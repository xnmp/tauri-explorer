//! Git status indicators for file entries.
//! Issue: feat/git-status-indicators
//!
//! Runs `git status --porcelain` to detect modified/untracked files
//! in a directory that is inside a git repository.

use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
use std::process::Command;

use crate::error::AppError;

/// Git status for a single file.
#[derive(Debug, Clone, Serialize)]
pub enum GitFileStatus {
    Modified,
    Added,
    Deleted,
    Renamed,
    Untracked,
    Ignored,
    Conflict,
}

/// Git status response for a directory.
#[derive(Debug, Serialize)]
pub struct GitStatusResponse {
    /// Whether this directory is inside a git repository
    pub is_git_repo: bool,
    /// Map of filename → git status (only includes files with status)
    pub statuses: HashMap<String, GitFileStatus>,
}

/// Parse a git status porcelain line into (filename, status).
fn parse_porcelain_line(line: &str) -> Option<(String, GitFileStatus)> {
    if line.len() < 4 {
        return None;
    }

    let xy = &line[0..2];
    let path_str = &line[3..];

    // For renamed files, take the destination path
    let filename = if let Some(pos) = path_str.find(" -> ") {
        &path_str[pos + 4..]
    } else {
        path_str
    };

    let status = match xy {
        "??" => GitFileStatus::Untracked,
        "!!" => GitFileStatus::Ignored,
        "DD" | "AU" | "UD" | "UA" | "DU" | "AA" | "UU" => GitFileStatus::Conflict,
        _ => {
            let index = xy.as_bytes()[0];
            let worktree = xy.as_bytes()[1];

            if worktree == b'D' || index == b'D' {
                GitFileStatus::Deleted
            } else if index == b'R' {
                GitFileStatus::Renamed
            } else if index == b'A' {
                GitFileStatus::Added
            } else if worktree == b'M' || index == b'M' {
                GitFileStatus::Modified
            } else {
                return None; // clean or unknown
            }
        }
    };

    Some((filename.to_string(), status))
}

/// Get git status for all files in the given directory.
#[tauri::command]
pub async fn get_git_status(path: String) -> Result<GitStatusResponse, AppError> {
    let dir = Path::new(&path);
    if !dir.exists() || !dir.is_dir() {
        return Ok(GitStatusResponse {
            is_git_repo: false,
            statuses: HashMap::new(),
        });
    }

    // Check if inside a git repo
    let output = Command::new("git")
        .args(["rev-parse", "--is-inside-work-tree"])
        .current_dir(dir)
        .output();

    let is_git_repo = match output {
        Ok(o) => o.status.success(),
        Err(_) => false,
    };

    if !is_git_repo {
        return Ok(GitStatusResponse {
            is_git_repo: false,
            statuses: HashMap::new(),
        });
    }

    // Get porcelain status
    let output = Command::new("git")
        .args(["status", "--porcelain", "-uall", "."])
        .current_dir(dir)
        .output()
        .map_err(AppError::from)?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut statuses = HashMap::new();

    for line in stdout.lines() {
        if let Some((filepath, status)) = parse_porcelain_line(line) {
            // Extract just the filename (first component relative to dir)
            let name = filepath
                .split('/')
                .next()
                .unwrap_or(&filepath)
                .to_string();
            // Don't overwrite a more specific status with a less specific one
            statuses.entry(name).or_insert(status);
        }
    }

    Ok(GitStatusResponse {
        is_git_repo,
        statuses,
    })
}
