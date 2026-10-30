//! Optional direct GitHub submission for user reports (#1455).
//!
//! A reporter may save a GitHub personal access token in Settings. The token
//! lives only in the OS credential store (through the shared `SecretStore`
//! used for AI credentials, under its own `app:` owner) and never crosses back
//! to the renderer: the UI can only learn whether one is saved. When the
//! reporter submits with it, the issue is created through the GitHub REST API
//! as that user, in the same repository the anonymous relay targets.
//!
//! The token is never logged or included in an error message.
use crate::ai::credentials::SecretStore;
use crate::user_report::{SubmitReportError, SubmittedUserReport};
use serde::{Deserialize, Serialize};

/// The repository's issues endpoint; the relay (`website/api/report.js`)
/// creates issues in the same repository
/// (`tests/website/report-repository-parity.test.ts`).
pub(crate) const GITHUB_ISSUES_URL: &str =
    "https://api.github.com/repos/xnmp/tauri-explorer/issues";
/// Owner/record in the shared credential namespace. AI profile owners are
/// restricted identities (no `:`) and plugins use `plugin:`, so this cannot
/// collide with either.
const TOKEN_OWNER: &str = "app:github-report";
const TOKEN_ID: &str = "token";
/// Classic (`ghp_`, 40) and fine-grained (`github_pat_`, ~93) tokens are far
/// below this; it bounds what is written to the credential store.
const MAX_TOKEN_CHARS: usize = 255;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ReportTokenState {
    Configured,
    Absent,
    /// The credential store is missing or locked; whether a token exists is
    /// unknown, so reports go through the anonymous relay.
    Unavailable,
}

fn credential_unavailable() -> SubmitReportError {
    SubmitReportError::new(
        "credential_unavailable",
        "OS credential storage is unavailable or locked; unlock it and try again — nothing was sent",
    )
}

/// Trimmed token, or a validation error that never echoes the input.
pub(crate) fn normalize_token(raw: &str) -> Result<String, SubmitReportError> {
    let token = raw.trim();
    if token.is_empty()
        || token.chars().count() > MAX_TOKEN_CHARS
        || !token.chars().all(|character| character.is_ascii_graphic())
    {
        return Err(SubmitReportError::new(
            "malformed_input",
            "Paste a GitHub personal access token without spaces (at most 255 characters)",
        ));
    }
    Ok(token.to_string())
}

pub(crate) fn token_state(store: &dyn SecretStore) -> ReportTokenState {
    match store.get(TOKEN_OWNER, TOKEN_ID) {
        Ok(Some(_)) => ReportTokenState::Configured,
        Ok(None) => ReportTokenState::Absent,
        Err(_) => ReportTokenState::Unavailable,
    }
}

pub(crate) fn save_token(store: &dyn SecretStore, raw: &str) -> Result<(), SubmitReportError> {
    let token = normalize_token(raw)?;
    // The Linux Secret Service store creates a new item on every put rather
    // than replacing one, and a duplicated record reads as unavailable, so
    // the previous token is removed first.
    store
        .remove(TOKEN_OWNER, TOKEN_ID)
        .map_err(|_| credential_unavailable())?;
    store
        .put(TOKEN_OWNER, TOKEN_ID, &token)
        .map_err(|_| credential_unavailable())
}

pub(crate) fn clear_token(store: &dyn SecretStore) -> Result<(), SubmitReportError> {
    store
        .remove(TOKEN_OWNER, TOKEN_ID)
        .map_err(|_| credential_unavailable())
}

pub(crate) fn load_token(store: &dyn SecretStore) -> Result<String, SubmitReportError> {
    let token = store
        .get(TOKEN_OWNER, TOKEN_ID)
        .map_err(|_| credential_unavailable())?
        .ok_or_else(|| {
            SubmitReportError::new(
                "authentication_failed",
                "No GitHub token is saved; add one in Settings → Issue Reports — nothing was sent",
            )
        })?;
    // A stored value that no longer validates is treated like a rejected one.
    normalize_token(&token).map_err(|_| {
        SubmitReportError::new(
            "authentication_failed",
            "The saved GitHub token is invalid; replace it in Settings → Issue Reports — nothing was sent",
        )
    })
}

#[derive(Debug, Serialize)]
pub(crate) struct GitHubIssueRequest {
    pub title: String,
    pub body: String,
    /// GitHub silently drops labels when the author lacks push access, so
    /// these only apply for maintainers; the request still succeeds.
    pub labels: Vec<&'static str>,
}

impl GitHubIssueRequest {
    pub(crate) fn new(title: String, body: String, kind: &str) -> Self {
        Self {
            title,
            body,
            labels: vec![
                "user-report",
                if kind == "bug" { "bug" } else { "enhancement" },
            ],
        }
    }
}

#[derive(Deserialize)]
struct CreatedIssue {
    html_url: String,
    number: u64,
}

#[derive(Deserialize)]
struct GitHubErrorBody {
    message: Option<String>,
}

/// GitHub's own error message, bounded and stripped of controls. It describes
/// the request (scopes, validation) and never contains the token.
fn github_message(body: Option<GitHubErrorBody>) -> Option<String> {
    let message: String = body?
        .message?
        .chars()
        .filter(|character| !character.is_control())
        .take(200)
        .collect();
    let message = message.trim().to_string();
    (!message.is_empty()).then_some(message)
}

/// Classify a non-success GitHub response. Only statuses that prove the issue
/// was not created are definite; anything else may follow a created issue.
fn classify_failure(
    status: u16,
    rate_limit_exhausted: bool,
    detail: Option<String>,
) -> SubmitReportError {
    let reason = detail
        .map(|detail| format!(" (GitHub: {detail})"))
        .unwrap_or_default();
    match status {
        401 => SubmitReportError::new(
            "authentication_failed",
            format!("GitHub rejected the saved token{reason}; replace it in Settings → Issue Reports — nothing was created"),
        ),
        403 | 429 if rate_limit_exhausted || status == 429 => SubmitReportError::new(
            "rate_limited",
            format!("GitHub's rate limit was reached{reason}; try again later"),
        ),
        403 | 404 => SubmitReportError::new(
            "authentication_failed",
            format!("The saved GitHub token can't create issues in xnmp/tauri-explorer{reason}. It needs public repository access with Issues: write — nothing was created"),
        ),
        422 => SubmitReportError::new(
            "malformed_input",
            format!("GitHub rejected the report{reason}"),
        ),
        408 | 500..=599 => SubmitReportError::new(
            "submission_uncertain",
            "GitHub did not confirm the report; check recent issues before retrying",
        ),
        _ => SubmitReportError::new(
            "server_rejected",
            format!("GitHub rejected the report{reason}"),
        ),
    }
}

/// Create the issue as the token's user. Like the relay path this follows no
/// redirects and sets no timeouts, so a transport failure is classified as
/// definite only when nothing can have reached GitHub.
pub(crate) fn create_issue(
    endpoint: &str,
    token: &str,
    issue: &GitHubIssueRequest,
) -> Result<SubmittedUserReport, SubmitReportError> {
    crate::user_report::resolve_relay_host(endpoint)?;
    let mut response = ureq::post(endpoint)
        .header("User-Agent", "tauri-explorer")
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header("Authorization", &format!("Bearer {token}"))
        .config()
        .http_status_as_error(false)
        .max_redirects(0)
        .build()
        .send_json(issue)
        .map_err(crate::user_report::map_transport_error)?;
    let status = response.status().as_u16();
    if !response.status().is_success() {
        let rate_limit_exhausted = response
            .headers()
            .get("x-ratelimit-remaining")
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.trim() == "0");
        let detail = github_message(response.body_mut().read_json::<GitHubErrorBody>().ok());
        return Err(classify_failure(status, rate_limit_exhausted, detail));
    }
    response
        .body_mut()
        .read_json::<CreatedIssue>()
        .map(|created| SubmittedUserReport {
            url: created.html_url,
            number: created.number,
        })
        .map_err(|_| {
            SubmitReportError::new(
                "submission_uncertain",
                "GitHub returned an invalid response; check recent issues before retrying",
            )
        })
}

fn os_secrets() -> crate::ai::credentials::OsSecrets {
    crate::ai::credentials::OsSecrets
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, SubmitReportError> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| credential_unavailable())
}

/// Whether a token is saved. The token itself never leaves the native side.
#[tauri::command]
pub async fn user_report_token_state() -> Result<ReportTokenState, SubmitReportError> {
    blocking(|| token_state(&os_secrets())).await
}

#[tauri::command]
pub async fn save_user_report_token(token: String) -> Result<(), SubmitReportError> {
    blocking(move || save_token(&os_secrets(), &token)).await?
}

#[tauri::command]
pub async fn clear_user_report_token() -> Result<(), SubmitReportError> {
    blocking(|| clear_token(&os_secrets())).await?
}

/// Read the saved token and create the issue, both off the async runtime.
pub(crate) async fn submit_as_user(
    issue: GitHubIssueRequest,
) -> Result<SubmittedUserReport, SubmitReportError> {
    blocking(move || {
        let token = load_token(&os_secrets())?;
        create_issue(GITHUB_ISSUES_URL, &token, &issue)
    })
    .await?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::credentials::MemorySecrets;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::{Shutdown, TcpListener};
    use std::sync::mpsc;

    const TOKEN: &str = "github_pat_11ABCDEFG0123456789_abcdefXYZ";

    struct LockedStore;
    impl SecretStore for LockedStore {
        fn get(&self, _: &str, _: &str) -> crate::ai::domain::Result<Option<String>> {
            Err(crate::ai::domain::ServiceError::new(
                "not_configured",
                "locked",
            ))
        }
        fn put(&self, _: &str, _: &str, _: &str) -> crate::ai::domain::Result<()> {
            Err(crate::ai::domain::ServiceError::new(
                "not_configured",
                "locked",
            ))
        }
        fn remove(&self, _: &str, _: &str) -> crate::ai::domain::Result<()> {
            Err(crate::ai::domain::ServiceError::new(
                "not_configured",
                "locked",
            ))
        }
    }

    #[test]
    fn token_is_trimmed_and_validated_without_echoing_it() {
        assert_eq!(normalize_token(&format!("  {TOKEN}\n")).unwrap(), TOKEN);
        for bad in [
            "",
            "   ",
            "ghp_has space",
            "ghp_tab\there",
            "ghp_é",
            &"a".repeat(256),
        ] {
            let error = normalize_token(bad).unwrap_err();
            assert_eq!(error.kind, "malformed_input");
            if !bad.trim().is_empty() {
                assert!(!error.message.contains(bad.trim()));
            }
        }
    }

    #[test]
    fn saving_replaces_the_previous_token_and_clearing_removes_it() {
        let store = MemorySecrets::default();
        assert_eq!(token_state(&store), ReportTokenState::Absent);
        save_token(&store, "ghp_first").unwrap();
        save_token(&store, &format!(" {TOKEN} ")).unwrap();
        assert_eq!(store.count(), 1);
        assert_eq!(token_state(&store), ReportTokenState::Configured);
        assert_eq!(load_token(&store).unwrap(), TOKEN);
        clear_token(&store).unwrap();
        assert_eq!(token_state(&store), ReportTokenState::Absent);
        assert_eq!(
            load_token(&store).unwrap_err().kind,
            "authentication_failed"
        );
    }

    #[test]
    fn an_invalid_token_never_replaces_a_saved_one() {
        let store = MemorySecrets::default();
        save_token(&store, TOKEN).unwrap();
        assert!(save_token(&store, "not a token").is_err());
        assert_eq!(load_token(&store).unwrap(), TOKEN);
    }

    #[test]
    fn a_locked_store_is_unavailable_not_absent() {
        assert_eq!(token_state(&LockedStore), ReportTokenState::Unavailable);
        assert_eq!(
            load_token(&LockedStore).unwrap_err().kind,
            "credential_unavailable"
        );
        assert_eq!(
            save_token(&LockedStore, TOKEN).unwrap_err().kind,
            "credential_unavailable"
        );
        assert_eq!(
            clear_token(&LockedStore).unwrap_err().kind,
            "credential_unavailable"
        );
    }

    #[test]
    fn issue_request_carries_the_relay_labels() {
        let bug = GitHubIssueRequest::new("t".into(), "b".into(), "bug");
        assert_eq!(
            serde_json::to_value(&bug).unwrap(),
            serde_json::json!({"title":"t","body":"b","labels":["user-report","bug"]})
        );
        let feature = GitHubIssueRequest::new("t".into(), "b".into(), "feature");
        assert_eq!(feature.labels, vec!["user-report", "enhancement"]);
    }

    struct Captured {
        request_line: String,
        headers: Vec<(String, String)>,
        body: String,
    }

    impl Captured {
        fn header(&self, name: &str) -> Option<&str> {
            self.headers
                .iter()
                .find(|(key, _)| key.eq_ignore_ascii_case(name))
                .map(|(_, value)| value.as_str())
        }
    }

    /// A one-shot local GitHub stand-in: records the request and answers with
    /// `status`, extra `headers` and `body`. No real network is used.
    fn stub_github(status: &str, headers: &str, body: &str) -> (String, mpsc::Receiver<Captured>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!(
            "http://{}/repos/xnmp/tauri-explorer/issues",
            listener.local_addr().unwrap()
        );
        let (sender, receiver) = mpsc::channel();
        let response = format!(
            "HTTP/1.1 {status}\r\n{headers}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(&mut stream);
            let mut request_line = String::new();
            reader.read_line(&mut request_line).unwrap();
            let mut headers = Vec::new();
            let mut content_length = 0;
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" {
                    break;
                }
                if let Some((name, value)) = line.split_once(':') {
                    if name.eq_ignore_ascii_case("content-length") {
                        content_length = value.trim().parse().unwrap();
                    }
                    headers.push((name.trim().to_string(), value.trim().to_string()));
                }
            }
            let mut request_body = vec![0_u8; content_length];
            reader.read_exact(&mut request_body).unwrap();
            sender
                .send(Captured {
                    request_line: request_line.trim().to_string(),
                    headers,
                    body: String::from_utf8(request_body).unwrap(),
                })
                .unwrap();
            stream.write_all(response.as_bytes()).unwrap();
            stream.shutdown(Shutdown::Write).unwrap();
        });
        (endpoint, receiver)
    }

    fn issue() -> GitHubIssueRequest {
        GitHubIssueRequest::new(
            "Crash".into(),
            "Steps\n\n---\n- Tauri Explorer: v1".into(),
            "bug",
        )
    }

    #[test]
    fn creates_the_issue_as_the_token_user() {
        let (endpoint, captured) = stub_github(
            "201 Created",
            "",
            r#"{"html_url":"https://github.com/xnmp/tauri-explorer/issues/77","number":77,"user":{"login":"reporter"}}"#,
        );
        let created = create_issue(&endpoint, TOKEN, &issue()).unwrap();
        assert_eq!(created.number, 77);
        assert_eq!(
            created.url,
            "https://github.com/xnmp/tauri-explorer/issues/77"
        );
        let request = captured.recv().unwrap();
        assert_eq!(
            request.request_line,
            "POST /repos/xnmp/tauri-explorer/issues HTTP/1.1"
        );
        assert_eq!(
            request.header("authorization"),
            Some(format!("Bearer {TOKEN}").as_str())
        );
        assert_eq!(
            request.header("accept"),
            Some("application/vnd.github+json")
        );
        assert_eq!(request.header("x-github-api-version"), Some("2022-11-28"));
        let body: serde_json::Value = serde_json::from_str(&request.body).unwrap();
        assert_eq!(
            body,
            serde_json::json!({
                "title": "Crash",
                "body": "Steps\n\n---\n- Tauri Explorer: v1",
                "labels": ["user-report", "bug"],
            })
        );
    }

    #[test]
    fn rejected_token_is_definite_and_never_echoed() {
        let (endpoint, _captured) =
            stub_github("401 Unauthorized", "", r#"{"message":"Bad credentials"}"#);
        let error = create_issue(&endpoint, TOKEN, &issue()).unwrap_err();
        assert_eq!(error.kind, "authentication_failed");
        assert!(error.message.contains("Bad credentials"));
        assert!(!error.message.contains(TOKEN));
    }

    #[test]
    fn missing_permission_is_an_authentication_failure() {
        let (endpoint, _captured) = stub_github(
            "403 Forbidden",
            "x-ratelimit-remaining: 4999\r\n",
            r#"{"message":"Resource not accessible by personal access token"}"#,
        );
        let error = create_issue(&endpoint, TOKEN, &issue()).unwrap_err();
        assert_eq!(error.kind, "authentication_failed");
        assert!(error.message.contains("Issues: write"));
    }

    #[test]
    fn exhausted_rate_limit_is_rate_limited() {
        let (endpoint, _captured) = stub_github(
            "403 Forbidden",
            "x-ratelimit-remaining: 0\r\n",
            r#"{"message":"API rate limit exceeded"}"#,
        );
        assert_eq!(
            create_issue(&endpoint, TOKEN, &issue()).unwrap_err().kind,
            "rate_limited"
        );
    }

    #[test]
    fn server_errors_and_invalid_success_bodies_are_uncertain() {
        let (endpoint, _captured) = stub_github("502 Bad Gateway", "", "{}");
        assert_eq!(
            create_issue(&endpoint, TOKEN, &issue()).unwrap_err().kind,
            "submission_uncertain"
        );
        let (endpoint, _captured) = stub_github("201 Created", "", r#"{"ok":true}"#);
        assert_eq!(
            create_issue(&endpoint, TOKEN, &issue()).unwrap_err().kind,
            "submission_uncertain"
        );
    }

    #[test]
    fn validation_failures_surface_github_detail() {
        let (endpoint, _captured) = stub_github(
            "422 Unprocessable Entity",
            "",
            "{\"message\":\"Validation\\u0007 Failed\"}",
        );
        let error = create_issue(&endpoint, TOKEN, &issue()).unwrap_err();
        assert_eq!(error.kind, "malformed_input");
        assert!(error.message.contains("Validation Failed"));
    }

    #[test]
    fn refused_connection_is_a_definite_failure() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}/issues", listener.local_addr().unwrap());
        drop(listener);
        assert_eq!(
            create_issue(&endpoint, TOKEN, &issue()).unwrap_err().kind,
            "network_unreachable"
        );
    }
}
