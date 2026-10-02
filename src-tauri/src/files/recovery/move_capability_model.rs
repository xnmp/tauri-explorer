//! Pure, bounded authority for temporary no-replace rename probes.
use super::{
    model::{EntryVersion, ObjectId},
    move_model::ArtifactPlan,
};
use serde::{Deserialize, Serialize};
use std::io;

/// Every move intent contains a source plan, and a target plan exactly when
/// the endpoints use different volumes.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Plans {
    pub source: ArtifactPlan,
    pub target: Option<ArtifactPlan>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum Step {
    Planned,
    RootIntent,
    /// Records root identity and intent to create the one empty probe file.
    FileIntent {
        root: ObjectId,
    },
    /// Records file identity and intent to perform the actual rename syscall.
    RenameIntent {
        root: ObjectId,
        file: EntryVersion,
    },
    /// One durable cleanup decision binds both the child and its empty root.
    /// Missing children/roots are allowed only after this removal intent.
    CleanupIntent {
        root: ObjectId,
        file: Option<EntryVersion>,
        renamed: bool,
        supported: bool,
    },
    Absent,
    Removed {
        root: ObjectId,
        file: Option<EntryVersion>,
        renamed: bool,
        supported: bool,
    },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Progress {
    pub steps: Vec<Step>,
}

pub(super) enum Event {
    BeginRoot,
    RootObserved(ObjectId),
    FileObserved(EntryVersion),
    BeginCleanup {
        renamed: bool,
        supported: bool,
    },
    Removed,
    /// Native observation verified that no creation ever became visible.
    Absent,
}

impl Progress {
    pub(super) fn new(count: usize) -> Self {
        Self {
            steps: vec![Step::Planned; count],
        }
    }
    pub(super) fn supported(&self) -> bool {
        !self.steps.is_empty()
            && self.steps.iter().all(|step| {
                matches!(
                    step,
                    Step::Removed {
                        supported: true,
                        ..
                    }
                )
            })
    }
    pub(super) fn removed(&self) -> bool {
        !self.steps.is_empty()
            && self
                .steps
                .iter()
                .all(|step| matches!(step, Step::Absent | Step::Removed { .. }))
    }
    pub(super) fn advance(&mut self, index: usize, event: Event) -> io::Result<()> {
        let prior_supported = self.steps.iter().take(index).all(|step| {
            matches!(
                step,
                Step::Removed {
                    supported: true,
                    ..
                }
            )
        });
        let step = self
            .steps
            .get_mut(index)
            .ok_or_else(|| invalid("Probe index exceeds its plan"))?;
        *step = match (&*step, event) {
            (Step::Planned, Event::BeginRoot) if prior_supported => Step::RootIntent,
            (Step::RootIntent, Event::RootObserved(root)) => Step::FileIntent { root },
            (Step::FileIntent { root }, Event::FileObserved(file)) => {
                Step::RenameIntent { root: *root, file }
            }
            (
                Step::FileIntent { root },
                Event::BeginCleanup {
                    renamed: false,
                    supported: false,
                },
            ) => Step::CleanupIntent {
                root: *root,
                file: None,
                renamed: false,
                supported: false,
            },
            (Step::RenameIntent { root, file }, Event::BeginCleanup { renamed, supported })
                if !supported || renamed =>
            {
                Step::CleanupIntent {
                    root: *root,
                    file: Some(file.clone()),
                    renamed,
                    supported,
                }
            }
            (
                Step::CleanupIntent {
                    root,
                    file,
                    renamed,
                    supported,
                },
                Event::Removed,
            ) => Step::Removed {
                root: *root,
                file: file.clone(),
                renamed: *renamed,
                supported: *supported,
            },
            (Step::Planned | Step::RootIntent, Event::Absent) => Step::Absent,
            _ => return Err(invalid("Illegal rename capability transition")),
        };
        Ok(())
    }
}

/// Errnos that, from an exactly unchanged probe namespace, mean the volume lacks
/// exclusive rename. macOS `renameatx_np(RENAME_EXCL)` reports `ENOTSUP` (45);
/// its distinct `EOPNOTSUPP` (102) is the socket error. Linux defines both as 95.
pub(super) fn unsupported_exclusive_rename(errno: i32) -> bool {
    [libc::ENOSYS, libc::ENOTSUP, libc::EOPNOTSUPP, libc::EINVAL].contains(&errno)
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

#[cfg(all(test, unix))]
#[path = "../../../test_support/recovery_move_capability_model.rs"]
mod tests;
