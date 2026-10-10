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
    impl std::fmt::Display for AppError {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            match self {
                Self::Other(v) => write!(f, "{v}"),
                Self::Io(v) => write!(f, "{v}"),
            }
        }
    }
}
#[path = "../../../src/process_supervisor.rs"]
mod process_supervisor;
use std::{
    io::{Read, Write},
    process::{Command, Stdio},
    time::{Duration, Instant},
};
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
        backend.as_ref().is_some_and(|backend| {
            !matches!(backend.lock().unwrap().try_wait(), Ok(None))
        })
    };
    let begin = Instant::now();
    let result = process_supervisor::output_controlled(
        &mut command,
        || {
            (args[0] == "cancel" && begin.elapsed() > Duration::from_millis(150))
                || backend_dead()
        },
        (65536, 65536),
        "fixture cancelled",
    );
    if args[0] == "reuse" {
        let first = result.unwrap();
        let second = process_supervisor::output_controlled(
            &mut command,
            || false,
            (65536, 65536),
            "fixture cancelled",
        )
        .unwrap();
        assert!(first.status.success() && second.status.success());
        assert_eq!(first.stdout, second.stdout);
        assert_eq!(first.stderr, second.stderr);
        println!("reused-command-success");
        return;
    }
    match result {
        Ok(output) => {
            println!("status={}", output.status.code().unwrap_or(-1));
            println!("stdout={}", String::from_utf8_lossy(&output.stdout));
            println!("stderr={}", String::from_utf8_lossy(&output.stderr));
        }
        Err(error) => {
            println!("error={error}");
            std::process::exit(2)
        }
    }
}
fn leaf(args: &[String]) {
    match args[0].as_str() {
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
            if mode == "overflow" {
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
