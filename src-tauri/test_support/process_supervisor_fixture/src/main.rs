//! Standalone test executable; compiles the exact production supervisor module.
mod error {
    #[derive(Debug)]
    pub enum AppError {
        Other(String),
        Io(std::io::Error),
    }
    impl From<std::io::Error> for AppError {
        fn from(value: std::io::Error) -> Self {
            Self::Io(value)
        }
    }
    #[derive(Debug)]
    pub enum ProcessRunError {
        NotStarted(AppError),
        Started(AppError),
    }
    impl ProcessRunError {
        pub fn into_error(self) -> AppError {
            match self {
                Self::NotStarted(error) | Self::Started(error) => error,
            }
        }
    }
    impl std::fmt::Display for AppError {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            match self {
                Self::Other(v) => write!(f, "{v}"),
                Self::Io(v) => write!(f, "{v}"),
            }
        }
    }
}
#[path = "../../../src/process_ext.rs"]
mod process_ext;
#[path = "../../../src/process_supervisor.rs"]
mod process_supervisor;
use std::{
    io::{Read, Write},
    process::{Command, Stdio},
    time::{Duration, Instant},
};
// A complete decoded 2x3 RGBA PNG, including its IEND and all CRCs.
const ORIGINAL_PNG: &[u8] = &[
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 2, 0, 0, 0, 3, 8, 6, 0,
    0, 0, 185, 234, 222, 129, 0, 0, 0, 17, 73, 68, 65, 84, 120, 156, 99, 16, 50, 9, 251, 15, 194,
    12, 24, 12, 0, 121, 107, 9, 163, 84, 185, 59, 165, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96,
    130,
];
fn main() {
    if let Some(code) = process_supervisor::early_mode() {
        std::process::exit(code)
    }
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.first().map(String::as_str) == Some("leaf") {
        leaf(&args[1..]);
        return;
    }
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .arg("leaf")
        .args(if args[0] == "reuse" {
            vec!["success".to_string()]
        } else {
            args.clone()
        })
        .env_clear()
        .env("FIXTURE_SENTINEL", "in-memory-only")
        .stdin(Stdio::null());
    if args[0] == "missing" {
        command = Command::new("/nonexistent/owned-process-fixture");
    }
    // Input larger than any OS pipe buffer, so an unread write must block.
    let input = args[0].starts_with("stdin-").then(|| {
        (0..1024 * 1024u32)
            .map(|n| (n.wrapping_mul(2_654_435_761) >> 24) as u8)
            .collect::<Vec<u8>>()
    });
    let expected = input.as_deref().map(digest);
    if args[0] == "preexec-hold" {
        use std::os::unix::process::CommandExt;
        let path = std::ffi::CString::new(args[1].clone()).unwrap();
        unsafe {
            command.pre_exec(move || {
                let fd = libc::open(
                    path.as_ptr(),
                    libc::O_WRONLY | libc::O_CREAT | libc::O_TRUNC,
                    0o600,
                );
                let pid = libc::getpid();
                libc::write(
                    fd,
                    (&pid as *const libc::pid_t).cast(),
                    std::mem::size_of_val(&pid),
                );
                libc::close(fd);
                loop {
                    libc::pause();
                }
            });
        }
    }
    // The owning plugin backend: its death must cancel and reap the CLI tree,
    // as the broker's liveness predicate does for host.process.run.
    let backend = (args[0] == "backend-death").then(|| {
        std::sync::Mutex::new(
            Command::new(std::env::current_exe().unwrap())
                .args(["leaf", "backend-hold", &format!("{}.backend", args[1])])
                .stdin(Stdio::null())
                .spawn()
                .unwrap(),
        )
    });
    let backend_dead = || {
        backend
            .as_ref()
            .is_some_and(|backend| !matches!(backend.lock().unwrap().try_wait(), Ok(None)))
    };
    let begin = Instant::now();
    #[cfg(target_os = "linux")]
    let polls = std::cell::Cell::new(0);
    let cancellation = || {
        #[cfg(target_os = "linux")]
        if args[0].starts_with("cancel-after-") {
            polls.set(polls.get() + 1);
            if polls.get() <= 2 {
                return false;
            }
            // Both pre-spawn checks passed. Pause the first supervision
            // poll until the original leaf has exited, without reaping it.
            let deadline = Instant::now() + Duration::from_secs(3);
            loop {
                if let Ok(pid) = std::fs::read_to_string(&args[1])
                    .and_then(|pid| pid.trim().parse::<i32>().map_err(std::io::Error::other))
                {
                    if std::fs::read_to_string(format!("/proc/{pid}/stat")).is_ok_and(|stat| {
                        stat.rsplit_once(')')
                            .unwrap()
                            .1
                            .trim_start()
                            .starts_with('Z')
                    }) {
                        let mut info = std::mem::MaybeUninit::<libc::siginfo_t>::zeroed();
                        assert_eq!(
                            unsafe {
                                libc::waitid(
                                    libc::P_PID,
                                    pid as libc::id_t,
                                    info.as_mut_ptr(),
                                    libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
                                )
                            },
                            0
                        );
                        let info = unsafe { info.assume_init() };
                        assert_eq!(info.si_code, libc::CLD_EXITED);
                        assert_eq!(
                            unsafe { info.si_status() },
                            if args[0] == "cancel-after-success" {
                                0
                            } else {
                                23
                            }
                        );
                        return true;
                    }
                }
                assert!(Instant::now() < deadline, "fixture leaf did not exit");
                std::thread::sleep(Duration::from_millis(1));
            }
        }
        (matches!(args[0].as_str(), "cancel" | "stdin-unread-cancel")
            && begin.elapsed() > Duration::from_millis(150))
            || backend_dead()
    };
    let result = if args[0].starts_with("fallback-") {
        process_ext::output_with_input(
            &mut command,
            cancellation,
            (65536, 65536),
            "fixture cancelled",
            input,
        )
    } else {
        process_supervisor::run(
            &mut command,
            cancellation,
            (65536, 65536),
            "fixture cancelled",
            input,
        )
    };
    if args[0] == "reuse" {
        let first = result.unwrap();
        let second = process_supervisor::run(
            &mut command,
            || false,
            (65536, 65536),
            "fixture cancelled",
            None,
        )
        .unwrap();
        assert!(first.status.success() && second.status.success());
        assert_eq!(first.stdout, second.stdout);
        assert_eq!(first.stderr, second.stderr);
        println!("reused-command-success");
        return;
    }
    match result {
        Ok(output) if args[0].ends_with("stderr-success") => {
            assert!(output.status.success());
            assert_eq!(output.stdout, ORIGINAL_PNG);
            assert_eq!(output.stderr.len(), 65536);
            assert!(output.stderr.starts_with(b"diagnostic-prefix"));
            assert!(output.stderr.ends_with(b"diagnostic-suffix"));
            assert!(String::from_utf8_lossy(&output.stderr).contains("[stderr truncated]"));
            println!(
                "exit-zero-stderr-overflow: original preserved; bounded prefix/suffix diagnostics"
            );
        }
        Ok(output) if args[0].ends_with("detached-output-exit") => {
            println!("status={}", output.status.code().unwrap_or(-1));
            println!("original-png-match={}", output.stdout == ORIGINAL_PNG);
            if args[0].contains("partial-") {
                println!(
                    "partial-capture-match={}",
                    output.stdout == ORIGINAL_PNG[..ORIGINAL_PNG.len() / 2]
                );
            }
            println!("stderr={}", String::from_utf8_lossy(&output.stderr));
        }
        Ok(output) if args[0] == "stdin-digest" => {
            println!("status={}", output.status.code().unwrap_or(-1));
            let echoed = String::from_utf8_lossy(&output.stdout);
            println!(
                "digest-match={}",
                Some(echoed.trim()) == expected.as_deref()
            );
        }
        Ok(output) => {
            println!("status={}", output.status.code().unwrap_or(-1));
            println!("stdout={}", String::from_utf8_lossy(&output.stdout));
            println!("stderr={}", String::from_utf8_lossy(&output.stderr));
        }
        Err(process_supervisor_error::NotStarted(error)) => {
            println!("not-started-error={error}");
            std::process::exit(2)
        }
        Err(process_supervisor_error::Started(error)) => {
            println!("started-error={error}");
            std::process::exit(2)
        }
    }
}
use error::ProcessRunError as process_supervisor_error;
/// FNV-1a over the bytes, with their length: echoed by the stdin leaf.
fn digest(bytes: &[u8]) -> String {
    let hash = bytes.iter().fold(0xcbf2_9ce4_8422_2325u64, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(0x0000_0100_0000_01b3)
    });
    format!("{}:{hash:016x}", bytes.len())
}
fn leaf(args: &[String]) {
    if args[0].ends_with("stderr-success") {
        std::io::stdout().write_all(ORIGINAL_PNG).unwrap();
        std::io::stderr().write_all(b"diagnostic-prefix").unwrap();
        std::io::stderr().write_all(&vec![b'x'; 200_000]).unwrap();
        std::io::stderr().write_all(b"diagnostic-suffix").unwrap();
        return;
    }
    match args[0].as_str() {
        "detached-output-exit"
        | "fallback-detached-output-exit"
        | "stderr-held-detached-output-exit"
        | "fallback-stderr-held-detached-output-exit"
        | "stdout-held-detached-output-exit"
        | "fallback-stdout-held-detached-output-exit"
        | "partial-detached-output-exit"
        | "fallback-partial-detached-output-exit" => unsafe {
            let (mut parent, mut peer) = std::os::unix::net::UnixStream::pair().unwrap();
            let child = libc::fork();
            assert!(child >= 0);
            if child == 0 {
                drop(parent);
                assert!(libc::setsid() > 0);
                if args[0].contains("stderr-held") {
                    libc::close(libc::STDOUT_FILENO);
                }
                if args[0].contains("stdout-held") {
                    libc::close(libc::STDERR_FILENO);
                }
                peer.write_all(&[1]).unwrap();
                drop(peer);
                // The detached helper never writes output; it only retains
                // inherited pipes after the original paid reply is complete.
                loop {
                    libc::pause();
                }
            }
            drop(peer);
            parent.read_exact(&mut [0]).unwrap();
            drop(parent);
            std::fs::write(&args[1], format!("{} {child} {child}", libc::getpid())).unwrap();
            let bytes = if args[0].contains("partial-") {
                &ORIGINAL_PNG[..ORIGINAL_PNG.len() / 2]
            } else {
                ORIGINAL_PNG
            };
            std::io::stdout().write_all(bytes).unwrap();
            std::io::stdout().flush().unwrap();
            std::io::stderr().write_all(b"completed-stderr").unwrap();
            std::io::stderr().flush().unwrap();
        },
        "cancel-after-success" | "cancel-after-nonzero" => {
            std::fs::write(&args[1], std::process::id().to_string()).unwrap();
            print!("completed-paid-output");
            eprint!("completed-stderr");
            std::process::exit(if args[0] == "cancel-after-success" {
                0
            } else {
                23
            });
        }
        "stdin-digest" => {
            let mut bytes = Vec::new();
            std::io::stdin().read_to_end(&mut bytes).unwrap();
            println!("{}", digest(&bytes));
        }
        "stdin-unread-exit" => {
            println!("exact-unread-exit");
            std::process::exit(5)
        }
        "success" => {
            println!(
                "exact-success:{}",
                std::env::var("FIXTURE_SENTINEL").unwrap()
            );
            eprintln!("exact-stderr");
        }
        "nonzero" => {
            println!("exact-nonzero");
            std::process::exit(23)
        }
        "backend-hold" => {
            std::fs::write(&args[1], std::process::id().to_string()).unwrap();
            loop {
                unsafe { libc::pause() };
            }
        }
        "large-success" => {
            std::io::stdout().write_all(&vec![b'x'; 65536]).unwrap();
        }
        mode => unsafe {
            let (mut input, mut output) = std::os::unix::net::UnixStream::pair().unwrap();
            let child = libc::fork();
            assert!(child >= 0);
            if child == 0 {
                drop(input);
                let grandchild = libc::fork();
                if grandchild == 0 {
                    loop {
                        libc::pause();
                    }
                }
                output.write_all(&grandchild.to_ne_bytes()).unwrap();
                drop(output);
                loop {
                    libc::pause();
                }
            }
            drop(output);
            let mut bytes = [0; 4];
            input.read_exact(&mut bytes).unwrap();
            drop(input);
            let grandchild = i32::from_ne_bytes(bytes);
            std::fs::write(&args[1], format!("{} {child} {grandchild}", libc::getpid())).unwrap();
            if mode == "early-exit" {
                println!("exact-early-success");
                return;
            }
            if mode == "overflow" || mode == "stdin-unread-overflow" {
                std::io::stdout().write_all(&vec![b'x'; 200_000]).unwrap();
            }
            if mode == "stderr-overflow" {
                std::io::stderr().write_all(&vec![b'x'; 200_000]).unwrap();
            }
            loop {
                libc::pause();
            }
        },
    }
}
