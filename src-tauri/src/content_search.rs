//! Content search module using grep crate (ripgrep library).
//! Issue: tauri-explorer-3a1q, tauri-explorer-5w06, tauri-pkc4, tauri-dbiw

use crate::error::AppError;
use grep_matcher::Matcher;
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
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
    /// 1-based column in UTF-16 code units (matches JS string indexing).
    pub column: u64,
    #[serde(rename = "lineContent")]
    pub line_content: String,
    /// Match start within `line_content`, in UTF-16 code units.
    #[serde(rename = "matchStart")]
    pub match_start: usize,
    /// Match end (exclusive) within `line_content`, in UTF-16 code units.
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
    /// Error message if the search failed mid-run; absent on success.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Registry for active content searches
static CONTENT_SEARCHES: crate::task_registry::TaskRegistry =
    crate::task_registry::TaskRegistry::new();

/// Start a streaming content search using ripgrep.
/// Returns search ID immediately, emits results via 'content-search-results' events.
#[tauri::command]
pub async fn start_content_search(
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

    log::debug!(
        "start_content_search: regex={} case_sensitive={} max={}",
        regex_mode,
        case_sensitive,
        max_results
    );

    if query.is_empty() {
        return Err(AppError::Other("Search query cannot be empty".into()));
    }

    // Build and validate the regex matcher BEFORE spawning so an invalid
    // pattern surfaces as a command error instead of an empty result set.
    let pattern = if regex_mode {
        query
    } else {
        regex::escape(&query)
    };

    let matcher = RegexMatcherBuilder::new()
        .case_insensitive(!case_sensitive)
        .line_terminator(Some(b'\n'))
        .build(&pattern)
        .map_err(|e| AppError::Other(format!("Invalid search pattern: {}", e)))?;

    let matcher = Arc::new(matcher);

    let (search_id, cancelled) = CONTENT_SEARCHES.start();
    let max_results = max_results.clamp(1, 5000);

    // Spawn search in background thread
    std::thread::spawn(move || {
        let result = perform_content_search(
            &app,
            search_id,
            matcher,
            &root_path,
            max_results,
            &cancelled,
        );

        CONTENT_SEARCHES.cleanup(search_id);

        if let Err(e) = result {
            // Emit error event so the frontend can surface mid-run failures
            let _ = app.emit(
                "content-search-results",
                ContentSearchEvent {
                    search_id,
                    results: vec![],
                    done: true,
                    files_searched: 0,
                    total_matches: 0,
                    error: Some(e.to_string()),
                },
            );
            #[cfg(debug_assertions)]
            eprintln!("Content search error: {}", e);
        }
    });

    Ok(search_id)
}

/// Incrementally converts byte offsets to UTF-16 code-unit offsets.
/// Offsets must be fed in non-decreasing order; the cursor carries its
/// position so a match-dense line is scanned once instead of once per offset.
struct Utf16Cursor<'a> {
    chars: std::str::Chars<'a>,
    byte_pos: usize,
    utf16_pos: usize,
}

impl<'a> Utf16Cursor<'a> {
    fn new(s: &'a str) -> Self {
        Self {
            chars: s.chars(),
            byte_pos: 0,
            utf16_pos: 0,
        }
    }

    /// UTF-16 offset for `byte_offset`. Clamps gracefully past end-of-string.
    fn advance_to(&mut self, byte_offset: usize) -> usize {
        while self.byte_pos < byte_offset {
            match self.chars.next() {
                Some(c) => {
                    self.byte_pos += c.len_utf8();
                    self.utf16_pos += c.len_utf16();
                }
                None => break,
            }
        }
        self.utf16_pos
    }
}

/// Find all matches of `matcher` within a single line, appending up to
/// `MAX_MATCHES_PER_FILE` entries to `file_matches`. Offsets in the produced
/// `ContentMatch` are UTF-16 code units into `line_content` (JS indexing).
fn collect_line_matches(
    matcher: &RegexMatcher,
    line_num: u64,
    line: &str,
    file_matches: &mut Vec<ContentMatch>,
) {
    // Trim/truncate once per line, not once per match: the display string is
    // identical for every match on the line.
    let trimmed = line.trim_end();
    let (line_content, clamp_at) = if trimmed.len() > MAX_LINE_LENGTH {
        let end = trimmed.floor_char_boundary(MAX_LINE_LENGTH);
        (format!("{}...", &trimmed[..end]), end)
    } else {
        (trimmed.to_string(), trimmed.len())
    };

    // Matches arrive left-to-right, so byte→UTF-16 conversion can share one
    // forward-only cursor across all matches on the line.
    let mut utf16 = Utf16Cursor::new(&line_content);

    let mut byte_offset = 0;
    while let Ok(Some(m)) = matcher.find(&line.as_bytes()[byte_offset..]) {
        if file_matches.len() >= MAX_MATCHES_PER_FILE {
            return;
        }

        let match_start = byte_offset + m.start();
        let match_end = byte_offset + m.end();

        // Convert byte offsets (clamped to the truncation point) to UTF-16
        // code units for the JS frontend.
        let start_utf16 = utf16.advance_to(match_start.min(clamp_at));
        let end_utf16 = utf16.advance_to(match_end.min(clamp_at));

        file_matches.push(ContentMatch {
            line_number: line_num,
            column: (start_utf16 + 1) as u64,
            line_content: line_content.clone(),
            match_start: start_utf16,
            match_end: end_utf16,
        });

        // Advance past the match; a zero-width match (e.g. `a*`, `()`) must
        // advance by at least one character to avoid looping in place.
        byte_offset = if match_end > byte_offset {
            match_end
        } else {
            match line[byte_offset..].chars().next() {
                Some(c) => byte_offset + c.len_utf8(),
                None => break,
            }
        };
        if byte_offset >= line.len() {
            break;
        }
    }
}

fn perform_content_search(
    app: &AppHandle,
    search_id: u64,
    matcher: Arc<RegexMatcher>,
    root_path: &std::path::Path,
    max_results: usize,
    cancelled: &Arc<AtomicBool>,
) -> Result<(), AppError> {
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
            // binary_detection::quit stops on first NUL byte. Memory maps are deliberately
            // disabled: a file truncated mid-search would raise SIGBUS and kill the process.
            let mut searcher = SearcherBuilder::new()
                .binary_detection(BinaryDetection::quit(b'\x00'))
                .memory_map(MmapChoice::never())
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
                if entry.file_type().is_none_or(|ft| ft.is_dir()) {
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

                        collect_line_matches(matcher.as_ref(), line_num, line, &mut file_matches);
                        Ok(file_matches.len() < MAX_MATCHES_PER_FILE)
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
                    error: None,
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
                error: None,
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
pub async fn cancel_content_search(search_id: u64) -> Result<(), AppError> {
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
            .memory_map(MmapChoice::never())
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
    fn test_utf16_offsets_for_non_ascii_line() {
        let matcher = RegexMatcherBuilder::new()
            .case_insensitive(false)
            .line_terminator(Some(b'\n'))
            .build("wörld")
            .unwrap();

        // "héllo " is 7 bytes (é = 2 bytes) but only 6 UTF-16 code units.
        let mut matches = Vec::new();
        collect_line_matches(&matcher, 1, "héllo wörld\n", &mut matches);

        assert_eq!(matches.len(), 1);
        let m = &matches[0];
        assert_eq!(m.match_start, 6, "start must be UTF-16 units, not bytes");
        assert_eq!(m.match_end, 11, "wörld is 5 UTF-16 units");
        assert_eq!(m.column, 7);

        // Offsets must slice the line correctly when treated as a JS string.
        let utf16: Vec<u16> = m.line_content.encode_utf16().collect();
        let highlighted = String::from_utf16(&utf16[m.match_start..m.match_end]).unwrap();
        assert_eq!(highlighted, "wörld");
    }

    #[test]
    fn test_utf16_offsets_for_multiple_matches_on_one_line() {
        let matcher = RegexMatcherBuilder::new()
            .case_insensitive(false)
            .line_terminator(Some(b'\n'))
            .build("ab")
            .unwrap();

        // Multi-byte chars between matches: the shared UTF-16 cursor must
        // produce the same offsets as independent per-match conversion.
        let mut matches = Vec::new();
        collect_line_matches(&matcher, 1, "ab é ab 日 ab\n", &mut matches);

        assert_eq!(matches.len(), 3);
        for m in &matches {
            let utf16: Vec<u16> = m.line_content.encode_utf16().collect();
            let s = String::from_utf16(&utf16[m.match_start..m.match_end]).unwrap();
            assert_eq!(s, "ab");
        }
        assert_eq!(matches[0].match_start, 0);
        assert_eq!(matches[1].match_start, 5);
        assert_eq!(matches[2].match_start, 10);
    }

    #[test]
    fn test_zero_width_matches_advance() {
        let matcher = RegexMatcherBuilder::new()
            .case_insensitive(false)
            .line_terminator(Some(b'\n'))
            .build("a*")
            .unwrap();

        let mut matches = Vec::new();
        collect_line_matches(&matcher, 1, "xyz\n", &mut matches);

        // One zero-width match per position — not MAX_MATCHES_PER_FILE
        // duplicates piled up at the same column.
        assert!(
            matches.len() <= 4,
            "zero-width matches must advance, got {} matches",
            matches.len()
        );
        let columns: Vec<u64> = matches.iter().map(|m| m.column).collect();
        let mut deduped = columns.clone();
        deduped.dedup();
        assert_eq!(columns, deduped, "matches must not repeat a column");
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
