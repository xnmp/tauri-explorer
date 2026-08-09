use std::path::Path;
use std::sync::mpsc;
use std::time::{Duration, Instant};
use tauri_explorer_lib::config_watch::watch_config_changes;

fn reported_name_after_external_write(config_dir: &Path, changed: &Path) -> Option<String> {
    let (sent, received) = mpsc::channel();
    let _watcher = watch_config_changes(config_dir.to_path_buf(), move |filename| {
        let _ = sent.send(filename);
    })
    .expect("watch config directory");

    std::fs::write(changed, "external edit").expect("write symlink target");
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        if let Ok(filename) = received.recv_timeout(Duration::from_millis(100)) {
            return Some(filename);
        }
    }
    None
}

#[cfg(unix)]
#[test]
fn reports_writes_to_symlinked_settings_targets() {
    let temp = tempfile::tempdir().expect("temporary directory");
    let config_dir = temp.path().join("config");
    let external_dir = temp.path().join("dotfiles");
    std::fs::create_dir_all(&config_dir).expect("config directory");
    std::fs::create_dir_all(&external_dir).expect("external directory");
    let target = external_dir.join("settings.json");
    std::fs::write(&target, "{}").expect("initial settings");
    std::os::unix::fs::symlink(&target, config_dir.join("settings.json"))
        .expect("symlinked settings");

    assert_eq!(
        reported_name_after_external_write(&config_dir, &target),
        Some("settings.json".to_string())
    );
}

#[cfg(unix)]
#[test]
fn reports_writes_to_symlinked_theme_targets() {
    let temp = tempfile::tempdir().expect("temporary directory");
    let config_dir = temp.path().join("config");
    let external_themes = temp.path().join("dotfiles/themes");
    std::fs::create_dir_all(&config_dir).expect("config directory");
    std::fs::create_dir_all(&external_themes).expect("external themes directory");
    let target = external_themes.join("midnight.css");
    std::fs::write(&target, "body {}").expect("initial theme");
    std::os::unix::fs::symlink(&external_themes, config_dir.join("themes"))
        .expect("symlinked themes directory");

    assert_eq!(
        reported_name_after_external_write(&config_dir, &target),
        Some("themes/midnight.css".to_string())
    );
}

#[cfg(unix)]
#[test]
fn reports_writes_after_a_symlink_target_is_replaced() {
    let temp = tempfile::tempdir().expect("temporary directory");
    let config_dir = temp.path().join("config");
    let first_target_dir = temp.path().join("first");
    let replacement_target_dir = temp.path().join("replacement");
    std::fs::create_dir_all(&config_dir).expect("config directory");
    std::fs::create_dir_all(&first_target_dir).expect("first target directory");
    std::fs::create_dir_all(&replacement_target_dir).expect("replacement target directory");
    let first_settings = first_target_dir.join("settings.json");
    let replacement_settings = replacement_target_dir.join("settings.json");
    std::fs::write(&first_settings, "{}").expect("first settings");
    std::fs::write(&replacement_settings, "{}").expect("replacement settings");
    std::os::unix::fs::symlink(&first_settings, config_dir.join("settings.json"))
        .expect("first settings symlink");

    let (sent, received) = mpsc::channel();
    let _watcher = watch_config_changes(config_dir.clone(), move |filename| {
        let _ = sent.send(filename);
    })
    .expect("watch config directory");

    std::fs::remove_file(config_dir.join("settings.json")).expect("replace settings symlink");
    std::os::unix::fs::symlink(&replacement_settings, config_dir.join("settings.json"))
        .expect("replacement settings symlink");
    while received.try_recv().is_ok() {}
    std::thread::sleep(Duration::from_secs(3));

    std::fs::write(&replacement_settings, "external edit").expect("write replacement target");
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut reported = None;
    while Instant::now() < deadline {
        if let Ok(filename) = received.recv_timeout(Duration::from_millis(100)) {
            if filename == "settings.json" {
                reported = Some(filename);
                break;
            }
        }
    }
    assert_eq!(reported, Some("settings.json".to_string()));
}
