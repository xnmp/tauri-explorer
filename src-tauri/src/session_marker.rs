//! Unclean-exit detection (#1686).
//!
//! The panic hook only sees Rust panics. A native crash (WebKitGTK, GTK, a
//! system library), an out-of-memory kill or a forced termination leaves no
//! crash file, so the standard browser approach applies: each main app
//! process holds a session marker for its lifetime and removes it on every
//! orderly exit (`disarm`, from `release_process_resources`). A marker that
//! survives its process means that process ended without an orderly exit.
//!
//! Ownership and liveness:
//! - One marker per main process (`<log dir>/sessions/session-*.marker`),
//!   so concurrent instances sharing a profile (Windows launched twice,
//!   macOS `open -n`) never overwrite or judge each other's markers.
//! - The owner holds an exclusive OS file lock on its marker. The OS
//!   releases the lock when the process dies, however it dies, and a PID
//!   reused by another process cannot inherit it. A later launch that can
//!   take the lock knows the owner has gone; one that cannot leaves the
//!   marker alone (its owner is still running). Taking the lock also claims
//!   the marker, so two launches never report the same session.
//! - Portal-mode, single-instance hand-off and CLI processes never arm or
//!   review markers: `start` is called only from the main process's setup.
//!
//! A surviving marker is reported (as a crash file the existing crash notice
//! offers) unless `classify` finds an innocent explanation: another app
//! version wrote it, the host session that ran it has ended (reboot, logout,
//! display server restart — the OS may stop the app without a signal it can
//! handle, #1056), or a crash file from that session already explains it.
#![allow(clippy::disallowed_methods)] // Retire-when: #1638 closed (non-UTF-8 names, ADR 0031)

use std::fs::{File, OpenOptions, TryLockError};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Condvar, Mutex};
use std::time::Duration;

const MAGIC: &str = "tauri-explorer session v1";
const MARKER_PREFIX: &str = "session-";
const MARKER_SUFFIX: &str = ".marker";
const STAGING_PREFIX: &str = ".session-";
const STAGING_SUFFIX: &str = ".tmp";
/// A record is a handful of short lines; anything larger is not ours.
const MAX_RECORD: u64 = 4096;
/// Windows estimates boot time from the uptime counter; clock adjustments
/// move the estimate by seconds, a reboot by much more.
const BOOT_EPOCH_TOLERANCE_SECS: i64 = 120;

/// What identifies the OS session a process ran in. When any part differs
/// between a marker and the current launch, the session that ran the marker's
/// process has ended, and the OS (not a crash) may have ended the process.
/// A part unknown on either side is no evidence either way.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct HostSession {
    /// Linux `boot_id`, macOS `kern.boottime`.
    pub boot: Option<String>,
    /// Windows: boot time estimated from the uptime counter (epoch seconds).
    pub boot_epoch: Option<i64>,
    /// Linux audit login session, Windows logon session (LUID).
    pub login: Option<String>,
    /// Linux: identity (device, inode, ctime) of the Wayland socket.
    pub wayland: Option<String>,
    /// Linux: identity of the local X11 socket.
    pub x11: Option<String>,
}

impl HostSession {
    pub(crate) fn current() -> Self {
        host::current()
    }

    /// False when any known part shows the session ended in between.
    pub(crate) fn continues(&self, later: &HostSession) -> bool {
        fn same<T: PartialEq>(a: &Option<T>, b: &Option<T>) -> bool {
            match (a, b) {
                (Some(a), Some(b)) => a == b,
                _ => true,
            }
        }
        let boot_epoch = match (self.boot_epoch, later.boot_epoch) {
            (Some(a), Some(b)) => (a - b).abs() <= BOOT_EPOCH_TOLERANCE_SECS,
            _ => true,
        };
        same(&self.boot, &later.boot)
            && boot_epoch
            && same(&self.login, &later.login)
            && same(&self.wayland, &later.wayland)
            && same(&self.x11, &later.x11)
    }
}

/// The marker's contents.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SessionRecord {
    pub version: String,
    pub pid: u32,
    /// When the session started (Unix seconds).
    pub started: u64,
    pub host: HostSession,
}

/// One line per field: values are single-line by construction, and a value
/// that is not is dropped rather than corrupting the record.
fn clean_value(value: &str) -> Option<&str> {
    (!value.is_empty() && !value.contains(['\n', '\r'])).then_some(value)
}

impl SessionRecord {
    pub(crate) fn current(started: u64) -> Self {
        Self {
            version: env!("CARGO_PKG_VERSION").to_owned(),
            pid: std::process::id(),
            started,
            host: HostSession::current(),
        }
    }

    pub(crate) fn encode(&self) -> String {
        let mut text = format!(
            "{MAGIC}\nversion={}\npid={}\nstarted={}\n",
            clean_value(&self.version).unwrap_or("unknown"),
            self.pid,
            self.started
        );
        let host = &self.host;
        let boot_epoch = host.boot_epoch.map(|epoch| epoch.to_string());
        for (key, value) in [
            ("boot", host.boot.as_deref()),
            ("boot_epoch", boot_epoch.as_deref()),
            ("login", host.login.as_deref()),
            ("wayland", host.wayland.as_deref()),
            ("x11", host.x11.as_deref()),
        ] {
            if let Some(value) = value.and_then(clean_value) {
                text.push_str(&format!("{key}={value}\n"));
            }
        }
        text
    }

    /// `None` for anything this version did not write in this format.
    pub(crate) fn decode(text: &str) -> Option<Self> {
        let mut lines = text.lines();
        if lines.next()? != MAGIC {
            return None;
        }
        let (mut version, mut pid, mut started) = (None, None, None);
        let mut host = HostSession::default();
        for line in lines {
            let (key, value) = line.split_once('=')?;
            let value = clean_value(value)?.to_owned();
            match key {
                "version" => version = Some(value),
                "pid" => pid = Some(value.parse().ok()?),
                "started" => started = Some(value.parse().ok()?),
                "boot" => host.boot = Some(value),
                "boot_epoch" => host.boot_epoch = Some(value.parse().ok()?),
                "login" => host.login = Some(value),
                "wayland" => host.wayland = Some(value),
                "x11" => host.x11 = Some(value),
                _ => return None,
            }
        }
        Some(Self {
            version: version?,
            pid: pid?,
            started: started?,
            host,
        })
    }
}

/// What a surviving marker means.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Verdict {
    /// Its owner is still running (a concurrent instance): leave it alone.
    OwnerAlive,
    /// Unreadable, or written in another format: not ours to judge.
    Unrecognized,
    /// Written by another app version: an update replaced the binary, and a
    /// report would describe a build the reporter no longer runs.
    OtherVersion,
    /// The machine restarted, the user logged out or the display server
    /// restarted since: the OS may have ended the app without a signal.
    HostSessionEnded,
    /// A crash file from that session already explains the exit.
    CoveredByCrashReport,
    /// The session ended without an orderly exit: report it.
    Unclean,
}

/// What a launch observed about one surviving marker.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Observation {
    /// `None` when unreadable or not in this format.
    pub record: Option<SessionRecord>,
    pub owner_alive: bool,
}

/// Decide what a surviving marker means. `crash_report_since` answers
/// whether an unconsumed crash file was written at or after a time.
pub(crate) fn classify(
    observation: &Observation,
    current_version: &str,
    current_host: &HostSession,
    crash_report_since: impl FnOnce(u64) -> bool,
) -> Verdict {
    if observation.owner_alive {
        return Verdict::OwnerAlive;
    }
    let Some(record) = &observation.record else {
        return Verdict::Unrecognized;
    };
    if record.version != current_version {
        return Verdict::OtherVersion;
    }
    if !record.host.continues(current_host) {
        return Verdict::HostSessionEnded;
    }
    if crash_report_since(record.started) {
        return Verdict::CoveredByCrashReport;
    }
    Verdict::Unclean
}

fn open_shared(path: &Path) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_SHARE_READ: u32 = 0x1;
        const FILE_SHARE_WRITE: u32 = 0x2;
        const FILE_SHARE_DELETE: u32 = 0x4;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        // The claimant deletes the marker while holding it open.
        options
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    options.open(path)
}

fn name_matches(path: &Path, prefix: &str, suffix: &str) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with(prefix) && name.ends_with(suffix))
}

/// This process's marker. Dropping it without `disarm` releases the lock and
/// leaves the file behind, exactly as a crash would.
#[derive(Debug)]
pub(crate) struct ArmedMarker {
    file: File,
    path: PathBuf,
}

impl ArmedMarker {
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    /// Orderly exit: remove the marker, then release the lock.
    pub(crate) fn disarm(self) -> std::io::Result<()> {
        let removed = std::fs::remove_file(&self.path);
        let _ = self.file.unlock();
        removed
    }

    /// A crash, for in-process tests: release the lock, keep the file. Not a
    /// plain drop, because a test child forked meanwhile (other tests spawn
    /// processes) shares the descriptor, and so the lock, until it execs.
    #[cfg(test)]
    pub(crate) fn abandon(self) {
        let _ = self.file.unlock();
    }
}

/// The markers of one profile's log directory.
pub(crate) struct Sessions {
    dir: PathBuf,
}

impl Sessions {
    pub(crate) fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    /// Write and lock this process's marker. Staged under a name `observe`
    /// ignores and locked before it is published, so no launch can see an
    /// unlocked marker of a live process.
    pub(crate) fn arm(&self, record: &SessionRecord) -> std::io::Result<ArmedMarker> {
        std::fs::create_dir_all(&self.dir)?;
        // tempfile opens close-on-exec (children never inherit the lock) and,
        // on Windows, shares delete access so a claimant can remove it.
        let mut staged = tempfile::Builder::new()
            .prefix(STAGING_PREFIX)
            .suffix(STAGING_SUFFIX)
            .tempfile_in(&self.dir)?;
        staged.as_file().try_lock().map_err(std::io::Error::from)?;
        staged.write_all(record.encode().as_bytes())?;
        staged.flush()?;
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let path = self.dir.join(format!(
            "{MARKER_PREFIX}{}-{nanos}{MARKER_SUFFIX}",
            record.pid
        ));
        let file = staged.persist_noclobber(&path).map_err(|e| e.error)?;
        Ok(ArmedMarker { file, path })
    }

    /// Every marker other than `own`. A marker whose lock can be taken has
    /// lost its owner: it is read and removed here, so exactly one launch
    /// observes it. Markers that cannot be removed are skipped, never
    /// reported, so a stuck file cannot repeat a report on every launch.
    pub(crate) fn observe(&self, own: Option<&Path>) -> Vec<Observation> {
        let Ok(entries) = std::fs::read_dir(&self.dir) else {
            return Vec::new(); // No sessions directory: the first launch.
        };
        let mut observations = Vec::new();
        for path in entries.flatten().map(|entry| entry.path()) {
            if Some(path.as_path()) == own {
                continue;
            }
            let staging = name_matches(&path, STAGING_PREFIX, STAGING_SUFFIX);
            if !staging && !name_matches(&path, MARKER_PREFIX, MARKER_SUFFIX) {
                continue;
            }
            let Ok(file) = open_shared(&path) else {
                continue;
            };
            if !file.metadata().is_ok_and(|m| m.is_file()) {
                continue;
            }
            match file.try_lock() {
                Ok(()) => {}
                Err(TryLockError::WouldBlock) => {
                    if !staging {
                        observations.push(Observation {
                            record: None,
                            owner_alive: true,
                        });
                    }
                    continue;
                }
                Err(TryLockError::Error(error)) => {
                    log::warn!("Session marker lock failed: {error}");
                    continue;
                }
            }
            let mut text = String::new();
            let read = (&file).take(MAX_RECORD + 1).read_to_string(&mut text);
            if let Err(error) = std::fs::remove_file(&path) {
                log::warn!("Could not remove an ended session marker: {error}");
                continue;
            }
            drop(file);
            // A staging file never published: its process died while arming.
            if staging {
                continue;
            }
            let record = read
                .ok()
                .filter(|_| text.len() as u64 <= MAX_RECORD)
                .and_then(|_| SessionRecord::decode(&text));
            observations.push(Observation {
                record,
                owner_alive: false,
            });
        }
        observations
    }
}

/// Where the markers and crash files live, and what the current launch is.
pub(crate) struct Review<'a> {
    pub sessions: &'a Sessions,
    pub crash_dir: &'a Path,
    pub own: Option<&'a Path>,
    pub version: &'a str,
    pub host: &'a HostSession,
}

/// Claim every ended session and publish one crash file for the newest
/// unclean one (the crash notice offers only the newest file anyway).
/// Returns the published file.
pub(crate) fn review_ended_sessions(
    review: &Review<'_>,
    now: u64,
    environment: impl FnOnce() -> String,
) -> Option<PathBuf> {
    let mut newest_unclean: Option<SessionRecord> = None;
    for observation in review.sessions.observe(review.own) {
        let verdict = classify(&observation, review.version, review.host, |since| {
            crate::crash_report::unseen_report_since(review.crash_dir, since)
        });
        if verdict != Verdict::OwnerAlive {
            log::info!("Session(marker): verdict={verdict:?}");
        }
        if verdict != Verdict::Unclean {
            continue;
        }
        let Some(record) = observation.record else {
            continue;
        };
        if newest_unclean
            .as_ref()
            .is_none_or(|newest| record.started > newest.started)
        {
            newest_unclean = Some(record);
        }
    }
    let record = newest_unclean?;
    let report = crate::crash_report::unclean_exit_report(
        &record.version,
        &environment(),
        now,
        record.started,
    );
    match crate::crash_report::publish_report(review.crash_dir, now, report.as_bytes()) {
        Ok(path) => {
            log::warn!("Session(marker): the previous session did not exit cleanly");
            Some(path)
        }
        Err(error) => {
            log::warn!("Could not record an unclean exit: {error}");
            None
        }
    }
}

// --- Process-wide state: the main process's own marker -------------------

enum Phase {
    Idle,
    Armed(ArmedMarker),
    Disarmed,
}

static PHASE: Mutex<Phase> = Mutex::new(Phase::Idle);

#[derive(Clone, Copy, PartialEq, Eq)]
enum ReviewState {
    NotStarted,
    Running,
    Done,
}

static REVIEW: (Mutex<ReviewState>, Condvar) =
    (Mutex::new(ReviewState::NotStarted), Condvar::new());

fn set_review(state: ReviewState) {
    let (lock, ready) = &REVIEW;
    *lock.lock().unwrap_or_else(|p| p.into_inner()) = state;
    ready.notify_all();
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Arm this process's marker, then review ended sessions, off the setup
/// thread. Main app process only: never portal, hand-off or CLI processes.
pub(crate) fn start(log_dir: PathBuf) {
    set_review(ReviewState::Running);
    let spawned = std::thread::Builder::new()
        .name("session-marker".into())
        .spawn(move || {
            let sessions = Sessions::new(log_dir.join("sessions"));
            let record = SessionRecord::current(now_secs());
            let own = {
                let mut phase = PHASE.lock().unwrap_or_else(|p| p.into_inner());
                // An exit that began before this thread ran stays disarmed.
                if matches!(*phase, Phase::Idle) {
                    match sessions.arm(&record) {
                        Ok(marker) => {
                            let own = marker.path().to_path_buf();
                            *phase = Phase::Armed(marker);
                            Some(own)
                        }
                        Err(error) => {
                            log::warn!("Could not write the session marker: {error}");
                            None
                        }
                    }
                } else {
                    None
                }
            };
            let crash_dir = log_dir.join("crashes");
            review_ended_sessions(
                &Review {
                    sessions: &sessions,
                    crash_dir: &crash_dir,
                    own: own.as_deref(),
                    version: &record.version,
                    host: &record.host,
                },
                now_secs(),
                || crate::environment::render_crash_lines(crate::environment::summary()),
            );
            set_review(ReviewState::Done);
        });
    if let Err(error) = spawned {
        log::warn!("Session marker thread failed to start: {error}");
        set_review(ReviewState::Done);
    }
}

/// Orderly exit: remove this process's marker. Idempotent, and a no-op in
/// processes that never armed one.
pub(crate) fn disarm() {
    let mut phase = PHASE.lock().unwrap_or_else(|p| p.into_inner());
    if let Phase::Armed(marker) = std::mem::replace(&mut *phase, Phase::Disarmed) {
        if let Err(error) = marker.disarm() {
            log::warn!("Could not remove the session marker: {error}");
        }
    }
}

/// Wait (bounded) for the startup review, so the crash notice sees an unclean
/// exit it publishes. Returns at once when no review was started.
pub(crate) fn await_review(timeout: Duration) {
    let (lock, ready) = &REVIEW;
    let state = lock.lock().unwrap_or_else(|p| p.into_inner());
    let _ = ready.wait_timeout_while(state, timeout, |state| *state == ReviewState::Running);
}

// --- Host session identity ------------------------------------------------

#[cfg(target_os = "linux")]
mod host {
    use super::HostSession;
    use std::os::unix::fs::MetadataExt;
    use std::path::{Path, PathBuf};

    fn read_trimmed(path: &str) -> Option<String> {
        let text = std::fs::read_to_string(path).ok()?;
        let text = text.trim();
        (!text.is_empty()).then(|| text.to_owned())
    }

    fn socket_identity(path: &Path) -> Option<String> {
        let meta = std::fs::metadata(path).ok()?;
        Some(format!(
            "{}:{}:{}.{}",
            meta.dev(),
            meta.ino(),
            meta.ctime(),
            meta.ctime_nsec()
        ))
    }

    /// `:0`, `:0.0` and `unix:0` name a local socket; `host:0` does not.
    pub(crate) fn x11_display_number(display: &str) -> Option<u32> {
        let (host, rest) = display.split_once(':')?;
        if !(host.is_empty() || host == "unix") {
            return None;
        }
        rest.split('.').next()?.parse().ok()
    }

    fn wayland_socket() -> Option<PathBuf> {
        let name = std::env::var_os("WAYLAND_DISPLAY").filter(|name| !name.is_empty())?;
        let name = PathBuf::from(name);
        if name.is_absolute() {
            return Some(name);
        }
        Some(PathBuf::from(std::env::var_os("XDG_RUNTIME_DIR")?).join(name))
    }

    pub(super) fn current() -> HostSession {
        // 4294967295 is the audit "unset" session.
        let login = read_trimmed("/proc/self/sessionid").filter(|id| id != "4294967295");
        let x11 = std::env::var("DISPLAY")
            .ok()
            .and_then(|display| x11_display_number(&display))
            .and_then(|n| socket_identity(&PathBuf::from(format!("/tmp/.X11-unix/X{n}"))));
        HostSession {
            boot: read_trimmed("/proc/sys/kernel/random/boot_id"),
            boot_epoch: None,
            login,
            wayland: wayland_socket().and_then(|path| socket_identity(&path)),
            x11,
        }
    }
}

#[cfg(target_os = "macos")]
mod host {
    use super::HostSession;

    /// Logout ends the app through its ordinary quit path on macOS, so the
    /// boot time is the only host identity needed.
    pub(super) fn current() -> HostSession {
        let mut mib = [libc::CTL_KERN, libc::KERN_BOOTTIME];
        let mut boot: libc::timeval = unsafe { std::mem::zeroed() };
        let mut size = std::mem::size_of::<libc::timeval>();
        let read = unsafe {
            libc::sysctl(
                mib.as_mut_ptr(),
                2,
                (&mut boot as *mut libc::timeval).cast(),
                &mut size,
                std::ptr::null_mut(),
                0,
            )
        };
        HostSession {
            boot: (read == 0).then(|| format!("{}.{}", boot.tv_sec, boot.tv_usec)),
            ..HostSession::default()
        }
    }
}

#[cfg(windows)]
mod host {
    use super::HostSession;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::Security::{
        GetTokenInformation, TokenStatistics, TOKEN_QUERY, TOKEN_STATISTICS,
    };
    use windows_sys::Win32::System::SystemInformation::GetTickCount64;
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    /// The logon session: logoff ends it (tao surfaces no end-session
    /// message), and Fast Startup's "shutdown" logs off without a reboot.
    fn logon_session() -> Option<String> {
        let mut token: HANDLE = std::ptr::null_mut();
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
            return None;
        }
        let mut stats: TOKEN_STATISTICS = unsafe { std::mem::zeroed() };
        let mut length = 0u32;
        let read = unsafe {
            GetTokenInformation(
                token,
                TokenStatistics,
                (&mut stats as *mut TOKEN_STATISTICS).cast(),
                std::mem::size_of::<TOKEN_STATISTICS>() as u32,
                &mut length,
            )
        };
        unsafe { CloseHandle(token) };
        (read != 0).then(|| {
            format!(
                "{:08x}{:08x}",
                stats.AuthenticationId.HighPart as u32, stats.AuthenticationId.LowPart
            )
        })
    }

    pub(super) fn current() -> HostSession {
        let uptime_secs = (unsafe { GetTickCount64() } / 1000) as i64;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .ok();
        HostSession {
            boot_epoch: now.map(|now| now - uptime_secs),
            login: logon_session(),
            ..HostSession::default()
        }
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
mod host {
    use super::HostSession;

    pub(super) fn current() -> HostSession {
        HostSession::default()
    }
}

#[cfg(test)]
#[path = "../test_support/session_marker_test.rs"]
mod tests;
