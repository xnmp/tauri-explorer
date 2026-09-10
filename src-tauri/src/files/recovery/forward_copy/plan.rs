//! Bind every independent replacement before yielding an executable child.
//! Preparation owns reservations only: no catalog, artifact or user-file effects.
use super::PreparedCopy;
use crate::{
    error::AppError,
    files::{
        anchored_copy::CopyProgress,
        file_identity::{of_file, version_from_metadata},
        native_directory::Directory,
        recovery::{
            coordinator::{Coordinator, Reservation},
            journal::MAX_RECORDS,
            model::{NativePath, OperationSpec, ReplacementSpec},
            resources::{Access, Request, Scope},
        },
    },
};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};

struct PendingCopy {
    requests: Vec<Request>,
    token: String,
    presentation: PathBuf,
}

impl PendingCopy {
    fn new(source: &Path, target: &Path) -> Result<Self, AppError> {
        let parent = target.parent().ok_or_else(|| {
            AppError::InvalidPath("Copy destination requires a parent directory".into())
        })?;
        let mut nonce = [0u8; 32];
        getrandom::fill(&mut nonce).map_err(|error| AppError::Other(error.to_string()))?;
        let token = hex::encode(nonce);
        let root = parent.join(format!(".tauri-explorer-recovery-{token}"));
        Ok(Self {
            requests: [
                (source.to_owned(), Access::Read),
                (target.to_owned(), Access::Write),
                (root, Access::Write),
            ]
            .into_iter()
            .map(|(path, access)| Request {
                path,
                access,
                scope: Scope::Subtree,
            })
            .collect(),
            token,
            presentation: target.to_owned(),
        })
    }

    fn bind(&self, reservation: &Reservation) -> Result<ReplacementSpec, AppError> {
        let paths: Vec<_> = reservation.paths().map(Path::to_path_buf).collect();
        let [source, target, root]: [_; 3] = paths.try_into().map_err(|_| {
            AppError::Other("Replacement admission returned invalid path bindings".into())
        })?;
        let directory = Directory::open(target.parent().ok_or_else(|| {
            AppError::InvalidPath("Admitted copy destination has no parent".into())
        })?)?;
        let spec = ReplacementSpec {
            source_version: version_from_metadata(&fs::symlink_metadata(&source)?)?,
            original: version_from_metadata(&fs::symlink_metadata(&target)?)?,
            source: NativePath(source),
            target: NativePath(target),
            root: NativePath(root),
            parent: of_file(&directory.file)?,
            artifact_token: self.token.clone(),
        };
        reservation.validate_operation(OperationSpec::CopyReplacement(spec.clone()))?;
        Ok(spec)
    }
}

#[cfg(test)]
pub(in crate::files::recovery) fn prepare(
    coordinator: &Arc<Coordinator>,
    source: &Path,
    target: &Path,
    progress: &mut impl CopyProgress,
) -> Result<PreparedCopy, AppError> {
    prepare_batch(coordinator, &[(source, target)], progress)
        .map(|mut copies| copies.pop().expect("one requested replacement"))
}

/// Exact targets are supplied by the caller's conflict policy. This primitive
/// supports independent children only; it must not reinterpret ordered overlaps
/// or choose new names when execution eventually starts.
pub(in crate::files::recovery) fn prepare_batch(
    coordinator: &Arc<Coordinator>,
    copies: &[(&Path, &Path)],
    progress: &mut impl CopyProgress,
) -> Result<Vec<PreparedCopy>, AppError> {
    if copies.is_empty() || copies.len() > MAX_RECORDS {
        return Err(AppError::InvalidPath(
            "Replacement batch has an invalid operation count".into(),
        ));
    }
    let mut pending = copies
        .iter()
        .map(|(source, target)| {
            progress.check_cancelled()?;
            PendingCopy::new(source, target)
        })
        .collect::<Result<Vec<_>, AppError>>()?;
    let groups = pending
        .iter_mut()
        .map(|copy| std::mem::take(&mut copy.requests))
        .collect();
    let reservations = coordinator.reserve_batch(groups)?;
    // Keep all owners together until every binding validates. On error, no
    // prefix can escape and every unstarted owner receives explicit settlement.
    let specs = pending
        .iter()
        .zip(&reservations)
        .map(|(copy, reservation)| {
            progress.check_cancelled()?;
            copy.bind(reservation)
        })
        .collect::<Result<Vec<_>, AppError>>();
    match specs {
        Ok(specs) => Ok(pending
            .into_iter()
            .zip(reservations)
            .zip(specs)
            .map(|((copy, reservation), spec)| PreparedCopy {
                reservation,
                spec,
                presentation: copy.presentation,
            })
            .collect()),
        Err(error) => Err(finish_unstarted(reservations, error)),
    }
}

/// Cleanup failure does not imply user-file effects. Preserve the original
/// diagnostic and report bounded ownership cleanup detail without hiding later
/// siblings behind the first failed retirement.
pub(super) fn finish_unstarted(reservations: Vec<Reservation>, error: AppError) -> AppError {
    match retire_unstarted(reservations) {
        Some(warning) => AppError::Other(format!("{error}\n{warning}. No copy was started; retry ownership admission after storage is available.")),
        None => error,
    }
}

pub(super) fn retire_unstarted(
    reservations: impl IntoIterator<Item = Reservation>,
) -> Option<String> {
    let mut failures = 0;
    let mut first = None;
    for reservation in reservations {
        let result =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| reservation.finish()))
                .unwrap_or_else(|_| {
                    Err(AppError::Other("Copy ownership retirement panicked".into()))
                });
        if let Err(cleanup) = result {
            log::warn!("Could not settle unstarted copy admission: {cleanup}");
            failures += 1;
            if first.is_none() {
                first = Some(cleanup.to_string().chars().take(1024).collect::<String>());
            }
        }
    }
    first.map(|first| {
        format!("Could not retire {failures} unstarted copy ownership record(s): {first}")
    })
}

#[cfg(test)]
#[path = "../../../../test_support/recovery_copy_plan.rs"]
mod tests;
