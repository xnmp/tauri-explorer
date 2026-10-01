use super::super::model::NativePath;
use super::*;

#[test]
fn native_entry_paths_round_trip_without_unicode_loss() {
    #[cfg(unix)]
    let native = {
        use std::{ffi::OsString, os::unix::ffi::OsStringExt};
        PathBuf::from(OsString::from_vec(b"/volume/invalid-\xff".to_vec()))
    };
    #[cfg(windows)]
    let native = {
        use std::{ffi::OsString, os::windows::ffi::OsStringExt};
        PathBuf::from(OsString::from_wide(&[67, 58, 92, 0xd800]))
    };
    let encoded = serde_json::to_string(&NativePath(native.clone())).unwrap();
    assert_eq!(
        serde_json::from_str::<NativePath>(&encoded).unwrap().0,
        native
    );
}

#[test]
fn malformed_native_entries_cannot_be_persisted() {
    let root = std::env::temp_dir();
    for path in [
        PathBuf::from("relative"),
        root.join("..\0bad"),
        root.join("safe/../outside"),
        root.join("x".repeat(MAX_BYTES + 1)),
    ] {
        assert!(serde_json::to_string(&NativePath(path)).is_err());
    }
}

#[test]
fn decoding_checks_platform_and_size_before_materializing_native_paths() {
    let tag = format!("{}:", std::env::consts::OS);
    let other = if cfg!(target_os = "linux") {
        "macos:"
    } else {
        "linux:"
    };
    for encoded in [
        format!("{other}L2E="),
        format!("{tag}%%%"),
        format!("{tag}{}", "A".repeat(MAX_ENCODED_BYTES + 4)),
        format!("{tag}AA=="),
    ] {
        assert!(serde_json::from_value::<NativePath>(serde_json::Value::String(encoded)).is_err());
    }
}
