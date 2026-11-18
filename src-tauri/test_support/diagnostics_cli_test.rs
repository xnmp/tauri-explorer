use super::{
    is_warn_or_error, newest_crash, read_tail, render, requested, warn_error_tail, CrashFile,
    Input, IDENTIFIER, LOG_FILE, MAX_CRASH_LINES, MAX_LOG_LINES,
};
use crate::environment::EnvironmentField;

fn fields() -> Vec<EnvironmentField> {
    vec![
        EnvironmentField {
            label: "OS",
            value: "Arch Linux (x86_64)".into(),
        },
        EnvironmentField {
            label: "Webview",
            value: "WebKitGTK unknown".into(),
        },
        EnvironmentField {
            label: "Install",
            value: "AppImage".into(),
        },
    ]
}

fn crash(name: &str, modified: Option<u64>) -> CrashFile {
    CrashFile {
        name: name.into(),
        modified,
    }
}

fn log_line(level: &str, message: &str) -> String {
    format!("[2026-11-18][10:00:00][{level}][tauri_explorer_lib] {message}")
}

#[test]
fn flag_is_detected_anywhere_before_the_terminator() {
    assert!(requested(["--diagnostics"]));
    assert!(requested(["/work", "--diagnostics"]));
    assert!(requested(["--new-tab", "--diagnostics", "/work"]));
    assert!(!requested(Vec::<&str>::new()));
    assert!(!requested(["/work", "--new-tab"]));
    // A folder literally named `--diagnostics` stays reachable.
    assert!(!requested(["--", "--diagnostics"]));
    // Exact match only.
    assert!(!requested(["--diagnostics=1", "--diag", "-diagnostics"]));
}

#[test]
fn newest_crash_is_chosen_by_modification_time() {
    let files = [
        crash("crash-300.txt.seen", Some(100)),
        crash("crash-100.txt", Some(300)),
        crash("crash-200.txt", None),
    ];
    assert_eq!(newest_crash(&files).unwrap().name, "crash-100.txt");
    assert_eq!(newest_crash(&[]), None);
    // Equal times fall back to the name so the choice is deterministic.
    let tied = [crash("crash-1.txt", Some(5)), crash("crash-2.txt", Some(5))];
    assert_eq!(newest_crash(&tied).unwrap().name, "crash-2.txt");
}

#[test]
fn only_leading_warn_and_error_levels_count() {
    assert!(is_warn_or_error(&log_line("WARN", "slow")));
    assert!(is_warn_or_error(&log_line("ERROR", "failed")));
    assert!(!is_warn_or_error(&log_line(
        "INFO",
        "saw [ERROR] in a file"
    )));
    assert!(!is_warn_or_error(&log_line("DEBUG", "x")));
    assert!(!is_warn_or_error("  continuation of a multi-line ERROR"));
    assert!(!is_warn_or_error("[unterminated"));
}

#[test]
fn tail_keeps_only_the_last_bounded_warn_and_error_lines_in_order() {
    let mut text = String::new();
    for index in 0..200 {
        let level = ["INFO", "WARN", "ERROR", "DEBUG"][index % 4];
        text.push_str(&log_line(level, &format!("event {index}")));
        text.push('\n');
    }
    let tail = warn_error_tail(&text, MAX_LOG_LINES);
    assert_eq!(tail.len(), MAX_LOG_LINES);
    assert!(tail.iter().all(|line| is_warn_or_error(line)));
    assert!(tail.last().unwrap().ends_with("event 198"));
    assert!(tail.first().unwrap().ends_with("event 101"));
}

#[test]
fn report_lists_environment_log_folder_crash_and_tail() {
    let fields = fields();
    let files = [
        crash("crash-1.txt.seen", Some(1_000)),
        crash("crash-2.txt", Some(1_700_000_000)),
    ];
    let mut log = String::new();
    for index in 0..120 {
        log.push_str(&log_line("WARN", &format!("warn {index} in /home/alice/x")));
        log.push('\n');
        log.push_str(&log_line("INFO", "noise"));
        log.push('\n');
    }
    let crash_text: String = (0..100).map(|line| format!("line {line}\n")).collect();
    let report = render(&Input {
        version: "0.9.1",
        environment: &fields,
        log_dir: Some("/home/alice/.local/share/io.github.xnmp.tauri-explorer/logs"),
        log_dir_exists: true,
        log_file: Some("tauri-explorer.log"),
        log_text: Some(&log),
        crash_files: &files,
        newest_crash_text: Some(&crash_text),
        home: Some("/home/alice"),
    });

    assert!(report.contains("- Tauri Explorer: v0.9.1\n- OS: Arch Linux (x86_64)\n"));
    assert!(report.contains("- Webview: WebKitGTK unknown\n- Install: AppImage\n"));
    assert!(report
        .contains("Log folder: /home/alice/.local/share/io.github.xnmp.tauri-explorer/logs\n"));
    assert!(report
        .contains("Newest crash report: crashes/crash-2.txt (2023-11-14 22:13:20 UTC), 1 older\n"));
    assert!(report.contains(&format!("  line {}\n", MAX_CRASH_LINES - 1)));
    assert!(!report.contains(&format!("  line {}\n", MAX_CRASH_LINES)));
    assert!(report.contains("more lines in the file"));
    assert!(report.contains(&format!(
        "Last {MAX_LOG_LINES} warning/error lines of tauri-explorer.log:"
    )));
    assert!(report.contains("warn 119 in ~/x"));
    assert!(!report.contains("warn 69 "));
    assert!(!report.contains("noise"));
    // Home is shown in full only in the log folder line.
    assert_eq!(report.matches("/home/alice").count(), 1);
}

#[test]
fn missing_log_folder_and_unresolvable_home_degrade_to_text() {
    let fields = fields();
    let missing = render(&Input {
        version: "0.9.1",
        environment: &fields,
        log_dir: Some("/nowhere/logs"),
        log_dir_exists: false,
        ..Input::default()
    });
    assert!(missing.contains("Log folder: /nowhere/logs (does not exist"));
    assert!(missing.contains("Crash reports: none\n"));
    assert!(missing.contains("Warnings and errors: no log file found\n"));

    let unknown = render(&Input {
        version: "0.9.1",
        environment: &fields,
        ..Input::default()
    });
    assert!(unknown.contains("Log folder: unknown"));

    let quiet = render(&Input {
        version: "0.9.1",
        environment: &fields,
        log_dir: Some("/logs"),
        log_dir_exists: true,
        log_file: Some("tauri-explorer.log"),
        log_text: Some(&log_line("INFO", "fine")),
        crash_files: &[crash("crash-1.txt", None)],
        ..Input::default()
    });
    assert!(quiet.contains("Warnings and errors: none in the end of tauri-explorer.log"));
    assert!(quiet.contains("crashes/crash-1.txt (time unknown)\n  (could not be read)\n"));
}

#[test]
fn long_lines_are_bounded() {
    let fields = fields();
    let long = log_line("ERROR", &"x".repeat(5_000));
    let report = render(&Input {
        version: "1",
        environment: &fields,
        log_file: Some("tauri-explorer.log"),
        log_text: Some(&long),
        ..Input::default()
    });
    let quoted = report
        .lines()
        .find(|line| line.contains("[ERROR]"))
        .unwrap();
    assert!(quoted.chars().count() < 450);
    assert!(quoted.ends_with("[...]"));
}

#[test]
fn log_tail_starts_at_a_line_boundary_when_cut() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("t.log");
    std::fs::write(&path, "first line\nsecond line\nthird\n").unwrap();
    assert_eq!(
        read_tail(&path, 1024).unwrap(),
        "first line\nsecond line\nthird\n"
    );
    assert_eq!(read_tail(&path, 15).unwrap(), "third\n");
    assert_eq!(read_tail(&dir.path().join("missing.log"), 10), None);
}

#[test]
fn log_location_matches_tauri_configuration() {
    let config: serde_json::Value =
        serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
    assert_eq!(config["identifier"], IDENTIFIER);
    // tauri-plugin-log names the file after the product.
    assert_eq!(
        format!("{}.log", config["productName"].as_str().unwrap()),
        LOG_FILE
    );
    // An override would move the log folder away from the default resolved here.
    assert!(config["app"].get("appDirectoriesOverride").is_none());
}
