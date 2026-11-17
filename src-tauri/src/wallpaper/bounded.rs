//! Bounded waits for the macOS wallpaper flow (#1731): work handed to
//! another executor (the main dispatch queue) and subprocesses. Both are
//! generic and pure enough to be tested on every host.

use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

/// Work queued on an executor that did not produce a result in time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HandOffError {
    /// The executor had not started the work by the start deadline. It never
    /// will: if it gets to the work later, it does nothing.
    NotStarted,
    /// The work started in time but had not finished after the extra grace
    /// period; it may still finish and take effect.
    StillRunning,
    /// The work ended without a result (it panicked or was dropped after
    /// starting).
    Lost,
}

const PENDING: u8 = 0;
const RUNNING: u8 = 1;
const ABANDONED: u8 = 2;

/// Run `work` through `submit` (which queues a job on some executor) and
/// wait for its result.
///
/// - If the job has not started within `start_within`, it is abandoned:
///   when the executor reaches it later it does nothing, and the caller
///   gets [`HandOffError::NotStarted`], so nothing changed.
/// - If it has started, its result is still awaited for up to `then_grace`,
///   because the work may already be taking effect: an error then would
///   misreport a change that happened.
///
/// The caller must not be the executor's own thread (it would wait on
/// itself); run the work inline there instead.
pub fn hand_off<T, S, W>(
    submit: S,
    work: W,
    start_within: Duration,
    then_grace: Duration,
) -> Result<T, HandOffError>
where
    T: Send + 'static,
    S: FnOnce(Box<dyn FnOnce() + Send>),
    W: FnOnce() -> T + Send + 'static,
{
    let (sender, receiver) = mpsc::sync_channel(1);
    let state = Arc::new(AtomicU8::new(PENDING));
    let job_state = Arc::clone(&state);
    submit(Box::new(move || {
        if job_state
            .compare_exchange(PENDING, RUNNING, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return;
        }
        let _ = sender.send(work());
    }));
    let first = receiver.recv_timeout(start_within);
    if let Ok(result) = first {
        return Ok(result);
    }
    let abandoned = state
        .compare_exchange(PENDING, ABANDONED, Ordering::AcqRel, Ordering::Acquire)
        .is_ok();
    if abandoned {
        return Err(HandOffError::NotStarted);
    }
    // It started: it either finished just now, or is still running.
    match first {
        Err(mpsc::RecvTimeoutError::Disconnected) => Err(HandOffError::Lost),
        _ => match receiver.recv_timeout(then_grace) {
            Ok(result) => Ok(result),
            Err(mpsc::RecvTimeoutError::Timeout) => Err(HandOffError::StillRunning),
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(HandOffError::Lost),
        },
    }
}

/// Run `program` with `args`, killing it if it has not exited within
/// `timeout`. Ok(stdout) on a zero exit; otherwise a reason naming the
/// program (its stderr, its exit, or the timeout).
pub fn run_command(program: &str, args: &[&str], timeout: Duration) -> Result<String, String> {
    let deadline = Instant::now() + timeout;
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("{program}: {e}"))?;
    // Drain both pipes on their own threads so a chatty child cannot block
    // on a full pipe while we wait for it.
    let drain = |pipe: Option<Box<dyn Read + Send>>| {
        let (tx, rx) = mpsc::channel();
        if let Some(mut pipe) = pipe {
            std::thread::spawn(move || {
                let mut bytes = Vec::new();
                let _ = pipe.read_to_end(&mut bytes);
                let _ = tx.send(bytes);
            });
        }
        rx
    };
    let stdout = drain(
        child
            .stdout
            .take()
            .map(|p| Box::new(p) as Box<dyn Read + Send>),
    );
    let stderr = drain(
        child
            .stderr
            .take()
            .map(|p| Box::new(p) as Box<dyn Read + Send>),
    );

    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "{program}: did not finish within {} s",
                    timeout.as_secs_f32()
                ));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("{program}: {e}"));
            }
        }
    };
    // The pipes close when the child exits; a grandchild holding them open
    // must not stretch the wait past the deadline.
    let collect = |rx: mpsc::Receiver<Vec<u8>>| {
        let left = deadline
            .saturating_duration_since(Instant::now())
            .max(Duration::from_millis(100));
        String::from_utf8_lossy(&rx.recv_timeout(left).unwrap_or_default()).into_owned()
    };
    let out = collect(stdout);
    let err = collect(stderr);
    if status.success() {
        Ok(out)
    } else if err.trim().is_empty() {
        Err(format!("{program}: exited with {status}"))
    } else {
        Err(format!("{program}: {}", err.trim()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;
    use std::sync::Mutex;

    const START: Duration = Duration::from_millis(200);
    const GRACE: Duration = Duration::from_millis(600);

    type Job = Box<dyn FnOnce() + Send>;

    /// An executor that runs each job on its own thread after `delay`.
    fn after(delay: Duration) -> impl FnOnce(Job) {
        move |job| {
            std::thread::spawn(move || {
                std::thread::sleep(delay);
                job();
            });
        }
    }

    #[test]
    fn work_run_on_time_returns_its_result() {
        assert_eq!(hand_off(|job: Job| job(), || 7, START, GRACE), Ok(7));
        assert_eq!(hand_off(after(Duration::ZERO), || 8, START, GRACE), Ok(8));
    }

    #[test]
    fn work_started_late_but_before_the_deadline_returns_its_result() {
        let started = Instant::now();
        let result = hand_off(after(START / 2), || "late", START, GRACE);
        assert_eq!(result, Ok("late"));
        assert!(started.elapsed() < START + GRACE);
    }

    #[test]
    fn work_that_starts_in_time_and_finishes_after_the_deadline_is_awaited() {
        let result = hand_off(
            after(Duration::from_millis(20)),
            || {
                std::thread::sleep(START + Duration::from_millis(150));
                "done"
            },
            START,
            GRACE,
        );
        assert_eq!(result, Ok("done"), "a change that happened is reported");
    }

    #[test]
    fn work_that_overruns_the_grace_period_is_still_running() {
        let started = Instant::now();
        let result = hand_off(
            after(Duration::ZERO),
            || std::thread::sleep(START + GRACE + Duration::from_millis(300)),
            START,
            GRACE,
        );
        assert_eq!(result, Err(HandOffError::StillRunning));
        assert!(started.elapsed() < START + GRACE + Duration::from_millis(250));
    }

    #[test]
    fn work_never_run_is_not_started_and_a_late_run_does_nothing() {
        let parked: Arc<Mutex<Option<Job>>> = Arc::default();
        let ran = Arc::new(AtomicBool::new(false));
        let slot = Arc::clone(&parked);
        let flag = Arc::clone(&ran);
        let started = Instant::now();
        let result = hand_off(
            move |job: Job| *slot.lock().unwrap() = Some(job),
            move || flag.store(true, Ordering::SeqCst),
            START,
            GRACE,
        );
        assert_eq!(result, Err(HandOffError::NotStarted));
        assert!(
            started.elapsed() < START + GRACE,
            "no grace when not started"
        );

        // The executor finally reaches the job after the caller gave up.
        let job = parked.lock().unwrap().take().unwrap();
        job();
        assert!(!ran.load(Ordering::SeqCst), "abandoned work must not run");
    }

    #[test]
    fn a_dropped_or_panicking_job_reports_no_result() {
        // Dropped unrun: it never started.
        assert_eq!(
            hand_off(|job: Job| drop(job), || 1, START, GRACE),
            Err(HandOffError::NotStarted)
        );
        // Started, then panicked.
        let result: Result<(), _> = hand_off(
            after(Duration::ZERO),
            || panic!("work failed"),
            START,
            GRACE,
        );
        assert_eq!(result, Err(HandOffError::Lost));
    }

    #[cfg(unix)]
    #[test]
    fn a_hung_command_is_killed_at_its_timeout() {
        let started = Instant::now();
        let err = run_command("sleep", &["30"], Duration::from_millis(300)).unwrap_err();
        assert!(err.contains("did not finish"), "{err}");
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "{:?}",
            started.elapsed()
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_hung_grandchild_holding_the_pipes_does_not_stretch_the_wait() {
        let started = Instant::now();
        // The shell exits at once; its background child keeps stdout open.
        let out = run_command(
            "sh",
            &["-c", "sleep 3 & echo ok"],
            Duration::from_millis(500),
        );
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "{:?}",
            started.elapsed()
        );
        assert!(out.is_ok(), "{out:?}");
    }

    #[cfg(unix)]
    #[test]
    fn command_output_and_failures_are_reported() {
        let ok = Duration::from_secs(10);
        assert_eq!(run_command("sh", &["-c", "echo hi"], ok), Ok("hi\n".into()));
        let err = run_command("sh", &["-c", "echo refused >&2; exit 3"], ok).unwrap_err();
        assert_eq!(err, "sh: refused");
        let err = run_command("sh", &["-c", "exit 4"], ok).unwrap_err();
        assert!(err.starts_with("sh: exited with"), "{err}");
        let big = run_command("sh", &["-c", "head -c 1000000 /dev/zero"], ok).unwrap();
        assert_eq!(big.len(), 1_000_000, "a full pipe does not deadlock");
        assert!(run_command("/nonexistent/program", &[], ok)
            .unwrap_err()
            .starts_with("/nonexistent/program:"));
    }
}
