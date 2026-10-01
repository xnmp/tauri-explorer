//! Preserve native I/O error codes at the Windows recovery boundary.
use std::io;
use windows::core::Error;

pub(super) fn io_error(error: Error) -> io::Error {
    let code = error.code().0 as u32;
    if code & 0xffff_0000 == 0x8007_0000 {
        io::Error::from_raw_os_error((code & 0xffff) as i32)
    } else {
        io::Error::other(error)
    }
}

/// `RtlNtStatusToDosError` returns this for a status it cannot map.
const ERROR_MR_MID_NOT_FOUND: u32 = 317;

pub(super) fn nt_error(status: windows::Win32::Foundation::NTSTATUS) -> io::Error {
    // SAFETY: status conversion has no borrowed memory or ownership effects.
    let code = unsafe { windows::Win32::Foundation::RtlNtStatusToDosError(status) };
    if code == ERROR_MR_MID_NOT_FOUND {
        // Keep the native status rather than an unrelated message-table error.
        return io::Error::other(format!("NTSTATUS {:#010x}", status.0 as u32));
    }
    io::Error::from_raw_os_error(code as i32)
}
