use super::*;
use log::Log;
use std::io::Write;

fn alex() -> Redactor {
    Redactor::new(&["/home/alex".to_owned()], false)
}

fn log_file_with(bytes: &[u8]) -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("tauri-explorer.log");
    std::fs::File::create(&path)
        .unwrap()
        .write_all(bytes)
        .unwrap();
    (dir, path)
}

#[test]
fn ring_evicts_oldest_entries_past_the_cap() {
    let mut ring = Ring::default();
    for index in 0..(MAX_RING_ENTRIES + 25) {
        ring.push(format!("[ERROR][t] failure {index}"));
    }
    let lines = ring.lines();
    assert_eq!(lines.len(), MAX_RING_ENTRIES);
    assert_eq!(lines[0], "[ERROR][t] failure 25");
    assert!(lines.last().unwrap().ends_with("failure 124"));
}

#[test]
fn ring_stays_within_its_byte_budget_for_huge_lines() {
    let mut ring = Ring::default();
    for index in 0..500 {
        // quote_line caps real lines at ~400 chars; the ring must hold even without it.
        ring.push(format!("{index}{}", "x".repeat(2000)));
    }
    let total: usize = ring.lines().iter().map(String::len).sum();
    assert!(total <= MAX_RING_BYTES + 100, "ring held {total} bytes");
    assert!(!ring.lines().is_empty());
}

#[test]
fn consecutive_repeats_collapse_instead_of_evicting_history() {
    let mut ring = Ring::default();
    ring.push("[WARN][a] first".into());
    for _ in 0..1000 {
        ring.push("[ERROR][b] loop".into());
    }
    assert_eq!(
        ring.lines(),
        vec!["[WARN][a] first", "[ERROR][b] loop (x1000)"]
    );
}

#[test]
fn only_warn_and_error_records_are_recorded() {
    let logger = RingLog;
    let record = |level, message: &str| {
        logger.log(
            &log::Record::builder()
                .level(level)
                .target("recent-errors-test")
                .args(format_args!("{message}"))
                .build(),
        )
    };
    record(log::Level::Info, "chatter-info-marker");
    record(log::Level::Debug, "chatter-debug-marker");
    record(log::Level::Warn, "warn-marker");
    record(log::Level::Error, "error-marker");
    let held = RING.lock().unwrap().lines().join("\n");
    assert!(held.lines().any(|line| line == "warn-marker"));
    assert!(held.lines().any(|line| line == "error-marker"));
    assert!(!held.contains("chatter"));
}

#[test]
fn previous_session_keeps_only_warn_and_error_before_the_session_offset_and_redacts_home() {
    let previous = "[2026-01-01][10:00:00][app][INFO] boot\n\
        [2026-01-01][10:00:01][app][ERROR] cannot read /home/alex/secret/file.txt\n\
        [2026-01-01][10:00:02][app][WARN] slow\n";
    let current = "[2026-01-02][09:00:00][app][ERROR] belongs to this session\n";
    let (_dir, path) = log_file_with(format!("{previous}{current}").as_bytes());
    let lines = previous_session_lines(&path, previous.len() as u64, &alex());
    assert_eq!(
        lines,
        vec![
            "[2026-01-01][10:00:01][app][ERROR] cannot read ~/secret/file.txt",
            "[2026-01-01][10:00:02][app][WARN] slow",
        ]
    );
}

#[test]
fn previous_session_survives_non_utf8_bytes_and_a_missing_file() {
    let mut bytes = b"[d][t][app][ERROR] bad \xff\xfe bytes\n".to_vec();
    bytes.extend_from_slice(b"[d][t][app][WARN] after\n");
    let (dir, path) = log_file_with(&bytes);
    let lines = previous_session_lines(&path, bytes.len() as u64, &Redactor::default());
    assert_eq!(lines.len(), 2);
    assert!(lines[0].contains("bad "));
    assert!(
        previous_session_lines(&dir.path().join("absent.log"), 10, &Redactor::default()).is_empty()
    );
}

#[test]
fn previous_session_is_the_current_log_before_this_session_writes() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join(LOG_FILE), "[d][t][app][ERROR] last time\n").unwrap();
    let lines = load_previous_session(dir.path(), &Redactor::default());
    assert_eq!(lines, vec!["[d][t][app][ERROR] last time"]);
}

#[test]
fn startup_rotation_moves_the_previous_session_to_a_dated_file() {
    // The plugin renamed the old log before setup: the current file is empty
    // (or absent) and the previous session is the newest rotated file.
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("tauri-explorer_2026-01-01_10-00-00.log"),
        "[d][t][app][ERROR] older\n",
    )
    .unwrap();
    std::thread::sleep(std::time::Duration::from_millis(20));
    std::fs::write(
        dir.path().join("tauri-explorer_2026-01-02_10-00-00.log"),
        "[d][t][app][ERROR] newest rotated\n",
    )
    .unwrap();
    std::fs::write(dir.path().join(LOG_FILE), "").unwrap();
    let lines = load_previous_session(dir.path(), &Redactor::default());
    assert_eq!(lines, vec!["[d][t][app][ERROR] newest rotated"]);
    // An absent current file behaves the same.
    std::fs::remove_file(dir.path().join(LOG_FILE)).unwrap();
    assert_eq!(
        load_previous_session(dir.path(), &Redactor::default()),
        lines
    );
}

#[test]
fn a_captured_previous_session_does_not_follow_later_rotation() {
    let dir = tempfile::tempdir().unwrap();
    let current = dir.path().join(LOG_FILE);
    std::fs::write(&current, "[d][t][app][ERROR] previous session\n").unwrap();
    let captured = load_previous_session(dir.path(), &Redactor::default());
    // Mid-session the log rotates and the new file holds this session's lines.
    std::fs::write(&current, "[d][t][app][ERROR] this session\n").unwrap();
    assert_eq!(captured, vec!["[d][t][app][ERROR] previous session"]);
}

#[test]
fn no_log_files_means_no_previous_session() {
    let dir = tempfile::tempdir().unwrap();
    assert!(load_previous_session(dir.path(), &Redactor::default()).is_empty());
    assert!(load_previous_session(&dir.path().join("missing"), &Redactor::default()).is_empty());
}

#[test]
fn lines_pass_through_a_formatted_dispatch_chain_with_a_single_prefix() {
    // The plugin formats at the top-level dispatch, so child targets get an
    // already-prefixed message (tauri-plugin-log builder).
    let (_, logger) = tauri_plugin_log::fern::Dispatch::new()
        .format(|out, message, record| {
            out.finish(format_args!(
                "[12:00:00][{}][{}] {}",
                record.target(),
                record.level(),
                message
            ))
        })
        .chain(
            tauri_plugin_log::fern::Dispatch::new().chain(Box::new(RingLog) as Box<dyn log::Log>),
        )
        .into_log();
    logger.log(
        &log::Record::builder()
            .level(log::Level::Error)
            .target("chain-test")
            .args(format_args!("chain-marker /home/alex/x"))
            .build(),
    );
    let held = RING.lock().unwrap().lines();
    let line = held
        .iter()
        .find(|line| line.contains("chain-marker"))
        .unwrap();
    assert_eq!(line.matches("[ERROR]").count(), 1, "{line}");
    assert!(
        line.starts_with("[12:00:00][chain-test][ERROR] chain-marker"),
        "{line}"
    );
}

#[test]
fn repeats_differing_only_in_timestamp_collapse() {
    let mut ring = Ring::default();
    ring.push("[2026-01-01][10:00:00][app][ERROR] loop".into());
    ring.push("[2026-01-01][10:00:01][app][ERROR] loop".into());
    ring.push("[2026-01-01][10:00:02][app][ERROR] other".into());
    assert_eq!(
        ring.lines(),
        vec![
            "[2026-01-01][10:00:00][app][ERROR] loop (x2)",
            "[2026-01-01][10:00:02][app][ERROR] other"
        ]
    );
}

#[test]
fn windows_debug_escaped_paths_are_redacted_in_the_previous_session() {
    let redactor = Redactor::new(&[r"C:\Users\alex".to_owned()], true);
    let text = "[d][t][app][ERROR] failed: \"C:\\\\Users\\\\alex\\\\Docs\\\\a.txt\"\n";
    let (_dir, path) = log_file_with(text.as_bytes());
    let lines = previous_session_lines(&path, text.len() as u64, &redactor);
    assert_eq!(lines.len(), 1);
    assert!(!lines[0].contains("alex"), "{}", lines[0]);
}

#[test]
fn previous_session_bounds_a_huge_log_and_huge_lines() {
    let mut text = String::new();
    for index in 0..5000 {
        text.push_str(&format!("[d][t][app][ERROR] {index} {}\n", "y".repeat(900)));
    }
    let (_dir, path) = log_file_with(text.as_bytes());
    let lines = previous_session_lines(&path, text.len() as u64, &Redactor::default());
    assert_eq!(lines.len(), MAX_PREVIOUS_LINES);
    assert!(lines.iter().all(|line| line.chars().count() <= 410));
    assert!(lines.last().unwrap().contains("4999"));
}

#[test]
fn previous_session_drops_the_fragment_a_scan_window_cuts_off() {
    let filler = format!("[d][t][app][ERROR] {}\n", "z".repeat(1000));
    let mut text = String::new();
    while (text.len() as u64) < PREVIOUS_SCAN_BYTES + 5000 {
        text.push_str(&filler);
    }
    text.push_str("[d][t][app][WARN] tail\n");
    let (_dir, path) = log_file_with(text.as_bytes());
    let lines = previous_session_lines(&path, text.len() as u64, &Redactor::default());
    assert!(lines.iter().all(|line| line.starts_with("[d][t][app]")));
}

#[test]
fn excerpt_labels_sources_and_is_empty_when_nothing_was_recorded() {
    assert_eq!(render_excerpt(&[], &[], 5000), "");
    let text = render_excerpt(&["[ERROR][a] old".into()], &["[WARN][b] new".into()], 5000);
    assert_eq!(
        text,
        "Previous session:\n[ERROR][a] old\n\nThis session:\n[WARN][b] new"
    );
}

#[test]
fn excerpt_drops_the_oldest_lines_first_to_fit() {
    let previous: Vec<String> = (0..20)
        .map(|i| format!("[ERROR][p] prev {i:02} {}", "a".repeat(100)))
        .collect();
    let current: Vec<String> = (0..30)
        .map(|i| format!("[ERROR][c] cur {i:02} {}", "b".repeat(100)))
        .collect();
    let text = render_excerpt(&previous, &current, 1500);
    assert!(units(&text) <= 1500);
    assert!(text.contains("cur 29"), "newest current line must survive");
    assert!(!text.contains("prev 00"), "oldest previous line goes first");
    assert_eq!(render_excerpt(&previous, &current, 5), "");
}
