use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::path::Path;
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};
use tauri_explorer_lib::config_watch::{apply_watch_plan_update, config_watch_plan};

fn reported_name_after_external_write(config_dir: &Path, changed: &Path) -> Option<String> {
    let plan = config_watch_plan(config_dir);
    let (sent, received) = mpsc::channel();
    let mut watcher: RecommendedWatcher =
        notify::recommended_watcher(move |event: Result<notify::Event, notify::Error>| {
            if let Ok(event) = event {
                for path in event.paths {
                    if let Some(filename) = plan.watched_config_name(&path) {
                        let _ = sent.send(filename);
                    }
                }
            }
        })
        .expect("watcher");
    watcher
        .watch(config_dir, RecursiveMode::Recursive)
        .expect("watch config directory");
    for (root, mode) in &config_watch_plan(config_dir).external_roots {
        watcher.watch(root, *mode).expect("watch external target");
    }

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

    let watch_plan = Arc::new(Mutex::new(config_watch_plan(&config_dir)));
    let callback_plan = Arc::clone(&watch_plan);
    let (sent, received) = mpsc::channel();
    let mut watcher: RecommendedWatcher =
        notify::recommended_watcher(move |event: Result<notify::Event, notify::Error>| {
            if let Ok(event) = event {
                let Ok(plan) = callback_plan.lock() else {
                    return;
                };
                for path in event.paths {
                    if let Some(filename) = plan.watched_config_name(&path) {
                        let _ = sent.send(filename);
                    }
                }
            }
        })
        .expect("watcher");
    watcher
        .watch(&config_dir, RecursiveMode::Recursive)
        .expect("watch config directory");
    for (root, mode) in &watch_plan.lock().expect("watch plan lock").external_roots {
        watcher.watch(root, *mode).expect("watch first target");
    }

    std::fs::remove_file(config_dir.join("settings.json")).expect("replace settings symlink");
    std::os::unix::fs::symlink(&replacement_settings, config_dir.join("settings.json"))
        .expect("replacement settings symlink");
    apply_watch_plan_update(&config_dir, &watch_plan, &mut watcher);
    while received.try_recv().is_ok() {}

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
