//! OS-owned "last opened" records (#1526) merged into the Details "Date
//! opened" column beside the app-owned history (#1525).
//!
//! Each operating system keeps its own record of files opened by other
//! applications. An [`OsRecentSource`] adapts one of them behind a single
//! contract: given the requested paths, return the epoch-millisecond time each
//! was last opened. Sources are read-only, local, and best-effort: a missing,
//! disabled or unreadable source contributes nothing and never fails the
//! command, so the column degrades to the app history alone.
//!
//! Adapters:
//! - Linux: `recently-used.xbel` (`xbel.rs`).
//! - macOS (Spotlight `kMDItemLastUsedDate`) and Windows (Recent `.lnk`):
//!   not yet implemented; add them to [`sources`] behind their own `cfg`.
use crate::error::AppError;
use std::collections::HashMap;

#[cfg(target_os = "linux")]
mod xbel;

/// Requests beyond this many paths are ignored; the frontend batches per
/// listed directory.
const MAX_PATHS: usize = 50_000;

/// One OS record of file opens.
pub(crate) trait OsRecentSource: Send + Sync {
    /// Epoch milliseconds of the last open for each of `paths` this source
    /// knows. Paths it does not know are absent; failures yield an empty map.
    fn opened_at(&self, paths: &[String]) -> HashMap<String, i64>;
}

/// The sources available on this platform.
fn sources() -> Vec<Box<dyn OsRecentSource>> {
    #[cfg(target_os = "linux")]
    {
        vec![Box::new(xbel::XbelSource::system())]
    }
    #[cfg(not(target_os = "linux"))]
    {
        Vec::new()
    }
}

/// Combine per-source results; the newest time wins for each path.
pub(crate) fn merge_newest(
    results: impl IntoIterator<Item = HashMap<String, i64>>,
) -> HashMap<String, i64> {
    let mut merged: HashMap<String, i64> = HashMap::new();
    for result in results {
        for (path, at) in result {
            merged
                .entry(path)
                .and_modify(|current| *current = (*current).max(at))
                .or_insert(at);
        }
    }
    merged
}

fn collect(sources: &[Box<dyn OsRecentSource>], paths: &[String]) -> HashMap<String, i64> {
    let paths = &paths[..paths.len().min(MAX_PATHS)];
    merge_newest(sources.iter().map(|source| source.opened_at(paths)))
}

/// When the OS last saw each path opened (epoch ms), keyed by the requested
/// path string. Paths with no OS record are omitted. The frontend skips this
/// call entirely when the user disables OS sources.
#[tauri::command]
pub async fn os_opened_times(paths: Vec<String>) -> Result<HashMap<String, i64>, AppError> {
    tauri::async_runtime::spawn_blocking(move || collect(&sources(), &paths))
        .await
        .map_err(|error| AppError::WorkerFailed(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixed(HashMap<String, i64>);
    impl OsRecentSource for Fixed {
        fn opened_at(&self, paths: &[String]) -> HashMap<String, i64> {
            paths
                .iter()
                .filter_map(|path| self.0.get(path).map(|at| (path.clone(), *at)))
                .collect()
        }
    }

    fn fixed(entries: &[(&str, i64)]) -> Box<dyn OsRecentSource> {
        Box::new(Fixed(
            entries.iter().map(|(p, t)| (p.to_string(), *t)).collect(),
        ))
    }

    #[test]
    fn newest_time_wins_across_sources() {
        let sources = vec![
            fixed(&[("/a", 10), ("/b", 50)]),
            fixed(&[("/a", 30), ("/c", 5)]),
        ];
        let paths: Vec<String> = ["/a", "/b", "/c", "/none"].map(String::from).to_vec();
        let merged = collect(&sources, &paths);
        assert_eq!(merged.get("/a"), Some(&30));
        assert_eq!(merged.get("/b"), Some(&50));
        assert_eq!(merged.get("/c"), Some(&5));
        assert!(!merged.contains_key("/none"));
    }

    #[test]
    fn no_sources_or_no_paths_is_empty() {
        assert!(collect(&[], &["/a".into()]).is_empty());
        assert!(collect(&[fixed(&[("/a", 1)])], &[]).is_empty());
    }
}
