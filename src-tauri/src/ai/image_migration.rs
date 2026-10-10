//! Resumable native image cutover. No plaintext key is copied into the journal.
//! The coordinator releases config guards before credential/provider IO.
use super::{
    credentials::SecretStore,
    domain::{Result, ServiceError},
    storage,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::Path;

const SOURCE: &str = "plugin.openai-image.json";
const MARKER: &str = ".ai-image-migration.json";
const IMPORT: &str = "trace-openai-image-v1";
const PROVIDER: &str = "xnmp.image-generation";
const RETIRED: &[&str] = &[
    "backend",
    "codexPath",
    "apiKey",
    "titleGenerator",
    "titleCodexPath",
];
pub(crate) trait Destination {
    fn call(&self, method: &str, params: Value) -> Result<Value>;
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Stage {
    Prepared,
    CredentialReady,
    DestinationCommitted,
    SourceRetired,
    LegacyResumed,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Journal {
    version: u32,
    #[serde(default = "original_source_id")]
    source_id: String,
    stage: Stage,
    source_digest: String,
    retired_digest: String,
    profile_id: Option<String>,
    secret_id: Option<String>,
    profiles: Vec<Value>,
    default_connection_id: Option<String>,
    skipped_existing: bool,
    receipt: Option<Value>,
}
fn original_source_id() -> String {
    IMPORT.into()
}
fn valid_source_id(value: &str) -> bool {
    value == IMPORT
        || value
            .strip_prefix("trace-openai-image-v1.")
            .is_some_and(|v| {
                v.len() == 32
                    && v.bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            })
}
fn profile_suffix(source_id: &str, source_digest: &str) -> String {
    if source_id == IMPORT {
        source_digest[..16].into()
    } else {
        hex::encode(Sha256::digest(format!("{source_id}:{source_digest}")))[..16].into()
    }
}
fn issue(code: &'static str, message: &str) -> ServiceError {
    ServiceError::new(code, message)
}
fn digest(value: &Value) -> Result<String> {
    Ok(hex::encode(Sha256::digest(
        serde_json::to_vec(value)
            .map_err(|_| issue("unavailable", "Image migration metadata is invalid"))?,
    )))
}
fn retired(value: &Value) -> Value {
    Value::Object(
        RETIRED
            .iter()
            .filter_map(|key| value.get(*key).map(|value| ((*key).into(), value.clone())))
            .collect(),
    )
}
fn source(root: &Path) -> Result<Value> {
    let value = storage::read_value(&root.join(SOURCE))?.unwrap_or_else(|| json!({}));
    if !value.is_object() {
        return Err(issue(
            "unavailable",
            "Legacy image settings must be a JSON object; repair the source before migration",
        ));
    }
    Ok(value)
}
fn read(root: &Path) -> Result<Option<Journal>> {
    let value = storage::read_private_value(&root.join(MARKER))?;
    let Some(value) = value else { return Ok(None) };
    let journal: Journal = serde_json::from_value(value).map_err(|_| {
        issue(
            "unavailable",
            "Image migration journal is malformed; retain it for recovery",
        )
    })?;
    let valid_digest = |v: &str| v.len() == 64 && v.bytes().all(|b| b.is_ascii_hexdigit());
    if journal.version != 1
        || !valid_source_id(&journal.source_id)
        || !valid_digest(&journal.source_digest)
        || !valid_digest(&journal.retired_digest)
        || journal.profiles.len() > 2
        || journal.profile_id.as_deref().is_some_and(|v| {
            !(v.starts_with("import-trace-openai-")
                && v.len() == 36
                && v[20..].bytes().all(|b| b.is_ascii_hexdigit()))
        })
        || journal
            .secret_id
            .as_deref()
            .is_some_and(|v| v.len() != 48 || !v.bytes().all(|b| b.is_ascii_hexdigit()))
        || (matches!(
            journal.stage,
            Stage::DestinationCommitted | Stage::SourceRetired
        ) && journal.receipt.is_none())
    {
        return Err(issue(
            "unavailable",
            "Image migration journal is invalid; retain it for recovery",
        ));
    }
    let suffix = profile_suffix(&journal.source_id, &journal.source_digest);
    let http = format!("import-trace-openai-{suffix}");
    let codex = format!("import-trace-codex-{suffix}");
    let mut seen = std::collections::HashSet::new();
    for profile in &journal.profiles {
        let id = profile["id"].as_str().unwrap_or("");
        if !seen.insert(id)
            || profile["recipeRevision"] != "import-pending"
            || !profile["name"].is_string()
        {
            return Err(issue(
                "unavailable",
                "Image migration profile identity is invalid",
            ));
        }
        let allowed = if id == http {
            profile["transport"] == "openai-images"
                && profile["baseUrl"] == "https://api.openai.com/v1/images"
                && profile["defaultModel"] == "gpt-image-2"
                && profile["allowInsecureHttp"] == false
                && profile["credential"]
                    == journal
                        .secret_id
                        .as_ref()
                        .map(|id| json!({"kind":"secret","id":id}))
                        .unwrap_or_else(|| json!({"kind":"environment","name":"OPENAI_API_KEY"}))
                && profile.as_object().is_some_and(|p| p.len() == 8)
        } else if id == codex {
            profile["transport"] == "codex-cli"
                && profile["modelSelection"] == false
                && profile["credential"] == json!({"kind":"cli_saved_login"})
                && profile["executablePath"]
                    .as_str()
                    .is_some_and(|v| v.len() <= 4096 && !v.contains('\0'))
                && profile.as_object().is_some_and(|p| p.len() == 7)
        } else {
            false
        };
        if !allowed {
            return Err(issue(
                "unavailable",
                "Image migration profile metadata is invalid",
            ));
        }
    }
    if journal
        .profile_id
        .as_ref()
        .is_some_and(|id| id != &http || !seen.contains(http.as_str()))
        || journal.secret_id.is_some() != journal.profile_id.is_some()
        || journal
            .default_connection_id
            .as_ref()
            .is_some_and(|id| !seen.contains(id.as_str()))
        || journal
            .receipt
            .as_ref()
            .is_some_and(|r| !valid_receipt(r, &journal))
    {
        return Err(issue(
            "unavailable",
            "Image migration credential or receipt linkage is invalid",
        ));
    }
    Ok(Some(journal))
}
fn save(root: &Path, journal: &Journal) -> Result<()> {
    if let Some(current) = read(root)? {
        if current.source_id != journal.source_id
            || current.source_digest != journal.source_digest
            || current.retired_digest != journal.retired_digest
        {
            return Err(issue(
                "operation_conflict",
                "Image migration identity changed",
            ));
        }
        if current.stage as u8 > journal.stage as u8 {
            return Ok(());
        }
    }
    storage::durable_write(
        &root.join(MARKER),
        &serde_json::to_vec(journal)
            .map_err(|_| issue("unavailable", "Image migration journal cannot be encoded"))?,
    )
}
fn key(value: &Value) -> Result<Option<&str>> {
    let Some(value) = value.get("apiKey") else {
        return Ok(None);
    };
    let value = value
        .as_str()
        .ok_or_else(|| issue("invalid_request", "Legacy image API key must be text"))?
        .trim();
    if value.is_empty() {
        return Ok(None);
    }
    if value.len() > 4096 || value.chars().any(char::is_control) {
        return Err(issue("invalid_request", "Legacy image API key is invalid"));
    }
    Ok(Some(value))
}
fn plan(value: &Value, configuration: &Value, source_id: String) -> Result<Journal> {
    let revision = configuration["documentRevision"].as_u64().ok_or_else(|| {
        issue(
            "unsupported_service",
            "Image provider returned no configuration revision",
        )
    })?;
    let configured = revision > 0
        || !configuration["profiles"]
            .as_array()
            .ok_or_else(|| issue("unsupported_service", "Image provider returned no profiles"))?
            .is_empty()
        || !configuration["defaultConnectionId"].is_null();
    let legacy = !retired(value).as_object().expect("object").is_empty();
    let http =
        match value.get("backend") {
            None => false,
            Some(Value::String(backend)) if backend == "codex" => false,
            Some(Value::String(backend)) if backend == "api_key" => true,
            _ => return Err(issue(
                "invalid_request",
                "Unknown legacy image backend; configure an image connection before retiring it",
            )),
        };
    if value.get("codexPath").is_some_and(|path| !path.is_string()) {
        return Err(issue(
            "invalid_request",
            "Legacy Codex executable path must be text; source retained",
        ));
    }
    let source_digest = digest(value)?;
    let suffix = profile_suffix(&source_id, &source_digest);
    let http_id = format!("import-trace-openai-{suffix}");
    let codex_id = format!("import-trace-codex-{suffix}");
    let import_http = legacy && (http || value.get("apiKey").is_some());
    let import_codex = legacy && (!http || value.get("codexPath").is_some());
    let profile_id = (import_http && key(value)?.is_some()).then(|| http_id.clone());
    let secret_id = if profile_id.is_some() {
        let mut bytes = [0u8; 24];
        getrandom::fill(&mut bytes).map_err(|_| {
            issue(
                "unavailable",
                "Image migration could not allocate a credential reference",
            )
        })?;
        Some(hex::encode(bytes))
    } else {
        None
    };
    let mut profiles = vec![];
    if import_http {
        profiles.push(json!({"id":http_id,"name":"Imported OpenAI images","recipeRevision":"import-pending","transport":"openai-images","baseUrl":"https://api.openai.com/v1/images","defaultModel":"gpt-image-2","allowInsecureHttp":false,"credential":secret_id.as_ref().map(|id|json!({"kind":"secret","id":id})).unwrap_or_else(||json!({"kind":"environment","name":"OPENAI_API_KEY"}))}));
    }
    if import_codex {
        let path = value
            .get("codexPath")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        if path.len() > 4096 || path.contains('\0') {
            return Err(issue(
                "invalid_request",
                "Legacy Codex executable path is invalid",
            ));
        }
        profiles.push(json!({"id":codex_id,"name":"Imported Codex images","recipeRevision":"import-pending","transport":"codex-cli","executablePath":path,"modelSelection":false,"credential":{"kind":"cli_saved_login"}}));
    }
    let default_connection_id = legacy.then_some(if http { http_id } else { codex_id });
    Ok(Journal {
        version: 1,
        source_id,
        stage: Stage::Prepared,
        source_digest,
        retired_digest: digest(&retired(value))?,
        profile_id,
        secret_id,
        profiles,
        default_connection_id,
        skipped_existing: configured,
        receipt: None,
    })
}
fn valid_receipt(value: &Value, journal: &Journal) -> bool {
    value["version"] == 1
        && value["state"] == "imported"
        && value["sourceDigest"].as_str() == Some(&journal.source_digest)
        && value["profileIds"]
            == json!(journal
                .profiles
                .iter()
                .filter_map(|p| p["id"].as_str())
                .collect::<Vec<_>>())
}
fn verify_credential(root: &Path, journal: &Journal, secrets: &dyn SecretStore) -> Result<()> {
    let (Some(profile), Some(secret)) = (&journal.profile_id, &journal.secret_id) else {
        return Ok(());
    };
    let store = storage::Store::new(root.into());
    let value = {
        let _guard = store.lock()?;
        let value = source(root)?;
        let fields = retired(&value);
        if !fields.as_object().expect("object").is_empty()
            && digest(&fields)? != journal.retired_digest
        {
            return Err(issue(
                "configuration_changed",
                "Legacy image connection changed; source retained",
            ));
        }
        value
    };
    let owner = format!("plugin:{PROVIDER}:{profile}");
    let original = key(&value)?;
    match (secrets.get(&owner, secret)?, original) {
        (Some(existing), Some(expected)) if existing != expected => {
            return Err(issue(
                "operation_conflict",
                "Imported image credential changed; source retained",
            ))
        }
        (Some(_), _) => {}
        // Only Prepared may create the immutable slot. Later verification
        // must not resurrect a key explicitly cleared in provider settings.
        (None, _) => {
            return Err(issue(
                "not_configured",
                "Imported image credential is unavailable; retain migration evidence",
            ))
        }
    }
    let verified = secrets.get(&owner, secret)?;
    if verified
        .as_deref()
        .is_none_or(|value| original.is_some_and(|expected| value != expected))
    {
        return Err(issue(
            "not_configured",
            "Imported image credential could not be verified; source retained",
        ));
    }
    Ok(())
}
/// Only call after split Trace activation commits and the destination is active.
/// Idempotent destination status/import absorbs lost acknowledgements.
pub(crate) fn migrate(
    root: &Path,
    secrets: &dyn SecretStore,
    destination: &dyn Destination,
) -> Result<()> {
    // Independent summary/text migration completes before the shared codexPath retires.
    storage::migrate_summary(root)?;
    storage::Store::new(root.into()).read()?;
    let configuration = destination.call("settings.read", json!({}))?;
    let store = storage::Store::new(root.into());
    let mut journal = {
        let _guard = store.lock()?;
        let value = source(root)?;
        match read(root)? {
            Some(old)
                if old.stage == Stage::LegacyResumed
                    || old.stage == Stage::SourceRetired
                        && !retired(&value).as_object().expect("object").is_empty() =>
            {
                let mut nonce = [0u8; 16];
                getrandom::fill(&mut nonce).map_err(|_| {
                    issue(
                        "unavailable",
                        "Image rollback import identity could not be allocated",
                    )
                })?;
                let journal = plan(
                    &value,
                    &configuration,
                    format!("{IMPORT}.{}", hex::encode(nonce)),
                )?;
                // Explicit rollback opens a fresh epoch. Old in-flight saves
                // conflict on sourceId; provider historical receipts remain.
                storage::durable_write(
                    &root.join(MARKER),
                    &serde_json::to_vec(&journal).map_err(|_| {
                        issue("unavailable", "Image migration journal cannot be encoded")
                    })?,
                )?;
                journal
            }
            Some(journal) => journal,
            None => {
                let journal = plan(&value, &configuration, IMPORT.into())?;
                save(root, &journal)?;
                journal
            }
        }
    };
    let observed = destination.call("migration.status", json!({"sourceId":journal.source_id}))?;
    let imported = observed["state"] == "imported";
    if imported {
        if !valid_receipt(&observed, &journal) {
            return Err(issue(
                "operation_conflict",
                "Image import receipt conflicts with the migration journal",
            ));
        }
        if journal.stage == Stage::SourceRetired {
            return Ok(());
        }
        journal.receipt = Some(observed);
        journal.stage = Stage::DestinationCommitted;
        let _guard = store.lock()?;
        save(root, &journal)?;
    }
    if !imported
        && matches!(
            journal.stage,
            Stage::DestinationCommitted | Stage::SourceRetired
        )
    {
        // A destination rollback lost its receipt. Restore the same import;
        // never retire source based only on a host-side historical marker.
        journal.stage = Stage::CredentialReady;
    }
    if journal.stage == Stage::Prepared {
        if let (Some(id), Some(secret)) = (&journal.profile_id, &journal.secret_id) {
            let value = {
                let _guard = store.lock()?;
                let value = source(root)?;
                if digest(&retired(&value))? != journal.retired_digest {
                    return Err(issue("configuration_changed", "Legacy image connection changed before its import; retain source and migration journal"));
                }
                value
            };
            let value = key(&value)?.ok_or_else(|| {
                issue(
                    "not_configured",
                    "Legacy image API key disappeared before import",
                )
            })?;
            let owner = format!("plugin:{PROVIDER}:{id}");
            match secrets.get(&owner, secret)? {
                Some(existing) if existing != value => {
                    return Err(issue(
                        "operation_conflict",
                        "Image credential reference already has different content; source retained",
                    ))
                }
                Some(_) => {}
                None => secrets.put(&owner, secret, value)?,
            }
            if secrets.get(&owner, secret)?.as_deref() != Some(value) {
                return Err(issue(
                    "not_configured",
                    "Imported image credential could not be verified; source retained",
                ));
            }
        }
        journal.stage = Stage::CredentialReady;
        let _guard = store.lock()?;
        save(root, &journal)?;
    }
    if journal.stage == Stage::CredentialReady {
        verify_credential(root, &journal, secrets)?;
        let configuration = destination.call("settings.read", json!({}))?;
        let receipt=destination.call("migration.import",json!({"sourceId":journal.source_id,"sourceDigest":journal.source_digest,"expectedRevision":configuration["documentRevision"],"profiles":journal.profiles,"defaultConnectionId":journal.default_connection_id}))?;
        if !valid_receipt(&receipt, &journal) {
            return Err(issue(
                "unsupported_service",
                "Image provider returned an invalid import receipt; source retained",
            ));
        }
        journal.receipt = Some(receipt);
        journal.stage = Stage::DestinationCommitted;
        let _guard = store.lock()?;
        save(root, &journal)?;
    }
    if journal.stage == Stage::DestinationCommitted {
        // Recheck immediately before retiring the source, including recovery
        // from a lost import reply. Credential IO never holds config guards.
        verify_credential(root, &journal, secrets)?;
        let _guard = store.lock()?;
        let resolved = crate::config::resolve_write_target(&root.join(SOURCE)).map_err(|_| {
            issue(
                "unavailable",
                "Legacy image source target cannot be resolved",
            )
        })?;
        let mut value = storage::read_value(&resolved)?.unwrap_or_else(|| json!({}));
        if !value.is_object() {
            return Err(issue(
                "unavailable",
                "Legacy source settings must be an object",
            ));
        }
        let fields = retired(&value);
        if !fields.as_object().expect("object").is_empty()
            && digest(&fields)? != journal.retired_digest
        {
            return Err(issue(
                "configuration_changed",
                "Legacy image settings changed during cutover; source retained",
            ));
        }
        for field in RETIRED {
            value.as_object_mut().expect("object").remove(*field);
        }
        storage::durable_write(
            &resolved,
            &serde_json::to_vec_pretty(&value)
                .map_err(|_| issue("unavailable", "Legacy image preferences cannot be encoded"))?,
        )?;
        journal.stage = Stage::SourceRetired;
        save(root, &journal)?;
    }
    Ok(())
}
/// Native whole-blob fence survives stale settings windows and host restarts.
pub(crate) fn write_source(root: &Path, data: &str) -> Result<()> {
    let _lifecycle = crate::installed_plugins::read_lifecycle()
        .map_err(|_| issue("unavailable", "Image settings lifecycle is unavailable"))?;
    let mode = crate::installed_plugins::image_source_mode_at(root)
        .map_err(|_| issue("unavailable", "Image package state cannot be read"))?;
    write_source_policy(root, data, mode)
}
fn write_source_policy(root: &Path, data: &str, mode: u8) -> Result<()> {
    if data.len() > 256 * 1024 {
        return Err(issue(
            "invalid_request",
            "Image settings exceed their storage limit",
        ));
    }
    let mut incoming: Value = serde_json::from_str(data)
        .map_err(|_| issue("invalid_request", "Malformed image settings"))?;
    if !incoming.is_object() {
        return Err(issue(
            "invalid_request",
            "Image settings must be a JSON object",
        ));
    }
    let store = storage::Store::new(root.into());
    let _guard = store.lock()?;
    let journal = read(root)?;
    let resolved = crate::config::resolve_write_target(&root.join(SOURCE))
        .map_err(|_| issue("unavailable", "Image settings target cannot be resolved"))?;
    let current = storage::read_value(&resolved)?.unwrap_or_else(|| json!({}));
    if !current.is_object() {
        return Err(issue(
            "unavailable",
            "Legacy image source must be an object",
        ));
    }
    if mode == 1 {
        // An intentional committed legacy rollback needs working legacy image
        // settings. The next split activation imports a new immutable epoch.
        if let Some(mut journal) = journal {
            journal.stage = Stage::LegacyResumed;
            save(root, &journal)?;
        }
    } else if mode == 2 || journal.is_some() {
        let fields = retired(&incoming);
        let actual = retired(&current);
        if !fields.as_object().expect("object").is_empty() && fields != actual {
            return Err(issue(
                "configuration_changed",
                "Image connections moved to Image Generation; reload these settings before saving",
            ));
        }
        if journal
            .as_ref()
            .is_some_and(|j| j.stage == Stage::SourceRetired)
            && !fields.as_object().expect("object").is_empty()
        {
            return Err(issue(
                "configuration_changed",
                "Retired image connection fields cannot be restored",
            ));
        }
        // Preference saves cannot erase the only plaintext key while native
        // import is pending. Only the coordinator retires these fields.
        for (key, value) in actual.as_object().expect("object") {
            incoming
                .as_object_mut()
                .expect("object")
                .insert(key.clone(), value.clone());
        }
    }
    storage::durable_write(
        &resolved,
        &serde_json::to_vec_pretty(&incoming)
            .map_err(|_| issue("unavailable", "Image settings cannot be encoded"))?,
    )
}

pub(crate) fn status(root: &Path) -> Result<Value> {
    let store = storage::Store::new(root.into());
    let _guard = store.lock()?;
    Ok(match read(root)? {
        None => json!({"state":"absent"}),
        Some(j) if j.stage == Stage::SourceRetired => json!({"state":"complete"}),
        Some(_) => {
            json!({"state":"pending","error":"Image connection import is pending; original settings are retained. Unlock credential storage or open Image Generation connections."})
        }
    })
}

#[cfg(test)]
mod tests {
    use super::super::credentials::MemorySecrets;
    use super::*;
    use std::{
        fs,
        sync::{
            atomic::{AtomicBool, Ordering},
            Mutex,
        },
    };
    struct Provider {
        configuration: Mutex<Value>,
        receipts: Mutex<std::collections::HashMap<String, Value>>,
        lose_reply: AtomicBool,
        imports: Mutex<Vec<Value>>,
    }
    impl Provider {
        fn new() -> Self {
            Self {
                configuration: Mutex::new(
                    json!({"documentRevision":0,"profiles":[],"defaultConnectionId":null}),
                ),
                receipts: Mutex::new(Default::default()),
                lose_reply: AtomicBool::new(false),
                imports: Mutex::new(vec![]),
            }
        }
    }
    impl Destination for Provider {
        fn call(&self, method: &str, params: Value) -> Result<Value> {
            match method {
                "settings.read" => Ok(self.configuration.lock().unwrap().clone()),
                "migration.status" => Ok(self
                    .receipts
                    .lock()
                    .unwrap()
                    .get(params["sourceId"].as_str().unwrap())
                    .cloned()
                    .unwrap_or_else(|| json!({"state":"absent"}))),
                "migration.import" => {
                    let mut receipts = self.receipts.lock().unwrap();
                    let source_id = params["sourceId"].as_str().unwrap().to_owned();
                    if let Some(receipt) = receipts.get(&source_id) {
                        return Ok(receipt.clone());
                    }
                    let mut configuration = self.configuration.lock().unwrap();
                    if configuration["documentRevision"] != params["expectedRevision"] {
                        return Err(issue("configuration_changed", "fixture CAS conflict"));
                    }
                    self.imports.lock().unwrap().push(params.clone());
                    let copy_default = configuration["documentRevision"] == 0
                        && configuration["profiles"].as_array().unwrap().is_empty()
                        && configuration["defaultConnectionId"].is_null();
                    configuration["profiles"]
                        .as_array_mut()
                        .unwrap()
                        .extend(params["profiles"].as_array().unwrap().iter().cloned());
                    if copy_default {
                        configuration["defaultConnectionId"] =
                            params["defaultConnectionId"].clone();
                    }
                    configuration["documentRevision"] =
                        json!(configuration["documentRevision"].as_u64().unwrap() + 1);
                    let receipt = json!({"version":1,"state":"imported","sourceDigest":params["sourceDigest"],"profileIds":params["profiles"].as_array().unwrap().iter().map(|p|p["id"].clone()).collect::<Vec<_>>()});
                    receipts.insert(source_id, receipt.clone());
                    if self.lose_reply.swap(false, Ordering::SeqCst) {
                        return Err(issue("timed_out", "fixture lost committed import reply"));
                    }
                    Ok(receipt)
                }
                _ => Err(issue("method_not_found", "fixture method")),
            }
        }
    }
    fn setup(value: Value) -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();
        fs::write(
            root.path().join(SOURCE),
            serde_json::to_vec(&value).unwrap(),
        )
        .unwrap();
        root
    }
    #[test]
    fn lost_import_reply_reuses_verified_secret_and_scrubs_only_after_receipt() {
        let root = setup(
            json!({"backend":"api_key","apiKey":"fixture-plaintext","codexPath":"/fixture/codex","titleGenerator":"disabled","quality":"high","batchCount":3}),
        );
        let provider = Provider::new();
        provider.lose_reply.store(true, Ordering::SeqCst);
        let secrets = MemorySecrets::default();
        assert_eq!(
            migrate(root.path(), &secrets, &provider).unwrap_err().code,
            "timed_out"
        );
        assert_eq!(source(root.path()).unwrap()["apiKey"], "fixture-plaintext");
        let raw = fs::read_to_string(root.path().join(MARKER)).unwrap();
        assert!(!raw.contains("fixture-plaintext"));
        let journal = read(root.path()).unwrap().unwrap();
        let owner = format!("plugin:{PROVIDER}:{}", journal.profile_id.unwrap());
        assert_eq!(
            secrets
                .get(&owner, journal.secret_id.as_ref().unwrap())
                .unwrap()
                .as_deref(),
            Some("fixture-plaintext")
        );
        migrate(root.path(), &secrets, &provider).unwrap();
        migrate(root.path(), &secrets, &provider).unwrap();
        assert_eq!(provider.imports.lock().unwrap().len(), 1);
        assert_eq!(
            source(root.path()).unwrap(),
            json!({"quality":"high","batchCount":3})
        );
        let trace: Value =
            serde_json::from_slice(&fs::read(root.path().join("plugin.trace.json")).unwrap())
                .unwrap();
        assert_eq!(trace["summarizePrompts"], false);
        assert_eq!(
            read(root.path()).unwrap().unwrap().stage,
            Stage::SourceRetired
        );
    }
    struct Locked;
    impl SecretStore for Locked {
        fn get(&self, _: &str, _: &str) -> Result<Option<String>> {
            Err(issue("not_configured", "fixture locked store"))
        }
        fn put(&self, _: &str, _: &str, _: &str) -> Result<()> {
            panic!("no mutation while locked")
        }
        fn remove(&self, _: &str, _: &str) -> Result<()> {
            panic!("no deletion")
        }
    }
    #[test]
    fn locked_credentials_preserve_source_and_fence_only_connection_changes() {
        let original = json!({"backend":"api_key","apiKey":"fixture-key","quality":"high"});
        let root = setup(original.clone());
        let provider = Provider::new();
        assert_eq!(
            migrate(root.path(), &Locked, &provider).unwrap_err().code,
            "not_configured"
        );
        assert_eq!(source(root.path()).unwrap(), original);
        assert!(provider.imports.lock().unwrap().is_empty());
        write_source(
            root.path(),
            r#"{"backend":"api_key","apiKey":"fixture-key","quality":"low"}"#,
        )
        .unwrap();
        assert_eq!(
            write_source(root.path(), r#"{"backend":"codex","apiKey":"fixture-key"}"#)
                .unwrap_err()
                .code,
            "configuration_changed"
        );
        migrate(root.path(), &MemorySecrets::default(), &provider).unwrap();
        assert_eq!(source(root.path()).unwrap(), json!({"quality":"low"}));
    }
    #[test]
    fn stale_whole_blob_cannot_restore_plaintext_after_restart() {
        let stale = json!({"backend":"api_key","apiKey":"fixture-key","quality":"high"});
        let root = setup(stale.clone());
        let provider = Provider::new();
        migrate(root.path(), &MemorySecrets::default(), &provider).unwrap();
        let mut stale = stale;
        stale["quality"] = json!("low");
        assert_eq!(
            write_source(root.path(), &stale.to_string())
                .unwrap_err()
                .code,
            "configuration_changed"
        );
        assert_eq!(source(root.path()).unwrap(), json!({"quality":"high"}));
        write_source(root.path(), r#"{"quality":"low"}"#).unwrap();
        assert_eq!(source(root.path()).unwrap(), json!({"quality":"low"}));
    }
    #[test]
    fn existing_destination_wins_and_blank_key_imports_environment_identity() {
        let root = setup(json!({"backend":"api_key","apiKey":""}));
        let provider = Provider::new();
        migrate(root.path(), &Locked, &provider).unwrap();
        assert_eq!(
            provider.imports.lock().unwrap()[0]["profiles"][0]["credential"],
            json!({"kind":"environment","name":"OPENAI_API_KEY"})
        );
        let root = setup(json!({"backend":"api_key","apiKey":"old-key"}));
        let provider = Provider::new();
        *provider.configuration.lock().unwrap() = json!({"documentRevision":8,"profiles":[{"id":"explicit"}],"defaultConnectionId":"explicit"});
        migrate(root.path(), &MemorySecrets::default(), &provider).unwrap();
        assert_eq!(
            provider.configuration.lock().unwrap()["defaultConnectionId"],
            "explicit"
        );
        assert_eq!(
            provider.configuration.lock().unwrap()["profiles"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert!(read(root.path()).unwrap().unwrap().skipped_existing);
    }
    #[test]
    fn no_cutover_marker_means_legacy_source_remains_writable() {
        let root = setup(json!({}));
        write_source(
            root.path(),
            r#"{"backend":"api_key","apiKey":"legacy-key"}"#,
        )
        .unwrap();
        assert!(!root.path().join(MARKER).exists());
        assert_eq!(source(root.path()).unwrap()["apiKey"], "legacy-key");
    }
    #[test]
    fn split_preference_save_preserves_unimported_connection_and_rejects_new_plaintext() {
        let root = setup(json!({"backend":"api_key","apiKey":"legacy-key","quality":"high"}));
        write_source_policy(root.path(), r#"{"quality":"low"}"#, 2).unwrap();
        assert_eq!(
            source(root.path()).unwrap(),
            json!({"backend":"api_key","apiKey":"legacy-key","quality":"low"})
        );
        assert_eq!(
            write_source_policy(root.path(), r#"{"apiKey":"new-key"}"#, 2)
                .unwrap_err()
                .code,
            "configuration_changed"
        );
        assert!(!root.path().join(MARKER).exists());
    }
    #[test]
    fn committed_legacy_rollback_imports_a_new_epoch_and_keeps_the_existing_default() {
        let root = setup(json!({"backend":"api_key","apiKey":"first-key"}));
        let secrets = MemorySecrets::default();
        let provider = Provider::new();
        migrate(root.path(), &secrets, &provider).unwrap();
        let first = read(root.path()).unwrap().unwrap();
        let default = provider.configuration.lock().unwrap()["defaultConnectionId"].clone();
        write_source_policy(
            root.path(),
            r#"{"backend":"api_key","apiKey":"second-key","quality":"high"}"#,
            1,
        )
        .unwrap();
        assert_eq!(
            read(root.path()).unwrap().unwrap().stage,
            Stage::LegacyResumed
        );
        migrate(root.path(), &secrets, &provider).unwrap();
        migrate(root.path(), &secrets, &provider).unwrap();
        let second = read(root.path()).unwrap().unwrap();
        assert_ne!(first.source_id, second.source_id);
        assert_ne!(first.profile_id, second.profile_id);
        assert_eq!(provider.imports.lock().unwrap().len(), 2);
        assert_eq!(provider.receipts.lock().unwrap().len(), 2);
        assert_eq!(
            provider.configuration.lock().unwrap()["defaultConnectionId"],
            default
        );
        assert_eq!(source(root.path()).unwrap(), json!({"quality":"high"}));
        for (journal, value) in [(&first, "first-key"), (&second, "second-key")] {
            assert_eq!(
                secrets
                    .get(
                        &format!("plugin:{PROVIDER}:{}", journal.profile_id.as_ref().unwrap()),
                        journal.secret_id.as_ref().unwrap()
                    )
                    .unwrap()
                    .as_deref(),
                Some(value)
            );
        }
    }
    #[test]
    fn codex_default_preserves_saved_http_key_as_an_independent_connection() {
        let root = setup(
            json!({"backend":"codex","apiKey":"  saved-http-key  ","codexPath":" /fixture/codex "}),
        );
        let secrets = MemorySecrets::default();
        let provider = Provider::new();
        migrate(root.path(), &secrets, &provider).unwrap();
        let configuration = provider.configuration.lock().unwrap();
        let profiles = configuration["profiles"].as_array().unwrap();
        assert_eq!(profiles.len(), 2);
        let codex = profiles
            .iter()
            .find(|p| p["transport"] == "codex-cli")
            .unwrap();
        assert_eq!(codex["executablePath"], "/fixture/codex");
        assert_eq!(configuration["defaultConnectionId"], codex["id"]);
        let journal = read(root.path()).unwrap().unwrap();
        assert_eq!(
            secrets
                .get(
                    &format!("plugin:{PROVIDER}:{}", journal.profile_id.unwrap()),
                    journal.secret_id.as_ref().unwrap()
                )
                .unwrap()
                .as_deref(),
            Some("saved-http-key")
        );
    }
    #[test]
    fn lost_import_reply_rechecks_credentials_before_source_retirement() {
        let root = setup(json!({"backend":"api_key","apiKey":"fixture-key"}));
        let secrets = MemorySecrets::default();
        let provider = Provider::new();
        provider.lose_reply.store(true, Ordering::SeqCst);
        assert!(migrate(root.path(), &secrets, &provider).is_err());
        assert_eq!(
            migrate(root.path(), &Locked, &provider).unwrap_err().code,
            "not_configured"
        );
        assert_eq!(source(root.path()).unwrap()["apiKey"], "fixture-key");
        assert_eq!(provider.imports.lock().unwrap().len(), 1);
        migrate(root.path(), &secrets, &provider).unwrap();
        assert_eq!(source(root.path()).unwrap(), json!({}));
    }
    #[test]
    fn deleting_an_imported_profile_after_lost_ack_does_not_resurrect_its_secret() {
        let root = setup(json!({"backend":"api_key","apiKey":"fixture-key"}));
        let secrets = MemorySecrets::default();
        let provider = Provider::new();
        provider.lose_reply.store(true, Ordering::SeqCst);
        assert!(migrate(root.path(), &secrets, &provider).is_err());
        let journal = read(root.path()).unwrap().unwrap();
        let owner = format!("plugin:{PROVIDER}:{}", journal.profile_id.unwrap());
        let secret = journal.secret_id.unwrap();
        provider.configuration.lock().unwrap()["profiles"] = json!([]);
        provider.configuration.lock().unwrap()["defaultConnectionId"] = Value::Null;
        secrets.remove(&owner, &secret).unwrap();
        assert_eq!(
            migrate(root.path(), &secrets, &provider).unwrap_err().code,
            "not_configured"
        );
        assert_eq!(secrets.get(&owner, &secret).unwrap(), None);
        assert_eq!(source(root.path()).unwrap()["apiKey"], "fixture-key");
        assert_eq!(provider.imports.lock().unwrap().len(), 1);
    }
    #[test]
    fn missing_destination_receipt_restores_original_import_without_creating_a_new_epoch() {
        let root = setup(json!({"backend":"api_key","apiKey":"fixture-key"}));
        let secrets = MemorySecrets::default();
        let provider = Provider::new();
        migrate(root.path(), &secrets, &provider).unwrap();
        let original = read(root.path()).unwrap().unwrap();
        provider.receipts.lock().unwrap().clear();
        *provider.configuration.lock().unwrap() =
            json!({"documentRevision":0,"profiles":[],"defaultConnectionId":null});
        migrate(root.path(), &secrets, &provider).unwrap();
        let restored = read(root.path()).unwrap().unwrap();
        assert_eq!(original.source_id, restored.source_id);
        assert_eq!(original.secret_id, restored.secret_id);
        assert_eq!(provider.imports.lock().unwrap().len(), 2);
        assert_eq!(source(root.path()).unwrap(), json!({}));
    }
    #[test]
    fn malformed_connections_and_oversized_keys_remain_at_the_source_without_import() {
        for value in [
            json!({"backend":null}),
            json!({"backend":42}),
            json!({"backend":"codex","codexPath":null}),
            json!({"backend":"api_key","apiKey":"k".repeat(4097)}),
        ] {
            let root = setup(value.clone());
            let provider = Provider::new();
            assert_eq!(
                migrate(root.path(), &MemorySecrets::default(), &provider)
                    .unwrap_err()
                    .code,
                "invalid_request"
            );
            assert_eq!(source(root.path()).unwrap(), value);
            assert!(provider.imports.lock().unwrap().is_empty());
        }
        let root = setup(json!({"backend":"api_key","apiKey":"k".repeat(4096)}));
        let provider = Provider::new();
        migrate(root.path(), &MemorySecrets::default(), &provider).unwrap();
        assert_eq!(provider.imports.lock().unwrap().len(), 1);
        assert_eq!(source(root.path()).unwrap(), json!({}));
    }
    #[cfg(unix)]
    #[test]
    fn ordinary_legacy_symlink_is_preserved_and_private_marker_symlink_refused() {
        let root = tempfile::tempdir().unwrap();
        let external = tempfile::tempdir().unwrap();
        let target = external.path().join("image.json");
        fs::write(
            &target,
            r#"{"backend":"codex","codexPath":"","quality":"high"}"#,
        )
        .unwrap();
        std::os::unix::fs::symlink(&target, root.path().join(SOURCE)).unwrap();
        migrate(root.path(), &Locked, &Provider::new()).unwrap();
        assert!(fs::symlink_metadata(root.path().join(SOURCE))
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(
            serde_json::from_slice::<Value>(&fs::read(target).unwrap()).unwrap(),
            json!({"quality":"high"})
        );
        fs::remove_file(root.path().join(MARKER)).unwrap();
        std::os::unix::fs::symlink(external.path().join("marker"), root.path().join(MARKER))
            .unwrap();
        assert!(write_source(root.path(), "{}").is_err());
    }
}
