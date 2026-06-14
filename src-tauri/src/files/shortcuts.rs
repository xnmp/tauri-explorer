//! Windows `.lnk` shortcut resolution.
//!
//! Lets the explorer "follow" a shortcut: a `.lnk` pointing at a folder should
//! navigate into that folder in-app, and one pointing at a file should open the
//! real target. We resolve the target with the `WScript.Shell` COM object via a
//! short PowerShell shell-out — the same dependency-free pattern used for the
//! clipboard. The path is passed via an environment variable, never
//! interpolated into the script, so filenames can't break or inject it.
//!
//! On non-Windows platforms there are no `.lnk` files, so the command always
//! resolves to `None` and callers fall back to their normal open/navigate path.

use serde::Serialize;

/// Resolved target of a shortcut.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutTarget {
    /// Absolute path the shortcut points at.
    pub target: String,
    /// Whether that target is a directory (navigate) vs a file (open).
    pub is_dir: bool,
}

#[cfg(windows)]
fn resolve_lnk_target(path: &str) -> Option<String> {
    use crate::process_ext::NoConsole;
    use std::process::Command;

    // WScript.Shell.CreateShortcut(...).TargetPath returns the resolved target.
    let script = r#"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$sh = New-Object -ComObject WScript.Shell
$sc = $sh.CreateShortcut($env:LNK_PATH)
[Console]::Out.Write($sc.TargetPath)
"#;
    let mut cmd = Command::new("powershell");
    cmd.no_console();
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", script]);
    cmd.env("LNK_PATH", path);
    let output = cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let target = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if target.is_empty() {
        None
    } else {
        Some(target)
    }
}

#[cfg(not(windows))]
fn resolve_lnk_target(_path: &str) -> Option<String> {
    None
}

/// Resolve a `.lnk` shortcut to its target. Returns `None` when `path` isn't a
/// shortcut, the target can't be determined, or the target no longer exists —
/// in which case the caller should act on the original path.
pub fn resolve(path: &str) -> Option<ShortcutTarget> {
    let target = resolve_lnk_target(path)?;
    let meta = std::fs::metadata(&target).ok()?;
    Some(ShortcutTarget {
        target,
        is_dir: meta.is_dir(),
    })
}

#[tauri::command]
pub async fn resolve_shortcut(path: String) -> Option<ShortcutTarget> {
    super::run_blocking(move || Ok(resolve(&path)))
        .await
        .unwrap_or(None)
}
