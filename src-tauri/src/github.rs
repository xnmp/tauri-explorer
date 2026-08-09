//! GitHub PR badges for the git graph (#448).
//!
//! Best-effort, silent-degrade integration: repos without a GitHub remote,
//! offline machines, and rate-limited/unauthenticated API calls all resolve
//! to an empty badge list rather than a surfaced error — a PR badge is a
//! nice-to-have decoration, not something that should ever block or error
//! the graph.
//!
//! `git_open_prs` decorates graph badges, while `git_failed_ci_checks` and
//! `git_failed_ci_check_log` retrieve a selected failed Actions job via `gh`.
//! `parse_github_remote` and the `gh` response mappings are pure and tested
//! directly (no network in tests, per project policy).

use std::collections::HashMap;
use std::path::Path;
use std::process::Command;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::error::AppError;
use crate::git_common::open_repo;
use crate::process_ext::NoConsole;

/// One open pull request, as surfaced to the frontend. camelCase over IPC
/// for the multi-word fields, matching the codebase's existing IPC structs.
///
/// The three status fields (#459) are populated only on the GraphQL path,
/// which requires a token; on the unauthenticated REST path they are `None`
/// and serialize as `null`, so the frontend renders the plain purple badge.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PrInfo {
    pub number: u64,
    pub title: String,
    #[serde(rename = "headRef")]
    pub head_ref: String,
    #[serde(rename = "htmlUrl")]
    pub html_url: String,
    pub draft: bool,
    /// CI rollup: `"success"` | `"failure"` | `"pending"`, or `None` when no
    /// checks are configured (or on the tokenless REST path).
    #[serde(rename = "ciStatus")]
    pub ci_status: Option<String>,
    /// `"approved"` | `"changes_requested"` | `"review_required"`, or `None`.
    #[serde(rename = "reviewDecision")]
    pub review_decision: Option<String>,
    /// Issue-comment count on the PR, or `None` on the REST path.
    #[serde(rename = "commentCount")]
    pub comment_count: Option<u64>,
    /// PR description text. On the GraphQL path this is `bodyText` (the
    /// markdown rendered to plain text); on the REST path it's the raw
    /// markdown `body`. `None`/empty when the PR has no description. Serde
    /// defaults so an older cached/serialized shape without the field still
    /// deserializes (the in-process cache is memory-only, but the IPC
    /// boundary and any future persistence stay forward-compatible).
    #[serde(default)]
    pub body: Option<String>,
    /// The PR's most-recent issue comments (oldest-first within the fetched
    /// window; capped at the last `COMMENT_FETCH_CAP`). Populated only on the
    /// GraphQL path — the REST list endpoint can't provide comment bodies
    /// without a per-PR fan-out, so it stays empty there (documented degrade,
    /// consistent with the module's best-effort philosophy).
    #[serde(default)]
    pub comments: Vec<PrComment>,
    /// Review threads from GraphQL, including their resolution state and
    /// per-line discussion. `None` means the REST fallback could not obtain
    /// this token-only data; an empty vector means GraphQL found no threads.
    #[serde(rename = "reviewThreads", default)]
    pub review_threads: Option<Vec<PrReviewThread>>,
}

/// A single issue comment on a PR, as surfaced to the frontend.
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct PrComment {
    /// Comment author's login, or `None` when the account was deleted
    /// (GitHub returns a null `author`).
    pub author: Option<String>,
    /// ISO-8601 creation timestamp (GraphQL `createdAt`), rendered to a
    /// relative time by the frontend.
    #[serde(rename = "createdAt")]
    pub created_at: String,
    /// Comment text (GraphQL `bodyText` — plain text, no markdown markup).
    pub body: String,
}

/// A GitHub pull-request review thread, as rendered in the inline PR detail.
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct PrReviewThread {
    pub resolved: bool,
    pub comments: Vec<PrReviewComment>,
}

/// A single comment belonging to a review thread.
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct PrReviewComment {
    pub author: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    pub body: String,
    pub path: Option<String>,
    pub line: Option<u64>,
}

/// A failed GitHub Actions job associated with an open PR. The opaque IDs are
/// produced by `gh pr checks`; callers only pass them back to retrieve the
/// corresponding log, never construct shell arguments from free-form text.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FailedCiCheck {
    pub name: String,
    #[serde(rename = "runId")]
    pub run_id: u64,
    #[serde(rename = "jobId")]
    pub job_id: u64,
}

/// The selected failed check and the text emitted by `gh run view --log-failed`.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FailedCiCheckLog {
    #[serde(rename = "checkName")]
    pub check_name: String,
    pub log: String,
}

/// How many trailing comments the single GraphQL query fetches per PR. Kept
/// small so the one-request design stays cheap; older comments are truncated.
const COMMENT_FETCH_CAP: usize = 20;
/// The review-thread query fans out beneath every open PR. These two caps keep
/// the worst case (100 PRs × 50 threads × 50 comments, plus PR comments) below
/// GitHub GraphQL's 500,000-node validation limit.
const REVIEW_THREAD_FETCH_CAP: usize = 50;
const REVIEW_COMMENT_FETCH_CAP: usize = 50;

const OPEN_PRS_QUERY: &str = "query($owner:String!,$name:String!){\
repository(owner:$owner,name:$name){\
pullRequests(states:OPEN,first:100){nodes{\
number title url isDraft headRefName reviewDecision bodyText \
comments(last:20){totalCount nodes{author{login} createdAt bodyText}} \
reviewThreads(first:50){nodes{isResolved comments(first:50){nodes{author{login} createdAt bodyText path line}}}} \
commits(last:1){nodes{commit{statusCheckRollup{state}}}}\
}}}}";

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
    /// Raw markdown description; the REST list endpoint returns it inline.
    #[serde(default)]
    body: Option<String>,
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
            // The REST list endpoint carries none of the status fields; a
            // token-holding session gets them from the GraphQL path instead.
            ci_status: None,
            review_decision: None,
            comment_count: None,
            // REST gives the description inline but not comment bodies (a
            // separate endpoint), so comments degrade to empty here.
            body: p.body.filter(|b| !b.is_empty()),
            comments: Vec::new(),
            review_threads: None,
        }
    }
}

/// Read the ambient GitHub token, if any (`GITHUB_TOKEN`, then `GH_TOKEN`).
fn github_token() -> Option<String> {
    std::env::var("GITHUB_TOKEN")
        .or_else(|_| std::env::var("GH_TOKEN"))
        .ok()
}

/// Open PRs for `owner/repo`. With a token, one GraphQL request fetches the
/// status decorations (CI rollup, review decision, comment count) that the
/// REST list endpoint can't provide without a 1+2N fan-out — this is what the
/// gh CLI does. Without a token (GraphQL requires auth) — or if GraphQL fails
/// at runtime — it falls back to the plain REST list, whose status fields stay
/// `None`.
fn fetch_open_prs(owner: &str, repo: &str) -> Result<Vec<PrInfo>, String> {
    if let Some(token) = github_token() {
        match fetch_open_prs_graphql(owner, repo, &token) {
            Ok(prs) => return Ok(prs),
            Err(e) => {
                log::debug!(
                    "git_open_prs: graphql failed for {owner}/{repo}: {e}; falling back to REST"
                );
            }
        }
    }
    fetch_open_prs_rest(owner, repo)
}

/// GET the open PRs for `owner/repo` via the REST list endpoint. Mirrors
/// `update_check.rs`'s ureq pattern: a `User-Agent` header (GitHub rejects
/// requests without one) and the GitHub REST `Accept` header. Adds bearer auth
/// when a token is set, which raises the unauthenticated rate limit.
fn fetch_open_prs_rest(owner: &str, repo: &str) -> Result<Vec<PrInfo>, String> {
    let url = format!("https://api.github.com/repos/{owner}/{repo}/pulls?state=open&per_page=100");
    let mut request = ureq::get(&url)
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "tauri-explorer-pr-badges");
    if let Some(token) = github_token() {
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

/// One GraphQL request for the open PRs plus their status decorations. The
/// last commit's `statusCheckRollup` gives the CI state; `reviewDecision` and
/// `comments.totalCount` come for free on the same node.
fn fetch_open_prs_graphql(owner: &str, repo: &str, token: &str) -> Result<Vec<PrInfo>, String> {
    let body = serde_json::json!({
        "query": OPEN_PRS_QUERY,
        "variables": { "owner": owner, "name": repo },
    });
    let resp: GqlResponse = ureq::post("https://api.github.com/graphql")
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "tauri-explorer-pr-badges")
        .header("Authorization", &format!("Bearer {token}"))
        .send_json(body)
        .map_err(|e| e.to_string())?
        .body_mut()
        .read_json()
        .map_err(|e| e.to_string())?;
    parse_graphql_prs(resp)
}

/// Extract PR rows from a parsed GraphQL response. Errors when the response
/// carries no `repository` data (e.g. a GraphQL `errors` payload — bad token,
/// missing repo), which the caller treats as a fetch failure. Pure, so the
/// response → `PrInfo` mapping is unit-tested without a network.
fn parse_graphql_prs(resp: GqlResponse) -> Result<Vec<PrInfo>, String> {
    let nodes = resp
        .data
        .and_then(|d| d.repository)
        .map(|r| r.pull_requests.nodes)
        .ok_or_else(|| "graphql response missing repository data".to_string())?;
    Ok(nodes.into_iter().map(PrInfo::from).collect())
}

/// Map GitHub's `StatusState` enum to our lowercase CI status. Unknown/absent
/// states (incl. no configured checks) map to `None` → plain badge.
fn map_ci_state(state: &str) -> Option<String> {
    match state {
        "SUCCESS" => Some("success".to_string()),
        "FAILURE" | "ERROR" => Some("failure".to_string()),
        "PENDING" | "EXPECTED" => Some("pending".to_string()),
        _ => None,
    }
}

/// Map GitHub's `PullRequestReviewDecision` enum to our lowercase form.
fn map_review_decision(decision: &str) -> Option<String> {
    match decision {
        "APPROVED" => Some("approved".to_string()),
        "CHANGES_REQUESTED" => Some("changes_requested".to_string()),
        "REVIEW_REQUIRED" => Some("review_required".to_string()),
        _ => None,
    }
}

// ----- GraphQL response shapes (only the fields we read) -----

#[derive(Deserialize)]
struct GqlResponse {
    #[serde(default)]
    data: Option<GqlData>,
}

#[derive(Deserialize)]
struct GqlData {
    #[serde(default)]
    repository: Option<GqlRepository>,
}

#[derive(Deserialize)]
struct GqlRepository {
    #[serde(rename = "pullRequests")]
    pull_requests: GqlPullRequests,
}

#[derive(Deserialize)]
struct GqlPullRequests {
    #[serde(default)]
    nodes: Vec<GqlPrNode>,
}

#[derive(Deserialize)]
struct GqlPrNode {
    number: u64,
    title: String,
    url: String,
    #[serde(rename = "isDraft", default)]
    is_draft: bool,
    #[serde(rename = "headRefName")]
    head_ref_name: String,
    #[serde(rename = "reviewDecision", default)]
    review_decision: Option<String>,
    #[serde(rename = "bodyText", default)]
    body_text: String,
    #[serde(default)]
    comments: GqlComments,
    #[serde(rename = "reviewThreads", default)]
    review_threads: GqlReviewThreads,
    #[serde(default)]
    commits: GqlCommits,
}

#[derive(Deserialize, Default)]
struct GqlComments {
    #[serde(rename = "totalCount", default)]
    total_count: u64,
    #[serde(default)]
    nodes: Vec<GqlCommentNode>,
}

#[derive(Deserialize)]
struct GqlCommentNode {
    /// Null when the author's account was deleted.
    #[serde(default)]
    author: Option<GqlAuthor>,
    #[serde(rename = "createdAt", default)]
    created_at: String,
    #[serde(rename = "bodyText", default)]
    body_text: String,
}

#[derive(Deserialize, Default)]
struct GqlReviewThreads {
    #[serde(default)]
    nodes: Vec<GqlReviewThreadNode>,
}

#[derive(Deserialize)]
struct GqlReviewThreadNode {
    #[serde(rename = "isResolved", default)]
    is_resolved: bool,
    #[serde(default)]
    comments: GqlReviewComments,
}

#[derive(Deserialize, Default)]
struct GqlReviewComments {
    #[serde(default)]
    nodes: Vec<GqlReviewCommentNode>,
}

#[derive(Deserialize)]
struct GqlReviewCommentNode {
    #[serde(default)]
    author: Option<GqlAuthor>,
    #[serde(rename = "createdAt", default)]
    created_at: String,
    #[serde(rename = "bodyText", default)]
    body_text: String,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    line: Option<u64>,
}

#[derive(Deserialize)]
struct GqlAuthor {
    #[serde(default)]
    login: String,
}

#[derive(Deserialize, Default)]
struct GqlCommits {
    #[serde(default)]
    nodes: Vec<GqlCommitNode>,
}

#[derive(Deserialize)]
struct GqlCommitNode {
    commit: GqlCommit,
}

#[derive(Deserialize)]
struct GqlCommit {
    #[serde(rename = "statusCheckRollup", default)]
    status_check_rollup: Option<GqlRollup>,
}

#[derive(Deserialize)]
struct GqlRollup {
    #[serde(default)]
    state: Option<String>,
}

impl From<GqlPrNode> for PrInfo {
    fn from(n: GqlPrNode) -> Self {
        let ci_status = n
            .commits
            .nodes
            .first()
            .and_then(|c| c.commit.status_check_rollup.as_ref())
            .and_then(|r| r.state.as_deref())
            .and_then(map_ci_state);
        let review_decision = n.review_decision.as_deref().and_then(map_review_decision);
        // Defensively cap the returned comments even if the API sent more than
        // requested; keep the most-recent `COMMENT_FETCH_CAP` (they arrive
        // oldest-first within the `last:N` window).
        let mut comment_nodes = n.comments.nodes;
        if comment_nodes.len() > COMMENT_FETCH_CAP {
            comment_nodes.drain(0..comment_nodes.len() - COMMENT_FETCH_CAP);
        }
        let comments = comment_nodes
            .into_iter()
            .map(|c| PrComment {
                author: c.author.map(|a| a.login),
                created_at: c.created_at,
                body: c.body_text,
            })
            .collect();
        let mut review_thread_nodes = n.review_threads.nodes;
        if review_thread_nodes.len() > REVIEW_THREAD_FETCH_CAP {
            review_thread_nodes.drain(0..review_thread_nodes.len() - REVIEW_THREAD_FETCH_CAP);
        }
        let review_threads = review_thread_nodes
            .into_iter()
            .map(|mut thread| {
                if thread.comments.nodes.len() > REVIEW_COMMENT_FETCH_CAP {
                    thread.comments.nodes.drain(
                        0..thread.comments.nodes.len() - REVIEW_COMMENT_FETCH_CAP,
                    );
                }
                PrReviewThread {
                    resolved: thread.is_resolved,
                    comments: thread
                        .comments
                        .nodes
                    .into_iter()
                    .map(|comment| PrReviewComment {
                        author: comment.author.map(|author| author.login),
                        created_at: comment.created_at,
                        body: comment.body_text,
                        path: comment.path,
                        line: comment.line,
                    })
                    .collect(),
                }
            })
            .collect();
        PrInfo {
            number: n.number,
            title: n.title,
            head_ref: n.head_ref_name,
            html_url: n.url,
            draft: n.is_draft,
            ci_status,
            review_decision,
            // GraphQL always yields a count (0 when no comments) — distinct
            // from the REST path's `None` ("unknown").
            comment_count: Some(n.comments.total_count),
            // Empty description reads as "no body"; normalize to None.
            body: Some(n.body_text).filter(|b| !b.is_empty()),
            comments,
            review_threads: Some(review_threads),
        }
    }
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

#[derive(Deserialize)]
struct GhPrCheck {
    name: String,
    state: String,
    link: String,
}

/// Extract Actions run/job IDs from the URL `gh pr checks` returns. External
/// check providers do not expose an Actions job log, so they are deliberately
/// omitted rather than presenting a button that cannot fulfil its promise.
fn actions_job_ids(link: &str) -> Option<(u64, u64)> {
    let (_, suffix) = link.split_once("/actions/runs/")?;
    let (run, job) = suffix.split_once("/job/")?;
    Some((
        run.parse().ok()?,
        job.split(['/', '?', '#']).next()?.parse().ok()?,
    ))
}

fn failed_actions_checks(json: &str) -> Result<Vec<FailedCiCheck>, AppError> {
    let checks: Vec<GhPrCheck> = serde_json::from_str(json)
        .map_err(|e| AppError::Other(format!("Could not read GitHub check list: {e}")))?;
    Ok(checks
        .into_iter()
        .filter(|check| {
            matches!(
                check.state.as_str(),
                "FAILURE" | "ERROR" | "failure" | "error"
            )
        })
        .filter_map(|check| {
            let (run_id, job_id) = actions_job_ids(&check.link)?;
            Some(FailedCiCheck {
                name: check.name,
                run_id,
                job_id,
            })
        })
        .collect())
}

fn gh_command_error(error: std::io::Error) -> AppError {
    if error.kind() == std::io::ErrorKind::NotFound {
        AppError::Other("GitHub CLI (`gh`) is not installed".to_string())
    } else {
        AppError::from(error)
    }
}

fn run_gh_with_accepted_exit(
    repo_root: &str,
    args: &[String],
    accepts_exit: fn(bool, Option<i32>) -> bool,
    fallback_error: &str,
) -> Result<String, AppError> {
    let mut command = Command::new("gh");
    command.no_console().args(args).current_dir(repo_root);
    let output = command.output().map_err(gh_command_error)?;
    if accepts_exit(output.status.success(), output.status.code()) {
        return Ok(String::from_utf8_lossy(&output.stdout).to_string());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(AppError::Other(if stderr.is_empty() {
        fallback_error.to_string()
    } else {
        stderr
    }))
}

fn accepts_success(success: bool, _code: Option<i32>) -> bool {
    success
}

fn run_gh(repo_root: &str, args: &[String]) -> Result<String, AppError> {
    run_gh_with_accepted_exit(
        repo_root,
        args,
        accepts_success,
        "GitHub CLI could not retrieve the CI check log",
    )
}

/// `gh pr checks` uses exit code 8 to say that some checks are still pending,
/// while still writing the complete JSON check list to stdout. A failed PR can
/// legitimately have both a failed job and a pending job, so that output must
/// remain usable for the failed-check viewer.
fn gh_pr_checks_output(repo_root: &str, args: &[String]) -> Result<String, AppError> {
    run_gh_with_accepted_exit(
        repo_root,
        args,
        accepts_gh_pr_checks_exit,
        "GitHub CLI could not list CI checks",
    )
}

fn accepts_gh_pr_checks_exit(success: bool, code: Option<i32>) -> bool {
    success || code == Some(8)
}

fn github_repo_slug(repo_root: &str) -> Result<String, AppError> {
    let repo = open_repo(Path::new(repo_root))?;
    let url = remote_url(&repo)
        .ok_or_else(|| AppError::Other("This repository has no GitHub remote".to_string()))?;
    let (owner, name) = parse_github_remote(&url).ok_or_else(|| {
        AppError::Other("This repository remote is not hosted on github.com".to_string())
    })?;
    Ok(format!("{owner}/{name}"))
}

/// List failed GitHub Actions checks on an open PR with `gh`. The `link`
/// metadata identifies each Actions job, allowing the next command to request
/// exactly that job's failed output rather than opening a browser.
#[tauri::command]
pub async fn git_failed_ci_checks(
    repo_root: String,
    pr_number: u64,
) -> Result<Vec<FailedCiCheck>, AppError> {
    tokio::task::spawn_blocking(move || {
        let slug = github_repo_slug(&repo_root)?;
        let args = vec![
            "pr".to_string(),
            "checks".to_string(),
            pr_number.to_string(),
            "--repo".to_string(),
            slug,
            "--json".to_string(),
            "name,state,link".to_string(),
        ];
        failed_actions_checks(&gh_pr_checks_output(&repo_root, &args)?)
    })
    .await
    .map_err(|e| AppError::Other(format!("Task join error: {e}")))?
}

/// Return the failed output for one Actions job via the GitHub CLI. IDs were
/// originally emitted by `git_failed_ci_checks`; their numeric type prevents
/// option injection at this IPC boundary.
#[tauri::command]
pub async fn git_failed_ci_check_log(
    repo_root: String,
    check: FailedCiCheck,
) -> Result<FailedCiCheckLog, AppError> {
    tokio::task::spawn_blocking(move || {
        let slug = github_repo_slug(&repo_root)?;
        let args = vec![
            "run".to_string(),
            "view".to_string(),
            check.run_id.to_string(),
            "--repo".to_string(),
            slug,
            "--job".to_string(),
            check.job_id.to_string(),
            "--log-failed".to_string(),
        ];
        Ok(FailedCiCheckLog {
            check_name: check.name,
            log: run_gh(&repo_root, &args)?,
        })
    })
    .await
    .map_err(|e| AppError::Other(format!("Task join error: {e}")))?
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

    #[test]
    fn keeps_only_failed_github_actions_jobs_from_gh_checks() {
        let checks = failed_actions_checks(
            r#"[
                {"name":"Unit tests","state":"FAILURE","link":"https://github.com/o/r/actions/runs/12/job/34"},
                {"name":"Lint","state":"SUCCESS","link":"https://github.com/o/r/actions/runs/12/job/35"},
                {"name":"Deploy preview","state":"PENDING","link":"https://github.com/o/r/actions/runs/13/job/36"},
                {"name":"External CI","state":"ERROR","link":"https://ci.example.test/build/7"}
            ]"#,
        )
        .unwrap();
        assert_eq!(checks.len(), 1);
        assert_eq!(checks[0].name, "Unit tests");
        assert_eq!(checks[0].run_id, 12);
        assert_eq!(checks[0].job_id, 34);
    }

    #[test]
    fn accepts_gh_pending_checks_exit_code_with_json_output() {
        assert!(accepts_gh_pr_checks_exit(false, Some(8)));
        assert!(accepts_gh_pr_checks_exit(true, Some(0)));
        assert!(!accepts_gh_pr_checks_exit(false, Some(1)));
    }

    // ----- GraphQL response → PrInfo mapping (#459) -----

    /// Build a GraphQL response body wrapping a single PR node's inner JSON.
    fn gql_body(node_fields: &str) -> serde_json::Value {
        serde_json::json!({
            "data": { "repository": { "pullRequests": { "nodes": [
                serde_json::from_str::<serde_json::Value>(node_fields).unwrap()
            ] } } }
        })
    }

    fn parse_one(node_fields: &str) -> PrInfo {
        let resp: GqlResponse = serde_json::from_value(gql_body(node_fields)).unwrap();
        let mut prs = parse_graphql_prs(resp).unwrap();
        assert_eq!(prs.len(), 1);
        prs.remove(0)
    }

    #[test]
    fn maps_core_fields_and_success_rollup() {
        let pr = parse_one(
            r#"{
                "number": 7, "title": "Add feature", "url": "https://github.com/o/r/pull/7",
                "isDraft": false, "headRefName": "feature", "reviewDecision": "APPROVED",
                "comments": { "totalCount": 3 },
                "commits": { "nodes": [ { "commit": { "statusCheckRollup": { "state": "SUCCESS" } } } ] }
            }"#,
        );
        assert_eq!(pr.number, 7);
        assert_eq!(pr.title, "Add feature");
        assert_eq!(pr.head_ref, "feature");
        assert_eq!(pr.html_url, "https://github.com/o/r/pull/7");
        assert!(!pr.draft);
        assert_eq!(pr.ci_status.as_deref(), Some("success"));
        assert_eq!(pr.review_decision.as_deref(), Some("approved"));
        assert_eq!(pr.comment_count, Some(3));
    }

    #[test]
    fn maps_all_ci_rollup_states() {
        let cases: &[(&str, Option<&str>)] = &[
            ("SUCCESS", Some("success")),
            ("FAILURE", Some("failure")),
            ("ERROR", Some("failure")),
            ("PENDING", Some("pending")),
            ("EXPECTED", Some("pending")),
            // Unknown / unexpected enum value → no badge color.
            ("WHATEVER", None),
        ];
        for (state, expected) in cases {
            let node = format!(
                r#"{{ "number": 1, "title": "t", "url": "u", "isDraft": false,
                     "headRefName": "b", "reviewDecision": null,
                     "comments": {{ "totalCount": 0 }},
                     "commits": {{ "nodes": [ {{ "commit": {{ "statusCheckRollup": {{ "state": "{state}" }} }} }} ] }} }}"#
            );
            assert_eq!(
                parse_one(&node).ci_status.as_deref(),
                *expected,
                "state {state}"
            );
        }
    }

    #[test]
    fn null_rollup_and_no_commits_yield_no_ci_status() {
        // statusCheckRollup: null (repo has no checks configured).
        let no_rollup = parse_one(
            r#"{ "number": 1, "title": "t", "url": "u", "isDraft": false,
                 "headRefName": "b", "reviewDecision": null, "comments": { "totalCount": 0 },
                 "commits": { "nodes": [ { "commit": { "statusCheckRollup": null } } ] } }"#,
        );
        assert_eq!(no_rollup.ci_status, None);
        // Empty commits list (shouldn't happen, but must not panic).
        let no_commits = parse_one(
            r#"{ "number": 1, "title": "t", "url": "u", "isDraft": false,
                 "headRefName": "b", "reviewDecision": null, "comments": { "totalCount": 0 },
                 "commits": { "nodes": [] } }"#,
        );
        assert_eq!(no_commits.ci_status, None);
    }

    #[test]
    fn maps_all_review_decisions() {
        let cases: &[(&str, Option<&str>)] = &[
            ("\"APPROVED\"", Some("approved")),
            ("\"CHANGES_REQUESTED\"", Some("changes_requested")),
            ("\"REVIEW_REQUIRED\"", Some("review_required")),
            ("null", None),
            ("\"SOMETHING_NEW\"", None),
        ];
        for (decision, expected) in cases {
            let node = format!(
                r#"{{ "number": 1, "title": "t", "url": "u", "isDraft": false,
                     "headRefName": "b", "reviewDecision": {decision},
                     "comments": {{ "totalCount": 0 }},
                     "commits": {{ "nodes": [] }} }}"#
            );
            assert_eq!(
                parse_one(&node).review_decision.as_deref(),
                *expected,
                "decision {decision}"
            );
        }
    }

    #[test]
    fn draft_flag_and_comment_count_flow_through() {
        let pr = parse_one(
            r#"{ "number": 12, "title": "wip", "url": "u", "isDraft": true,
                 "headRefName": "experiment", "reviewDecision": "CHANGES_REQUESTED",
                 "comments": { "totalCount": 0 }, "commits": { "nodes": [] } }"#,
        );
        assert!(pr.draft);
        assert_eq!(pr.comment_count, Some(0));
        assert_eq!(pr.review_decision.as_deref(), Some("changes_requested"));
    }

    #[test]
    fn tolerates_missing_optional_fields() {
        // No reviewDecision, comments, or commits keys at all — defaults kick
        // in rather than failing to deserialize.
        let pr = parse_one(
            r#"{ "number": 5, "title": "t", "url": "u", "isDraft": false, "headRefName": "b" }"#,
        );
        assert_eq!(pr.ci_status, None);
        assert_eq!(pr.review_decision, None);
        assert_eq!(pr.comment_count, Some(0));
    }

    #[test]
    fn errors_payload_and_null_repository_are_fetch_failures() {
        // A GraphQL `errors` response carries no repository data.
        let errors: GqlResponse = serde_json::from_value(serde_json::json!({
            "data": { "repository": null },
            "errors": [ { "message": "Could not resolve to a Repository" } ]
        }))
        .unwrap();
        assert!(parse_graphql_prs(errors).is_err());

        // Missing `data` entirely.
        let empty: GqlResponse = serde_json::from_value(serde_json::json!({})).unwrap();
        assert!(parse_graphql_prs(empty).is_err());
    }

    #[test]
    fn empty_pull_request_list_is_ok_empty() {
        let resp: GqlResponse = serde_json::from_value(serde_json::json!({
            "data": { "repository": { "pullRequests": { "nodes": [] } } }
        }))
        .unwrap();
        assert_eq!(parse_graphql_prs(resp).unwrap().len(), 0);
    }

    #[test]
    fn pr_info_serializes_status_fields_camelcase_with_nulls() {
        // REST-path PrInfo (all status fields None) must serialize the keys as
        // camelCase `null`, matching the frontend's `| null` typing.
        let pr = PrInfo {
            number: 1,
            title: "t".to_string(),
            head_ref: "b".to_string(),
            html_url: "u".to_string(),
            draft: false,
            ci_status: None,
            review_decision: None,
            comment_count: None,
            body: None,
            comments: Vec::new(),
            review_threads: None,
        };
        let v = serde_json::to_value(&pr).unwrap();
        assert!(v.get("ciStatus").unwrap().is_null());
        assert!(v.get("reviewDecision").unwrap().is_null());
        assert!(v.get("commentCount").unwrap().is_null());
        assert!(v.get("body").unwrap().is_null());
        assert!(v.get("comments").unwrap().as_array().unwrap().is_empty());
        assert_eq!(v.get("headRef").unwrap(), "b");
    }

    // ----- Body + comments parsing (#468) -----

    #[test]
    fn maps_body_text_and_comments() {
        let pr = parse_one(
            r#"{
                "number": 7, "title": "Add feature", "url": "u",
                "isDraft": false, "headRefName": "feature", "reviewDecision": null,
                "bodyText": "This PR adds a feature.\nSecond line.",
                "comments": { "totalCount": 2, "nodes": [
                    { "author": { "login": "alice" }, "createdAt": "2024-01-01T10:00:00Z", "bodyText": "Looks good" },
                    { "author": { "login": "bob" }, "createdAt": "2024-01-02T11:30:00Z", "bodyText": "Nit: rename" }
                ] },
                "commits": { "nodes": [] }
            }"#,
        );
        assert_eq!(
            pr.body.as_deref(),
            Some("This PR adds a feature.\nSecond line.")
        );
        assert_eq!(pr.comment_count, Some(2));
        assert_eq!(pr.comments.len(), 2);
        assert_eq!(pr.comments[0].author.as_deref(), Some("alice"));
        assert_eq!(pr.comments[0].created_at, "2024-01-01T10:00:00Z");
        assert_eq!(pr.comments[0].body, "Looks good");
        assert_eq!(pr.comments[1].author.as_deref(), Some("bob"));
    }

    #[test]
    fn maps_review_threads() {
        let pr = parse_one(
            r#"{
                "number": 7, "title": "Add feature", "url": "u",
                "isDraft": false, "headRefName": "feature", "reviewDecision": null,
                "reviewThreads": { "nodes": [
                    { "isResolved": true, "comments": { "nodes": [
                        { "author": { "login": "alice" }, "createdAt": "2024-01-01T10:00:00Z", "bodyText": "Fixed", "path": "src/lib/parser.ts", "line": 42 }
                    ] } },
                    { "isResolved": false, "comments": { "nodes": [
                        { "author": null, "createdAt": "2024-01-02T10:00:00Z", "bodyText": "Please revisit", "path": null, "line": null }
                    ] } }
                ] },
                "commits": { "nodes": [] }
            }"#,
        );
        let threads = pr.review_threads.expect("GraphQL supplies review-thread data");
        assert_eq!(threads.len(), 2);
        assert!(threads[0].resolved);
        assert_eq!(threads[0].comments[0].path.as_deref(), Some("src/lib/parser.ts"));
        assert_eq!(threads[0].comments[0].line, Some(42));
        assert!(!threads[1].resolved);
        assert_eq!(threads[1].comments[0].author, None);
    }

    #[test]
    fn open_pr_query_requests_bounded_review_thread_fields() {
        assert!(OPEN_PRS_QUERY.contains("reviewThreads(first:50)"));
        assert!(OPEN_PRS_QUERY.contains("comments(first:50)"));
        for field in ["isResolved", "createdAt", "bodyText", "path", "line"] {
            assert!(OPEN_PRS_QUERY.contains(field), "query should request {field}");
        }
        assert!(100 * REVIEW_THREAD_FETCH_CAP * REVIEW_COMMENT_FETCH_CAP < 500_000);
    }

    #[test]
    fn empty_body_maps_to_none_and_no_comments_is_empty_vec() {
        // A closed-description PR (empty bodyText) and zero comments — common
        // for freshly opened PRs.
        let pr = parse_one(
            r#"{
                "number": 8, "title": "t", "url": "u", "isDraft": false,
                "headRefName": "b", "reviewDecision": null, "bodyText": "",
                "comments": { "totalCount": 0, "nodes": [] },
                "commits": { "nodes": [] }
            }"#,
        );
        assert_eq!(pr.body, None);
        assert!(pr.comments.is_empty());
        assert_eq!(pr.comment_count, Some(0));
    }

    #[test]
    fn missing_body_and_comment_keys_default_gracefully() {
        // Neither bodyText nor comments present at all (defensive against a
        // trimmed response) — defaults, no deserialize failure.
        let pr = parse_one(
            r#"{ "number": 5, "title": "t", "url": "u", "isDraft": false, "headRefName": "b" }"#,
        );
        assert_eq!(pr.body, None);
        assert!(pr.comments.is_empty());
    }

    #[test]
    fn comment_with_deleted_author_maps_to_none_login() {
        // GitHub returns a null `author` for comments whose account is gone.
        let pr = parse_one(
            r#"{
                "number": 9, "title": "t", "url": "u", "isDraft": false,
                "headRefName": "b", "reviewDecision": null, "bodyText": "desc",
                "comments": { "totalCount": 1, "nodes": [
                    { "author": null, "createdAt": "2024-03-01T00:00:00Z", "bodyText": "ghost note" }
                ] },
                "commits": { "nodes": [] }
            }"#,
        );
        assert_eq!(pr.comments.len(), 1);
        assert_eq!(pr.comments[0].author, None);
        assert_eq!(pr.comments[0].body, "ghost note");
    }

    #[test]
    fn rest_pull_carries_body_but_no_comments() {
        // The REST list shape (GhPull) supplies `body` inline; comment bodies
        // are a separate endpoint, so they degrade to empty.
        let pull: GhPull = serde_json::from_value(serde_json::json!({
            "number": 3, "title": "rest pr", "html_url": "u", "draft": false,
            "body": "REST description", "head": { "ref": "b" }
        }))
        .unwrap();
        let pr = PrInfo::from(pull);
        assert_eq!(pr.body.as_deref(), Some("REST description"));
        assert!(pr.comments.is_empty());
        assert_eq!(pr.comment_count, None);
    }

    #[test]
    fn rest_pull_null_body_maps_to_none() {
        let pull: GhPull = serde_json::from_value(serde_json::json!({
            "number": 4, "title": "rest pr", "html_url": "u", "draft": false,
            "body": null, "head": { "ref": "b" }
        }))
        .unwrap();
        assert_eq!(PrInfo::from(pull).body, None);
    }
}
