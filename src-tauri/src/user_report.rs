use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::process::{Command, Stdio};

use crate::process_ext::NoConsole;

const DEFAULT_REPORT_URL: &str = "https://tauri-explorer.vercel.app/api/report";
const GITHUB_REPO: &str = "xnmp/tauri-explorer";
const GITHUB_ISSUE_URL_PREFIX: &str = "https://github.com/xnmp/tauri-explorer/issues/";
const GITHUB_ATTACHMENT_URL_PREFIX: &str = "https://github.com/user-attachments/";
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

fn append_issue_section(body: &mut String, section: &str) {
    let separator = if body.is_empty() { "" } else { "\n\n" };
    let added_units = separator.encode_utf16().count() + section.encode_utf16().count();
    if body.encode_utf16().count() + added_units <= MAX_RELAY_BODY_UNITS {
        body.push_str(separator);
        body.push_str(section);
    }
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
    let mut body = truncate_utf16(description.trim(), MAX_RELAY_BODY_UNITS);
    let contact = contact
        .map(sanitize)
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| format!("How to reach the reporter: {value}"));
    let environment = format!(
        "---\n- Tauri Explorer: v{}\n- OS: {} ({})",
        sanitize(environment.version),
        sanitize(environment.os),
        sanitize(environment.arch)
    );
    for section in contact.iter().chain(std::iter::once(&environment)) {
        append_issue_section(&mut body, section);
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
    if body.encode_utf16().count() > MAX_RELAY_BODY_UNITS || invalid_control(body) {
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

#[derive(Debug, PartialEq)]
enum GitHubCliError {
    Unavailable,
    AttachmentUpload(String),
    Rejected,
    InvalidResponse,
}

impl GitHubCliError {
    fn into_submit_error(self) -> SubmitReportError {
        match self {
            Self::Unavailable => SubmitReportError::new(
                "attachment_uploader_unavailable",
                "GitHub CLI or the gh-image extension is unavailable",
            ),
            Self::AttachmentUpload(message) => {
                SubmitReportError::new("attachment_upload_failed", message)
            }
            Self::Rejected | Self::InvalidResponse => {
                SubmitReportError::new("server_rejected", "GitHub rejected the report")
            }
        }
    }
}

fn github_issue_args(payload: &RelayRequest) -> Vec<String> {
    vec![
        "issue".to_string(),
        "create".to_string(),
        "--repo".to_string(),
        GITHUB_REPO.to_string(),
        "--title".to_string(),
        payload.title.clone(),
        "--body-file".to_string(),
        "-".to_string(),
        "--label".to_string(),
        "user-report".to_string(),
        "--label".to_string(),
        if payload.kind == "bug" {
            "bug".to_string()
        } else {
            "enhancement".to_string()
        },
    ]
}

fn parse_github_attachment_output(stdout: &[u8]) -> Result<String, GitHubCliError> {
    let stdout = std::str::from_utf8(stdout).map_err(|_| GitHubCliError::InvalidResponse)?;
    stdout
        .lines()
        .map(str::trim)
        .find(|line| line.contains(GITHUB_ATTACHMENT_URL_PREFIX))
        .map(str::to_string)
        .ok_or(GitHubCliError::InvalidResponse)
}

fn attachment_extension(media_type: &str) -> Result<&'static str, GitHubCliError> {
    match media_type {
        "image/png" => Ok("png"),
        "image/jpeg" => Ok("jpg"),
        "image/gif" => Ok("gif"),
        _ => Err(GitHubCliError::AttachmentUpload(
            "Attachment type is not supported".to_string(),
        )),
    }
}

fn github_attachment_args(path: &std::path::Path) -> Vec<std::ffi::OsString> {
    vec![
        "image".into(),
        path.as_os_str().to_owned(),
        "--repo".into(),
        GITHUB_REPO.into(),
    ]
}

fn upload_github_attachments(
    attachments: &[ReportAttachment],
) -> Result<Vec<String>, GitHubCliError> {
    let directory = tempfile::Builder::new()
        .prefix("tauri-explorer-report-")
        .tempdir()
        .map_err(|error| GitHubCliError::AttachmentUpload(error.to_string()))?;
    let mut markdown = Vec::with_capacity(attachments.len());

    for (index, attachment) in attachments.iter().enumerate() {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&attachment.data)
            .map_err(|_| {
                GitHubCliError::AttachmentUpload("Attachment data is invalid".to_string())
            })?;
        let path = directory.path().join(format!(
            "attachment-{}.{}",
            index + 1,
            attachment_extension(&attachment.media_type)?,
        ));
        std::fs::write(&path, bytes)
            .map_err(|error| GitHubCliError::AttachmentUpload(error.to_string()))?;

        let output = Command::new("gh")
            .no_console()
            .args(github_attachment_args(&path))
            .env("GH_PROMPT_DISABLED", "true")
            .env("GH_NO_UPDATE_NOTIFIER", "true")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .map_err(|_| GitHubCliError::Unavailable)?;
        if !output.status.success() {
            let detail = String::from_utf8_lossy(&output.stderr)
                .lines()
                .next()
                .unwrap_or("gh image failed")
                .to_string();
            return Err(GitHubCliError::AttachmentUpload(detail));
        }
        markdown.push(parse_github_attachment_output(&output.stdout)?);
    }

    Ok(markdown)
}

fn body_with_github_attachments(body: &str, attachments: &[String]) -> String {
    if attachments.is_empty() {
        return body.to_string();
    }
    let separator = if body.is_empty() { "" } else { "\n\n" };
    format!(
        "{body}{separator}## Attachments\n\n{}",
        attachments.join("\n\n"),
    )
}

fn parse_github_issue_output(stdout: &[u8]) -> Result<SubmittedUserReport, GitHubCliError> {
    let stdout = std::str::from_utf8(stdout).map_err(|_| GitHubCliError::InvalidResponse)?;
    let url = stdout
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| line.starts_with(GITHUB_ISSUE_URL_PREFIX))
        .ok_or(GitHubCliError::InvalidResponse)?;
    let number = url
        .strip_prefix(GITHUB_ISSUE_URL_PREFIX)
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or(GitHubCliError::InvalidResponse)?;
    Ok(SubmittedUserReport {
        url: url.to_string(),
        number,
    })
}

fn submit_via_github_cli(payload: &RelayRequest) -> Result<SubmittedUserReport, GitHubCliError> {
    let attachment_markdown = upload_github_attachments(&payload.attachments)?;
    let issue_body = body_with_github_attachments(&payload.body, &attachment_markdown);
    let mut command = Command::new("gh");
    command
        .no_console()
        .args(github_issue_args(payload))
        .env("GH_PROMPT_DISABLED", "true")
        .env("GH_NO_UPDATE_NOTIFIER", "true")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|_| GitHubCliError::Unavailable)?;
    let Some(mut stdin) = child.stdin.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return Err(GitHubCliError::Unavailable);
    };
    if stdin.write_all(issue_body.as_bytes()).is_err() {
        drop(stdin);
        let _ = child.kill();
        let _ = child.wait();
        return Err(GitHubCliError::Rejected);
    }
    drop(stdin);
    let output = child
        .wait_with_output()
        .map_err(|_| GitHubCliError::Rejected)?;
    if !output.status.success() {
        return Err(GitHubCliError::Rejected);
    }
    parse_github_issue_output(&output.stdout)
}

fn deliver_report_with<G, R>(
    payload: RelayRequest,
    submit_to_github: G,
    submit_to_relay: R,
) -> Result<SubmittedUserReport, SubmitReportError>
where
    G: FnOnce(&RelayRequest) -> Result<SubmittedUserReport, GitHubCliError>,
    R: FnOnce(RelayRequest) -> Result<SubmittedUserReport, SubmitReportError>,
{
    let has_attachments = !payload.attachments.is_empty();
    match submit_to_github(&payload) {
        Ok(issue) => return Ok(issue),
        Err(error) if has_attachments => return Err(error.into_submit_error()),
        Err(error) => {
            log::debug!("GitHub CLI report submission unavailable: {error:?}");
        }
    }
    submit_to_relay(payload)
}

fn deliver_report(
    endpoint: &str,
    payload: RelayRequest,
) -> Result<SubmittedUserReport, SubmitReportError> {
    deliver_report_with(payload, submit_via_github_cli, |payload| {
        send_report(endpoint, payload)
    })
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
        contact: contact.unwrap_or_default(),
        version: info.version,
        os: info.os,
        arch: info.arch,
        website: String::new(),
        attachments,
    };
    tauri::async_runtime::spawn_blocking(move || deliver_report(&endpoint, payload))
        .await
        .map_err(|error| SubmitReportError::new("server_rejected", error.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::{
        assemble_issue_body, attachment_from_image_bytes, body_with_github_attachments,
        deliver_report_with, github_attachment_args, github_issue_args,
        parse_github_attachment_output, parse_github_issue_output, report_image_media_type,
        send_report, validate_attachments, validate_draft, Environment, GitHubCliError,
        RelayRequest, ReportAttachment, SubmittedUserReport, MAX_RELAY_BODY_UNITS,
    };
    use std::cell::Cell;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::{Shutdown, TcpListener};

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
        assert!(body.encode_utf16().count() <= MAX_RELAY_BODY_UNITS);
        assert_eq!(body, description);

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
    fn github_cli_submission_uses_stdin_and_the_matching_report_label() {
        let args = github_issue_args(&payload());
        assert_eq!(
            args,
            [
                "issue",
                "create",
                "--repo",
                "xnmp/tauri-explorer",
                "--title",
                "Title",
                "--body-file",
                "-",
                "--label",
                "user-report",
                "--label",
                "bug",
            ]
        );

        let mut feature = payload();
        feature.kind = "feature".to_string();
        assert_eq!(github_issue_args(&feature).last().unwrap(), "enhancement");
    }

    #[test]
    fn github_image_output_is_appended_to_the_issue_body() {
        assert_eq!(
            github_attachment_args(std::path::Path::new("/tmp/report image.png")),
            [
                "image",
                "/tmp/report image.png",
                "--repo",
                "xnmp/tauri-explorer",
            ]
            .map(std::ffi::OsString::from),
        );
        let markdown = parse_github_attachment_output(
            b"![attachment-1.png](https://github.com/user-attachments/assets/abc123)\n",
        )
        .unwrap();
        assert_eq!(
            body_with_github_attachments("Description", &[markdown]),
            "Description\n\n## Attachments\n\n![attachment-1.png](https://github.com/user-attachments/assets/abc123)",
        );
        assert_eq!(
            body_with_github_attachments(
                "",
                &["![shot](https://github.com/user-attachments/assets/123)".to_string()],
            ),
            "## Attachments\n\n![shot](https://github.com/user-attachments/assets/123)",
        );
        assert_eq!(
            parse_github_attachment_output(b"not an attachment").unwrap_err(),
            GitHubCliError::InvalidResponse,
        );
    }

    #[test]
    fn github_cli_output_returns_the_created_issue_contract() {
        let issue =
            parse_github_issue_output(b"https://github.com/xnmp/tauri-explorer/issues/591\n")
                .unwrap();
        assert_eq!(issue.number, 591);
        assert_eq!(
            issue.url,
            "https://github.com/xnmp/tauri-explorer/issues/591"
        );
        assert_eq!(
            parse_github_issue_output(b"not an issue url").unwrap_err(),
            GitHubCliError::InvalidResponse
        );
    }

    #[test]
    fn text_reports_prefer_github_cli_and_fall_back_to_the_relay() {
        let relay_called = Cell::new(false);
        let issue = deliver_report_with(
            payload(),
            |_| {
                Ok(SubmittedUserReport {
                    url: "https://github.com/xnmp/tauri-explorer/issues/591".to_string(),
                    number: 591,
                })
            },
            |_| {
                relay_called.set(true);
                unreachable!("relay must not run after a successful gh submission")
            },
        )
        .unwrap();
        assert_eq!(issue.number, 591);
        assert!(!relay_called.get());

        let relay_called = Cell::new(false);
        let issue = deliver_report_with(
            payload(),
            |_| Err(GitHubCliError::Unavailable),
            |_| {
                relay_called.set(true);
                Ok(SubmittedUserReport {
                    url: "https://github.com/xnmp/tauri-explorer/issues/592".to_string(),
                    number: 592,
                })
            },
        )
        .unwrap();
        assert_eq!(issue.number, 592);
        assert!(relay_called.get());
    }

    #[test]
    fn reports_with_images_require_the_cli_upload_to_succeed() {
        let mut report = payload();
        report.attachments.push(png_attachment());
        let github_called = Cell::new(false);
        let delivered = deliver_report_with(
            report,
            |payload| {
                github_called.set(true);
                assert_eq!(payload.attachments.len(), 1);
                Ok(SubmittedUserReport {
                    url: "https://github.com/xnmp/tauri-explorer/issues/593".to_string(),
                    number: 593,
                })
            },
            |_| unreachable!("relay must not run after a successful attachment upload"),
        )
        .unwrap();
        assert_eq!(delivered.number, 593);
        assert!(github_called.get());

        let mut report = payload();
        report.attachments.push(png_attachment());
        let relay_called = Cell::new(false);
        let error = deliver_report_with(
            report,
            |_| {
                Err(GitHubCliError::AttachmentUpload(
                    "upload failed".to_string(),
                ))
            },
            |_| {
                relay_called.set(true);
                unreachable!("selected images must never be silently dropped")
            },
        )
        .unwrap_err();
        assert_eq!(error.kind, "attachment_upload_failed");
        assert!(!relay_called.get());
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
        validate_draft("Title", " ", "feature", None).unwrap();
        assert_eq!(
            validate_draft("Title", &"x".repeat(8001), "bug", None)
                .unwrap_err()
                .kind,
            "malformed_input"
        );
    }
}
