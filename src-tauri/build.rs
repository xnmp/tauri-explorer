fn main() {
    // Keep incremental builds in sync with both native resources.
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=windows-app-manifest.xml");

    let windows_msvc = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc");
    let windows = if windows_msvc {
        // Tauri embeds resources only in app binaries. MSVC must instead embed
        // the manifest through the linker so library test executables also get
        // Common Controls v6 (required by trash's TaskDialogIndirect import).
        // Disable the resource manifest to avoid embedding it twice in the app.
        tauri_build::WindowsAttributes::new_without_app_manifest()
    } else {
        tauri_build::WindowsAttributes::new().app_manifest(include_str!("windows-app-manifest.xml"))
    };

    tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows))
        .expect("failed to run build script");

    if windows_msvc {
        // Generic link arguments cover unit tests too; rustc-link-arg-tests
        // covers separate test targets only. Follow Tauri's API example.
        let manifest = std::path::PathBuf::from(
            std::env::var_os("CARGO_MANIFEST_DIR").expect("Cargo supplies the package directory"),
        )
        .join("windows-app-manifest.xml");
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    }
}
