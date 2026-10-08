//! Real-filesystem contracts for move retirement. Public bytes and recovery
//! availability, rather than in-memory step representation, are the assertions.
//!
//! Split by concern across submodules, sharing the [`fixtures`] module's
//! `Fixture` helper. See `docs/code-map/map-folder.md` for the layout.
use super::*;
use crate::files::recovery::{
    checkpoint::{Event, Side},
    coordinator::Coordinator,
    forward_move::PreparedMove,
    model::RecoveryChoice,
    move_execution::MoveExecution,
    retirement, service,
};
use std::{fs, path::PathBuf, sync::Arc};

mod fixtures;

mod enforcement_observability;
mod lifecycle;
mod mount_boundary;
mod planning_budget;
mod readonly_umask;
mod undo;
