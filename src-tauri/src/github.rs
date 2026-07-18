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
            // The REST list endpoint carries none of the status fields; a
            // token-holding session gets them from the GraphQL path instead.
            ci_status: None,
            review_decision: None,
            comment_count: None,
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
    const QUERY: &str = "query($owner:String!,$name:String!){\
repository(owner:$owner,name:$name){\
pullRequests(states:OPEN,first:100){nodes{\
number title url isDraft headRefName reviewDecision \
comments{totalCount} \
commits(last:1){nodes{commit{statusCheckRollup{state}}}}\
}}}}";
    let body = serde_json::json!({
        "query": QUERY,
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
    #[serde(default)]
    comments: GqlComments,
    #[serde(default)]
    commits: GqlCommits,
}

#[derive(Deserialize, Default)]
struct GqlComments {
    #[serde(rename = "totalCount", default)]
    total_count: u64,
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
            assert_eq!(parse_one(&node).ci_status.as_deref(), *expected, "state {state}");
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
        };
        let v = serde_json::to_value(&pr).unwrap();
        assert!(v.get("ciStatus").unwrap().is_null());
        assert!(v.get("reviewDecision").unwrap().is_null());
        assert!(v.get("commentCount").unwrap().is_null());
        assert_eq!(v.get("headRef").unwrap(), "b");
    }
}
