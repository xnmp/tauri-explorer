//! Read-only restore preparation, then descriptor-relative execution under one
//! selection reservation. Request spelling is a receipt key, never rebound work.
use super::{
    identity,
    plan::{verify_directory, DirectoryIdentity},
    rename_noreplace_at, resolved_restore_path, unlink, validate_private, version_at, Directory,
    INFO_SUFFIX, MAX_INFO_BYTES,
};
use crate::{
    error::AppError,
    files::{
        batch::DirectoryEffects,
        mutation::PublishedEntry,
        recovery::resources::{
            self, Access, Request, Resource, Scope, SelectionIndex, SelectionRole,
        },
        trash_artifact::{RestoreRequest, TrashArtifact, TrashSuccess},
    },
};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    ffi::{OsStr, OsString},
    io::{self, Read},
    os::unix::ffi::OsStrExt,
    path::{Path, PathBuf},
    sync::Arc,
};

const MAX_BYTES: usize = 32 * 1024 * 1024;

pub(crate) struct PreparedSelection {
    items: VecDeque<(String, Result<Prepared, String>)>,
    // Every created entry already has a bounded prepared claim. The map cannot
    // grow beyond that set and records only this batch's successful mkdirs.
    created: HashMap<PathBuf, DirectoryIdentity>,
}

struct Prepared {
    request: RestoreRequest,
    target: PathBuf,
    root: DirectoryIdentity,
    info: DirectoryIdentity,
    files: DirectoryIdentity,
    parents: Parents,
}

struct Parents {
    anchor: PathBuf,
    identity: DirectoryIdentity,
    missing: Vec<OsString>,
}

#[derive(Default)]
struct Claims {
    requests: Vec<(Request, SelectionRole)>,
    shared: HashSet<(PathBuf, Access, Scope)>,
    bytes: usize,
}
impl Claims {
    fn add(
        &mut self,
        path: &Path,
        access: Access,
        scope: Scope,
        role: SelectionRole,
    ) -> Result<(), AppError> {
        // A filesystem root cannot itself be a managed mutation entry.
        if path.file_name().is_none() {
            return Ok(());
        }
        let key = (path.to_owned(), access, scope);
        if !matches!(role, SelectionRole::Shared) || !self.shared.contains(&key) {
            self.bytes = self.bytes.saturating_add(path.as_os_str().len() * 2 + 512);
            if self.requests.len() >= 32_768 || self.bytes > MAX_BYTES {
                return Err(AppError::InvalidPath(
                    "Restore selection exceeds its preparation budget".into(),
                ));
            }
            if matches!(role, SelectionRole::Shared) {
                self.shared.insert(key);
            }
            self.requests.push((
                Request {
                    path: path.to_owned(),
                    access,
                    scope,
                },
                role,
            ));
        }
        Ok(())
    }
}

pub(crate) fn prepare(
    requests: &[RestoreRequest],
) -> Result<(PreparedSelection, Vec<Resource>), AppError> {
    prepare_with(requests, || {})
}

/// `between` runs after targets are resolved and before claims are captured:
/// the seam where an external alias retarget could split the two observations.
fn prepare_with(
    requests: &[RestoreRequest],
    mut between: impl FnMut(),
) -> Result<(PreparedSelection, Vec<Resource>), AppError> {
    let mut claims = Claims::default();
    let mut items = VecDeque::new();
    let mut retained = 0usize;
    // Claim position of each item's target request, when one was recorded.
    let mut targets = Vec::with_capacity(requests.len());
    for request in requests {
        targets.push(
            target_request_path(request)
                .file_name()
                .map(|_| claims.requests.len()),
        );
        // Even an invalid artifact retains its requested namespace claim. It
        // cannot execute, but its aligned per-item error survives batch setup.
        claims.add(
            &target_request_path(request),
            Access::Write,
            Scope::Subtree,
            SelectionRole::Exclusive,
        )?;
        let item = Prepared::new(request.clone());
        if let Ok(prepared) = &item {
            let TrashArtifact::Freedesktop {
                root,
                name,
                payload_version,
                ..
            } = request.artifact.as_ref()
            else {
                unreachable!()
            };
            for directory in [
                root.clone(),
                root.join("info"),
                root.join("files"),
                prepared.parents.anchor.clone(),
            ] {
                claims.add(
                    &directory,
                    Access::Read,
                    Scope::Entry,
                    SelectionRole::Shared,
                )?;
            }
            claims.add(
                &root.join("files").join(name),
                Access::Write,
                Scope::Subtree,
                SelectionRole::Source {
                    directory: payload_version.directory,
                },
            )?;
            claims.add(
                &root.join("info").join(info_name(name)),
                Access::Write,
                Scope::Entry,
                SelectionRole::Exclusive,
            )?;
            let mut parent = prepared.parents.anchor.clone();
            for name in &prepared.parents.missing {
                parent.push(name);
                claims.add(&parent, Access::Write, Scope::Entry, SelectionRole::Shared)?;
            }
            retained = retained.saturating_add(prepared.retained_bytes());
        } else {
            retained = retained.saturating_add(request.path.len() + 512);
        }
        if retained > MAX_BYTES {
            return Err(AppError::InvalidPath(
                "Restore plans exceed their memory budget".into(),
            ));
        }
        items.push_back((
            request.path.clone(),
            item.map_err(|error| error.to_string()),
        ));
    }
    between();
    let (requests, roles): (Vec<_>, Vec<_>) = claims.requests.into_iter().unzip();
    let captured = resources::capture_requests(&requests)?;
    // Execution restores into the target resolved above; the admitted claim
    // must name that same physical entry, or the pair came from different
    // observations of an alias and this item cannot run under the claim.
    for ((_, item), position) in items.iter_mut().zip(&targets) {
        if let (Ok(prepared), Some(position)) = (&*item, position) {
            if captured.get(*position).map(|resource| &resource.path.0) != Some(&prepared.target) {
                *item = Err(
                    "Restore destination changed while it was being prepared; nothing was restored"
                        .into(),
                );
            }
        }
    }
    let mut index = SelectionIndex::default();
    let mut resources = HashSet::new();
    for (position, resource) in captured.into_iter().enumerate() {
        index.insert(
            &resource,
            roles
                .get(position)
                .copied()
                .unwrap_or(SelectionRole::Shared),
        )?;
        resources.insert(resource);
    }
    Ok((
        PreparedSelection {
            items,
            created: HashMap::new(),
        },
        resources.into_iter().collect(),
    ))
}

impl PreparedSelection {
    pub(crate) fn execute_next(
        &mut self,
        key: &str,
        effects: &DirectoryEffects,
    ) -> Result<TrashSuccess, AppError> {
        self.execute_next_with(key, effects, || Ok(()))
    }

    fn execute_next_with(
        &mut self,
        key: &str,
        effects: &DirectoryEffects,
        before_publish: impl FnOnce() -> Result<(), AppError>,
    ) -> Result<TrashSuccess, AppError> {
        if self.items.front().map(|item| item.0.as_str()) != Some(key) {
            return Err(AppError::WorkerFailed(
                "Restore execution does not match its prepared selection".into(),
            ));
        }
        let (_, item) = self.items.pop_front().expect("checked front");
        item.map_err(AppError::Other)?
            .execute(&mut self.created, effects, before_publish)
    }
}

impl Prepared {
    fn new(request: RestoreRequest) -> Result<Self, AppError> {
        let TrashArtifact::Freedesktop {
            root,
            name,
            original_path,
            ..
        } = request.artifact.as_ref()
        else {
            return Err(AppError::InvalidPath(
                "Restore receipt is not a Freedesktop trash artifact".into(),
            ));
        };
        if !super::is_name(name) {
            return Err(AppError::InvalidPath("Invalid trash artifact name".into()));
        }
        let target = resolved_restore_path(&target_request_path(&request))?;
        if target != *original_path {
            return Err(AppError::InvalidPath(
                "Restore request does not match its trash receipt".into(),
            ));
        }
        let root_directory = Directory::open(root)?;
        validate_private(&root_directory)?;
        let info = root_directory.open_existing(OsStr::new("info"))?;
        let files = root_directory.open_existing(OsStr::new("files"))?;
        verify_artifact(&request, &info, &files)?;
        let parents = Parents::new(
            target
                .parent()
                .ok_or_else(|| AppError::InvalidPath(request.path.clone()))?,
        )?;
        Ok(Self {
            request,
            target,
            root: DirectoryIdentity::capture(&root_directory)?,
            info: DirectoryIdentity::capture(&info)?,
            files: DirectoryIdentity::capture(&files)?,
            parents,
        })
    }

    fn retained_bytes(&self) -> usize {
        std::mem::size_of::<Self>()
            + self.request.path.capacity()
            + self.target.capacity()
            + self.parents.anchor.capacity()
            + self
                .parents
                .missing
                .iter()
                .map(|name| name.capacity() + std::mem::size_of::<OsString>())
                .sum::<usize>()
    }

    fn execute(
        self,
        created: &mut HashMap<PathBuf, DirectoryIdentity>,
        effects: &DirectoryEffects,
        before_publish: impl FnOnce() -> Result<(), AppError>,
    ) -> Result<TrashSuccess, AppError> {
        let TrashArtifact::Freedesktop {
            root,
            name,
            payload_version,
            metadata_identity,
            ..
        } = self.request.artifact.as_ref()
        else {
            unreachable!()
        };
        let root_directory = Directory::open(root)?;
        verify_directory(&root_directory, &self.root)?;
        validate_private(&root_directory)?;
        let info = root_directory.open_existing(OsStr::new("info"))?;
        let files = root_directory.open_existing(OsStr::new("files"))?;
        verify_directory(&info, &self.info)?;
        verify_directory(&files, &self.files)?;
        verify_artifact(&self.request, &info, &files)?;
        let target_parent = self.parents.open(created, effects)?;
        let target_name = self.target.file_name().expect("prepared target name");
        let physical_target = target_parent.path()?.join(target_name);
        let parent = crate::files::file_identity::of_file(&target_parent.file)?;
        // Parent creation may block. Verify payload and metadata again directly
        // before publication, without discovering new paths or artifact names.
        verify_artifact(&self.request, &info, &files)?;
        before_publish()?;
        rename_noreplace_at(&files, name, &target_parent, target_name)?;
        let version = version_at(&target_parent, target_name).map_err(|error| {
            AppError::MutationUncertain(format!(
                "Restored payload identity could not be read: {error}"
            ))
        })?;
        if version != *payload_version {
            return Err(AppError::MutationUncertain(
                "Restored payload identity changed".into(),
            ));
        }
        let info_name = info_name(name);
        let cleanup = info
            .open_file(&info_name)
            .and_then(|file| file.metadata())
            .and_then(|metadata| {
                if identity(&metadata) != *metadata_identity {
                    return Err(io::Error::other(
                        "Trash metadata was replaced after restoration",
                    ));
                }
                unlink(&info, &info_name)
            });
        let mut warnings = Vec::new();
        if let Err(error) = cleanup {
            warnings.push(format!(
                "Restored item, but trash metadata cleanup failed: {error}"
            ));
        }
        if let Err(error) = target_parent
            .sync()
            .and_then(|_| files.sync())
            .and_then(|_| info.sync())
        {
            warnings.push(format!(
                "Restored item, but directory synchronization failed: {error}"
            ));
        }
        Ok(TrashSuccess {
            artifact: None,
            publication: Some(Arc::new(PublishedEntry {
                path: physical_target,
                parent,
                version,
            })),
            warning: (!warnings.is_empty()).then(|| warnings.join("; ")),
        })
    }
}

impl Parents {
    fn new(parent: &Path) -> Result<Self, AppError> {
        let mut anchor = parent;
        let mut missing = Vec::new();
        loop {
            match Directory::open(anchor) {
                Ok(directory) => {
                    missing.reverse();
                    return Ok(Self {
                        anchor: anchor.to_owned(),
                        identity: DirectoryIdentity::capture(&directory)?,
                        missing,
                    });
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    missing.push(
                        anchor
                            .file_name()
                            .ok_or_else(|| {
                                AppError::InvalidPath("Restore parent is unavailable".into())
                            })?
                            .to_owned(),
                    );
                    if missing.len() > 256 {
                        return Err(AppError::InvalidPath(
                            "Restore parent exceeds depth limit".into(),
                        ));
                    }
                    anchor = anchor.parent().expect("normal child has parent");
                }
                Err(error) => return Err(error.into()),
            }
        }
    }

    fn open(
        self,
        created: &mut HashMap<PathBuf, DirectoryIdentity>,
        effects: &DirectoryEffects,
    ) -> Result<Directory, AppError> {
        self.open_with(created, effects, |directory, name| {
            directory.create_directory_with_mode(name, 0o777)
        })
    }

    fn open_with(
        self,
        created: &mut HashMap<PathBuf, DirectoryIdentity>,
        effects: &DirectoryEffects,
        mut create: impl FnMut(&Directory, &OsStr) -> io::Result<Directory>,
    ) -> Result<Directory, AppError> {
        let mut directory = Directory::open(&self.anchor)?;
        verify_directory(&directory, &self.identity)?;
        let mut path = self.anchor;
        for name in self.missing {
            path.push(&name);
            directory = if let Some(expected) = created.get(&path) {
                let child = directory.open_existing(&name)?;
                verify_directory(&child, expected)?;
                child
            } else {
                effects.before_create(&path)?;
                let child = create(&directory, &name)?;
                created.insert(path.clone(), DirectoryIdentity::capture(&child)?);
                child
            };
        }
        Ok(directory)
    }
}

fn info_name(name: &OsStr) -> OsString {
    let mut result = name.to_owned();
    result.push(OsStr::from_bytes(INFO_SUFFIX));
    result
}

fn verify_artifact(
    request: &RestoreRequest,
    info: &Directory,
    files: &Directory,
) -> Result<(), AppError> {
    let TrashArtifact::Freedesktop {
        name,
        metadata_digest,
        metadata_identity,
        payload_version,
        ..
    } = request.artifact.as_ref()
    else {
        unreachable!()
    };
    validate_private(info)?;
    validate_private(files)?;
    let mut metadata = info.open_file(&info_name(name))?;
    let stat = metadata.metadata()?;
    if !stat.is_file() || identity(&stat) != *metadata_identity {
        return Err(AppError::Other("Trash metadata identity changed".into()));
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut metadata)
        .take(MAX_INFO_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_INFO_BYTES
        || <[u8; 32]>::from(Sha256::digest(&bytes)) != *metadata_digest
    {
        return Err(AppError::Other("Trash metadata changed".into()));
    }
    if version_at(files, name)? != *payload_version {
        return Err(AppError::Other("Trash payload identity changed".into()));
    }
    Ok(())
}

#[cfg(test)]
pub(super) fn restore(
    request: &RestoreRequest,
    effects: &DirectoryEffects,
    before_publish: impl FnOnce() -> Result<(), AppError>,
) -> Result<TrashSuccess, AppError> {
    Prepared::new(request.clone())?.execute(&mut HashMap::new(), effects, before_publish)
}

#[cfg(test)]
#[path = "../../../test_support/trash_restoration_admission.rs"]
mod tests;

// Copy history intentionally keys its native publication by the physical path's
// display projection. A trusted exact artifact preserves the actual native path;
// ordinary deletion aliases still resolve and must match that artifact.
fn target_request_path(request: &RestoreRequest) -> PathBuf {
    match request.artifact.as_ref() {
        TrashArtifact::Freedesktop { original_path, .. }
            if request.path == original_path.to_string_lossy() =>
        {
            original_path.clone()
        }
        _ => PathBuf::from(&request.path),
    }
}
