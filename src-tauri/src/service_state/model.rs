//! Frozen host ownership records. Provider execution outcomes remain provider-owned.
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PackageGeneration {
    pub package_id: String,
    pub digest: String,
    pub incarnation: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ServiceTarget {
    pub package_id: String,
    pub service_id: String,
    pub major: u32,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ArtifactDescriptor {
    pub handle: String,
    pub sha256: String,
    pub byte_length: u64,
    pub media_type: String,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AdmissionPhase {
    Reserved,
    Forwarding,
    Accepted,
    Terminal,
    Released,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Admission {
    pub consumer: PackageGeneration,
    pub provider: PackageGeneration,
    pub target: ServiceTarget,
    pub operation_id: String,
    pub fingerprint: String,
    pub phase: AdmissionPhase,
    pub inputs: Vec<ArtifactDescriptor>,
    pub output: Option<ArtifactDescriptor>,
    pub needs_attention: bool,
    pub disposition: Option<String>,
    pub transfer_receipt: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CaptureInput {
    pub path: String,
    pub expected_digest: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CapturedArtifact {
    pub source_path: String,
    pub artifact: ArtifactDescriptor,
    pub width: u32,
    pub height: u32,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ArtifactPath {
    pub path: String,
    pub artifact: ArtifactDescriptor,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct OutputStage {
    pub handle: String,
    pub path: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TransferReceipt {
    pub transfer_receipt: String,
}
#[derive(Clone, Copy)]
pub(crate) struct Limits {
    pub disk_bytes: u64,
    pub operations: usize,
    pub per_consumer: usize,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            disk_bytes: 2 * 1024 * 1024 * 1024,
            operations: 64,
            per_consumer: 16,
        }
    }
}
