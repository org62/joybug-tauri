//! Windows JIT (postmortem) debugger registration.
//!
//! When a process dies of an unhandled exception, Windows Error Reporting
//! launches whatever is registered under
//! `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\AeDebug\Debugger`, with
//! `%ld` placeholders expanded to the faulting PID and an event handle:
//! `"debugger.exe" -p <pid> -e <handle>`. The debugger attaches to the frozen
//! process and signals the event so WER knows it has taken over.
//!
//! This module holds the machinery, none of which is Tauri IPC — most of it
//! runs in a *second* process that has no Tauri app at all. The three
//! `#[tauri::command]` wrappers the Settings toggle and the startup hand-off
//! need live in `commands::jit_debugger`.
//!
//! * **Elevated registry work** ([`do_register`] / [`do_restore`]) — run by a
//!   second Joybug process started with `runas` and a `--jit-register` /
//!   `--jit-unregister` flag (see `lib.rs`), because HKLM is admin-only. The
//!   pre-existing value is saved to `jit_debugger_backup.json` so disabling
//!   puts the machine back exactly as it was.
//! * **The startup hand-off**: the `-p/-e` arguments the JIT launch carries are
//!   parked in [`StartupAttachState`] and handed to the UI once, which then
//!   attaches like a normal "attach to PID" session.
//!
//! 64-bit only: no `WOW6432Node` mirror is written.

use crate::data_dir::joybug_data_dir;
use crate::error::{Error, Result};
use serde::{Deserialize, Serialize};
use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::ptr;
use std::sync::Mutex;
use tracing::{error, info, warn};
use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_CANCELLED, ERROR_FILE_NOT_FOUND, ERROR_SUCCESS, HANDLE, WAIT_OBJECT_0,
};
use windows_sys::Win32::System::Registry::{
    RegCloseKey, RegCreateKeyExW, RegDeleteValueW, RegOpenKeyExW, RegQueryValueExW, RegSetValueExW,
    HKEY, HKEY_LOCAL_MACHINE, KEY_QUERY_VALUE, KEY_SET_VALUE, REG_OPTION_NON_VOLATILE, REG_SZ,
};
use windows_sys::Win32::System::Threading::{GetExitCodeProcess, SetEvent, WaitForSingleObject, INFINITE};
use windows_sys::Win32::UI::Shell::{
    ShellExecuteExW, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
};
use windows_sys::Win32::UI::WindowsAndMessaging::SW_HIDE;

const AEDEBUG_SUBKEY: &str = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\AeDebug";
const DEBUGGER_VALUE: &str = "Debugger";
const AUTO_VALUE: &str = "Auto";
const BACKUP_FILE: &str = "jit_debugger_backup.json";

/// CLI flags handled in `lib.rs::run()` before the Tauri app is built.
pub const REGISTER_FLAG: &str = "--jit-register";
pub const UNREGISTER_FLAG: &str = "--jit-unregister";

// ---------------------------------------------------------------------------
// Startup state
// ---------------------------------------------------------------------------

/// The `-p <pid> -e <handle>` pair a Windows JIT (AeDebug) launch passed on the
/// command line.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct StartupAttach {
    pub pid: u32,
    pub event_handle: u64,
}

/// Managed state holding the startup attach until the UI takes it (once).
/// Always managed; `None` on a normal launch.
#[derive(Default)]
pub struct StartupAttachState(pub Mutex<Option<StartupAttach>>);

// ---------------------------------------------------------------------------
// Registry access
// ---------------------------------------------------------------------------

fn wide(s: &str) -> Vec<u16> {
    OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
}

fn win_err(what: &str, code: u32) -> Error {
    Error::JitDebugger(format!("{what} failed (Win32 error {code})"))
}

fn last_os_code() -> u32 {
    std::io::Error::last_os_error().raw_os_error().unwrap_or(0) as u32
}

/// An open registry key, closed on drop.
struct RegKey(HKEY);

impl RegKey {
    fn open(root: HKEY, subkey: &str, access: u32) -> Result<Self> {
        let mut hkey: HKEY = ptr::null_mut();
        let rc = unsafe { RegOpenKeyExW(root, wide(subkey).as_ptr(), 0, access, &mut hkey) };
        if rc != ERROR_SUCCESS {
            return Err(win_err(&format!("Opening registry key {subkey}"), rc));
        }
        Ok(Self(hkey))
    }

    fn create(root: HKEY, subkey: &str, access: u32) -> Result<Self> {
        let mut hkey: HKEY = ptr::null_mut();
        let rc = unsafe {
            RegCreateKeyExW(
                root,
                wide(subkey).as_ptr(),
                0,
                ptr::null(),
                REG_OPTION_NON_VOLATILE,
                access,
                ptr::null(),
                &mut hkey,
                ptr::null_mut(),
            )
        };
        if rc != ERROR_SUCCESS {
            return Err(win_err(&format!("Creating registry key {subkey}"), rc));
        }
        Ok(Self(hkey))
    }

    /// Read a string value. `Ok(None)` when the value does not exist.
    fn get_string(&self, name: &str) -> Result<Option<String>> {
        let name_w = wide(name);
        let mut size: u32 = 0;
        let rc = unsafe {
            RegQueryValueExW(self.0, name_w.as_ptr(), ptr::null(), ptr::null_mut(), ptr::null_mut(), &mut size)
        };
        if rc == ERROR_FILE_NOT_FOUND {
            return Ok(None);
        }
        if rc != ERROR_SUCCESS {
            return Err(win_err(&format!("Reading registry value {name}"), rc));
        }
        let mut buf = vec![0u16; (size as usize).div_ceil(2) + 1];
        let mut size = (buf.len() * 2) as u32;
        let rc = unsafe {
            RegQueryValueExW(self.0, name_w.as_ptr(), ptr::null(), ptr::null_mut(), buf.as_mut_ptr().cast(), &mut size)
        };
        if rc != ERROR_SUCCESS {
            return Err(win_err(&format!("Reading registry value {name}"), rc));
        }
        let len = (size as usize / 2).min(buf.len());
        let s: Vec<u16> = buf[..len].iter().copied().take_while(|&c| c != 0).collect();
        Ok(Some(String::from_utf16_lossy(&s)))
    }

    fn set_string(&self, name: &str, value: &str) -> Result<()> {
        let data = wide(value);
        let rc = unsafe {
            RegSetValueExW(self.0, wide(name).as_ptr(), 0, REG_SZ, data.as_ptr().cast(), (data.len() * 2) as u32)
        };
        if rc != ERROR_SUCCESS {
            return Err(win_err(&format!("Writing registry value {name}"), rc));
        }
        Ok(())
    }

    /// Delete a value; a value that is already absent is not an error.
    fn delete_value(&self, name: &str) -> Result<()> {
        let rc = unsafe { RegDeleteValueW(self.0, wide(name).as_ptr()) };
        if rc != ERROR_SUCCESS && rc != ERROR_FILE_NOT_FOUND {
            return Err(win_err(&format!("Deleting registry value {name}"), rc));
        }
        Ok(())
    }

    /// Write `Some` or delete on `None` — the restore primitive.
    fn put(&self, name: &str, value: Option<&str>) -> Result<()> {
        match value {
            Some(v) => self.set_string(name, v),
            None => self.delete_value(name),
        }
    }
}

impl Drop for RegKey {
    fn drop(&mut self) {
        unsafe { RegCloseKey(self.0) };
    }
}

// ---------------------------------------------------------------------------
// Register / restore (run elevated)
// ---------------------------------------------------------------------------

/// What the AeDebug key held before Joybug took it over. `None` = the value
/// did not exist, and restore deletes it again.
#[derive(Debug, Default, PartialEq, Serialize, Deserialize)]
struct Backup {
    debugger: Option<String>,
    auto: Option<String>,
}

/// The AeDebug `Debugger` value that launches this exe.
fn our_debugger_value(exe: &Path) -> String {
    format!("\"{}\" -p %ld -e %ld", exe.display())
}

/// Where the key and the backup live. Parameterised so the unit test can run
/// against a throwaway `HKCU` key instead of the real, admin-only HKLM one.
struct Target {
    root: HKEY,
    subkey: String,
    backup_path: PathBuf,
}

impl Target {
    fn aedebug() -> Self {
        Self {
            root: HKEY_LOCAL_MACHINE,
            subkey: AEDEBUG_SUBKEY.to_string(),
            backup_path: joybug_data_dir().join(BACKUP_FILE),
        }
    }

    fn load_backup(&self) -> Option<Backup> {
        let bytes = std::fs::read(&self.backup_path).ok()?;
        match serde_json::from_slice(&bytes) {
            Ok(b) => Some(b),
            Err(e) => {
                error!("Corrupt {}: {e}", self.backup_path.display());
                None
            }
        }
    }

    /// Unlike `data_dir::save_json`, this write is fail-loud: registering
    /// without a saved backup would make a later "disable" wipe the machine's
    /// original AeDebug value instead of putting it back.
    fn save_backup(&self, backup: &Backup) -> Result<()> {
        if let Some(parent) = self.backup_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let data = serde_json::to_vec_pretty(backup).map_err(|e| Error::JitDebugger(e.to_string()))?;
        std::fs::write(&self.backup_path, data)
            .map_err(|e| Error::JitDebugger(format!("Writing {}: {e}", self.backup_path.display())))
    }

    /// Point AeDebug at `exe`. The current values are backed up first unless a
    /// backup already exists — a re-register must not overwrite the original
    /// machine setting with Joybug's own value.
    fn register(&self, exe: &Path) -> Result<()> {
        let key = RegKey::create(self.root, &self.subkey, KEY_QUERY_VALUE | KEY_SET_VALUE)?;
        if !self.backup_path.exists() {
            let backup = Backup {
                debugger: key.get_string(DEBUGGER_VALUE)?,
                auto: key.get_string(AUTO_VALUE)?,
            };
            self.save_backup(&backup)?;
        }
        key.set_string(DEBUGGER_VALUE, &our_debugger_value(exe))?;
        // "1": attach straight away instead of showing the WER prompt first.
        key.set_string(AUTO_VALUE, "1")
    }

    /// Put back what [`Self::register`] replaced. Without a backup (nothing
    /// was saved, or it was lost) Joybug's values are simply removed. Each value
    /// is restored independently so one failure does not block the other.
    fn restore(&self) -> Result<()> {
        let backup = self.load_backup().unwrap_or_default();
        let key = RegKey::create(self.root, &self.subkey, KEY_QUERY_VALUE | KEY_SET_VALUE)?;
        let mut first_err = None;
        for (name, value) in [(DEBUGGER_VALUE, &backup.debugger), (AUTO_VALUE, &backup.auto)] {
            if let Err(e) = key.put(name, value.as_deref()) {
                error!("Restoring AeDebug {name}: {e}");
                first_err.get_or_insert(e);
            }
        }
        if let Some(e) = first_err {
            return Err(e);
        }
        if let Err(e) = std::fs::remove_file(&self.backup_path) {
            if e.kind() != std::io::ErrorKind::NotFound {
                warn!("Could not remove {}: {e}", self.backup_path.display());
            }
        }
        Ok(())
    }

    fn current_debugger(&self) -> Result<Option<String>> {
        match RegKey::open(self.root, &self.subkey, KEY_QUERY_VALUE) {
            Ok(key) => key.get_string(DEBUGGER_VALUE),
            // No AeDebug key at all: nothing is registered.
            Err(_) => Ok(None),
        }
    }
}

/// Run one elevated-child operation and turn it into a process exit code.
fn elevated_exit(what: &str, op: impl FnOnce() -> Result<()>) -> i32 {
    match op() {
        Ok(()) => {
            info!("AeDebug {what} succeeded");
            0
        }
        Err(e) => {
            error!("AeDebug {what} failed: {e}");
            1
        }
    }
}

/// Entry point of the elevated `--jit-register` child. Returns the process exit code.
pub fn do_register() -> i32 {
    elevated_exit("register", || {
        crate::commands::exe_path().and_then(|exe| Target::aedebug().register(exe))
    })
}

/// Entry point of the elevated `--jit-unregister` child. Returns the process exit code.
pub fn do_restore() -> i32 {
    elevated_exit("restore", || Target::aedebug().restore())
}

// ---------------------------------------------------------------------------
// Elevated self-relaunch
// ---------------------------------------------------------------------------

/// Run our own exe elevated with `flag` and wait for it. `ShellExecuteExW` with
/// the `runas` verb is the only supported way to trigger UAC; a declined
/// prompt comes back as `ERROR_CANCELLED`.
pub fn run_elevated(flag: &str) -> Result<()> {
    let exe = crate::commands::exe_path()?;
    let verb = wide("runas");
    let file = wide(&exe.to_string_lossy());
    let params = wide(flag);
    let dir = exe.parent().map(|d| wide(&d.to_string_lossy()));

    let mut info: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
    info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
    info.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC;
    info.lpVerb = verb.as_ptr();
    info.lpFile = file.as_ptr();
    info.lpParameters = params.as_ptr();
    info.lpDirectory = dir.as_ref().map_or(ptr::null(), |d| d.as_ptr());
    info.nShow = SW_HIDE;

    let ok = unsafe { ShellExecuteExW(&mut info) };
    if ok == 0 {
        let code = last_os_code();
        return Err(if code == ERROR_CANCELLED {
            Error::JitDebuggerCancelled
        } else {
            win_err("Launching the elevated helper", code)
        });
    }
    if info.hProcess.is_null() {
        return Err(Error::JitDebugger("Elevated helper started without a process handle".into()));
    }

    // Anything that stops us reading a real exit code counts as a failure.
    let exit_code = unsafe {
        let mut code: u32 = 1;
        if WaitForSingleObject(info.hProcess, INFINITE) == WAIT_OBJECT_0 {
            let _ = GetExitCodeProcess(info.hProcess, &mut code);
        }
        CloseHandle(info.hProcess);
        code
    };
    if exit_code != 0 {
        return Err(Error::JitDebugger(format!(
            "The elevated helper exited with code {exit_code} (see the Joybug log)"
        )));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct JitDebuggerStatus {
    /// AeDebug points at this exe.
    pub registered: bool,
    /// The raw `Debugger` value currently registered, whoever owns it.
    pub current: Option<String>,
}

pub fn status() -> Result<JitDebuggerStatus> {
    let current = Target::aedebug().current_debugger()?;
    let registered = match (&current, crate::commands::exe_path()) {
        (Some(value), Ok(exe)) => value.eq_ignore_ascii_case(&our_debugger_value(exe)),
        _ => false,
    };
    Ok(JitDebuggerStatus { registered, current })
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

/// Parse the AeDebug invocation `-p <pid> -e <handle>` out of the process
/// arguments. Anything else yields `None` (a normal launch).
pub fn parse_startup_attach<I: IntoIterator<Item = String>>(args: I) -> Option<StartupAttach> {
    let mut pid = None;
    let mut event_handle = None;
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "-p" => pid = args.next().and_then(|v| v.parse::<u32>().ok()),
            "-e" => event_handle = args.next().and_then(|v| v.parse::<u64>().ok()),
            _ => {}
        }
    }
    Some(StartupAttach { pid: pid?, event_handle: event_handle? })
}

/// Signal the event WER passed on the command line so it stops waiting for the
/// debugger. The handle was duplicated into this process by WER and is only
/// valid here, which is why the JIT launch attaches in-process. Reporting is
/// the caller's job — it owns the session context.
pub fn signal_wer_event(handle: u64) -> Result<()> {
    if unsafe { SetEvent(handle as HANDLE) } == 0 {
        return Err(win_err(&format!("SetEvent on the WER handle {handle:#x}"), last_os_code()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows_sys::Win32::System::Registry::{RegDeleteKeyW, HKEY_CURRENT_USER};

    /// A throwaway HKCU key + backup file, deleted on drop. Never touches the
    /// real AeDebug key, so it runs unelevated and leaves nothing behind.
    struct Scratch(Target);

    impl Scratch {
        fn new(tag: &str) -> Self {
            let subkey = format!(r"SOFTWARE\JoybugTests\AeDebug-{tag}-{}", std::process::id());
            let backup_path = std::env::temp_dir().join(format!("joybug-jit-{tag}-{}.json", std::process::id()));
            let _ = std::fs::remove_file(&backup_path);
            Self(Target { root: HKEY_CURRENT_USER, subkey, backup_path })
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0.backup_path);
            unsafe { RegDeleteKeyW(HKEY_CURRENT_USER, wide(&self.0.subkey).as_ptr()) };
        }
    }

    fn values(t: &Target) -> (Option<String>, Option<String>) {
        let key = RegKey::open(t.root, &t.subkey, KEY_QUERY_VALUE).unwrap();
        (key.get_string(DEBUGGER_VALUE).unwrap(), key.get_string(AUTO_VALUE).unwrap())
    }

    #[test]
    fn register_backs_up_existing_values_and_restore_puts_them_back() {
        let s = Scratch::new("existing");
        let t = &s.0;
        let key = RegKey::create(t.root, &t.subkey, KEY_SET_VALUE).unwrap();
        key.set_string(DEBUGGER_VALUE, r#""C:\other\dbg.exe" -p %ld -e %ld"#).unwrap();
        key.set_string(AUTO_VALUE, "0").unwrap();
        drop(key);

        let exe = Path::new(r"C:\joybug\Joybug-UI-x64.exe");
        t.register(exe).unwrap();
        assert_eq!(values(t), (Some(our_debugger_value(exe)), Some("1".into())));
        assert_eq!(
            t.load_backup().unwrap(),
            Backup { debugger: Some(r#""C:\other\dbg.exe" -p %ld -e %ld"#.into()), auto: Some("0".into()) }
        );

        // Re-registering must keep the original backup, not Joybug's own value.
        t.register(exe).unwrap();
        assert_eq!(t.load_backup().unwrap().auto, Some("0".into()));

        t.restore().unwrap();
        assert_eq!(values(t), (Some(r#""C:\other\dbg.exe" -p %ld -e %ld"#.into()), Some("0".into())));
        assert!(!t.backup_path.exists());
    }

    #[test]
    fn restore_deletes_values_that_were_absent() {
        let s = Scratch::new("absent");
        let t = &s.0;
        let exe = Path::new(r"C:\joybug\Joybug-UI-x64.exe");
        t.register(exe).unwrap();
        assert_eq!(t.load_backup().unwrap(), Backup::default());
        assert_eq!(values(t).1, Some("1".into()));

        t.restore().unwrap();
        assert_eq!(values(t), (None, None));
        assert!(!t.backup_path.exists());
    }

    #[test]
    fn restore_without_backup_removes_our_values() {
        let s = Scratch::new("nobackup");
        let t = &s.0;
        t.register(Path::new(r"C:\joybug\Joybug-UI-x64.exe")).unwrap();
        std::fs::remove_file(&t.backup_path).unwrap();
        t.restore().unwrap();
        assert_eq!(values(t), (None, None));
    }

    #[test]
    fn parses_the_aedebug_invocation() {
        let args = |s: &str| s.split(' ').map(String::from).collect::<Vec<_>>();
        assert_eq!(
            parse_startup_attach(args("-p 1234 -e 5678")),
            Some(StartupAttach { pid: 1234, event_handle: 5678 })
        );
        assert_eq!(parse_startup_attach(args("-e 5678 -p 1234")).map(|a| a.pid), Some(1234));
        assert_eq!(parse_startup_attach(args("-p 1234")), None);
        assert_eq!(parse_startup_attach(args("-p abc -e 1")), None);
        assert_eq!(parse_startup_attach(Vec::<String>::new()), None);
    }
}
