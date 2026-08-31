//! One binary, three roles.
//!
//! A Windows Sandbox session needs a debug server and an ETW collector running
//! *inside* the guest, and host-side ETW needs the collector too. Rather than
//! building, embedding and version-matching two extra executables, this exe is
//! all three: the sandbox stages a copy of it into the guest, and the flags it
//! is launched with pick the role.
//!
//! | Flag present | Role |
//! |---|---|
//! | `--listen <addr>` | debug server (same CLI as `joybug-core`'s own `main`) |
//! | `--out <file>` | ETW collector ([`joybug_core::etw::run_collector`]) |
//! | neither | the GUI |
//!
//! Dispatch happens before anything Tauri touches: inside the guest there is no
//! WebView2 and no desktop to put a window on, so initializing the GUI first and
//! branching later would not work.

/// Which role this invocation is.
pub enum GuestMode {
    /// Debug server; carries the parsed server CLI.
    Server(ServerArgs),
    /// ETW collector. Its own argument parsing lives in `winsandbox::tracer`, so
    /// the whole argument list is simply forwarded.
    Tracer,
}

/// The debug-server invocation, parsed from argv. Mirrors the flags in
/// `external/joybug-core/src/main.rs`, because `joybug_core::sandbox` builds the
/// in-guest command line against that same contract.
pub struct ServerArgs {
    /// Bind address, e.g. `0.0.0.0:9000`.
    pub listen: String,
    pub symbol_path: Option<String>,
    pub offline: bool,
}

/// Decide this invocation's role, or `None` for the normal GUI launch.
///
/// Hand-rolled and keyed strictly on the two entry flags: an arg parser that
/// rejects unknown flags would be a liability here, because the GUI is also
/// launched with arguments we do not control (Tauri, WebView2, file
/// associations, "open with"). Anything without `--listen` or `--out` falls
/// through to the GUI untouched.
pub fn from_args() -> Option<GuestMode> {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    if argv.iter().any(|a| a == "--listen") {
        return Some(GuestMode::Server(parse_server(&argv)));
    }
    if argv.iter().any(|a| a == "--out") {
        return Some(GuestMode::Tracer);
    }
    None
}

fn parse_server(argv: &[String]) -> ServerArgs {
    let mut listen = String::new();
    let mut symbol_path = None;
    let mut offline = false;
    let mut it = argv.iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--listen" => listen = it.next().cloned().unwrap_or_default(),
            "--symbol-path" => symbol_path = it.next().cloned(),
            "--offline" => offline = true,
            _ => {}
        }
    }
    ServerArgs { listen, symbol_path, offline }
}

/// Run the selected role to completion and exit; never returns to the GUI path.
pub fn run(mode: GuestMode) -> ! {
    match mode {
        GuestMode::Tracer => {
            // The collector owns the process and exits with the traced target's
            // code; it parses the rest of argv itself.
            joybug_core::etw::run_collector(std::env::args().skip(1))
        }
        GuestMode::Server(args) => run_server(args),
    }
}

/// Serve the debug protocol until the process is killed.
///
/// `wsb exec` discards a guest process's stdout, so the caller redirects this to
/// a log file in the shared folder — which is why failures are printed as well
/// as logged: `await_server_ready` tails that file to explain a server that
/// never came up.
fn run_server(args: ServerArgs) -> ! {
    joybug_core::init_tracing();
    let ServerArgs { listen, symbol_path, offline } = args;
    println!("joybug guest server starting on {listen}");

    let cfg = joybug_core::SymbolConfig { symbol_path, offline };
    let runtime = match tokio::runtime::Runtime::new() {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("failed to start the tokio runtime: {e}");
            std::process::exit(1);
        }
    };

    // The bootstrap itself (bind + serve) is core's `server::serve` — the same
    // function core's own `main` runs, so the two server entry points can't
    // drift apart.
    let code = runtime.block_on(async move {
        match joybug_core::server::serve(&listen, cfg).await {
            Ok(()) => 0,
            Err(e) => {
                eprintln!("server failed on {listen}: {e}");
                1
            }
        }
    });
    std::process::exit(code);
}
