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

/// Safety cap for the non-streaming path which collects entries into memory.
/// High enough to cover any normal home directory tree; prevents OOM if
/// the search root is accidentally `/` or a network mount. The streaming
/// path (used by the UI) has its own cancellation mechanism and doesn't
/// need this cap.
const WALK_SAFETY_CAP: usize = 500_000;

/// Collect file/directory entries under `root_path` using jwalk.
/// Returns `(relative_path, name, is_dir)` tuples.
/// Capped at `WALK_SAFETY_CAP` to bound memory for the non-streaming path.
fn walk_entries(root_path: &PathBuf) -> Vec<(String, String, bool)> {
    let mut entries: Vec<(String, String, bool)> = Vec::new();

    let walker = WalkDir::new(root_path)
        .skip_hidden(true)
        .process_read_dir(|_depth, _path, _read_dir_state, children| {
            for entry in children.iter_mut() {
                if let Ok(e) = entry {
                    let name = e.file_name().to_string_lossy();
                    if SKIP_DIRS.contains(&name.as_ref()) {
                        e.read_children_path = None;
                    }
                }
            }
        });

    for entry in walker.into_iter().take(WALK_SAFETY_CAP) {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };

        // Skip the root itself
        if entry.path() == *root_path {
            continue;
        }

        let path = entry.path();
        let relative_path = match path.strip_prefix(root_path) {
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

    entries
}

/// Directory bonus: directories are ranked higher than files with equal scores
/// since users more commonly navigate to folders from QuickOpen.
const DIRECTORY_BONUS: u32 = 30;

/// Score an entry against a query. Returns Some(score) if matched, None otherwise.
/// Uses nucleo fuzzy matching with a case-insensitive substring fallback.
/// Shallower entries (fewer path components) get a depth bonus so items
/// closer to the search root rank higher than deeply nested ones.
/// Directories get an additional bonus to rank above files.
fn score_entry(
    name: &str,
    relative_path: &str,
    is_dir: bool,
    query_lower: &str,
    pattern: &Pattern,
    matcher: &mut Matcher,
) -> Option<u32> {
    let mut buf = Vec::new();
    let haystack = Utf32Str::new(name, &mut buf);
    let base_score = if let Some(score) = pattern.score(haystack, matcher) {
        score
    } else if name.to_lowercase().contains(query_lower)
        || relative_path.to_lowercase().contains(query_lower)
    {
        1
    } else {
        return None;
    };

    // Depth bonus: depth 1 (direct child) gets +50, each extra level reduces by 5.
    // Clamped to 0 so deep items are never penalized below their base score.
    let depth = relative_path.matches('/').count() + 1;
    let depth_bonus = (50u32).saturating_sub((depth as u32 - 1) * 5);
    let dir_bonus = if is_dir { DIRECTORY_BONUS } else { 0 };
    Some(base_score.saturating_add(depth_bonus).saturating_add(dir_bonus))
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
    let entries = walk_entries(&root_path);

    if entries.is_empty() {
        return Ok(SearchResponse { results: vec![] });
    }

    let mut matcher = Matcher::new(Config::DEFAULT);
    let pattern = Pattern::parse(&query, CaseMatching::Ignore, Normalization::Smart);
    let query_lower = query.to_lowercase();

    let mut scored: Vec<(u32, usize)> = entries
        .iter()
        .enumerate()
        .filter_map(|(idx, (relative_path, name, is_dir))| {
            score_entry(name, relative_path, *is_dir, &query_lower, &pattern, &mut matcher)
                .map(|score| (score, idx))
        })
        .collect();

    scored.sort_by(|a, b| b.0.cmp(&a.0));

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
        let batch_size = 500;

        let query_lower = query.to_lowercase();
        let mut matcher = Matcher::new(Config::DEFAULT);
        let pattern = Pattern::parse(&query, CaseMatching::Ignore, Normalization::Smart);

        let walker = WalkDir::new(&root_path)
            .skip_hidden(true)
            .process_read_dir(|_depth, _path, _read_dir_state, children| {
                // Don't remove skip-listed dirs — they should still appear as
                // search results. Instead, prevent descent by clearing
                // read_children_path so their contents aren't walked.
                for entry in children.iter_mut() {
                    if let Ok(e) = entry {
                        let name = e.file_name().to_string_lossy();
                        if SKIP_DIRS.contains(&name.as_ref()) {
                            e.read_children_path = None;
                        }
                    }
                }
            });

        let mut pending_entries: Vec<(String, String, bool)> = Vec::new();

        for entry in walker {
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
                    &query_lower,
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
                    &query_lower,
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
    query_lower: &str,
) {
    // Score boost for results under the priority prefix (e.g. CWD)
    const BOOST_SCORE: u32 = 100;

    let mut new_results: Vec<SearchResult> = pending
        .iter()
        .filter_map(|(relative_path, name, is_dir)| {
            let score = score_entry(name, relative_path, *is_dir, query_lower, pattern, matcher)?;
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
            Some(SearchResult {
                name: name.clone(),
                path: full_path.to_string_lossy().to_string(),
                relative_path: relative_path.clone(),
                score: boosted_score,
                kind: if *is_dir {
                    "directory".to_string()
                } else {
                    "file".to_string()
                },
            })
        })
        .collect();

    pending.clear();

    // Merge with existing results — keep a generous buffer so subdirectory
    // matches from later batches aren't prematurely dropped.
    all_results.append(&mut new_results);
    all_results.sort_by(|a, b| b.score.cmp(&a.score));
    all_results.truncate(limit * 10);

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

    /// Helper: create a visible subdirectory inside a tempdir (tempdir names
    /// start with `.tmp` which jwalk's `skip_hidden` would filter).
    fn visible_root(dir: &tempfile::TempDir) -> std::path::PathBuf {
        let root = dir.path().join("root");
        fs::create_dir(&root).unwrap();
        root
    }

    /// Helper: format results for assertion messages.
    fn fmt_results(results: &[SearchResult]) -> Vec<String> {
        results
            .iter()
            .map(|r| format!("{} ({}) @ {} [score={}]", r.name, r.kind, r.relative_path, r.score))
            .collect()
    }

    // ── Walker tests ─────────────────────────────────────────────────────

    #[test]
    fn test_walk_entries_finds_subdirectories() {
        let dir = tempdir().unwrap();
        let root = visible_root(&dir);
        build_project_tree(&root);

        let entries = walk_entries(&PathBuf::from(&root));

        // Verify we collected entries from all depths
        let names: Vec<&str> = entries.iter().map(|e| e.1.as_str()).collect();
        let rel_paths: Vec<&str> = entries.iter().map(|e| e.0.as_str()).collect();

        // Root-level items
        assert!(names.contains(&"README.md"), "Should find root file");
        assert!(names.contains(&"src"), "Should find root dir");

        // Depth-2 items
        assert!(names.contains(&"components"), "Should find src/components");
        assert!(names.contains(&"utils"), "Should find src/utils");

        // Depth-3 items
        assert!(names.contains(&"Button"), "Should find src/components/Button");
        assert!(names.contains(&"Modal"), "Should find src/components/Modal");

        // Depth-4 items (files inside deeply nested dirs)
        assert!(names.contains(&"Button.test.ts"), "Should find deeply nested file");

        // Check that relative paths are correct
        assert!(
            rel_paths.contains(&"src/components/Button"),
            "Relative path should be correct for nested dir, got: {:?}",
            rel_paths
        );
    }

    #[test]
    fn test_walk_entries_with_duplicates() {
        let dir = tempdir().unwrap();
        let root = visible_root(&dir);

        // Create "abc" at multiple levels
        fs::create_dir_all(root.join("folder1/abc")).unwrap();
        File::create(root.join("folder1/abc/data.txt")).unwrap();
        fs::create_dir_all(root.join("folder1/sub1/abc")).unwrap();
        File::create(root.join("folder1/sub1/abc/data.txt")).unwrap();
        fs::create_dir(root.join("folder2")).unwrap();
        File::create(root.join("folder2/abc.txt")).unwrap();

        let entries = walk_entries(&PathBuf::from(&root));

        // Count "abc" directories
        let abc_dirs: Vec<&(String, String, bool)> = entries
            .iter()
            .filter(|(_, name, is_dir)| name == "abc" && *is_dir)
            .collect();
        assert_eq!(
            abc_dirs.len(),
            2,
            "Should find both 'abc' directories, entries: {:?}",
            entries.iter().map(|(r, n, d)| format!("{n} @ {r} dir={d}")).collect::<Vec<_>>()
        );

        // Count "abc.txt" files
        let abc_files: Vec<_> = entries
            .iter()
            .filter(|(_, name, is_dir)| name == "abc.txt" && !*is_dir)
            .collect();
        assert_eq!(abc_files.len(), 1, "Should find abc.txt file");
    }

    #[test]
    fn test_walk_entries_large_tree() {
        let dir = tempdir().unwrap();
        let root = visible_root(&dir);

        // Create 200 files in root
        for i in 0..200 {
            File::create(root.join(format!("file_{:04}.txt", i))).unwrap();
        }
        // Create target deep in tree
        fs::create_dir_all(root.join("a/b/c/d/target_folder")).unwrap();
        File::create(root.join("a/b/c/d/target_folder/payload.txt")).unwrap();

        let entries = walk_entries(&PathBuf::from(&root));

        // Must find the deeply nested folder despite 200 root siblings
        assert!(
            entries.iter().any(|(_, name, is_dir)| name == "target_folder" && *is_dir),
            "Should find deeply nested folder. Total entries: {}. Dirs found: {:?}",
            entries.len(),
            entries.iter().filter(|(_, _, d)| *d).map(|(r, n, _)| format!("{n} @ {r}")).collect::<Vec<_>>()
        );
    }

    // ── Search tests ────────────────────────────────────────────────────

    #[test]
    fn test_fuzzy_search_basic() {
        let dir = tempdir().unwrap();
        let root = visible_root(&dir);
        File::create(root.join("hello_world.txt")).unwrap();
        File::create(root.join("goodbye.txt")).unwrap();
        fs::create_dir(root.join("hello_folder")).unwrap();

        let result = fuzzy_search("hello".into(), root.to_string_lossy().into(), 10).unwrap();

        assert!(
            result.results.iter().any(|r| r.name.contains("hello")),
            "Should find matches for 'hello', got: {:?}",
            fmt_results(&result.results)
        );
    }

    #[test]
    fn test_fuzzy_search_no_match() {
        let dir = tempdir().unwrap();
        let root = visible_root(&dir);
        File::create(root.join("test.txt")).unwrap();

        let result =
            fuzzy_search("zzzzzznotfound".into(), root.to_string_lossy().into(), 10).unwrap();
        assert!(result.results.is_empty());
    }

    #[test]
    fn test_skip_hidden_dirs() {
        let dir = tempdir().unwrap();
        let root = visible_root(&dir);
        fs::create_dir(root.join(".git")).unwrap();
        File::create(root.join(".git").join("config")).unwrap();
        File::create(root.join("visible.txt")).unwrap();

        let result = fuzzy_search("config".into(), root.to_string_lossy().into(), 10).unwrap();
        assert!(result.results.iter().all(|r| !r.path.contains(".git")));
    }

    #[test]
    fn test_substring_fallback_always_matches() {
        let dir = tempdir().unwrap();
        let root = visible_root(&dir);
        File::create(root.join("my-component.test.tsx")).unwrap();
        File::create(root.join("README.md")).unwrap();
        fs::create_dir(root.join("src")).unwrap();
        File::create(root.join("src").join("utils.ts")).unwrap();

        let result =
            fuzzy_search("component".into(), root.to_string_lossy().into(), 10).unwrap();
        assert!(
            result.results.iter().any(|r| r.name == "my-component.test.tsx"),
            "Substring match should work, got: {:?}",
            fmt_results(&result.results)
        );

        let result = fuzzy_search("readme".into(), root.to_string_lossy().into(), 10).unwrap();
        assert!(
            result.results.iter().any(|r| r.name == "README.md"),
            "Case-insensitive substring match should work"
        );
    }

    // ── Larger tree with subdirectories ──────────────────────────────────

    /// Build a realistic project tree:
    ///   root/
    ///     src/
    ///       components/
    ///         Button/
    ///           index.ts
    ///           Button.test.ts
    ///         Modal/
    ///           index.ts
    ///       utils/
    ///         helpers.ts
    ///         format.ts
    ///     packages/
    ///       core/
    ///         lib.ts
    ///         core.test.ts
    ///       cli/
    ///         main.ts
    ///     tests/
    ///       integration/
    ///         api.test.ts
    ///     docs/
    ///       guide.md
    ///     scripts/
    ///       deploy.sh
    ///       setup.sh
    ///     README.md
    ///     package.json
    fn build_project_tree(root: &std::path::Path) {
        let dirs = [
            "src/components/Button",
            "src/components/Modal",
            "src/utils",
            "packages/core",
            "packages/cli",
            "tests/integration",
            "docs",
            "scripts",
        ];
        for d in &dirs {
            fs::create_dir_all(root.join(d)).unwrap();
        }
        let files = [
            "src/components/Button/index.ts",
            "src/components/Button/Button.test.ts",
            "src/components/Modal/index.ts",
            "src/utils/helpers.ts",
            "src/utils/format.ts",
            "packages/core/lib.ts",
            "packages/core/core.test.ts",
            "packages/cli/main.ts",
            "tests/integration/api.test.ts",
            "docs/guide.md",
            "scripts/deploy.sh",
            "scripts/setup.sh",
            "README.md",
            "package.json",
        ];
        for f in &files {
            File::create(root.join(f)).unwrap();
        }
    }

    #[test]
    fn test_finds_folders_in_subdirectories() {
        let dir = tempdir().unwrap();
        let root = visible_root(&dir);
        build_project_tree(&root);

        // Deeply nested folder
        let result = fuzzy_search("Button".into(), root.to_string_lossy().into(), 20).unwrap();
        assert!(
            result.results.iter().any(|r| r.name == "Button" && r.kind == "directory"),
            "Should find folder 'Button' in subdirectory, got: {:?}",
            fmt_results(&result.results)
        );

        // Another nested folder
        let result = fuzzy_search("core".into(), root.to_string_lossy().into(), 20).unwrap();
        assert!(
            result.results.iter().any(|r| r.name == "core" && r.kind == "directory"),
            "Should find folder 'core' in subdirectory, got: {:?}",
            fmt_results(&result.results)
        );

        // Nested folder + file that share the name
        let result =
            fuzzy_search("integration".into(), root.to_string_lossy().into(), 20).unwrap();
        assert!(
            result
                .results
                .iter()
                .any(|r| r.name == "integration" && r.kind == "directory"),
            "Should find folder 'integration', got: {:?}",
            fmt_results(&result.results)
        );
    }

    #[test]
    fn test_duplicate_names_at_different_depths() {
        let dir = tempdir().unwrap();
        let root = visible_root(&dir);

        // Create "abc" at multiple levels:
        //   folder1/abc/          (directory)
        //   folder1/abc/data.txt
        //   folder1/sub1/abc/     (directory)
        //   folder1/sub1/abc/data.txt
        //   folder2/abc.txt       (file)
        fs::create_dir_all(root.join("folder1/abc")).unwrap();
        File::create(root.join("folder1/abc/data.txt")).unwrap();
        fs::create_dir_all(root.join("folder1/sub1/abc")).unwrap();
        File::create(root.join("folder1/sub1/abc/data.txt")).unwrap();
        fs::create_dir(root.join("folder2")).unwrap();
        File::create(root.join("folder2/abc.txt")).unwrap();

        let result = fuzzy_search("abc".into(), root.to_string_lossy().into(), 20).unwrap();

        // Should find ALL instances of "abc"
        let abc_dirs: Vec<&SearchResult> = result
            .results
            .iter()
            .filter(|r| r.name == "abc" && r.kind == "directory")
            .collect();
        assert_eq!(
            abc_dirs.len(),
            2,
            "Should find both 'abc' directories, got: {:?}",
            fmt_results(&result.results)
        );

        let abc_file = result
            .results
            .iter()
            .find(|r| r.name == "abc.txt" && r.kind == "file");
        assert!(
            abc_file.is_some(),
            "Should also find 'abc.txt' file, got: {:?}",
            fmt_results(&result.results)
        );

        // Verify paths are distinct
        let abc_paths: Vec<&str> = abc_dirs.iter().map(|r| r.relative_path.as_str()).collect();
        assert!(
            abc_paths.contains(&"folder1/abc"),
            "Should include folder1/abc, got: {:?}",
            abc_paths
        );
        assert!(
            abc_paths.contains(&"folder1/sub1/abc"),
            "Should include folder1/sub1/abc, got: {:?}",
            abc_paths
        );
    }

    #[test]
    fn test_large_tree_with_many_siblings() {
        let dir = tempdir().unwrap();
        let root = visible_root(&dir);

        // Create 200 files in root to fill early batches
        for i in 0..200 {
            File::create(root.join(format!("file_{:04}.txt", i))).unwrap();
        }

        // Create target folder deep in subdirectory
        fs::create_dir_all(root.join("a/b/c/d")).unwrap();
        fs::create_dir(root.join("a/b/c/d/target_folder")).unwrap();
        File::create(root.join("a/b/c/d/target_folder/payload.txt")).unwrap();

        // Also create duplicate at a shallower level
        fs::create_dir(root.join("a/target_folder")).unwrap();
        File::create(root.join("a/target_folder/other.txt")).unwrap();

        let result =
            fuzzy_search("target_folder".into(), root.to_string_lossy().into(), 20).unwrap();

        let target_dirs: Vec<&SearchResult> = result
            .results
            .iter()
            .filter(|r| r.name == "target_folder" && r.kind == "directory")
            .collect();
        assert_eq!(
            target_dirs.len(),
            2,
            "Should find both target_folder instances despite 200 sibling files, got: {:?}",
            fmt_results(&result.results)
        );
    }

    #[test]
    fn test_finds_files_inside_deeply_nested_folders() {
        let dir = tempdir().unwrap();
        let root = visible_root(&dir);
        build_project_tree(&root);

        // Search for a file that only exists deep in the tree
        let result =
            fuzzy_search("api.test.ts".into(), root.to_string_lossy().into(), 20).unwrap();
        assert!(
            result.results.iter().any(|r| r.name == "api.test.ts"),
            "Should find deeply nested file, got: {:?}",
            fmt_results(&result.results)
        );

        // Search for "deploy" — only scripts/deploy.sh matches
        let result = fuzzy_search("deploy".into(), root.to_string_lossy().into(), 20).unwrap();
        assert!(
            result.results.iter().any(|r| r.name == "deploy.sh"),
            "Should find file in subdirectory, got: {:?}",
            fmt_results(&result.results)
        );
    }

    #[test]
    fn test_shallow_matches_rank_higher_than_deep() {
        let dir = tempdir().unwrap();
        let root = visible_root(&dir);

        // Same name at different depths
        fs::create_dir(root.join("config")).unwrap();
        fs::create_dir_all(root.join("a/b/config")).unwrap();
        fs::create_dir_all(root.join("a/b/c/d/config")).unwrap();

        let result = fuzzy_search("config".into(), root.to_string_lossy().into(), 20).unwrap();

        let configs: Vec<&SearchResult> = result
            .results
            .iter()
            .filter(|r| r.name == "config")
            .collect();
        assert_eq!(configs.len(), 3, "Should find all 3, got: {:?}", fmt_results(&result.results));

        // Scores should decrease with depth
        assert!(
            configs[0].score > configs[1].score && configs[1].score > configs[2].score,
            "Shallower should score higher: {:?}",
            configs.iter().map(|r| (&r.relative_path, r.score)).collect::<Vec<_>>()
        );

        // Shallowest should be first
        assert_eq!(configs[0].relative_path, "config");
    }
}
