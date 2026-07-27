use serde::{Deserialize, Serialize};
use tauri::AppHandle;

const DEFAULT_REPORT_URL: &str = "https://tauri-explorer.vercel.app/api/report";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RelayRequest {
    title: String,
    body: String,
    kind: String,
    contact: String,
    version: String,
    os: String,
    arch: String,
    website: String,
}

#[derive(Debug, Deserialize)]
struct RelayErrorBody {
    error: RelayError,
}

#[derive(Debug, Deserialize)]
struct RelayError {
    code: String,
    message: String,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct SubmittedUserReport {
    pub url: String,
    pub number: u64,
}

#[derive(Debug)]
pub struct SubmitReportError {
    kind: &'static str,
    message: String,
}

impl SubmitReportError {
    fn new(kind: &'static str, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

impl Serialize for SubmitReportError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeMap;
        let mut map = serializer.serialize_map(Some(2))?;
        map.serialize_entry("kind", self.kind)?;
        map.serialize_entry("message", &self.message)?;
        map.end()
    }
}

pub struct Environment<'a> {
    pub version: &'a str,
    pub os: &'a str,
    pub arch: &'a str,
}

pub fn assemble_issue_body(
    description: &str,
    contact: Option<&str>,
    environment: &Environment<'_>,
    log_tail: Option<&str>,
) -> String {
    let mut sections = vec![description.trim().to_string()];
    if let Some(contact) = contact.map(str::trim).filter(|value| !value.is_empty()) {
        sections.push(format!("How to reach the reporter: {contact}"));
    }
    sections.push(format!(
        "---\n- Tauri Explorer: v{}\n- OS: {} ({})",
        environment.version, environment.os, environment.arch
    ));
    if let Some(logs) = log_tail.map(str::trim).filter(|value| !value.is_empty()) {
        sections.push(format!("## Recent logs\n\n```text\n{logs}\n```"));
    }
    sections.join("\n\n")
}

fn validate_draft(
    title: &str,
    body: &str,
    kind: &str,
    contact: Option<&str>,
) -> Result<(), SubmitReportError> {
    let invalid_control = |value: &str| {
        value
            .chars()
            .any(|character| character.is_control() && character != '\n' && character != '\r')
    };
    if title.trim().is_empty() || title.trim().chars().count() > 120 || invalid_control(title) {
        return Err(SubmitReportError::new(
            "malformed_input",
            "Title must be 1–120 characters",
        ));
    }
    if body.trim().is_empty() || body.chars().count() > 8000 || invalid_control(body) {
        return Err(SubmitReportError::new(
            "malformed_input",
            "Description must be 1–8000 characters",
        ));
    }
    if kind != "bug" && kind != "feature" {
        return Err(SubmitReportError::new(
            "malformed_input",
            "Unknown report kind",
        ));
    }
    if contact.unwrap_or_default().chars().count() > 100 {
        return Err(SubmitReportError::new(
            "malformed_input",
            "Contact must be at most 100 characters",
        ));
    }
    Ok(())
}

fn map_relay_error(error: ureq::Error) -> SubmitReportError {
    match error {
        ureq::Error::StatusCode(429) => {
            SubmitReportError::new("rate_limited", "Too many reports; please try later")
        }
        ureq::Error::StatusCode(_) => {
            SubmitReportError::new("server_rejected", "The report service rejected the report")
        }
        _ => SubmitReportError::new(
            "network_unreachable",
            "The report service could not be reached",
        ),
    }
}

fn send_report(
    endpoint: &str,
    payload: RelayRequest,
) -> Result<SubmittedUserReport, SubmitReportError> {
    let mut response = ureq::post(endpoint)
        .header("User-Agent", "tauri-explorer")
        .config()
        .http_status_as_error(false)
        .build()
        .send_json(payload)
        .map_err(map_relay_error)?;
    if !response.status().is_success() {
        let fallback_kind = if response.status().as_u16() == 429 {
            "rate_limited"
        } else {
            "server_rejected"
        };
        let error = response
            .body_mut()
            .read_json::<RelayErrorBody>()
            .ok()
            .map(|body| body.error);
        let kind = match error.as_ref().map(|value| value.code.as_str()) {
            Some("daily_cap") => "daily_cap",
            Some("rate_limited") => "rate_limited",
            Some("malformed_input") => "malformed_input",
            _ => fallback_kind,
        };
        return Err(SubmitReportError::new(
            kind,
            error
                .map(|value| value.message)
                .unwrap_or_else(|| "The report service rejected the report".to_string()),
        ));
    }
    response
        .body_mut()
        .read_json::<SubmittedUserReport>()
        .map_err(|_| {
            SubmitReportError::new(
                "server_rejected",
                "The report service returned an invalid response",
            )
        })
}

#[tauri::command]
pub async fn submit_user_report(
    app: AppHandle,
    title: String,
    body: String,
    kind: String,
    contact: Option<String>,
) -> Result<SubmittedUserReport, SubmitReportError> {
    validate_draft(&title, &body, &kind, contact.as_deref())?;
    let info = crate::system::get_app_info().await;
    let log_tail = crate::system::read_log_tail(app, 50)
        .await
        .unwrap_or_default();
    let assembled = assemble_issue_body(
        &body,
        contact.as_deref(),
        &Environment {
            version: &info.version,
            os: &info.os,
            arch: &info.arch,
        },
        (!log_tail.is_empty()).then_some(log_tail.as_str()),
    );
    let endpoint = std::env::var("TAURI_EXPLORER_REPORT_URL")
        .unwrap_or_else(|_| DEFAULT_REPORT_URL.to_string());
    let payload = RelayRequest {
        title: title.trim().replace(['\n', '\r'], " "),
        body: assembled,
        kind,
        contact: contact.unwrap_or_default(),
        version: info.version,
        os: info.os,
        arch: info.arch,
        website: String::new(),
    };
    tauri::async_runtime::spawn_blocking(move || send_report(&endpoint, payload))
        .await
        .map_err(|error| SubmitReportError::new("server_rejected", error.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::{assemble_issue_body, send_report, validate_draft, Environment, RelayRequest};
    use std::io::{Read, Write};
    use std::net::TcpListener;

    #[test]
    fn user_report_body_contains_description_contact_environment_and_log_tail() {
        let body = assemble_issue_body(
            "It freezes on café/🐛 paths.",
            Some("@reporter"),
            &Environment {
                version: "1.7.0",
                os: "linux",
                arch: "x86_64",
            },
            Some("line one\nline two"),
        );
        assert!(body.contains("It freezes on café/🐛 paths."));
        assert!(body.contains("How to reach the reporter: @reporter"));
        assert!(body.contains("Tauri Explorer: v1.7.0"));
        assert!(body.contains("OS: linux (x86_64)"));
        assert!(body.contains("line one\nline two"));
    }

    #[test]
    fn user_report_body_omits_absent_optional_sections() {
        let body = assemble_issue_body(
            "Description only",
            None,
            &Environment {
                version: "1.7.0",
                os: "macos",
                arch: "aarch64",
            },
            None,
        );
        assert!(!body.contains("How to reach"));
        assert!(!body.contains("Recent logs"));
        assert!(body.contains("Description only"));
    }

    fn payload() -> RelayRequest {
        RelayRequest {
            title: "Title".to_string(),
            body: "Description".to_string(),
            kind: "bug".to_string(),
            contact: String::new(),
            version: "1.7.0".to_string(),
            os: "linux".to_string(),
            arch: "x86_64".to_string(),
            website: String::new(),
        }
    }

    fn stub_response(status: &str, response_body: &str) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let response_body = response_body.to_string();
        let status = status.to_string();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 4096];
            let _ = stream.read(&mut request);
            write!(
                stream,
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response_body}",
                response_body.len()
            )
            .unwrap();
        });
        endpoint
    }

    #[test]
    fn relay_daily_cap_stays_distinct_for_the_ui() {
        let endpoint = stub_response(
            "429 Too Many Requests",
            r#"{"error":{"code":"daily_cap","message":"Reports are temporarily unavailable"}}"#,
        );
        let error = send_report(&endpoint, payload()).unwrap_err();
        assert_eq!(error.kind, "daily_cap");
        assert!(error.message.contains("temporarily unavailable"));
    }

    #[test]
    fn unreachable_relay_has_a_network_error_kind() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        drop(listener);
        assert_eq!(
            send_report(&endpoint, payload()).unwrap_err().kind,
            "network_unreachable"
        );
    }

    #[test]
    fn malformed_drafts_are_rejected_before_io() {
        assert_eq!(
            validate_draft(" ", "Description", "bug", None)
                .unwrap_err()
                .kind,
            "malformed_input"
        );
        assert_eq!(
            validate_draft("Title", " ", "feature", None)
                .unwrap_err()
                .kind,
            "malformed_input"
        );
        assert_eq!(
            validate_draft("Title", &"x".repeat(8001), "bug", None)
                .unwrap_err()
                .kind,
            "malformed_input"
        );
    }
}
