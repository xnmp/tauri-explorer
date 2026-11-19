//! Home-directory redaction for text that leaves the machine in a report
//! (#1685). Log lines carry paths in several shapes, so one home directory is
//! matched in every form it can take there:
//!
//! - as displayed, and canonicalized (a symlinked home such as `/var/home/x`);
//! - Debug-escaped (`{:?}` doubles every Windows backslash);
//! - with forward slashes (`C:/Users/x`);
//! - percent-encoded (asset-protocol URLs in forwarded frontend errors).
//!
//! A match counts only at a path boundary, so `/home/alex` never eats the
//! start of `/home/alexander`. Windows paths match case-insensitively.
//! Removable-media mount points embed the user name too
//! (`/run/media/<user>/`), so that segment is replaced unconditionally.

const MEDIA_PREFIXES: [&str; 2] = ["/run/media/", "/media/"];

#[derive(Debug, Default, Clone)]
pub(crate) struct Redactor {
    /// Longest first, so a canonical `/var/home/x` wins over its tail `/home/x`.
    forms: Vec<(String, bool)>,
}

fn percent_encode(text: &str, keep_slash: bool) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        let keep = byte.is_ascii_alphanumeric()
            || matches!(byte, b'-' | b'_' | b'.' | b'~')
            || (keep_slash && byte == b'/');
        if keep {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

impl Redactor {
    /// `homes` are the displayed forms of the home directory (the as-given and
    /// canonical paths). Entries of one character or less are ignored: `/`
    /// would redact every path separator.
    pub(crate) fn new(homes: &[String], windows: bool) -> Self {
        let mut forms: Vec<(String, bool)> = Vec::new();
        let mut add = |text: String, ignore_case: bool| {
            if text.len() > 1 && !forms.iter().any(|(existing, _)| *existing == text) {
                forms.push((text, ignore_case));
            }
        };
        for home in homes.iter().filter(|home| home.len() > 1) {
            add(home.clone(), windows);
            let forward = home.replace('\\', "/");
            add(forward.clone(), windows);
            add(home.replace('\\', "\\\\"), windows);
            for base in [home.as_str(), forward.as_str()] {
                // Hex digits vary in case, so encoded forms always ignore it.
                add(percent_encode(base, true), true);
                add(percent_encode(base, false), true);
            }
        }
        forms.sort_by_key(|(text, _)| std::cmp::Reverse(text.len()));
        Self { forms }
    }

    /// The current user's home, as displayed and canonicalized.
    pub(crate) fn for_current_user() -> Self {
        let mut homes = Vec::new();
        if let Some(home) = dirs::home_dir() {
            homes.push(crate::diagnostics_cli::display(&home));
            if let Ok(canonical) = std::fs::canonicalize(&home) {
                // Windows canonical paths carry a `\\?\` verbatim prefix.
                let shown = crate::diagnostics_cli::display(&canonical);
                homes.push(shown.strip_prefix(r"\\?\").unwrap_or(&shown).to_owned());
            }
        }
        Self::new(&homes, cfg!(windows))
    }

    pub(crate) fn redact(&self, line: &str) -> String {
        let mut out = line.to_owned();
        for (form, ignore_case) in &self.forms {
            out = replace_at_boundary(&out, form, *ignore_case);
        }
        MEDIA_PREFIXES
            .iter()
            .fold(out, |text, prefix| redact_segment_after(&text, prefix))
    }
}

fn ends_path_component(next: Option<char>) -> bool {
    next.is_none_or(|c| !(c.is_alphanumeric() || c == '_' || c == '-'))
}

fn replace_at_boundary(text: &str, pattern: &str, ignore_case: bool) -> String {
    // ASCII lowercasing keeps byte offsets, so matches index the original.
    let folded = ignore_case.then(|| text.to_ascii_lowercase());
    let haystack = folded.as_deref().unwrap_or(text);
    let needle = if ignore_case {
        pattern.to_ascii_lowercase()
    } else {
        pattern.to_owned()
    };
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0;
    while let Some(found) = haystack[cursor..].find(&needle) {
        let start = cursor + found;
        let end = start + needle.len();
        out.push_str(&text[cursor..start]);
        if ends_path_component(text[end..].chars().next()) {
            out.push('~');
        } else {
            out.push_str(&text[start..end]);
        }
        cursor = end;
    }
    out.push_str(&text[cursor..]);
    out
}

fn redact_segment_after(text: &str, prefix: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0;
    while let Some(found) = text[cursor..].find(prefix) {
        let segment_start = cursor + found + prefix.len();
        let segment_len = text[segment_start..]
            .find(|c: char| c == '/' || c == '\\' || c == '"' || c == '\'' || c.is_whitespace())
            .unwrap_or(text.len() - segment_start);
        out.push_str(&text[cursor..segment_start]);
        if segment_len > 0 {
            out.push('~');
        }
        cursor = segment_start + segment_len;
    }
    out.push_str(&text[cursor..]);
    out
}

#[cfg(test)]
#[path = "../test_support/report_redaction_test.rs"]
mod tests;
