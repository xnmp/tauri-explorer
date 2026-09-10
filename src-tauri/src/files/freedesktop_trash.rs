//! Exact, interoperable Freedesktop trash receipts for Linux.

#[cfg(test)]
use super::native_directory::native_name;
use super::native_directory::{is_name, Directory};
use super::{
    batch,
    entry_version::EntryVersion,
    file_identity::version_at,
    trash_artifact::{EntryIdentity, RestoreRequest, TrashArtifact, TrashSuccess},
    trash_mounts::{Mount, MountSnapshot},
};
use crate::error::AppError;
use sha2::{Digest, Sha256};
use std::{
    ffi::{OsStr, OsString},
    fs::{File, Metadata},
    io::{self, Read, Write},
    os::unix::{
        ffi::OsStrExt,
        ffi::OsStringExt,
        fs::{MetadataExt, PermissionsExt},
    },
    path::{Component, Path, PathBuf},
    sync::Arc,
};

const INFO_SUFFIX: &[u8] = b".trashinfo";
const MAX_INFO_BYTES: u64 = 1024 * 1024;

mod plan;
mod selection;

pub(crate) struct Context {
    mounts: MountSnapshot,
    data_home: PathBuf,
}

impl Context {
    /// Snapshot the mount namespace without creating trash directories.
    pub(crate) fn new() -> Result<Self, AppError> {
        let data_home = dirs::data_dir()
            .filter(|path| path.is_absolute())
            .ok_or_else(|| AppError::InvalidPath("XDG data directory is unavailable".into()))?;
        Ok(Self {
            mounts: MountSnapshot::read()?,
            data_home,
        })
    }

    #[cfg(test)]
    pub(crate) fn trash(&mut self, path: &Path) -> Result<TrashSuccess, AppError> {
        self.trash_with_post_commit(path, |source, files, info| {
            source.sync()?;
            files.sync()?;
            info.sync()
        })
    }

    #[cfg(test)]
    fn trash_with_post_commit(
        &mut self,
        path: &Path,
        post_commit: impl FnOnce(&Directory, &Directory, &Directory) -> io::Result<()>,
    ) -> Result<TrashSuccess, AppError> {
        let mut random = random_bytes;
        self.trash_with(path, &mut random, rename_noreplace_at, post_commit)
    }

    #[cfg(test)]
    fn trash_with(
        &mut self,
        path: &Path,
        random: &mut impl FnMut(&mut [u8]) -> io::Result<()>,
        move_entry: impl FnMut(&Directory, &OsStr, &Directory, &OsStr) -> io::Result<()>,
        post_commit: impl FnOnce(&Directory, &Directory, &Directory) -> io::Result<()>,
    ) -> Result<TrashSuccess, AppError> {
        self.prepare(path, random)?
            .execute_with(move_entry, post_commit)
    }

    #[cfg(test)]
    fn open_trash(&self, layout: &TrashLayout) -> Result<TrashDirectories, AppError> {
        match layout {
            TrashLayout::Home => plan::open_home(&self.data_home),
            TrashLayout::Mounted(mount) => plan::open_mounted(mount),
        }
    }
}

impl plan::Prepared {
    fn execute_with(
        self,
        mut move_entry: impl FnMut(&Directory, &OsStr, &Directory, &OsStr) -> io::Result<()>,
        post_commit: impl FnOnce(&Directory, &Directory, &Directory) -> io::Result<()>,
    ) -> Result<TrashSuccess, AppError> {
        let Self {
            source_parent_path,
            source_parent_identity,
            source_name,
            original_path,
            source_version,
            source_mount,
            layout,
            fallback,
            name,
            info_name,
            temporary_name,
            metadata,
            digest,
        } = self;
        let source_parent = Directory::open(&source_parent_path)?;
        plan::verify_directory(&source_parent, &source_parent_identity)?;
        if version_at(&source_parent, &source_name)? != source_version {
            return Err(AppError::Other(
                "Trash source changed after preparation".into(),
            ));
        }
        if super::trash_mounts::mount_id(&original_path)?.is_some_and(|mount| mount != source_mount)
        {
            return Err(AppError::Other(
                "Trash source mount changed after preparation".into(),
            ));
        }
        let mut last_error = None;
        for layout in std::iter::once(layout).chain(fallback) {
            let directories = match layout.execute() {
                Ok(directories) => directories,
                Err(error) => {
                    last_error = Some(error);
                    continue;
                }
            };
            let (metadata_identity, reserved) =
                match reserve_info(&directories.info, &info_name, &temporary_name, &metadata) {
                    Ok(Some(reserved)) => reserved,
                    Ok(None) => {
                        last_error = Some(AppError::AlreadyExists(
                            "Prepared trash metadata name is occupied".into(),
                        ));
                        continue;
                    }
                    Err(error @ AppError::MutationUncertain(_)) => return Err(error),
                    Err(error) => {
                        last_error = Some(error);
                        continue;
                    }
                };
            if let Err(error) = directories.info.sync() {
                drop(reserved);
                match cleanup_info(&directories.info, &info_name) {
                    Ok(()) => {
                        last_error = Some(error.into());
                        continue;
                    }
                    Err(cleanup) => return Err(AppError::MutationUncertain(format!(
                        "Trash metadata could not be synchronized: {error}; cleanup also failed: {cleanup}"
                    ))),
                }
            }
            match move_entry(&source_parent, &source_name, &directories.files, &name) {
                Ok(()) => {
                    drop(reserved);
                    let (artifact, identity_warning) = match version_at(&directories.files, &name) {
                        Ok(payload_version) if payload_version == source_version => (
                            Some(Arc::new(TrashArtifact::Freedesktop {
                                root: directories.root_path.clone(),
                                name,
                                original_path: original_path.clone(),
                                metadata_digest: digest,
                                metadata_identity,
                                payload_version,
                            })),
                            None,
                        ),
                        Ok(_) => {
                            let sync_warning = post_commit(
                                &source_parent,
                                &directories.files,
                                &directories.info,
                            )
                            .err()
                            .map(|error| format!("; directory synchronization also failed: {error}"))
                            .unwrap_or_default();
                            return Err(AppError::MutationUncertain(format!(
                                "The source identity changed while {} was moved to trash; metadata and the unverified payload were retained at {} and {}{sync_warning}",
                                original_path.display(),
                                directories.root_path.join("info").join(&info_name).display(),
                                directories.root_path.join("files").join(&name).display()
                            )));
                        }
                        Err(error) => (
                            None,
                            Some(format!(
                                "Item was moved to trash, but its recovery identity could not be read: {error}"
                            )),
                        ),
                    };
                    let sync_warning = post_commit(
                        &source_parent,
                        &directories.files,
                        &directories.info,
                    )
                    .err()
                    .map(|error| {
                        format!(
                            "Item was moved to trash, but its directory metadata could not be synchronized: {error}"
                        )
                    });
                    let warning = match (identity_warning, sync_warning) {
                        (Some(identity), Some(sync)) => Some(format!("{identity}; {sync}")),
                        (Some(warning), None) | (None, Some(warning)) => Some(warning),
                        (None, None) => None,
                    };
                    return Ok(TrashSuccess {
                        artifact,
                        warning,
                        publication: None,
                    });
                }
                Err(error) => {
                    drop(reserved);
                    let source_after = probe_version_at(&source_parent, &source_name);
                    let payload_after = probe_version_at(&directories.files, &name);
                    let source_unchanged = source_after
                        .as_ref()
                        .is_ok_and(|value| value.as_ref() == Some(&source_version));
                    let payload_is_source = payload_after.as_ref().is_ok_and(|value| {
                        value.as_ref().is_some_and(|value| *value == source_version)
                    });
                    if source_unchanged {
                        match cleanup_info(&directories.info, &info_name) {
                            Ok(()) => {
                                last_error = Some(error.into());
                                continue;
                            }
                            Err(cleanup) => return Err(AppError::MutationUncertain(format!(
                                "Could not move {} to trash: {error}; incomplete metadata remains at {}: {cleanup}",
                                original_path.display(),
                                directories.root_path.join("info").join(&info_name).display()
                            ))),
                        }
                    }
                    if let (Ok(None), Ok(Some(payload_version))) = (&source_after, &payload_after) {
                        if !payload_is_source {
                            return Err(AppError::MutationUncertain(format!(
                                "Moving {} to trash returned {error}, and a different payload occupies {}; metadata was retained at {}",
                                original_path.display(),
                                directories.root_path.join("files").join(&name).display(),
                                directories.root_path.join("info").join(&info_name).display()
                            )));
                        }
                        let artifact = Arc::new(TrashArtifact::Freedesktop {
                            root: directories.root_path.clone(),
                            name,
                            original_path: original_path.clone(),
                            metadata_digest: digest,
                            metadata_identity,
                            payload_version: payload_version.clone(),
                        });
                        let sync_warning =
                            post_commit(&source_parent, &directories.files, &directories.info)
                                .err()
                                .map(|sync| {
                                    format!("; directory synchronization also failed: {sync}")
                                })
                                .unwrap_or_default();
                        return Ok(TrashSuccess {
                            publication: None,
                            artifact: Some(artifact),
                            warning: Some(format!(
                                "The rename reported an error, but the exact payload was verified in trash: {error}{sync_warning}"
                            )),
                        });
                    }
                    return Err(AppError::MutationUncertain(format!(
                        "Moving {} to trash returned {error}, and its exact outcome could not be verified; metadata was retained at {} and the candidate payload is {}",
                        original_path.display(),
                        directories.root_path.join("info").join(info_name).display(),
                        directories.root_path.join("files").join(name).display()
                    )));
                }
            }
        }
        Err(last_error.expect("each prepared destination either commits or records its failure"))
    }
}

#[cfg(test)]
pub(crate) fn restore(
    request: &RestoreRequest,
    effects: &batch::DirectoryEffects,
) -> Result<(), AppError> {
    restore_receipt(request, effects).map(|_| ())
}

pub(crate) fn restore_receipt(
    request: &RestoreRequest,
    effects: &batch::DirectoryEffects,
) -> Result<TrashSuccess, AppError> {
    restore_inner(request, effects, || Ok(()))
}

#[cfg(test)]
pub(super) fn restore_with_before_publish(
    request: &RestoreRequest,
    effects: &batch::DirectoryEffects,
    before_publish: impl FnOnce() -> Result<(), AppError>,
) -> Result<(), AppError> {
    restore_inner(request, effects, before_publish).map(|_| ())
}

fn restore_inner(
    request: &RestoreRequest,
    effects: &batch::DirectoryEffects,
    before_publish: impl FnOnce() -> Result<(), AppError>,
) -> Result<TrashSuccess, AppError> {
    let TrashArtifact::Freedesktop {
        root,
        name,
        original_path,
        metadata_digest,
        metadata_identity,
        payload_version,
    } = request.artifact.as_ref()
    else {
        return Err(AppError::InvalidPath(
            "Restore receipt is not a Freedesktop trash artifact".into(),
        ));
    };
    let requested_path = resolved_restore_path(Path::new(&request.path))?;
    if requested_path != *original_path || !is_name(name) {
        return Err(AppError::InvalidPath(
            "Restore request does not match its trash receipt".into(),
        ));
    }

    let root_directory = Directory::open(root)?;
    validate_private(&root_directory)?;
    let info = root_directory.open_existing(OsStr::new("info"))?;
    let files = root_directory.open_existing(OsStr::new("files"))?;
    validate_private(&info)?;
    validate_private(&files)?;

    let mut info_name = name.clone();
    info_name.push(OsStr::from_bytes(INFO_SUFFIX));
    let mut metadata = info.open_file(&info_name)?;
    let metadata_stat = metadata.metadata()?;
    if !metadata_stat.is_file() || identity(&metadata_stat) != *metadata_identity {
        return Err(AppError::Other(
            "Trash metadata identity changed; refusing to restore an unverified item".into(),
        ));
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut metadata)
        .take(MAX_INFO_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_INFO_BYTES
        || <[u8; 32]>::from(Sha256::digest(&bytes)) != *metadata_digest
    {
        return Err(AppError::Other(
            "Trash metadata changed; refusing to restore an unverified item".into(),
        ));
    }
    if version_at(&files, name)? != *payload_version {
        return Err(AppError::Other(
            "Trash payload identity changed; refusing to restore an unverified item".into(),
        ));
    }

    let parent = original_path
        .parent()
        .ok_or_else(|| AppError::InvalidPath(request.path.clone()))?;
    let target_name = original_path
        .file_name()
        .ok_or_else(|| AppError::InvalidPath(request.path.clone()))?;
    super::restore_parents::create(parent, effects)?;
    let target_parent = Directory::open(parent)?;
    let parent_identity = super::file_identity::of_file(&target_parent.file)?;
    let physical_target = target_parent.path()?.join(target_name);
    before_publish()?;
    rename_noreplace_at(&files, name, &target_parent, target_name)?;

    let restored_version = version_at(&target_parent, target_name).map_err(|error| {
        AppError::MutationUncertain(format!(
            "The payload was restored, but its identity could not be read: {error}"
        ))
    })?;
    if restored_version != *payload_version {
        return Err(AppError::MutationUncertain(
            "Restored payload identity could not be verified".into(),
        ));
    }
    if let Err(error) = unlink(&info, &info_name) {
        log::warn!(
            "Restored {} but could not remove trash metadata: {error}",
            original_path.display()
        );
    }
    if let Err(error) = target_parent
        .sync()
        .and_then(|_| files.sync())
        .and_then(|_| info.sync())
    {
        log::warn!(
            "Restored {} but could not synchronize directory metadata: {error}",
            original_path.display()
        );
    }
    Ok(TrashSuccess {
        artifact: None,
        publication: Some(Arc::new(super::mutation::PublishedEntry {
            path: physical_target,
            parent: parent_identity,
            version: restored_version,
        })),
        warning: None,
    })
}

enum TrashLayout {
    Home,
    Mounted(Mount),
}

struct TrashDirectories {
    root_path: PathBuf,
    info: Directory,
    files: Directory,
}

#[cfg(test)]
fn open_mounted_trash(mount: &Mount) -> Result<TrashDirectories, AppError> {
    plan::open_mounted(mount)
}

fn source_path(path: &Path) -> Result<(PathBuf, OsString, PathBuf), AppError> {
    if !path.is_absolute() {
        return Err(AppError::InvalidPath("Trash path must be absolute".into()));
    }
    let name = path
        .file_name()
        .ok_or_else(|| AppError::InvalidPath("Cannot trash a filesystem root".into()))?
        .to_owned();
    let parent = std::fs::canonicalize(
        path.parent()
            .ok_or_else(|| AppError::InvalidPath(path.display().to_string()))?,
    )?;
    let original = parent.join(&name);
    std::fs::symlink_metadata(&original)?;
    Ok((parent, name, original))
}

fn resolved_restore_path(path: &Path) -> Result<PathBuf, AppError> {
    if !path.is_absolute() {
        return Err(AppError::InvalidPath(
            "Restore path must be absolute".into(),
        ));
    }
    let name = path
        .file_name()
        .ok_or_else(|| AppError::InvalidPath("Cannot restore a filesystem root".into()))?;
    let parent = path
        .parent()
        .ok_or_else(|| AppError::InvalidPath(path.display().to_string()))?;
    let existing = parent
        .ancestors()
        .find(|ancestor| std::fs::symlink_metadata(ancestor).is_ok())
        .ok_or_else(|| AppError::NotFound(path.display().to_string()))?;
    let mut resolved = std::fs::canonicalize(existing)?;
    let missing = parent
        .strip_prefix(existing)
        .map_err(|_| AppError::InvalidPath(path.display().to_string()))?;
    for component in missing.components() {
        match component {
            Component::Normal(name) => resolved.push(name),
            _ => return Err(AppError::InvalidPath(path.display().to_string())),
        }
    }
    resolved.push(name);
    Ok(resolved)
}

fn metadata_path(layout: &TrashLayout, original: &Path) -> Result<PathBuf, AppError> {
    match layout {
        TrashLayout::Home => Ok(original.to_owned()),
        TrashLayout::Mounted(mount) => original
            .strip_prefix(&mount.mount_point)
            .map(Path::to_owned)
            .map_err(|_| {
                AppError::InvalidPath(format!(
                    "{} is outside its captured mount {}",
                    original.display(),
                    mount.mount_point.display()
                ))
            }),
    }
}

fn trash_info(original: &Path) -> Vec<u8> {
    let encoded = percent_encode(original.as_os_str().as_bytes());
    format!(
        "[Trash Info]\nPath={encoded}\nDeletionDate={}\n",
        chrono::Local::now().format("%Y-%m-%dT%H:%M:%S")
    )
    .into_bytes()
}

fn percent_encode(bytes: &[u8]) -> String {
    let mut encoded = String::with_capacity(bytes.len());
    for byte in bytes {
        if byte.is_ascii_alphanumeric() || matches!(*byte, b'/' | b'-' | b'_' | b'.' | b'~') {
            encoded.push(char::from(*byte));
        } else {
            use std::fmt::Write as _;
            let _ = write!(encoded, "%{byte:02X}");
        }
    }
    encoded
}

fn candidate_name(
    source: &OsStr,
    files_limit: usize,
    info_limit: usize,
    random: &mut impl FnMut(&mut [u8]) -> io::Result<()>,
) -> Result<OsString, AppError> {
    let limit = files_limit.min(info_limit);
    let mut entropy = [0u8; 16];
    random(&mut entropy)?;
    let suffix = format!(".tauri-{}", hex::encode(entropy));
    if limit < suffix.len() {
        return Err(AppError::Other(
            "Trash filesystem filename limit is too small".into(),
        ));
    }
    let prefix = &source.as_bytes()[..source.as_bytes().len().min(limit - suffix.len())];
    let mut name = prefix.to_vec();
    name.extend_from_slice(suffix.as_bytes());
    Ok(OsString::from_vec(name))
}

fn reserve_info(
    info: &Directory,
    final_name: &OsStr,
    temporary: &OsStr,
    contents: &[u8],
) -> Result<Option<(EntryIdentity, File)>, AppError> {
    let mut file = match info.create_file(temporary) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let result = file.write_all(contents).and_then(|_| file.sync_all());
    if let Err(error) = result {
        return Err(metadata_failure(error, cleanup_info(info, temporary)));
    }
    match rename_noreplace_at(info, temporary, info, final_name) {
        Ok(()) => {
            let metadata = file.metadata().map_err(|error| {
                AppError::MutationUncertain(format!(
                    "Trash metadata was published but its identity could not be read: {error}"
                ))
            })?;
            Ok(Some((identity(&metadata), file)))
        }
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            cleanup_info(info, temporary).map_err(|cleanup| {
                AppError::MutationUncertain(format!(
                    "Trash metadata name was occupied and staging cleanup failed: {cleanup}"
                ))
            })?;
            Ok(None)
        }
        Err(error) => Err(metadata_failure(error, cleanup_info(info, temporary))),
    }
}

fn metadata_failure(error: io::Error, cleanup: io::Result<()>) -> AppError {
    match cleanup {
        Ok(()) => error.into(),
        Err(cleanup) => AppError::MutationUncertain(format!(
            "Trash metadata preparation failed: {error}; staging cleanup also failed: {cleanup}"
        )),
    }
}

fn random_bytes(bytes: &mut [u8]) -> io::Result<()> {
    File::open("/dev/urandom")?.read_exact(bytes)
}

fn validate_shared_trash(directory: &Directory) -> Result<(), AppError> {
    let metadata = directory.metadata()?;
    let mode = metadata.mode();
    if !metadata.is_dir() || mode & libc::S_ISVTX == 0 {
        return Err(AppError::PermissionDenied(
            "Mounted .Trash directory is not a sticky real directory".into(),
        ));
    }
    Ok(())
}

fn private_permissions(metadata: &Metadata) -> Result<Option<u32>, AppError> {
    let uid = unsafe { libc::geteuid() };
    if !metadata.is_dir() || metadata.uid() != uid || metadata.mode() & 0o022 != 0 {
        return Err(AppError::PermissionDenied(
            "Trash directory is not a private directory owned by the current user".into(),
        ));
    }
    Ok((metadata.mode() & 0o077 != 0).then_some(metadata.mode() & 0o700))
}

fn ensure_private(directory: &Directory) -> Result<(), AppError> {
    // Repair owner-controlled legacy layouts without granting new owner access.
    if let Some(owner_permissions) = private_permissions(&directory.metadata()?)? {
        directory
            .file
            .set_permissions(std::fs::Permissions::from_mode(owner_permissions))?;
        directory.sync()?;
    }
    validate_private(directory)
}

fn validate_private(directory: &Directory) -> Result<(), AppError> {
    let metadata = directory.metadata()?;
    let uid = unsafe { libc::geteuid() };
    if !metadata.is_dir() || metadata.uid() != uid || metadata.mode() & 0o077 != 0 {
        return Err(AppError::PermissionDenied(
            "Trash directory is not a private directory owned by the current user".into(),
        ));
    }
    Ok(())
}

fn identity(metadata: &Metadata) -> EntryIdentity {
    EntryIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
        ctime_seconds: metadata.ctime(),
        ctime_nanoseconds: metadata.ctime_nsec(),
    }
}

fn probe_version_at(directory: &Directory, name: &OsStr) -> io::Result<Option<EntryVersion>> {
    match version_at(directory, name) {
        Ok(identity) => Ok(Some(identity)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn rename_noreplace_at(
    source_directory: &Directory,
    source: &OsStr,
    target_directory: &Directory,
    target: &OsStr,
) -> io::Result<()> {
    source_directory.rename_to(source, target_directory, target)
}

fn unlink(directory: &Directory, name: &OsStr) -> io::Result<()> {
    directory.unlink(name, false)
}

fn cleanup_info(directory: &Directory, name: &OsStr) -> io::Result<()> {
    unlink(directory, name)?;
    directory.sync()
}

#[cfg(test)]
#[path = "../../test_support/freedesktop_trash.rs"]
mod tests;
