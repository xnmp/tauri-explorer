use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

fn scratch_dir() -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock is after the Unix epoch")
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("wry-build-script-{nonce}"));
    fs::create_dir_all(&dir).expect("scratch directory is created");
    dir
}

fn compile_build_script(source: &Path, output: &Path) {
    let result = Command::new("rustc")
        .arg(source)
        .arg("-o")
        .arg(output)
        .output()
        .expect("rustc is available to compile the vendored build script");
    assert!(
        result.status.success(),
        "vendored build script compiles: {}",
        String::from_utf8_lossy(&result.stderr)
    );
}

fn run_build_script(executable: &Path, target_os: &str, manifest_dir: &Path, out_dir: &Path) -> String {
    fs::create_dir_all(out_dir).expect("build output directory is created");
    let result = Command::new(executable)
        .env("CARGO_CFG_TARGET_OS", target_os)
        .env("CARGO_MANIFEST_DIR", manifest_dir)
        .env("OUT_DIR", out_dir)
        .env("WRY_ANDROID_PACKAGE", "com.example.app")
        .env("WRY_ANDROID_LIBRARY", "example")
        .env("WRY_ANDROID_KOTLIN_FILES_OUT_DIR", out_dir)
        .output()
        .expect("vendored build script runs");
    assert!(
        result.status.success(),
        "vendored build script runs for {target_os}: {}",
        String::from_utf8_lossy(&result.stderr)
    );
    String::from_utf8(result.stdout).expect("build script output is UTF-8")
}

#[test]
fn build_script_declares_source_tracking_on_linux_and_preserves_android_directives() {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let vendor_dir = manifest_dir.join("vendor/wry");
    let source = vendor_dir.join("build.rs");
    let scratch = scratch_dir();
    let executable = scratch.join("wry-build-script");
    compile_build_script(&source, &executable);

    let linux_output = run_build_script(
        &executable,
        "linux",
        &vendor_dir,
        &scratch.join("linux-out"),
    );
    assert!(
        linux_output.lines().any(|line| line == "cargo:rerun-if-changed=build.rs"),
        "Linux build script output must make Cargo track build.rs; got:\n{linux_output}"
    );

    let android_output = run_build_script(
        &executable,
        "android",
        &vendor_dir,
        &scratch.join("android-out"),
    );
    assert!(
        android_output
            .lines()
            .any(|line| line == "cargo:rerun-if-env-changed=WRY_ANDROID_PACKAGE"),
        "Android build script output must preserve its package environment tracking; got:\n{android_output}"
    );
    assert!(
        android_output
            .lines()
            .any(|line| line.starts_with("cargo:rerun-if-changed=") && line.contains("src/android/kotlin")),
        "Android build script output must preserve Kotlin source tracking; got:\n{android_output}"
    );

    fs::remove_dir_all(scratch).expect("scratch directory is removed");
}
