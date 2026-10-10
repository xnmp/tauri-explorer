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
        Storage::FileSystem as win,
        System::IO::IO_STATUS_BLOCK,
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
fn local_ntfs(file: &File) -> io::Result<()> {
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
    if String::from_utf16_lossy(&filesystem[..end]) != "NTFS" {
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
fn open_native(
    parent: Option<&File>,
    mut name: Vec<u16>,
    directory: bool,
    create: bool,
    writable: bool,
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
        | if writable || create {
            nt::FILE_WRITE_THROUGH
        } else {
            nt::NTCREATEFILE_CREATE_OPTIONS(0)
        };
    nt_result(unsafe {
        nt::NtCreateFile(
            &mut result,
            access,
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

struct Chain {
    directories: Vec<File>,
}
pub(crate) struct AnchoredDirectory {
    chain: Arc<Chain>,
    path: PathBuf,
}
pub(crate) struct AnchoredFile {
    file: File,
    parent: Arc<Chain>,
    path: PathBuf,
    writable: bool,
}
impl AnchoredDirectory {
    /// Retain every opened ancestor, including the volume root, until all owned
    /// child IO and its caller's metadata commit finish. C:\ needs traversal only.
    pub fn open_absolute(path: &Path) -> io::Result<Self> {
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
        let root = format!("\\??\\{}:\\", drive as char)
            .encode_utf16()
            .collect();
        let first = open_native(None, root, true, false, false)?;
        local_ntfs(&first)?;
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
        })
    }
    fn directory(&self) -> &File {
        self.chain.directories.last().expect("volume anchor")
    }
    pub fn path(&self) -> &Path {
        &self.path
    }
    pub fn open_regular(&self, name: &OsStr, writable: bool) -> io::Result<AnchoredFile> {
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
        let directory = open_native(Some(self.directory()), component(name)?, true, true, true)?;
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
        })
    }
    /// Only an already owned write-through source handle can publish; no path
    /// re-open window, replacement, cross-volume copy, or relaxed share modes.
    pub fn publish_noreplace(
        &self,
        mut pending: AnchoredFile,
        final_name: &OsStr,
    ) -> io::Result<AnchoredFile> {
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
