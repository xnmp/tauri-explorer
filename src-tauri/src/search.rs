//! Fuzzy search module for Tauri commands.
//! Issue: tauri-explorer-az6w, tauri-explorer-nv2y

use crate::error::AppError;
use crate::search_cache::{SearchEntryCache, MAX_CACHED_LISTING_ENTRIES};
use jwalk::WalkDir;
use nucleo_matcher::pattern::{CaseMatching, Normalization, Pattern};
use nucleo_matcher::{Config, Matcher, Utf32Str};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Runtime};

/// Directories that are never walked: repo internals, caches and editor state.
/// Nothing a user would Quick Open to lives inside them.
const HARD_SKIP_DIRS: &[&str] = &[
    ".git",
    ".svn",
    ".hg",
    "__pycache__",
    ".cache",
    ".npm",
    ".cargo",
    ".idea",
    ".vscode",
];

/// Build output and dependency trees. Their contents ARE reachable — a Windows
/// installer really does live at `target/release/bundle/nsis` (#393) — but they
/// are huge and must never crowd out source files, so they are walked only in a
/// second pass, after the fast pass has emitted its results, and their hits are
/// penalized (see [`DEFERRED_PENALTY`]).
const DEFERRED_DIRS: &[&str] = &[
    "node_modules",
    "target",
    "build",
    "dist",
    "out",
    ".venv",
    "venv",
];

/// Subtracted from a deferred hit's score, so a build artifact ranks below the
/// source file it shadows (same name ⇒ the source wins on depth alone) without
/// being buried under unrelated fuzzy noise — a *divisor* here sank an exact
/// `nsis` folder-name match below 20 loose subsequence matches, i.e. right back
/// out of the results.
const DEFERRED_PENALTY: u32 = 40;

/// Ceiling on entries scanned in the deferred pass. A `node_modules` +
/// `target` pair can hold hundreds of thousands of files; the fast pass has
/// already produced results by then, so this pass is a bonus, not a promise.
const DEFERRED_SCAN_CAP: usize = 200_000;

fn is_hard_skip(name: &str) -> bool {
    HARD_SKIP_DIRS.contains(&name)
}

fn is_deferred(name: &str) -> bool {
    DEFERRED_DIRS.contains(&name)
}

/// One walked entry. `deferred` marks a hit found inside a build-output tree.
#[derive(Clone)]
struct Walked {
    relative_path: String,
    name: String,
    is_dir: bool,
    deferred: bool,
}

static SEARCH_ENTRY_CACHE: SearchEntryCache<Walked> = SearchEntryCache::new();

#[cfg(test)]
static TEST_WALK_COUNTS: std::sync::OnceLock<Mutex<std::collections::HashMap<PathBuf, usize>>> =
    std::sync::OnceLock::new();

#[cfg(test)]
struct TestStreamGate {
    started: std::sync::Barrier,
    release: std::sync::Barrier,
}

#[cfg(test)]
static TEST_STREAM_GATES: std::sync::OnceLock<
    Mutex<std::collections::HashMap<PathBuf, Arc<TestStreamGate>>>,
> = std::sync::OnceLock::new();

#[cfg(test)]
static TEST_STREAM_WALK_COUNTS: std::sync::OnceLock<
    Mutex<std::collections::HashMap<PathBuf, usize>>,
> = std::sync::OnceLock::new();

pub(crate) fn invalidate_search_cache_for_change(changed_path: &Path) {
    SEARCH_ENTRY_CACHE.invalidate_for_change(changed_path);
}

pub(crate) fn invalidate_search_cache_root(root: &Path) {
    SEARCH_ENTRY_CACHE.invalidate_root(root);
}

// ─── WSL delegation (#414) ───────────────────────────────────────────────────
// Walking a `\\wsl.localhost\…` tree from Windows crosses the 9P network
// boundary once per directory — tens of thousands of round-trips, so the
// deferred pass (target/, node_modules/) effectively never finishes and
// Quick Open "can't find" folders like target/release/bundle/deb. Delegate
// the walk to the distro's native `find` (same pattern as terminals #378):
// it scans the whole tree in well under a second and streams results back.

#[cfg(any(windows, test))]
/// `find` arguments for the fast pass over `linux_path`: hidden + hard-skip
/// trees pruned silently; build-output trees pruned but printed (type `d`)
/// so they appear as results themselves and seed the deferred pass.
/// Output lines: `<y>\t<relative path>` (`%y` type char, `%P` path).
fn find_fast_args(linux_path: &str) -> Vec<String> {
    let mut args: Vec<String> = vec![linux_path.into(), "-mindepth".into(), "1".into()];
    // Hidden entries and hard-skip dirs: prune, print nothing.
    args.extend(["(".into(), "-name".into(), ".*".into()]);
    for d in HARD_SKIP_DIRS {
        args.extend(["-o".into(), "-name".into(), (*d).into()]);
    }
    args.extend([")".into(), "-prune".into(), "-o".into()]);
    // Deferred dirs: prune but print the dir itself.
    args.push("(".into());
    let mut first = true;
    for d in DEFERRED_DIRS {
        if !first {
            args.push("-o".into());
        }
        first = false;
        args.extend(["-name".into(), (*d).into()]);
    }
    args.extend([
        ")".into(),
        "-prune".into(),
        "-printf".into(),
        "d\\t%P\\n".into(),
        "-o".into(),
        "-printf".into(),
        "%y\\t%P\\n".into(),
    ]);
    args
}

#[cfg(any(windows, test))]
/// `find` arguments for one deferred (build-output) tree: hidden and
/// hard-skip dirs pruned; everything else printed.
fn find_deferred_args(linux_path: &str) -> Vec<String> {
    let mut args: Vec<String> = vec![linux_path.into(), "-mindepth".into(), "1".into()];
    args.extend(["(".into(), "-name".into(), ".*".into()]);
    for d in HARD_SKIP_DIRS {
        args.extend(["-o".into(), "-name".into(), (*d).into()]);
    }
    args.extend([
        ")".into(),
        "-prune".into(),
        "-o".into(),
        "-printf".into(),
        "%y\\t%P\\n".into(),
    ]);
    args
}

#[cfg(any(windows, test))]
/// Parse one `find -printf '%y\t%P\n'` output line into (is_dir, rel_path).
fn parse_find_line(line: &str) -> Option<(bool, &str)> {
    let (kind, rel) = line.split_once('\t')?;
    if rel.is_empty() {
        return None;
    }
    Some((kind == "d", rel))
}

#[cfg(any(windows, test))]
/// Argv prefix for `wsl.exe` that delegates `find` to `distro`, i.e. the args
/// before the find arguments themselves.
///
/// Uses `--exec` rather than `--`: `wsl.exe -- <cmd>` joins the trailing argv
/// and runs it through the distro user's **default login shell** (zsh here),
/// which choked on the unquoted find metacharacters (`( -name … )`), exited 1
/// and returned zero entries (#423). `--exec` launches find directly, passing
/// argv verbatim — no shell, no quoting required.
fn wsl_find_argv(distro: &str) -> [String; 4] {
    ["-d".into(), distro.into(), "--exec".into(), "find".into()]
}

#[cfg(any(windows, test))]
/// Run one `find` under `runner` (a pre-built Command missing only the find
/// args), streaming parsed lines into `on_line`. Returns false if the process
/// could not be spawned OR exited non-zero without producing any output
/// (caller falls back to jwalk).
fn stream_find(
    mut cmd: std::process::Command,
    stop: &dyn Fn() -> bool,
    on_line: &mut dyn FnMut(bool, &str),
) -> bool {
    use crate::process_ext::NoConsole;
    use std::io::BufRead;
    // stderr is piped (was null) purely so a non-zero exit can be explained in
    // the log; it is drained on a helper thread to avoid a pipe-full deadlock.
    cmd.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdin(std::process::Stdio::null())
        .no_console();
    // Grep-able record of the exact command line being spawned.
    let cmd_desc = {
        let prog = cmd.get_program().to_string_lossy().to_string();
        let args: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        format!("{prog} {}", args.join(" "))
    };
    log::info!("quickfind: stream_find spawn: {cmd_desc}");
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            log::warn!("quickfind: stream_find spawn FAILED: {cmd_desc}: {e}");
            return false;
        }
    };
    // Drain stderr on a helper thread so a chatty `find` (permission-denied
    // spam) can never block the stdout reader.
    let stderr_handle = child.stderr.take().map(|mut err| {
        std::thread::spawn(move || {
            use std::io::Read;
            let mut raw = Vec::new();
            let _ = err.read_to_end(&mut raw);
            raw.truncate(1024); // cap logged stderr at ~1KB
            String::from_utf8_lossy(&raw).to_string()
        })
    });
    let mut parsed = 0usize;
    let mut unparsed = 0usize;
    if let Some(out) = child.stdout.take() {
        for line in std::io::BufReader::new(out).lines() {
            if stop() {
                let _ = child.kill();
                break;
            }
            let Ok(line) = line else { break };
            if let Some((is_dir, rel)) = parse_find_line(&line) {
                parsed += 1;
                on_line(is_dir, rel);
            } else {
                unparsed += 1;
            }
        }
    }
    let status = child.wait();
    let stderr_buf = stderr_handle
        .and_then(|h| h.join().ok())
        .unwrap_or_default();
    // A process spawn is not success: `wsl.exe -- find …` used to run through
    // the distro's login shell (zsh), which exited 1 on the unquoted find
    // metacharacters and produced zero output. Treat a non-zero exit that
    // yielded nothing as failure so the caller can fall back to jwalk. If we
    // already streamed entries (e.g. the child was killed by `stop`), keep
    // them — a fallback would only re-emit duplicates.
    match status {
        Ok(st) => {
            log::info!(
                "quickfind: stream_find done: parsed={parsed} unparsed={unparsed} status={st}"
            );
            if !st.success() && !stderr_buf.trim().is_empty() {
                log::warn!("quickfind: stream_find stderr: {}", stderr_buf.trim_end());
            }
            st.success() || parsed > 0
        }
        Err(e) => {
            log::warn!(
                "quickfind: stream_find wait FAILED: parsed={parsed} unparsed={unparsed}: {e}"
            );
            parsed > 0
        }
    }
}

#[cfg(any(windows, test))]
/// Both walk passes via the distro's native `find` (#414). Returns false when
/// find could not run — the caller falls back to the jwalk implementation.
fn find_walk_passes(
    make_cmd: &dyn Fn() -> std::process::Command,
    linux_path: &str,
    stop: &dyn Fn() -> bool,
    on_entry: &mut dyn FnMut(Walked),
) -> bool {
    let mut deferred_roots: Vec<String> = Vec::new();
    let mut fast_count = 0usize;
    let ok = stream_find(
        {
            let mut c = make_cmd();
            c.args(find_fast_args(linux_path));
            c
        },
        stop,
        &mut |is_dir, rel| {
            fast_count += 1;
            let name = rel.rsplit('/').next().unwrap_or(rel).to_string();
            if is_dir && is_deferred(&name) {
                deferred_roots.push(rel.to_string());
            }
            on_entry(Walked {
                relative_path: rel.to_string(),
                name,
                is_dir,
                deferred: false,
            });
        },
    );
    if !ok {
        log::warn!("quickfind: find_walk_passes fast pass could not run; falling back to jwalk");
        return false;
    }
    log::info!(
        "quickfind: find_walk_passes fast pass emitted {fast_count} entries; deferred_roots={deferred_roots:?}"
    );
    // Cell: the stop closure reads the counter while the line callback
    // increments it — a plain usize would be a simultaneous & / &mut borrow.
    let scanned = std::cell::Cell::new(0usize);
    let total_roots = deferred_roots.len();
    for (i, root_rel) in deferred_roots.iter().enumerate() {
        if stop() || scanned.get() >= DEFERRED_SCAN_CAP {
            log::warn!(
                "quickfind: find_walk_passes deferred cap/stop hit after {} entries; {} of {total_roots} roots left unwalked: {:?}",
                scanned.get(),
                total_roots - i,
                &deferred_roots[i..]
            );
            break;
        }
        let before = scanned.get();
        let abs = format!("{}/{}", linux_path.trim_end_matches('/'), root_rel);
        stream_find(
            {
                let mut c = make_cmd();
                c.args(find_deferred_args(&abs));
                c
            },
            &|| stop() || scanned.get() >= DEFERRED_SCAN_CAP,
            &mut |is_dir, rel| {
                scanned.set(scanned.get() + 1);
                let name = rel.rsplit('/').next().unwrap_or(rel).to_string();
                on_entry(Walked {
                    relative_path: format!("{root_rel}/{rel}"),
                    name,
                    is_dir,
                    deferred: true,
                });
            },
        );
        log::info!(
            "quickfind: find_walk_passes deferred root {root_rel:?} scanned {} entries (running total {})",
            scanned.get() - before,
            scanned.get()
        );
    }
    true
}

/// Walk `root`, calling `on_entry` for every visible entry: the fast pass
/// first (build-output trees pruned, but still reported as entries themselves),
/// then those pruned trees, marked `deferred`. Stops early when `stop` returns
/// true. Returns once both passes are done.
fn walk_passes(
    root: &Path,
    stop: &dyn Fn() -> bool,
    fast_cap: usize,
    on_entry: &mut dyn FnMut(Walked),
) {
    // WSL UNC roots delegate to the distro's native find (#414); on any
    // failure (wsl.exe missing, no find) fall through to the jwalk passes.
    #[cfg(windows)]
    {
        let root_str = root.to_string_lossy();
        match crate::wsl::parse_wsl_unc(&root_str) {
            Some((distro, linux_path)) => {
                log::info!(
                    "quickfind: WSL UNC matched root={root_str:?} distro={distro:?} linux_path={linux_path:?}"
                );
                let make_cmd = move || {
                    let mut c = std::process::Command::new("wsl.exe");
                    c.args(wsl_find_argv(&distro));
                    c
                };
                if find_walk_passes(&make_cmd, &linux_path, stop, on_entry) {
                    log::info!("quickfind: WSL find delegation completed for {linux_path:?}");
                    return;
                }
                log::warn!(
                    "quickfind: WSL find delegation returned false for {linux_path:?}; falling back to jwalk"
                );
            }
            None => {
                if root_str.starts_with('\\') {
                    log::info!(
                        "quickfind: UNC-like root {root_str:?} did NOT match parse_wsl_unc; using jwalk"
                    );
                }
            }
        }
    }
    let deferred_roots = Arc::new(Mutex::new(Vec::<PathBuf>::new()));

    let collect = deferred_roots.clone();
    let fast = WalkDir::new(root).skip_hidden(true).process_read_dir(
        move |_depth, _path, _state, children| {
            for e in children.iter_mut().flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                if is_hard_skip(&name) {
                    e.read_children_path = None;
                } else if is_deferred(&name) {
                    // Reported as an entry, but its contents wait for pass two.
                    if let Ok(mut roots) = collect.lock() {
                        roots.push(e.path());
                    }
                    e.read_children_path = None;
                }
            }
        },
    );

    let mut emit = |entry: jwalk::DirEntry<((), ())>, deferred: bool| {
        let path = entry.path();
        if path == root {
            return; // the root itself is not a result
        }
        let Ok(rel) = path.strip_prefix(root) else {
            return;
        };
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        if name.starts_with('.') {
            return; // hidden entries the walker didn't already filter
        }
        on_entry(Walked {
            relative_path: normalize_rel_separators(rel.to_string_lossy().to_string()),
            name,
            is_dir: entry.file_type().is_dir(),
            deferred,
        });
    };

    let mut fast_count = 0usize;
    for entry in fast.into_iter().take(fast_cap) {
        if stop() {
            return;
        }
        if let Ok(e) = entry {
            emit(e, false);
            fast_count += 1;
        }
    }
    log::info!("quickfind: jwalk fast pass processed {fast_count} entries");

    // Pass two: the build-output trees, deprioritized and capped.
    let roots = match deferred_roots.lock() {
        Ok(r) => r.clone(),
        Err(_) => return,
    };
    let mut scanned = 0usize;
    let roots_len = roots.len();
    for (i, deferred_root) in roots.iter().enumerate() {
        if stop() || scanned >= DEFERRED_SCAN_CAP {
            log::warn!(
                "quickfind: jwalk deferred cap/stop hit after {scanned} entries; {} of {roots_len} roots left unwalked",
                roots_len - i
            );
            return;
        }
        let before = scanned;
        let walker = WalkDir::new(deferred_root)
            .skip_hidden(true)
            .process_read_dir(|_depth, _path, _state, children| {
                for e in children.iter_mut().flatten() {
                    if is_hard_skip(&e.file_name().to_string_lossy()) {
                        e.read_children_path = None;
                    }
                }
            });
        for entry in walker {
            if stop() || scanned >= DEFERRED_SCAN_CAP {
                log::warn!(
                    "quickfind: jwalk deferred cap/stop hit mid-root {deferred_root:?} after {scanned} entries"
                );
                return;
            }
            scanned += 1;
            if let Ok(e) = entry {
                // Depth 0 is the deferred root itself, which the fast pass
                // already emitted — a second copy would show up as a
                // duplicate result.
                if e.depth == 0 {
                    continue;
                }
                emit(e, true);
            }
        }
        log::info!(
            "quickfind: jwalk deferred root {deferred_root:?} scanned {} entries (running total {scanned})",
            scanned - before
        );
    }
}

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

/// Safety cap for the non-streaming path which collects entries into memory.
/// High enough to cover any normal home directory tree; prevents OOM if
/// the search root is accidentally `/` or a network mount. The streaming
/// path (used by the UI) has its own cancellation mechanism and doesn't
/// need this cap.
const WALK_SAFETY_CAP: usize = 500_000;

/// Normalize OS path separators in a relative path to forward slashes.
///
/// `strip_prefix` yields `\`-separated components on Windows, which would make
/// depth ranking (which counts `/`) dead and break the frontend `relativePath`
/// convention. Only the platform separator is replaced, so literal backslashes
/// in Unix filenames are preserved.
fn normalize_rel_separators(p: String) -> String {
    if std::path::MAIN_SEPARATOR == '/' {
        p
    } else {
        p.replace(std::path::MAIN_SEPARATOR, "/")
    }
}

/// Collect file/directory entries under `root_path` (both passes).
/// Capped at `WALK_SAFETY_CAP` to bound memory for the non-streaming path.
fn walk_entries(root_path: &Path) -> Vec<Walked> {
    #[cfg(test)]
    {
        *TEST_WALK_COUNTS
            .get_or_init(|| Mutex::new(std::collections::HashMap::new()))
            .lock()
            .expect("test walk counts lock")
            .entry(root_path.to_path_buf())
            .or_default() += 1;
    }
    let mut entries: Vec<Walked> = Vec::new();
    walk_passes(root_path, &|| false, WALK_SAFETY_CAP, &mut |w| {
        entries.push(w)
    });
    entries
}

#[cfg(test)]
fn walk_count_for_test(root_path: &Path) -> usize {
    TEST_WALK_COUNTS
        .get_or_init(|| Mutex::new(std::collections::HashMap::new()))
        .lock()
        .expect("test walk counts lock")
        .get(root_path)
        .copied()
        .unwrap_or_default()
}

fn walk_streaming_entries(
    root_path: &Path,
    cancelled: &dyn Fn() -> bool,
    on_entry: &mut dyn FnMut(Walked),
) -> Option<Vec<Walked>> {
    #[cfg(test)]
    {
        *TEST_STREAM_WALK_COUNTS
            .get_or_init(|| Mutex::new(std::collections::HashMap::new()))
            .lock()
            .expect("test stream walk counts lock")
            .entry(root_path.to_path_buf())
            .or_default() += 1;
    }
    let mut completed_entries = Some(Vec::new());
    #[cfg(test)]
    let mut paused = false;
    walk_passes(root_path, cancelled, usize::MAX, &mut |entry| {
        #[cfg(test)]
        if !paused {
            let gate = TEST_STREAM_GATES
                .get_or_init(|| Mutex::new(std::collections::HashMap::new()))
                .lock()
                .expect("test stream gates lock")
                .remove(root_path);
            if let Some(gate) = gate {
                paused = true;
                gate.started.wait();
                gate.release.wait();
            }
        }
        if completed_entries
            .as_ref()
            .is_some_and(|entries| entries.len() >= MAX_CACHED_LISTING_ENTRIES)
        {
            completed_entries = None;
        }
        if let Some(entries) = completed_entries.as_mut() {
            entries.push(entry.clone());
        }
        on_entry(entry);
    });

    if cancelled() {
        None
    } else {
        completed_entries
    }
}

#[cfg(test)]
fn install_stream_gate_for_test(root_path: &Path) -> Arc<TestStreamGate> {
    let gate = Arc::new(TestStreamGate {
        started: std::sync::Barrier::new(2),
        release: std::sync::Barrier::new(2),
    });
    TEST_STREAM_GATES
        .get_or_init(|| Mutex::new(std::collections::HashMap::new()))
        .lock()
        .expect("test stream gates lock")
        .insert(root_path.to_path_buf(), Arc::clone(&gate));
    gate
}

#[cfg(test)]
fn stream_walk_count_for_test(root_path: &Path) -> usize {
    TEST_STREAM_WALK_COUNTS
        .get_or_init(|| Mutex::new(std::collections::HashMap::new()))
        .lock()
        .expect("test stream walk counts lock")
        .get(root_path)
        .copied()
        .unwrap_or_default()
}

fn cached_walk_entries(root_path: &Path) -> Arc<Vec<Walked>> {
    if crate::files::fs_watcher::ensure_search_cache_watched(root_path) {
        SEARCH_ENTRY_CACHE.get_or_load(root_path, || walk_entries(root_path))
    } else {
        Arc::new(walk_entries(root_path))
    }
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
    entry: &Walked,
    query_lower: &str,
    pattern: &Pattern,
    matcher: &mut Matcher,
) -> Option<u32> {
    let Walked {
        name,
        relative_path,
        is_dir,
        deferred,
    } = entry;
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
    let dir_bonus = if *is_dir { DIRECTORY_BONUS } else { 0 };
    let score = base_score
        .saturating_add(depth_bonus)
        .saturating_add(dir_bonus);
    // A build artifact never outranks the source file it shadows (#393) —
    // but an exact name match is what the user asked for, not fuzzy noise:
    // penalizing it buried `target/release/bundle/deb` under 20 unrelated
    // `debug*` subsequence matches (#427). Exact-vs-exact same-name pairs
    // still resolve in the source file's favor via the depth bonus.
    let exact = name.to_lowercase() == query_lower;
    Some(if *deferred && !exact {
        score.saturating_sub(DEFERRED_PENALTY)
    } else {
        score
    })
}

/// Fuzzy search for files and directories recursively (non-streaming version).
/// Uses nucleo for fast fuzzy matching and jwalk for parallel traversal.
/// Async with the walk offloaded to a blocking thread so the IPC thread
/// is never blocked by large directory trees.
#[tauri::command]
pub async fn fuzzy_search(
    query: String,
    root: String,
    limit: usize,
) -> Result<SearchResponse, AppError> {
    tokio::task::spawn_blocking(move || fuzzy_search_sync(query, root, limit))
        .await
        .map_err(|e| AppError::Other(format!("Task join error: {}", e)))?
}

fn fuzzy_search_sync(
    query: String,
    root: String,
    limit: usize,
) -> Result<SearchResponse, AppError> {
    let root_path = PathBuf::from(&root);

    if !root_path.exists() {
        return Err(AppError::NotFound(root));
    }

    if !root_path.is_dir() {
        return Err(AppError::InvalidPath(format!("Not a directory: {}", root)));
    }

    let limit = limit.clamp(1, 100);
    let entries = cached_walk_entries(&root_path);
    log::debug!("fuzzy_search: query={:?} entries={}", query, entries.len());

    if entries.is_empty() {
        return Ok(SearchResponse { results: vec![] });
    }

    let mut matcher = Matcher::new(Config::DEFAULT);
    let pattern = Pattern::parse(&query, CaseMatching::Ignore, Normalization::Smart);
    let query_lower = query.to_lowercase();

    let mut scored: Vec<(u32, usize)> = entries
        .iter()
        .enumerate()
        .filter_map(|(idx, entry)| {
            score_entry(entry, &query_lower, &pattern, &mut matcher).map(|score| (score, idx))
        })
        .collect();

    scored.sort_by_key(|s| std::cmp::Reverse(s.0));

    let results: Vec<SearchResult> = scored
        .into_iter()
        .take(limit)
        .map(|(score, idx)| {
            let entry = &entries[idx];
            let full_path = root_path.join(&entry.relative_path);
            SearchResult {
                name: entry.name.clone(),
                path: full_path.to_string_lossy().to_string(),
                relative_path: entry.relative_path.clone(),
                score,
                kind: if entry.is_dir {
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
pub async fn start_streaming_search(
    app: AppHandle,
    query: String,
    root: String,
    limit: usize,
    boost_prefix: Option<String>,
) -> Result<u64, AppError> {
    start_streaming_search_with_runtime(app, query, root, limit, boost_prefix).await
}

async fn start_streaming_search_with_runtime<R: Runtime>(
    app: AppHandle<R>,
    query: String,
    root: String,
    limit: usize,
    boost_prefix: Option<String>,
) -> Result<u64, AppError> {
    let root_path = PathBuf::from(&root);

    // Stat off the calling thread — a dead network mount can hang here.
    let (exists, is_dir) = {
        let p = root_path.clone();
        tokio::task::spawn_blocking(move || (p.exists(), p.is_dir()))
            .await
            .map_err(|e| AppError::Other(format!("Task join error: {}", e)))?
    };
    if !exists {
        return Err(AppError::NotFound(root));
    }

    if !is_dir {
        return Err(AppError::InvalidPath(format!("Not a directory: {}", root)));
    }

    let limit = limit.clamp(1, 100);
    log::debug!(
        "start_streaming_search: id=pending query={:?} root={:?}",
        query,
        root
    );
    log::info!("quickfind: start_streaming_search query={query:?} root={root:?}");
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

        let mut pending_entries: Vec<Walked> = Vec::new();

        let cache_eligible = crate::files::fs_watcher::ensure_search_cache_watched(&root_path);
        let cache_revision = cache_eligible.then(|| SEARCH_ENTRY_CACHE.begin_load(&root_path));
        let cached_entries = cache_eligible
            .then(|| SEARCH_ENTRY_CACHE.completed(&root_path))
            .flatten();
        let mut accept_entry = |entry: Walked| {
            pending_entries.push(entry);
            total_scanned += 1;

            if pending_entries.len() >= batch_size {
                let ctx = BatchContext {
                    app: &app,
                    search_id,
                    root_path: &root_path,
                    pattern: &pattern,
                    limit,
                    boost_prefix: boost_path.as_deref(),
                    query_lower: &query_lower,
                };
                process_batch(
                    &ctx,
                    &mut pending_entries,
                    &mut all_results,
                    &mut matcher,
                    total_scanned,
                );
            }
        };

        let completed_entries = if let Some(entries) = cached_entries {
            for entry in entries.iter() {
                if cancelled.load(Ordering::Relaxed) {
                    break;
                }
                accept_entry(entry.clone());
            }
            None
        } else {
            // Fast pass first, then the deferred build-output trees (#393), so
            // a cold search still emits its first results incrementally.
            walk_streaming_entries(
                &root_path,
                &|| cancelled.load(Ordering::Relaxed),
                &mut accept_entry,
            )
        };

        drop(accept_entry);

        if !cancelled.load(Ordering::Relaxed)
            && crate::files::fs_watcher::is_search_cache_watched(&root_path)
        {
            if let (Some(entries), Some(revision)) = (completed_entries, cache_revision) {
                SEARCH_ENTRY_CACHE.publish_if_unchanged(&root_path, Arc::new(entries), revision);
            }
        }

        // Process remaining entries
        if !pending_entries.is_empty() && !cancelled.load(Ordering::Relaxed) {
            let ctx = BatchContext {
                app: &app,
                search_id,
                root_path: &root_path,
                pattern: &pattern,
                limit,
                boost_prefix: boost_path.as_deref(),
                query_lower: &query_lower,
            };
            process_batch(
                &ctx,
                &mut pending_entries,
                &mut all_results,
                &mut matcher,
                total_scanned,
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

#[cfg(test)]
#[path = "../tests/issue_651_search_integration.rs"]
mod issue_651_integration_tests;

#[cfg(test)]
#[path = "../tests/issue_651_streaming_integration.rs"]
mod issue_651_streaming_integration_tests;

/// Per-search constants shared by every `process_batch` call.
struct BatchContext<'a, R: Runtime> {
    app: &'a AppHandle<R>,
    search_id: u64,
    root_path: &'a Path,
    pattern: &'a Pattern,
    limit: usize,
    boost_prefix: Option<&'a Path>,
    query_lower: &'a str,
}

fn process_batch<R: Runtime>(
    ctx: &BatchContext<'_, R>,
    pending: &mut Vec<Walked>,
    all_results: &mut Vec<SearchResult>,
    matcher: &mut Matcher,
    total_scanned: usize,
) {
    let BatchContext {
        app,
        search_id,
        root_path,
        pattern,
        limit,
        boost_prefix,
        query_lower,
    } = *ctx;
    // Score boost for results under the priority prefix (e.g. CWD)
    const BOOST_SCORE: u32 = 100;

    let mut new_results: Vec<SearchResult> = pending
        .iter()
        .filter_map(|entry| {
            let score = score_entry(entry, query_lower, pattern, matcher)?;
            let full_path = root_path.join(&entry.relative_path);
            // Boost results under the priority prefix (e.g. CWD) — but never a
            // build artifact, which the CWD boost would lift back above the
            // source files the penalty exists to protect (#393).
            let boosted_score = match boost_prefix {
                Some(prefix) if !entry.deferred && full_path.starts_with(prefix) => {
                    score.saturating_add(BOOST_SCORE)
                }
                _ => score,
            };
            Some(SearchResult {
                name: entry.name.clone(),
                path: full_path.to_string_lossy().to_string(),
                relative_path: entry.relative_path.clone(),
                score: boosted_score,
                kind: if entry.is_dir {
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
    all_results.sort_by_key(|r| std::cmp::Reverse(r.score));
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
pub async fn cancel_search(search_id: u64) -> Result<(), AppError> {
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

    /// Helper: format walked entries for assertion messages.
    fn fmt_walked(entries: &[Walked]) -> Vec<String> {
        entries
            .iter()
            .map(|e| {
                format!(
                    "{} @ {} dir={} deferred={}",
                    e.name, e.relative_path, e.is_dir, e.deferred
                )
            })
            .collect()
    }

    #[test]
    fn find_lines_parse_into_kind_and_rel_path() {
        assert_eq!(
            parse_find_line("d\tsrc-tauri/target"),
            Some((true, "src-tauri/target"))
        );
        assert_eq!(
            parse_find_line("f\ta/b c/d.txt"),
            Some((false, "a/b c/d.txt"))
        );
        assert_eq!(parse_find_line("l\tlink"), Some((false, "link")));
        assert_eq!(parse_find_line("no-tab-here"), None);
        assert_eq!(parse_find_line("d\t"), None);
    }

    /// The find-delegated walk (#414), exercised against the REAL `find`
    /// binary on a synthetic tree shaped like the WSL repro: hidden and
    /// hard-skip trees invisible, build output deferred but reachable —
    /// `target/release/bundle/deb` must come back as a deferred directory.
    #[test]
    #[cfg(unix)]
    fn find_walk_passes_matches_jwalk_semantics() {
        if std::process::Command::new("find")
            .arg("--version")
            .output()
            .is_err()
        {
            eprintln!("skipping: no `find` on this machine");
            return;
        }
        let dir = tempdir().unwrap();
        let root = visible_root(&dir);
        fs::create_dir_all(root.join("src/lib")).unwrap();
        File::create(root.join("src/lib/app.ts")).unwrap();
        fs::create_dir_all(root.join(".git/objects")).unwrap();
        File::create(root.join(".git/objects/junk")).unwrap();
        fs::create_dir_all(root.join("src-tauri/target/release/bundle/deb")).unwrap();
        File::create(root.join("src-tauri/target/release/bundle/deb/app.deb")).unwrap();
        fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        File::create(root.join("node_modules/pkg/index.js")).unwrap();

        let root_str = root.to_string_lossy().to_string();
        let make_cmd = || std::process::Command::new("find");
        let mut entries: Vec<Walked> = Vec::new();
        let ok = find_walk_passes(&make_cmd, &root_str, &|| false, &mut |w| entries.push(w));
        assert!(ok, "find walk should run");

        let listing = fmt_walked(&entries);
        // Fast-pass entries, not deferred.
        assert!(
            listing.contains(&"app.ts @ src/lib/app.ts dir=false deferred=false".to_string()),
            "source files walk in the fast pass: {listing:?}"
        );
        // The deferred root itself is a fast-pass entry…
        assert!(
            listing.contains(&"target @ src-tauri/target dir=true deferred=false".to_string()),
            "build-output roots are entries themselves: {listing:?}"
        );
        // …and its contents arrive via the deferred pass, including the deb dir.
        assert!(
            listing.contains(
                &"deb @ src-tauri/target/release/bundle/deb dir=true deferred=true".to_string()
            ),
            "deferred pass must reach target/release/bundle/deb: {listing:?}"
        );
        assert!(
            listing.contains(
                &"index.js @ node_modules/pkg/index.js dir=false deferred=true".to_string()
            ),
            "node_modules contents are deferred: {listing:?}"
        );
        // Repo internals never appear.
        assert!(
            !listing.iter().any(|l| l.contains(".git")),
            "hard-skip trees must be invisible: {listing:?}"
        );
    }

    /// The WSL delegation must use `--exec` (verbatim argv) rather than `--`,
    /// which would route the find command through the distro's login shell and
    /// mangle its metacharacters (#423).
    #[test]
    fn wsl_find_argv_uses_exec_not_dash_dash() {
        let argv = wsl_find_argv("Ubuntu");
        assert_eq!(argv, ["-d", "Ubuntu", "--exec", "find"]);
        assert!(
            argv.iter().any(|a| a == "--exec"),
            "must use --exec: {argv:?}"
        );
        assert!(
            !argv.iter().any(|a| a == "--"),
            "bare -- routes through the login shell: {argv:?}"
        );
    }

    /// When the fast-pass `find` exits non-zero without producing output (the
    /// #423 failure mode: the login shell rejected the command), the walk must
    /// report failure so the caller falls back to jwalk instead of silently
    /// returning an empty result set.
    #[test]
    #[cfg(unix)]
    fn find_walk_passes_fails_on_nonzero_exit() {
        // `false` ignores its args and exits 1 with no stdout — a deterministic
        // stand-in for the shell-mangled find that returned nothing.
        let make_cmd = || std::process::Command::new("false");
        let mut entries: Vec<Walked> = Vec::new();
        let ok = find_walk_passes(&make_cmd, "/whatever", &|| false, &mut |w| entries.push(w));
        assert!(!ok, "a non-zero exit with no output must return false");
        assert!(entries.is_empty(), "no entries should have been emitted");
    }

    /// Helper: format results for assertion messages.
    fn fmt_results(results: &[SearchResult]) -> Vec<String> {
        results
            .iter()
            .map(|r| {
                format!(
                    "{} ({}) @ {} [score={}]",
                    r.name, r.kind, r.relative_path, r.score
                )
            })
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
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        let rel_paths: Vec<&str> = entries.iter().map(|e| e.relative_path.as_str()).collect();

        // Root-level items
        assert!(names.contains(&"README.md"), "Should find root file");
        assert!(names.contains(&"src"), "Should find root dir");

        // Depth-2 items
        assert!(names.contains(&"components"), "Should find src/components");
        assert!(names.contains(&"utils"), "Should find src/utils");

        // Depth-3 items
        assert!(
            names.contains(&"Button"),
            "Should find src/components/Button"
        );
        assert!(names.contains(&"Modal"), "Should find src/components/Modal");

        // Depth-4 items (files inside deeply nested dirs)
        assert!(
            names.contains(&"Button.test.ts"),
            "Should find deeply nested file"
        );

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
        let abc_dirs: Vec<&Walked> = entries
            .iter()
            .filter(|e| e.name == "abc" && e.is_dir)
            .collect();
        assert_eq!(
            abc_dirs.len(),
            2,
            "Should find both 'abc' directories, entries: {:?}",
            fmt_walked(&entries)
        );

        // Count "abc.txt" files
        let abc_files: Vec<_> = entries
            .iter()
            .filter(|e| e.name == "abc.txt" && !e.is_dir)
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
            entries
                .iter()
                .any(|e| e.name == "target_folder" && e.is_dir),
            "Should find deeply nested folder. Total entries: {}. Entries: {:?}",
            entries.len(),
            fmt_walked(&entries)
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

        let result = fuzzy_search_sync("hello".into(), root.to_string_lossy().into(), 10).unwrap();

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
            fuzzy_search_sync("zzzzzznotfound".into(), root.to_string_lossy().into(), 10).unwrap();
        assert!(result.results.is_empty());
    }

    #[test]
    fn test_skip_hidden_dirs() {
        let dir = tempdir().unwrap();
        let root = visible_root(&dir);
        fs::create_dir(root.join(".git")).unwrap();
        File::create(root.join(".git").join("config")).unwrap();
        File::create(root.join("visible.txt")).unwrap();

        let result = fuzzy_search_sync("config".into(), root.to_string_lossy().into(), 10).unwrap();
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
            fuzzy_search_sync("component".into(), root.to_string_lossy().into(), 10).unwrap();
        assert!(
            result
                .results
                .iter()
                .any(|r| r.name == "my-component.test.tsx"),
            "Substring match should work, got: {:?}",
            fmt_results(&result.results)
        );

        let result = fuzzy_search_sync("readme".into(), root.to_string_lossy().into(), 10).unwrap();
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
        let result = fuzzy_search_sync("Button".into(), root.to_string_lossy().into(), 20).unwrap();
        assert!(
            result
                .results
                .iter()
                .any(|r| r.name == "Button" && r.kind == "directory"),
            "Should find folder 'Button' in subdirectory, got: {:?}",
            fmt_results(&result.results)
        );

        // Another nested folder
        let result = fuzzy_search_sync("core".into(), root.to_string_lossy().into(), 20).unwrap();
        assert!(
            result
                .results
                .iter()
                .any(|r| r.name == "core" && r.kind == "directory"),
            "Should find folder 'core' in subdirectory, got: {:?}",
            fmt_results(&result.results)
        );

        // Nested folder + file that share the name
        let result =
            fuzzy_search_sync("integration".into(), root.to_string_lossy().into(), 20).unwrap();
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

        let result = fuzzy_search_sync("abc".into(), root.to_string_lossy().into(), 20).unwrap();

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
            fuzzy_search_sync("target_folder".into(), root.to_string_lossy().into(), 20).unwrap();

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
            fuzzy_search_sync("api.test.ts".into(), root.to_string_lossy().into(), 20).unwrap();
        assert!(
            result.results.iter().any(|r| r.name == "api.test.ts"),
            "Should find deeply nested file, got: {:?}",
            fmt_results(&result.results)
        );

        // Search for "deploy" — only scripts/deploy.sh matches
        let result = fuzzy_search_sync("deploy".into(), root.to_string_lossy().into(), 20).unwrap();
        assert!(
            result.results.iter().any(|r| r.name == "deploy.sh"),
            "Should find file in subdirectory, got: {:?}",
            fmt_results(&result.results)
        );
    }

    /// The reported bug: `target/` was pruned outright, so the Windows
    /// installer folder at `target/release/bundle/nsis` — a real thing users
    /// look for — was invisible to Quick Open (#393).
    #[test]
    fn test_finds_folders_inside_build_output_trees() {
        let dir = tempdir().unwrap();
        let root = visible_root(&dir);
        build_project_tree(&root);
        fs::create_dir_all(root.join("src-tauri/target/release/bundle/nsis")).unwrap();
        File::create(root.join("src-tauri/target/release/bundle/nsis/setup.exe")).unwrap();
        fs::create_dir_all(root.join("node_modules/lodash")).unwrap();

        let result = fuzzy_search_sync("nsis".into(), root.to_string_lossy().into(), 20).unwrap();
        let nsis = result
            .results
            .iter()
            .find(|r| r.name == "nsis" && r.kind == "directory");
        assert!(
            nsis.is_some(),
            "nsis under target/ must be reachable, got: {:?}",
            fmt_results(&result.results)
        );
        assert_eq!(
            nsis.unwrap().relative_path,
            "src-tauri/target/release/bundle/nsis"
        );

        let result = fuzzy_search_sync("lodash".into(), root.to_string_lossy().into(), 20).unwrap();
        assert!(
            result.results.iter().any(|r| r.name == "lodash"),
            "node_modules contents must be reachable too, got: {:?}",
            fmt_results(&result.results)
        );
    }

    /// The #427 burial: an exact-name match inside a build-output tree must
    /// survive a repo full of fuzzy competitors. In the real repo, querying
    /// "deb" produced 20+ shallow `debug*` subsequence matches whose
    /// unpenalized scores pushed the exact `target/release/bundle/deb` hit
    /// out of the top-20 emission entirely.
    #[test]
    fn test_exact_name_match_in_build_output_survives_fuzzy_crowd() {
        let dir = tempdir().unwrap();
        let root = visible_root(&dir);
        fs::create_dir_all(root.join("src-tauri/target/release/bundle/deb")).unwrap();
        File::create(root.join("src-tauri/target/release/bundle/deb/pkg.deb")).unwrap();
        // 26 shallow fuzzy competitors, mirroring screenshots/branch dirs
        // named debug-something in the real repo.
        for c in b'a'..=b'z' {
            File::create(root.join(format!("debug-{}.md", c as char))).unwrap();
        }

        let result = fuzzy_search_sync("deb".into(), root.to_string_lossy().into(), 20).unwrap();
        let deb = result
            .results
            .iter()
            .find(|r| r.name == "deb" && r.kind == "directory");
        assert!(
            deb.is_some(),
            "exact-name deb under target/ must stay in the top results, got: {:?}",
            fmt_results(&result.results)
        );
    }

    /// …but build artifacts must never crowd out the source files that share
    /// their name — the whole reason those trees were skipped in the first place.
    #[test]
    fn test_build_output_hits_rank_below_source_hits() {
        let dir = tempdir().unwrap();
        let root = visible_root(&dir);
        fs::create_dir_all(root.join("src")).unwrap();
        File::create(root.join("src/widget.ts")).unwrap();
        fs::create_dir_all(root.join("dist/assets")).unwrap();
        File::create(root.join("dist/assets/widget.ts")).unwrap();

        let result = fuzzy_search_sync("widget".into(), root.to_string_lossy().into(), 20).unwrap();
        let widgets: Vec<&SearchResult> = result
            .results
            .iter()
            .filter(|r| r.name == "widget.ts")
            .collect();
        assert_eq!(
            widgets.len(),
            2,
            "both copies found, got: {:?}",
            fmt_results(&result.results)
        );
        assert_eq!(
            widgets[0].relative_path,
            "src/widget.ts",
            "the source copy must rank first, got: {:?}",
            fmt_results(&result.results)
        );
        assert!(
            widgets[0].score > widgets[1].score,
            "the dist/ copy must be penalized: {:?}",
            widgets
                .iter()
                .map(|r| (&r.relative_path, r.score))
                .collect::<Vec<_>>()
        );
    }

    /// Repo internals stay invisible: nothing a user Quick Opens to is in .git.
    #[test]
    fn test_hard_skipped_dirs_are_never_walked() {
        let dir = tempdir().unwrap();
        let root = visible_root(&dir);
        fs::create_dir_all(root.join(".git/objects")).unwrap();
        File::create(root.join(".git/objects/deadbeef")).unwrap();
        File::create(root.join("deadbeef.txt")).unwrap();

        let result =
            fuzzy_search_sync("deadbeef".into(), root.to_string_lossy().into(), 20).unwrap();
        assert!(
            result.results.iter().all(|r| !r.path.contains(".git")),
            "'.git' contents must stay unreachable, got: {:?}",
            fmt_results(&result.results)
        );
        assert!(result.results.iter().any(|r| r.name == "deadbeef.txt"));
    }

    #[test]
    fn test_deferred_root_is_not_emitted_twice() {
        let dir = tempdir().unwrap();
        let root = visible_root(&dir);
        fs::create_dir_all(root.join("target/release")).unwrap();
        File::create(root.join("target/release/app.exe")).unwrap();

        let entries = walk_entries(&PathBuf::from(&root));
        let target_dirs = entries
            .iter()
            .filter(|e| e.name == "target" && e.is_dir)
            .count();
        assert_eq!(
            target_dirs,
            1,
            "deferred root emitted once, got: {:?}",
            fmt_walked(&entries)
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

        let result = fuzzy_search_sync("config".into(), root.to_string_lossy().into(), 20).unwrap();

        let configs: Vec<&SearchResult> = result
            .results
            .iter()
            .filter(|r| r.name == "config")
            .collect();
        assert_eq!(
            configs.len(),
            3,
            "Should find all 3, got: {:?}",
            fmt_results(&result.results)
        );

        // Scores should decrease with depth
        assert!(
            configs[0].score > configs[1].score && configs[1].score > configs[2].score,
            "Shallower should score higher: {:?}",
            configs
                .iter()
                .map(|r| (&r.relative_path, r.score))
                .collect::<Vec<_>>()
        );

        // Shallowest should be first
        assert_eq!(configs[0].relative_path, "config");
    }
}
