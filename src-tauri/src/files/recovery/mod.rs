//! Durable recovery infrastructure; Linux simple-entry admission is connected.
pub(crate) mod commands;
#[cfg(unix)]
mod context;
#[cfg(unix)]
mod coordinator;
mod file_lock;
#[cfg(target_os = "linux")]
mod forward_copy;
mod journal;
mod locks;
mod model;
mod move_model;
pub(crate) use model::{ReplacementDirection, ReplacementHistory, ReplacementOutcome};
#[cfg(target_os = "linux")]
mod history;
mod native_path;
#[cfg(all(target_os = "linux", feature = "e2e-renderer-recovery"))]
#[path = "../../../test_support/file_recovery_native.rs"]
pub(crate) mod native_probe;
#[cfg(unix)]
mod rename_outcome;
#[cfg(unix)]
mod replacement_artifact;
#[cfg(unix)]
mod replacement_execution;
#[cfg(unix)]
mod replacement_reapplication;
#[cfg(unix)]
mod replacement_restoration;
#[cfg(unix)]
mod replacement_transition;
#[cfg(unix)]
pub(super) mod resources;
#[cfg(unix)]
mod service;
mod storage;
#[cfg(target_os = "linux")]
mod subscriptions;

mod private_storage;

// Linux production admission is the first integration slice. Other platform
// namespace/case/durability adapters remain required before their enablement.
#[cfg(target_os = "linux")]
mod runtime;
#[cfg(target_os = "linux")]
pub(crate) use context::MutationAdmission;
#[cfg(target_os = "linux")]
pub(crate) use resources::{Access, Request as ResourceRequest, Scope};
#[cfg(target_os = "linux")]
pub(crate) use runtime::Runtime;
