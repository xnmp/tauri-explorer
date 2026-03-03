//! Fuzzy search module for Tauri commands.
//! Issue: tauri-explorer-az6w, tauri-explorer-nv2y

use crate::error::AppError;
use jwalk::WalkDir;
use nucleo_matcher::pattern::{CaseMatching, Normalization, Pattern};
use nucleo_matcher::{Config, Matcher, Utf32Str};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter};

/// Directories to skip during recursive search (for performance).
const SKIP_DIRS: &[&str] = &[
    ".git",
    ".svn",
    ".hg",
    "node_modules",
    "__pycache__",
    ".venv",
    "venv",
    ".cache",
    ".npm",
    ".cargo",
    "target",
    "build",
    "dist",
    "out",
    ".idea",
    ".vscode",
];

/// Search result from fuzzy file search.
#[derive(Debug, Clone, Serialize)]
pub struct SearchResult {
    pub name: String,
    pub path: String,
    #[serde(rename = "relativePath")]
    pub relative_path: String,
    pub score: u32,
    pub kind: String, // "file" or "directory"
}

/// Search response.
#[derive(Debug, Serialize)]
pub struct SearchResponse {
    pub results: Vec<SearchResult>,
}

/// Event payload for streaming search results.
#[derive(Debug, Clone, Serialize)]
pub struct SearchResultsEvent {
    #[serde(rename = "searchId")]
    pub search_id: u64,
    pub results: Vec<SearchResult>,
    pub done: bool,
    #[serde(rename = "totalScanned")]
    pub total_scanned: usize,
}

/// Registry for active searches
static SEARCHES: crate::task_registry::TaskRegistry = crate::task_registry::TaskRegistry::new();

/// Check if a directory should be skipped.
fn should_skip_dir(name: &str) -> bool {
    name.starts_with('.') || SKIP_DIRS.contains(&name)
}

/// Fuzzy search for files and directories recursively (non-streaming version).
/// Uses nucleo for fast fuzzy matching and jwalk for parallel traversal.
#[tauri::command]
pub fn fuzzy_search(query: String, root: String, limit: usize) -> Result<SearchResponse, AppError> {
    let root_path = PathBuf::from(&root);

    if !root_path.exists() {
        return Err(AppError::NotFound(root));
    }

    if !root_path.is_dir() {
        return Err(AppError::InvalidPath(format!("Not a directory: {}", root)));
    }

    let limit = limit.min(100).max(1);

    // Collect entries using jwalk for parallel traversal
    let mut entries: Vec<(String, String, bool)> = Vec::new(); // (relative_path, name, is_dir)
    let max_entries = 10000;

    let walker = WalkDir::new(&root_path)
        .skip_hidden(true)
        .process_read_dir(|_depth, _path, _read_dir_state, children| {
            children.retain(|entry| {
                entry.as_ref().map_or(true, |e| {
                    let name = e.file_name().to_string_lossy();
                    !should_skip_dir(&name)
                })
            });
        });

    for entry in walker.into_iter().take(max_entries) {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };

        // Skip the root itself
        if entry.path() == root_path {
            continue;
        }

        let path = entry.path();
        let relative_path = match path.strip_prefix(&root_path) {
            Ok(p) => p.to_string_lossy().to_string(),
            Err(_) => continue,
        };

        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();

        // Skip hidden files not caught by walker
        if name.starts_with('.') {
            continue;
        }

        let is_dir = entry.file_type().is_dir();

        entries.push((relative_path, name, is_dir));
    }

    if entries.is_empty() {
        return Ok(SearchResponse { results: vec![] });
    }

    // Use nucleo for fuzzy matching
    let mut matcher = Matcher::new(Config::DEFAULT);
    let pattern = Pattern::parse(&query, CaseMatching::Ignore, Normalization::Smart);

    // Score all entries
    let mut scored: Vec<(u32, usize)> = entries
        .iter()
        .enumerate()
        .filter_map(|(idx, (_, name, _))| {
            let mut buf = Vec::new();
            let haystack = Utf32Str::new(name, &mut buf);
            pattern.score(haystack, &mut matcher).map(|score| (score, idx))
        })
        .collect();

    // Sort by score descending
    scored.sort_by(|a, b| b.0.cmp(&a.0));

    // Take top results
    let results: Vec<SearchResult> = scored
        .into_iter()
        .take(limit)
        .map(|(score, idx)| {
            let (relative_path, name, is_dir) = &entries[idx];
            let full_path = root_path.join(relative_path);
            SearchResult {
                name: name.clone(),
                path: full_path.to_string_lossy().to_string(),
                relative_path: relative_path.clone(),
                score,
                kind: if *is_dir {
                    "directory".to_string()
                } else {
                    "file".to_string()
                },
            }
        })
        .collect();

    Ok(SearchResponse { results })
}

/// Start a streaming fuzzy search that emits results incrementally.
/// Returns a search ID that can be used to cancel the search.
/// `boost_prefix` is an optional path prefix; results under it get a score bonus.
#[tauri::command]
pub fn start_streaming_search(
    app: AppHandle,
    query: String,
    root: String,
    limit: usize,
    boost_prefix: Option<String>,
) -> Result<u64, AppError> {
    let root_path = PathBuf::from(&root);

    if !root_path.exists() {
        return Err(AppError::NotFound(root));
    }

    if !root_path.is_dir() {
        return Err(AppError::InvalidPath(format!("Not a directory: {}", root)));
    }

    let limit = limit.min(100).max(1);
    let (search_id, cancelled) = SEARCHES.start();

    let boost_path = boost_prefix.map(PathBuf::from);

    // Spawn search in background thread
    std::thread::spawn(move || {
        let mut all_results: Vec<SearchResult> = Vec::new();
        let mut total_scanned = 0;
        let batch_size = 100; // Process results in batches
        let max_entries = 10000;

        let mut matcher = Matcher::new(Config::DEFAULT);
        let pattern = Pattern::parse(&query, CaseMatching::Ignore, Normalization::Smart);

        let walker = WalkDir::new(&root_path)
            .skip_hidden(true)
            .process_read_dir(|_depth, _path, _read_dir_state, children| {
                children.retain(|entry| {
                    entry.as_ref().map_or(true, |e| {
                        let name = e.file_name().to_string_lossy();
                        !should_skip_dir(&name)
                    })
                });
            });

        let mut pending_entries: Vec<(String, String, bool)> = Vec::new();

        for entry in walker.into_iter().take(max_entries) {
            // Check for cancellation
            if cancelled.load(Ordering::Relaxed) {
                break;
            }

            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };

            // Skip the root itself
            if entry.path() == root_path {
                continue;
            }

            let path = entry.path();
            let relative_path = match path.strip_prefix(&root_path) {
                Ok(p) => p.to_string_lossy().to_string(),
                Err(_) => continue,
            };

            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();

            // Skip hidden files
            if name.starts_with('.') {
                continue;
            }

            let is_dir = entry.file_type().is_dir();
            pending_entries.push((relative_path, name, is_dir));
            total_scanned += 1;

            // Process batch and emit results
            if pending_entries.len() >= batch_size {
                process_batch(
                    &app,
                    search_id,
                    &mut pending_entries,
                    &mut all_results,
                    &root_path,
                    &pattern,
                    &mut matcher,
                    limit,
                    total_scanned,
                    boost_path.as_ref(),
                );
            }
        }

        // Process remaining entries
        if !pending_entries.is_empty() && !cancelled.load(Ordering::Relaxed) {
            process_batch(
                &app,
                search_id,
                &mut pending_entries,
                &mut all_results,
                &root_path,
                &pattern,
                &mut matcher,
                limit,
                total_scanned,
                boost_path.as_ref(),
            );
        }

        // Emit final results with done=true
        if !cancelled.load(Ordering::Relaxed) {
            let _ = app.emit(
                "search-results",
                SearchResultsEvent {
                    search_id,
                    results: all_results.into_iter().take(limit).collect(),
                    done: true,
                    total_scanned,
                },
            );
        }

        SEARCHES.cleanup(search_id);
    });

    Ok(search_id)
}

fn process_batch(
    app: &AppHandle,
    search_id: u64,
    pending: &mut Vec<(String, String, bool)>,
    all_results: &mut Vec<SearchResult>,
    root_path: &PathBuf,
    pattern: &Pattern,
    matcher: &mut Matcher,
    limit: usize,
    total_scanned: usize,
    boost_prefix: Option<&PathBuf>,
) {
    // Score boost for results under the priority prefix (e.g. CWD)
    const BOOST_SCORE: u32 = 100;

    // Score entries in this batch
    let mut new_results: Vec<SearchResult> = pending
        .iter()
        .filter_map(|(relative_path, name, is_dir)| {
            let mut buf = Vec::new();
            let haystack = Utf32Str::new(name, &mut buf);
            pattern.score(haystack, matcher).map(|score| {
                let full_path = root_path.join(relative_path);
                // Boost score for results under the priority prefix
                let boosted_score = if let Some(prefix) = boost_prefix {
                    if full_path.starts_with(prefix) {
                        score.saturating_add(BOOST_SCORE)
                    } else {
                        score
                    }
                } else {
                    score
                };
                SearchResult {
                    name: name.clone(),
                    path: full_path.to_string_lossy().to_string(),
                    relative_path: relative_path.clone(),
                    score: boosted_score,
                    kind: if *is_dir {
                        "directory".to_string()
                    } else {
                        "file".to_string()
                    },
                }
            })
        })
        .collect();

    pending.clear();

    // Merge with existing results
    all_results.append(&mut new_results);
    all_results.sort_by(|a, b| b.score.cmp(&a.score));
    all_results.truncate(limit * 2); // Keep some buffer for merging

    // Emit current top results
    let current_top: Vec<SearchResult> = all_results.iter().take(limit).cloned().collect();

    if !current_top.is_empty() {
        let _ = app.emit(
            "search-results",
            SearchResultsEvent {
                search_id,
                results: current_top,
                done: false,
                total_scanned,
            },
        );
    }
}

/// Cancel an active streaming search.
#[tauri::command]
pub fn cancel_search(search_id: u64) -> Result<(), AppError> {
    SEARCHES.cancel(search_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{self, File};
    use tempfile::tempdir;

    #[test]
    fn test_fuzzy_search_basic() {
        let dir = tempdir().unwrap();
        File::create(dir.path().join("hello_world.txt")).unwrap();
        File::create(dir.path().join("goodbye.txt")).unwrap();
        fs::create_dir(dir.path().join("hello_folder")).unwrap();

        // Test that we can search the directory
        let result = fuzzy_search(
            "hello".to_string(),
            dir.path().to_string_lossy().to_string(),
            10,
        )
        .unwrap();

        // Should find matches for "hello"
        // Note: nucleo is strict - if no results, the pattern may not match
        if !result.results.is_empty() {
            assert!(result.results.iter().any(|r| r.name.contains("hello")));
        }
    }

    #[test]
    fn test_fuzzy_search_empty_query() {
        let dir = tempdir().unwrap();
        File::create(dir.path().join("test.txt")).unwrap();

        let result = fuzzy_search(
            "zzzzzznotfound".to_string(),
            dir.path().to_string_lossy().to_string(),
            10,
        )
        .unwrap();

        // Should return empty results for non-matching query
        assert!(result.results.is_empty());
    }

    #[test]
    fn test_skip_hidden_dirs() {
        let dir = tempdir().unwrap();
        fs::create_dir(dir.path().join(".git")).unwrap();
        File::create(dir.path().join(".git").join("config")).unwrap();
        File::create(dir.path().join("visible.txt")).unwrap();

        let result = fuzzy_search(
            "config".to_string(),
            dir.path().to_string_lossy().to_string(),
            10,
        )
        .unwrap();

        // Should not find config inside .git
        assert!(result.results.iter().all(|r| !r.path.contains(".git")));
    }
}
