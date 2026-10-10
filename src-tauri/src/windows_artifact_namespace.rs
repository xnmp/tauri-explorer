//! Windows local-NTFS artifact namespace primitives.
//!
//! Names are resolved one component at a time relative to retained directory
//! handles. Reparse points, alternate streams, remote paths and replacement are
//! refused. Creation/publication use NTFS write-through metadata requests, not
//! a no-op substitute for Unix directory fsync. Native Windows qualification is
//! required before callers use these primitives as durable authority.
#![cfg(windows)]
use std::{
    ffi::OsStr,
    fs::File,
    io,
    os::windows::{
        ffi::OsStrExt,
        io::{AsRawHandle, FromRawHandle},
    },
    path::{Component, Path, PathBuf, Prefix},
    sync::Arc,
};
use windows::{
    Wdk::{Foundation::OBJECT_ATTRIBUTES, Storage::FileSystem as nt},
    Win32::{
        Foundation::{HANDLE, NTSTATUS, OBJ_CASE_INSENSITIVE, OBJ_DONT_REPARSE, UNICODE_STRING},
        Security::{self as security, Authorization as acl},
        Storage::FileSystem as win,
        System::{Threading, IO::IO_STATUS_BLOCK},
    },
};

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}
fn win_error(error: windows::core::Error) -> io::Error {
    io::Error::other(error)
}
fn nt_result(status: NTSTATUS) -> io::Result<()> {
    if status.0 >= 0 {
        Ok(())
    } else {
        Err(io::Error::from_raw_os_error(
            unsafe { nt::RtlNtStatusToDosErrorNoTeb(status) } as i32,
        ))
    }
}
fn handle(file: &File) -> HANDLE {
    HANDLE(file.as_raw_handle())
}
fn component(name: &OsStr) -> io::Result<Vec<u16>> {
    let text = name
        .to_str()
        .ok_or_else(|| invalid("Non-Unicode artifact component"))?;
    let wide: Vec<_> = name.encode_wide().take(256).collect();
    if wide.is_empty() || wide.len() > 255 {
        return Err(invalid("Artifact component exceeds the single-name bound"));
    }
    let device = text.split('.').next().unwrap_or("").to_ascii_uppercase();
    if wide.is_empty()
        || wide.len() > 255
        || text == "."
        || text == ".."
        || text.ends_with(['.', ' '])
        || text.chars().any(|c| {
            c.is_control() || matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
        })
        || ["CON", "PRN", "AUX", "NUL"].contains(&device.as_str())
        || ["COM¹", "COM²", "COM³", "LPT¹", "LPT²", "LPT³"].contains(&device.as_str())
        || (device.starts_with("COM") || device.starts_with("LPT"))
            && device.len() == 4
            && matches!(device.as_bytes()[3], b'1'..=b'9')
    {
        return Err(invalid("Artifact component is not an ordinary single name"));
    }
    Ok(wide)
}
fn information(file: &File, directory: bool) -> io::Result<win::BY_HANDLE_FILE_INFORMATION> {
    if unsafe { win::GetFileType(handle(file)) } != win::FILE_TYPE_DISK {
        return Err(invalid("Artifact handle is not a disk object"));
    }
    let mut info = win::BY_HANDLE_FILE_INFORMATION::default();
    unsafe { win::GetFileInformationByHandle(handle(file), &mut info) }.map_err(win_error)?;
    if info.dwFileAttributes & win::FILE_ATTRIBUTE_REPARSE_POINT.0 != 0
        || (info.dwFileAttributes & win::FILE_ATTRIBUTE_DIRECTORY.0 != 0) != directory
    {
        return Err(invalid(
            "Artifact handle is reparse or has the wrong object type",
        ));
    }
    Ok(info)
}
fn identity(file: &File, directory: bool) -> io::Result<(u32, u32, u32)> {
    let info = information(file, directory)?;
    Ok((
        info.dwVolumeSerialNumber,
        info.nFileIndexHigh,
        info.nFileIndexLow,
    ))
}
fn local_volume(file: &File, require_ntfs: bool) -> io::Result<()> {
    let mut filesystem = [0u16; 32];
    unsafe {
        win::GetVolumeInformationByHandleW(
            handle(file),
            None,
            None,
            None,
            None,
            Some(&mut filesystem),
        )
    }
    .map_err(win_error)?;
    let end = filesystem
        .iter()
        .position(|c| *c == 0)
        .unwrap_or(filesystem.len());
    if require_ntfs && String::from_utf16_lossy(&filesystem[..end]) != "NTFS" {
        return Err(invalid("Artifact authority requires local NTFS"));
    }
    let mut path = vec![0u16; 32768];
    let length =
        unsafe { win::GetFinalPathNameByHandleW(handle(file), &mut path, win::VOLUME_NAME_GUID) }
            as usize;
    if length == 0
        || length >= path.len()
        || !String::from_utf16_lossy(&path[..length]).starts_with("\\\\?\\Volume{")
    {
        return Err(invalid(
            "Artifact authority is not a local volume namespace",
        ));
    }
    Ok(())
}
/// OBJ_DONT_REPARSE also rejects the Object Manager drive-letter link on
/// Windows 10. Resolve only that alias, never any filesystem component.
fn volume_root(drive: u8) -> io::Result<Vec<u16>> {
    let name = [u16::from(drive), u16::from(b':'), 0];
    let mut target = vec![0u16; 32768];
    let length =
        unsafe { win::QueryDosDeviceW(windows::core::PCWSTR(name.as_ptr()), Some(&mut target)) }
            as usize;
    if length == 0 {
        return Err(io::Error::last_os_error());
    }
    if length > target.len() {
        return Err(invalid("Drive alias exceeds bounded target"));
    }
    let end = target[..length]
        .iter()
        .position(|unit| *unit == 0)
        .ok_or_else(|| invalid("Drive alias lacks a terminated current mapping"))?;
    target.truncate(end); // Later MULTI_SZ entries are prior mappings, not authority.
    let prefix = b"\\Device\\HarddiskVolume";
    if target.len() <= prefix.len()
        || !target[..prefix.len()]
            .iter()
            .zip(prefix)
            .all(|(&unit, byte)| u8::try_from(unit).is_ok_and(|c| c.eq_ignore_ascii_case(byte)))
        || !target[prefix.len()..]
            .iter()
            .all(|unit| (u16::from(b'0')..=u16::from(b'9')).contains(unit))
    {
        return Err(invalid(
            "Drive alias does not directly identify a disk volume",
        ));
    }
    target.push(u16::from(b'\\'));
    Ok(target)
}
fn open_native(
    parent: Option<&File>,
    name: Vec<u16>,
    directory: bool,
    create: bool,
    writable: bool,
) -> io::Result<File> {
    open_native_options(
        parent,
        name,
        directory,
        create,
        writable,
        win::FILE_ACCESS_RIGHTS(0),
        None,
    )
}
fn open_native_options(
    parent: Option<&File>,
    mut name: Vec<u16>,
    directory: bool,
    create: bool,
    writable: bool,
    extra_access: win::FILE_ACCESS_RIGHTS,
    descriptor: Option<security::PSECURITY_DESCRIPTOR>,
) -> io::Result<File> {
    let byte_length = name
        .len()
        .checked_mul(2)
        .filter(|n| *n <= u16::MAX as usize)
        .ok_or_else(|| invalid("Artifact name is too long"))?;
    let mut unicode = UNICODE_STRING {
        Length: byte_length as u16,
        MaximumLength: byte_length as u16,
        Buffer: windows::core::PWSTR(name.as_mut_ptr()),
    };
    let attributes = OBJECT_ATTRIBUTES {
        Length: std::mem::size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: parent.map(handle).unwrap_or_default(),
        ObjectName: &mut unicode,
        Attributes: OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE,
        SecurityDescriptor: descriptor
            .map(|d| d.0.cast_const().cast())
            .unwrap_or(std::ptr::null()),
        ..Default::default()
    };
    let mut result = HANDLE::default();
    let mut status = IO_STATUS_BLOCK::default();
    let access = if directory {
        win::FILE_READ_ATTRIBUTES
            | win::FILE_TRAVERSE
            | win::SYNCHRONIZE
            | if writable {
                win::FILE_WRITE_ATTRIBUTES | win::DELETE
            } else {
                win::FILE_ACCESS_RIGHTS(0)
            }
    } else {
        win::FILE_READ_DATA
            | win::FILE_READ_ATTRIBUTES
            | win::SYNCHRONIZE
            | if writable {
                win::FILE_WRITE_DATA | win::FILE_WRITE_ATTRIBUTES | win::DELETE
            } else {
                win::FILE_ACCESS_RIGHTS(0)
            }
    };
    let options = nt::FILE_SYNCHRONOUS_IO_NONALERT
        | nt::FILE_OPEN_REPARSE_POINT
        | if directory {
            nt::FILE_DIRECTORY_FILE
        } else {
            nt::FILE_NON_DIRECTORY_FILE
        }
        | if writable || create || extra_access.0 & win::WRITE_DAC.0 != 0 {
            nt::FILE_WRITE_THROUGH
        } else {
            nt::NTCREATEFILE_CREATE_OPTIONS(0)
        };
    nt_result(unsafe {
        nt::NtCreateFile(
            &mut result,
            access | extra_access,
            &attributes,
            &mut status,
            None,
            win::FILE_ATTRIBUTE_NORMAL,
            win::FILE_SHARE_READ,
            if create {
                nt::FILE_CREATE
            } else {
                nt::FILE_OPEN
            },
            options,
            None,
            0,
        )
    })?;
    let file = unsafe { File::from_raw_handle(result.0) };
    information(&file, directory)?;
    Ok(file)
}

fn rename_file(parent: &File, source: &File, name: &OsStr, replace: bool) -> io::Result<()> {
    let wide = component(name)?;
    let length = (std::mem::offset_of!(nt::FILE_RENAME_INFORMATION, FileName) + wide.len() * 2)
        .max(std::mem::size_of::<nt::FILE_RENAME_INFORMATION>());
    let mut storage = vec![0u64; length.div_ceil(8)];
    let rename = storage.as_mut_ptr().cast::<nt::FILE_RENAME_INFORMATION>();
    unsafe {
        (*rename).Anonymous.ReplaceIfExists = replace;
        (*rename).RootDirectory = handle(parent);
        (*rename).FileNameLength = (wide.len() * 2) as u32;
        std::ptr::copy_nonoverlapping(wide.as_ptr(), (*rename).FileName.as_mut_ptr(), wide.len());
    }
    let mut status = IO_STATUS_BLOCK::default();
    nt_result(unsafe {
        nt::NtSetInformationFile(
            handle(source),
            &mut status,
            rename.cast(),
            length as u32,
            nt::FileRenameInformation,
        )
    })
}
struct LocalAllocation(*mut std::ffi::c_void);
impl Drop for LocalAllocation {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                windows::Win32::Foundation::LocalFree(Some(windows::Win32::Foundation::HLOCAL(
                    self.0,
                )));
            }
        }
    }
}
struct TokenHandle(HANDLE);
impl Drop for TokenHandle {
    fn drop(&mut self) {
        let _ = unsafe { windows::Win32::Foundation::CloseHandle(self.0) };
    }
}
struct PrivateDescriptor(LocalAllocation);
impl PrivateDescriptor {
    fn pointer(&self) -> security::PSECURITY_DESCRIPTOR {
        security::PSECURITY_DESCRIPTOR(self.0 .0)
    }
    fn current_user() -> io::Result<Self> {
        let mut token = HANDLE::default();
        unsafe {
            Threading::OpenProcessToken(
                Threading::GetCurrentProcess(),
                security::TOKEN_QUERY,
                &mut token,
            )
        }
        .map_err(win_error)?;
        let token = TokenHandle(token);
        let mut length = 0;
        let _ = unsafe {
            security::GetTokenInformation(token.0, security::TokenUser, None, 0, &mut length)
        };
        if length == 0 || length > 65536 {
            return Err(invalid("Token user exceeds bounded SID allocation"));
        }
        let mut buffer = vec![0u64; (length as usize).div_ceil(8)];
        unsafe {
            security::GetTokenInformation(
                token.0,
                security::TokenUser,
                Some(buffer.as_mut_ptr().cast()),
                length,
                &mut length,
            )
        }
        .map_err(win_error)?;
        let sid = unsafe { (*buffer.as_ptr().cast::<security::TOKEN_USER>()).User.Sid };
        let mut text = windows::core::PWSTR::null();
        unsafe { acl::ConvertSidToStringSidW(sid, &mut text) }.map_err(win_error)?;
        let owned_text = LocalAllocation(text.0.cast());
        let sid_text =
            unsafe { text.to_string() }.map_err(|_| invalid("Token SID is not valid Unicode"))?;
        // Exactly current user and SYSTEM. Administrators are not implicitly
        // added; privileged administrators remain outside the privacy threat model.
        let descriptor = format!("O:{sid_text}D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;{sid_text})");
        drop(owned_text);
        let wide: Vec<u16> = descriptor.encode_utf16().chain(Some(0)).collect();
        let mut result = security::PSECURITY_DESCRIPTOR::default();
        unsafe {
            acl::ConvertStringSecurityDescriptorToSecurityDescriptorW(
                windows::core::PCWSTR(wide.as_ptr()),
                acl::SDDL_REVISION_1,
                &mut result,
                None,
            )
        }
        .map_err(win_error)?;
        Ok(Self(LocalAllocation(result.0)))
    }
    fn owner_dacl(&self) -> io::Result<(security::PSID, *mut security::ACL)> {
        let mut owner = security::PSID::default();
        let mut defaulted = windows::core::BOOL::default();
        unsafe { security::GetSecurityDescriptorOwner(self.pointer(), &mut owner, &mut defaulted) }
            .map_err(win_error)?;
        let mut present = windows::core::BOOL::default();
        let mut dacl = std::ptr::null_mut();
        unsafe {
            security::GetSecurityDescriptorDacl(
                self.pointer(),
                &mut present,
                &mut dacl,
                &mut defaulted,
            )
        }
        .map_err(win_error)?;
        if !present.as_bool() || dacl.is_null() || owner.0.is_null() {
            return Err(invalid("Private descriptor lacks explicit owner/DACL"));
        }
        Ok((owner, dacl))
    }
}
fn verify_descriptor(file: &File, expected: &PrivateDescriptor) -> io::Result<()> {
    let mut actual = security::PSECURITY_DESCRIPTOR::default();
    unsafe {
        acl::GetSecurityInfo(
            handle(file),
            acl::SE_FILE_OBJECT,
            security::OWNER_SECURITY_INFORMATION | security::DACL_SECURITY_INFORMATION,
            None,
            None,
            None,
            None,
            Some(&mut actual),
        )
    }
    .ok()
    .map_err(win_error)?;
    let actual = PrivateDescriptor(LocalAllocation(actual.0));
    let (owner, dacl) = actual.owner_dacl()?;
    let (expected_owner, expected_dacl) = expected.owner_dacl()?;
    unsafe { security::EqualSid(owner, expected_owner) }
        .map_err(|_| invalid("Private root is not owned by current user"))?;
    let mut control = 0;
    let mut revision = 0;
    unsafe {
        security::GetSecurityDescriptorControl(actual.pointer(), &mut control, &mut revision)
    }
    .map_err(win_error)?;
    if control & security::SE_DACL_PROTECTED.0 == 0 {
        return Err(invalid("Private root inherits a foreign DACL"));
    }
    let mut size = security::ACL_SIZE_INFORMATION::default();
    unsafe {
        security::GetAclInformation(
            dacl,
            (&mut size as *mut security::ACL_SIZE_INFORMATION).cast(),
            std::mem::size_of_val(&size) as u32,
            security::AclSizeInformation,
        )
    }
    .map_err(win_error)?;
    if size.AceCount != 2 || size.AclBytesInUse > 65536 {
        return Err(invalid("Private root DACL contains unexpected entries"));
    }
    let mut matched = [false; 2];
    for index in 0..2 {
        let mut entry = std::ptr::null_mut();
        unsafe { security::GetAce(dacl, index, &mut entry) }.map_err(win_error)?;
        let ace = unsafe { &*entry.cast::<security::ACCESS_ALLOWED_ACE>() };
        // Type 0 = ACCESS_ALLOWED_ACE, flags 3 = OBJECT/CONTAINER_INHERIT.
        if ace.Header.AceType != 0
            || ace.Header.AceFlags != 3
            || ace.Header.AceSize < std::mem::size_of::<security::ACCESS_ALLOWED_ACE>() as u16
        {
            return Err(invalid("Private DACL contains unexpected ACE type/flags"));
        }
        let mut found = false;
        for expected_index in 0..2 {
            let mut wanted = std::ptr::null_mut();
            unsafe { security::GetAce(expected_dacl, expected_index as u32, &mut wanted) }
                .map_err(win_error)?;
            let wanted = unsafe { &*wanted.cast::<security::ACCESS_ALLOWED_ACE>() };
            if !matched[expected_index]
                && ace.Mask == wanted.Mask
                && unsafe {
                    security::EqualSid(
                        security::PSID((&ace.SidStart as *const u32).cast_mut().cast()),
                        security::PSID((&wanted.SidStart as *const u32).cast_mut().cast()),
                    )
                }
                .is_ok()
            {
                matched[expected_index] = true;
                found = true;
                break;
            }
        }
        if !found {
            return Err(invalid("Private DACL grants a foreign principal"));
        }
    }
    Ok(())
}

struct Chain {
    directories: Vec<File>,
}
pub(crate) struct AnchoredDirectory {
    chain: Arc<Chain>,
    path: PathBuf,
    authority: bool,
}
pub(crate) struct AnchoredFile {
    file: File,
    parent: Arc<Chain>,
    path: PathBuf,
    writable: bool,
}
/// Holds the original source name/handle and both namespace chains through the
/// caller's metadata commit. A cloned source handle must never masquerade as an
/// opened destination handle: rename/delete act on the original opened name.
pub(crate) struct PublishedLink {
    source: AnchoredFile,
    destination: Arc<Chain>,
    path: PathBuf,
}
impl PublishedLink {
    pub fn file(&self) -> &File {
        self.source.file()
    }
    pub fn path(&self) -> &Path {
        &self.path
    }
    pub fn source_path(&self) -> &Path {
        self.source.path()
    }
    pub fn flush(&self) -> io::Result<()> {
        information(self.destination.directories.last().unwrap(), true)?;
        self.source.flush()
    }
}
/// Physical POSIX name removal is observable, but not yet a qualified durable
/// directory barrier. Keep the exact durable cleanup reservation on disk.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DeletionOutcome {
    RemovedDurabilityUnqualified,
}
impl AnchoredDirectory {
    fn require_authority(&self) -> io::Result<()> {
        if self.authority {
            Ok(())
        } else {
            Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "Readonly source has no artifact namespace authority",
            ))
        }
    }
    /// Local FAT/exFAT/NTFS inputs may be read without granting any mutation or
    /// acquired-proof authority. Every ancestor/final object remains anchored.
    pub fn open_absolute_readonly(path: &Path) -> io::Result<AnchoredFile> {
        let parent = path
            .parent()
            .ok_or_else(|| invalid("Input has no parent"))?;
        let name = path
            .file_name()
            .ok_or_else(|| invalid("Input has no file name"))?;
        Self::open_path(parent, false)?.open_regular(name, false)
    }
    /// Create missing ancestors with write-through metadata and private ACLs.
    /// Existing ancestors are only traversed; only the requested final root is
    /// secured. Existing descendants need their own explicit validation.
    pub fn ensure_private_absolute(path: &Path) -> io::Result<Self> {
        let mut parts = path.components();
        let drive = match parts.next() {
            Some(Component::Prefix(p)) => match p.kind() {
                Prefix::Disk(d) | Prefix::VerbatimDisk(d) => d,
                _ => return Err(invalid("Private root needs local drive")),
            },
            _ => return Err(invalid("Private root is not absolute")),
        };
        if !matches!(parts.next(), Some(Component::RootDir)) {
            return Err(invalid("Private root is drive-relative"));
        }
        // Validate the whole bounded request before creating any missing name.
        let mut names = Vec::new();
        for part in parts {
            let Component::Normal(name) = part else {
                return Err(invalid("Private root contains traversal"));
            };
            if names.len() >= 127 {
                return Err(invalid("Artifact path exceeds ancestor bound"));
            }
            component(name)?;
            names.push(name);
        }
        if names.is_empty() {
            return Err(invalid("Private namespace cannot be a volume root"));
        }
        let mut root = Self::open_absolute(Path::new(&format!("{}:\\", drive as char)))?;
        for name in names {
            root = match root.open_directory(name) {
                Ok(existing) => existing,
                Err(e) if e.kind() == io::ErrorKind::NotFound => {
                    match root.create_private_directory(name) {
                        Ok(created) => created,
                        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
                            root.open_directory(name)?
                        }
                        Err(e) => return Err(e),
                    }
                }
                Err(e) => return Err(e),
            };
        }
        root.secure_private_directory()?;
        Ok(root)
    }
    pub fn open_directory(&self, name: &OsStr) -> io::Result<Self> {
        if self.chain.directories.len() >= 128 {
            return Err(invalid("Artifact path exceeds ancestor bound"));
        }
        let directory = open_native(Some(self.directory()), component(name)?, true, false, false)?;
        let mut directories = self
            .chain
            .directories
            .iter()
            .map(File::try_clone)
            .collect::<io::Result<Vec<_>>>()?;
        directories.push(directory);
        Ok(Self {
            chain: Arc::new(Chain { directories }),
            path: self.path.join(name),
            authority: self.authority,
        })
    }
    pub fn create_private_directory(&self, name: &OsStr) -> io::Result<Self> {
        let descriptor = PrivateDescriptor::current_user()?;
        let root = self.create_directory_with_security(name, Some(descriptor.pointer()))?;
        root.verify_private_directory()?;
        Ok(root)
    }
    fn security_handle(&self, mutate: bool) -> io::Result<File> {
        self.require_authority()?;
        if self.chain.directories.len() < 2 {
            return Err(invalid("Volume root security is not owned"));
        }
        let parent = &self.chain.directories[self.chain.directories.len() - 2];
        let access = win::READ_CONTROL
            | if mutate {
                win::WRITE_DAC | win::WRITE_OWNER
            } else {
                win::FILE_ACCESS_RIGHTS(0)
            };
        let file = open_native_options(
            Some(parent),
            component(self.path.file_name().unwrap())?,
            true,
            false,
            false,
            access,
            None,
        )?;
        if identity(&file, true)? != identity(self.directory(), true)? {
            return Err(invalid("Private directory identity changed"));
        }
        Ok(file)
    }
    /// Handle-based protection: current token user and SYSTEM only, full access
    /// inherited by files/directories, protected against parent ACL inheritance.
    pub fn secure_private_directory(&self) -> io::Result<()> {
        let file = self.security_handle(true)?;
        let desired = PrivateDescriptor::current_user()?;
        let (owner, dacl) = desired.owner_dacl()?;
        unsafe {
            acl::SetSecurityInfo(
                handle(&file),
                acl::SE_FILE_OBJECT,
                security::OWNER_SECURITY_INFORMATION
                    | security::DACL_SECURITY_INFORMATION
                    | security::PROTECTED_DACL_SECURITY_INFORMATION,
                Some(owner),
                None,
                Some(dacl),
                None,
            )
        }
        .ok()
        .map_err(win_error)?;
        verify_descriptor(&file, &desired)
    }
    pub fn verify_private_directory(&self) -> io::Result<()> {
        verify_descriptor(
            &self.security_handle(false)?,
            &PrivateDescriptor::current_user()?,
        )
    }
    pub fn hardlink_noreplace(
        &self,
        source: AnchoredFile,
        name: &OsStr,
    ) -> io::Result<PublishedLink> {
        self.require_authority()?;
        if !source.writable {
            return Err(invalid("Hardlink source is not writable authority"));
        }
        local_volume(&source.file, true)?;
        if identity(self.directory(), true)?.0 != identity(&source.file, false)?.0 {
            return Err(invalid("Hardlink crosses volumes"));
        }
        source.flush()?;
        let wide = component(name)?;
        let length = (std::mem::offset_of!(nt::FILE_LINK_INFORMATION, FileName) + wide.len() * 2)
            .max(std::mem::size_of::<nt::FILE_LINK_INFORMATION>());
        let mut storage = vec![0u64; length.div_ceil(8)];
        let link = storage.as_mut_ptr().cast::<nt::FILE_LINK_INFORMATION>();
        unsafe {
            (*link).Anonymous.ReplaceIfExists = false;
            (*link).RootDirectory = handle(self.directory());
            (*link).FileNameLength = (wide.len() * 2) as u32;
            std::ptr::copy_nonoverlapping(wide.as_ptr(), (*link).FileName.as_mut_ptr(), wide.len());
        }
        let mut status = IO_STATUS_BLOCK::default();
        nt_result(unsafe {
            nt::NtSetInformationFile(
                handle(&source.file),
                &mut status,
                link.cast(),
                length as u32,
                nt::FileLinkInformation,
            )
        })?;
        source.flush()?;
        Ok(PublishedLink {
            source,
            destination: self.chain.clone(),
            path: self.path.join(name),
        })
    }
    /// Config-only replacement. Artifact publication must use no-replace. A
    /// failure after the rename is mutation-uncertain, never safe to roll back
    /// a newly minted credential without checking the durable destination.
    pub fn replace_regular(
        &self,
        mut pending: AnchoredFile,
        final_name: &OsStr,
    ) -> io::Result<AnchoredFile> {
        self.require_authority()?;
        if !pending.writable
            || identity(self.directory(), true)?
                != identity(pending.parent.directories.last().unwrap(), true)?
        {
            return Err(invalid("Replacement source namespace mismatch"));
        }
        // Reject a reparse/directory destination before requesting replacement.
        match self.open_regular(final_name, false) {
            Ok(file) => drop(file),
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
        pending.flush()?;
        rename_file(self.directory(), &pending.file, final_name, true)?;
        pending.path = self.path.join(final_name);
        pending.flush()?;
        Ok(pending)
    }
    /// First retire with publish_noreplace to a deterministic owned tombstone.
    /// Then physically delete it. Success does NOT authorize dropping durable
    /// cleanup metadata until Windows final namespace durability is qualified.
    pub fn delete_regular(&self, file: AnchoredFile) -> io::Result<DeletionOutcome> {
        self.require_authority()?;
        if !file.writable
            || identity(self.directory(), true)?
                != identity(file.parent.directories.last().unwrap(), true)?
        {
            return Err(invalid("Deletion namespace mismatch"));
        }
        let name = file
            .path
            .file_name()
            .ok_or_else(|| invalid("Deletion has no owned name"))?
            .to_owned();
        file.flush()?;
        let disposition = nt::FILE_DISPOSITION_INFORMATION_EX {
            Flags: nt::FILE_DISPOSITION_INFORMATION_EX_FLAGS(
                nt::FILE_DISPOSITION_DELETE.0 | nt::FILE_DISPOSITION_POSIX_SEMANTICS.0,
            ),
        };
        let mut status = IO_STATUS_BLOCK::default();
        nt_result(unsafe {
            nt::NtSetInformationFile(
                handle(&file.file),
                &mut status,
                (&disposition as *const nt::FILE_DISPOSITION_INFORMATION_EX).cast(),
                std::mem::size_of_val(&disposition) as u32,
                nt::FileDispositionInformationEx,
            )
        })?;
        file.flush()?;
        drop(file); // Microsoft documents POSIX namespace removal at close.
        match self.open_regular(&name, false) {
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                Ok(DeletionOutcome::RemovedDurabilityUnqualified)
            }
            Err(e) => Err(e),
            Ok(_) => Err(io::Error::other(
                "Deletion name is still present; retain cleanup reservation",
            )),
        }
    }
    /// Retain every opened ancestor, including the volume root, until all owned
    /// child IO and its caller's metadata commit finish. C:\ needs traversal only.
    pub fn open_absolute(path: &Path) -> io::Result<Self> {
        Self::open_path(path, true)
    }
    fn open_path(path: &Path, authority: bool) -> io::Result<Self> {
        let mut components = path.components();
        let drive = match components.next() {
            Some(Component::Prefix(p)) => match p.kind() {
                Prefix::Disk(d) | Prefix::VerbatimDisk(d) => d,
                _ => return Err(invalid("Artifact root requires a local drive path")),
            },
            _ => return Err(invalid("Artifact root is not absolute")),
        };
        if !matches!(components.next(), Some(Component::RootDir)) {
            return Err(invalid("Artifact root is drive-relative"));
        }
        let root = volume_root(drive)?;
        let first = open_native(None, root, true, false, false)?;
        local_volume(&first, authority)?;
        let mut directories = vec![first];
        let mut resolved = PathBuf::from(format!("{}:\\", drive as char));
        for part in components {
            let Component::Normal(name) = part else {
                return Err(invalid("Artifact root contains traversal"));
            };
            if directories.len() >= 128 {
                return Err(invalid("Artifact path exceeds ancestor bound"));
            }
            let next = open_native(directories.last(), component(name)?, true, false, false)?;
            resolved.push(name);
            directories.push(next);
        }
        Ok(Self {
            chain: Arc::new(Chain { directories }),
            path: resolved,
            authority,
        })
    }
    fn directory(&self) -> &File {
        self.chain.directories.last().expect("volume anchor")
    }
    pub fn path(&self) -> &Path {
        &self.path
    }
    pub fn open_regular(&self, name: &OsStr, writable: bool) -> io::Result<AnchoredFile> {
        if writable {
            self.require_authority()?;
        }
        let file = open_native(
            Some(self.directory()),
            component(name)?,
            false,
            false,
            writable,
        )?;
        Ok(AnchoredFile {
            file,
            parent: self.chain.clone(),
            path: self.path.join(name),
            writable,
        })
    }
    pub fn create_new(&self, name: &OsStr) -> io::Result<AnchoredFile> {
        self.require_authority()?;
        let file = open_native(Some(self.directory()), component(name)?, false, true, true)?;
        Ok(AnchoredFile {
            file,
            parent: self.chain.clone(),
            path: self.path.join(name),
            writable: true,
        })
    }
    /// Native write-through directory creation. Existing names are not replaced.
    /// Caller must establish private ACL ownership before committing a namespace.
    pub fn create_directory(&self, name: &OsStr) -> io::Result<Self> {
        self.create_directory_with_security(name, None)
    }
    fn create_directory_with_security(
        &self,
        name: &OsStr,
        sd: Option<security::PSECURITY_DESCRIPTOR>,
    ) -> io::Result<Self> {
        self.require_authority()?;
        if self.chain.directories.len() >= 128 {
            return Err(invalid("Artifact path exceeds ancestor bound"));
        }
        let directory = open_native_options(
            Some(self.directory()),
            component(name)?,
            true,
            true,
            true,
            win::FILE_ACCESS_RIGHTS(0),
            sd,
        )?;
        let created = identity(&directory, true)?;
        // The creation handle has DELETE access for namespace operations. Do
        // not retain it in a read guard: later independent readers must be able
        // to open this directory while still denying delete sharing themselves.
        drop(directory);
        let directory = open_native(Some(self.directory()), component(name)?, true, false, false)?;
        if identity(&directory, true)? != created {
            return Err(invalid("Created directory changed before anchoring"));
        }
        let mut directories = self
            .chain
            .directories
            .iter()
            .map(File::try_clone)
            .collect::<io::Result<Vec<_>>>()?;
        directories.push(directory);
        Ok(Self {
            chain: Arc::new(Chain { directories }),
            path: self.path.join(name),
            authority: true,
        })
    }
    /// Only an already owned write-through source handle can publish; no path
    /// re-open window, replacement, cross-volume copy, or relaxed share modes.
    pub fn publish_noreplace(
        &self,
        mut pending: AnchoredFile,
        final_name: &OsStr,
    ) -> io::Result<AnchoredFile> {
        self.require_authority()?;
        if !pending.writable
            || identity(self.directory(), true)?
                != identity(pending.parent.directories.last().unwrap(), true)?
        {
            return Err(invalid(
                "Publication source belongs to a different namespace",
            ));
        }
        pending.flush()?;
        let wide = component(final_name)?;
        let offset = std::mem::offset_of!(nt::FILE_RENAME_INFORMATION, FileName);
        let length =
            (offset + wide.len() * 2).max(std::mem::size_of::<nt::FILE_RENAME_INFORMATION>());
        let mut storage = vec![
            0u64;
            length.div_ceil(8).max(
                std::mem::size_of::<nt::FILE_RENAME_INFORMATION>().div_ceil(8)
            )
        ];
        let rename = storage.as_mut_ptr().cast::<nt::FILE_RENAME_INFORMATION>();
        unsafe {
            (*rename).Anonymous.ReplaceIfExists = false;
            (*rename).RootDirectory = handle(self.directory());
            (*rename).FileNameLength = (wide.len() * 2) as u32;
            std::ptr::copy_nonoverlapping(
                wide.as_ptr(),
                (*rename).FileName.as_mut_ptr(),
                wide.len(),
            );
        }
        let mut status = IO_STATUS_BLOCK::default();
        nt_result(unsafe {
            nt::NtSetInformationFile(
                handle(&pending.file),
                &mut status,
                rename.cast(),
                length as u32,
                nt::FileRenameInformation,
            )
        })?;
        #[cfg(test)]
        if final_name == OsStr::new("crash-final")
            && std::env::var_os("TE_NAMESPACE_FIXTURE_STAGE").as_deref()
                == Some(OsStr::new("after-rename"))
        {
            std::process::exit(91);
        }
        pending.path = self.path.join(final_name);
        pending.flush()?;
        Ok(pending)
    }
    /// Qualification probe only: propagate the actual kernel result. Never use
    /// an unsupported directory flush as a successful durability barrier.
    pub fn probe_directory_flush(&self) -> io::Result<()> {
        let mut status = IO_STATUS_BLOCK::default();
        nt_result(unsafe { nt::NtFlushBuffersFile(handle(self.directory()), &mut status) })
    }
    pub fn flush_evidence(&self, file: &AnchoredFile) -> io::Result<()> {
        self.require_authority()?;
        if identity(self.directory(), true)?
            != identity(file.parent.directories.last().unwrap(), true)?
        {
            return Err(invalid("Evidence namespace mismatch"));
        }
        file.flush()
    }
}
impl AnchoredFile {
    pub fn file(&self) -> &File {
        &self.file
    }
    pub fn file_mut(&mut self) -> &mut File {
        &mut self.file
    }
    pub fn path(&self) -> &Path {
        &self.path
    }
    pub fn flush(&self) -> io::Result<()> {
        if !self.writable {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "Windows artifact flush requires a writable handle",
            ));
        }
        information(&self.file, false)?;
        unsafe { win::FlushFileBuffers(handle(&self.file)) }.map_err(win_error)
    }
}
