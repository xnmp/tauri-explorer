//! Production durable-move orchestration. One worker owns admission, binding,
//! promotion and every filesystem effect; no phase owner escapes its result.
//!
//! Nothing here plans a source park. The executor reaches parking only from a
//! `Published` checkpoint, so an error or crash while preparing leaves the
//! user's source exactly where it was.
use super::{
    coordinator::{Coordinator, Reservation},
    model::{NativePath, OperationSpec},
    move_execution::MoveExecution,
    move_model::{ArtifactPlan, MoveSpec, Strategy},
    resources::{Access, Request, Scope},
};
use crate::{
    error::AppError,
    files::{
        anchored_copy::CopyProgress,
        file_identity::{of_file, version_from_metadata},
        mutation::{FileMutationReceipt, MoveRecoveryReceipt},
        native_directory::Directory,
    },
};
use std::{
    fs, io,
    path::{Path, PathBuf},
    sync::Arc,
};

/// Own the admitted paths separately from execution so the refresh projection
/// survives even a panicking worker. No artifact effects occur while preparing.
pub(super) struct PreparedMove {
    reservation: Reservation,
    spec: MoveSpec,
    presentation: PathBuf,
}

/// Native observation of the endpoints an ordered move inspected before asking
/// for an overwrite decision. Revalidated under admission before any effect.
#[cfg(target_os = "linux")]
pub(crate) struct MoveObservation {
    pub source: crate::files::entry_version::EntryVersion,
    pub source_parent: crate::files::object_id::ObjectId,
    pub target_parent: crate::files::object_id::ObjectId,
    pub target: Option<crate::files::entry_version::EntryVersion>,
}

struct PendingMove {
    requests: Vec<Request>,
    source_token: Option<String>,
    target_token: Option<String>,
    requested_source: PathBuf,
    presentation: PathBuf,
}

fn token() -> Result<String, AppError> {
    let mut nonce = [0u8; 32];
    getrandom::fill(&mut nonce).map_err(|error| AppError::Other(error.to_string()))?;
    Ok(hex::encode(nonce))
}

fn artifact(parent: &Path, token: &str) -> PathBuf {
    parent.join(format!(".tauri-explorer-recovery-{token}"))
}

fn parent_of(path: &Path, what: &str) -> Result<PathBuf, AppError> {
    Ok(path
        .parent()
        .ok_or_else(|| AppError::InvalidPath(format!("Move {what} requires a parent directory")))?
        .to_owned())
}

impl PendingMove {
    /// Decide the artifact layout from a pre-admission observation. Admission
    /// rebinds aliases, so `bind` re-derives and rejects any disagreement.
    fn new(source: &Path, target: &Path) -> Result<Self, AppError> {
        let source_parent = parent_of(source, "source")?;
        let target_parent = parent_of(target, "destination")?;
        let cross_volume = !same_volume(&source_parent, &target_parent)?;
        let overwriting = fs::symlink_metadata(target).is_ok();
        let source_token = cross_volume.then(token).transpose()?;
        let target_token = (cross_volume || overwriting).then(token).transpose()?;
        let mut requests: Vec<Request> = [
            (source.to_owned(), Access::Write),
            (target.to_owned(), Access::Write),
        ]
        .into_iter()
        .map(|(path, access)| Request {
            path,
            access,
            scope: Scope::Subtree,
        })
        .collect();
        for (token, parent) in [
            (source_token.as_ref(), &source_parent),
            (target_token.as_ref(), &target_parent),
        ] {
            let Some(token) = token else { continue };
            requests.push(Request {
                path: artifact(parent, token),
                access: Access::Write,
                scope: Scope::Subtree,
            });
        }
        Ok(Self {
            requests,
            source_token,
            target_token,
            requested_source: source.to_owned(),
            presentation: target.to_owned(),
        })
    }

    fn bind(&self, reservation: &Reservation) -> Result<MoveSpec, AppError> {
        let mut paths = reservation.paths().map(Path::to_path_buf);
        let invalid = || AppError::Other("Move admission returned invalid path bindings".into());
        let source = paths.next().ok_or_else(invalid)?;
        let target = paths.next().ok_or_else(invalid)?;
        // Capture resolves parent aliases only. Following a source leaf would
        // relocate a symlink's referent instead of the selected symlink, so the
        // admitted leaf names must still be exactly the requested ones.
        if !source.is_absolute()
            || !target.is_absolute()
            || source.file_name() != self.requested_source.file_name()
            || target.file_name() != self.presentation.file_name()
        {
            return Err(invalid());
        }
        let source_parent = Directory::open(&parent_of(&source, "source")?)?;
        let target_parent = Directory::open(&parent_of(&target, "destination")?)?;
        let source_identity = of_file(&source_parent.file)?;
        let target_identity = of_file(&target_parent.file)?;
        let cross_volume = !source_identity.same_volume(target_identity);
        let target_original = match fs::symlink_metadata(&target) {
            Ok(metadata) => Some(version_from_metadata(&metadata)?),
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        };
        // The artifact layout was planned before admission. If the volumes or
        // the conflict changed underneath it, retire rather than improvise.
        if cross_volume != self.source_token.is_some()
            || (cross_volume || target_original.is_some()) != self.target_token.is_some()
        {
            return Err(AppError::Other(
                "Move destination or filesystem changed before admission; retry the request".into(),
            ));
        }
        let mut plan = |token: &Option<String>, parent: &Path| -> Result<Option<ArtifactPlan>, AppError> {
            let Some(token) = token else { return Ok(None) };
            let expected = artifact(parent, token);
            let admitted = paths.next().ok_or_else(invalid)?;
            if admitted != expected {
                return Err(invalid());
            }
            Ok(Some(ArtifactPlan {
                path: NativePath(admitted),
                token: token.clone(),
            }))
        };
        let source_root = plan(&self.source_token, &parent_of(&source, "source")?)?;
        let target_root = plan(&self.target_token, &parent_of(&target, "destination")?)?;
        if paths.next().is_some() {
            return Err(invalid());
        }
        let spec = MoveSpec {
            source_version: version_from_metadata(&fs::symlink_metadata(&source)?)?,
            source: NativePath(source),
            source_parent: source_identity,
            target: NativePath(target),
            target_parent: target_identity,
            target_original,
            strategy: if cross_volume {
                Strategy::CopyParked
            } else {
                Strategy::Rename
            },
            source_root,
            target_root,
        };
        reservation.validate_operation(OperationSpec::Move(spec.clone()))?;
        Ok(spec)
    }
}

fn same_volume(left: &Path, right: &Path) -> Result<bool, AppError> {
    use std::os::unix::fs::MetadataExt;
    Ok(fs::metadata(left)?.dev() == fs::metadata(right)?.dev())
}

impl PreparedMove {
    pub(super) fn prepare(
        coordinator: &Arc<Coordinator>,
        source: &Path,
        target: &Path,
    ) -> Result<Self, AppError> {
        let mut pending = PendingMove::new(source, target)?;
        let requests = std::mem::take(&mut pending.requests);
        let reservation = coordinator.reserve(requests)?;
        match pending.bind(&reservation) {
            Ok(spec) => Ok(Self {
                reservation,
                spec,
                presentation: pending.presentation,
            }),
            Err(error) => Err(retire(vec![reservation], error)),
        }
    }

    #[cfg(target_os = "linux")]
    pub(super) fn matches_observation(&self, expected: &MoveObservation) -> bool {
        self.spec.source_version == expected.source
            && self.spec.source_parent == expected.source_parent
            && self.spec.target_parent == expected.target_parent
            && self.spec.target_original == expected.target
    }

    pub(super) fn retire(moves: Vec<Self>, error: AppError) -> AppError {
        retire(
            moves.into_iter().map(|prepared| prepared.reservation).collect(),
            error,
        )
    }

    #[cfg(test)]
    pub(super) fn strategy(&self) -> Strategy {
        self.spec.strategy
    }

    pub(super) fn execute(
        self,
        progress: &mut impl CopyProgress,
    ) -> Result<FileMutationReceipt, AppError> {
        self.execute_with(progress, None)
    }

    pub(super) fn execute_with(
        self,
        progress: &mut impl CopyProgress,
        hook: Option<super::move_execution::Boundary>,
    ) -> Result<FileMutationReceipt, AppError> {
        let Self {
            reservation,
            spec,
            presentation,
        } = self;
        if let Err(error) = progress.check_cancelled() {
            return Err(retire(vec![reservation], error));
        }
        let committed = spec.target.0.clone();
        let source = spec.source.0.clone();
        let target_parent = spec.target_parent;
        let staging = spec.strategy == Strategy::CopyParked;
        let overwriting = spec.target_original.is_some();
        // A failed promotion may already have published catalog evidence. From
        // here errors must never promise ordinary partial cleanup.
        let operation = reservation
            .promote(OperationSpec::Move(spec))
            .map_err(|failure| {
                let error = failure.error;
                drop(failure.reservation);
                retained(error)
            })?;
        let id = operation.intent().id.clone();
        let result = (|| {
            let mut execution = MoveExecution::prepare_with(operation, hook)?;
            if staging {
                execution.stage_copy(progress)?;
                // Cancellation is honoured until the destination is touched.
                progress.check_cancelled()?;
            }
            if overwriting {
                execution.displace_target()?;
            }
            execution.publish_move()?;
            if staging {
                // Only now may the source stop being reachable at its name.
                execution.park_source()?;
            }
            Ok::<_, AppError>(execution.operation.state().move_state()?.effect_revision)
        })();
        let revision = result.map_err(retained)?;
        let mut receipt = FileMutationReceipt::committed(&committed);
        // Keep the pane's alias spelling only while its parent still denotes
        // the native directory captured by the durable operation.
        if presentation
            .parent()
            .and_then(|parent| fs::canonicalize(parent).ok())
            .and_then(|parent| Directory::open(&parent).ok())
            .and_then(|directory| of_file(&directory.file).ok())
            == Some(target_parent)
        {
            receipt.path = presentation.to_string_lossy().into_owned();
            if let Some(entry) = &mut receipt.entry {
                entry.path = receipt.path.clone();
            }
        }
        let mut refresh_dirs: Vec<String> = [
            committed.as_path(),
            source.as_path(),
            Path::new(&receipt.path),
            presentation.as_path(),
        ]
        .into_iter()
        .filter_map(Path::parent)
        .map(|parent| parent.to_string_lossy().into_owned())
        .collect();
        refresh_dirs.sort_unstable();
        refresh_dirs.dedup();
        receipt.relocation = Some(MoveRecoveryReceipt {
            history: super::model::ReplacementHistory {
                id: id.clone(),
                revision,
                refresh_dirs,
            },
            id,
            warning: None,
        });
        Ok(receipt)
    }
}

fn retire(reservations: Vec<Reservation>, error: AppError) -> AppError {
    super::forward_copy::finish_unstarted_owners(reservations, error)
}

fn retained(error: AppError) -> AppError {
    AppError::MutationUncertain(format!(
        "Move evidence is retained in File Recovery; inspect it before retrying. {error}"
    ))
}

#[cfg(test)]
#[path = "../../../test_support/recovery_forward_move.rs"]
mod tests;
