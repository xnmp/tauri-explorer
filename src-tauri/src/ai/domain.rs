//! Pure text-service contracts, validation and cache identity.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use url::Url;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServiceError {
    pub code: &'static str,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after_ms: Option<u64>,
}
impl ServiceError {
    pub fn new(code: &'static str, message: &str) -> Self {
        Self {
            code,
            message: message.into(),
            retry_after_ms: None,
        }
    }
    pub fn invalid(message: &str) -> Self {
        Self::new("invalid_request", message)
    }
}
impl std::fmt::Display for ServiceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}
impl std::error::Error for ServiceError {}
pub type Result<T> = std::result::Result<T, ServiceError>;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum Credential {
    None,
    Environment { name: String },
    Secret { id: String },
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "transport")]
pub enum Connection {
    #[serde(rename = "codex-cli", rename_all = "camelCase")]
    Codex { executable_path: String },
    #[serde(rename = "claude-code-cli", rename_all = "camelCase")]
    Claude { executable_path: String },
    #[serde(rename = "openai-chat-completions", rename_all = "camelCase")]
    Chat {
        base_url: String,
        allow_insecure_http: bool,
        credential: Credential,
    },
    #[serde(rename = "anthropic-messages", rename_all = "camelCase")]
    Messages {
        base_url: String,
        allow_insecure_http: bool,
        credential: Credential,
    },
}
impl Connection {
    pub fn transport(&self) -> &'static str {
        match self {
            Self::Codex { .. } => "codex-cli",
            Self::Claude { .. } => "claude-code-cli",
            Self::Chat { .. } => "openai-chat-completions",
            Self::Messages { .. } => "anthropic-messages",
        }
    }
    pub fn credential(&self) -> Option<&Credential> {
        match self {
            Self::Chat { credential, .. } | Self::Messages { credential, .. } => Some(credential),
            _ => None,
        }
    }
    pub fn credential_mut(&mut self) -> Option<&mut Credential> {
        match self {
            Self::Chat { credential, .. } | Self::Messages { credential, .. } => Some(credential),
            _ => None,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub model: String,
    pub timeout_ms: u64,
    #[serde(flatten)]
    pub connection: Connection,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Configuration {
    pub schema_version: u64,
    pub revision: u64,
    pub enabled: bool,
    pub default_profile_id: Option<String>,
    pub profiles: Vec<Profile>,
}
impl Default for Configuration {
    fn default() -> Self {
        Self {
            schema_version: 1,
            revision: 0,
            enabled: true,
            default_profile_id: Some("codex".into()),
            profiles: vec![Profile {
                id: "codex".into(),
                name: "Codex".into(),
                model: "gpt-6-luna".into(),
                timeout_ms: 45_000,
                connection: Connection::Codex {
                    executable_path: String::new(),
                },
            }],
        }
    }
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Context {
    pub profile_id: String,
    pub configuration_revision: u64,
    pub fingerprint: String,
    pub transport: &'static str,
    pub requested_model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actual_model: Option<String>,
}
impl Profile {
    pub fn context(&self, revision: u64) -> Context {
        // Secret/source, label, timeout and revision cannot change generated text.
        let identity = match &self.connection {
            Connection::Codex { executable_path } | Connection::Claude { executable_path } => {
                executable_path.clone()
            }
            Connection::Chat { base_url, .. } | Connection::Messages { base_url, .. } => {
                base_url.clone()
            }
        };
        let canonical = serde_json::to_vec(&(
            "text-adapter-v1",
            self.connection.transport(),
            identity,
            &self.model,
        ))
        .expect("serializable fingerprint");
        Context {
            profile_id: self.id.clone(),
            configuration_revision: revision,
            fingerprint: hex::encode(Sha256::digest(canonical)),
            transport: self.connection.transport(),
            requested_model: self.model.clone(),
            actual_model: None,
        }
    }
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub request_id: String,
    pub instructions: String,
    pub input: String,
    pub max_output_tokens: u32,
    pub timeout_ms: Option<u64>,
    pub expected_configuration_revision: Option<u64>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
}
#[derive(Debug, Serialize)]
pub struct TextResult {
    pub text: String,
    pub context: Context,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<Usage>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Describe {
    pub version: u8,
    pub enabled: bool,
    pub available: bool,
    pub configuration_revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<Context>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ServiceError>,
}
#[derive(Debug, Serialize)]
pub struct Check {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ServiceError>,
}

pub fn valid_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
}
fn valid_label(s: &str) -> bool {
    !s.trim().is_empty() && s.chars().count() <= 256 && !s.chars().any(char::is_control)
}
pub fn validate_request(request: &Request) -> Result<()> {
    if !valid_id(&request.request_id) {
        return Err(ServiceError::invalid(
            "Request ID must contain 1–128 letters, digits, dots, underscores or hyphens",
        ));
    }
    if request
        .instructions
        .len()
        .saturating_add(request.input.len())
        > 64 * 1024
        || request.input.trim().is_empty()
    {
        return Err(ServiceError::invalid(
            "Text input must be nonempty and combined input must fit 64 KiB",
        ));
    }
    if !(1..=4096).contains(&request.max_output_tokens)
        || request.timeout_ms.is_some_and(|n| n == 0 || n > 45_000)
    {
        return Err(ServiceError::invalid(
            "Output tokens must be 1–4096 and deadline at most 45 seconds",
        ));
    }
    Ok(())
}
pub fn api_root(base: &str, allow_http: bool) -> Result<Url> {
    if base.len() > 2048 {
        return Err(ServiceError::invalid("API root is too long"));
    }
    let mut url =
        Url::parse(base).map_err(|_| ServiceError::invalid("Enter an absolute API root URL"))?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.host_str().is_none()
    {
        return Err(ServiceError::invalid(
            "API root cannot contain credentials, query strings or fragments",
        ));
    }
    let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if url.scheme() != "https" && !(url.scheme() == "http" && (allow_http || local)) {
        return Err(ServiceError::invalid(
            "Use HTTPS or explicitly allow insecure HTTP",
        ));
    }
    let path = format!("{}/", url.path().trim_end_matches('/'));
    url.set_path(&path);
    Ok(url)
}
pub fn validate_configuration(config: &mut Configuration) -> Result<()> {
    if config.schema_version != 1 {
        return Err(ServiceError::new(
            "unavailable",
            "AI configuration schema is unsupported; update the host",
        ));
    }
    if config.revision > 9_007_199_254_740_991 {
        return Err(ServiceError::invalid(
            "Configuration revision exceeds its supported range",
        ));
    }
    if config.profiles.len() > 32 {
        return Err(ServiceError::invalid(
            "At most 32 text profiles are supported",
        ));
    }
    let mut ids = HashSet::new();
    for p in &mut config.profiles {
        if !valid_id(&p.id)
            || !ids.insert(p.id.clone())
            || !valid_label(&p.name)
            || !valid_label(&p.model)
            || !(1000..=45_000).contains(&p.timeout_ms)
        {
            return Err(ServiceError::invalid(
                "Profiles require unique IDs, a name/model and a 1–45 second timeout",
            ));
        }
        match &mut p.connection {
            Connection::Codex { executable_path } | Connection::Claude { executable_path } => {
                if executable_path.len() > 4096 || executable_path.chars().any(char::is_control) {
                    return Err(ServiceError::invalid("Invalid CLI executable path"));
                }
            }
            Connection::Chat {
                base_url,
                allow_insecure_http,
                credential,
            }
            | Connection::Messages {
                base_url,
                allow_insecure_http,
                credential,
            } => {
                *base_url = api_root(base_url, *allow_insecure_http)?
                    .as_str()
                    .trim_end_matches('/')
                    .to_owned();
                match credential {
                    Credential::Environment { name } => {
                        if name.len() > 128
                            || name.is_empty()
                            || !name.bytes().enumerate().all(|(i, c)| {
                                c == b'_'
                                    || c.is_ascii_alphabetic()
                                    || (i > 0 && c.is_ascii_digit())
                            })
                        {
                            return Err(ServiceError::invalid(
                                "Invalid credential environment variable name",
                            ));
                        }
                    }
                    Credential::Secret { id } if !valid_id(id) => {
                        return Err(ServiceError::invalid("Invalid credential reference"));
                    }
                    _ => {}
                }
            }
        }
    }
    if config
        .default_profile_id
        .as_ref()
        .is_some_and(|id| !ids.contains(id))
        || config.enabled && config.default_profile_id.is_none()
    {
        return Err(ServiceError::invalid(
            "Select an existing default profile or disable text generation",
        ));
    }
    Ok(())
}
pub fn final_text(s: &str) -> Result<String> {
    let text = s.trim();
    if text.is_empty()
        || text.len() > 64 * 1024
        || text
            .chars()
            .any(|c| c.is_control() && c != '\n' && c != '\t' && c != '\r')
    {
        Err(ServiceError::new(
            "invalid_response",
            "Provider returned invalid or oversized text",
        ))
    } else {
        Ok(text.to_owned())
    }
}

pub fn parse_configuration(value: serde_json::Value) -> Result<Configuration> {
    if let Some(profiles) = value.get("profiles").and_then(serde_json::Value::as_array) {
        for profile in profiles {
            let fields = profile
                .as_object()
                .ok_or_else(|| ServiceError::invalid("Profile must be an object"))?;
            let is_cli = matches!(
                profile.get("transport").and_then(serde_json::Value::as_str),
                Some("codex-cli" | "claude-code-cli")
            );
            if fields.keys().any(|key| {
                !matches!(
                    key.as_str(),
                    "id" | "name" | "model" | "timeoutMs" | "transport"
                ) && !(is_cli && key == "executablePath")
                    && !(!is_cli
                        && matches!(key.as_str(), "baseUrl" | "allowInsecureHttp" | "credential"))
            }) {
                return Err(ServiceError::invalid(
                    "Profile contains unsupported fields for its transport",
                ));
            }
        }
    }
    serde_json::from_value(value).map_err(|_| ServiceError::invalid("Malformed AI configuration"))
}
