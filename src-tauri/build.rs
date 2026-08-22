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

    tauri_build::build()
}
