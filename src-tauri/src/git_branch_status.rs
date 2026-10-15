//! Trunk-aware branch classification for the commit graph's branch badges
//! (#1081).
//!
//! A plain "is the tip an ancestor of HEAD" check misreads three common shapes:
//! a branch that is merely *behind* trunk (its tip sits on trunk's own
//! first-parent chain), a branch merely lagging its own upstream, and a branch
//! whose work landed as a single squash commit (different OIDs, same patch).
//! This module resolves the trunk independently of the checked-out branch and
//! reports, per branch, one of `merged`, `squash_merged`, `stale` or `unknown`.
//! Branches with no status are omitted.
//!
//! The badges are informational only: the graph's "Mute merge commits" toggle
//! keeps dimming exactly the rows with two or more parents.
//!
//! Work is bounded: the trunk first-parent walk and each branch's squash
//! search (the patch-id diffs) stop at fixed limits, and a search that hits its
//! limit reports `unknown` rather than guessing a positive status. Ancestry
//! checks use libgit2's date-pruned merge-base walks. Results are cached per
//! repository until a branch tip, upstream or the trunk moves, and requests
//! for one repository run single-flight, so reload bursts do not pile up.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Arc, LazyLock, Mutex};

use git2::{BranchType, DiffOptions, Oid, Repository};
use serde::Serialize;

use crate::error::AppError;
use crate::git_common::{open_repo, to_app_err};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BranchStatus {
    /// The tip is reachable from trunk through a merge (not trunk's own
    /// first-parent line).
    Merged,
    /// The branch's combined change landed on trunk as one squash commit.
    SquashMerged,
    /// A local branch strictly behind its upstream, or a remote-tracking
    /// branch strictly behind the local branch that tracks it.
    Stale,
    /// A bounded search ran out before reaching a verdict.
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BranchStatusEntry {
    /// Shorthand, e.g. `feature` or `origin/feature`.
    pub name: String,
    pub remote: bool,
    pub status: BranchStatus,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct BranchStatuses {
    /// Shorthand of the resolved trunk, `None` when none resolved (then
    /// `statuses` is empty).
    pub trunk: Option<String>,
    pub statuses: Vec<BranchStatusEntry>,
}

/// Search bounds. Exposed so tests can exhaust them on tiny repos.
#[derive(Debug, Clone, Copy)]
pub struct ClassifyLimits {
    /// Commits of trunk's first-parent chain collected to recognise a tip
    /// that is merely behind trunk.
    pub first_parent: usize,
    /// Trunk first-parent commits examined per branch for a squash match.
    pub squash: usize,
}

pub const DEFAULT_LIMITS: ClassifyLimits = ClassifyLimits {
    first_parent: 20_000,
    squash: 1_000,
};

/// Names never classified merged/squash_merged, whatever trunk resolves to.
const PROTECTED: [&str; 2] = ["main", "master"];

struct Trunk {
    name: String,
    /// Branch part of the trunk name (`main` for `origin/main`).
    branch: String,
    tip: Oid,
}

struct BranchInfo {
    name: String,
    /// Branch part without the remote prefix.
    branch: String,
    /// Full ref name, e.g. `refs/heads/feature`.
    refname: String,
    remote: bool,
    tip: Oid,
}

fn remote_names(repo: &Repository) -> Vec<String> {
    let mut names: Vec<String> = repo
        .remotes()
        .map(|list| {
            list.iter()
                .filter_map(|name| name.ok().flatten().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    // `origin` first so its HEAD wins over other remotes'.
    names.sort_by_key(|name| (name != "origin", name.clone()));
    names
}

/// Strip the `<remote>/` prefix from a remote-tracking shorthand.
fn branch_part(name: &str, remotes: &[String]) -> String {
    remotes
        .iter()
        .find_map(|remote| name.strip_prefix(&format!("{remote}/")))
        .or_else(|| name.split_once('/').map(|(_, rest)| rest))
        .unwrap_or(name)
        .to_string()
}

/// Trunk is `<remote>/HEAD`'s target, then `init.defaultBranch`, then `main`,
/// then `master` — never the checked-out branch.
fn resolve_trunk(repo: &Repository, remotes: &[String]) -> Option<Trunk> {
    for remote in remotes {
        let Ok(head) = repo.find_reference(&format!("refs/remotes/{remote}/HEAD")) else {
            continue;
        };
        let Some(target) = head.symbolic_target().ok().flatten().map(str::to_string) else {
            continue;
        };
        if let Ok(reference) = repo.find_reference(&target) {
            if let (Some(tip), Some(short)) = (
                reference.target(),
                target.strip_prefix("refs/remotes/").map(str::to_string),
            ) {
                return Some(Trunk {
                    branch: branch_part(&short, remotes),
                    name: short,
                    tip,
                });
            }
        }
    }
    let default_branch = repo
        .config()
        .ok()
        .and_then(|config| config.get_string("init.defaultBranch").ok())
        .filter(|name| !name.trim().is_empty());
    default_branch
        .into_iter()
        .chain(PROTECTED.iter().map(|name| name.to_string()))
        .find_map(|name| {
            let tip = repo
                .find_reference(&format!("refs/heads/{name}"))
                .ok()?
                .target()?;
            Some(Trunk {
                branch: name.clone(),
                name,
                tip,
            })
        })
}

fn gather(repo: &Repository, remotes: &[String]) -> Vec<BranchInfo> {
    let mut out = Vec::new();
    let Ok(branches) = repo.branches(None) else {
        return out;
    };
    for (branch, kind) in branches.flatten() {
        let reference = branch.get();
        let (Some(name), Some(refname), Some(tip)) = (
            reference.shorthand().ok().map(str::to_string),
            reference.name().ok().map(str::to_string),
            reference.target(),
        ) else {
            continue;
        };
        if name.ends_with("/HEAD") {
            continue;
        }
        let remote = kind == BranchType::Remote;
        out.push(BranchInfo {
            branch: if remote {
                branch_part(&name, remotes)
            } else {
                name.clone()
            },
            name,
            refname,
            remote,
            tip,
        });
    }
    out
}

/// `older` is a strict ancestor of `newer`.
fn strictly_behind(repo: &Repository, older: Oid, newer: Oid) -> bool {
    older != newer && repo.graph_descendant_of(newer, older).unwrap_or(false)
}

/// Upstream full ref name per local branch ref, e.g.
/// `refs/heads/feature` → `refs/remotes/origin/feature`.
fn upstreams(repo: &Repository, branches: &[BranchInfo]) -> HashMap<String, String> {
    branches
        .iter()
        .filter(|branch| !branch.remote)
        .filter_map(|branch| {
            let upstream = repo.branch_upstream_name(&branch.refname).ok()?;
            Some((branch.refname.clone(), upstream.as_str().ok()?.to_string()))
        })
        .collect()
}

fn is_stale(
    repo: &Repository,
    branch: &BranchInfo,
    branches: &[BranchInfo],
    upstreams: &HashMap<String, String>,
) -> bool {
    let tip_of = |refname: &str| {
        branches
            .iter()
            .find(|candidate| candidate.refname == refname)
            .map(|candidate| candidate.tip)
    };
    if branch.remote {
        upstreams
            .iter()
            .filter(|(_, upstream)| **upstream == branch.refname)
            .filter_map(|(local, _)| tip_of(local))
            .any(|local_tip| strictly_behind(repo, branch.tip, local_tip))
    } else {
        upstreams
            .get(&branch.refname)
            .and_then(|upstream| tip_of(upstream))
            .is_some_and(|upstream_tip| strictly_behind(repo, branch.tip, upstream_tip))
    }
}

/// Trunk's first-parent chain, plus the first commit left uncollected when
/// the walk hit its limit (every deeper chain commit is its ancestor).
fn first_parent_chain(
    repo: &Repository,
    tip: Oid,
    limit: usize,
) -> Result<(HashSet<Oid>, Option<Oid>), AppError> {
    let mut walk = repo.revwalk().map_err(to_app_err)?;
    walk.simplify_first_parent().map_err(to_app_err)?;
    walk.push(tip).map_err(to_app_err)?;
    let mut chain = HashSet::new();
    for step in walk {
        let oid = step.map_err(to_app_err)?;
        if chain.len() == limit {
            return Ok((chain, Some(oid)));
        }
        chain.insert(oid);
    }
    Ok((chain, None))
}

fn tree_patch_id(repo: &Repository, old: Oid, new: Oid) -> Option<Oid> {
    let old_tree = repo.find_commit(old).ok()?.tree().ok()?;
    let new_tree = repo.find_commit(new).ok()?.tree().ok()?;
    let mut options = DiffOptions::new();
    let diff = repo
        .diff_tree_to_tree(Some(&old_tree), Some(&new_tree), Some(&mut options))
        .ok()?;
    if diff.deltas().len() == 0 {
        return None;
    }
    diff.patchid(None).ok()
}

/// Does trunk carry one commit whose patch equals the branch's combined diff
/// since its merge base? `None` = the search hit its limit.
fn squash_merged(
    repo: &Repository,
    trunk_tip: Oid,
    tip: Oid,
    limit: usize,
    trunk_patch_ids: &mut HashMap<Oid, Option<Oid>>,
) -> Option<bool> {
    let Ok(base) = repo.merge_base(trunk_tip, tip) else {
        return Some(false);
    };
    let Some(branch_patch) = tree_patch_id(repo, base, tip) else {
        return Some(false);
    };
    let mut walk = repo.revwalk().ok()?;
    walk.simplify_first_parent().ok()?;
    walk.push(trunk_tip).ok()?;
    walk.hide(base).ok()?;
    for (examined, step) in walk.enumerate() {
        if examined == limit {
            return None;
        }
        let oid = step.ok()?;
        let patch = *trunk_patch_ids.entry(oid).or_insert_with(|| {
            let commit = repo.find_commit(oid).ok()?;
            if commit.parent_count() != 1 {
                return None;
            }
            tree_patch_id(repo, commit.parent_id(0).ok()?, oid)
        });
        if patch == Some(branch_patch) {
            return Some(true);
        }
    }
    Some(false)
}

/// Classify every local and remote-tracking branch against the resolved
/// trunk. This is exactly what the `git_branch_statuses` command returns.
pub fn classify_branches(
    repo: &Repository,
    limits: ClassifyLimits,
) -> Result<BranchStatuses, AppError> {
    let remotes = remote_names(repo);
    let Some(trunk) = resolve_trunk(repo, &remotes) else {
        return Ok(BranchStatuses::default());
    };
    let branches = gather(repo, &remotes);
    let upstreams = upstreams(repo, &branches);
    let (chain, chain_rest) = first_parent_chain(repo, trunk.tip, limits.first_parent)?;
    let mut trunk_patch_ids = HashMap::new();
    let mut statuses = Vec::new();

    for branch in &branches {
        let status = if is_stale(repo, branch, &branches, &upstreams) {
            Some(BranchStatus::Stale)
        } else if branch.name == trunk.name
            || branch.branch == trunk.branch
            || PROTECTED.contains(&branch.branch.as_str())
            || chain.contains(&branch.tip)
        {
            None
        } else if repo
            .graph_descendant_of(trunk.tip, branch.tip)
            .unwrap_or(false)
        {
            // Not on the collected chain. When that chain was cut short, a
            // tip at or below its uncollected rest may still lie on trunk's
            // own line; any other tip was merged in above the cut.
            let maybe_on_chain = chain_rest.is_some_and(|rest| {
                rest == branch.tip || repo.graph_descendant_of(rest, branch.tip).unwrap_or(false)
            });
            Some(if maybe_on_chain {
                BranchStatus::Unknown
            } else {
                BranchStatus::Merged
            })
        } else {
            match squash_merged(
                repo,
                trunk.tip,
                branch.tip,
                limits.squash,
                &mut trunk_patch_ids,
            ) {
                Some(true) => Some(BranchStatus::SquashMerged),
                Some(false) => None,
                None => Some(BranchStatus::Unknown),
            }
        };
        if let Some(status) = status {
            statuses.push(BranchStatusEntry {
                name: branch.name.clone(),
                remote: branch.remote,
                status,
            });
        }
    }
    statuses.sort_by(|a, b| (a.remote, &a.name).cmp(&(b.remote, &b.name)));
    Ok(BranchStatuses {
        trunk: Some(trunk.name),
        statuses,
    })
}

/// Every input `classify_branches` reads besides the immutable object graph:
/// the trunk, each branch tip and each upstream mapping.
fn inputs_signature(repo: &Repository) -> String {
    let remotes = remote_names(repo);
    let trunk = resolve_trunk(repo, &remotes)
        .map(|trunk| format!("{}={}", trunk.name, trunk.tip))
        .unwrap_or_default();
    let branches = gather(repo, &remotes);
    let mut parts: Vec<String> = branches
        .iter()
        .map(|branch| format!("{}={}", branch.refname, branch.tip))
        .chain(
            upstreams(repo, &branches)
                .into_iter()
                .map(|(local, upstream)| format!("{local}>{upstream}")),
        )
        .collect();
    parts.sort();
    format!("{trunk}\n{}", parts.join("\n"))
}

type ResultCache = HashMap<String, (String, BranchStatuses)>;

static RESULTS: LazyLock<Mutex<ResultCache>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static REPO_LOCKS: LazyLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Single-flight, signature-cached classification. Every graph reload asks
/// again (filter changes included), so concurrent requests for one repository
/// run one at a time and reuse the last result while no classification input
/// moved; a ref or upstream change recomputes.
fn classify_cached(repo_path: &str, limits: ClassifyLimits) -> Result<BranchStatuses, AppError> {
    let lock = REPO_LOCKS
        .lock()
        .map_err(|_| AppError::Other("branch status lock poisoned".into()))?
        .entry(repo_path.to_string())
        .or_default()
        .clone();
    let _guard = lock
        .lock()
        .map_err(|_| AppError::Other("branch status lock poisoned".into()))?;
    let repo = open_repo(Path::new(repo_path))?;
    let signature = inputs_signature(&repo);
    if let Ok(cache) = RESULTS.lock() {
        if let Some((cached, result)) = cache.get(repo_path) {
            if *cached == signature {
                return Ok(result.clone());
            }
        }
    }
    let result = classify_branches(&repo, limits)?;
    if let Ok(mut cache) = RESULTS.lock() {
        cache.insert(repo_path.to_string(), (signature, result.clone()));
    }
    Ok(result)
}

/// Merged / squash-merged / stale status per branch for the graph's badges.
#[tauri::command]
pub async fn git_branch_statuses(repo_path: String) -> Result<BranchStatuses, AppError> {
    tokio::task::spawn_blocking(move || classify_cached(&repo_path, DEFAULT_LIMITS))
        .await
        .map_err(|e| AppError::Other(format!("git branch status task join: {e}")))?
}

#[cfg(test)]
#[path = "../test_support/git_branch_status_tests.rs"]
mod tests;
