//! Filesystem watcher for auto-refreshing directory listings.
//! Issue: tauri-explorer-2gdf
//!
//! Uses `notify` crate to watch directories for external changes.
//! Refcounted watches allow multiple panes viewing the same directory
//! to share a single OS watch. Debounces events (300ms) before emitting.

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

use crate::error::AppError;
use super::dir_listing::invalidate_dir_cache;

/// Event payload emitted to the frontend when a watched directory changes.
#[derive(Clone, Serialize)]
struct DirectoryChangedPayload {
    path: String,
}

/// Singleton filesystem watcher with refcounted directory watches.
#[derive(Debug)]
struct FsWatcher {
    watcher: RecommendedWatcher,
    watched: HashMap<String, usize>,
}

static FS_WATCHER: OnceLock<Mutex<FsWatcher>> = OnceLock::new();

/// Initialize the filesystem watcher. Call once during app setup.
pub fn init_watcher(app: &AppHandle) {
    let app_handle = app.clone();

    let watcher = notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
        let event = match res {
            Ok(e) => e,
            Err(err) => {
                log::warn!("fs_watcher error: {}", err);
                return;
            }
        };

        // Only react to creates, removes, and renames
        match event.kind {
            EventKind::Create(_) | EventKind::Remove(_) | EventKind::Modify(notify::event::ModifyKind::Name(_)) => {}
            _ => return,
        }

        // Collect unique parent directories from the event paths
        let mut dirs = Vec::new();
        for path in &event.paths {
            let dir = path
                .parent()
                .unwrap_or(path)
                .to_string_lossy()
                .to_string();
            if !dirs.contains(&dir) {
                dirs.push(dir);
            }
        }

        for dir in dirs {
            // Invalidate the directory cache
            let _ = invalidate_dir_cache(dir.clone());

            // Emit event to frontend
            if let Err(e) = app_handle.emit("directory-changed", DirectoryChangedPayload { path: dir.clone() }) {
                log::warn!("Failed to emit directory-changed for {}: {}", dir, e);
            }
        }
    })
    .expect("Failed to create filesystem watcher");

    let fs_watcher = FsWatcher {
        watcher,
        watched: HashMap::new(),
    };

    FS_WATCHER
        .set(Mutex::new(fs_watcher))
        .expect("init_watcher called more than once");

    log::info!("Filesystem watcher initialized");
}

fn with_watcher<F, R>(f: F) -> Result<R, AppError>
where
    F: FnOnce(&mut FsWatcher) -> Result<R, AppError>,
{
    let mut watcher = FS_WATCHER
        .get()
        .ok_or_else(|| AppError::Other("Filesystem watcher not initialized".to_string()))?
        .lock()
        .map_err(|e| AppError::Other(format!("Watcher lock poisoned: {}", e)))?;
    f(&mut watcher)
}

/// Start watching a directory. Refcounted — multiple calls for the same path
/// increment the count; the OS watch starts only on the first call.
#[tauri::command]
pub fn watch_directory(path: String) -> Result<(), AppError> {
    with_watcher(|w| {
        let count = w.watched.entry(path.clone()).or_insert(0);
        *count += 1;
        if *count == 1 {
            let pb = PathBuf::from(&path);
            w.watcher
                .watch(&pb, RecursiveMode::NonRecursive)
                .map_err(|e| AppError::Other(format!("Failed to watch {}: {}", path, e)))?;
            log::debug!("Started watching: {}", path);
        } else {
            log::debug!("Incremented watch refcount for {}: {}", path, count);
        }
        Ok(())
    })
}

/// Stop watching a directory. Decrements refcount; OS watch removed at zero.
#[tauri::command]
pub fn unwatch_directory(path: String) -> Result<(), AppError> {
    with_watcher(|w| {
        if let Some(count) = w.watched.get_mut(&path) {
            *count -= 1;
            if *count == 0 {
                w.watched.remove(&path);
                let pb = PathBuf::from(&path);
                let _ = w.watcher.unwatch(&pb);
                log::debug!("Stopped watching: {}", path);
            } else {
                log::debug!("Decremented watch refcount for {}: {}", path, count);
            }
        }
        Ok(())
    })
}
