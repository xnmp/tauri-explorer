//! Real per-volume rename capability checks before any move root/user effect.
//! Probe effects are owned by the existing durable move, never by Drop cleanup.
use super::{
    coordinator::DurableOperation,
    model::{DurableIntent, EntryVersion},
    move_capability_model::{Event, Step},
    move_execution::Boundary,
    move_model::MovePhase,
    move_transition::MoveTransition,
    replacement_artifact::{Anchor, Root, RootPlan},
};
use crate::{
    error::AppError,
    files::{
        file_identity::{version_at, version_from_metadata},
        native_directory::Directory,
    },
};
use std::{ffi::OsStr, io};

const BEFORE: &str = "probe-before";
const AFTER: &str = "probe-after";

pub(super) fn plans(intent: &DurableIntent) -> Result<Vec<RootPlan>, AppError> {
    let spec = intent.operation.move_spec()?;
    Ok(spec
        .probe_plans()
        .map(|(plan, endpoint, parent)| RootPlan {
            parent_path: endpoint
                .0
                .parent()
                .expect("validated endpoint parent")
                .to_owned(),
            parent,
            root: plan.path.0.clone(),
            token: plan.token.clone(),
            excluded: std::iter::once(spec.source_version.object)
                .chain(spec.target_original.iter().map(|original| original.object))
                .collect(),
        })
        .collect())
}

fn anchor(operation: &DurableOperation, index: usize) -> Result<Anchor, AppError> {
    let plan = plans(operation.intent())?
        .into_iter()
        .nth(index)
        .ok_or_else(|| invalid("Rename probe index exceeds its immutable plan"))?;
    Anchor::open_plan(operation.intent(), plan)
}
fn step(operation: &DurableOperation, index: usize) -> Result<Step, AppError> {
    operation
        .state()
        .move_state()?
        .rename_probe
        .as_ref()
        .and_then(|progress| progress.steps.get(index))
        .cloned()
        .ok_or_else(|| invalid("Rename probe has no recorded progress"))
}
fn advance(operation: &mut DurableOperation, index: usize, event: Event) -> Result<(), AppError> {
    operation.advance_move(MoveTransition::Probe(index, event))
}
fn at(hook: Option<&Boundary>, label: &'static str) -> Result<(), AppError> {
    hook.map_or(Ok(()), |hook| hook(label))
}
fn observed(root: &Root, name: &str) -> Result<Option<EntryVersion>, AppError> {
    match version_at(root.directory(), OsStr::new(name)) {
        Ok(version) => Ok(Some(version)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}
fn exact_namespace(
    root: &Root,
    expected: Option<(&str, &EntryVersion)>,
    removing: bool,
) -> Result<(), AppError> {
    root.verify_namespace()?;
    let names = root.directory().names(1)?;
    if names
        .iter()
        .any(|name| Some(name.as_os_str()) != expected.map(|(name, _)| OsStr::new(name)))
    {
        return Err(invalid(
            "Rename probe contains unrecorded entries; evidence is preserved",
        ));
    }
    if let Some((name, version)) = expected {
        match observed(root, name)? {
            Some(actual) if actual == *version => {}
            None if removing => {}
            _ => return Err(invalid("Rename probe file changed; evidence is preserved")),
        }
    }
    root.verify_namespace()
}

pub(super) fn qualify(
    operation: DurableOperation,
    hook: Option<&Boundary>,
) -> Result<DurableOperation, AppError> {
    qualify_with(operation, hook, Directory::rename_to).map_err(Failure::into_app_error)
}

#[derive(Debug)]
enum Failure {
    Retained(AppError),
    Rejected(AppError),
}
impl From<AppError> for Failure {
    fn from(error: AppError) -> Self {
        Self::Retained(error)
    }
}
impl From<io::Error> for Failure {
    fn from(error: io::Error) -> Self {
        Self::Retained(error.into())
    }
}
impl Failure {
    fn into_app_error(self) -> AppError {
        match self {
            Self::Rejected(error) => error,
            Self::Retained(error) => AppError::MutationUncertain(format!("Rename capability evidence is retained in File Recovery; inspect it before retrying. {error}")),
        }
    }
}

fn qualify_with(
    mut operation: DurableOperation,
    hook: Option<&Boundary>,
    mut rename: impl FnMut(&Directory, &OsStr, &Directory, &OsStr) -> io::Result<()>,
) -> Result<DurableOperation, Failure> {
    if operation
        .intent()
        .operation
        .move_spec()?
        .rename_probes
        .is_none()
    {
        return Ok(operation);
    }
    let state = operation.state().move_state()?;
    if state.phase != MovePhase::Planned || state.rename_probe.is_some() {
        return Err(invalid("Interrupted capability checks require explicit recovery").into());
    }
    for index in 0..plans(operation.intent())?.len() {
        advance(&mut operation, index, Event::BeginRoot)?;
        at(hook, "probe-root-intent")?;
        let root = anchor(&operation, index)?.create()?;
        at(hook, "probe-root-created")?;
        advance(&mut operation, index, Event::RootObserved(root.identity()))?;
        at(hook, "probe-file-intent")?;
        let file = root.directory().create_file(OsStr::new(BEFORE))?;
        file.sync_all()?;
        root.directory().sync()?;
        let version = version_from_metadata(&file.metadata()?)?;
        at(hook, "probe-file-created")?;
        advance(&mut operation, index, Event::FileObserved(version.clone()))?;
        at(hook, "probe-rename-intent")?;
        exact_namespace(&root, Some((BEFORE, &version)), false)?;
        let result = rename(
            root.directory(),
            OsStr::new(BEFORE),
            root.directory(),
            OsStr::new(AFTER),
        );
        at(hook, "probe-rename-returned")?;
        match result {
            Ok(()) => {
                exact_namespace(&root, Some((AFTER, &version)), false)?;
                root.directory().sync()?;
                advance(
                    &mut operation,
                    index,
                    Event::BeginCleanup {
                        renamed: true,
                        supported: true,
                    },
                )?;
                at(hook, "probe-cleanup-intent")?;
                drop(root);
                cleanup_one(&mut operation, index, hook)?;
            }
            Err(error) => {
                // Failure does not establish non-effect (notably over NFS).
                // Only exact unchanged endpoints plus a documented capability
                // errno authorize the normal unsupported/cleanup path.
                exact_namespace(&root, Some((BEFORE, &version)), false)?;
                if !unsupported(&error) {
                    return Err(error.into());
                }
                advance(
                    &mut operation,
                    index,
                    Event::BeginCleanup {
                        renamed: false,
                        supported: false,
                    },
                )?;
                at(hook, "probe-cleanup-intent")?;
                drop(root);
                cleanup_one(&mut operation, index, hook)?;
                discard(operation, hook)?;
                return Err(Failure::Rejected(AppError::Other(format!(
                    "Filesystem does not support exclusive rename; move was not started: {error}"
                ))));
            }
        }
    }
    verify_absent(&operation)?;
    Ok(operation)
}

fn unsupported(error: &io::Error) -> bool {
    matches!(
        error.raw_os_error(),
        Some(libc::ENOSYS | libc::EOPNOTSUPP | libc::EINVAL)
    )
}

/// Read-only evidence check for explicit preflight cleanup. Unknown creation
/// windows are intentionally preserved; private names alone never prove ownership.
pub(super) fn inspect(operation: &DurableOperation) -> Result<(), AppError> {
    let state = operation.state().move_state()?;
    if !matches!(state.phase, MovePhase::Planned | MovePhase::Aborted)
        || operation
            .intent()
            .operation
            .move_spec()?
            .rename_probes
            .is_none()
    {
        return Err(invalid("Move is not in capability preflight"));
    }
    for index in 0..plans(operation.intent())?.len() {
        let step = state
            .rename_probe
            .as_ref()
            .map_or(Step::Planned, |p| p.steps[index].clone());
        match step {
            Step::Planned | Step::RootIntent | Step::Absent | Step::Removed { .. } => {
                anchor(operation, index)?.verify_absent()?
            }
            Step::FileIntent { root } => {
                let root = anchor(operation, index)?.open_existing(root)?;
                exact_namespace(&root, None, false)?;
            }
            Step::RenameIntent { root, file } => {
                let root = anchor(operation, index)?.open_existing(root)?;
                let name = if observed(&root, BEFORE)?.as_ref() == Some(&file) {
                    BEFORE
                } else {
                    AFTER
                };
                exact_namespace(&root, Some((name, &file)), false)?;
            }
            Step::CleanupIntent {
                root,
                file,
                renamed,
                ..
            } => {
                if let Some(root) = anchor(operation, index)?.open_optional(root)? {
                    exact_namespace(
                        &root,
                        file.as_ref()
                            .map(|file| (if renamed { AFTER } else { BEFORE }, file)),
                        true,
                    )?;
                }
            }
        }
    }
    Ok(())
}

/// Cleanup only; never resumes a user's move after a renderer/process failure.
pub(super) fn discard(
    mut operation: DurableOperation,
    hook: Option<&Boundary>,
) -> Result<(), AppError> {
    inspect(&operation)?;
    if operation.state().move_state()?.phase == MovePhase::Aborted {
        return operation.retire_record();
    }
    let count = plans(operation.intent())?.len();
    // Initialize progress through the ordinary first transition when the move
    // was dropped after promotion but before its first capability checkpoint.
    if operation.state().move_state()?.rename_probe.is_none() {
        advance(&mut operation, 0, Event::Absent)?;
    }
    for index in 0..count {
        match step(&operation, index)? {
            Step::Planned | Step::RootIntent => {
                anchor(&operation, index)?.verify_absent()?;
                advance(&mut operation, index, Event::Absent)?;
            }
            Step::FileIntent { .. } => advance(
                &mut operation,
                index,
                Event::BeginCleanup {
                    renamed: false,
                    supported: false,
                },
            )?,
            Step::RenameIntent { root, file } => {
                let root = anchor(&operation, index)?.open_existing(root)?;
                let renamed = observed(&root, AFTER)?.as_ref() == Some(&file);
                exact_namespace(
                    &root,
                    Some((if renamed { AFTER } else { BEFORE }, &file)),
                    false,
                )?;
                advance(
                    &mut operation,
                    index,
                    Event::BeginCleanup {
                        renamed,
                        supported: false,
                    },
                )?;
            }
            Step::CleanupIntent { .. } | Step::Absent | Step::Removed { .. } => {}
        }
        cleanup_one(&mut operation, index, hook)?;
    }
    verify_absent(&operation)?;
    operation.advance_move(MoveTransition::AbortPreflight)?;
    at(hook, "probe-aborted")?;
    operation.retire_record()
}

fn verify_absent(operation: &DurableOperation) -> Result<(), AppError> {
    for index in 0..plans(operation.intent())?.len() {
        anchor(operation, index)?.verify_absent()?;
    }
    Ok(())
}

fn cleanup_one(
    operation: &mut DurableOperation,
    index: usize,
    hook: Option<&Boundary>,
) -> Result<(), AppError> {
    let (identity, file, renamed) = match step(operation, index)? {
        Step::Absent | Step::Removed { .. } => return anchor(operation, index)?.verify_absent(),
        Step::CleanupIntent {
            root,
            file,
            renamed,
            ..
        } => (root, file, renamed),
        _ => return Err(invalid("Rename probe removal has no durable intent")),
    };
    if let Some(root) = anchor(operation, index)?.open_optional(identity)? {
        let name = if renamed { AFTER } else { BEFORE };
        exact_namespace(&root, file.as_ref().map(|file| (name, file)), true)?;
        if file.is_some() && root.directory().entry_exists(OsStr::new(name))? {
            // Recheck immediately before the destructive syscall.
            exact_namespace(&root, file.as_ref().map(|file| (name, file)), false)?;
            root.directory().unlink(OsStr::new(name), false)?;
            root.directory().sync()?;
        }
        at(hook, "probe-file-removed")?;
        exact_namespace(&root, None, true)?;
        root.remove_empty_probe()?;
    }
    at(hook, "probe-root-removed")?;
    advance(operation, index, Event::Removed)?;
    at(hook, "probe-removed")
}

fn invalid(message: &str) -> AppError {
    io::Error::new(io::ErrorKind::InvalidData, message).into()
}

#[cfg(all(test, target_os = "linux"))]
#[path = "../../../test_support/recovery_move_capability.rs"]
mod tests;
