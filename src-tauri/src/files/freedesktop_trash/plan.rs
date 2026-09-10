//! Read-only preparation of exact trash namespaces. Execution consumes this
//! plan; it never allocates another candidate or discovers an unplanned root.
use super::{
    candidate_name, ensure_private, metadata_path, private_permissions, source_path, trash_info,
    validate_private, validate_shared_trash, version_at, Context, TrashDirectories, TrashLayout,
    INFO_SUFFIX, MAX_INFO_BYTES,
};
use crate::{
    error::AppError,
    files::{
        entry_version::EntryVersion,
        native_directory::Directory,
        object_id::ObjectId,
        recovery::resources::{Access, Scope, SelectionRole},
        trash_mounts::Mount,
    },
};
use sha2::{Digest, Sha256};
use std::{
    ffi::{OsStr, OsString},
    io,
    os::{
        fd::AsRawFd,
        unix::{ffi::OsStrExt, fs::MetadataExt},
    },
    path::{Component, Path, PathBuf},
    sync::Arc,
};

const MAX_LAYOUT_DEPTH: usize = 256;

pub(super) struct Prepared {
    pub(super) original_path: PathBuf,
    pub(super) source_parent_path: PathBuf,
    pub(super) source_parent_identity: DirectoryIdentity,
    pub(super) source_name: OsString,
    pub(super) source_version: EntryVersion,
    pub(super) source_mount: u64,
    pub(super) layout: Arc<LayoutPlan>,
    pub(super) fallback: Option<Arc<LayoutPlan>>,
    pub(super) name: OsString,
    pub(super) info_name: OsString,
    pub(super) temporary_name: OsString,
    pub(super) metadata: Vec<u8>,
    pub(super) digest: [u8; 32],
}

#[derive(PartialEq, Eq, Hash)]
pub(super) struct LayoutPlan {
    anchor_path: PathBuf,
    anchor_identity: DirectoryIdentity,
    shared_anchor: bool,
    prefix: Vec<DirectoryStep>,
    root_path: PathBuf,
    info: DirectoryStep,
    files: DirectoryStep,
}

#[derive(PartialEq, Eq, Hash)]
struct DirectoryStep {
    name: OsString,
    action: DirectoryAction,
}

#[derive(PartialEq, Eq, Hash)]
enum DirectoryAction {
    Create,
    Open(DirectoryIdentity),
    Repair(DirectoryIdentity),
}

struct LayoutProbe {
    plan: LayoutPlan,
    info: Option<Directory>,
    files: Option<Directory>,
    info_limit: usize,
    files_limit: usize,
}

struct Destinations {
    primary: LayoutProbe,
    fallback: Option<LayoutProbe>,
}

impl Destinations {
    fn iter(&self) -> impl Iterator<Item = &LayoutProbe> {
        std::iter::once(&self.primary).chain(self.fallback.iter())
    }
}

#[derive(PartialEq, Eq, Hash)]
pub(super) struct DirectoryIdentity {
    device: u64,
    inode: u64,
    mount: Option<u64>,
}

impl DirectoryIdentity {
    fn capture(directory: &Directory) -> Result<Self, AppError> {
        let metadata = directory.metadata()?;
        if metadata.nlink() == 0 {
            return Err(AppError::Other("Trash directory was removed".into()));
        }
        Ok(Self {
            device: metadata.dev(),
            inode: metadata.ino(),
            mount: directory.mount_id()?,
        })
    }

    pub(super) fn object(&self) -> ObjectId {
        ObjectId::unix(self.device, self.inode)
    }
}

impl Context {
    pub(super) fn prepare(
        &self,
        path: &Path,
        random: &mut impl FnMut(&mut [u8]) -> io::Result<()>,
    ) -> Result<Prepared, AppError> {
        let (source_parent_path, source_name, original_path) = source_path(path)?;
        let source_parent = Directory::open(&source_parent_path)?;
        let source_parent_identity = DirectoryIdentity::capture(&source_parent)?;
        let source_version = version_at(&source_parent, &source_name)?;
        let source_mount = self.mounts.resolve(&original_path)?;
        let home_mount = self.mounts.resolve_existing_ancestor(&self.data_home)?;
        let (layout, probes) = if home_mount.id == source_mount.id {
            (
                TrashLayout::Home,
                Destinations {
                    primary: LayoutProbe::home(&self.data_home)?,
                    fallback: None,
                },
            )
        } else {
            (
                TrashLayout::Mounted(source_mount.clone()),
                LayoutProbe::mounted(source_mount)?,
            )
        };
        if probes.iter().any(|probe| {
            probe.plan.root_path.starts_with(&original_path)
                || original_path.starts_with(&probe.plan.root_path)
        }) {
            return Err(AppError::InvalidPath(
                "A trash source cannot contain or belong to its destination trash directory".into(),
            ));
        }
        let files_limit = probes
            .iter()
            .map(|probe| probe.files_limit)
            .min()
            .expect("primary destination");
        let info_limit = probes
            .iter()
            .map(|probe| probe.info_limit)
            .min()
            .expect("primary destination");
        let metadata = trash_info(&metadata_path(&layout, &original_path)?);
        if metadata.len() as u64 > MAX_INFO_BYTES {
            return Err(AppError::InvalidPath(
                "Trash metadata exceeds its size limit".into(),
            ));
        }
        let digest = Sha256::digest(&metadata).into();
        for _ in 0..128 {
            let name = candidate_name(
                &source_name,
                files_limit,
                info_limit.saturating_sub(INFO_SUFFIX.len()),
                random,
            )?;
            let mut info_name = name.clone();
            info_name.push(OsStr::from_bytes(INFO_SUFFIX));
            let mut entropy = [0u8; 16];
            random(&mut entropy)?;
            let temporary_name = OsString::from(format!(".tauri-{}.tmp", hex::encode(entropy)));
            if temporary_name.len() > info_limit {
                return Err(AppError::Other(
                    "Trash filesystem metadata filename limit is too small".into(),
                ));
            }
            let mut collision = false;
            for probe in probes.iter() {
                collision |= occupied(&probe.files, &name)?
                    || occupied(&probe.info, &info_name)?
                    || occupied(&probe.info, &temporary_name)?;
            }
            if collision {
                continue;
            }
            return Ok(Prepared {
                original_path,
                source_parent_path,
                source_parent_identity,
                source_name,
                source_version,
                source_mount: source_mount.id,
                layout: Arc::new(probes.primary.plan),
                fallback: probes.fallback.map(|probe| Arc::new(probe.plan)),
                name,
                info_name,
                temporary_name,
                metadata,
                digest,
            });
        }
        Err(AppError::AlreadyExists(
            "Could not allocate a unique Freedesktop trash name".into(),
        ))
    }
}

fn occupied(directory: &Option<Directory>, name: &OsStr) -> io::Result<bool> {
    directory
        .as_ref()
        .map_or(Ok(false), |directory| directory.entry_exists(name))
}

impl LayoutProbe {
    fn home(data_home: &Path) -> Result<Self, AppError> {
        if !data_home.is_absolute() || data_home.components().count() > MAX_LAYOUT_DEPTH {
            return Err(AppError::InvalidPath(
                "Trash data directory is not a bounded absolute path".into(),
            ));
        }
        let mut existing = data_home;
        loop {
            match std::fs::symlink_metadata(existing) {
                Ok(_) => break,
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    existing = existing
                        .parent()
                        .ok_or_else(|| AppError::NotFound(data_home.display().to_string()))?;
                }
                Err(error) => return Err(error.into()),
            }
        }
        let anchor_path = std::fs::canonicalize(existing)?;
        let anchor = Directory::open(&anchor_path)?;
        let mut names = Vec::new();
        for component in data_home
            .strip_prefix(existing)
            .map_err(|error| AppError::InvalidPath(error.to_string()))?
            .components()
        {
            match component {
                Component::Normal(name) => names.push(name.to_owned()),
                _ => {
                    return Err(AppError::InvalidPath(
                        "Trash data directory is not normalized".into(),
                    ))
                }
            }
        }
        names.push(OsString::from("Trash"));
        Self::from_anchor(anchor, anchor_path, false, names)
    }

    fn mounted(mount: &Mount) -> Result<Destinations, AppError> {
        if !mount.root.is_absolute()
            || !mount.mount_point.is_absolute()
            || mount.filesystem.is_empty()
        {
            return Err(AppError::InvalidPath(
                "Captured Linux mount record is incomplete".into(),
            ));
        }
        let top = Directory::open(&mount.mount_point)?;
        let uid = unsafe { libc::geteuid() };
        let mut primary = None;
        if let Ok(shared) = top.open_existing(OsStr::new(".Trash")) {
            if validate_shared_trash(&shared).is_ok() {
                let name = OsString::from(uid.to_string());
                // Both the preferred shared layout and any usable personal
                // fallback must be fully probed before candidate selection.
                let usable = match shared.open_existing(&name) {
                    Ok(root) => root
                        .metadata()
                        .is_ok_and(|metadata| private_permissions(&metadata).is_ok()),
                    Err(error) if error.kind() == io::ErrorKind::NotFound => can_create(&shared),
                    Err(_) => false,
                };
                if usable {
                    primary = Self::from_anchor(
                        shared,
                        mount.mount_point.join(".Trash"),
                        true,
                        vec![name],
                    )
                    .ok();
                }
            }
        }
        let personal = Self::from_anchor(
            top,
            mount.mount_point.clone(),
            false,
            vec![OsString::from(format!(".Trash-{uid}"))],
        );
        match primary {
            Some(primary) => Ok(Destinations {
                primary,
                fallback: personal.ok(),
            }),
            None => personal.map(|primary| Destinations {
                primary,
                fallback: None,
            }),
        }
    }

    fn from_anchor(
        anchor: Directory,
        anchor_path: PathBuf,
        shared_anchor: bool,
        names: Vec<OsString>,
    ) -> Result<Self, AppError> {
        if names.len() > MAX_LAYOUT_DEPTH {
            return Err(AppError::InvalidPath(
                "Trash directory hierarchy exceeds its depth limit".into(),
            ));
        }
        let anchor_identity = DirectoryIdentity::capture(&anchor)?;
        let mut limit = anchor.name_max()?;
        let mut current = Some(anchor);
        let mut root_path = anchor_path.clone();
        let mut prefix = Vec::with_capacity(names.len());
        for name in names {
            if name.len() > limit {
                return Err(AppError::InvalidPath(
                    "Trash directory component exceeds its filesystem name limit".into(),
                ));
            }
            let (step, child) = DirectoryStep::observe(current.as_ref(), &name)?;
            if let Some(child) = &child {
                limit = child.name_max()?;
            }
            root_path.push(&name);
            prefix.push(step);
            current = child;
        }
        if limit < "files".len() {
            return Err(AppError::InvalidPath(
                "Trash directory filename limit is too small".into(),
            ));
        }
        let (info_step, info) = DirectoryStep::observe(current.as_ref(), OsStr::new("info"))?;
        let (files_step, files) = DirectoryStep::observe(current.as_ref(), OsStr::new("files"))?;
        let info_limit = info.as_ref().map_or(Ok(limit), Directory::name_max)?;
        let files_limit = files.as_ref().map_or(Ok(limit), Directory::name_max)?;
        Ok(Self {
            plan: LayoutPlan {
                anchor_path,
                anchor_identity,
                shared_anchor,
                prefix,
                root_path,
                info: info_step,
                files: files_step,
            },
            info,
            files,
            info_limit,
            files_limit,
        })
    }
}

impl DirectoryStep {
    fn observe(
        parent: Option<&Directory>,
        name: &OsStr,
    ) -> Result<(Self, Option<Directory>), AppError> {
        let child = match parent.map(|parent| parent.open_existing(name)) {
            Some(Ok(child)) => Some(child),
            Some(Err(error)) if error.kind() == io::ErrorKind::NotFound => None,
            Some(Err(error)) => return Err(error.into()),
            None => None,
        };
        let action = match &child {
            Some(child) => {
                let metadata = child.metadata()?;
                let identity = DirectoryIdentity::capture(child)?;
                if private_permissions(&metadata)?.is_some() {
                    DirectoryAction::Repair(identity)
                } else {
                    DirectoryAction::Open(identity)
                }
            }
            None => DirectoryAction::Create,
        };
        Ok((
            Self {
                name: name.to_owned(),
                action,
            },
            child,
        ))
    }

    fn execute(&self, parent: &Directory) -> Result<Directory, AppError> {
        match self.action {
            DirectoryAction::Open(ref expected) | DirectoryAction::Repair(ref expected) => {
                let child = parent.open_existing(&self.name)?;
                verify_directory(&child, expected)?;
                if matches!(self.action, DirectoryAction::Repair(_)) {
                    ensure_private(&child)?;
                } else {
                    validate_private(&child)?;
                }
                Ok(child)
            }
            DirectoryAction::Create => {
                let child = match parent.create_directory(&self.name) {
                    Ok(child) => child,
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                        // Another first-use operation may have created this
                        // exact namespace after preparation. Adoption is read-
                        // only: never follow a link or repair unplanned modes.
                        let child = parent.open_existing(&self.name)?;
                        validate_private(&child)?;
                        parent.sync()?;
                        return Ok(child);
                    }
                    Err(error) => return Err(error.into()),
                };
                parent.sync()?;
                validate_private(&child)?;
                Ok(child)
            }
        }
    }
}

impl LayoutPlan {
    pub(super) fn execute(&self) -> Result<TrashDirectories, AppError> {
        let mut root = Directory::open(&self.anchor_path)?;
        verify_directory(&root, &self.anchor_identity)?;
        if self.shared_anchor {
            validate_shared_trash(&root)?;
        }
        for step in &self.prefix {
            root = step.execute(&root)?;
        }
        if root.path()? != self.root_path {
            return Err(AppError::Other(
                "Trash directory namespace changed during preparation".into(),
            ));
        }
        let info = self.info.execute(&root)?;
        let files = self.files.execute(&root)?;
        root.sync()?;
        Ok(TrashDirectories {
            root_path: self.root_path.clone(),
            info,
            files,
        })
    }
}

impl Prepared {
    pub(super) fn retained_bytes(&self) -> usize {
        std::mem::size_of::<Self>()
            + self.original_path.capacity()
            + self.source_parent_path.capacity()
            + self.source_name.capacity()
            + self.name.capacity()
            + self.info_name.capacity()
            + self.temporary_name.capacity()
            + self.metadata.capacity()
    }

    pub(super) fn visit_artifacts(
        &self,
        mut visit: impl FnMut(&Path, Scope) -> Result<(), AppError>,
    ) -> Result<(), AppError> {
        for layout in std::iter::once(&self.layout).chain(self.fallback.iter()) {
            visit(
                &layout.root_path.join("files").join(&self.name),
                Scope::Subtree,
            )?;
            visit(
                &layout.root_path.join("info").join(&self.info_name),
                Scope::Entry,
            )?;
            visit(
                &layout.root_path.join("info").join(&self.temporary_name),
                Scope::Entry,
            )?;
        }
        Ok(())
    }
}

impl LayoutPlan {
    pub(super) fn retained_bytes(&self) -> usize {
        std::mem::size_of::<Self>()
            + 2 * std::mem::size_of::<usize>()
            + self.anchor_path.capacity()
            + self.root_path.capacity()
            + self.prefix.capacity() * std::mem::size_of::<DirectoryStep>()
            + self
                .prefix
                .iter()
                .map(|step| step.name.capacity())
                .sum::<usize>()
            + self.info.name.capacity()
            + self.files.name.capacity()
    }

    pub(super) fn visit_resources(
        &self,
        mut visit: impl FnMut(&Path, Access, Scope, SelectionRole) -> Result<(), AppError>,
    ) -> Result<(), AppError> {
        // A filesystem root cannot be a selected mutation entry. Every other
        // anchor is a shared read dependency; creation/repair steps own writes.
        if self.anchor_path.file_name().is_some() {
            visit(
                &self.anchor_path,
                Access::Read,
                Scope::Entry,
                SelectionRole::Shared,
            )?;
        }
        let mut path = self.anchor_path.clone();
        for step in &self.prefix {
            path.push(&step.name);
            visit(&path, step.access(), Scope::Entry, SelectionRole::Shared)?;
        }
        for step in [&self.info, &self.files] {
            visit(
                &self.root_path.join(&step.name),
                step.access(),
                Scope::Entry,
                SelectionRole::Shared,
            )?;
        }
        // This is a selection exclusion, not a broad inter-operation lock on
        // the trash root. Individual payload/metadata claims remain separate.
        visit(
            &self.root_path,
            Access::Read,
            Scope::Subtree,
            SelectionRole::Container,
        )
    }
}

impl DirectoryStep {
    fn access(&self) -> Access {
        match self.action {
            DirectoryAction::Open(_) => Access::Read,
            DirectoryAction::Create | DirectoryAction::Repair(_) => Access::Write,
        }
    }
}

pub(super) fn verify_directory(
    directory: &Directory,
    expected: &DirectoryIdentity,
) -> Result<(), AppError> {
    if &DirectoryIdentity::capture(directory)? != expected {
        return Err(AppError::Other(
            "Trash directory changed after preparation".into(),
        ));
    }
    Ok(())
}

fn can_create(directory: &Directory) -> bool {
    // SAFETY: the owned descriptor and constant terminated component are valid.
    // Effective-ID access checking includes native ACLs without mutating .Trash.
    unsafe {
        libc::faccessat(
            directory.file.as_raw_fd(),
            c".".as_ptr(),
            libc::W_OK | libc::X_OK,
            libc::AT_EACCESS,
        ) == 0
    }
}

#[cfg(test)]
#[path = "../../../test_support/freedesktop_trash_plan.rs"]
mod tests;

#[cfg(test)]
pub(super) fn open_home(path: &Path) -> Result<TrashDirectories, AppError> {
    LayoutProbe::home(path)?.plan.execute()
}

#[cfg(test)]
pub(super) fn open_mounted(mount: &Mount) -> Result<TrashDirectories, AppError> {
    let probes = LayoutProbe::mounted(mount)?;
    execute_layouts(probes.primary.plan, probes.fallback.map(|probe| probe.plan))
}

#[cfg(test)]
fn execute_layouts(
    primary: LayoutPlan,
    fallback: Option<LayoutPlan>,
) -> Result<TrashDirectories, AppError> {
    primary.execute().or_else(|primary_error| match fallback {
        Some(fallback) => fallback.execute().map_err(|error| AppError::Other(format!(
            "Prepared shared trash failed: {primary_error}; prepared personal trash also failed: {error}"
        ))),
        None => Err(primary_error),
    })
}
