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
/// The relay's body ceiling (`maxRelayBodyUnits` in the relay contract).
const MAX_RELAY_BODY_UNITS: usize = 8500;
/// Slow folder-load diagnostics the reporter chose to include (#1022).
const MAX_DIAGNOSTICS_UNITS: usize = 6000;
/// Below this remaining budget a diagnostics section would be too truncated
/// to help, so it is omitted instead.
const MIN_DIAGNOSTICS_UNITS: usize = 200;
const DIAGNOSTICS_TRUNCATED: &str = "\n… (truncated to fit the report)";

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

fn units(value: &str) -> usize {
    value.encode_utf16().count()
}

/// Append the reporter-approved slow-load diagnostics (#1022) after the
/// environment block, inside a collapsed section and a code fence so paths
/// render literally. The relay body limit is never exceeded: the section is
/// truncated at a line boundary to the remaining budget, or omitted when too
/// little remains. This is not a log tail (#595): the dialog shows exactly
/// these records, each captured when a load stalled, and the reporter can
/// exclude them.
fn append_diagnostics(body: String, diagnostics: Option<&str>) -> String {
    let Some(diagnostics) = diagnostics
        .map(sanitize)
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
    else {
        return body;
    };
    let longest_backtick_run = diagnostics
        .split(|character| character != '`')
        .map(str::len)
        .max()
        .unwrap_or(0);
    let fence = "`".repeat(longest_backtick_run.max(2) + 1);
    let open =
        format!("\n\n<details><summary>Slow folder-load diagnostics</summary>\n\n{fence}text\n");
    let close = format!("\n{fence}\n\n</details>");
    let overhead = units(&body) + units(&open) + units(&close);
    let Some(budget) = MAX_RELAY_BODY_UNITS
        .checked_sub(overhead)
        .filter(|budget| *budget >= MIN_DIAGNOSTICS_UNITS)
    else {
        return body;
    };
    let fitted = if units(&diagnostics) <= budget {
        diagnostics
    } else {
        let keep = truncate_utf16(&diagnostics, budget - units(DIAGNOSTICS_TRUNCATED));
        let keep = keep
            .rfind('\n')
            .map_or(keep.as_str(), |line_end| &keep[..line_end]);
        format!("{keep}{DIAGNOSTICS_TRUNCATED}")
    };
    format!("{body}{open}{fitted}{close}")
}

fn validate_diagnostics(diagnostics: Option<&str>) -> Result<(), SubmitReportError> {
    if diagnostics.is_some_and(|value| units(value) > MAX_DIAGNOSTICS_UNITS) {
        return Err(SubmitReportError::new(
            "malformed_input",
            "Diagnostics must be at most 6000 characters",
        ));
    }
    Ok(())
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

/// Environment override for the report relay. Release builds honour it so the
/// alpha smoke can exercise rejection and ambiguity against a controlled local
/// relay (docs/testing/alpha-release-smoke.md). It is restricted to `https://`
/// or loopback `http://`, so an environment that sets it cannot send a report
/// in cleartext to a remote host (SECURITY.md).
const REPORT_URL_OVERRIDE: &str = "TAURI_EXPLORER_REPORT_URL";

/// The relay endpoint for `override_url` (the override's value, if set).
/// An empty override means unset; any other unacceptable override fails the
/// submission before anything is sent, rather than silently reporting to the
/// production relay from what was meant to be a controlled test.
fn report_endpoint(override_url: Option<&str>) -> Result<String, SubmitReportError> {
    match override_url.map(str::trim) {
        None | Some("") => Ok(DEFAULT_REPORT_URL.to_string()),
        Some(url) if permitted_report_url(url) => Ok(url.to_string()),
        Some(url) => {
            log::warn!("{}", rejected_override_warning(url));
            Err(SubmitReportError::new(
                "server_rejected",
                format!("{REPORT_URL_OVERRIDE} must be an https:// URL or a loopback http:// URL; nothing was sent"),
            ))
        }
    }
}

fn rejected_override_warning(url: &str) -> String {
    format!(
        "Ignoring {REPORT_URL_OVERRIDE} ({}): it must be https:// or loopback http://",
        redacted_report_url(url)
    )
}

/// Log-safe summary of a rejected override: scheme and host only. Userinfo
/// (`user:token@`), path and query can carry credentials, so they never reach
/// the log; the host is bounded because the value is attacker-sized input.
fn redacted_report_url(url: &str) -> String {
    const MAX_HOST_CHARS: usize = 128;
    let Ok(uri) = url.parse::<ureq::http::Uri>() else {
        return "unparseable URL".to_string();
    };
    let scheme = uri.scheme_str().unwrap_or("no scheme");
    match uri.host().filter(|host| !host.is_empty()) {
        Some(host) if host.chars().count() > MAX_HOST_CHARS => {
            let bounded: String = host.chars().take(MAX_HOST_CHARS).collect();
            format!("{scheme}://{bounded}...")
        }
        Some(host) => format!("{scheme}://{host}"),
        None => format!("{scheme} URL without a host"),
    }
}

fn permitted_report_url(url: &str) -> bool {
    let Ok(uri) = url.parse::<ureq::http::Uri>() else {
        return false;
    };
    let Some(host) = uri.host().filter(|host| !host.is_empty()) else {
        return false;
    };
    match uri.scheme_str() {
        Some(scheme) if scheme.eq_ignore_ascii_case("https") => true,
        Some(scheme) if scheme.eq_ignore_ascii_case("http") => is_loopback_host(host),
        _ => false,
    }
}

/// `localhost` or a literal loopback address. Names that merely resolve to a
/// loopback address (`127.0.0.1.nip.io`) are refused: resolution can change.
fn is_loopback_host(host: &str) -> bool {
    let bare = host
        .strip_prefix('[')
        .and_then(|inner| inner.strip_suffix(']'))
        .unwrap_or(host);
    bare.eq_ignore_ascii_case("localhost")
        || bare
            .parse::<std::net::IpAddr>()
            .is_ok_and(|address| address.is_loopback())
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
    diagnostics: Option<String>,
) -> Result<SubmittedUserReport, SubmitReportError> {
    validate_draft(&title, &body, &kind, contact.as_deref())?;
    validate_diagnostics(diagnostics.as_deref())?;
    let attachments = attachments.unwrap_or_default();
    validate_attachments(&attachments)?;
    let info = crate::system::get_app_info().await;
    let assembled = append_diagnostics(
        assemble_issue_body(
            &body,
            contact.as_deref(),
            &Environment {
                version: &info.version,
                os: &info.os,
                arch: &info.arch,
            },
        ),
        diagnostics.as_deref(),
    );
    let endpoint = report_endpoint(std::env::var(REPORT_URL_OVERRIDE).ok().as_deref())?;
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
        append_diagnostics, truncate_utf16, units, validate_diagnostics, MAX_DIAGNOSTICS_UNITS,
        MAX_RELAY_BODY_UNITS,
    };
    use super::{
        assemble_issue_body, attachment_from_image_bytes, map_transport_error, relay_error_kind,
        report_image_media_type, send_report, validate_attachments, validate_draft, Environment,
        RelayRequest, ReportAttachment, MAX_ATTACHMENTS, MAX_ATTACHMENTS_BYTES,
        MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_NAME_UNITS, MAX_CONTACT_UNITS,
        MAX_REPORT_DESCRIPTION_UNITS, MAX_TITLE_UNITS,
    };
    use super::{
        redacted_report_url, rejected_override_warning, report_endpoint, DEFAULT_REPORT_URL,
    };
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::{Shutdown, TcpListener};

    #[test]
    fn report_endpoint_defaults_to_the_production_relay_when_unset_or_empty() {
        for unset in [None, Some(""), Some("   ")] {
            assert_eq!(report_endpoint(unset).unwrap(), DEFAULT_REPORT_URL);
        }
    }

    #[test]
    fn report_endpoint_accepts_https_and_loopback_http() {
        for url in [
            "https://relay.example.test/api/report",
            "HTTPS://relay.example.test/api/report",
            "https://203.0.113.9:8443/report",
            "http://localhost:3000/api/report",
            "http://LOCALHOST/report",
            "http://127.0.0.1:8787/report",
            "http://127.12.0.1/report",
            "http://[::1]:8787/report",
        ] {
            assert_eq!(report_endpoint(Some(url)).unwrap(), url, "{url}");
        }
    }

    #[test]
    fn report_endpoint_rejects_cleartext_remote_and_non_http_overrides() {
        for url in [
            "http://relay.example.test/api/report",
            "http://203.0.113.9/report",
            "http://localhost.example.test/report",
            "http://127.0.0.1.nip.io/report",
            "http://[::ffff:203.0.113.9]/report",
            "http://0x7f000001/report",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "ftp://localhost/report",
            "ws://localhost/report",
            "localhost:3000/report",
            "https://",
            "http:///report",
            "not a url",
            "https://exa mple.test/report",
        ] {
            let error = report_endpoint(Some(url)).expect_err(url);
            assert_eq!(error.kind, "server_rejected", "{url}");
            assert!(error.message.contains("TAURI_EXPLORER_REPORT_URL"), "{url}");
        }
    }

    #[test]
    fn report_endpoint_rejects_an_extremely_long_override_without_panicking() {
        let url = format!("http://{}.example.test/report", "a".repeat(100_000));
        assert!(report_endpoint(Some(&url)).is_err());
    }

    #[test]
    fn rejected_override_logs_only_scheme_and_host() {
        assert_eq!(
            rejected_override_warning("http://reporter:s3cret@relay.example.test/api?token=t0k"),
            "Ignoring TAURI_EXPLORER_REPORT_URL (http://relay.example.test): \
             it must be https:// or loopback http://"
        );
        assert_eq!(
            redacted_report_url("http://reporter:s3cret@relay.example.test:8080/api?token=t0k"),
            "http://relay.example.test"
        );
        assert_eq!(
            redacted_report_url("ftp://ops:hunter2@[::1]/report"),
            "ftp://[::1]"
        );
        for url in [
            "http://reporter:s3cret@relay.example.test/report?token=t0k",
            "https://:s3cret@/report",
            "localhost:s3cret",
            "not a url s3cret",
            "javascript:alert('s3cret')",
            "file:///home/me/s3cret",
        ] {
            let redacted = rejected_override_warning(url);
            assert!(!redacted.contains("s3cret"), "{url} -> {redacted}");
            assert!(!redacted.contains("t0k"), "{url} -> {redacted}");
        }
    }

    #[test]
    fn rejected_override_log_is_bounded_for_extremely_long_hosts() {
        let url = format!("http://{}.example.test/report", "a".repeat(100_000));
        assert!(redacted_report_url(&url).len() < 200);
    }

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

    fn environment() -> Environment<'static> {
        Environment {
            version: "1.11.3",
            os: "linux",
            arch: "x86_64",
        }
    }

    #[test]
    fn relay_body_ceiling_matches_the_relay_contract() {
        assert_eq!(MAX_RELAY_BODY_UNITS, contract_limit("maxRelayBodyUnits"));
    }

    #[test]
    fn approved_diagnostics_follow_the_environment_in_a_collapsed_literal_block() {
        let base = assemble_issue_body("It hangs", None, &environment());
        let body = append_diagnostics(
            base.clone(),
            Some("1. /mnt/nas/photos — 7.4 s, still pending\n   stuck in: native read-dir"),
        );
        assert!(body.starts_with(&base));
        assert!(body.contains("<details><summary>Slow folder-load diagnostics</summary>"));
        assert!(body.contains("```text\n1. /mnt/nas/photos"));
        assert!(body.ends_with("```\n\n</details>"));
        // Nothing approved, nothing appended.
        assert_eq!(append_diagnostics(base.clone(), None), base);
        assert_eq!(append_diagnostics(base.clone(), Some("  \n ")), base);
    }

    #[test]
    fn a_path_containing_backticks_cannot_close_the_fence() {
        let body = append_diagnostics(
            assemble_issue_body("", None, &environment()),
            Some("1. /tmp/```weird````dir — 6.0 s"),
        );
        assert!(body.contains("`````text\n1. /tmp/```weird````dir"));
    }

    #[test]
    fn diagnostics_never_push_the_body_past_the_relay_limit() {
        let lines: String = (0..400)
            .map(|n| format!("{n}. /very/long/path/{}\n", "x".repeat(10)))
            .collect();
        let diagnostics = truncate_utf16(&lines, MAX_DIAGNOSTICS_UNITS);
        validate_diagnostics(Some(&diagnostics)).unwrap();
        for description in ["", "short", &"d".repeat(4000), &"🐛".repeat(3900)] {
            let body = append_diagnostics(
                assemble_issue_body(description, Some("@me"), &environment()),
                Some(&diagnostics),
            );
            assert!(units(&body) <= MAX_RELAY_BODY_UNITS, "{}", units(&body));
            assert!(body.contains(description));
            let truncated = body.contains("(truncated to fit the report)");
            assert_eq!(
                truncated,
                units(description) > 1000,
                "{}",
                units(description)
            );
            // Truncation happens at a line boundary.
            assert!(!body.contains("/very/long/path/xxxxx\n…"));
        }
        // A maximal description still fits: only what the budget allows.
        let full = assemble_issue_body(
            &"x".repeat(MAX_REPORT_DESCRIPTION_UNITS),
            Some(&"c".repeat(MAX_CONTACT_UNITS)),
            &environment(),
        );
        let with = append_diagnostics(full.clone(), Some(&diagnostics));
        assert!(with.starts_with(&full));
        assert!(units(&with) <= MAX_RELAY_BODY_UNITS);
        // With too little room left the section is omitted, not mangled.
        let crowded = format!(
            "{full}{}",
            "y".repeat(MAX_RELAY_BODY_UNITS - units(&full) - 150)
        );
        assert!(append_diagnostics(crowded.clone(), Some(&diagnostics)) == crowded);
    }

    #[test]
    fn oversized_or_control_laden_diagnostics_are_handled_at_the_boundary() {
        assert_eq!(
            validate_diagnostics(Some(&"x".repeat(MAX_DIAGNOSTICS_UNITS + 1)))
                .unwrap_err()
                .kind,
            "malformed_input"
        );
        validate_diagnostics(None).unwrap();
        let body = append_diagnostics(String::from("base"), Some("a\u{0}b\u{7}c"));
        assert!(body.contains("abc"));
    }
}
