fn main() {
    // The app icon is embedded into the Windows executable as a resource by
    // tauri_build, but tauri_build emits no `rerun-if-changed` covering the
    // icon files themselves. Without this line, regenerating `src-tauri/icons`
    // (e.g. `npx tauri icon logo.png`) leaves cargo's cached build-script
    // output untouched, so every later build — `cargo build` and
    // `npm run tauri build` alike — keeps embedding the *previous* icon while
    // still happily recompiling the crate. The only other way out is
    // `cargo clean -p joybug-tauri`, which is easy to forget and costs a full
    // rebuild.
    println!("cargo:rerun-if-changed=icons");

    build_id();
    tauri_build::build()
}

/// `JOYBUG_BUILD_ID` for the telemetry run line: which code this exe is, even
/// for a local build that reports version 0.0.0. `<app commit>[+<diff hash>]
/// core <core commit>[+<diff hash>] <build time>`; the diff hash tells two
/// builds of the same commit with different uncommitted changes apart.
fn build_id() {
    // Whatever goes into the exe: the build id is recomputed with it.
    for path in ["src", "../src", "../external/joybug-core/src", "../.git/HEAD", "../.git/index", "../.git/modules/external/joybug-core/HEAD", "../.git/modules/external/joybug-core/index"] {
        println!("cargo:rerun-if-changed={path}");
    }
    let git = |dir: &str, args: &[&str]| -> Option<Vec<u8>> {
        let out = std::process::Command::new("git").arg("-C").arg(dir).args(args).output().ok()?;
        out.status.success().then_some(out.stdout)
    };
    let describe = |dir: &str| -> String {
        let Some(commit) = git(dir, &["rev-parse", "--short=10", "HEAD"]) else { return "unknown".into() };
        let commit = String::from_utf8_lossy(&commit).trim().to_string();
        let diff = git(dir, &["diff", "HEAD"]).unwrap_or_default();
        let untracked = git(dir, &["ls-files", "--others", "--exclude-standard"]).unwrap_or_default();
        if diff.is_empty() && untracked.is_empty() {
            return commit;
        }
        // FNV-1a over the uncommitted changes.
        let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
        for b in diff.iter().chain(&untracked) {
            hash ^= *b as u64;
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
        format!("{commit}+{:08x}", hash as u32)
    };
    let built = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    println!("cargo:rustc-env=JOYBUG_BUILD_ID={} core {} @{built}", describe(".."), describe("../external/joybug-core"));
}
