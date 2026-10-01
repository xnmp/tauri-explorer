//! Windows byte-range locking for durable recovery ownership.

use crate::files::windows_io::io_error;
use std::{
    fs::File,
    io,
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
};
use windows::{
    core::{Error as WindowsError, HRESULT, PCWSTR},
    Win32::{
        Foundation::{
            ERROR_IO_PENDING, ERROR_LOCK_VIOLATION, ERROR_NOT_FOUND, ERROR_OPERATION_ABORTED,
            HANDLE, WIN32_ERROR,
        },
        Storage::FileSystem::{
            LockFileEx, UnlockFileEx, LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY,
        },
        System::{
            Threading::CreateEventW,
            IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED, OVERLAPPED_0, OVERLAPPED_0_0},
        },
    },
};

const LOCK_OFFSET: u32 = 4096;
const LOCK_LENGTH: u32 = 1;

pub(super) fn lock(file: &File, wait: bool) -> io::Result<bool> {
    let handle = handle(file);
    let mut request = LockRequest::new()?;
    let flags = if wait {
        LOCKFILE_EXCLUSIVE_LOCK
    } else {
        LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY
    };

    // LockFileEx is synchronous unless the file was opened for overlapped I/O.
    // https://learn.microsoft.com/windows/win32/api/fileapi/nf-fileapi-lockfileex
    match unsafe { LockFileEx(handle, flags, None, LOCK_LENGTH, 0, &mut request.overlapped) } {
        Ok(()) => Ok(true),
        Err(error) if !wait && is_error(&error, ERROR_LOCK_VIOLATION) => Ok(false),
        Err(error) if is_error(&error, ERROR_IO_PENDING) => {
            complete_pending_lock(handle, &mut request.overlapped, wait)
        }
        Err(error) => Err(io_error(error)),
    }
}

pub(super) fn unlock(file: &File) -> io::Result<()> {
    let handle = handle(file);
    let mut request = LockRequest::new()?;
    match unsafe { UnlockFileEx(handle, None, LOCK_LENGTH, 0, &mut request.overlapped) } {
        Ok(()) => Ok(()),
        Err(error) if is_error(&error, ERROR_IO_PENDING) => {
            wait_for_completion(handle, &mut request.overlapped)
        }
        Err(error) => Err(io_error(error)),
    }
}

fn complete_pending_lock(
    handle: HANDLE,
    overlapped: &mut OVERLAPPED,
    wait: bool,
) -> io::Result<bool> {
    if wait {
        return wait_for_completion(handle, overlapped).map(|()| true);
    }

    // FAIL_IMMEDIATELY normally prevents a pending request. If a filesystem
    // nevertheless queues one, cancel only this request and drain its terminal
    // completion before this stack-owned OVERLAPPED is released.
    // https://learn.microsoft.com/windows/win32/api/ioapiset/nf-ioapiset-cancelioex
    let cancellation_error = unsafe { CancelIoEx(handle, Some(overlapped)) }
        .err()
        .filter(|error| !is_error(error, ERROR_NOT_FOUND));

    match wait_for_completion(handle, overlapped) {
        Ok(()) => Ok(true),
        Err(error)
            if error.raw_os_error() == Some(ERROR_OPERATION_ABORTED.0 as i32)
                || error.raw_os_error() == Some(ERROR_LOCK_VIOLATION.0 as i32) =>
        {
            Ok(false)
        }
        // A failed cancellation does not prove that the request ended. The
        // completion above is authoritative for pointer lifetime; preserve a
        // distinct cancellation failure when the operation also failed.
        Err(error) => Err(cancellation_error.map(io_error).unwrap_or(error)),
    }
}

fn wait_for_completion(handle: HANDLE, overlapped: &mut OVERLAPPED) -> io::Result<()> {
    let mut transferred = 0;
    // This OVERLAPPED owns a dedicated event, so unrelated operations or cloned
    // handles cannot wake this completion wait.
    // https://learn.microsoft.com/windows/win32/api/ioapiset/nf-ioapiset-getoverlappedresult
    unsafe { GetOverlappedResult(handle, overlapped, &mut transferred, true) }.map_err(io_error)
}

struct LockRequest {
    overlapped: OVERLAPPED,
    // Closed only after the immediate call or drained pending completion above.
    _event: OwnedHandle,
}

impl LockRequest {
    fn new() -> io::Result<Self> {
        // Manual reset is the documented event shape for an OVERLAPPED request.
        // https://learn.microsoft.com/windows/win32/sync/using-event-objects
        let event = unsafe { CreateEventW(None, true, false, PCWSTR::null()) }.map_err(io_error)?;
        // SAFETY: CreateEventW returned a unique owned handle, transferred once.
        let event = unsafe { OwnedHandle::from_raw_handle(event.0) };
        let overlapped = OVERLAPPED {
            Anonymous: OVERLAPPED_0 {
                Anonymous: OVERLAPPED_0_0 {
                    Offset: LOCK_OFFSET,
                    OffsetHigh: 0,
                },
            },
            hEvent: HANDLE(event.as_raw_handle()),
            ..Default::default()
        };
        Ok(Self {
            overlapped,
            _event: event,
        })
    }
}

fn handle(file: &File) -> HANDLE {
    HANDLE(file.as_raw_handle())
}

fn is_error(error: &WindowsError, expected: WIN32_ERROR) -> bool {
    error.code() == HRESULT::from_win32(expected.0)
}

#[cfg(test)]
mod tests {
    use super::{lock, unlock};
    use std::{
        fs::{self, File, OpenOptions},
        io::Read,
        os::windows::fs::OpenOptionsExt,
        sync::mpsc,
        thread,
        time::Duration,
    };
    use windows::Win32::Storage::FileSystem::FILE_FLAG_OVERLAPPED;

    #[test]
    fn async_handles_contend_without_hiding_lock_evidence() {
        let directory = tempfile::tempdir().expect("create lock fixture");
        let path = directory.path().join("owner.lock");
        let nonce = [0x5a; 32];
        fs::write(&path, nonce).expect("write immutable lock evidence");

        let open_async = || {
            OpenOptions::new()
                .read(true)
                .write(true)
                .custom_flags(FILE_FLAG_OVERLAPPED.0)
                .open(&path)
                .expect("open independent asynchronous lock handle")
        };
        let owner = open_async();
        let contender = open_async();

        assert!(lock(&owner, false).expect("acquire owner"));
        assert!(!lock(&contender, false).expect("observe contention"));

        let mut evidence = File::open(&path).expect("open evidence while owner is active");
        let mut observed = [0; 33];
        let length = evidence
            .read(&mut observed)
            .expect("read bounded evidence while owner is active");
        assert_eq!(length, nonce.len());
        assert_eq!(&observed[..length], &nonce);

        unlock(&owner).expect("release owner");
        assert!(lock(&contender, false).expect("acquire former contender"));
        unlock(&contender).expect("release former contender");
    }

    #[test]
    fn async_blocking_waiter_acquires_after_owner_releases() {
        let directory = tempfile::tempdir().expect("create lock fixture");
        let path = directory.path().join("owner.lock");
        let nonce = [0xa5; 32];
        fs::write(&path, nonce).expect("write immutable lock evidence");

        let owner = open_async(&path);
        let waiter = open_async(&path);
        assert!(lock(&owner, false).expect("acquire owner"));

        let (started_tx, started_rx) = mpsc::sync_channel(0);
        let (completed_tx, completed_rx) = mpsc::sync_channel(1);
        let waiter_path = path.clone();
        let waiting = thread::spawn(move || {
            started_tx.send(()).expect("announce blocking lock call");
            let acquired = lock(&waiter, true).expect("blocking waiter result");
            assert!(acquired);
            assert_eq!(read_evidence(&waiter_path), nonce);
            unlock(&waiter).expect("release blocking waiter");
            completed_tx.send(()).expect("announce waiter completion");
        });

        started_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("waiter started blocking lock call");
        assert_eq!(read_evidence(&path), nonce);
        assert!(matches!(
            completed_rx.recv_timeout(Duration::from_millis(50)),
            Err(mpsc::RecvTimeoutError::Timeout)
        ));
        unlock(&owner).expect("release owner for blocking waiter");
        completed_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("waiter completes after owner release");
        waiting.join().expect("blocking waiter completes");
    }

    fn open_async(path: &std::path::Path) -> File {
        OpenOptions::new()
            .read(true)
            .write(true)
            .custom_flags(FILE_FLAG_OVERLAPPED.0)
            .open(path)
            .expect("open independent asynchronous lock handle")
    }

    fn read_evidence(path: &std::path::Path) -> [u8; 32] {
        let mut file = File::open(path).expect("open evidence while ownership is active");
        let mut observed = [0; 33];
        let length = file
            .read(&mut observed)
            .expect("read bounded evidence while ownership is active");
        assert_eq!(length, 32);
        observed[..length]
            .try_into()
            .expect("copy exact lock evidence")
    }
}
