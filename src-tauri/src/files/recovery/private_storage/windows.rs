//! Windows recovery evidence policy evaluated through retained handles.

use std::{
    fs::{File, Metadata},
    io,
    mem::size_of,
    os::windows::io::AsRawHandle,
    ptr,
};

use windows::Win32::{
    Foundation::HANDLE,
    Storage::FileSystem::{
        FileAttributeTagInfo, FileStandardInfo, GetFileInformationByHandleEx,
        FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, FILE_ATTRIBUTE_TAG_INFO,
        FILE_STANDARD_INFO,
    },
};

use crate::files::{
    native_directory::{validate_private_security, Directory},
    windows_io::io_error,
};

pub(super) fn validate_directory(directory: &Directory) -> io::Result<()> {
    let metadata = directory.file.metadata()?;
    let attributes = attributes(&directory.file)?;
    let standard = standard(&directory.file)?;

    if !metadata.is_dir()
        || attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0
        || attributes.FileAttributes & FILE_ATTRIBUTE_DIRECTORY.0 == 0
        || !standard.Directory
        || standard.DeletePending
    {
        return Err(invalid(
            "Recovery storage must be a live non-reparse directory",
        ));
    }
    validate_private_security(&directory.file)
}

pub(super) fn validate_file(file: &File) -> io::Result<Metadata> {
    let metadata = file.metadata()?;
    let attributes = attributes(file)?;
    let standard = standard(file)?;

    if !metadata.is_file()
        || attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0
        || attributes.FileAttributes & FILE_ATTRIBUTE_DIRECTORY.0 != 0
        || standard.Directory
        || standard.DeletePending
        || standard.NumberOfLinks != 1
    {
        return Err(invalid(
            "Recovery evidence must be a live, non-reparse, singly linked regular file",
        ));
    }
    validate_private_security(file)?;
    Ok(metadata)
}

fn attributes(file: &File) -> io::Result<FILE_ATTRIBUTE_TAG_INFO> {
    let mut information = FILE_ATTRIBUTE_TAG_INFO::default();
    // SAFETY: the borrowed handle remains live, and the synchronous API gets a
    // uniquely borrowed output buffer of the exact generated structure size.
    unsafe {
        GetFileInformationByHandleEx(
            HANDLE(file.as_raw_handle()),
            FileAttributeTagInfo,
            ptr::from_mut(&mut information).cast(),
            size_of::<FILE_ATTRIBUTE_TAG_INFO>() as u32,
        )
    }
    .map_err(io_error)?;
    Ok(information)
}

fn standard(file: &File) -> io::Result<FILE_STANDARD_INFO> {
    let mut information = FILE_STANDARD_INFO::default();
    // SAFETY: the borrowed handle remains live, and the synchronous API gets a
    // uniquely borrowed output buffer of the exact generated structure size.
    unsafe {
        GetFileInformationByHandleEx(
            HANDLE(file.as_raw_handle()),
            FileStandardInfo,
            ptr::from_mut(&mut information).cast(),
            size_of::<FILE_STANDARD_INFO>() as u32,
        )
    }
    .map_err(io_error)?;
    Ok(information)
}

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}
