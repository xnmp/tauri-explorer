//! AI rename suggestions via the Gemini CLI.
//! Issue: feat/plugin-ai-rename-suggestions (#145)
//!
//! Shells out to `gemini -p "<prompt>"` (the non-interactive/headless text-prompt
//! flag — verified via `gemini --help`) with GEMINI_API_KEY set, then parses the
//! returned lines into clean filename suggestions. Text-generation only: no file
//! editing, so `--yolo`/tool auto-approval is unnecessary. Requires the gemini
//! CLI on PATH, the same dependency the nano-banana plugin already carries.

use crate::error::AppError;
use std::collections::HashSet;

/// Upper bound for a single suggestion request. Shorter than nano-banana's image
/// job (a text prompt should return quickly); still generous for a cold CLI.
const SUGGEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

/// Suggest 1-5 filenames for a file, based on its name and (optionally) a
/// caller-provided, already-truncated content hint.
///
/// Returns the cleaned suggestion list. Errors (gemini missing, non-zero exit,
/// timeout, empty output) surface as `AppError` so the UI can toast them.
#[tauri::command]
pub async fn ai_suggest_filenames(
    original_name: String,
    content_hint: Option<String>,
    count: u8,
    api_key: String,
) -> Result<Vec<String>, AppError> {
    if api_key.is_empty() {
        return Err(AppError::Other(
            "Gemini API key is not configured".to_string(),
        ));
    }

    let count = count.clamp(1, 5) as usize;
    let prompt = build_prompt(&original_name, content_hint.as_deref(), count);

    let raw =
        match tokio::time::timeout(SUGGEST_TIMEOUT, run_gemini_suggest(&prompt, &api_key)).await {
            Ok(result) => result?,
            Err(_) => {
                return Err(AppError::Other(format!(
                    "AI rename timed out after {} seconds",
                    SUGGEST_TIMEOUT.as_secs()
                )))
            }
        };

    let suggestions = clean_suggestions(&raw, &original_name, count);
    if suggestions.is_empty() {
        return Err(AppError::Other(
            "The model returned no usable filename suggestions".to_string(),
        ));
    }
    Ok(suggestions)
}

/// Build a tight, deterministic prompt. The content hint is only ever present
/// when the caller (the explicit user action) supplied it.
fn build_prompt(original_name: &str, content_hint: Option<&str>, count: usize) -> String {
    let hint = match content_hint {
        Some(h) if !h.trim().is_empty() => format!(", whose content begins:\n{}\n", h.trim()),
        _ => String::new(),
    };
    format!(
        "Suggest {count} concise, descriptive filenames (keep the original extension, no path, \
         match the original's naming style e.g. kebab-case or snake_case) for a file currently \
         named '{original_name}'{hint}. Return ONLY the filenames, one per line, with no \
         numbering, quotes, or commentary."
    )
}

/// Invoke the gemini CLI in non-interactive mode with the prompt.
async fn run_gemini_suggest(prompt: &str, api_key: &str) -> Result<String, AppError> {
    log::info!("AI rename: gemini -p \"{}\"", prompt);

    let result = tokio::process::Command::new("gemini")
        .arg("-p")
        .arg(prompt)
        .env("GEMINI_API_KEY", api_key)
        .kill_on_drop(true)
        .output()
        .await
        .map_err(|e| {
            AppError::Other(format!(
                "Failed to start gemini CLI (is it installed?): {}",
                e
            ))
        })?;

    if !result.status.success() {
        let stderr = String::from_utf8_lossy(&result.stderr);
        return Err(AppError::Other(format!(
            "gemini exited with {}: {}",
            result.status,
            stderr.trim()
        )));
    }

    Ok(String::from_utf8_lossy(&result.stdout).to_string())
}

/// The extension of `name` including the leading dot (e.g. ".md"), or "" when
/// there is none. Mirrors the frontend `getExtension` rule: a leading dot
/// (dotfile like `.gitignore`) and a trailing dot are not extensions.
fn extension_with_dot(name: &str) -> &str {
    match name.rfind('.') {
        Some(i) if i > 0 && i < name.len() - 1 => &name[i..],
        _ => "",
    }
}

/// Strip a leading list marker ("1. ", "2) ", "- ", "* ", "• ") from a line.
fn strip_list_marker(s: &str) -> &str {
    let t = s.trim_start();
    for m in ["- ", "* ", "• "] {
        if let Some(rest) = t.strip_prefix(m) {
            return rest.trim_start();
        }
    }
    let digit_len = t.chars().take_while(|c| c.is_ascii_digit()).count();
    if digit_len > 0 {
        let rest = &t[digit_len..];
        if let Some(r) = rest.strip_prefix(". ").or_else(|| rest.strip_prefix(") ")) {
            return r.trim_start();
        }
    }
    t
}

/// Guarantee `name` ends with `original_ext`. If it already does, unchanged; if
/// it has no (or a different) extension, its own extension is replaced/appended.
fn ensure_extension(name: &str, original_ext: &str) -> String {
    if original_ext.is_empty() {
        return name.to_string();
    }
    if name.to_lowercase().ends_with(&original_ext.to_lowercase()) {
        return name.to_string();
    }
    let stem = match name.rfind('.') {
        Some(i) if i > 0 => &name[..i],
        _ => name,
    };
    format!("{}{}", stem, original_ext)
}

/// Pure parsing of raw model output into clean, deduped filename suggestions.
///
/// Strips code fences, list markers, wrapping quotes/backticks; drops empties
/// and anything containing a path separator; normalizes each to the original
/// extension; dedups case-insensitively; caps to `count`.
pub fn clean_suggestions(raw: &str, original_name: &str, count: usize) -> Vec<String> {
    let original_ext = extension_with_dot(original_name);
    let mut seen: HashSet<String> = HashSet::new();
    let mut out: Vec<String> = Vec::new();

    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("```") {
            continue; // code fence delimiter
        }
        let unmarked = strip_list_marker(trimmed);
        let cleaned = unmarked
            .trim_matches(|c| c == '`' || c == '"' || c == '\'')
            .trim();
        if cleaned.is_empty() {
            continue;
        }
        // A filename, not a path — reject traversal / directory components.
        if cleaned.contains('/') || cleaned.contains('\\') {
            continue;
        }

        let normalized = ensure_extension(cleaned, original_ext);
        if seen.insert(normalized.to_lowercase()) {
            out.push(normalized);
        }
        if out.len() >= count {
            break;
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_plain_lines_and_reappends_missing_extension() {
        let raw = "meeting-notes\nq1-summary.md\nproject_plan";
        let got = clean_suggestions(raw, "notes.md", 3);
        assert_eq!(
            got,
            vec![
                "meeting-notes.md".to_string(),
                "q1-summary.md".to_string(),
                "project_plan.md".to_string(),
            ]
        );
    }

    #[test]
    fn strips_code_fences_and_backticks() {
        let raw = "```\n`report-2024.csv`\ndata-export.csv\n```";
        let got = clean_suggestions(raw, "data.csv", 5);
        assert_eq!(got, vec!["report-2024.csv", "data-export.csv"]);
    }

    #[test]
    fn strips_numbered_and_bulleted_list_markers() {
        let raw = "1. first-name.txt\n2) second-name.txt\n- third-name.txt\n* fourth-name.txt";
        let got = clean_suggestions(raw, "orig.txt", 5);
        assert_eq!(
            got,
            vec![
                "first-name.txt",
                "second-name.txt",
                "third-name.txt",
                "fourth-name.txt"
            ]
        );
    }

    #[test]
    fn dedups_case_insensitively() {
        let raw = "report.md\nReport.md\nREPORT.md\nother.md";
        let got = clean_suggestions(raw, "x.md", 5);
        assert_eq!(got, vec!["report.md", "other.md"]);
    }

    #[test]
    fn caps_to_count() {
        let raw = "a.md\nb.md\nc.md\nd.md\ne.md";
        let got = clean_suggestions(raw, "x.md", 2);
        assert_eq!(got, vec!["a.md", "b.md"]);
    }

    #[test]
    fn rejects_path_separators() {
        let raw = "../escape.md\nfoo/bar.md\ngood-name.md\nC:\\win.md";
        let got = clean_suggestions(raw, "x.md", 5);
        assert_eq!(got, vec!["good-name.md"]);
    }

    #[test]
    fn replaces_a_different_extension_with_the_original() {
        let raw = "renamed.txt";
        let got = clean_suggestions(raw, "photo.png", 3);
        assert_eq!(got, vec!["renamed.png"]);
    }

    #[test]
    fn handles_no_original_extension() {
        let raw = "Makefile-new\nbuild-rules";
        let got = clean_suggestions(raw, "Makefile", 3);
        assert_eq!(got, vec!["Makefile-new", "build-rules"]);
    }

    #[test]
    fn empty_and_garbage_output_yields_empty() {
        assert!(clean_suggestions("", "x.md", 3).is_empty());
        assert!(clean_suggestions("\n\n   \n```\n```\n", "x.md", 3).is_empty());
        // Only path-like garbage → nothing usable.
        assert!(clean_suggestions("/a\n../b\n\\c", "x.md", 3).is_empty());
    }

    #[test]
    fn dotfile_original_has_no_extension() {
        assert_eq!(extension_with_dot(".gitignore"), "");
        assert_eq!(extension_with_dot("file."), "");
        assert_eq!(extension_with_dot("file.md"), ".md");
        assert_eq!(extension_with_dot("a.b.c"), ".c");
    }
}
