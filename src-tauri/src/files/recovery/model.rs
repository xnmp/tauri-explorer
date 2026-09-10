//! Durable recovery data and decisions. No filesystem or runtime operations.
use serde::{Deserialize, Serialize};
#[cfg(any(unix, test))]
use std::path::PathBuf;

/// Native-only history identity. Paths are a refresh projection, never authority.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ReplacementHistory {
    pub id: String,
    pub revision: u64,
    pub refresh_dirs: Vec<String>,
}

#[derive(Clone, Copy, Debug)]
pub(crate) enum ReplacementDirection {
    Restore,
    Reapply,
}

pub(crate) struct ReplacementOutcome {
    pub history: ReplacementHistory,
    pub warning: Option<String>,
}

#[cfg(any(unix, test))]
#[derive(Clone, Debug, Eq, PartialEq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub(crate) struct NativePath(#[serde(with = "super::native_path")] pub PathBuf);

#[cfg(unix)]
pub(super) use super::durable_model::*;

fn invalid(message: &str) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidData, message)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum RecoveryChoice {
    Restore,
    Discard,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecoveryItem {
    pub id: String,
    #[serde(serialize_with = "serialize_counter")]
    pub generation: u64,
    pub original_path: String,
    pub retained_path: Option<String>,
    /// Measured size of the retained artifact. `None` means not measured yet
    /// or not measurable; it is never reported as zero (ADR 0023).
    #[serde(serialize_with = "serialize_optional_counter")]
    pub retained_bytes: Option<u64>,
    pub status: &'static str,
    pub message: String,
    pub actions: Vec<RecoveryChoice>,
}

/// User-visible retention accounting. Byte counters cross IPC as canonical
/// decimal strings for the same reason journal generations do.
#[derive(Clone, Copy, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecoveryStorage {
    #[serde(serialize_with = "serialize_counter")]
    pub used_bytes: u64,
    #[serde(serialize_with = "serialize_counter")]
    pub budget_bytes: u64,
    pub records: usize,
    pub record_budget: usize,
    pub unmeasured: usize,
    pub unavailable: usize,
    pub discardable: usize,
    pub at_capacity: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecoverySnapshot {
    #[serde(serialize_with = "serialize_counter")]
    pub revision: u64,
    pub items: Vec<RecoveryItem>,
    pub storage: RecoveryStorage,
    pub error: Option<String>,
}

// SQLite generations are exact signed 64-bit integers; JavaScript numbers are
// not. Keep them lossless on IPC without changing the native journal format.
fn serialize_counter<S: serde::Serializer>(value: &u64, serializer: S) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(&value.to_string())
}

fn serialize_optional_counter<S: serde::Serializer>(
    value: &Option<u64>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    match value {
        Some(value) => serializer.serialize_str(&value.to_string()),
        None => serializer.serialize_none(),
    }
}

pub(super) fn parse_generation(value: &str) -> std::io::Result<u64> {
    if value.is_empty()
        || value.len() > 19
        || value.starts_with('0')
        || !value.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(invalid(
            "Recovery generation must be a canonical positive decimal integer",
        ));
    }
    let generation: i64 = value
        .parse()
        .map_err(|_| invalid("Recovery generation exceeds the journal range"))?;
    Ok(generation as u64)
}
