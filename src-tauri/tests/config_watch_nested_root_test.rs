#![cfg(target_os = "linux")]

use std::os::unix::fs::{symlink, MetadataExt};
use std::path::Path;
use std::sync::mpsc;
use std::time::{Duration, Instant};
use tauri_explorer_lib::config_watch::watch_config_changes;

fn has_native_watch(root: &Path) -> bool {
    let inode = std::fs::metadata(root).expect("root metadata").ino();
    std::fs::read_dir("/proc/self/fdinfo")
        .expect("Linux native-watch inventory")
        .filter_map(Result::ok)
        .filter_map(|entry| std::fs::read_to_string(entry.path()).ok())
        .any(|info| {
            info.lines()
                .filter(|line| line.starts_with("inotify "))
                .any(|line| {
                    line.split_whitespace()
                        .filter_map(|field| field.strip_prefix("ino:"))
                        .any(|value| u64::from_str_radix(value, 16).ok() == Some(inode))
                })
        })
}

#[test]
fn public_watcher_reports_canonical_writes_after_nested_root_retirement() {
    let temp = tempfile::tempdir().expect("watcher tree");
    let config = temp.path().join("config");
    let dots = temp.path().join("dots");
    let nested = dots.join("sub");
    std::fs::create_dir_all(&config).expect("config directory");
    std::fs::create_dir_all(&nested).expect("nested target directory");
    let old = dots.join("settings.json");
    let target = nested.join("settings.json");
    std::fs::write(&old, "old").expect("old settings");
    std::fs::write(&target, "new").expect("nested settings");
    let configured = config.join("settings.json");
    symlink(&old, &configured).expect("initial symlink");
    let (sent, received) = mpsc::channel();
    let watcher = watch_config_changes(config.clone(), move |name| {
        let _ = sent.send(name);
    })
    .expect("production config watcher");
    assert!(
        has_native_watch(&dots),
        "initial ancestor watch was not established"
    );

    let replacement = config.join("replacement");
    symlink(&target, &replacement).expect("replacement symlink");
    std::fs::rename(replacement, configured).expect("atomic retarget");
    let deadline = Instant::now() + Duration::from_secs(10);
    while has_native_watch(&dots) {
        assert!(
            Instant::now() < deadline,
            "refresh did not retire the ancestor watch"
        );
        std::thread::sleep(Duration::from_millis(20));
    }

    // inotify removes a recursive root on its callback thread. An event from
    // this first-ever sentinel write proves that removal finished, and drains
    // earlier symlink-entry callbacks before asserting on a canonical write.
    std::fs::write(config.join("bookmarks.json"), "[]").expect("handover barrier");
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let name = received
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .expect("handover barrier callback");
        if name == "bookmarks.json" {
            break;
        }
    }
    while received.try_recv().is_ok() {}

    // Restoration may still be completing after the removal barrier. Repeated
    // canonical writes permit that handover gap without letting the original
    // ancestor watch hide a permanently lost descendant registration.
    let target = std::fs::canonicalize(target).expect("canonical nested target");
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut observed = false;
    let mut revision = 0;
    while Instant::now() < deadline {
        std::fs::write(&target, format!("canonical edit {revision}"))
            .expect("canonical target write");
        if received
            .recv_timeout(Duration::from_millis(100))
            .ok()
            .as_deref()
            == Some("settings.json")
        {
            observed = true;
            break;
        }
        revision += 1;
    }
    assert!(
        observed,
        "nested canonical settings edits stopped reporting after ancestor retirement"
    );
    watcher
        .shutdown(Duration::from_secs(5))
        .expect("bounded watcher shutdown");
}
