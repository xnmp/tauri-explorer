//! Handle-relative Windows directory operations for recovery storage.
//!
//! Names are opened relative to retained directory handles so validation and
//! mutation never fall back to a path lookup. See `NtCreateFile`'s
//! `RootDirectory` contract:
//! https://learn.microsoft.com/windows-hardware/drivers/ddi/ntifs/nf-ntifs-ntcreatefile

use std::{
    ffi::{OsStr, OsString},
    fs::{File, Metadata, OpenOptions},
    io,
    mem::{offset_of, size_of},
    os::windows::{
        ffi::{OsStrExt, OsStringExt},
        fs::OpenOptionsExt,
        io::{AsRawHandle, FromRawHandle},
    },
    path::{Component, Path, PathBuf, Prefix},
    ptr,
};

use windows::{
    core::PWSTR,
    Wdk::{
        Foundation::OBJECT_ATTRIBUTES,
        Storage::FileSystem::{
            FileNamesInformation, NtCreateFile, NtQueryDirectoryFile, FILE_CREATE,
            FILE_DIRECTORY_FILE, FILE_NAMES_INFORMATION, FILE_NON_DIRECTORY_FILE, FILE_OPEN,
            FILE_OPEN_REPARSE_POINT, FILE_SYNCHRONOUS_IO_NONALERT, NTCREATEFILE_CREATE_DISPOSITION,
            NTCREATEFILE_CREATE_OPTIONS,
        },
    },
    Win32::{
        Foundation::{
            ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND, HANDLE, STATUS_NO_MORE_FILES,
            UNICODE_STRING,
        },
        Security::SECURITY_DESCRIPTOR,
        Storage::FileSystem::{
            FileAttributeTagInfo, FileDispositionInfoEx, FileRenameInfo,
            GetFileInformationByHandleEx, GetVolumeInformationByHandleW, ReOpenFile,
            SetFileInformationByHandle, DELETE, FILE_ACCESS_RIGHTS, FILE_ATTRIBUTE_DIRECTORY,
            FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_REPARSE_POINT, FILE_ATTRIBUTE_TAG_INFO,
            FILE_DISPOSITION_FLAG_DELETE, FILE_DISPOSITION_FLAG_POSIX_SEMANTICS,
            FILE_DISPOSITION_INFO_EX, FILE_DISPOSITION_INFO_EX_FLAGS, FILE_FLAG_BACKUP_SEMANTICS,
            FILE_FLAG_OPEN_REPARSE_POINT, FILE_GENERIC_READ, FILE_GENERIC_WRITE,
            FILE_LIST_DIRECTORY, FILE_READ_ATTRIBUTES, FILE_RENAME_INFO, FILE_RENAME_INFO_0,
            FILE_SHARE_DELETE, FILE_SHARE_MODE, FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_TRAVERSE,
            READ_CONTROL, SYNCHRONIZE,
        },
        System::IO::IO_STATUS_BLOCK,
    },
};

use crate::files::windows_io::{io_error, nt_error};

use super::{
    windows_security::{validate_private, PrivateDescriptor},
    Directory,
};

const SHARE_ALL: FILE_SHARE_MODE =
    FILE_SHARE_MODE(FILE_SHARE_READ.0 | FILE_SHARE_WRITE.0 | FILE_SHARE_DELETE.0);
const DIRECTORY_ACCESS: FILE_ACCESS_RIGHTS = FILE_ACCESS_RIGHTS(
    FILE_LIST_DIRECTORY.0
        | FILE_TRAVERSE.0
        | FILE_READ_ATTRIBUTES.0
        | READ_CONTROL.0
        | SYNCHRONIZE.0,
);
const ENUMERATION_BUFFER_BYTES: usize = 128 * 1024;

impl Directory {
    pub(crate) fn open(path: &Path) -> io::Result<Self> {
        let mut components = path.components();
        let prefix = match components.next() {
            Some(Component::Prefix(prefix))
                if matches!(
                    prefix.kind(),
                    Prefix::Disk(_)
                        | Prefix::VerbatimDisk(_)
                        | Prefix::UNC(_, _)
                        | Prefix::VerbatimUNC(_, _)
                ) =>
            {
                prefix
            }
            _ => {
                return Err(invalid_input(
                    "Directory path must use a filesystem drive or UNC root",
                ))
            }
        };
        if !matches!(components.next(), Some(Component::RootDir)) {
            return Err(invalid_input("Directory path must be absolute"));
        }

        let mut root = PathBuf::from(prefix.as_os_str());
        root.push(r"\");
        let file = OpenOptions::new()
            .read(true)
            .access_mode(DIRECTORY_ACCESS.0)
            .share_mode(SHARE_ALL.0)
            .custom_flags((FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT).0)
            .open(root)?;
        ensure_kind(&file, EntryKind::Directory, true)?;

        let mut directory = Self { file };
        for component in components {
            match component {
                Component::Normal(name) => directory = directory.open_existing(name)?,
                _ => return Err(invalid_input("Directory path is not normalized")),
            }
        }
        Ok(directory)
    }

    pub(crate) fn open_existing(&self, name: &OsStr) -> io::Result<Self> {
        let file = open_relative(
            &self.file,
            name,
            DIRECTORY_ACCESS,
            FILE_OPEN,
            FILE_DIRECTORY_FILE,
            None,
        )?;
        ensure_kind(&file, EntryKind::Directory, true)?;
        Ok(Self { file })
    }

    /// Exclusive creation with the private descriptor applied by the create syscall.
    pub(crate) fn create_directory(&self, name: &OsStr) -> io::Result<Self> {
        let security = PrivateDescriptor::new()?;
        let file = open_relative(
            &self.file,
            name,
            DIRECTORY_ACCESS,
            FILE_CREATE,
            FILE_DIRECTORY_FILE,
            Some(security.as_ptr()),
        )?;
        ensure_kind(&file, EntryKind::Directory, true)?;
        validate_private(&file)?;
        Ok(Self { file })
    }

    /// Exclusive creation with the private descriptor applied by the create syscall.
    pub(crate) fn create_file(&self, name: &OsStr) -> io::Result<File> {
        let security = PrivateDescriptor::new()?;
        let access = FILE_GENERIC_READ | FILE_GENERIC_WRITE | READ_CONTROL | DELETE | SYNCHRONIZE;
        let file = open_relative(
            &self.file,
            name,
            access,
            FILE_CREATE,
            FILE_NON_DIRECTORY_FILE,
            Some(security.as_ptr()),
        )?;
        ensure_kind(&file, EntryKind::File, true)?;
        validate_private(&file)?;
        Ok(file)
    }

    pub(crate) fn open_file(&self, name: &OsStr) -> io::Result<File> {
        let access = FILE_GENERIC_READ | READ_CONTROL | SYNCHRONIZE;
        let file = open_relative(
            &self.file,
            name,
            access,
            FILE_OPEN,
            FILE_NON_DIRECTORY_FILE,
            None,
        )?;
        ensure_kind(&file, EntryKind::File, true)?;
        Ok(file)
    }

    pub(crate) fn metadata(&self) -> io::Result<Metadata> {
        self.file.metadata()
    }

    pub(crate) fn entry_exists(&self, name: &OsStr) -> io::Result<bool> {
        match open_leaf_for_mutation(&self.file, name, FILE_READ_ATTRIBUTES | SYNCHRONIZE) {
            Ok(_) => Ok(true),
            Err(error)
                if matches!(
                    error.raw_os_error(),
                    Some(code)
                        if code == ERROR_FILE_NOT_FOUND.0 as i32
                            || code == ERROR_PATH_NOT_FOUND.0 as i32
                ) =>
            {
                Ok(false)
            }
            Err(error) => Err(error),
        }
    }

    /// Renames the exact opened source; the destination can never replace an entry.
    /// `FILE_RENAME_INFO::RootDirectory` keeps destination lookup handle-relative:
    /// https://learn.microsoft.com/windows/win32/api/winbase/ns-winbase-file_rename_info
    pub(crate) fn rename_to(
        &self,
        source: &OsStr,
        target_directory: &Self,
        target: &OsStr,
    ) -> io::Result<()> {
        let _ = native_name(source)?;
        let target = native_name(target)?;
        let source = open_leaf_for_mutation(
            &self.file,
            source,
            DELETE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
        )?;

        let name_bytes = target
            .len()
            .checked_mul(size_of::<u16>())
            .ok_or_else(|| invalid_input("Filesystem name is too long"))?;
        let information_bytes = offset_of!(FILE_RENAME_INFO, FileName)
            .checked_add(name_bytes)
            .ok_or_else(|| invalid_input("Filesystem name is too long"))?;
        let storage_bytes = information_bytes.max(size_of::<FILE_RENAME_INFO>());
        let mut storage = aligned_storage(storage_bytes);
        let information = storage.as_mut_ptr().cast::<FILE_RENAME_INFO>();
        // SAFETY: storage is aligned, zeroed, and large enough for the fixed fields
        // plus the complete UTF-16 name passed to SetFileInformationByHandle.
        unsafe {
            ptr::write(
                information,
                FILE_RENAME_INFO {
                    Anonymous: FILE_RENAME_INFO_0 {
                        ReplaceIfExists: false,
                    },
                    RootDirectory: file_handle(&target_directory.file),
                    FileNameLength: u32::try_from(name_bytes)
                        .map_err(|_| invalid_input("Filesystem name is too long"))?,
                    FileName: [0],
                },
            );
            ptr::copy_nonoverlapping(
                target.as_ptr(),
                ptr::addr_of_mut!((*information).FileName).cast::<u16>(),
                target.len(),
            );
            SetFileInformationByHandle(
                file_handle(&source),
                FileRenameInfo,
                information.cast(),
                u32::try_from(storage_bytes)
                    .map_err(|_| invalid_input("Filesystem name is too long"))?,
            )
            .map_err(io_error)
        }
    }

    /// Removes the exact opened leaf. Reparse points are removed as links.
    pub(crate) fn unlink(&self, name: &OsStr, directory: bool) -> io::Result<()> {
        let file = open_leaf_for_mutation(
            &self.file,
            name,
            DELETE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
        )?;
        let attributes = attributes(&file)?;
        let is_directory = attributes.FileAttributes & FILE_ATTRIBUTE_DIRECTORY.0 != 0
            && attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT.0 == 0;
        if is_directory != directory {
            return Err(invalid_input(if directory {
                "Entry is not a directory"
            } else {
                "Entry is a directory"
            }));
        }

        let information = FILE_DISPOSITION_INFO_EX {
            Flags: FILE_DISPOSITION_INFO_EX_FLAGS(
                FILE_DISPOSITION_FLAG_DELETE.0 | FILE_DISPOSITION_FLAG_POSIX_SEMANTICS.0,
            ),
        };
        // POSIX disposition retires the opened name immediately and refuses a
        // non-empty directory. Unsupported filesystems fail closed; there is no
        // path-based or delete-on-close fallback.
        unsafe {
            SetFileInformationByHandle(
                file_handle(&file),
                FileDispositionInfoEx,
                ptr::from_ref(&information).cast(),
                size_of::<FILE_DISPOSITION_INFO_EX>() as u32,
            )
            .map_err(io_error)?;
        }
        drop(file);
        if self.entry_exists(name)? {
            return Err(io::Error::other(
                "Windows did not retire the requested directory entry",
            ));
        }
        Ok(())
    }

    /// Enumerates through a freshly reopened handle so calls never share a cursor.
    /// Records follow `FILE_NAMES_INFORMATION`'s checked linked-buffer layout:
    /// https://learn.microsoft.com/windows-hardware/drivers/ddi/ntifs/ns-ntifs-_file_names_information
    pub(crate) fn names(&self, maximum: usize) -> io::Result<Vec<OsString>> {
        // SAFETY: the source handle remains valid for the call and the returned
        // handle is transferred immediately to one File owner.
        let handle = unsafe {
            ReOpenFile(
                file_handle(&self.file),
                (FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE).0,
                SHARE_ALL,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            )
            .map_err(io_error)?
        };
        // SAFETY: ReOpenFile returned a uniquely owned valid HANDLE.
        let directory = unsafe { File::from_raw_handle(handle.0) };
        let mut buffer = vec![0usize; ENUMERATION_BUFFER_BYTES.div_ceil(size_of::<usize>())];
        let mut restart = true;
        let mut names = Vec::new();

        loop {
            let mut status_block = IO_STATUS_BLOCK::default();
            // The reopened handle is synchronous (no OVERLAPPED flag), so the
            // stack status block and buffer cannot outlive this call.
            let status = unsafe {
                NtQueryDirectoryFile(
                    file_handle(&directory),
                    None,
                    None,
                    None,
                    &mut status_block,
                    buffer.as_mut_ptr().cast(),
                    ENUMERATION_BUFFER_BYTES as u32,
                    FileNamesInformation,
                    false,
                    None,
                    restart,
                )
            };
            restart = false;
            if status == STATUS_NO_MORE_FILES {
                return Ok(names);
            }
            if status.0 < 0 {
                return Err(nt_error(status));
            }

            let returned = status_block.Information;
            if returned == 0 || returned > ENUMERATION_BUFFER_BYTES {
                return Err(invalid_data("Invalid Windows directory enumeration length"));
            }
            // SAFETY: every byte in the initialized usize allocation is valid to
            // read as u8, and `returned` was checked against its byte capacity.
            let returned_bytes =
                unsafe { std::slice::from_raw_parts(buffer.as_ptr().cast::<u8>(), returned) };
            parse_names(returned_bytes, maximum, &mut names)?;
        }
    }

    pub(crate) fn sync(&self) -> io::Result<()> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "Windows recovery namespace durability has not been qualified",
        ))
    }

    pub(crate) fn name_max(&self) -> io::Result<usize> {
        let mut maximum = 0u32;
        // SAFETY: the directory handle is valid and the one supplied output
        // pointer remains writable for the duration of the synchronous call.
        unsafe {
            GetVolumeInformationByHandleW(
                file_handle(&self.file),
                None,
                None,
                Some(&mut maximum),
                None,
                None,
            )
            .map_err(io_error)?;
        }
        usize::try_from(maximum).map_err(|_| invalid_data("Invalid maximum component length"))
    }
}

#[derive(Clone, Copy)]
enum EntryKind {
    Directory,
    File,
}

fn open_leaf_for_mutation(
    parent: &File,
    name: &OsStr,
    access: FILE_ACCESS_RIGHTS,
) -> io::Result<File> {
    open_relative(
        parent,
        name,
        access,
        FILE_OPEN,
        NTCREATEFILE_CREATE_OPTIONS(0),
        None,
    )
}

fn open_relative(
    parent: &File,
    name: &OsStr,
    access: FILE_ACCESS_RIGHTS,
    disposition: NTCREATEFILE_CREATE_DISPOSITION,
    kind_options: NTCREATEFILE_CREATE_OPTIONS,
    security: Option<*mut core::ffi::c_void>,
) -> io::Result<File> {
    let name = native_name(name)?;
    let name_bytes = name
        .len()
        .checked_mul(size_of::<u16>())
        .and_then(|length| u16::try_from(length).ok())
        .ok_or_else(|| invalid_input("Filesystem name is too long"))?;
    let unicode = UNICODE_STRING {
        Length: name_bytes,
        MaximumLength: name_bytes,
        Buffer: PWSTR(name.as_ptr().cast_mut()),
    };
    let attributes = OBJECT_ATTRIBUTES {
        Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: file_handle(parent),
        ObjectName: &unicode,
        // The exact UTF-16 spelling is part of recovery identity. Omitting
        // OBJ_CASE_INSENSITIVE also preserves case-sensitive directory policy.
        Attributes: Default::default(),
        SecurityDescriptor: security.map_or(ptr::null(), |pointer| {
            pointer.cast::<SECURITY_DESCRIPTOR>() as *const SECURITY_DESCRIPTOR
        }),
        SecurityQualityOfService: ptr::null(),
    };
    let mut handle = HANDLE::default();
    let mut status_block = IO_STATUS_BLOCK::default();
    let options = kind_options | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT;
    // FILE_SYNCHRONOUS_IO_NONALERT makes this open complete before the stack
    // UNICODE_STRING, OBJECT_ATTRIBUTES, status block, and security descriptor
    // can be released.
    let status = unsafe {
        NtCreateFile(
            &mut handle,
            access,
            &attributes,
            &mut status_block,
            None,
            FILE_ATTRIBUTE_NORMAL,
            SHARE_ALL,
            disposition,
            options,
            None,
            0,
        )
    };
    if status.0 < 0 {
        return Err(nt_error(status));
    }
    if handle.is_invalid() {
        return Err(invalid_data("Windows returned an invalid file handle"));
    }
    // SAFETY: NtCreateFile completed synchronously and returned one owned handle.
    Ok(unsafe { File::from_raw_handle(handle.0) })
}

fn attributes(file: &File) -> io::Result<FILE_ATTRIBUTE_TAG_INFO> {
    let mut information = FILE_ATTRIBUTE_TAG_INFO::default();
    // SAFETY: information is correctly sized and writable for this synchronous query.
    unsafe {
        GetFileInformationByHandleEx(
            file_handle(file),
            FileAttributeTagInfo,
            ptr::from_mut(&mut information).cast(),
            size_of::<FILE_ATTRIBUTE_TAG_INFO>() as u32,
        )
        .map_err(io_error)?;
    }
    Ok(information)
}

fn ensure_kind(file: &File, expected: EntryKind, reject_reparse: bool) -> io::Result<()> {
    let attributes = attributes(file)?;
    if reject_reparse && attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0 {
        return Err(io::Error::other("Filesystem entry is a reparse point"));
    }
    let is_directory = attributes.FileAttributes & FILE_ATTRIBUTE_DIRECTORY.0 != 0;
    if is_directory != matches!(expected, EntryKind::Directory) {
        return Err(invalid_input(match expected {
            EntryKind::Directory => "Entry is not a directory",
            EntryKind::File => "Entry is not a file",
        }));
    }
    Ok(())
}

fn parse_names(buffer: &[u8], maximum: usize, names: &mut Vec<OsString>) -> io::Result<()> {
    const HEADER_BYTES: usize = offset_of!(FILE_NAMES_INFORMATION, FileName);
    let mut offset = 0usize;
    loop {
        let header_end = offset
            .checked_add(HEADER_BYTES)
            .ok_or_else(|| invalid_data("Invalid Windows directory record offset"))?;
        if header_end > buffer.len() {
            return Err(invalid_data("Truncated Windows directory record"));
        }
        let next_entry_offset = read_record_u32(buffer, offset)?;
        let file_name_length = read_record_u32(buffer, offset + 8)?;
        let name_bytes = usize::try_from(file_name_length)
            .map_err(|_| invalid_data("Invalid Windows directory name length"))?;
        if name_bytes == 0 || name_bytes % size_of::<u16>() != 0 {
            return Err(invalid_data("Odd Windows directory name length"));
        }
        let record_end = header_end
            .checked_add(name_bytes)
            .ok_or_else(|| invalid_data("Invalid Windows directory name length"))?;
        if record_end > buffer.len() {
            return Err(invalid_data("Truncated Windows directory name"));
        }
        let wide: Vec<u16> = buffer[header_end..record_end]
            .chunks_exact(size_of::<u16>())
            .map(|unit| u16::from_le_bytes([unit[0], unit[1]]))
            .collect();
        if wide.as_slice() != [b'.' as u16] && wide.as_slice() != [b'.' as u16, b'.' as u16] {
            if names.len() == maximum {
                return Err(invalid_data("Directory exceeds its entry limit"));
            }
            names.push(OsString::from_wide(&wide));
        }

        let next = usize::try_from(next_entry_offset)
            .map_err(|_| invalid_data("Invalid Windows directory record offset"))?;
        if next == 0 {
            return Ok(());
        }
        if next % size_of::<u32>() != 0 {
            return Err(invalid_data("Misaligned Windows directory record"));
        }
        if next < record_end - offset {
            return Err(invalid_data("Overlapping Windows directory records"));
        }
        offset = offset
            .checked_add(next)
            .ok_or_else(|| invalid_data("Invalid Windows directory record offset"))?;
        if offset >= buffer.len() {
            return Err(invalid_data("Invalid Windows directory record offset"));
        }
    }
}

fn read_record_u32(buffer: &[u8], offset: usize) -> io::Result<u32> {
    let end = offset
        .checked_add(size_of::<u32>())
        .ok_or_else(|| invalid_data("Invalid Windows directory record offset"))?;
    let bytes: [u8; size_of::<u32>()] = buffer
        .get(offset..end)
        .ok_or_else(|| invalid_data("Truncated Windows directory record"))?
        .try_into()
        .map_err(|_| invalid_data("Invalid Windows directory record"))?;
    Ok(u32::from_le_bytes(bytes))
}

fn native_name(name: &OsStr) -> io::Result<Vec<u16>> {
    // Bound allocation before validation, including input from malformed records.
    const MAXIMUM_UNITS: usize = u16::MAX as usize / size_of::<u16>();
    let name: Vec<u16> = name.encode_wide().take(MAXIMUM_UNITS + 1).collect();
    let is_dot = name == [b'.' as u16] || name == [b'.' as u16, b'.' as u16];
    if name.is_empty()
        || is_dot
        || name.iter().any(|unit| {
            *unit == 0
                || *unit == u16::from(b'/')
                || *unit == u16::from(b'\\')
                || *unit == u16::from(b':')
        })
    {
        return Err(invalid_input("Expected one filesystem name"));
    }
    if name.len() > MAXIMUM_UNITS {
        return Err(invalid_input("Filesystem name is too long"));
    }
    Ok(name)
}

fn aligned_storage(bytes: usize) -> Vec<usize> {
    vec![0; bytes.div_ceil(size_of::<usize>())]
}

fn file_handle(file: &File) -> HANDLE {
    HANDLE(file.as_raw_handle())
}

fn invalid_input(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

fn invalid_data(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

#[cfg(test)]
mod tests {
    use super::*;

    const HEADER_BYTES: usize = offset_of!(FILE_NAMES_INFORMATION, FileName);

    #[test]
    fn parser_preserves_wtf16_names() {
        let record = record(0, &[0xd800, b'x' as u16]);
        let mut names = Vec::new();

        parse_names(&record, 1, &mut names).unwrap();

        assert_eq!(names[0].encode_wide().collect::<Vec<_>>(), [0xd800, 0x78]);
    }

    #[test]
    fn parser_rejects_empty_odd_truncated_and_misaligned_records() {
        let mut empty = vec![0; HEADER_BYTES];
        assert!(parse_names(&empty, 1, &mut Vec::new()).is_err());

        empty[8..12].copy_from_slice(&1u32.to_le_bytes());
        empty.push(0);
        assert!(parse_names(&empty, 1, &mut Vec::new()).is_err());

        let mut truncated = vec![0; HEADER_BYTES];
        truncated[8..12].copy_from_slice(&2u32.to_le_bytes());
        assert!(parse_names(&truncated, 1, &mut Vec::new()).is_err());

        let mut misaligned = record(15, &[b'a' as u16]);
        misaligned.resize(HEADER_BYTES * 2 + 4, 0);
        assert!(parse_names(&misaligned, 2, &mut Vec::new()).is_err());
    }

    #[test]
    fn parser_rejects_overlapping_and_out_of_bounds_offsets() {
        let overlapping = record(HEADER_BYTES as u32, &[b'a' as u16]);
        assert!(parse_names(&overlapping, 2, &mut Vec::new()).is_err());

        let out_of_bounds = record(128, &[b'a' as u16]);
        assert!(parse_names(&out_of_bounds, 2, &mut Vec::new()).is_err());
    }

    fn record(next: u32, name: &[u16]) -> Vec<u8> {
        let mut bytes = vec![0; HEADER_BYTES + size_of_val(name)];
        bytes[..4].copy_from_slice(&next.to_le_bytes());
        bytes[8..12].copy_from_slice(&u32::try_from(size_of_val(name)).unwrap().to_le_bytes());
        for (destination, unit) in bytes[HEADER_BYTES..].chunks_exact_mut(2).zip(name) {
            destination.copy_from_slice(&unit.to_le_bytes());
        }
        bytes
    }
}
