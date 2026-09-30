use base64::Engine as _;
use serde::{Deserialize, Serialize};
const DEFAULT_REPORT_URL: &str = "https://tauri-explorer.vercel.app/api/report";
const MAX_ATTACHMENTS: usize = 3;
const MAX_ATTACHMENT_BYTES: usize = 2 * 1024 * 1024;
const MAX_ATTACHMENTS_BYTES: usize = 3 * 1024 * 1024;
const MAX_TITLE_UNITS: usize = 120;
const MAX_ATTACHMENT_NAME_UNITS: usize = 120;
const MAX_CONTACT_UNITS: usize = 100;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportAttachment {
    pub name: String,
    pub media_type: String,
    pub data: String,
}

/// Contact and environment details travel inside `body`
/// (`assemble_issue_body`); the relay publishes nothing else.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RelayRequest {
    title: String,
    body: String,
    kind: String,
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

#[cfg(any(test, all(not(windows), not(target_os = "macos"))))]
pub(crate) fn report_image_media_type(bytes: &[u8]) -> Option<&'static str> {
    ["image/png", "image/jpeg", "image/gif"]
        .into_iter()
        .find(|media_type| valid_image_magic(media_type, bytes))
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
            || name.encode_utf16().count() > MAX_ATTACHMENT_NAME_UNITS
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

const MAX_REPORT_DESCRIPTION_UNITS: usize = 8000;

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

/// Assemble the GitHub issue body from the reporter's draft.
///
/// Deliberately carries no log tail (#595): the last 50 log lines are almost
/// always unrelated background chatter (git-status probes, thumbnail decodes)
/// captured at submit time rather than at failure time, so they buried the
/// reporter's own words under noise without ever aiding triage. Logs are still
/// available on demand through Command Palette → "Open Logs Folder".
pub fn assemble_issue_body(
    description: &str,
    contact: Option<&str>,
    environment: &Environment<'_>,
) -> String {
    let description = sanitize(description);
    let contact = contact
        .map(sanitize)
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| format!("How to reach the reporter: {value}"));
    let environment = format!(
        "---\n- Tauri Explorer: v{}\n- OS: {} ({})",
        truncate_utf16(&sanitize(environment.version), 100),
        truncate_utf16(&sanitize(environment.os), 100),
        truncate_utf16(&sanitize(environment.arch), 100)
    );
    let suffix = contact
        .iter()
        .chain(std::iter::once(&environment))
        .map(String::as_str)
        .collect::<Vec<_>>()
        .join("\n\n");
    let description = description.trim();
    if description.is_empty() {
        suffix
    } else {
        format!("{description}\n\n{suffix}")
    }
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
        || title.trim().encode_utf16().count() > MAX_TITLE_UNITS
        || invalid_control(title)
    {
        return Err(SubmitReportError::new(
            "malformed_input",
            "Title must be 1–120 characters",
        ));
    }
    if body.encode_utf16().count() > MAX_REPORT_DESCRIPTION_UNITS || invalid_control(body) {
        return Err(SubmitReportError::new(
            "malformed_input",
            "Description must be at most 8000 characters",
        ));
    }
    if kind != "bug" && kind != "feature" {
        return Err(SubmitReportError::new(
            "malformed_input",
            "Unknown report kind",
        ));
    }
    if contact.unwrap_or_default().encode_utf16().count() > MAX_CONTACT_UNITS {
        return Err(SubmitReportError::new(
            "malformed_input",
            "Contact must be at most 100 characters",
        ));
    }
    Ok(())
}

/// True only when the failure provably happened before any request byte
/// reached the relay. This holds because `send_report` follows no redirects
/// (a redirect hop would reconnect after the POST was delivered) and sets no
/// timeouts (ureq can attribute a send-phase timeout to the connect phase).
/// Everything else — resets, response timeouts, unreachable-host errors that
/// an established socket can also report — may follow a delivered report.
fn failed_before_sending(error: &ureq::Error) -> bool {
    use ureq::Error;
    match error {
        Error::HostNotFound
        | Error::ConnectionFailed
        | Error::BadUri(_)
        | Error::RequireHttpsOnly(_)
        | Error::TlsRequired
        | Error::InvalidProxyUrl
        | Error::ConnectProxyFailed(_) => true,
        // TCP reports a refusal only while connecting; ureq also uses it when
        // every resolved address refused.
        Error::Io(error) => error.kind() == std::io::ErrorKind::ConnectionRefused,
        _ => false,
    }
}

fn relay_unreachable() -> SubmitReportError {
    SubmitReportError::new(
        "network_unreachable",
        "Couldn't reach the report server — nothing was sent",
    )
}

/// Resolve the relay host before sending. ureq reports a lookup failure as an
/// unattributed I/O error, indistinguishable from a later socket error, so the
/// usual offline case (no DNS) is only provably pre-send when checked here.
/// Skipped when a proxy resolves the host instead.
fn resolve_relay_host(endpoint: &str) -> Result<(), SubmitReportError> {
    use std::net::ToSocketAddrs;
    // A malformed endpoint is left for ureq to report.
    let Ok(uri) = endpoint.parse::<ureq::http::Uri>() else {
        return Ok(());
    };
    let Some(host) = uri.host() else {
        return Ok(());
    };
    if ureq::Proxy::try_from_env().is_some_and(|proxy| !proxy.is_no_proxy(&uri)) {
        return Ok(());
    }
    let port = uri
        .port_u16()
        .unwrap_or(if uri.scheme_str() == Some("http") {
            80
        } else {
            443
        });
    let host = host.trim_start_matches('[').trim_end_matches(']');
    match (host, port).to_socket_addrs() {
        Ok(mut addresses) => match addresses.next() {
            Some(_) => Ok(()),
            None => Err(relay_unreachable()),
        },
        Err(error) => {
            log::warn!("User report relay host did not resolve: {error}");
            Err(relay_unreachable())
        }
    }
}

fn map_transport_error(error: ureq::Error) -> SubmitReportError {
    if failed_before_sending(&error) {
        log::warn!("User report relay unreachable: {error}");
        return relay_unreachable();
    }
    log::warn!("User report relay response lost: {error}");
    SubmitReportError::new(
        "submission_uncertain",
        "The report service response was lost; check recent issues before retrying",
    )
}

/// The app error kind for a relay's typed error code; unknown codes fall back
/// to the HTTP status classification.
fn relay_error_kind(code: &str) -> Option<&'static str> {
    Some(match code {
        "daily_cap" => "daily_cap",
        "rate_limited" => "rate_limited",
        "malformed_input" => "malformed_input",
        "submission_uncertain" => "submission_uncertain",
        "server_rejected" => "server_rejected",
        _ => return None,
    })
}

fn send_report(
    endpoint: &str,
    payload: RelayRequest,
) -> Result<SubmittedUserReport, SubmitReportError> {
    resolve_relay_host(endpoint)?;
    let mut response = ureq::post(endpoint)
        .header("User-Agent", "tauri-explorer")
        .config()
        .http_status_as_error(false)
        // Following a redirect would reconnect after the report was delivered,
        // so a failure on that hop could be misreported as never sent.
        .max_redirects(0)
        .build()
        .send_json(payload)
        .map_err(map_transport_error)?;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let fallback_kind = match status {
            429 => "rate_limited",
            408 | 500..=599 => "submission_uncertain",
            _ => "server_rejected",
        };
        let error = response
            .body_mut()
            .read_json::<RelayErrorBody>()
            .ok()
            .map(|body| body.error);
        let kind = error
            .as_ref()
            .and_then(|value| relay_error_kind(&value.code))
            .unwrap_or(fallback_kind);
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
                "submission_uncertain",
                "The report service returned an invalid response; check recent issues before retrying",
            )
        })
}

#[tauri::command]
pub async fn submit_user_report(
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
    let assembled = assemble_issue_body(
        &body,
        contact.as_deref(),
        &Environment {
            version: &info.version,
            os: &info.os,
            arch: &info.arch,
        },
    );
    let endpoint = std::env::var("TAURI_EXPLORER_REPORT_URL")
        .unwrap_or_else(|_| DEFAULT_REPORT_URL.to_string());
    let payload = RelayRequest {
        title: title.trim().replace(['\n', '\r'], " "),
        body: assembled,
        kind,
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
        assemble_issue_body, attachment_from_image_bytes, map_transport_error, relay_error_kind,
        report_image_media_type, send_report, validate_attachments, validate_draft, Environment,
        RelayRequest, ReportAttachment, MAX_ATTACHMENTS, MAX_ATTACHMENTS_BYTES,
        MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_NAME_UNITS, MAX_CONTACT_UNITS,
        MAX_REPORT_DESCRIPTION_UNITS, MAX_TITLE_UNITS,
    };
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::{Shutdown, TcpListener};

    /// The limits and error codes the relay (`website/api/_report-core.js`)
    /// enforces; its vitest suite asserts the same fixture.
    fn contract() -> serde_json::Value {
        serde_json::from_str(include_str!(
            "../../tests/contract/fixtures/report_relay.json"
        ))
        .expect("report relay contract fixture")
    }

    fn contract_limit(name: &str) -> usize {
        contract()["limits"][name]
            .as_u64()
            .unwrap_or_else(|| panic!("contract limit {name}")) as usize
    }

    #[test]
    fn native_limits_match_the_relay_contract() {
        assert_eq!(MAX_ATTACHMENTS, contract_limit("maxAttachments"));
        assert_eq!(MAX_ATTACHMENT_BYTES, contract_limit("maxAttachmentBytes"));
        assert_eq!(MAX_ATTACHMENTS_BYTES, contract_limit("maxAttachmentsBytes"));
        assert_eq!(MAX_TITLE_UNITS, contract_limit("maxTitleUnits"));
        assert_eq!(
            MAX_ATTACHMENT_NAME_UNITS,
            contract_limit("maxAttachmentNameUnits")
        );
        let app_limit = |name: &str| contract()["appLimits"][name].as_u64().unwrap() as usize;
        assert_eq!(
            MAX_REPORT_DESCRIPTION_UNITS,
            app_limit("maxDescriptionUnits")
        );
        assert_eq!(MAX_CONTACT_UNITS, app_limit("maxContactUnits"));
    }

    #[test]
    fn every_relay_error_code_reaches_the_ui_unchanged() {
        let codes = contract()["relayErrorCodes"].as_array().unwrap().clone();
        assert!(!codes.is_empty());
        for code in codes {
            let code = code.as_str().unwrap();
            assert_eq!(relay_error_kind(code), Some(code));
        }
        assert_eq!(relay_error_kind("method_not_allowed"), None);
    }

    #[test]
    fn relay_request_carries_only_contract_fields() {
        let json = serde_json::to_value(payload()).unwrap();
        let mut sent: Vec<&str> = json
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        let contract = contract();
        let mut expected: Vec<&str> = contract["requestFields"]
            .as_array()
            .unwrap()
            .iter()
            .map(|field| field.as_str().unwrap())
            .collect();
        sent.sort_unstable();
        expected.sort_unstable();
        assert_eq!(sent, expected);
    }

    #[test]
    fn user_report_body_contains_description_contact_and_environment() {
        let body = assemble_issue_body(
            "It freezes on café/🐛 paths.",
            Some("@reporter"),
            &Environment {
                version: "1.7.0",
                os: "linux",
                arch: "x86_64",
            },
        );
        assert!(body.contains("It freezes on café/🐛 paths."));
        assert!(body.contains("How to reach the reporter: @reporter"));
        assert!(body.contains("Tauri Explorer: v1.7.0"));
        assert!(body.contains("OS: linux (x86_64)"));
    }

    /// #595: the log tail was pure noise in every report it appeared in.
    /// The body must end at the environment block — no log section, no fence,
    /// and none of the log text that used to be spliced in.
    #[test]
    fn user_report_body_never_carries_a_log_tail() {
        let body = assemble_issue_body(
            "Short description",
            Some("@reporter"),
            &Environment {
                version: "1.7.0",
                os: "linux",
                arch: "x86_64",
            },
        );
        // The real guard is structural: `assemble_issue_body` has no log-tail
        // parameter, so a log section cannot be reintroduced without changing
        // the signature. This pins the whole rendered shape so any new
        // machine-collected section shows up as a diff here.
        assert_eq!(
            body,
            "Short description\n\n\
             How to reach the reporter: @reporter\n\n\
             ---\n\
             - Tauri Explorer: v1.7.0\n\
             - OS: linux (x86_64)"
        );
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
        );
        assert!(!body.contains("How to reach"));
        assert!(!body.contains("Recent logs"));
        assert!(body.contains("Description only"));
    }

    #[test]
    fn blank_description_still_adds_environment_without_leading_whitespace() {
        let body = assemble_issue_body(
            "   ",
            None,
            &Environment {
                version: "1.7.0",
                os: "linux",
                arch: "x86_64",
            },
        );

        assert!(body.starts_with("---\n- Tauri Explorer: v1.7.0"));
        validate_draft("Title-only report", "", "bug", None).unwrap();
    }

    #[test]
    fn assembled_body_obeys_relay_units_and_sanitizes_controls() {
        let description = "🐛".repeat(4000);
        let body = assemble_issue_body(
            &description,
            Some("@reporter"),
            &Environment {
                version: "1.7.0",
                os: "linux",
                arch: "x86_64",
            },
        );
        assert!(body.encode_utf16().count() <= contract_limit("maxRelayBodyUnits"));
        assert!(body.starts_with(&description));
        assert!(body.contains("How to reach the reporter: @reporter"));
        assert!(body.ends_with("- Tauri Explorer: v1.7.0\n- OS: linux (x86_64)"));

        let full = assemble_issue_body(
            &"x".repeat(MAX_REPORT_DESCRIPTION_UNITS),
            Some(&"c".repeat(MAX_CONTACT_UNITS)),
            &Environment {
                version: &"v".repeat(100),
                os: &"o".repeat(100),
                arch: &"a".repeat(100),
            },
        );
        assert!(full.starts_with(&"x".repeat(MAX_REPORT_DESCRIPTION_UNITS)));
        assert!(full.encode_utf16().count() <= contract_limit("maxRelayBodyUnits"));

        let sanitized = assemble_issue_body(
            "safe\u{0}text\u{7}\nsecond line",
            None,
            &Environment {
                version: "1.7.0",
                os: "linux",
                arch: "x86_64",
            },
        );
        assert!(sanitized.contains("safetext\nsecond line"));
        assert!(!sanitized.contains('\u{0}'));
        assert!(!sanitized.contains('\u{7}'));
    }

    fn payload() -> RelayRequest {
        RelayRequest {
            title: "Title".to_string(),
            body: "Description".to_string(),
            kind: "bug".to_string(),
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
    fn image_attachment_is_base64_encoded_at_the_native_boundary() {
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

    #[test]
    fn clipboard_report_media_type_recognizes_png_and_jpeg_bytes() {
        assert_eq!(
            report_image_media_type(b"\x89PNG\r\n\x1a\npayload"),
            Some("image/png")
        );
        assert_eq!(
            report_image_media_type(b"\xff\xd8\xffpayload"),
            Some("image/jpeg")
        );
        assert_eq!(report_image_media_type(b"not an image"), None);
    }

    /// Consume one complete HTTP request (headers and sized body).
    fn read_request(stream: &mut std::net::TcpStream) {
        let mut reader = BufReader::new(stream);
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
    }

    fn stub_response(status: &str, response_body: &str) -> String {
        stub_response_with_headers(status, "", response_body)
    }

    fn stub_response_with_headers(status: &str, headers: &str, response_body: &str) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let response_body = response_body.to_string();
        let status = status.to_string();
        let headers = headers.to_string();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            read_request(&mut stream);

            let response = format!(
                "HTTP/1.1 {status}\r\n{headers}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response_body}",
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
    fn refused_connection_is_a_definite_failure() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        drop(listener);
        assert_eq!(
            send_report(&endpoint, payload()).unwrap_err().kind,
            "network_unreachable"
        );
    }

    #[test]
    fn unresolvable_relay_host_is_a_definite_failure_before_sending() {
        // `.invalid` never resolves (RFC 6761).
        let error =
            send_report("https://relay.tauri-explorer.invalid/api/report", payload()).unwrap_err();
        assert_eq!(error.kind, "network_unreachable");
    }

    #[test]
    fn a_redirect_is_not_followed_after_the_report_was_delivered() {
        let closed = TcpListener::bind("127.0.0.1:0").unwrap();
        let refused = format!("http://{}/", closed.local_addr().unwrap());
        drop(closed);
        let endpoint = stub_response_with_headers(
            "303 See Other",
            &format!("Location: {refused}\r\n"),
            r#"{"error":{"code":"server_rejected","message":"moved"}}"#,
        );
        // Following it to a refused port would report "nothing was sent" for
        // a report the first hop already received.
        let error = send_report(&endpoint, payload()).unwrap_err();
        assert_eq!(error.kind, "server_rejected");
    }

    #[test]
    fn lost_relay_response_is_uncertain_to_avoid_duplicate_submission() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            // Receive the whole request, then vanish without a response: the
            // relay may already have created the issue.
            let (mut stream, _) = listener.accept().unwrap();
            read_request(&mut stream);
            stream.shutdown(Shutdown::Both).unwrap();
        });
        assert_eq!(
            send_report(&endpoint, payload()).unwrap_err().kind,
            "submission_uncertain"
        );
    }

    #[test]
    fn only_failures_before_sending_are_definite() {
        use std::io::{Error as IoError, ErrorKind};
        use ureq::{Error, Timeout};
        for definite in [
            Error::HostNotFound,
            Error::ConnectionFailed,
            Error::Io(IoError::from(ErrorKind::ConnectionRefused)),
        ] {
            assert_eq!(map_transport_error(definite).kind, "network_unreachable");
        }
        for uncertain in [
            // ureq can attribute a send-phase timeout to connect or resolve.
            Error::Timeout(Timeout::Resolve),
            Error::Timeout(Timeout::Connect),
            Error::Timeout(Timeout::SendBody),
            Error::Timeout(Timeout::RecvResponse),
            Error::Timeout(Timeout::Global),
            Error::Io(IoError::from(ErrorKind::ConnectionReset)),
            Error::Io(IoError::from(ErrorKind::HostUnreachable)),
            Error::Io(IoError::from(ErrorKind::UnexpectedEof)),
            // A lookup failure inside ureq is an unattributed I/O error.
            Error::Io(IoError::other("failed to lookup address information")),
        ] {
            assert_eq!(map_transport_error(uncertain).kind, "submission_uncertain");
        }
    }

    #[test]
    fn relay_uncertainty_is_preserved_for_the_ui() {
        let endpoint = stub_response(
            "503 Service Unavailable",
            r#"{"error":{"code":"submission_uncertain","message":"Check recent issues before retrying"}}"#,
        );
        let error = send_report(&endpoint, payload()).unwrap_err();
        assert_eq!(error.kind, "submission_uncertain");
    }

    #[test]
    fn untyped_gateway_error_is_uncertain_after_a_possible_issue_creation() {
        let endpoint = stub_response("502 Bad Gateway", "upstream response was lost");
        let error = send_report(&endpoint, payload()).unwrap_err();
        assert_eq!(error.kind, "submission_uncertain");
    }

    #[test]
    fn malformed_drafts_are_rejected_before_io() {
        assert_eq!(
            validate_draft(" ", "Description", "bug", None)
                .unwrap_err()
                .kind,
            "malformed_input"
        );
        validate_draft("Title", " ", "feature", None).unwrap();
        assert_eq!(
            validate_draft("Title", &"x".repeat(8001), "bug", None)
                .unwrap_err()
                .kind,
            "malformed_input"
        );
    }
}
