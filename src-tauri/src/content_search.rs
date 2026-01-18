//! Content search module using grep crate (ripgrep library).
//! Issue: tauri-explorer-3a1q, tauri-explorer-5w06

use grep_matcher::Matcher;
use grep_regex::RegexMatcher;
use grep_searcher::sinks::UTF8;
use grep_searcher::Searcher;
use ignore::{WalkBuilder, WalkState};
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

/// Maximum matches to collect per file to prevent runaway processing
const MAX_MATCHES_PER_FILE: usize = 50;

/// A single match within a file.
#[derive(Debug, Clone, Serialize)]
pub struct ContentMatch {
    #[serde(rename = "lineNumber")]
    pub line_number: u64,
    pub column: u64,
    #[serde(rename = "lineContent")]
    pub line_content: String,
    #[serde(rename = "matchStart")]
    pub match_start: usize,
    #[serde(rename = "matchEnd")]
    pub match_end: usize,
}

/// Search result for a single file containing matches.
#[derive(Debug, Clone, Serialize)]
pub struct ContentSearchResult {
    pub path: String,
    #[serde(rename = "relativePath")]
    pub relative_path: String,
    pub matches: Vec<ContentMatch>,
}

/// Event payload for streaming content search results.
#[derive(Debug, Clone, Serialize)]
pub struct ContentSearchEvent {
    #[serde(rename = "searchId")]
    pub search_id: u64,
    pub results: Vec<ContentSearchResult>,
    pub done: bool,
    #[serde(rename = "filesSearched")]
    pub files_searched: usize,
    #[serde(rename = "totalMatches")]
    pub total_matches: usize,
}

/// Global state for active content searches
static NEXT_CONTENT_SEARCH_ID: AtomicU64 = AtomicU64::new(1);
static ACTIVE_CONTENT_SEARCHES: OnceLock<Mutex<HashMap<u64, Arc<AtomicBool>>>> = OnceLock::new();

fn get_active_content_searches() -> &'static Mutex<HashMap<u64, Arc<AtomicBool>>> {
    ACTIVE_CONTENT_SEARCHES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Start a streaming content search using ripgrep.
/// Returns search ID immediately, emits results via 'content-search-results' events.
#[tauri::command]
pub fn start_content_search(
    app: AppHandle,
    query: String,
    root: String,
    case_sensitive: bool,
    regex_mode: bool,
    max_results: usize,
) -> Result<u64, String> {
    let root_path = PathBuf::from(&root);

    if !root_path.exists() {
        return Err("Directory not found".to_string());
    }

    if !root_path.is_dir() {
        return Err("Path is not a directory".to_string());
    }

    if query.is_empty() {
        return Err("Search query cannot be empty".to_string());
    }

    let search_id = NEXT_CONTENT_SEARCH_ID.fetch_add(1, Ordering::SeqCst);
    let max_results = max_results.min(1000).max(1);

    // Create cancellation flag
    let cancelled = Arc::new(AtomicBool::new(false));
    {
        let mut searches = get_active_content_searches().lock().unwrap();
        searches.insert(search_id, cancelled.clone());
    }

    // Spawn search in background thread
    std::thread::spawn(move || {
        let result = perform_content_search(
            &app,
            search_id,
            &query,
            &root_path,
            case_sensitive,
            regex_mode,
            max_results,
            &cancelled,
        );

        // Clean up
        {
            let mut searches = get_active_content_searches().lock().unwrap();
            searches.remove(&search_id);
        }

        if let Err(e) = result {
            // Emit error event
            let _ = app.emit(
                "content-search-results",
                ContentSearchEvent {
                    search_id,
                    results: vec![],
                    done: true,
                    files_searched: 0,
                    total_matches: 0,
                },
            );
            eprintln!("Content search error: {}", e);
        }
    });

    Ok(search_id)
}

fn perform_content_search(
    app: &AppHandle,
    search_id: u64,
    query: &str,
    root_path: &std::path::Path,
    case_sensitive: bool,
    regex_mode: bool,
    max_results: usize,
    cancelled: &Arc<AtomicBool>,
) -> Result<(), String> {
    // Build the regex matcher
    let pattern = if regex_mode {
        query.to_string()
    } else {
        // Escape regex special characters for literal search
        regex::escape(query)
    };

    let matcher = if case_sensitive {
        RegexMatcher::new(&pattern)
    } else {
        RegexMatcher::new_line_matcher(&format!("(?i){}", pattern))
    }
    .map_err(|e| format!("Invalid search pattern: {}", e))?;

    let matcher = Arc::new(matcher);

    // Shared counters for parallel access
    let files_searched = Arc::new(AtomicUsize::new(0));
    let total_matches = Arc::new(AtomicUsize::new(0));

    // Channel for collecting results from parallel workers
    let (tx, rx) = mpsc::channel::<ContentSearchResult>();

    // Use parallel walker for multi-core file processing
    let walker = WalkBuilder::new(root_path)
        .hidden(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .threads(num_cpus::get().min(8)) // Use available cores, cap at 8
        .build_parallel();

    let root_path = root_path.to_path_buf();

    // Spawn parallel workers
    let cancelled_clone = cancelled.clone();
    let files_searched_clone = files_searched.clone();
    let total_matches_clone = total_matches.clone();

    std::thread::spawn(move || {
        walker.run(|| {
            let matcher = matcher.clone();
            let cancelled = cancelled_clone.clone();
            let tx = tx.clone();
            let root_path = root_path.clone();
            let files_searched = files_searched_clone.clone();
            let total_matches = total_matches_clone.clone();

            Box::new(move |entry| {
                // Check for cancellation
                if cancelled.load(Ordering::Relaxed) {
                    return WalkState::Quit;
                }

                // Check global max results
                if total_matches.load(Ordering::Relaxed) >= max_results {
                    return WalkState::Quit;
                }

                let entry = match entry {
                    Ok(e) => e,
                    Err(_) => return WalkState::Continue,
                };

                let path = entry.path();

                // Skip directories
                if path.is_dir() {
                    return WalkState::Continue;
                }

                // Skip binary files
                if is_binary_file(path) {
                    return WalkState::Continue;
                }

                files_searched.fetch_add(1, Ordering::Relaxed);

                // Search the file with per-file match limit
                let mut file_matches: Vec<ContentMatch> = Vec::new();
                let mut searcher = Searcher::new();

                let _ = searcher.search_path(
                    matcher.as_ref(),
                    path,
                    UTF8(|line_num, line| {
                        // Check per-file limit
                        if file_matches.len() >= MAX_MATCHES_PER_FILE {
                            return Ok(false); // Stop searching this file
                        }

                        let mut byte_offset = 0;
                        while let Ok(Some(m)) = matcher.find(&line.as_bytes()[byte_offset..]) {
                            if file_matches.len() >= MAX_MATCHES_PER_FILE {
                                return Ok(false);
                            }

                            let match_start = byte_offset + m.start();
                            let match_end = byte_offset + m.end();

                            file_matches.push(ContentMatch {
                                line_number: line_num,
                                column: (match_start + 1) as u64,
                                line_content: line.trim_end().to_string(),
                                match_start,
                                match_end,
                            });

                            byte_offset = match_end;
                            if byte_offset >= line.len() {
                                break;
                            }
                        }
                        Ok(true)
                    }),
                );

                if !file_matches.is_empty() {
                    let relative_path = path
                        .strip_prefix(&root_path)
                        .map(|p| p.to_string_lossy().to_string())
                        .unwrap_or_else(|_| path.to_string_lossy().to_string());

                    total_matches.fetch_add(file_matches.len(), Ordering::Relaxed);

                    let _ = tx.send(ContentSearchResult {
                        path: path.to_string_lossy().to_string(),
                        relative_path,
                        matches: file_matches,
                    });
                }

                WalkState::Continue
            })
        });
        // tx drops here, signaling channel close
    });

    // Collect results and emit batches (runs in original thread)
    let mut pending_results: Vec<ContentSearchResult> = Vec::new();
    let batch_size = 10;

    while let Ok(result) = rx.recv() {
        if cancelled.load(Ordering::Relaxed) {
            break;
        }

        pending_results.push(result);

        // Emit batch when threshold reached (delta only, not accumulated)
        if pending_results.len() >= batch_size {
            let _ = app.emit(
                "content-search-results",
                ContentSearchEvent {
                    search_id,
                    results: std::mem::take(&mut pending_results), // Move, don't clone
                    done: false,
                    files_searched: files_searched.load(Ordering::Relaxed),
                    total_matches: total_matches.load(Ordering::Relaxed),
                },
            );
        }
    }

    // Emit final results
    if !cancelled.load(Ordering::Relaxed) {
        let _ = app.emit(
            "content-search-results",
            ContentSearchEvent {
                search_id,
                results: pending_results, // Move remaining results
                done: true,
                files_searched: files_searched.load(Ordering::Relaxed),
                total_matches: total_matches.load(Ordering::Relaxed),
            },
        );
    }

    Ok(())
}

/// Simple heuristic to detect binary files by extension.
fn is_binary_file(path: &std::path::Path) -> bool {
    let binary_extensions = [
        "exe", "dll", "so", "dylib", "bin", "o", "a", "lib", "obj", "class", "jar", "war", "ear",
        "zip", "tar", "gz", "bz2", "xz", "7z", "rar", "iso", "dmg", "img", "pdf", "doc", "docx",
        "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "png", "jpg", "jpeg", "gif", "bmp",
        "ico", "svg", "webp", "mp3", "mp4", "avi", "mkv", "mov", "wmv", "flv", "wav", "flac",
        "ogg", "woff", "woff2", "ttf", "otf", "eot", "pyc", "pyo", "wasm", "node",
    ];

    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| binary_extensions.contains(&e.to_lowercase().as_str()))
        .unwrap_or(false)
}

/// Cancel an active content search.
#[tauri::command]
pub fn cancel_content_search(search_id: u64) -> Result<(), String> {
    let searches = get_active_content_searches().lock().unwrap();
    if let Some(cancelled) = searches.get(&search_id) {
        cancelled.store(true, Ordering::Relaxed);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::io::Write;
    use tempfile::tempdir;

    #[test]
    fn test_is_binary_file() {
        assert!(is_binary_file(std::path::Path::new("test.png")));
        assert!(is_binary_file(std::path::Path::new("test.exe")));
        assert!(!is_binary_file(std::path::Path::new("test.rs")));
        assert!(!is_binary_file(std::path::Path::new("test.txt")));
        assert!(!is_binary_file(std::path::Path::new("test.js")));
    }

    #[test]
    fn test_content_match_serialization() {
        let m = ContentMatch {
            line_number: 10,
            column: 5,
            line_content: "hello world".to_string(),
            match_start: 0,
            match_end: 5,
        };

        let json = serde_json::to_string(&m).unwrap();
        assert!(json.contains("\"lineNumber\":10"));
        assert!(json.contains("\"lineContent\":\"hello world\""));
    }
}
