//! One reader owns each pipe. Retirement drains a snapshot of its queued bytes,
//! rather than closing capture after a scheduling deadline. A detached writer
//! can keep a pipe open, but cannot make that finite drain wait for future data.
use std::{
    io::{self, Read},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread::JoinHandle,
    time::Duration,
};

#[cfg(unix)]
use std::os::fd::AsRawFd;
#[cfg(windows)]
use std::os::windows::io::AsRawHandle;

pub(crate) trait OutputPipe: Read + Send + 'static {
    fn configure(&self) -> io::Result<()>;
    /// Returns queued bytes, or zero for an empty/closed pipe. The pipe's only
    /// reader consumes no more than this snapshot once retirement is observed.
    fn available(&self) -> io::Result<usize>;
    fn read_ready(&mut self, buffer: &mut [u8]) -> io::Result<usize>;
}

#[cfg(unix)]
impl<T: Read + AsRawFd + Send + 'static> OutputPipe for T {
    fn configure(&self) -> io::Result<()> {
        let fd = self.as_raw_fd();
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }

    fn available(&self) -> io::Result<usize> {
        let mut bytes: libc::c_int = 0;
        if unsafe { libc::ioctl(self.as_raw_fd(), libc::FIONREAD, &mut bytes) } < 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(bytes.max(0) as usize)
        }
    }

    fn read_ready(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        self.read(buffer)
    }
}

#[cfg(windows)]
fn peek(pipe: &impl AsRawHandle) -> io::Result<Option<usize>> {
    use windows_sys::Win32::{
        Foundation::{ERROR_BROKEN_PIPE, ERROR_PIPE_NOT_CONNECTED},
        System::Pipes::PeekNamedPipe,
    };
    let mut bytes = 0;
    // Anonymous child pipes support PeekNamedPipe. Their sole reader then
    // reads at most the returned amount, so synchronous ReadFile cannot wait
    // for another writer. Broken pipes are EOF, including empty stderr.
    if unsafe {
        PeekNamedPipe(
            pipe.as_raw_handle(),
            std::ptr::null_mut(),
            0,
            std::ptr::null_mut(),
            &mut bytes,
            std::ptr::null_mut(),
        )
    } != 0
    {
        Ok(Some(bytes as usize))
    } else {
        let error = io::Error::last_os_error();
        match error.raw_os_error().map(|code| code as u32) {
            Some(ERROR_BROKEN_PIPE | ERROR_PIPE_NOT_CONNECTED) => Ok(None),
            _ => Err(error),
        }
    }
}

#[cfg(windows)]
impl<T: Read + AsRawHandle + Send + 'static> OutputPipe for T {
    fn configure(&self) -> io::Result<()> {
        Ok(())
    }

    fn available(&self) -> io::Result<usize> {
        Ok(peek(self)?.unwrap_or(0))
    }

    fn read_ready(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        match peek(self)? {
            None => Ok(0),
            Some(0) => Err(io::ErrorKind::WouldBlock.into()),
            Some(bytes) => {
                let count = bytes.min(buffer.len());
                self.read(&mut buffer[..count])
            }
        }
    }
}

pub(crate) fn spawn(
    mut pipe: impl OutputPipe,
    limit: usize,
    overflow: Arc<AtomicBool>,
    retire: Arc<AtomicBool>,
) -> io::Result<JoinHandle<io::Result<Vec<u8>>>> {
    pipe.configure()?;
    std::thread::Builder::new()
        .name("owned-process-output".into())
        .spawn(move || read(&mut pipe, limit, &overflow, &retire))
}

/// Output workers are always joined. Retirement makes every read finite even
/// when a descendant escaped the process group and retained a pipe handle.
pub(crate) struct Readers {
    retire: Arc<AtomicBool>,
    stdout: Option<JoinHandle<io::Result<Vec<u8>>>>,
    stderr: Option<JoinHandle<io::Result<Vec<u8>>>>,
}

impl Readers {
    pub(crate) fn new(
        stdout: impl OutputPipe,
        stderr: impl OutputPipe,
        limits: (usize, usize),
        overflow: Arc<AtomicBool>,
    ) -> io::Result<Self> {
        let retire = Arc::new(AtomicBool::new(false));
        let mut readers = Self {
            retire: retire.clone(),
            stdout: None,
            stderr: None,
        };
        readers.stdout = Some(spawn(stdout, limits.0, overflow.clone(), retire.clone())?);
        readers.stderr = Some(spawn(stderr, limits.1, overflow, retire)?);
        Ok(readers)
    }

    pub(crate) fn retire(&self) {
        self.retire.store(true, Ordering::Release);
    }

    pub(crate) fn is_finished(&self) -> bool {
        [&self.stdout, &self.stderr]
            .iter()
            .all(|reader| reader.as_ref().is_none_or(JoinHandle::is_finished))
    }

    pub(crate) fn finish(&mut self) -> io::Result<(Vec<u8>, Vec<u8>)> {
        self.retire();
        // Join both before propagating an error, so no worker outlives cleanup.
        let stdout = join(self.stdout.take().expect("stdout reader"));
        let stderr = join(self.stderr.take().expect("stderr reader"));
        Ok((stdout?, stderr?))
    }
}

impl Drop for Readers {
    fn drop(&mut self) {
        self.retire();
        for reader in [&mut self.stdout, &mut self.stderr] {
            if let Some(reader) = reader.take() {
                let _ = reader.join();
            }
        }
    }
}

fn join(reader: JoinHandle<io::Result<Vec<u8>>>) -> io::Result<Vec<u8>> {
    reader
        .join()
        .map_err(|_| io::Error::other("child output reader panicked"))?
}

fn read(
    pipe: &mut impl OutputPipe,
    limit: usize,
    overflow: &AtomicBool,
    retire: &AtomicBool,
) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    let mut buffer = [0u8; 8192];
    let mut queued = None;
    loop {
        if queued.is_none() && retire.load(Ordering::Acquire) {
            queued = Some(pipe.available()?);
        }
        let count = match queued {
            Some(0) => return Ok(bytes),
            Some(count) => count.min(buffer.len()),
            None => buffer.len(),
        };
        match pipe.read_ready(&mut buffer[..count]) {
            Ok(0) => return Ok(bytes),
            Ok(count) => {
                let remaining = limit.saturating_sub(bytes.len());
                bytes.extend_from_slice(&buffer[..count.min(remaining)]);
                if count > remaining {
                    overflow.store(true, Ordering::Release);
                }
                if let Some(remaining) = queued.as_mut() {
                    *remaining -= count;
                }
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            // No queued data remains. An escaped helper may retain the write
            // end; its future bytes do not belong to the completed leaf.
            Err(error) if error.kind() == io::ErrorKind::WouldBlock && queued.is_some() => {
                return Ok(bytes)
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(error) => return Err(error),
        }
    }
}
