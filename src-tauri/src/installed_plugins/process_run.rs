//! `host.process.run`: request validation, admission and execution, and the
//! typed codes that let a plugin tell "never ran" from "may have run".
//! Contract: docs/shared-ai-services-contracts.md, "Owned processes".
use crate::{
    error::{AppError, ProcessRunError},
    plugin_job::JobControl,
    process_ext::NoConsole,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    process::{Command, Output, Stdio},
    sync::Arc,
};

/// Largest `stdin`, in UTF-8 bytes. An image prompt with its framing is a few
/// KiB; this bound keeps the whole request well inside the 1 MiB plugin frame.
pub(super) const STDIN_MAX_BYTES: usize = 256 * 1024;
const MAX_RUNNING: usize = 4;
const MAX_SPOOLS: usize = 8;
const CANCELLED: &str = "Plugin process cancelled";

/// Advertised in `initialize` as `processStdin`. Plugins detect stdin support
/// by this capability, never by host version.
pub(super) fn stdin_capability() -> Value {
    json!({"version":1,"maxBytes":STDIN_MAX_BYTES})
}

/// Wire codes for `host.process.run` errors (`error.data.code`). Every code
/// except `INTERRUPTED` and `PROTOCOL_ERROR` proves the program never ran.
pub(super) mod code {
    /// Malformed request, unknown field, or a limit (including stdin) exceeded.
    pub(crate) const INVALID_REQUEST: &str = "invalid_request";
    /// The plugin's concurrent process or retained output limit is in use.
    pub(crate) const CAPACITY_REACHED: &str = "capacity_reached";
    /// The executable or working directory does not exist.
    pub(crate) const NOT_FOUND: &str = "not_found";
    /// The executable or working directory is not accessible.
    pub(crate) const PERMISSION_DENIED: &str = "permission_denied";
    /// Any other refusal or failure before the program executed: inactive
    /// plugin, lifecycle change, shutdown, call admission, supervision setup,
    /// worker start, cancellation before spawn, or another spawn error.
    pub(crate) const NOT_STARTED: &str = "not_started";
    /// The program was spawned; its effects are unknown.
    pub(crate) const INTERRUPTED: &str = "interrupted";
    /// The request reused the ID of a running process. Its reply would reach
    /// that process's waiter, so it must not claim that nothing ran.
    pub(crate) const PROTOCOL_ERROR: &str = "protocol_error";
}

pub(super) fn refusal(code: &str, message: &str) -> AppError {
    AppError::Service {
        code: code.into(),
        message: message.into(),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ProcessRequest {
    program: String,
    args: Vec<String>,
    cwd: Option<PathBuf>,
    env: Vec<(String, Option<String>)>,
    stdout_limit: usize,
    stderr_limit: usize,
    /// Written to the child's stdin, which is then closed. Absent or null
    /// means stdin is null.
    #[serde(default)]
    stdin: Option<String>,
}

/// Validate a request before any admission or process work.
pub(super) fn parse(params: &Value) -> Result<ProcessRequest, AppError> {
    let request: ProcessRequest = serde_json::from_value(params.clone())
        .map_err(|_| refusal(code::INVALID_REQUEST, "Invalid host process request"))?;
    if !PathBuf::from(&request.program).is_absolute()
        || request.args.len() > 128
        || request.env.len() > 128
        || request.args.iter().any(|arg| arg.len() > 64 * 1024)
        || request.stdout_limit > 16 * 1024 * 1024
        || request.stderr_limit > 1024 * 1024
        || request
            .stdin
            .as_ref()
            .is_some_and(|stdin| stdin.len() > STDIN_MAX_BYTES)
    {
        return Err(refusal(
            code::INVALID_REQUEST,
            "Host process request exceeds its limits",
        ));
    }
    Ok(request)
}

/// Register a process under the broker's maps; the caller holds both locks.
/// A refusal leaves both maps unchanged.
pub(super) fn admit(
    controls: &mut HashMap<String, JobControl>,
    spools: &mut HashMap<String, Arc<tempfile::TempDir>>,
    alive: bool,
    id: &str,
    control: &JobControl,
    spool: &Arc<tempfile::TempDir>,
) -> Result<(), AppError> {
    if controls.contains_key(id) {
        return Err(refusal(
            code::PROTOCOL_ERROR,
            "Plugin process request ID is already running",
        ));
    }
    if !alive {
        return Err(refusal(code::NOT_STARTED, "Plugin backend is stopping"));
    }
    if controls.len() >= MAX_RUNNING {
        return Err(refusal(
            code::CAPACITY_REACHED,
            "Plugin process capacity reached",
        ));
    }
    if spools.len() >= MAX_SPOOLS {
        return Err(refusal(
            code::CAPACITY_REACHED,
            "Plugin output spool capacity reached",
        ));
    }
    spools.insert(id.to_owned(), spool.clone());
    controls.insert(id.to_owned(), control.clone());
    Ok(())
}

/// Run an admitted request. `supervised` selects the SDK 3 Unix
/// parent-death-safe process group; elsewhere the owned tree of `process_ext`.
pub(super) fn execute(
    request: ProcessRequest,
    cancelled: impl Fn() -> bool,
    supervised: bool,
) -> Result<Output, ProcessRunError> {
    let mut command = Command::new(&request.program);
    command.no_console().args(&request.args);
    if let Some(cwd) = &request.cwd {
        command.current_dir(cwd);
    }
    for (key, value) in &request.env {
        if let Some(value) = value {
            command.env(key, value);
        } else {
            command.env_remove(key);
        }
    }
    command.stdin(Stdio::null());
    let limits = (request.stdout_limit, request.stderr_limit);
    let input = request.stdin.map(String::into_bytes);
    #[cfg(unix)]
    if supervised {
        return crate::process_supervisor::run(&mut command, cancelled, limits, CANCELLED, input);
    }
    let _ = supervised;
    crate::process_ext::output_with_input(&mut command, cancelled, limits, CANCELLED, input)
}

/// The wire code for a failed run: typed when nothing ran, else interrupted.
pub(super) fn failure_code(failure: &ProcessRunError) -> &'static str {
    match failure {
        ProcessRunError::NotStarted(AppError::NotFound(_)) => code::NOT_FOUND,
        ProcessRunError::NotStarted(AppError::PermissionDenied(_)) => code::PERMISSION_DENIED,
        ProcessRunError::NotStarted(_) => code::NOT_STARTED,
        ProcessRunError::Started(_) => code::INTERRUPTED,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        path::Path,
        sync::mpsc,
        time::{Duration, Instant},
    };

    fn request(program: &str, args: &[&str], stdin: Option<String>) -> Value {
        json!({"program":program,"args":args,"cwd":null,"env":[],"stdoutLimit":1024*1024,"stderrLimit":1024,"stdin":stdin})
    }
    fn code_of(error: AppError) -> String {
        error.service_code().to_owned()
    }
    /// Runs the broker's own composition: validation, then execution.
    fn run(params: Value, cancelled: impl Fn() -> bool) -> Result<Output, String> {
        let request = parse(&params).map_err(code_of)?;
        execute(request, cancelled, false).map_err(|failure| failure_code(&failure).to_owned())
    }
    /// A deadlock must fail the test, not hang it.
    fn within<T: Send + 'static>(limit: Duration, work: impl FnOnce() -> T + Send + 'static) -> T {
        let (send, receive) = mpsc::channel();
        std::thread::spawn(move || {
            let _ = send.send(work());
        });
        receive
            .recv_timeout(limit)
            .expect("owned process run did not return before its watchdog")
    }
    #[cfg(unix)]
    fn shell(script: &str) -> Value {
        request("/bin/sh", &["-c", script], None)
    }
    #[cfg(unix)]
    fn quoted(path: &Path) -> String {
        format!("'{}'", path.display().to_string().replace('\'', "'\\''"))
    }

    #[test]
    fn stdin_is_bounded_in_utf8_bytes_before_anything_runs() {
        let directory = tempfile::tempdir().unwrap();
        let marker = directory.path().join("ran");
        let program = std::env::current_exe().unwrap();
        let program = program.to_str().unwrap();
        let exact = "x".repeat(STDIN_MAX_BYTES);
        assert!(parse(&request(program, &[], Some(exact))).is_ok());
        // Two-byte scalars: fewer characters than the bound, more bytes.
        let multibyte = "é".repeat(STDIN_MAX_BYTES / 2 + 1);
        assert!(multibyte.chars().count() < STDIN_MAX_BYTES);
        #[cfg(unix)]
        let over = {
            let mut over = shell(&format!(": > {}", quoted(&marker)));
            over["stdin"] = json!(multibyte);
            over
        };
        #[cfg(windows)]
        let over = request(
            "C:\\Windows\\System32\\cmd.exe",
            &["/C", &format!("type nul > \"{}\"", marker.display())],
            Some(multibyte),
        );
        assert_eq!(run(over, || false).unwrap_err(), "invalid_request");
        assert!(!marker.exists(), "an over-bound request started a process");
        let mut unknown = request(program, &[], None);
        unknown["stdinFile"] = json!("/etc/passwd");
        assert_eq!(code_of(parse(&unknown).err().unwrap()), "invalid_request");
        assert_eq!(
            code_of(parse(&request("relative", &[], None)).err().unwrap()),
            "invalid_request"
        );
        assert!(parse(&request(program, &[], None)).is_ok());
    }

    #[test]
    fn spawn_refusals_are_typed_and_run_nothing() {
        let directory = tempfile::tempdir().unwrap();
        let missing = directory.path().join("missing-executable");
        assert_eq!(
            run(request(missing.to_str().unwrap(), &[], None), || false).unwrap_err(),
            "not_found"
        );
        let marker = directory.path().join("ran");
        #[cfg(unix)]
        let marking = shell(&format!(": > {}", quoted(&marker)));
        #[cfg(windows)]
        let marking = request(
            "C:\\Windows\\System32\\cmd.exe",
            &["/C", &format!("type nul > \"{}\"", marker.display())],
            None,
        );
        assert_eq!(run(marking, || true).unwrap_err(), "not_started");
        assert!(!marker.exists(), "a cancelled admission started a process");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let script = directory.path().join("not-executable");
            std::fs::write(&script, format!("#!/bin/sh\n: > {}\n", quoted(&marker))).unwrap();
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o600)).unwrap();
            assert_eq!(
                run(request(script.to_str().unwrap(), &[], None), || false).unwrap_err(),
                "permission_denied"
            );
            assert!(!marker.exists());
        }
    }

    #[cfg(unix)]
    #[test]
    fn failures_after_spawn_are_interrupted() {
        let directory = tempfile::tempdir().unwrap();
        let marker = directory.path().join("ran");
        let started = Instant::now();
        let failure = run(
            shell(&format!(": > {}; exec sleep 30", quoted(&marker))),
            move || started.elapsed() > Duration::from_millis(300),
        )
        .unwrap_err();
        assert_eq!(failure, "interrupted");
        assert!(marker.exists(), "fixture never ran");
        let mut flood = shell("while :; do printf xxxxxxxxxxxxxxxx; done");
        flood["stdoutLimit"] = json!(64);
        assert_eq!(run(flood, || false).unwrap_err(), "interrupted");
    }

    #[test]
    fn stdin_reaches_the_child_byte_for_byte_and_is_closed() {
        // Non-ASCII, newline-bearing input larger than an OS pipe buffer.
        let input: String = (0..STDIN_MAX_BYTES * 4 / 7)
            .map(|n| ['a', 'é', '\n', '漢'][n % 4])
            .collect();
        assert!(input.len() <= STDIN_MAX_BYTES && input.len() > 128 * 1024);
        #[cfg(unix)]
        let echo = request("/bin/sh", &["-c", "cat"], Some(input.clone()));
        #[cfg(windows)]
        let echo = request(
            "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
            &[
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "$i=[Console]::OpenStandardInput();$o=[Console]::OpenStandardOutput();$i.CopyTo($o);$o.Flush()",
            ],
            Some(input.clone()),
        );
        // `cat` only exits after EOF, so a returned result also proves closure.
        let output = within(Duration::from_secs(20), move || run(echo, || false)).unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout, input.into_bytes());
    }

    #[test]
    fn a_child_that_never_reads_large_stdin_is_reaped_on_deadline() {
        let directory = tempfile::tempdir().unwrap();
        let pid = directory.path().join("pid");
        #[cfg(unix)]
        let mut idle = shell(&format!("echo $$ > {}; exec sleep 30", quoted(&pid)));
        #[cfg(windows)]
        let mut idle = request(
            "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
            &[
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                &format!(
                    "Set-Content -LiteralPath '{}' -Value $PID; Start-Sleep -Seconds 30",
                    pid.display()
                ),
            ],
            None,
        );
        idle["stdin"] = json!("x".repeat(STDIN_MAX_BYTES));
        let observed = pid.clone();
        let started = Instant::now();
        // The deadline fires only once the child is running and blocking us.
        let failure = within(Duration::from_secs(20), move || {
            run(idle, move || {
                observed.exists() && started.elapsed() > Duration::from_millis(300)
            })
        })
        .unwrap_err();
        assert_eq!(failure, "interrupted");
        assert!(started.elapsed() < Duration::from_secs(10));
        #[cfg(unix)]
        {
            let pid: i32 = std::fs::read_to_string(&pid)
                .unwrap()
                .trim()
                .parse()
                .unwrap();
            // Reaped: the PID no longer names our child (not even a zombie).
            assert_eq!(
                unsafe { libc::kill(pid, 0) },
                -1,
                "child survived its deadline"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn unread_stdin_is_an_ordinary_outcome_for_exiting_or_flooding_children() {
        let mut exits = shell("printf done; exit 7");
        exits["stdin"] = json!("x".repeat(STDIN_MAX_BYTES));
        let output = within(Duration::from_secs(20), move || run(exits, || false)).unwrap();
        assert_eq!(output.status.code(), Some(7));
        assert_eq!(output.stdout, b"done");
        let mut flood = shell("head -c 400000 /dev/zero");
        flood["stdin"] = json!("x".repeat(STDIN_MAX_BYTES));
        let output = within(Duration::from_secs(20), move || run(flood, || false)).unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout.len(), 400000);
    }

    #[test]
    fn admission_refusals_are_typed_and_admit_nothing() {
        let spool = Arc::new(tempfile::tempdir().unwrap());
        let control = JobControl::new();
        let (mut controls, mut spools) = (HashMap::new(), HashMap::new());
        let attempt = |controls: &mut HashMap<String, JobControl>,
                       spools: &mut HashMap<String, Arc<tempfile::TempDir>>,
                       alive: bool,
                       id: &str| {
            let before = (controls.len(), spools.len());
            let result = admit(controls, spools, alive, id, &control, &spool);
            if result.is_err() {
                assert_eq!((controls.len(), spools.len()), before, "{id}");
            }
            result.map_err(code_of)
        };
        assert_eq!(
            attempt(&mut controls, &mut spools, false, "host:0").unwrap_err(),
            "not_started"
        );
        for n in 1..=MAX_RUNNING {
            attempt(&mut controls, &mut spools, true, &format!("host:{n}")).unwrap();
        }
        assert_eq!(
            attempt(&mut controls, &mut spools, true, "host:1").unwrap_err(),
            "protocol_error"
        );
        assert_eq!(
            attempt(&mut controls, &mut spools, true, "host:9").unwrap_err(),
            "capacity_reached"
        );
        // Finished runs keep their spools until released.
        controls.clear();
        for n in MAX_RUNNING + 1..=MAX_SPOOLS {
            attempt(&mut controls, &mut spools, true, &format!("host:{n}")).unwrap();
        }
        controls.clear();
        assert_eq!(
            attempt(&mut controls, &mut spools, true, "host:10").unwrap_err(),
            "capacity_reached"
        );
    }
}
