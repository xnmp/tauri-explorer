//! Exact, interoperable Freedesktop trash receipts for Linux.

use super::{
    batch,
    trash_artifact::{EntryIdentity, RestoreRequest, TrashArtifact, TrashSuccess},
    trash_mounts::{Mount, MountSnapshot},
};
use crate::error::AppError;
use sha2::{Digest, Sha256};
use std::{
    ffi::{CString, OsStr, OsString},
    fs::{File, Metadata},
    io::{self, Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::{
            ffi::OsStrExt,
            ffi::OsStringExt,
            fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
        },
    },
    path::{Component, Path, PathBuf},
    sync::Arc,
};

const INFO_SUFFIX: &[u8] = b".trashinfo";
const MAX_INFO_BYTES: u64 = 1024 * 1024;

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

    pub(crate) fn trash(&mut self, path: &Path) -> Result<TrashSuccess, AppError> {
        self.trash_with_post_commit(path, |source, files, info| {
            source.sync()?;
            files.sync()?;
            info.sync()
        })
    }

    fn trash_with_post_commit(
        &mut self,
        path: &Path,
        post_commit: impl FnOnce(&Directory, &Directory, &Directory) -> io::Result<()>,
    ) -> Result<TrashSuccess, AppError> {
        let mut random = random_bytes;
        self.trash_with(path, &mut random, rename_noreplace_at, post_commit)
    }

    fn trash_with(
        &mut self,
        path: &Path,
        random: &mut impl FnMut(&mut [u8]) -> io::Result<()>,
        mut move_entry: impl FnMut(&Directory, &OsStr, &Directory, &OsStr) -> io::Result<()>,
        post_commit: impl FnOnce(&Directory, &Directory, &Directory) -> io::Result<()>,
    ) -> Result<TrashSuccess, AppError> {
        let (source_parent_path, source_name, original_path) = source_path(path)?;
        let source_parent = Directory::open(&source_parent_path)?;
        let source_identity = identity_at(&source_parent, &source_name)?;
        let source_mount = self.mounts.resolve(&original_path)?.clone();
        let home_mount = self.mounts.resolve_existing_ancestor(&self.data_home)?;
        let layout = if home_mount.id == source_mount.id {
            TrashLayout::Home
        } else {
            TrashLayout::Mounted(source_mount.clone())
        };
        let directories = self.open_trash(&layout)?;
        let metadata_path = metadata_path(&layout, &original_path)?;
        let metadata = trash_info(&metadata_path);
        let digest: [u8; 32] = Sha256::digest(&metadata).into();

        for _ in 0..128 {
            let name = candidate_name(
                &source_name,
                directories.files.name_max()?,
                directories
                    .info
                    .name_max()?
                    .saturating_sub(INFO_SUFFIX.len()),
                random,
            )?;
            let mut info_name = name.clone();
            info_name.push(OsStr::from_bytes(INFO_SUFFIX));
            let Some((metadata_identity, reserved)) =
                reserve_info(&directories.info, &info_name, &metadata, random)?
            else {
                continue;
            };

            if let Err(error) = directories.info.sync() {
                return Err(match cleanup_info(&directories.info, &info_name) {
                    Ok(()) => error.into(),
                    Err(cleanup) => AppError::Other(format!(
                        "Trash metadata could not be synchronized: {error}; cleanup also failed: {cleanup}"
                    )),
                });
            }
            match move_entry(&source_parent, &source_name, &directories.files, &name) {
                Ok(()) => {
                    drop(reserved);
                    let (artifact, identity_warning) = match identity_at(&directories.files, &name) {
                        Ok(payload_identity) if same_object(&payload_identity, &source_identity) => (
                            Some(Arc::new(TrashArtifact::Freedesktop {
                                root: directories.root_path.clone(),
                                name,
                                original_path: original_path.clone(),
                                metadata_digest: digest,
                                metadata_identity,
                                payload_identity,
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
                    return Ok(TrashSuccess { artifact, warning });
                }
                Err(error) => {
                    drop(reserved);
                    let source_after = probe_identity_at(&source_parent, &source_name);
                    let payload_after = probe_identity_at(&directories.files, &name);
                    let source_unchanged = source_after
                        .as_ref()
                        .is_ok_and(|value| value.as_ref() == Some(&source_identity));
                    let payload_is_source = payload_after.as_ref().is_ok_and(|value| {
                        value
                            .as_ref()
                            .is_some_and(|value| same_object(value, &source_identity))
                    });
                    if source_unchanged {
                        let cleanup = cleanup_info(&directories.info, &info_name);
                        if error.kind() == io::ErrorKind::AlreadyExists && cleanup.is_ok() {
                            continue;
                        }
                        return Err(match cleanup {
                            Ok(()) => error.into(),
                            Err(cleanup) => AppError::Other(format!(
                                "Could not move {} to trash: {error}; incomplete metadata remains at {}: {cleanup}",
                                original_path.display(),
                                directories.root_path.join("info").join(info_name).display()
                            )),
                        });
                    }
                    if let (Ok(None), Ok(Some(payload_identity))) = (&source_after, &payload_after)
                    {
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
                            payload_identity: payload_identity.clone(),
                        });
                        let sync_warning =
                            post_commit(&source_parent, &directories.files, &directories.info)
                                .err()
                                .map(|sync| {
                                    format!("; directory synchronization also failed: {sync}")
                                })
                                .unwrap_or_default();
                        return Ok(TrashSuccess {
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
        Err(AppError::AlreadyExists(
            "Could not allocate a unique Freedesktop trash name".into(),
        ))
    }

    fn open_trash(&self, layout: &TrashLayout) -> Result<TrashDirectories, AppError> {
        match layout {
            TrashLayout::Home => {
                let data = open_or_create_path(&self.data_home)?;
                let root = data.open_or_create_private(OsStr::new("Trash"))?;
                TrashDirectories::open(root)
            }
            TrashLayout::Mounted(mount) => open_mounted_trash(mount),
        }
    }
}

pub(crate) fn restore(
    request: &RestoreRequest,
    effects: &batch::DirectoryEffects,
) -> Result<(), AppError> {
    restore_inner(request, effects, || Ok(()))
}

#[cfg(test)]
pub(super) fn restore_with_before_publish(
    request: &RestoreRequest,
    effects: &batch::DirectoryEffects,
    before_publish: impl FnOnce() -> Result<(), AppError>,
) -> Result<(), AppError> {
    restore_inner(request, effects, before_publish)
}

fn restore_inner(
    request: &RestoreRequest,
    effects: &batch::DirectoryEffects,
    before_publish: impl FnOnce() -> Result<(), AppError>,
) -> Result<(), AppError> {
    let TrashArtifact::Freedesktop {
        root,
        name,
        original_path,
        metadata_digest,
        metadata_identity,
        payload_identity,
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
    if identity_at(&files, name)? != *payload_identity {
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
    before_publish()?;
    rename_noreplace_at(&files, name, &target_parent, target_name)?;

    let restored_identity = identity_at(&target_parent, target_name).map_err(|error| {
        AppError::MutationUncertain(format!(
            "The payload was restored, but its identity could not be read: {error}"
        ))
    })?;
    if !same_object(&restored_identity, payload_identity) {
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
    Ok(())
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

impl TrashDirectories {
    fn open(root: Directory) -> Result<Self, AppError> {
        ensure_private(&root)?;
        let root_path = root.path()?;
        let info = root.open_or_create_private(OsStr::new("info"))?;
        let files = root.open_or_create_private(OsStr::new("files"))?;
        root.sync()?;
        Ok(Self {
            root_path,
            info,
            files,
        })
    }
}

fn open_mounted_trash(mount: &Mount) -> Result<TrashDirectories, AppError> {
    if !mount.root.is_absolute()
        || !mount.mount_point.is_absolute()
        || mount.filesystem.as_bytes().is_empty()
    {
        return Err(AppError::InvalidPath(
            "Captured Linux mount record is incomplete".into(),
        ));
    }
    let top = Directory::open(&mount.mount_point)?;
    let uid = unsafe { libc::geteuid() };
    let shared = top.open_existing(OsStr::new(".Trash"));
    if let Ok(shared) = shared {
        if validate_shared_trash(&shared).is_ok() {
            let name = OsString::from(uid.to_string());
            if let Ok(root) = shared.open_or_create_private(&name) {
                return TrashDirectories::open(root);
            }
        }
    }
    let name = OsString::from(format!(".Trash-{uid}"));
    let root = top.open_or_create_private(&name)?;
    TrashDirectories::open(root)
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
    contents: &[u8],
    random: &mut impl FnMut(&mut [u8]) -> io::Result<()>,
) -> Result<Option<(EntryIdentity, File)>, AppError> {
    let mut entropy = [0u8; 16];
    random(&mut entropy)?;
    let temporary = OsString::from(format!(".tauri-{}.tmp", hex::encode(entropy)));
    let mut file = match info.create_file(&temporary) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let result = file.write_all(contents).and_then(|_| file.sync_all());
    if let Err(error) = result {
        let _ = unlink(info, &temporary);
        return Err(error.into());
    }
    match rename_noreplace_at(info, &temporary, info, final_name) {
        Ok(()) => Ok(Some((identity(&file.metadata()?), file))),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            let _ = unlink(info, &temporary);
            Ok(None)
        }
        Err(error) => {
            let _ = unlink(info, &temporary);
            Err(error.into())
        }
    }
}

fn random_bytes(bytes: &mut [u8]) -> io::Result<()> {
    File::open("/dev/urandom")?.read_exact(bytes)
}

struct Directory {
    file: File,
}

impl Directory {
    fn open(path: &Path) -> io::Result<Self> {
        if !path.is_absolute() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Directory path must be absolute",
            ));
        }
        let file = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW)
            .open(Path::new("/"))?;
        let mut directory = Self { file };
        for component in path.components() {
            match component {
                Component::RootDir => {}
                Component::Normal(name) => directory = directory.open_existing(name)?,
                _ => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "Directory path is not normalized",
                    ));
                }
            }
        }
        Ok(directory)
    }

    fn open_existing(&self, name: &OsStr) -> io::Result<Self> {
        let name = native_name(name)?;
        // SAFETY: name is terminated and the returned descriptor is uniquely owned.
        let descriptor = unsafe {
            libc::openat(
                self.file.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            )
        };
        if descriptor < 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(Self {
                file: unsafe { File::from_raw_fd(descriptor) },
            })
        }
    }

    fn open_or_create_private(&self, name: &OsStr) -> Result<Self, AppError> {
        let native = native_name(name)?;
        // SAFETY: parent descriptor and component C string remain valid.
        let result = unsafe { libc::mkdirat(self.file.as_raw_fd(), native.as_ptr(), 0o700) };
        if result != 0 {
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::AlreadyExists {
                return Err(error.into());
            }
        } else {
            self.sync()?;
        }
        let child = self.open_existing(name)?;
        ensure_private(&child)?;
        Ok(child)
    }

    fn create_file(&self, name: &OsStr) -> io::Result<File> {
        let name = native_name(name)?;
        // SAFETY: name is terminated and the returned descriptor is uniquely owned.
        let descriptor = unsafe {
            libc::openat(
                self.file.as_raw_fd(),
                name.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_CLOEXEC | libc::O_NOFOLLOW,
                0o600,
            )
        };
        if descriptor < 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(unsafe { File::from_raw_fd(descriptor) })
        }
    }

    fn open_file(&self, name: &OsStr) -> io::Result<File> {
        let name = native_name(name)?;
        // SAFETY: name is terminated and the returned descriptor is uniquely owned.
        let descriptor = unsafe {
            libc::openat(
                self.file.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK,
            )
        };
        if descriptor < 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(unsafe { File::from_raw_fd(descriptor) })
        }
    }

    fn metadata(&self) -> io::Result<Metadata> {
        self.file.metadata()
    }

    fn sync(&self) -> io::Result<()> {
        self.file.sync_all()
    }

    fn path(&self) -> io::Result<PathBuf> {
        std::fs::read_link(format!("/proc/self/fd/{}", self.file.as_raw_fd()))
    }

    fn name_max(&self) -> io::Result<usize> {
        // SAFETY: fpathconf only reads the valid descriptor.
        let value = unsafe { libc::fpathconf(self.file.as_raw_fd(), libc::_PC_NAME_MAX) };
        if value < 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(value as usize)
        }
    }
}

fn open_or_create_path(path: &Path) -> Result<Directory, AppError> {
    let existing = path
        .ancestors()
        .find(|ancestor| std::fs::symlink_metadata(ancestor).is_ok())
        .ok_or_else(|| AppError::NotFound(path.display().to_string()))?;
    let canonical = std::fs::canonicalize(existing)?;
    let mut directory = Directory::open(&canonical)?;
    let missing = path
        .strip_prefix(existing)
        .map_err(|_| AppError::InvalidPath(path.display().to_string()))?;
    let mut names = Vec::new();
    for component in missing.components() {
        match component {
            Component::Normal(name) => names.push(name.to_owned()),
            _ => {
                return Err(AppError::InvalidPath(format!(
                    "Trash directory path is not normalized: {}",
                    path.display()
                )));
            }
        }
    }
    for name in names {
        directory = directory.open_or_create_private(&name)?;
    }
    Ok(directory)
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

fn ensure_private(directory: &Directory) -> Result<(), AppError> {
    let metadata = directory.metadata()?;
    let uid = unsafe { libc::geteuid() };
    if !metadata.is_dir() || metadata.uid() != uid || metadata.mode() & 0o022 != 0 {
        return Err(AppError::PermissionDenied(
            "Trash directory is not a private directory owned by the current user".into(),
        ));
    }
    // trash 5.x created these directories with the process umask. Repair its
    // owner-controlled, non-writable-by-others legacy layouts through the validated
    // descriptor instead of rejecting trash previously created by this app.
    if metadata.mode() & 0o077 != 0 {
        let owner_permissions = metadata.mode() & 0o700;
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

fn same_object(left: &EntryIdentity, right: &EntryIdentity) -> bool {
    left.device == right.device && left.inode == right.inode
}

fn identity_at(directory: &Directory, name: &OsStr) -> io::Result<EntryIdentity> {
    let name = native_name(name)?;
    let mut stat = std::mem::MaybeUninit::<libc::stat>::zeroed();
    // SAFETY: name is terminated and stat points to writable memory.
    let result = unsafe {
        libc::fstatat(
            directory.file.as_raw_fd(),
            name.as_ptr(),
            stat.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    if result != 0 {
        return Err(io::Error::last_os_error());
    }
    let stat = unsafe { stat.assume_init() };
    Ok(EntryIdentity {
        device: stat.st_dev,
        inode: stat.st_ino,
        ctime_seconds: stat.st_ctime,
        ctime_nanoseconds: stat.st_ctime_nsec,
    })
}

fn probe_identity_at(directory: &Directory, name: &OsStr) -> io::Result<Option<EntryIdentity>> {
    match identity_at(directory, name) {
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
    let source = native_name(source)?;
    let target = native_name(target)?;
    // SAFETY: both directory descriptors and terminated component names live
    // for the duration of the call.
    let result = unsafe {
        libc::renameat2(
            source_directory.file.as_raw_fd(),
            source.as_ptr(),
            target_directory.file.as_raw_fd(),
            target.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

fn unlink(directory: &Directory, name: &OsStr) -> io::Result<()> {
    let name = native_name(name)?;
    // SAFETY: directory descriptor and terminated component name are valid.
    let result = unsafe { libc::unlinkat(directory.file.as_raw_fd(), name.as_ptr(), 0) };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

fn cleanup_info(directory: &Directory, name: &OsStr) -> io::Result<()> {
    unlink(directory, name)?;
    directory.sync()
}

fn native_name(name: &OsStr) -> io::Result<CString> {
    if !is_name(name) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Expected one filesystem name",
        ));
    }
    CString::new(name.as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "Name contains a NUL byte"))
}

fn is_name(name: &OsStr) -> bool {
    matches!(
        Path::new(name).components().collect::<Vec<_>>().as_slice(),
        [Component::Normal(_)]
    )
}

#[cfg(test)]
#[path = "../../test_support/freedesktop_trash.rs"]
mod tests;
