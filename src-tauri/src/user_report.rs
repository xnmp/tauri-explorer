use base64::Engine as _;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

const DEFAULT_REPORT_URL: &str = "https://tauri-explorer.vercel.app/api/report";
const MAX_ATTACHMENTS: usize = 3;
const MAX_ATTACHMENT_BYTES: usize = 2 * 1024 * 1024;
const MAX_ATTACHMENTS_BYTES: usize = 3 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportAttachment {
    pub name: String,
    pub media_type: String,
    pub data: String,
}

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
    attachments: Vec<ReportAttachment>,
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
    pub(crate) fn new(kind: &'static str, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

fn valid_image_magic(media_type: &str, bytes: &[u8]) -> bool {
    match media_type {
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => bytes.starts_with(b"\xff\xd8\xff"),
        "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        _ => false,
    }
}

pub(crate) fn validate_attachments(
    attachments: &[ReportAttachment],
) -> Result<(), SubmitReportError> {
    if attachments.len() > MAX_ATTACHMENTS {
        return Err(SubmitReportError::new(
            "malformed_input",
            "Attach up to 3 images",
        ));
    }
    let mut total = 0;
    for attachment in attachments {
        let name = attachment.name.trim();
        if name.is_empty()
            || name.encode_utf16().count() > 120
            || name.chars().any(char::is_control)
            || !matches!(
                attachment.media_type.as_str(),
                "image/png" | "image/jpeg" | "image/gif"
            )
        {
            return Err(SubmitReportError::new(
                "malformed_input",
                "Attachment name or type is invalid",
            ));
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&attachment.data)
            .map_err(|_| SubmitReportError::new("malformed_input", "Attachment data is invalid"))?;
        if bytes.is_empty()
            || bytes.len() > MAX_ATTACHMENT_BYTES
            || !valid_image_magic(&attachment.media_type, &bytes)
        {
            return Err(SubmitReportError::new(
                "malformed_input",
                "Attachment data is invalid",
            ));
        }
        total += bytes.len();
        if total > MAX_ATTACHMENTS_BYTES {
            return Err(SubmitReportError::new(
                "malformed_input",
                "Attachments must total 3 MiB or less",
            ));
        }
    }
    Ok(())
}

pub(crate) fn attachment_from_image_bytes(
    name: String,
    media_type: &str,
    bytes: Vec<u8>,
) -> Result<ReportAttachment, SubmitReportError> {
    let attachment = ReportAttachment {
        name,
        media_type: media_type.to_string(),
        data: base64::engine::general_purpose::STANDARD.encode(bytes),
    };
    validate_attachments(std::slice::from_ref(&attachment))?;
    Ok(attachment)
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

const MAX_RELAY_BODY_UNITS: usize = 8000;

fn sanitize(value: &str) -> String {
    value
        .chars()
        .filter(|character| !character.is_control() || *character == '\n' || *character == '\r')
        .collect()
}

fn truncate_utf16(value: &str, max_units: usize) -> String {
    let mut units = 0;
    value
        .chars()
        .take_while(|character| {
            let next = units + character.len_utf16();
            if next > max_units {
                false
            } else {
                units = next;
                true
            }
        })
        .collect()
}

pub fn assemble_issue_body(
    description: &str,
    contact: Option<&str>,
    environment: &Environment<'_>,
    log_tail: Option<&str>,
) -> String {
    let description = sanitize(description);
    let mut body = truncate_utf16(description.trim(), MAX_RELAY_BODY_UNITS);
    let contact = contact
        .map(sanitize)
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| format!("\n\nHow to reach the reporter: {value}"));
    let environment = format!(
        "\n\n---\n- Tauri Explorer: v{}\n- OS: {} ({})",
        sanitize(environment.version),
        sanitize(environment.os),
        sanitize(environment.arch)
    );
    for section in contact.iter().chain(std::iter::once(&environment)) {
        if body.encode_utf16().count() + section.encode_utf16().count() <= MAX_RELAY_BODY_UNITS {
            body.push_str(section);
        }
    }

    if let Some(logs) = log_tail
        .map(sanitize)
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        const LOG_PREFIX: &str = "\n\n## Recent logs\n\n```text\n";
        const LOG_SUFFIX: &str = "\n```";
        let remaining = MAX_RELAY_BODY_UNITS.saturating_sub(body.encode_utf16().count());
        let framing = LOG_PREFIX.encode_utf16().count() + LOG_SUFFIX.encode_utf16().count();
        if remaining > framing {
            body.push_str(LOG_PREFIX);
            body.push_str(&truncate_utf16(logs, remaining - framing));
            body.push_str(LOG_SUFFIX);
        }
    }
    body
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
    if title.trim().is_empty()
        || title.trim().encode_utf16().count() > 120
        || invalid_control(title)
    {
        return Err(SubmitReportError::new(
            "malformed_input",
            "Title must be 1–120 characters",
        ));
    }
    if body.trim().is_empty()
        || body.encode_utf16().count() > MAX_RELAY_BODY_UNITS
        || invalid_control(body)
    {
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
    if contact.unwrap_or_default().encode_utf16().count() > 100 {
        return Err(SubmitReportError::new(
            "malformed_input",
            "Contact must be at most 100 characters",
        ));
    }
    Ok(())
}

fn map_transport_error(_error: ureq::Error) -> SubmitReportError {
    SubmitReportError::new(
        "network_unreachable",
        "The report service could not be reached",
    )
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
        .map_err(map_transport_error)?;
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
    attachments: Option<Vec<ReportAttachment>>,
) -> Result<SubmittedUserReport, SubmitReportError> {
    validate_draft(&title, &body, &kind, contact.as_deref())?;
    let attachments = attachments.unwrap_or_default();
    validate_attachments(&attachments)?;
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
        attachments,
    };
    tauri::async_runtime::spawn_blocking(move || send_report(&endpoint, payload))
        .await
        .map_err(|error| SubmitReportError::new("server_rejected", error.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::{
        assemble_issue_body, attachment_from_image_bytes, send_report, validate_attachments,
        validate_draft, Environment, RelayRequest, ReportAttachment, MAX_RELAY_BODY_UNITS,
    };
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::{Shutdown, TcpListener};

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

    #[test]
    fn assembled_body_obeys_relay_units_and_sanitizes_log_controls() {
        let description = "🐛".repeat(4000);
        let body = assemble_issue_body(
            &description,
            Some("@reporter"),
            &Environment {
                version: "1.7.0",
                os: "linux",
                arch: "x86_64",
            },
            Some("safe\u{0}log\u{7}\nlast line"),
        );
        assert!(body.encode_utf16().count() <= MAX_RELAY_BODY_UNITS);
        assert!(!body.contains('\u{0}'));
        assert!(!body.contains('\u{7}'));
        assert_eq!(body, description);

        let with_logs = assemble_issue_body(
            "Short description",
            None,
            &Environment {
                version: "1.7.0",
                os: "linux",
                arch: "x86_64",
            },
            Some("safe\u{0}log\u{7}\nlast line"),
        );
        assert!(with_logs.contains("safelog\nlast line"));
        assert!(!with_logs.contains('\u{0}'));
        assert!(!with_logs.contains('\u{7}'));
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
            attachments: Vec::new(),
        }
    }

    fn png_attachment() -> ReportAttachment {
        attachment_from_image_bytes(
            "Clipboard screenshot.png".to_string(),
            "image/png",
            vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3],
        )
        .unwrap()
    }

    #[test]
    fn image_attachment_is_base64_encoded_for_the_relay_without_writing_a_file() {
        let attachment = png_attachment();
        assert_eq!(attachment.name, "Clipboard screenshot.png");
        assert_eq!(attachment.media_type, "image/png");
        assert_eq!(attachment.data, "iVBORw0KGgoBAgM=");
        validate_attachments(std::slice::from_ref(&attachment)).unwrap();
    }

    #[test]
    fn native_boundary_rejects_unsupported_empty_excessive_and_oversized_images() {
        let unsupported = ReportAttachment {
            name: "vector.svg".to_string(),
            media_type: "image/svg+xml".to_string(),
            data: "PHN2Zz4=".to_string(),
        };
        assert_eq!(
            validate_attachments(&[unsupported]).unwrap_err().kind,
            "malformed_input"
        );
        assert_eq!(
            attachment_from_image_bytes("empty.png".to_string(), "image/png", Vec::new())
                .unwrap_err()
                .kind,
            "malformed_input"
        );
        assert_eq!(
            validate_attachments(&vec![png_attachment(); 4])
                .unwrap_err()
                .kind,
            "malformed_input"
        );
        assert_eq!(
            attachment_from_image_bytes(
                "huge.png".to_string(),
                "image/png",
                vec![0; 2 * 1024 * 1024 + 1],
            )
            .unwrap_err()
            .kind,
            "malformed_input"
        );
    }

    #[test]
    fn relay_payload_serializes_the_attachment_contract() {
        let mut request = payload();
        request.attachments.push(png_attachment());
        let json = serde_json::to_value(request).unwrap();
        assert_eq!(json["attachments"][0]["name"], "Clipboard screenshot.png");
        assert_eq!(json["attachments"][0]["mediaType"], "image/png");
        assert_eq!(json["attachments"][0]["data"], "iVBORw0KGgoBAgM=");
    }

    fn stub_response(status: &str, response_body: &str) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let response_body = response_body.to_string();
        let status = status.to_string();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(&mut stream);
            let mut content_length = 0;
            loop {
                let mut header = String::new();
                reader.read_line(&mut header).unwrap();
                if header == "\r\n" {
                    break;
                }
                if let Some((name, value)) = header.split_once(':') {
                    if name.eq_ignore_ascii_case("content-length") {
                        content_length = value.trim().parse().unwrap();
                    }
                }
            }
            let mut request_body = vec![0_u8; content_length];
            reader.read_exact(&mut request_body).unwrap();
            drop(reader);

            let response = format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response_body}",
                response_body.len()
            );
            stream.write_all(response.as_bytes()).unwrap();
            stream.shutdown(Shutdown::Write).unwrap();
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
