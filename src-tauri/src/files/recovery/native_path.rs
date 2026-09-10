//! Platform-tagged, lossless paths in private durable records, never IPC paths.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Deserializer, Serializer};
use std::path::{Path, PathBuf};

const MAX_BYTES: usize = 128 * 1024;
const MAX_ENCODED_BYTES: usize = MAX_BYTES.div_ceil(3) * 4;

pub(super) fn validate(path: &Path) -> Result<(), &'static str> {
    if !path.is_absolute()
        || path.file_name().is_none()
        || path.as_os_str().as_encoded_bytes().len() > MAX_BYTES
        || path.as_os_str().as_encoded_bytes().contains(&0)
        || path
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Err(
            "Recovery path must be a bounded absolute entry without NUL or parent traversal",
        );
    }
    Ok(())
}

pub(super) fn serialize<S: Serializer>(path: &Path, serializer: S) -> Result<S::Ok, S::Error> {
    validate(path).map_err(serde::ser::Error::custom)?;
    #[cfg(unix)]
    let bytes = {
        use std::os::unix::ffi::OsStrExt;
        path.as_os_str().as_bytes()
    };
    #[cfg(windows)]
    let bytes = {
        use std::os::windows::ffi::OsStrExt;
        path.as_os_str()
            .encode_wide()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>()
    };
    if bytes.len() > MAX_BYTES {
        return Err(serde::ser::Error::custom(
            "Recovery path exceeds its native byte limit",
        ));
    }
    serializer.serialize_str(&format!(
        "{}:{}",
        std::env::consts::OS,
        STANDARD.encode(bytes)
    ))
}

pub(super) fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<PathBuf, D::Error> {
    let encoded = String::deserialize(deserializer)?;
    let (_, payload) = encoded
        .split_once(':')
        .filter(|(platform, _)| *platform == std::env::consts::OS)
        .ok_or_else(|| {
            serde::de::Error::custom("Recovery path belongs to an unsupported platform")
        })?;
    if payload.len() > MAX_ENCODED_BYTES {
        return Err(serde::de::Error::custom(
            "Recovery path exceeds its encoded byte limit",
        ));
    }
    let bytes = STANDARD.decode(payload).map_err(serde::de::Error::custom)?;
    if bytes.len() > MAX_BYTES {
        return Err(serde::de::Error::custom(
            "Recovery path exceeds its native byte limit",
        ));
    }
    #[cfg(unix)]
    let path = {
        use std::{ffi::OsString, os::unix::ffi::OsStringExt};
        PathBuf::from(OsString::from_vec(bytes))
    };
    #[cfg(windows)]
    let path = {
        use std::{ffi::OsString, os::windows::ffi::OsStringExt};
        if bytes.len() % 2 != 0 {
            return Err(serde::de::Error::custom("Malformed UTF-16 recovery path"));
        }
        let units: Vec<_> = bytes
            .as_chunks::<2>()
            .0
            .iter()
            .copied()
            .map(u16::from_le_bytes)
            .collect();
        PathBuf::from(OsString::from_wide(&units))
    };
    validate(&path).map_err(serde::de::Error::custom)?;
    Ok(path)
}

#[cfg(test)]
#[path = "../../../test_support/recovery_native_path.rs"]
mod tests;
