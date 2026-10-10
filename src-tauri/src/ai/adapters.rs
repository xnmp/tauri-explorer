//! Provider IO owns its deadline and never returns raw diagnostics.
use super::{cli, domain::*, Control};
use serde_json::{json, Value};
use std::{sync::Arc, time::Duration};
const MAX_RESPONSE: usize = 256 * 1024;
fn unavailable(message: &str) -> ServiceError {
    ServiceError::new("unavailable", message)
}

/// CLI availability for describe/check: never starts a generation.
pub fn check_cli(profile: &Profile) -> Result<()> {
    cli::check(profile, &cli::process_env, &|| false).map(|_| ())
}
pub async fn execute(
    profile: Profile,
    credential: Option<String>,
    request: Request,
    mut context: Context,
    control: Arc<Control>,
    permit: tokio::sync::OwnedSemaphorePermit,
) -> Result<TextResult> {
    let (text, actual, usage) = match &profile.connection {
        Connection::Codex { .. } | Connection::Claude { .. } => {
            // Availability, policy and the help probe run inside the owned
            // worker so the async caller never blocks on a child process.
            let worker = control.clone();
            tokio::task::spawn_blocking(move || {
                let _permit = permit;
                cli::run(&profile, &request, &worker, &cli::process_env)
            })
            .await
            .map_err(|_| unavailable("CLI worker failed"))??
        }
        _ => {
            let _permit = permit;
            http(&profile, credential.as_deref(), &request, &control).await?
        }
    };
    control.check()?;
    context.actual_model = actual;
    Ok(TextResult {
        text: final_text(&text)?,
        context,
        usage,
    })
}
async fn http(
    profile: &Profile,
    key: Option<&str>,
    request: &Request,
    control: &Control,
) -> Result<(String, Option<String>, Option<Usage>)> {
    let (base, allow, anthropic) = match &profile.connection {
        Connection::Chat {
            base_url,
            allow_insecure_http,
            ..
        } => (base_url, *allow_insecure_http, false),
        Connection::Messages {
            base_url,
            allow_insecure_http,
            ..
        } => (base_url, *allow_insecure_http, true),
        _ => unreachable!(),
    };
    let endpoint = api_root(base, allow)?
        .join(if anthropic {
            "messages"
        } else {
            "chat/completions"
        })
        .map_err(|_| ServiceError::invalid("Invalid API root"))?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .connect_timeout(Duration::from_secs(10))
        .build()
        .map_err(|_| unavailable("HTTP client is unavailable"))?;
    let body = if anthropic {
        json!({"model":profile.model,"max_tokens":request.max_output_tokens,"system":request.instructions,"messages":[{"role":"user","content":request.input}],"stream":false})
    } else {
        json!({"model":profile.model,"max_tokens":request.max_output_tokens,"messages":[{"role":"system","content":request.instructions},{"role":"user","content":request.input}],"stream":false})
    };
    let mut call = client.post(endpoint).json(&body);
    if anthropic {
        call = call.header("anthropic-version", "2023-06-01");
        if let Some(key) = key {
            let mut value = reqwest::header::HeaderValue::from_str(key).map_err(|_| {
                ServiceError::new(
                    "authentication_failed",
                    "API credential cannot be used in a request header",
                )
            })?;
            value.set_sensitive(true);
            call = call.header("x-api-key", value);
        }
    } else if let Some(key) = key {
        call = call.bearer_auth(key);
    }
    control.check()?;
    let io = async {
        let mut response = call.send().await.map_err(|_| {
            ServiceError::new(
                "provider_failed",
                "Could not reach the configured text endpoint",
            )
        })?;
        let status = response.status().as_u16();
        if !(200..300).contains(&status) {
            let mut error = match status {
                401 | 403 => {
                    ServiceError::new("authentication_failed", "Provider rejected the credential")
                }
                429 => ServiceError::new("rate_limited", "Provider rate limit reached"),
                _ => ServiceError::new(
                    "provider_failed",
                    "Text endpoint rejected the request; check protocol and model",
                ),
            };
            error.retry_after_ms = response
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse::<u64>().ok())
                .map(|n| n.saturating_mul(1000).min(3_600_000));
            return Err(error);
        }
        if response
            .content_length()
            .is_some_and(|n| n > MAX_RESPONSE as u64)
        {
            return Err(ServiceError::new(
                "invalid_response",
                "Provider response exceeds its limit",
            ));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| {
            ServiceError::new("invalid_response", "Could not read provider response")
        })? {
            if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE {
                return Err(ServiceError::new(
                    "invalid_response",
                    "Provider response exceeds its limit",
                ));
            }
            bytes.extend(chunk);
        }
        let v: Value = serde_json::from_slice(&bytes).map_err(|_| {
            ServiceError::new("invalid_response", "Provider returned malformed JSON")
        })?;
        parse_http(&v, anthropic)
    };
    tokio::select! {result=io=>result,error=control.stopped()=>Err(error)}
}
fn parse_http(v: &Value, anthropic: bool) -> Result<(String, Option<String>, Option<Usage>)> {
    if anthropic && v["stop_reason"] != "end_turn" {
        return Err(ServiceError::new(
            "invalid_response",
            "Provider did not finish its text response",
        ));
    }
    if !anthropic {
        let choice = &v["choices"][0];
        if choice["finish_reason"] != "stop"
            || choice["message"]["refusal"]
                .as_str()
                .is_some_and(|s| !s.is_empty())
        {
            return Err(ServiceError::new(
                "invalid_response",
                "Provider did not return a complete text response",
            ));
        }
    }
    let text = if anthropic {
        let blocks = v["content"].as_array().ok_or_else(|| {
            ServiceError::new("invalid_response", "Provider returned no text blocks")
        })?;
        if blocks.iter().any(|b| {
            !matches!(
                b["type"].as_str(),
                Some("text" | "thinking" | "redacted_thinking")
            )
        }) {
            return Err(ServiceError::new(
                "invalid_response",
                "Provider returned a tool result instead of text",
            ));
        }
        blocks
            .iter()
            .filter(|b| b["type"] == "text")
            .map(|b| {
                b["text"].as_str().ok_or_else(|| {
                    ServiceError::new("invalid_response", "Malformed provider text block")
                })
            })
            .collect::<Result<Vec<_>>>()?
            .join("")
    } else {
        let choice = &v["choices"][0];
        if choice["message"]["tool_calls"]
            .as_array()
            .is_some_and(|t| !t.is_empty())
        {
            return Err(ServiceError::new(
                "invalid_response",
                "Provider returned tool calls instead of text",
            ));
        }
        choice["message"]["content"]
            .as_str()
            .ok_or_else(|| {
                ServiceError::new("invalid_response", "Provider returned no final text")
            })?
            .into()
    };
    let actual = v["model"]
        .as_str()
        .filter(|m| m.len() <= 256 && !m.chars().any(char::is_control))
        .map(str::to_owned);
    let usage = Some(Usage {
        input_tokens: v["usage"][if anthropic {
            "input_tokens"
        } else {
            "prompt_tokens"
        }]
        .as_u64(),
        output_tokens: v["usage"][if anthropic {
            "output_tokens"
        } else {
            "completion_tokens"
        }]
        .as_u64(),
    });
    Ok((text, actual, usage))
}
