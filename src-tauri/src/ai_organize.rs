//! AI destination suggestions ("where does this file belong") via the Gemini CLI.
//! Issue: #158 — IDE-style move/organize suggestions.
//!
//! Same shape as `ai_rename.rs`: shells out to `gemini -p "<prompt>"` with
//! GEMINI_API_KEY set. The model is constrained to choose among caller-provided
//! candidate folders, and the response is validated against that list — the
//! model can never invent a destination.

use crate::error::AppError;
use std::collections::HashSet;

/// Upper bound for a single suggestion request (matches ai_rename).
const SUGGEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

/// Suggest up to `count` destination folders for a file, chosen from
/// `candidates` (paths as the frontend wants them displayed/used).
///
/// `content_hint` is an optional, already-truncated content head supplied by
/// the explicit user action — the backend never reads files itself here.
#[tauri::command]
pub async fn ai_suggest_destination(
    file_name: String,
    content_hint: Option<String>,
    candidates: Vec<String>,
    count: u8,
    api_key: String,
) -> Result<Vec<String>, AppError> {
    if api_key.is_empty() {
        return Err(AppError::Other(
            "Gemini API key is not configured".to_string(),
        ));
    }
    if candidates.is_empty() {
        return Err(AppError::Other(
            "No candidate folders to choose from".to_string(),
        ));
    }

    let count = count.clamp(1, 5) as usize;
    let prompt = build_prompt(&file_name, content_hint.as_deref(), &candidates, count);

    let raw = match tokio::time::timeout(SUGGEST_TIMEOUT, run_gemini(&prompt, &api_key)).await {
        Ok(result) => result?,
        Err(_) => {
            return Err(AppError::Other(format!(
                "AI destination suggestion timed out after {} seconds",
                SUGGEST_TIMEOUT.as_secs()
            )))
        }
    };

    let suggestions = clean_destinations(&raw, &candidates, count);
    if suggestions.is_empty() {
        return Err(AppError::Other(
            "The model returned no usable destination suggestions".to_string(),
        ));
    }
    Ok(suggestions)
}

/// Tight, deterministic prompt: the model must answer with lines drawn
/// verbatim from the numbered candidate list.
fn build_prompt(
    file_name: &str,
    content_hint: Option<&str>,
    candidates: &[String],
    count: usize,
) -> String {
    let hint = match content_hint {
        Some(h) if !h.trim().is_empty() => format!("\nIts content begins:\n{}\n", h.trim()),
        _ => String::new(),
    };
    let list = candidates
        .iter()
        .map(|c| format!("- {c}"))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "A file named '{file_name}' needs a home.{hint}\nChoose the {count} best-fitting \
         destination folders for it FROM THIS LIST ONLY, best first:\n{list}\n\nReturn ONLY \
         the chosen folder paths, exactly as written above, one per line, with no numbering, \
         quotes, or commentary."
    )
}

/// Invoke the gemini CLI in non-interactive mode with the prompt.
async fn run_gemini(prompt: &str, api_key: &str) -> Result<String, AppError> {
    log::info!("AI organize: gemini -p (prompt {} chars)", prompt.len());

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

/// Parse raw model output into an ordered, deduped list of destinations that
/// are guaranteed to come from `candidates` (case-sensitive path match after
/// stripping list markers/quotes/fences). Caps to `count`.
pub fn clean_destinations(raw: &str, candidates: &[String], count: usize) -> Vec<String> {
    let candidate_set: HashSet<&str> = candidates.iter().map(|s| s.as_str()).collect();
    let mut seen: HashSet<String> = HashSet::new();
    let mut out: Vec<String> = Vec::new();

    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("```") {
            continue;
        }
        let unmarked = strip_list_marker(trimmed);
        let cleaned = unmarked
            .trim_matches(|c| c == '`' || c == '"' || c == '\'')
            .trim();
        if cleaned.is_empty() || !candidate_set.contains(cleaned) {
            continue; // not one of ours — the model may not invent paths
        }
        if seen.insert(cleaned.to_string()) {
            out.push(cleaned.to_string());
            if out.len() == count {
                break;
            }
        }
    }
    out
}

/// Strip a leading list marker ("1. ", "2) ", "- ", "* ", "• ") from a line.
/// (Duplicated from ai_rename to keep both modules self-contained.)
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

#[cfg(test)]
mod tests {
    use super::*;

    fn cands(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn keeps_only_known_candidates_in_order() {
        let candidates = cands(&["/home/u/Documents", "/home/u/Pictures", "/home/u/Archive"]);
        let raw = "/home/u/Pictures\n/home/u/Made-Up\n/home/u/Documents\n";
        assert_eq!(
            clean_destinations(raw, &candidates, 3),
            vec!["/home/u/Pictures", "/home/u/Documents"]
        );
    }

    #[test]
    fn strips_markers_fences_and_quotes() {
        let candidates = cands(&["/a/b", "/c/d"]);
        let raw = "```\n1. \"/a/b\"\n- `/c/d`\n```";
        assert_eq!(
            clean_destinations(raw, &candidates, 5),
            vec!["/a/b", "/c/d"]
        );
    }

    #[test]
    fn dedups_and_caps() {
        let candidates = cands(&["/a", "/b", "/c"]);
        let raw = "/a\n/a\n/b\n/c";
        assert_eq!(clean_destinations(raw, &candidates, 2), vec!["/a", "/b"]);
    }

    #[test]
    fn empty_or_hostile_output_yields_nothing() {
        let candidates = cands(&["/a"]);
        assert!(clean_destinations("", &candidates, 3).is_empty());
        assert!(clean_destinations("/etc/passwd\n../../x", &candidates, 3).is_empty());
    }

    #[test]
    fn prompt_lists_candidates_and_constrains() {
        let p = build_prompt("notes.md", Some("hello"), &cands(&["/x", "/y"]), 2);
        assert!(p.contains("- /x"));
        assert!(p.contains("- /y"));
        assert!(p.contains("FROM THIS LIST ONLY"));
        assert!(p.contains("hello"));
    }
}
