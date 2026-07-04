//! Shared helpers for commands that shell out to the `gemini` CLI.

use crate::error::AppError;

/// Resolve the Gemini API key: the key configured in plugin settings wins,
/// otherwise fall back to the `GEMINI_API_KEY` environment variable so users
/// never have to persist the key to disk.
pub fn resolve_api_key(provided: &str) -> Result<String, AppError> {
    if !provided.is_empty() {
        return Ok(provided.to_string());
    }
    match std::env::var("GEMINI_API_KEY") {
        Ok(key) if !key.is_empty() => Ok(key),
        _ => Err(AppError::Other(
            "Gemini API key is not configured (set it in the plugin settings or export GEMINI_API_KEY)"
                .to_string(),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provided_key_wins() {
        let key = resolve_api_key("abc").unwrap();
        assert_eq!(key, "abc");
    }

    #[test]
    fn empty_key_without_env_errors() {
        // Serialize env mutation: this test only asserts the error branch
        // when the variable is absent.
        if std::env::var("GEMINI_API_KEY").is_err() {
            let err = resolve_api_key("").unwrap_err();
            assert!(err.to_string().contains("not configured"));
        }
    }
}
