//! Who holds the plugin profile lease (#1433). `flock`/`LockFileEx` have no
//! portable owner query, so the owner writes a small record into the lease
//! file after taking the lock, and a refused process reads it back. The record
//! is advisory diagnostics only: writing it is best-effort and never affects
//! ownership, and any missing, garbled or stale record yields `None` so the
//! refusal falls back to the generic message.
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    path::PathBuf,
};

const MAGIC: &str = "tauri-explorer-plugin-profile-owner v1";
/// A record is a handful of short lines; anything larger is not ours.
const MAX_RECORD: u64 = 4096;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct OwnerRecord {
    pub pid: u32,
    /// Linux `/proc/<pid>/stat` start time in clock ticks since boot. Together
    /// with the PID it identifies one process incarnation despite PID reuse.
    pub start_ticks: Option<u64>,
    /// Wall-clock seconds since the Unix epoch when the lease was acquired.
    pub since: i64,
    pub executable: PathBuf,
}

impl OwnerRecord {
    pub(super) fn current() -> Self {
        let pid = std::process::id();
        Self {
            pid,
            start_ticks: start_ticks(pid),
            since: chrono::Utc::now().timestamp(),
            executable: std::env::current_exe().unwrap_or_default(),
        }
    }

    fn encode(&self) -> Option<String> {
        let executable = self.executable.to_str()?;
        if executable.contains(['\n', '\r']) {
            return None;
        }
        let mut text = format!("{MAGIC}\npid={}\n", self.pid);
        if let Some(ticks) = self.start_ticks {
            text.push_str(&format!("start_ticks={ticks}\n"));
        }
        text.push_str(&format!("since={}\nexe={executable}\n", self.since));
        Some(text)
    }

    fn decode(text: &str) -> Option<Self> {
        let mut lines = text.lines();
        if lines.next()? != MAGIC {
            return None;
        }
        let (mut pid, mut start_ticks, mut since, mut executable) = (None, None, None, None);
        for line in lines {
            let (key, value) = line.split_once('=')?;
            match key {
                "pid" => pid = Some(value.parse::<u32>().ok().filter(|pid| *pid != 0)?),
                "start_ticks" => start_ticks = Some(value.parse().ok()?),
                "since" => since = Some(value.parse().ok()?),
                "exe" if !value.is_empty() => executable = Some(PathBuf::from(value)),
                _ => return None,
            }
        }
        Some(Self {
            pid: pid?,
            start_ticks,
            since: since?,
            executable: executable?,
        })
    }

    /// "/usr/bin/tauri-explorer (PID 1234, owner since 2026-10-29 12:00:00)"
    pub(super) fn describe(&self) -> String {
        let since = chrono::DateTime::from_timestamp(self.since, 0)
            .map(|at| {
                at.with_timezone(&chrono::Local)
                    .format("%Y-%m-%d %H:%M:%S")
                    .to_string()
            })
            .unwrap_or_else(|| "an unknown time".into());
        format!(
            "{} (PID {}, owner since {since})",
            self.executable.display(),
            self.pid
        )
    }
}

/// Replace the lease file's contents with this process's record. The caller
/// holds the lock; failures only lose the diagnostic.
pub(super) fn write(mut file: &File, record: &OwnerRecord) {
    let Some(text) = record.encode() else {
        return;
    };
    let written = file
        .set_len(0)
        .and_then(|()| file.seek(SeekFrom::Start(0)))
        .and_then(|_| file.write_all(text.as_bytes()));
    if let Err(cause) = written {
        log::debug!("Could not record the plugin profile owner: {cause}");
    }
}

/// Best-effort clear on release, so a later reader cannot mistake a reused
/// PID for this process on platforms without a start-time identity check.
pub(super) fn clear(file: &File) {
    let _ = file.set_len(0);
}

/// Read the record a refused process found in the lease file and keep it only
/// if that process still appears to be alive.
pub(super) fn read_live(mut file: &File) -> Option<OwnerRecord> {
    let mut text = String::new();
    file.seek(SeekFrom::Start(0)).ok()?;
    file.take(MAX_RECORD).read_to_string(&mut text).ok()?;
    let record = OwnerRecord::decode(&text)?;
    alive(&record).then_some(record)
}

#[cfg(target_os = "linux")]
fn start_ticks(pid: u32) -> Option<u64> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // `comm` (field 2) is parenthesised and may contain spaces or ')'.
    let rest = &stat[stat.rfind(')')? + 1..];
    // Fields after `comm` start at 3 (state); starttime is field 22.
    rest.split_whitespace().nth(22 - 3)?.parse().ok()
}

#[cfg(not(target_os = "linux"))]
fn start_ticks(_pid: u32) -> Option<u64> {
    None
}

#[cfg(target_os = "linux")]
fn alive(record: &OwnerRecord) -> bool {
    // A missing /proc entry is a dead PID; a different start time is a reused one.
    match (start_ticks(record.pid), record.start_ticks) {
        (None, _) => false,
        (Some(now), Some(recorded)) => now == recorded,
        (Some(_), None) => true,
    }
}

#[cfg(all(unix, not(target_os = "linux")))]
fn alive(record: &OwnerRecord) -> bool {
    let Ok(pid) = libc::pid_t::try_from(record.pid) else {
        return false;
    };
    // Signal 0 probes existence only. EPERM still means the PID exists.
    unsafe { libc::kill(pid, 0) == 0 }
    || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// No identity check: Windows refuses reads of a byte range another handle
/// has locked, so a refused process normally cannot read the record at all.
#[cfg(not(unix))]
fn alive(_record: &OwnerRecord) -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::OpenOptions;

    fn lease() -> (tempfile::TempDir, File) {
        let dir = tempfile::tempdir().unwrap();
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(dir.path().join(".plugin-runtime.lock"))
            .unwrap();
        (dir, file)
    }

    #[test]
    fn a_live_owner_record_round_trips_through_the_lease_file() {
        let (dir, file) = lease();
        // A longer earlier record must not leave a trailing fragment.
        std::fs::write(
            dir.path().join(".plugin-runtime.lock"),
            "x".repeat(600).as_bytes(),
        )
        .unwrap();
        let record = OwnerRecord::current();
        write(&file, &record);
        assert_eq!(read_live(&file), Some(record.clone()));
        #[cfg(target_os = "linux")]
        assert!(record.start_ticks.is_some());
        let described = record.describe();
        assert!(described.contains(&format!("(PID {}, owner since ", std::process::id())));
        assert!(described.starts_with(&record.executable.display().to_string()));
    }

    #[test]
    fn garbled_missing_or_oversized_records_are_ignored() {
        let (dir, file) = lease();
        let path = dir.path().join(".plugin-runtime.lock");
        assert_eq!(read_live(&file), None);
        let pid = std::process::id();
        for text in [
            "not a record".to_string(),
            format!("{MAGIC}\npid={pid}\n"),
            format!("{MAGIC}\npid=abc\nsince=1\nexe=/bin/x\n"),
            format!("{MAGIC}\npid=0\nsince=1\nexe=/bin/x\n"),
            format!("{MAGIC}\npid={pid}\nsince=1\nexe=/bin/x\nextra=1\n"),
            format!(
                "{MAGIC}\npid={pid}\nsince=1\nexe=/bin/x\n{}",
                "y".repeat(5000)
            ),
        ] {
            std::fs::write(&path, text.as_bytes()).unwrap();
            assert_eq!(read_live(&file), None, "{text:.80}");
        }
    }

    #[test]
    fn a_record_naming_a_dead_process_is_stale() {
        let (_dir, file) = lease();
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .arg("--list")
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let pid = child.id();
        child.wait().unwrap();
        let record = OwnerRecord {
            pid,
            start_ticks: None,
            since: 0,
            executable: PathBuf::from("/opt/old/tauri-explorer"),
        };
        write(&file, &record);
        assert_eq!(read_live(&file), None);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_reused_pid_with_another_start_time_is_stale() {
        let (_dir, file) = lease();
        let mut record = OwnerRecord::current();
        record.start_ticks = record.start_ticks.map(|ticks| ticks + 1);
        write(&file, &record);
        assert_eq!(read_live(&file), None);
    }

    #[test]
    fn clearing_on_release_removes_the_record() {
        let (_dir, file) = lease();
        write(&file, &OwnerRecord::current());
        clear(&file);
        assert_eq!(read_live(&file), None);
    }
}
