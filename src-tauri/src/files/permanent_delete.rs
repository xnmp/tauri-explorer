//! Permanent deletion binds its effect to the object that was selected.
//!
//! On Unix a selected entry is first captured by an atomic no-replace rename
//! into a fresh private sibling directory, through a retained handle to the
//! verified physical parent. Its identity is checked after that move and
//! before any irreversible removal: a replaced leaf or ancestor is restored
//! (or retained and reported), never deleted. The guarantee covers
//! substitution of the requested namespace by other processes; it does not
//! defend the private staging directory against a hostile same-user process,
//! nor prove the provenance of every descendant discovered while removing.
//!
//! Windows keeps its path-based removal and makes no identity claim; a
//! handle-disposition adapter is separate work.
use crate::{error::AppError, files::trash_artifact::TrashSuccess};
use std::path::Path;

#[cfg(target_os = "linux")]
pub(crate) use unix::prepare_selection;

/// Delete one entry now. The returned warning reports completed deletion with
/// leftover empty staging, which must not become an uncertain failure.
pub(crate) fn delete(path: &Path) -> Result<TrashSuccess, AppError> {
    #[cfg(unix)]
    {
        unix::delete_native(path)
    }
    #[cfg(not(unix))]
    {
        let is_dir = std::fs::symlink_metadata(path)?.is_dir();
        super::file_ops::remove_entry_at(path)
            .map_err(|error| AppError::MutationUncertain(error.to_string()))?;
        log::info!("Permanently deleted entry (is_dir={is_dir})");
        Ok(TrashSuccess::default())
    }
}

/// Native namespace effects, injectable so tests can substitute entries at the
/// exact seam between the last check and the atomic capture.
#[cfg(unix)]
pub(super) trait Operations {
    fn rename(
        &mut self,
        source: &super::native_directory::Directory,
        name: &std::ffi::OsStr,
        target: &super::native_directory::Directory,
        target_name: &std::ffi::OsStr,
    ) -> std::io::Result<()> {
        source.rename_to(name, target, target_name)
    }

    fn make_directory(
        &mut self,
        parent: &super::native_directory::Directory,
        name: &std::ffi::OsStr,
    ) -> std::io::Result<()> {
        parent.make_directory(name)
    }

    fn unlink(
        &mut self,
        directory: &super::native_directory::Directory,
        name: &std::ffi::OsStr,
        is_directory: bool,
    ) -> std::io::Result<()> {
        directory.unlink(name, is_directory)
    }
}

#[cfg(unix)]
struct Native;

#[cfg(unix)]
impl Operations for Native {}

#[cfg(unix)]
#[path = "permanent_delete/tree.rs"]
mod tree;

// Selections are admitted on Linux only; other Unix platforms delete one path.
#[cfg(unix)]
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
mod unix {
    use super::{tree, Native, Operations};
    use crate::{
        error::AppError,
        files::{
            entry_version::EntryVersion,
            file_identity::{of_file, version_at, version_from_metadata},
            native_directory::Directory,
            object_id::ObjectId,
            recovery::resources::{self, Access, Scope, SelectionIndex, SelectionRole},
            trash_artifact::TrashSuccess,
        },
    };
    use std::{
        collections::{HashSet, VecDeque},
        ffi::{OsStr, OsString},
        fs, io,
        os::unix::fs::MetadataExt,
        path::{Path, PathBuf},
        sync::Arc,
    };

    const PAYLOAD: &str = "payload";
    const CONTAINER_PREFIX: &str = ".tauri-delete-";

    pub(crate) struct PreparedSelection {
        paths: Arc<Vec<String>>,
        next: usize,
        items: VecDeque<Result<Item, String>>,
        resources: Vec<resources::Resource>,
    }

    /// One observed physical entry and its planned private staging sibling.
    pub(super) struct Item {
        parent: PathBuf,
        parent_object: ObjectId,
        name: OsString,
        version: EntryVersion,
        /// Linux birth time: unlike mtime it cannot be forged with `utimensat`,
        /// so a reused inode with replicated metadata still mismatches.
        birth: Option<Birth>,
        container: OsString,
    }

    type Birth = (i64, u32);

    /// Birth time of `name` relative to `directory` (or an absolute path with
    /// `AT_FDCWD`), without following a final symlink. `None` when the
    /// filesystem or kernel does not report it.
    #[cfg(target_os = "linux")]
    fn birth_time(directory: libc::c_int, name: &std::ffi::CStr) -> io::Result<Option<Birth>> {
        let mut stat = std::mem::MaybeUninit::<libc::statx>::zeroed();
        // SAFETY: the descriptor (or AT_FDCWD) and terminated name are valid,
        // and stat is writable storage for the kernel to fill.
        let result = unsafe {
            libc::statx(
                directory,
                name.as_ptr(),
                libc::AT_SYMLINK_NOFOLLOW,
                libc::STATX_BTIME,
                stat.as_mut_ptr(),
            )
        };
        if result != 0 {
            let error = io::Error::last_os_error();
            return match error.raw_os_error() {
                Some(libc::ENOSYS) => Ok(None),
                _ => Err(error),
            };
        }
        // SAFETY: successful statx initialized stat.
        let stat = unsafe { stat.assume_init() };
        Ok((stat.stx_mask & libc::STATX_BTIME != 0)
            .then_some((stat.stx_btime.tv_sec, stat.stx_btime.tv_nsec)))
    }

    #[cfg(target_os = "linux")]
    fn birth_of_path(path: &Path) -> io::Result<Option<Birth>> {
        use std::os::unix::ffi::OsStrExt;
        let path = std::ffi::CString::new(path.as_os_str().as_bytes())
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "Path contains a NUL byte"))?;
        birth_time(libc::AT_FDCWD, &path)
    }

    #[cfg(all(test, target_os = "linux"))]
    pub(super) fn birth_of_path_for_test(path: &Path) -> io::Result<Option<Birth>> {
        birth_of_path(path)
    }

    #[cfg(target_os = "linux")]
    fn birth_at(directory: &Directory, name: &OsStr) -> io::Result<Option<Birth>> {
        use std::os::fd::AsRawFd;
        birth_time(
            directory.file.as_raw_fd(),
            &crate::files::native_directory::native_name(name)?,
        )
    }

    #[cfg(not(target_os = "linux"))]
    fn birth_of_path(_: &Path) -> io::Result<Option<Birth>> {
        Ok(None)
    }

    #[cfg(not(target_os = "linux"))]
    fn birth_at(_: &Directory, _: &OsStr) -> io::Result<Option<Birth>> {
        Ok(None)
    }

    fn random(bytes: &mut [u8]) -> io::Result<()> {
        getrandom::fill(bytes).map_err(io::Error::other)
    }

    pub(crate) fn prepare_selection(
        paths: Arc<Vec<String>>,
    ) -> Result<PreparedSelection, AppError> {
        prepare_with(paths, &mut random)
    }

    /// A native path keeps non-Unicode names exact; there is no receipt key.
    pub(super) fn delete_native(path: &Path) -> Result<TrashSuccess, AppError> {
        let (mut items, _) = prepare_items(std::iter::once(path), &mut random)?;
        items
            .pop_front()
            .expect("one prepared item per path")
            .map_err(AppError::Other)?
            .execute(&mut Native)
    }

    /// Observe the whole selection before any effect. Physical duplicates,
    /// ancestor overlap and alias conflicts are rejected by the shared index;
    /// hardlinked leaves stay distinct namespace entries.
    pub(super) fn prepare_with(
        paths: Arc<Vec<String>>,
        random: &mut impl FnMut(&mut [u8]) -> io::Result<()>,
    ) -> Result<PreparedSelection, AppError> {
        let (items, resources) = prepare_items(paths.iter().map(Path::new), random)?;
        Ok(PreparedSelection {
            paths,
            next: 0,
            items,
            resources,
        })
    }

    type Prepared = (VecDeque<Result<Item, String>>, Vec<resources::Resource>);

    fn prepare_items<'a>(
        paths: impl ExactSizeIterator<Item = &'a Path>,
        random: &mut impl FnMut(&mut [u8]) -> io::Result<()>,
    ) -> Result<Prepared, AppError> {
        let mut index = SelectionIndex::default();
        let mut claims = HashSet::new();
        let mut insert = |resource: resources::Resource, role| -> io::Result<()> {
            index.insert(&resource, role)?;
            claims.insert(resource);
            Ok(())
        };
        let mut items = VecDeque::with_capacity(paths.len());
        for path in paths {
            let mut captured = resources::capture_requests(&[resources::Request {
                path: path.to_owned(),
                access: Access::Write,
                scope: Scope::Subtree,
            }])?
            .into_iter();
            let source = captured
                .next()
                .expect("capture retains the primary request first");
            let version = match fs::symlink_metadata(&source.path.0) {
                Ok(metadata) => Some(version_from_metadata(&metadata)?),
                Err(error) if error.kind() == io::ErrorKind::NotFound => None,
                Err(error) => return Err(error.into()),
            };
            if source.object != version.as_ref().map(|version| version.object) {
                return Err(AppError::Other(
                    "Deletion source changed during namespace capture".into(),
                ));
            }
            let physical = source.path.0.clone();
            let birth = match version {
                Some(_) => birth_of_path(&physical)?,
                None => None,
            };
            let parent_object = *source
                .ancestors
                .first()
                .expect("validated source has a parent identity");
            insert(
                source,
                SelectionRole::Source {
                    directory: version.as_ref().is_some_and(|version| version.directory),
                },
            )?;
            for dependency in captured {
                insert(dependency, SelectionRole::Shared)?;
            }
            let Some(version) = version else {
                items.push_back(Err(
                    AppError::NotFound(path.display().to_string()).to_string()
                ));
                continue;
            };
            let (Some(parent), Some(name)) = (physical.parent(), physical.file_name()) else {
                return Err(AppError::InvalidPath(path.display().to_string()));
            };
            let mut nonce = [0u8; 16];
            random(&mut nonce)?;
            let container: OsString = format!(
                "{CONTAINER_PREFIX}{}",
                nonce
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect::<String>()
            )
            .into();
            insert(
                resources::capture(&parent.join(&container), Access::Write, Scope::Subtree)?,
                SelectionRole::Exclusive,
            )?;
            items.push_back(Ok(Item {
                parent: parent.to_owned(),
                parent_object,
                name: name.to_owned(),
                version,
                birth,
                container,
            }));
        }
        Ok((items, claims.into_iter().collect()))
    }

    impl PreparedSelection {
        /// Plan and claims come from one observation; callers must not rebind
        /// paths while retaining these prepared effects.
        pub(crate) fn into_admission(mut self) -> (Self, Vec<resources::Resource>) {
            let resources = std::mem::take(&mut self.resources);
            (self, resources)
        }

        pub(crate) fn execute_next(&mut self, requested: &str) -> Result<TrashSuccess, AppError> {
            self.execute_next_with(requested, &mut Native)
        }

        pub(super) fn execute_next_with(
            &mut self,
            requested: &str,
            operations: &mut impl Operations,
        ) -> Result<TrashSuccess, AppError> {
            if self.paths.get(self.next).map(String::as_str) != Some(requested) {
                return Err(AppError::WorkerFailed(
                    "Deletion does not match its prepared selection".into(),
                ));
            }
            let item = self.items.pop_front().ok_or_else(|| {
                AppError::WorkerFailed("Deletion exceeded its prepared selection".into())
            })?;
            self.next += 1;
            item.map_err(AppError::Other)?.execute(operations)
        }
    }

    #[cfg(target_os = "linux")]
    fn open_parent(path: &Path) -> io::Result<Directory> {
        Directory::open_searchable(path)
    }

    #[cfg(not(target_os = "linux"))]
    fn open_parent(path: &Path) -> io::Result<Directory> {
        Directory::open(path)
    }

    /// Fresh staging must be an empty private directory owned by this user.
    fn verify_container(container: &Directory) -> io::Result<()> {
        let metadata = container.metadata()?;
        // SAFETY: geteuid has no preconditions.
        let uid = unsafe { libc::geteuid() };
        if !metadata.is_dir()
            || metadata.uid() != uid
            || metadata.mode() & 0o077 != 0
            || container.entries()?.next().is_some()
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "Deletion staging directory is not a fresh private directory",
            ));
        }
        Ok(())
    }

    impl Item {
        fn describe(&self) -> String {
            self.parent.join(&self.name).display().to_string()
        }

        fn residue(&self) -> String {
            self.parent.join(&self.container).display().to_string()
        }

        fn execute(self, operations: &mut impl Operations) -> Result<TrashSuccess, AppError> {
            let parent = open_parent(&self.parent)?;
            if of_file(&parent.file)? != self.parent_object {
                return Err(AppError::Other(format!(
                    "The folder containing {} changed after it was selected; nothing was deleted",
                    self.describe()
                )));
            }
            if version_at(&parent, &self.name)? != self.version {
                return Err(AppError::Other(format!(
                    "{} changed after it was selected; nothing was deleted",
                    self.describe()
                )));
            }
            match operations.make_directory(&parent, &self.container) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                    return Err(AppError::AlreadyExists(format!(
                        "Deletion staging name {} is occupied; nothing was deleted",
                        self.residue()
                    )));
                }
                // mkdirat failed: nothing was created.
                Err(error) => return Err(error.into()),
            }
            // Created but unverifiable staging is reported, never removed: its
            // name alone does not prove the directory is still ours.
            let unverified = |error: io::Error| {
                Err(AppError::MutationUncertain(format!(
                    "Could not delete {}: its staging folder {} was created but could not be verified: {error}; nothing was deleted",
                    self.describe(),
                    self.residue()
                )))
            };
            let container = match parent.open_existing(&self.container) {
                Ok(container) => container,
                Err(error) => return unverified(error),
            };
            let staged = match container.metadata() {
                Ok(metadata) => (metadata.dev(), metadata.ino()),
                Err(error) => return unverified(error),
            };
            if let Err(error) = verify_container(&container) {
                drop(container);
                return self.discard_container(&parent, Some(staged), operations, error.into());
            }
            let payload = OsStr::new(PAYLOAD);
            if let Err(error) = operations.rename(&parent, &self.name, &container, payload) {
                drop(container);
                return self.discard_container(&parent, Some(staged), operations, error.into());
            }
            // Captured: from here the selected name may hold a newcomer.
            let captured = version_at(&container, payload).and_then(|version| {
                let birth = match self.birth {
                    Some(_) => birth_at(&container, payload)?,
                    None => None,
                };
                Ok(version == self.version && birth == self.birth)
            });
            match captured {
                Ok(true) => {}
                Ok(false) => {
                    return self.restore(
                        &parent,
                        container,
                        staged,
                        operations,
                        false,
                        format!(
                            "{} was replaced before it could be deleted; nothing was deleted",
                            self.describe()
                        ),
                    );
                }
                Err(error) => {
                    return Err(AppError::MutationUncertain(format!(
                        "{} was moved to {} for deletion, but its identity could not be verified: {error}",
                        self.describe(),
                        self.residue()
                    )));
                }
            }
            if let Err(partial) =
                tree::remove(&container, payload, self.version.directory, operations)
            {
                return self.restore(
                    &parent,
                    container,
                    staged,
                    operations,
                    partial.removed,
                    format!("Could not delete {}: {}", self.describe(), partial.error),
                );
            }
            drop(container);
            log::info!(
                "Permanently deleted entry (is_dir={})",
                self.version.directory
            );
            let warning = self
                .remove_container(&parent, Some(staged), operations)
                .err()
                .map(|error| {
                    format!(
                        "Deleted, but its empty staging folder {} could not be removed: {error}",
                        self.residue()
                    )
                });
            Ok(TrashSuccess {
                warning,
                ..TrashSuccess::default()
            })
        }

        /// Remove staging that never held the payload; failure to do so is
        /// owned residue and cannot be reported as a clean no-effect failure.
        fn discard_container(
            &self,
            parent: &Directory,
            staged: Option<(u64, u64)>,
            operations: &mut impl Operations,
            error: AppError,
        ) -> Result<TrashSuccess, AppError> {
            match self.remove_container(parent, staged, operations) {
                Ok(()) => Err(error),
                Err(cleanup) => Err(AppError::MutationUncertain(format!(
                    "Could not delete {}: {error}; its empty staging folder {} remains: {cleanup}",
                    self.describe(),
                    self.residue()
                ))),
            }
        }

        /// Return a captured payload (or whatever remains of it) to its name
        /// with a no-replace rename. A clean outcome requires that nothing was
        /// unlinked and the staging directory was removed.
        fn restore(
            &self,
            parent: &Directory,
            container: Directory,
            staged: (u64, u64),
            operations: &mut impl Operations,
            removed: bool,
            failure: String,
        ) -> Result<TrashSuccess, AppError> {
            let payload = OsStr::new(PAYLOAD);
            let restored = match container.entry_exists(payload) {
                Ok(true) => operations.rename(&container, payload, parent, &self.name),
                Ok(false) => Ok(()),
                Err(error) => Err(error),
            };
            drop(container);
            if let Err(error) = restored {
                return Err(AppError::MutationUncertain(format!(
                    "{failure}; the captured item was kept at {} because it could not be returned to {}: {error}",
                    self.residue_payload(),
                    self.describe()
                )));
            }
            if let Err(cleanup) = self.remove_container(parent, Some(staged), operations) {
                return Err(AppError::MutationUncertain(format!(
                    "{failure}; the item was returned to {}, but its staging folder {} remains: {cleanup}",
                    self.describe(),
                    self.residue()
                )));
            }
            if removed {
                return Err(AppError::MutationUncertain(format!(
                    "{failure}; it was partially deleted and what remains is at {}",
                    self.describe()
                )));
            }
            Err(AppError::Other(failure))
        }

        /// Remove the staging name only while it still names the directory
        /// this deletion created; a renamed-and-replaced staging name is not ours.
        fn remove_container(
            &self,
            parent: &Directory,
            staged: Option<(u64, u64)>,
            operations: &mut impl Operations,
        ) -> io::Result<()> {
            if let Some(expected) = staged {
                let stat = parent.stat(&self.container)?;
                #[allow(clippy::unnecessary_cast)] // Darwin dev_t/ino_t differ from Linux.
                if (stat.st_dev as u64, stat.st_ino as u64) != expected {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "the staging name no longer refers to the staging folder",
                    ));
                }
            }
            operations.unlink(parent, &self.container, true)
        }

        fn residue_payload(&self) -> String {
            self.parent
                .join(&self.container)
                .join(PAYLOAD)
                .display()
                .to_string()
        }
    }
}

#[cfg(all(test, unix))]
#[path = "../../test_support/permanent_delete.rs"]
mod tests;
