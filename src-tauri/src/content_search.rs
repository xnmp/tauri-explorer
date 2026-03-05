//! Content search module using grep crate (ripgrep library).
//! Issue: tauri-explorer-3a1q, tauri-explorer-5w06, tauri-pkc4, tauri-dbiw

use crate::error::AppError;
use grep_matcher::Matcher;
use grep_regex::RegexMatcherBuilder;
use grep_searcher::sinks::UTF8;
use grep_searcher::{BinaryDetection, MmapChoice, SearcherBuilder};
use ignore::{WalkBuilder, WalkState};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc};
use tauri::{AppHandle, Emitter};

/// Maximum matches to collect per file to prevent runaway processing
const MAX_MATCHES_PER_FILE: usize = 50;

/// Maximum characters to include in line_content before truncation
const MAX_LINE_LENGTH: usize = 300;

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

/// Registry for active content searches
static CONTENT_SEARCHES: crate::task_registry::TaskRegistry = crate::task_registry::TaskRegistry::new();

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
) -> Result<u64, AppError> {
    let root_path = PathBuf::from(&root);

    if !root_path.exists() {
        return Err(AppError::NotFound(root));
    }

    if !root_path.is_dir() {
        return Err(AppError::InvalidPath(format!("Not a directory: {}", root)));
    }

    if query.is_empty() {
        return Err(AppError::Other("Search query cannot be empty".into()));
    }

    let (search_id, cancelled) = CONTENT_SEARCHES.start();
    let max_results = max_results.min(5000).max(1);

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

        CONTENT_SEARCHES.cleanup(search_id);

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
) -> Result<(), AppError> {
    // Build the regex matcher
    let pattern = if regex_mode {
        query.to_string()
    } else {
        regex::escape(query)
    };

    let matcher = RegexMatcherBuilder::new()
        .case_insensitive(!case_sensitive)
        .line_terminator(Some(b'\n'))
        .build(&pattern)
        .map_err(|e| AppError::Other(format!("Invalid search pattern: {}", e)))?;

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

            // Create searcher once per worker thread: avoids buffer re-allocation per file.
            // mmap avoids read syscalls; binary_detection::quit stops on first NUL byte.
            let mut searcher = SearcherBuilder::new()
                .binary_detection(BinaryDetection::quit(b'\x00'))
                .memory_map(unsafe { MmapChoice::auto() })
                .build();

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

                // Skip directories using file_type() (avoids extra stat syscall)
                if entry.file_type().map_or(true, |ft| ft.is_dir()) {
                    return WalkState::Continue;
                }

                // Fast pre-filter: skip known-binary extensions before opening the file
                if is_binary_file(path) {
                    return WalkState::Continue;
                }

                files_searched.fetch_add(1, Ordering::Relaxed);

                // Search the file with per-file match limit
                let mut file_matches: Vec<ContentMatch> = Vec::new();

                let _ = searcher.search_path(
                    matcher.as_ref(),
                    path,
                    UTF8(|line_num, line| {
                        // Check per-file limit
                        if file_matches.len() >= MAX_MATCHES_PER_FILE {
                            return Ok(false);
                        }

                        let mut byte_offset = 0;
                        while let Ok(Some(m)) = matcher.find(&line.as_bytes()[byte_offset..]) {
                            if file_matches.len() >= MAX_MATCHES_PER_FILE {
                                return Ok(false);
                            }

                            let match_start = byte_offset + m.start();
                            let match_end = byte_offset + m.end();

                            // Truncate long lines before IPC serialization
                            let trimmed = line.trim_end();
                            let (line_content, clamped_start, clamped_end) =
                                if trimmed.len() > MAX_LINE_LENGTH {
                                    let end = trimmed.floor_char_boundary(MAX_LINE_LENGTH);
                                    (
                                        format!("{}...", &trimmed[..end]),
                                        match_start.min(end),
                                        match_end.min(end),
                                    )
                                } else {
                                    (trimmed.to_string(), match_start, match_end)
                                };

                            file_matches.push(ContentMatch {
                                line_number: line_num,
                                column: (clamped_start + 1) as u64,
                                line_content,
                                match_start: clamped_start,
                                match_end: clamped_end,
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

    // Collect results and emit time-based batches (runs in original thread).
    // Adaptive batching: 16ms for fast first-paint, then 100ms steady state.
    let mut pending_results: Vec<ContentSearchResult> = Vec::new();
    let mut batch_interval = std::time::Duration::from_millis(16);
    let steady_interval = std::time::Duration::from_millis(100);
    let mut last_emit = std::time::Instant::now();

    loop {
        let should_flush = match rx.recv_timeout(batch_interval) {
            Ok(result) => {
                pending_results.push(result);
                last_emit.elapsed() >= batch_interval
            }
            Err(mpsc::RecvTimeoutError::Timeout) => true,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        };

        if should_flush && !pending_results.is_empty() {
            let _ = app.emit(
                "content-search-results",
                ContentSearchEvent {
                    search_id,
                    results: std::mem::take(&mut pending_results),
                    done: false,
                    files_searched: files_searched.load(Ordering::Relaxed),
                    total_matches: total_matches.load(Ordering::Relaxed),
                },
            );
            last_emit = std::time::Instant::now();
            batch_interval = steady_interval;
        }

        if cancelled.load(Ordering::Relaxed) {
            break;
        }
    }

    // Emit final results
    if !cancelled.load(Ordering::Relaxed) {
        let _ = app.emit(
            "content-search-results",
            ContentSearchEvent {
                search_id,
                results: pending_results,
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
pub fn cancel_content_search(search_id: u64) -> Result<(), AppError> {
    CONTENT_SEARCHES.cancel(search_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use grep_matcher::Matcher;
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

    #[test]
    fn test_searcher_builder_with_mmap_and_binary_detection() {
        let dir = tempdir().unwrap();

        // Create a text file with searchable content
        let text_path = dir.path().join("test.txt");
        let mut f = File::create(&text_path).unwrap();
        writeln!(f, "hello world").unwrap();
        writeln!(f, "goodbye world").unwrap();

        // Create a binary file (contains NUL bytes)
        let bin_path = dir.path().join("test.bin");
        let mut f = File::create(&bin_path).unwrap();
        f.write_all(b"hello\x00binary\x00data").unwrap();

        let matcher = RegexMatcherBuilder::new()
            .case_insensitive(true)
            .line_terminator(Some(b'\n'))
            .build("hello")
            .unwrap();

        let mut searcher = SearcherBuilder::new()
            .binary_detection(BinaryDetection::quit(b'\x00'))
            .memory_map(unsafe { MmapChoice::auto() })
            .build();

        // Text file: should find matches
        let mut text_matches = 0;
        let _ = searcher.search_path(
            &matcher,
            &text_path,
            UTF8(|_line_num, _line| {
                text_matches += 1;
                Ok(true)
            }),
        );
        assert_eq!(text_matches, 1);

        // Binary file: should quit early on NUL byte (may find 0 or 1 match
        // depending on whether NUL appears before or after the match)
        let mut bin_matches = 0;
        let _ = searcher.search_path(
            &matcher,
            &bin_path,
            UTF8(|_line_num, _line| {
                bin_matches += 1;
                Ok(true)
            }),
        );
        // Binary detection should prevent normal multi-line searching
        assert!(bin_matches <= 1);
    }

    #[test]
    fn test_line_truncation() {
        let long_line = "a".repeat(500);
        let trimmed = long_line.trim_end();
        if trimmed.len() > MAX_LINE_LENGTH {
            let end = trimmed.floor_char_boundary(MAX_LINE_LENGTH);
            let truncated = format!("{}...", &trimmed[..end]);
            assert_eq!(truncated.len(), MAX_LINE_LENGTH + 3); // 300 + "..."
        }
    }

    #[test]
    fn test_regex_matcher_builder_case_insensitive() {
        let matcher = RegexMatcherBuilder::new()
            .case_insensitive(true)
            .line_terminator(Some(b'\n'))
            .build("hello")
            .unwrap();

        // Should match regardless of case
        let hay = b"Hello World";
        let m = matcher.find(hay).unwrap();
        assert!(m.is_some());

        let hay = b"HELLO WORLD";
        let m = matcher.find(hay).unwrap();
        assert!(m.is_some());
    }

    #[test]
    fn test_regex_matcher_builder_case_sensitive() {
        let matcher = RegexMatcherBuilder::new()
            .case_insensitive(false)
            .line_terminator(Some(b'\n'))
            .build("hello")
            .unwrap();

        let hay = b"Hello World";
        let m = matcher.find(hay).unwrap();
        assert!(m.is_none());

        let hay = b"hello world";
        let m = matcher.find(hay).unwrap();
        assert!(m.is_some());
    }
}
