//! Host-authored presentation identity. Provider success is not consumer completion.
use super::model::PackageGeneration;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum JobState {
    Accepting,
    Running,
    Recovering,
    NeedsAttention,
    Completed,
    Error,
    Cancelled,
    Discarded,
}
impl JobState {
    pub fn terminal(self) -> bool {
        matches!(
            self,
            Self::Completed | Self::Error | Self::Cancelled | Self::Discarded
        )
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct JobRecord {
    pub job_key: String,
    pub owner: PackageGeneration,
    pub operation_id: String,
    pub job_id: u64,
    pub kind: String,
    pub label: String,
    pub origin_window: String,
    pub revision: u64,
    #[serde(default)]
    pub source_revision: u64,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    /// When the row first became retained (terminal or parked). Unlike
    /// `updated_at_ms` it never moves afterwards, so it is the end of the
    /// job's duration. Absent on rows settled before it existed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settled_at_ms: Option<u64>,
    pub state: JobState,
    pub phase: Option<String>,
    pub output_path: Option<String>,
    pub run_id: Option<i64>,
    pub error: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct JobSnapshot {
    pub watermark: u64,
    pub jobs: Vec<JobRecord>,
}
