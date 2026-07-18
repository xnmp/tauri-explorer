//! GitHub PR badges for the git graph (#448).
//!
//! Best-effort, silent-degrade integration: repos without a GitHub remote,
//! offline machines, and rate-limited/unauthenticated API calls all resolve
//! to an empty badge list rather than a surfaced error — a PR badge is a
//! nice-to-have decoration, not something that should ever block or error
//! the graph.
//!
//! `git_open_prs` is the only Tauri command here; `parse_github_remote` is
//! pure and unit-tested directly (no network in tests, per project policy).

use std::collections::HashMap;
use std::path::Path;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::error::AppError;
use crate::git_common::open_repo;

/// One open pull request, as surfaced to the frontend. camelCase over IPC
/// for the multi-word fields, matching the codebase's existing IPC structs.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PrInfo {
    pub number: u64,
    pub title: String,
    #[serde(rename = "headRef")]
    pub head_ref: String,
    #[serde(rename = "htmlUrl")]
    pub html_url: String,
    pub draft: bool,
}

/// Extract `(owner, repo)` from a GitHub remote URL. Only github.com hosts
/// are recognized (SSH scp-like syntax, `ssh://`, and `https://`); anything
/// else — other hosts, malformed input — returns `None`. Handles an optional
/// trailing `/` and an optional `.git` suffix.
pub fn parse_github_remote(url: &str) -> Option<(String, String)> {
    let url = url.trim();
    let path = url
        .strip_prefix("git@github.com:")
        .or_else(|| url.strip_prefix("ssh://git@github.com/"))
        .or_else(|| url.strip_prefix("https://github.com/"))
        .or_else(|| url.strip_prefix("http://github.com/"))?;

    let path = path.trim_end_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);

    let (owner, repo) = path.split_once('/')?;
    if owner.is_empty() || repo.is_empty() || repo.contains('/') {
        return None;
    }
    Some((owner.to_string(), repo.to_string()))
}

// ----- In-process TTL cache (owner/repo → recent result) -----

enum CacheState {
    Hit(Vec<PrInfo>),
    /// A fetch failed recently; keyed separately from `Hit` so a real "no
    /// open PRs" result (also an empty Vec) doesn't share the negative TTL.
    Failed,
}

struct CacheEntry {
    at: Instant,
    ttl: Duration,
    state: CacheState,
}

const POSITIVE_TTL: Duration = Duration::from_secs(120);
const NEGATIVE_TTL: Duration = Duration::from_secs(60);

static PR_CACHE: LazyLock<Mutex<HashMap<String, CacheEntry>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn cache_get(key: &str) -> Option<Vec<PrInfo>> {
    let cache = PR_CACHE.lock().unwrap();
    let entry = cache.get(key)?;
    if entry.at.elapsed() >= entry.ttl {
        return None;
    }
    Some(match &entry.state {
        CacheState::Hit(prs) => prs.clone(),
        CacheState::Failed => Vec::new(),
    })
}

fn cache_put(key: String, state: CacheState) {
    let ttl = match state {
        CacheState::Hit(_) => POSITIVE_TTL,
        CacheState::Failed => NEGATIVE_TTL,
    };
    let mut cache = PR_CACHE.lock().unwrap();
    cache.insert(
        key,
        CacheEntry {
            at: Instant::now(),
            ttl,
            state,
        },
    );
}

// ----- GitHub API -----

#[derive(Deserialize)]
struct GhPull {
    number: u64,
    title: String,
    html_url: String,
    #[serde(default)]
    draft: bool,
    head: GhHead,
}

#[derive(Deserialize)]
struct GhHead {
    #[serde(rename = "ref")]
    ref_name: String,
}

impl From<GhPull> for PrInfo {
    fn from(p: GhPull) -> Self {
        PrInfo {
            number: p.number,
            title: p.title,
            head_ref: p.head.ref_name,
            html_url: p.html_url,
            draft: p.draft,
        }
    }
}

/// GET the open PRs for `owner/repo`. Mirrors `update_check.rs`'s ureq
/// pattern: a `User-Agent` header (GitHub rejects requests without one) and
/// the GitHub REST `Accept` header. Adds bearer auth when `GITHUB_TOKEN` or
/// `GH_TOKEN` is set, which raises the unauthenticated rate limit.
fn fetch_open_prs(owner: &str, repo: &str) -> Result<Vec<PrInfo>, String> {
    let url = format!("https://api.github.com/repos/{owner}/{repo}/pulls?state=open&per_page=100");
    let mut request = ureq::get(&url)
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "tauri-explorer-pr-badges");
    if let Ok(token) = std::env::var("GITHUB_TOKEN").or_else(|_| std::env::var("GH_TOKEN")) {
        request = request.header("Authorization", &format!("Bearer {token}"));
    }
    let pulls: Vec<GhPull> = request
        .call()
        .map_err(|e| e.to_string())?
        .body_mut()
        .read_json()
        .map_err(|e| e.to_string())?;
    Ok(pulls.into_iter().map(PrInfo::from).collect())
}

/// The repo's `origin` remote URL, falling back to the first configured
/// remote when there is no `origin`. `None` when the repo has no remotes at
/// all, or the resolved remote has no URL (e.g. a purely local remote).
fn remote_url(repo: &git2::Repository) -> Option<String> {
    let names = repo.remotes().ok()?;
    let names: Vec<&str> = names.iter().flatten().collect();
    let chosen = if names.contains(&"origin") {
        "origin"
    } else {
        names.first()?
    };
    repo.find_remote(chosen).ok()?.url().map(|u| u.to_string())
}

/// Open PRs for the repo at `repo_root`, decorated for the git graph's ref
/// chips. Degrades to `Ok(vec![])` — never `Err` — for every condition that
/// isn't a caller bug: no GitHub remote, offline, rate-limited, or a
/// malformed API response. Cached per `owner/repo` for 120s (60s on
/// failure) so a busy graph (watcher-triggered reloads) doesn't hammer the
/// API or retry every refresh on an offline machine.
#[tauri::command]
pub async fn git_open_prs(repo_root: String) -> Result<Vec<PrInfo>, AppError> {
    tokio::task::spawn_blocking(move || {
        let repo = open_repo(Path::new(&repo_root))?;
        let Some(url) = remote_url(&repo) else {
            return Ok(Vec::new());
        };
        let Some((owner, name)) = parse_github_remote(&url) else {
            return Ok(Vec::new());
        };
        let key = format!("{owner}/{name}");
        if let Some(cached) = cache_get(&key) {
            return Ok(cached);
        }
        match fetch_open_prs(&owner, &name) {
            Ok(prs) => {
                cache_put(key, CacheState::Hit(prs.clone()));
                Ok(prs)
            }
            Err(e) => {
                log::debug!("git_open_prs: fetch failed for {owner}/{name}: {e}");
                cache_put(key, CacheState::Failed);
                Ok(Vec::new())
            }
        }
    })
    .await
    .map_err(|e| AppError::Other(format!("Task join error: {}", e)))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_all_known_github_remote_shapes() {
        let cases: &[(&str, Option<(&str, &str)>)] = &[
            ("https://github.com/owner/repo.git", Some(("owner", "repo"))),
            ("https://github.com/owner/repo", Some(("owner", "repo"))),
            ("git@github.com:owner/repo.git", Some(("owner", "repo"))),
            ("git@github.com:owner/repo", Some(("owner", "repo"))),
            (
                "ssh://git@github.com/owner/repo.git",
                Some(("owner", "repo")),
            ),
            ("ssh://git@github.com/owner/repo", Some(("owner", "repo"))),
            ("http://github.com/owner/repo.git", Some(("owner", "repo"))),
            // Trailing slash.
            ("https://github.com/owner/repo/", Some(("owner", "repo"))),
            (
                "https://github.com/owner/repo.git/",
                Some(("owner", "repo")),
            ),
            // Hyphenated / underscored / dotted names.
            (
                "https://github.com/my-org/my_repo.thing.git",
                Some(("my-org", "my_repo.thing")),
            ),
            // Non-GitHub hosts.
            ("https://gitlab.com/owner/repo.git", None),
            ("git@bitbucket.org:owner/repo.git", None),
            ("https://github.company.com/owner/repo.git", None),
            // Malformed / incomplete.
            ("not a url", None),
            ("", None),
            ("https://github.com/", None),
            ("https://github.com/owner", None),
            ("https://github.com//repo", None),
            ("https://github.com/owner/repo/extra", None),
            ("git@github.com:owner", None),
        ];
        for (input, expected) in cases {
            let actual = parse_github_remote(input);
            let expected = expected.map(|(o, r)| (o.to_string(), r.to_string()));
            assert_eq!(actual, expected, "input: {input:?}");
        }
    }
}
