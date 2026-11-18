use super::*;

const VERSION: &str = env!("CARGO_PKG_VERSION");

fn host() -> HostSession {
    HostSession {
        boot: Some("boot-a".into()),
        boot_epoch: None,
        login: Some("3".into()),
        wayland: Some("59:103:1.0".into()),
        x11: Some("66:7:1.0".into()),
    }
}

fn record(started: u64) -> SessionRecord {
    SessionRecord {
        version: VERSION.into(),
        pid: 4242,
        started,
        host: host(),
    }
}

fn dead(record: SessionRecord) -> Observation {
    Observation {
        record: Some(record),
        owner_alive: false,
    }
}

fn verdict(observation: &Observation, covered: bool) -> Verdict {
    classify(observation, VERSION, &host(), |_| covered)
}

struct Profile {
    _dir: tempfile::TempDir,
    sessions: Sessions,
    sessions_dir: PathBuf,
    crash_dir: PathBuf,
}

fn profile() -> Profile {
    let dir = tempfile::tempdir().unwrap();
    let sessions_dir = dir.path().join("sessions");
    Profile {
        sessions: Sessions::new(sessions_dir.clone()),
        sessions_dir,
        crash_dir: dir.path().join("crashes"),
        _dir: dir,
    }
}

impl Profile {
    fn review(&self, own: Option<&Path>, now: u64) -> Option<PathBuf> {
        review_ended_sessions(
            &Review {
                sessions: &self.sessions,
                crash_dir: &self.crash_dir,
                own,
                version: VERSION,
                host: &host(),
            },
            now,
            || "os: test".to_owned(),
        )
    }

    fn markers(&self) -> usize {
        std::fs::read_dir(&self.sessions_dir)
            .map(|entries| entries.count())
            .unwrap_or(0)
    }

    fn reports(&self) -> Vec<String> {
        std::fs::read_dir(&self.crash_dir)
            .map(|entries| {
                entries
                    .flatten()
                    .filter(|entry| entry.file_name().to_string_lossy().ends_with(".txt"))
                    .map(|entry| std::fs::read_to_string(entry.path()).unwrap())
                    .collect()
            })
            .unwrap_or_default()
    }
}

// --- classify: the decision alone ------------------------------------------

#[test]
fn a_dead_owner_of_this_version_in_the_same_host_session_is_unclean() {
    assert_eq!(verdict(&dead(record(100)), false), Verdict::Unclean);
}

#[test]
fn a_live_owner_is_a_concurrent_instance_whatever_its_record_says() {
    for record in [None, Some(record(100))] {
        let observation = Observation {
            record,
            owner_alive: true,
        };
        assert_eq!(verdict(&observation, false), Verdict::OwnerAlive);
    }
}

#[test]
fn an_unreadable_or_foreign_format_marker_is_never_reported() {
    let observation = Observation {
        record: None,
        owner_alive: false,
    };
    assert_eq!(verdict(&observation, false), Verdict::Unrecognized);
}

#[test]
fn a_marker_from_another_app_version_is_not_reported() {
    let mut older = record(100);
    older.version = "0.0.1".into();
    assert_eq!(verdict(&dead(older), false), Verdict::OtherVersion);
}

#[test]
fn a_crash_file_from_that_session_already_explains_the_exit() {
    let mut asked = None;
    let observation = dead(record(100));
    let result = classify(&observation, VERSION, &host(), |since| {
        asked = Some(since);
        true
    });
    assert_eq!(result, Verdict::CoveredByCrashReport);
    // Coverage is judged from the session's own start.
    assert_eq!(asked, Some(100));
}

#[test]
fn a_reboot_logout_or_display_restart_since_is_an_ended_host_session() {
    let changes: [fn(&mut HostSession); 4] = [
        |h| h.boot = Some("boot-b".into()),
        |h| h.login = Some("4".into()),
        |h| h.wayland = Some("59:999:2.0".into()),
        |h| h.x11 = Some("66:8:2.0".into()),
    ];
    for change in changes {
        let mut earlier = record(100);
        change(&mut earlier.host);
        assert_eq!(verdict(&dead(earlier), false), Verdict::HostSessionEnded);
    }
}

#[test]
fn host_parts_unknown_on_either_side_are_no_evidence() {
    let mut earlier = record(100);
    earlier.host = HostSession::default();
    assert_eq!(verdict(&dead(earlier), false), Verdict::Unclean);
    let now = HostSession {
        x11: None,
        ..host()
    };
    assert!(record(100).host.continues(&now));
}

#[test]
fn an_estimated_boot_time_tolerates_clock_adjustment_but_not_a_reboot() {
    let at = |epoch| HostSession {
        boot_epoch: Some(epoch),
        ..HostSession::default()
    };
    assert!(at(1_000_000).continues(&at(1_000_000 + BOOT_EPOCH_TOLERANCE_SECS)));
    assert!(at(1_000_000).continues(&at(1_000_000 - 3)));
    assert!(!at(1_000_000).continues(&at(1_000_000 + BOOT_EPOCH_TOLERANCE_SECS + 1)));
}

// --- the record ------------------------------------------------------------

#[test]
fn a_record_round_trips_and_omits_unknown_host_parts() {
    let full = record(1_700_000_000);
    assert_eq!(SessionRecord::decode(&full.encode()), Some(full));
    let bare = SessionRecord {
        host: HostSession {
            boot_epoch: Some(-5),
            ..HostSession::default()
        },
        ..record(1)
    };
    let text = bare.encode();
    assert!(!text.contains("login="));
    assert_eq!(SessionRecord::decode(&text), Some(bare));
}

#[test]
fn a_multi_line_value_cannot_inject_a_field() {
    let mut forged = record(100);
    forged.host.login = Some("3\nversion=0.0.1".into());
    let decoded = SessionRecord::decode(&forged.encode()).unwrap();
    assert_eq!(decoded.version, VERSION);
    assert_eq!(decoded.host.login, None);
}

#[test]
fn malformed_records_decode_to_nothing() {
    let valid = record(100).encode();
    for text in [
        String::new(),
        "not a marker".into(),
        valid.replacen(MAGIC, "tauri-explorer session v0", 1),
        valid.replace("started=100", "started=soon"),
        valid.replace("pid=4242\n", ""),
        format!("{valid}unknown=1\n"),
        format!("{valid}no separator\n"),
        valid.replace("login=3", "login="),
    ] {
        assert_eq!(SessionRecord::decode(&text), None, "{text:?}");
    }
}

// --- marker IO and the review ------------------------------------------------

#[test]
fn the_very_first_launch_has_nothing_to_review() {
    let profile = profile();
    assert_eq!(profile.review(None, 200), None);
    assert!(profile.reports().is_empty());
}

#[test]
fn an_orderly_exit_leaves_nothing_behind() {
    let profile = profile();
    let marker = profile.sessions.arm(&record(100)).unwrap();
    assert_eq!(profile.markers(), 1);
    marker.disarm().unwrap();
    assert_eq!(profile.markers(), 0);
    assert_eq!(profile.review(None, 200), None);
}

#[test]
fn a_session_that_died_is_reported_once_as_an_unclean_exit() {
    let profile = profile();
    // Released without disarming: the lock goes, the file stays, as in a crash.
    profile.sessions.arm(&record(100)).unwrap().abandon();

    let published = profile
        .review(None, 200)
        .expect("unclean exit not reported");
    let contents = std::fs::read_to_string(&published).unwrap();
    assert_eq!(
        crate::crash_report::crash_kind(&contents),
        crate::crash_report::CrashKind::UncleanExit
    );
    assert!(contents.contains("panic: Tauri Explorer did not exit cleanly"));
    assert!(contents.contains("session started: 100 (unix)"));
    assert!(contents.contains("os: test"));
    assert_eq!(profile.markers(), 0, "the claimed marker must be removed");

    // Claimed: the next launch does not report it again.
    assert_eq!(profile.review(None, 300), None);
    assert_eq!(profile.reports().len(), 1);
}

#[test]
fn a_running_instance_is_left_alone_until_it_dies() {
    let profile = profile();
    let running = profile.sessions.arm(&record(100)).unwrap();
    let mine = profile.sessions.arm(&record(150)).unwrap();

    assert_eq!(
        profile.sessions.observe(Some(mine.path())),
        vec![Observation {
            record: None,
            owner_alive: true,
        }]
    );
    assert_eq!(profile.review(Some(mine.path()), 200), None);
    assert_eq!(
        profile.markers(),
        2,
        "a live instance's marker must survive"
    );

    running.abandon();
    assert!(profile.review(Some(mine.path()), 300).is_some());
    // This launch's own marker is never judged, even by its own review.
    assert_eq!(profile.markers(), 1);
    mine.disarm().unwrap();
}

#[test]
fn an_unseen_crash_file_from_the_session_suppresses_a_second_notice() {
    let profile = profile();
    profile.sessions.arm(&record(100)).unwrap().abandon();
    crate::crash_report::publish_report(&profile.crash_dir, 150, b"panic: boom").unwrap();
    assert_eq!(profile.review(None, 200), None);
    assert_eq!(profile.reports(), vec!["panic: boom".to_owned()]);
}

#[test]
fn only_an_unseen_crash_file_written_during_the_session_covers_it() {
    let profile = profile();
    // Before the session started.
    crate::crash_report::publish_report(&profile.crash_dir, 99, b"older").unwrap();
    // During it, but already offered (consumed) in that session.
    let seen = crate::crash_report::publish_report(&profile.crash_dir, 120, b"seen").unwrap();
    let mut consumed = seen.as_os_str().to_owned();
    consumed.push(".seen");
    std::fs::rename(&seen, consumed).unwrap();

    profile.sessions.arm(&record(100)).unwrap().abandon();
    assert!(profile.review(None, 200).is_some());
}

#[test]
fn an_unclean_exit_report_published_during_a_session_does_not_cover_its_own_end() {
    let profile = profile();
    // Launch at 100 reports an earlier session (file at 101); nobody consumes
    // it, and then the launch itself dies.
    let earlier = crate::crash_report::unclean_exit_report(VERSION, "os: test", 101, 50);
    crate::crash_report::publish_report(&profile.crash_dir, 101, earlier.as_bytes()).unwrap();
    profile.sessions.arm(&record(100)).unwrap().abandon();
    assert!(profile.review(None, 200).is_some());
}

#[test]
fn markers_from_other_versions_or_formats_are_cleared_silently() {
    let profile = profile();
    let mut older = record(100);
    older.version = "0.0.1".into();
    profile.sessions.arm(&older).unwrap().abandon();
    std::fs::write(
        profile.sessions_dir.join("session-1-1.marker"),
        "tauri-explorer session v0\npid=1\n",
    )
    .unwrap();
    std::fs::write(
        profile.sessions_dir.join("session-2-2.marker"),
        "x".repeat(10_000),
    )
    .unwrap();

    assert_eq!(profile.review(None, 200), None);
    assert!(profile.reports().is_empty());
    assert_eq!(profile.markers(), 0);
}

#[test]
fn a_marker_staged_by_a_process_that_died_while_arming_is_cleared() {
    let profile = profile();
    std::fs::create_dir_all(&profile.sessions_dir).unwrap();
    std::fs::write(
        profile.sessions_dir.join(".session-abc.tmp"),
        record(100).encode(),
    )
    .unwrap();
    std::fs::write(profile.sessions_dir.join("unrelated.txt"), "keep").unwrap();
    assert_eq!(profile.review(None, 200), None);
    assert!(profile.reports().is_empty());
    assert_eq!(profile.markers(), 1, "only unrelated files remain");
}

#[test]
fn several_dead_sessions_yield_one_report_for_the_newest() {
    let profile = profile();
    profile.sessions.arm(&record(100)).unwrap().abandon();
    profile.sessions.arm(&record(180)).unwrap().abandon();
    let published = profile.review(None, 200).unwrap();
    let contents = std::fs::read_to_string(published).unwrap();
    assert!(contents.contains("session started: 180 (unix)"));
    assert_eq!(profile.reports().len(), 1);
    let left: Vec<_> = std::fs::read_dir(&profile.sessions_dir)
        .unwrap()
        .flatten()
        .map(|e| e.file_name())
        .collect();
    assert_eq!(profile.markers(), 0, "{left:?}");
}

#[test]
fn a_marker_from_an_ended_host_session_is_cleared_without_a_report() {
    let profile = profile();
    let mut before_reboot = record(100);
    before_reboot.host.boot = Some("boot-before".into());
    profile.sessions.arm(&before_reboot).unwrap().abandon();
    assert_eq!(profile.review(None, 200), None);
    assert_eq!(profile.markers(), 0);
}

#[cfg(unix)]
#[test]
fn a_marker_is_private_to_its_user() {
    use std::os::unix::fs::PermissionsExt;
    let profile = profile();
    let marker = profile.sessions.arm(&record(100)).unwrap();
    let mode = std::fs::metadata(marker.path())
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(mode & 0o777, 0o600);
    marker.disarm().unwrap();
}

#[test]
fn the_current_host_session_continues_itself() {
    let now = HostSession::current();
    assert!(now.continues(&HostSession::current()));
    #[cfg(target_os = "linux")]
    assert!(now.boot.is_some());
    #[cfg(windows)]
    assert!(now.boot_epoch.is_some() && now.login.is_some());
}

#[cfg(target_os = "linux")]
#[test]
fn only_local_x11_displays_name_a_socket() {
    use super::host::x11_display_number;
    assert_eq!(x11_display_number(":0"), Some(0));
    assert_eq!(x11_display_number(":1.0"), Some(1));
    assert_eq!(x11_display_number("unix:2"), Some(2));
    assert_eq!(x11_display_number("remote:0"), None);
    assert_eq!(x11_display_number(""), None);
    assert_eq!(x11_display_number(":x"), None);
}

#[test]
fn review_waits_only_for_a_started_review() {
    // Nothing started in this process: returns at once.
    let started = std::time::Instant::now();
    await_review(Duration::from_secs(5));
    assert!(started.elapsed() < Duration::from_secs(1));
}

/// A real process holds the marker and is stopped by a signal (#1686): the
/// OS-level lock and the signal path, not a simulation of either.
#[cfg(unix)]
mod real_process {
    use super::*;
    use std::process::{Child, Command};

    const HELPER: &str = "session_marker::tests::real_process::helper_holds_a_marker";

    fn spawn_helper(log_dir: &Path) -> Child {
        Command::new(std::env::current_exe().unwrap())
            .args(["--ignored", "--exact", HELPER, "--nocapture"])
            .env("TE_SESSION_MARKER_LOG_DIR", log_dir)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap()
    }

    fn wait_for_marker(sessions: &Path, helper: &mut Child) {
        let deadline = std::time::Instant::now() + Duration::from_secs(20);
        loop {
            let armed = std::fs::read_dir(sessions).is_ok_and(|entries| {
                entries
                    .flatten()
                    .any(|entry| name_matches(&entry.path(), MARKER_PREFIX, MARKER_SUFFIX))
            });
            if armed {
                return;
            }
            if std::time::Instant::now() > deadline {
                let _ = helper.kill();
                panic!("helper never armed its marker");
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn stop(helper: &mut Child, signo: i32) -> std::process::ExitStatus {
        unsafe { libc::kill(helper.id() as libc::pid_t, signo) };
        helper.wait().unwrap()
    }

    fn review(log_dir: &Path) -> Option<PathBuf> {
        let sessions = Sessions::new(log_dir.join("sessions"));
        review_ended_sessions(
            &Review {
                sessions: &sessions,
                crash_dir: &log_dir.join("crashes"),
                own: None,
                version: VERSION,
                host: &HostSession::current(),
            },
            now_secs(),
            || "os: test".to_owned(),
        )
    }

    #[test]
    fn a_killed_process_is_an_unclean_exit_and_a_terminated_one_is_not() {
        use std::os::unix::process::ExitStatusExt;
        let dir = tempfile::tempdir().unwrap();

        let mut killed = spawn_helper(dir.path());
        wait_for_marker(&dir.path().join("sessions"), &mut killed);
        // Alive: a concurrent launch must leave it alone.
        assert_eq!(review(dir.path()), None);
        assert_eq!(
            stop(&mut killed, libc::SIGKILL).signal(),
            Some(libc::SIGKILL)
        );
        assert!(
            review(dir.path()).is_some(),
            "a SIGKILLed session must be reported"
        );

        for signo in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP] {
            let mut stopped = spawn_helper(dir.path());
            wait_for_marker(&dir.path().join("sessions"), &mut stopped);
            let status = stop(&mut stopped, signo);
            assert_eq!(
                status.code(),
                Some(0),
                "signal {signo} did not exit in order"
            );
            assert_eq!(
                review(dir.path()),
                None,
                "signal {signo} reported as unclean"
            );
        }
        assert_eq!(
            std::fs::read_dir(dir.path().join("sessions"))
                .unwrap()
                .count(),
            0
        );
    }

    /// The helper: the app's own wiring (signal handling, then `start`), with
    /// `exit(0)` standing in for the event loop's orderly exit.
    #[test]
    #[ignore]
    fn helper_holds_a_marker() {
        let Some(log_dir) = std::env::var_os("TE_SESSION_MARKER_LOG_DIR") else {
            return;
        };
        crate::termination_signals::install(|| std::process::exit(0)).unwrap();
        start(PathBuf::from(log_dir));
        await_review(Duration::from_secs(10));
        std::thread::sleep(Duration::from_secs(30));
    }
}
