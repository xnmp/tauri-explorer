//! Windows file identity captured from an already-open handle.

use super::ObjectId;
use std::{
    fs::{File, OpenOptions},
    io,
    mem::size_of,
    os::windows::{fs::OpenOptionsExt, io::AsRawHandle},
    path::Path,
};
use windows::Win32::{
    Foundation::{ERROR_INVALID_FUNCTION, ERROR_INVALID_PARAMETER, ERROR_NOT_SUPPORTED, HANDLE},
    Storage::FileSystem::{
        FileIdInfo, GetFileInformationByHandle, GetFileInformationByHandleEx,
        BY_HANDLE_FILE_INFORMATION, FILE_ID_128, FILE_ID_INFO, FILE_READ_ATTRIBUTES,
        FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    },
};

pub(super) fn of_file(file: &File) -> io::Result<ObjectId> {
    let mut information = FILE_ID_INFO::default();
    // FILE_ID_INFO preserves the volume serial and full 128-bit identifier used
    // to compare two open file handles on one computer.
    // https://learn.microsoft.com/windows/win32/api/winbase/ns-winbase-file_id_info
    // SAFETY: the borrowed handle remains live and the writable output buffer
    // has exactly the size required by FileIdInfo for this synchronous call.
    unsafe {
        GetFileInformationByHandleEx(
            HANDLE(file.as_raw_handle()),
            FileIdInfo,
            (&mut information as *mut FILE_ID_INFO).cast(),
            size_of::<FILE_ID_INFO>() as u32,
        )
    }
    .map_err(crate::files::windows_io::io_error)?;

    Ok(ObjectId::windows(
        information.VolumeSerialNumber,
        information.FileId.Identifier,
    ))
}

/// The status a filesystem returns for an information class it does not
/// implement. FastFAT answers STATUS_INVALID_PARAMETER (#793).
pub(in crate::files) fn is_unsupported_class(error: &io::Error) -> bool {
    matches!(
        error.raw_os_error(),
        Some(code)
            if code == ERROR_INVALID_PARAMETER.0 as i32
                || code == ERROR_INVALID_FUNCTION.0 as i32
                || code == ERROR_NOT_SUPPORTED.0 as i32
    )
}

/// The volume serial and 128-bit file ID. Filesystems without
/// `FileIdInformation`, such as FAT (#793), fall back to the 64-bit file
/// index, zero-extended, which is what they would report there. Only an
/// unsupported-class error falls back; every other failure is returned.
pub(in crate::files) fn file_id(file: &File) -> io::Result<FILE_ID_INFO> {
    let mut identity = FILE_ID_INFO::default();
    // SAFETY: the handle is valid and the output buffer is exactly one
    // FILE_ID_INFO for the synchronous call.
    let extended = unsafe {
        GetFileInformationByHandleEx(
            HANDLE(file.as_raw_handle()),
            FileIdInfo,
            (&mut identity as *mut FILE_ID_INFO).cast(),
            size_of::<FILE_ID_INFO>() as u32,
        )
        .map_err(crate::files::windows_io::io_error)
    };
    match extended {
        Ok(()) => Ok(identity),
        Err(error) if is_unsupported_class(&error) => {
            let mut information = BY_HANDLE_FILE_INFORMATION::default();
            // SAFETY: the handle is valid and the output buffer is writable
            // for the synchronous call.
            unsafe {
                GetFileInformationByHandle(HANDLE(file.as_raw_handle()), &mut information)
                    .map_err(crate::files::windows_io::io_error)?;
            }
            Ok(indexed_file_id(&information))
        }
        Err(error) => Err(error),
    }
}

pub(in crate::files) fn indexed_file_id(information: &BY_HANDLE_FILE_INFORMATION) -> FILE_ID_INFO {
    let index =
        (u64::from(information.nFileIndexHigh) << 32) | u64::from(information.nFileIndexLow);
    let mut identifier = [0u8; 16];
    identifier[..8].copy_from_slice(&index.to_le_bytes());
    FILE_ID_INFO {
        VolumeSerialNumber: u64::from(information.dwVolumeSerialNumber),
        FileId: FILE_ID_128 {
            Identifier: identifier,
        },
    }
}

/// Identity of an existing path through a handle with attribute-only access
/// and full sharing: no data access, and no conflict with other openers.
pub(super) fn of_path(path: &Path) -> io::Result<ObjectId> {
    let handle = OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES.0)
        .share_mode(FILE_SHARE_READ.0 | FILE_SHARE_WRITE.0 | FILE_SHARE_DELETE.0)
        .open(path)?;
    let identity = file_id(&handle)?;
    Ok(ObjectId::windows(
        identity.VolumeSerialNumber,
        identity.FileId.Identifier,
    ))
}
