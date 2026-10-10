//! Host semantic intent excludes transport tokens/handles but covers all paid
//! request choices; a forged recipe digest cannot change a repeated operation.
use super::{model::ArtifactDescriptor, receipt::Options};
use crate::error::AppError;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Start {
    operation_id: String,
    connection_id: String,
    expected_connection_revision: String,
    model: Option<String>,
    prompt: String,
    inputs: Vec<ArtifactDescriptor>,
    options: Options,
    preparation_token: String,
    effective_recipe_digest: String,
}
fn bounded(value: &str, max: usize) -> bool {
    !value.is_empty() && value.len() <= max && !value.chars().any(char::is_control)
}
pub(crate) fn semantic(value: &Value) -> Result<String, AppError> {
    let reject = || AppError::Other("Invalid image start request".into());
    let request: Start = serde_json::from_value(value.clone()).map_err(|_| reject())?;
    let valid_id = !request.operation_id.is_empty()
        && request.operation_id.len() <= 128
        && request
            .operation_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b));
    if !valid_id
        || !super::receipt::identity(&request.connection_id)
        || !super::receipt::identity(&request.expected_connection_revision)
        || request.model.as_ref().is_some_and(|v| !super::receipt::model(v))
        || request.prompt.trim().is_empty()
        || request.prompt.len() > 16000
        || request.prompt.contains('\0')
        || request.inputs.len() > 8
        || !request.options.valid()
        || !bounded(&request.preparation_token, 128)
        || request.effective_recipe_digest.len() != 64
        || !request
            .effective_recipe_digest
            .bytes()
            .all(|b| b.is_ascii_hexdigit())
    {
        return Err(reject());
    }
    let mut total = 0u64;
    for input in &request.inputs {
        total = total.checked_add(input.byte_length).ok_or_else(reject)?;
        if input.sha256.len() != 64
            || input.handle.is_empty() || input.handle.len()>128
            || !input.sha256.bytes().all(|b| b.is_ascii_hexdigit())
            || input.byte_length == 0
            || input.byte_length > 20 * 1024 * 1024
            || !matches!(
                input.media_type.as_str(),
                "image/png" | "image/jpeg" | "image/webp"
            )
        {
            return Err(reject());
        }
    }
    if total > 64 * 1024 * 1024 {
        return Err(reject());
    }
    let inputs=request.inputs.iter().map(|input|json!({"sha256":input.sha256,"byteLength":input.byte_length,"mediaType":input.media_type})).collect::<Vec<_>>();
    let semantic = json!({"schemaVersion":1,"connectionId":request.connection_id,"expectedConnectionRevision":request.expected_connection_revision,"model":request.model,"prompt":request.prompt,"inputs":inputs,"options":request.options});
    let bytes = serde_json::to_vec(&semantic).map_err(|_| reject())?;
    Ok(hex::encode(Sha256::digest(bytes)))
}
