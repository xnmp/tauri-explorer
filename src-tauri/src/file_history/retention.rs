//! Bound retained recovery after filesystem execution, independently of the
//! transient receipt budget. Completed effects never become retryable work.
use super::model::{
    artifact_item_bytes, entry_bytes, Action, Direction, Execution, Recovery,
    ARTIFACT_MAP_OVERHEAD, ENTRY_OVERHEAD, MAX_BYTES,
};
use std::{collections::BTreeMap, sync::Arc};

pub(super) struct Retained {
    pub action: Option<Action>,
    pub warning: Option<String>,
}

fn count(action: &Action) -> usize {
    match action {
        Action::Batch { actions, .. } => actions.iter().map(count).sum(),
        Action::Delete { paths, .. } => paths.len(),
        _ => 1,
    }
}

/// Partial execution can allocate larger vector capacities than its source.
/// Remove that incidental slack before comparing the two retained positions.
fn compact(action: Action) -> Action {
    match action {
        Action::Batch { actions, label } => Action::Batch {
            actions: actions
                .into_iter()
                .map(compact)
                .collect::<Vec<_>>()
                .into_boxed_slice()
                .into_vec(),
            label,
        },
        Action::Delete {
            paths,
            parent_dir,
            recovery,
        } => Action::Delete {
            paths: paths.into_boxed_slice().into_vec(),
            parent_dir,
            recovery,
        },
        action => action,
    }
}

/// Keep a contiguous prefix in the next execution order. Batch siblings may
/// depend on each other: after dropping one, retaining a later sibling is not
/// safe merely because it is smaller. Stored order is preserved for execution.
fn fit(action: Action, direction: Direction, budget: usize) -> Option<Action> {
    if action.retained_bytes() <= budget {
        return Some(action);
    }
    match action {
        Action::Batch { mut actions, label } => {
            let overhead = std::mem::size_of::<Action>() + label.capacity();
            let mut available = budget.checked_sub(overhead)?;
            if direction == Direction::Undo {
                actions.reverse();
            }
            let mut retained = Vec::new();
            for action in actions {
                let before = count(&action);
                let Some(child) = fit(action, direction, available) else {
                    break;
                };
                available -= child.retained_bytes();
                let partial = count(&child) != before;
                retained.push(child);
                if partial {
                    break;
                }
            }
            if retained.is_empty() {
                return None;
            }
            if direction == Direction::Undo {
                retained.reverse();
            }
            Some(Action::Batch {
                actions: retained.into_boxed_slice().into_vec(),
                label,
            })
        }
        Action::Delete {
            paths,
            parent_dir,
            recovery: Recovery::Restore(artifacts),
        } => {
            let mut available = budget.checked_sub(
                std::mem::size_of::<Action>() + parent_dir.capacity() + ARTIFACT_MAP_OVERHEAD,
            )?;
            let mut retained = Vec::new();
            let mut receipts = BTreeMap::new();
            for path in paths {
                let artifact = artifacts.get(&path)?;
                let key = path.clone();
                let cost = std::mem::size_of::<String>()
                    + path.capacity()
                    + artifact_item_bytes(&key, artifact);
                let Some(rest) = available.checked_sub(cost) else {
                    break;
                };
                available = rest;
                receipts.insert(key, artifact.clone());
                retained.push(path);
            }
            if retained.is_empty() {
                return None;
            }
            Some(Action::Delete {
                paths: retained.into_boxed_slice().into_vec(),
                parent_dir,
                recovery: Recovery::Restore(Arc::new(receipts)),
            })
        }
        // Capture actions and indivisible inverses retain their full contract.
        _ => None,
    }
}

pub(super) fn retain(action: Action, direction: Direction, entry_budget: usize) -> Retained {
    let action = compact(action);
    let before = count(&action);
    let action = entry_budget
        .checked_sub(ENTRY_OVERHEAD)
        .and_then(|budget| fit(action, direction, budget));
    let dropped = before - action.as_ref().map_or(0, count);
    debug_assert!(action
        .as_ref()
        .is_none_or(|action| entry_bytes(action) <= entry_budget));
    Retained {
        action,
        warning: (dropped != 0).then(|| format!("File history memory budget exceeded; recovery for {dropped} completed item(s) is unavailable")),
    }
}

pub(super) fn settlement(mut result: Execution, executed: Direction) -> Execution {
    result.remaining = result.remaining.map(compact);
    let remaining_bytes = result.remaining.as_ref().map_or(0, entry_bytes);
    // Remaining is a subset of an admitted source; it must never be dropped
    // merely to make room for recovery of already completed effects.
    debug_assert!(remaining_bytes <= MAX_BYTES);
    if let Some(opposite) = result.opposite.take() {
        let next = match executed {
            Direction::Undo => Direction::Redo,
            Direction::Redo => Direction::Undo,
        };
        let retained = retain(opposite, next, MAX_BYTES.saturating_sub(remaining_bytes));
        result.opposite = retained.action;
        if let Some(warning) = retained.warning {
            result.error = Some(match result.error {
                Some(error) => format!("{error}; {warning}"),
                None => warning,
            });
        }
    }
    result
}

#[cfg(test)]
#[path = "../../test_support/file_history_retention.rs"]
mod tests;
