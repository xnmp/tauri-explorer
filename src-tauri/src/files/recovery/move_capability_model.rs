//! Pure, bounded authority for temporary no-replace rename probes.
use super::{
    model::{EntryVersion, ObjectId},
    move_model::ArtifactPlan,
};
use serde::{Deserialize, Serialize};
use std::io;

/// Absence identifies legacy intents. New intents always contain a source plan
/// and contain a target plan exactly when the endpoints use different volumes.
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

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

pub(super) fn validate(
    spec: &super::move_model::MoveSpec,
    state: &super::move_model::MoveState,
) -> io::Result<()> {
    use super::move_model::MovePhase;
    if state.phase == MovePhase::Aborted && spec.rename_probes.is_none() {
        return Err(invalid(
            "Legacy move cannot infer aborted preflight authority",
        ));
    }
    let Some(progress) = &state.rename_probe else {
        if spec.rename_probes.is_some() && state.phase != MovePhase::Planned {
            return Err(invalid("Move has no completed rename capability evidence"));
        }
        return Ok(());
    };
    if spec.rename_probes.is_none() || progress.steps.len() != spec.probe_plans().count() {
        return Err(invalid(
            "Rename probe progress differs from its immutable plans",
        ));
    }
    if state.phase == MovePhase::Aborted {
        if !progress.removed()
            || state.effect_revision != 0
            || state.retirement.is_some()
            || state.error.is_some()
        {
            return Err(invalid(
                "Aborted preflight still owns probe effects or user history",
            ));
        }
    } else if state.phase != MovePhase::Planned && !progress.supported() {
        return Err(invalid(
            "Move effects require completed rename capability probes",
        ));
    }
    let mut objects = std::collections::HashSet::new();
    objects.insert(spec.source_parent);
    objects.insert(spec.target_parent);
    objects.insert(spec.source_version.object);
    if let Some(original) = &spec.target_original {
        objects.insert(original.object);
    }
    // Removed probe identities may be reused by later artifact creation; they
    // cannot be compared against newly created move-root identities.
    let mut prior_removed = true;
    for ((_, _, parent), step) in spec.probe_plans().zip(&progress.steps) {
        if !prior_removed && !matches!(step, Step::Planned) {
            return Err(invalid("Rename probes must execute in order"));
        }
        prior_removed &= matches!(step, Step::Absent | Step::Removed { .. });
        let (root, file) = match step {
            Step::Planned | Step::RootIntent | Step::Absent => continue,
            Step::FileIntent { root } => (*root, None),
            Step::RenameIntent { root, file } => (*root, Some(file)),
            Step::CleanupIntent {
                root,
                file,
                renamed,
                supported,
            }
            | Step::Removed {
                root,
                file,
                renamed,
                supported,
            } => {
                if (*supported && !*renamed) || (file.is_none() && (*renamed || *supported)) {
                    return Err(invalid("Probe cleanup cannot infer rename support"));
                }
                (*root, file.as_ref())
            }
        };
        spec.validate_root(parent, root)?;
        if !objects.insert(root) {
            return Err(invalid("Probe root aliases other evidence"));
        }
        if let Some(file) = file {
            file.validate()?;
            if file.size != 0
                || file.mode != 0o100600
                || !file.object.same_volume(root)
                || !objects.insert(file.object)
            {
                return Err(invalid("Probe file is not its own empty private file"));
            }
        }
    }
    Ok(())
}
