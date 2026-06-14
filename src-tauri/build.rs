fn main() {
    // Re-run (and re-embed the Windows .exe icon) whenever the icon changes.
    // Without this, an incremental `tauri build` keeps the previously embedded
    // icon, so a regenerated icon.ico shows up in `tauri dev` but not in the
    // installed binary.
    println!("cargo:rerun-if-changed=icons/icon.ico");

    let mut windows = tauri_build::WindowsAttributes::new();

    // Windows manifest for Per-Monitor V2 DPI awareness.
    // The Common-Controls v6 dependency is required so that comctl32 v6 is loaded;
    // without it, `TaskDialogIndirect` (used by the `trash` crate) fails to resolve
    // and the binary exits at startup with a "procedure entry point not found" error.
    let manifest = r#"
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0" xmlns:asmv3="urn:schemas-microsoft-com:asm.v3">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0" processorArchitecture="*" publicKeyToken="6595b64144ccf1df" language="*"/>
    </dependentAssembly>
  </dependency>
  <asmv3:application>
    <asmv3:windowsSettings>
      <dpiAware xmlns="http://schemas.microsoft.com/SMI/2005/WindowsSettings">true</dpiAware>
      <dpiAwareness xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">PerMonitorV2</dpiAwareness>
    </asmv3:windowsSettings>
  </asmv3:application>
</assembly>
"#;

    windows = windows.app_manifest(manifest);

    tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows))
        .expect("failed to run build script");
}
