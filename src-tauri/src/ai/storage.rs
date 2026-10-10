//! Cross-process serialized CAS and durable configuration replacement.
//! Unix syncs containing directories. Windows uses MoveFileExW WRITE_THROUGH;
//! filesystem/device guarantees still depend on the OS and underlying volume.
use super::credentials::{self, SecretStore};
use super::domain::*;
use serde_json::{json, Value};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};
const MAX_CONFIG: usize = 256 * 1024;
pub struct Store {
    pub root: PathBuf,
    #[cfg(test)]
    pub fail_next_commit_after_replace: std::sync::atomic::AtomicBool,
}
pub struct Guard {
    _file: File,
}
fn storage_error() -> ServiceError {
    ServiceError::new(
        "unavailable",
        "AI configuration storage cannot be read or durably written",
    )
}
fn regular(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(m) if !m.is_file() => Err(ServiceError::new(
            "unavailable",
            "AI service files must be regular files, without symlinks",
        )),
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(storage_error()),
    }
}
impl Store {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            #[cfg(test)]
            fail_next_commit_after_replace: std::sync::atomic::AtomicBool::new(false),
        }
    }
    pub fn lock(&self) -> Result<Guard> {
        let path = self.root.join(".ai-connections.lock");
        regular(&path)?;
        let mut options = OpenOptions::new();
        options.create(true).truncate(false).read(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_NOCTTY);
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.custom_flags(0x0020_0000); // FILE_FLAG_OPEN_REPARSE_POINT
        }
        let file = options.open(path).map_err(|_| storage_error())?;
        let metadata = file.metadata().map_err(|_| storage_error())?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(storage_error());
        }
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        loop {
            match file.try_lock() {
                Ok(()) => break,
                Err(std::fs::TryLockError::WouldBlock) if std::time::Instant::now() < deadline => {
                    std::thread::sleep(std::time::Duration::from_millis(10))
                }
                Err(_) => return Err(storage_error()),
            }
        }
        Ok(Guard { _file: file })
    }
    pub fn read_locked(&self) -> Result<Configuration> {
        let path = self.root.join("ai-connections.json");
        regular(&path)?;
        let Some(value) = read_private_value(&path)? else {
            let legacy = read_value(&self.root.join("plugin.openai-image.json"))?;
            let mut defaults = Configuration::default();
            if let Some(path) = legacy
                .as_ref()
                .and_then(|v| v.get("titleCodexPath"))
                .and_then(Value::as_str)
                .filter(|p| !p.trim().is_empty())
                .or_else(|| {
                    legacy
                        .as_ref()
                        .and_then(|v| v.get("codexPath"))
                        .and_then(Value::as_str)
                        .filter(|p| !p.trim().is_empty())
                })
            {
                defaults.profiles[0].connection = Connection::Codex {
                    executable_path: path.trim().to_owned(),
                };
            }
            validate_configuration(&mut defaults)?;
            // The durable destination is the migration commit. A pending marker
            // is informational; retries always re-read the destination first.
            durable_write(
                &self.root.join(".ai-text-migration.json"),
                b"{\"version\":1,\"state\":\"pending\"}",
            )?;
            durable_write(
                &path,
                &serde_json::to_vec_pretty(&defaults).map_err(|_| storage_error())?,
            )?;
            durable_write(
                &self.root.join(".ai-text-migration.json"),
                b"{\"version\":1,\"state\":\"complete\"}",
            )?;
            return Ok(defaults);
        };
        if value.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
            return Err(ServiceError::new(
                "unavailable",
                "Unsupported AI configuration schema; update the host or restore this file",
            ));
        }
        let mut config = parse_configuration(value).map_err(|_| {
            ServiceError::new(
                "unavailable",
                "AI configuration is malformed; repair ai-connections.json",
            )
        })?;
        validate_configuration(&mut config).map_err(|_| {
            ServiceError::new(
                "unavailable",
                "AI configuration is invalid; repair ai-connections.json",
            )
        })?;
        let marker = self.root.join(".ai-text-migration.json");
        regular(&marker)?;
        if read_private_value(&marker)?
            .as_ref()
            .and_then(|v| v.get("state"))
            .and_then(Value::as_str)
            == Some("pending")
        {
            durable_write(&marker, b"{\"version\":1,\"state\":\"complete\"}")?;
        }
        Ok(config)
    }
    pub fn read(&self) -> Result<Configuration> {
        let _guard = self.lock()?;
        self.read_locked()
    }
    #[cfg(test)]
    pub fn save(&self, config: Configuration, expected: u64) -> Result<Configuration> {
        self.save_with_secrets(config, expected, None)
    }
    pub fn save_with_secrets(
        &self,
        mut config: Configuration,
        expected: u64,
        secrets: Option<&dyn SecretStore>,
    ) -> Result<Configuration> {
        validate_configuration(&mut config)?;
        let _guard = self.lock()?;
        let old = self.read_locked()?;
        check_revision(&old, expected)?;
        // Public saves cannot forge a secret association or steal another profile's record.
        for p in &config.profiles {
            if let Some(Credential::Secret { id }) = p.connection.credential() {
                if !old.profiles.iter().any(|o| {
                    o.id == p.id
                        && o.connection.credential() == Some(&Credential::Secret { id: id.clone() })
                }) {
                    return Err(ServiceError::invalid(
                        "Save credentials through the write-only credential command",
                    ));
                }
            }
        }
        let committed = self.commit(config, old.revision)?;
        if let Some(secrets) = secrets {
            for profile in old.profiles {
                if let Some(Credential::Secret { id }) = profile.connection.credential() {
                    if !committed.profiles.iter().any(|p| {
                        p.id == profile.id
                            && p.connection.credential() == profile.connection.credential()
                    }) {
                        let _ = secrets.remove(&profile.id, id);
                    }
                }
            }
        }
        Ok(committed)
    }
    fn commit(&self, mut config: Configuration, revision: u64) -> Result<Configuration> {
        config.revision = revision
            .checked_add(1)
            .filter(|n| *n <= 9_007_199_254_740_991)
            .ok_or_else(storage_error)?;
        #[cfg(test)]
        let fail_after_replace = self
            .fail_next_commit_after_replace
            .swap(false, std::sync::atomic::Ordering::Relaxed);
        #[cfg(not(test))]
        let fail_after_replace = false;
        durable_write_impl(
            &self.root.join("ai-connections.json"),
            &serde_json::to_vec_pretty(&config).map_err(|_| storage_error())?,
            fail_after_replace,
        )?;
        Ok(config)
    }
    pub fn credential(
        &self,
        id: &str,
        key: Option<&str>,
        expected: u64,
        secrets: &dyn SecretStore,
    ) -> Result<Configuration> {
        if key.is_some_and(|s| s.is_empty() || s.len() > 8192 || s.chars().any(char::is_control)) {
            return Err(ServiceError::invalid(
                "API key must contain 1–8192 characters without control characters",
            ));
        }
        let _guard = self.lock()?;
        let mut config = self.read_locked()?;
        check_revision(&config, expected)?;
        let p = config
            .profiles
            .iter_mut()
            .find(|p| p.id == id)
            .ok_or_else(|| ServiceError::invalid("Unknown profile"))?;
        let old = p
            .connection
            .credential()
            .cloned()
            .ok_or_else(|| ServiceError::invalid("CLI login is managed by the CLI"))?;
        let new = if let Some(key) = key {
            let mut bytes = [0u8; 16];
            getrandom::fill(&mut bytes).map_err(|_| storage_error())?;
            let secret_id = hex::encode(bytes);
            secrets.put(id, &secret_id, key)?;
            if secrets.get(id, &secret_id).ok().flatten().as_deref() != Some(key) {
                let _ = secrets.remove(id, &secret_id);
                return Err(ServiceError::new(
                    "not_configured",
                    "OS credential verification failed",
                ));
            }
            Credential::Secret { id: secret_id }
        } else {
            Credential::None
        };
        *p.connection.credential_mut().expect("HTTP credential") = new.clone();
        let revision = config.revision;
        match self.commit(config, revision) {
            Ok(config) => {
                // Generation snapshots resolve credentials under this lock before release.
                if let Credential::Secret { id: old_id } = old {
                    let _ = secrets.remove(id, &old_id);
                }
                Ok(config)
            }
            Err(e) => {
                if let Credential::Secret { id: new_id } = new {
                    // Replacement may have committed before directory sync failed. Retain
                    // the record unless a readable durable document proves it unreferenced.
                    if let Ok(observed) = self.read_locked() {
                        if !observed.profiles.iter().any(|p| {
                            p.id == id
                                && p.connection.credential()
                                    == Some(&Credential::Secret { id: new_id.clone() })
                        }) {
                            let _ = secrets.remove(id, &new_id);
                        }
                    }
                }
                Err(e)
            }
        }
    }
    pub fn snapshot(
        &self,
        secrets: &dyn SecretStore,
        expected: Option<u64>,
    ) -> Result<(Profile, u64, Option<String>)> {
        let _guard = self.lock()?;
        let config = self.read_locked()?;
        if let Some(expected) = expected {
            check_revision(&config, expected)?;
        }
        if !config.enabled {
            return Err(ServiceError::new("disabled", "Text generation is disabled"));
        }
        let profile = config
            .profiles
            .into_iter()
            .find(|p| Some(&p.id) == config.default_profile_id.as_ref())
            .ok_or_else(|| ServiceError::new("not_configured", "Select a default text profile"))?;
        let credential = credentials::resolve(&profile, secrets)?;
        Ok((profile, config.revision, credential))
    }
    pub fn sanitized(&self, config: Configuration, secrets: &dyn SecretStore) -> Value {
        let mut value = serde_json::to_value(&config).expect("serializable configuration");
        for (profile, v) in config
            .profiles
            .iter()
            .zip(value["profiles"].as_array_mut().unwrap())
        {
            if profile.connection.credential().is_some() {
                v["hasCredential"] = json!(credentials::resolve(profile, secrets)
                    .ok()
                    .flatten()
                    .is_some());
            }
        }
        value
    }
}
pub fn check_revision(config: &Configuration, expected: u64) -> Result<()> {
    if config.revision == expected {
        Ok(())
    } else {
        Err(ServiceError::new(
            "configuration_changed",
            "Text configuration changed; reload and try again",
        ))
    }
}
pub(super) fn read_value(path: &Path) -> Result<Option<Value>> {
    read_value_with_policy(path, false)
}
pub(super) fn read_private_value(path: &Path) -> Result<Option<Value>> {
    read_value_with_policy(path, true)
}
fn read_value_with_policy(path: &Path, private: bool) -> Result<Option<Value>> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(
            libc::O_NONBLOCK | libc::O_NOCTTY | if private { libc::O_NOFOLLOW } else { 0 },
        );
    }
    if private {
        regular(path)?;
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.custom_flags(0x0020_0000);
        }
    }
    let file = match options.open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(storage_error()),
    };
    let metadata = file.metadata().map_err(|_| storage_error())?;
    if !metadata.is_file() || private && metadata.file_type().is_symlink() {
        return Err(storage_error());
    }
    let mut bytes = Vec::new();
    file.take((MAX_CONFIG + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| storage_error())?;
    if bytes.len() > MAX_CONFIG {
        return Err(ServiceError::new(
            "unavailable",
            "AI configuration exceeds its storage limit",
        ));
    }
    serde_json::from_slice(&bytes).map(Some).map_err(|_| {
        ServiceError::new(
            "unavailable",
            "Configuration JSON is malformed; repair the existing file",
        )
    })
}
pub fn durable_write(path: &Path, bytes: &[u8]) -> Result<()> {
    durable_write_impl(path, bytes, false)
}
fn durable_write_impl(path: &Path, bytes: &[u8], fail_after_replace: bool) -> Result<()> {
    if bytes.len() > MAX_CONFIG {
        return Err(ServiceError::invalid("Configuration is too large"));
    }
    let parent = path.parent().ok_or_else(storage_error)?;
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|_| storage_error())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        temp.as_file()
            .set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|_| storage_error())?;
    }
    temp.write_all(bytes)
        .and_then(|_| temp.as_file().sync_all())
        .map_err(|_| storage_error())?;
    #[cfg(not(windows))]
    {
        temp.persist(path).map_err(|_| storage_error())?;
        if fail_after_replace {
            return Err(storage_error());
        }
        File::open(parent)
            .and_then(|f| f.sync_all())
            .map_err(|_| storage_error())?;
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows::Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        };
        let from: Vec<u16> = temp
            .path()
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect();
        let to: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        unsafe {
            MoveFileExW(
                windows_core::PCWSTR(from.as_ptr()),
                windows_core::PCWSTR(to.as_ptr()),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        }
        .map_err(|_| storage_error())?;
        if fail_after_replace {
            return Err(storage_error());
        }
    }
    Ok(())
}
pub fn migrate_summary(root: &Path) -> Result<()> {
    let store = Store::new(root.into());
    let _guard = store.lock()?;
    migrate_summary_locked(root)
}
fn migrate_summary_locked(root: &Path) -> Result<()> {
    let marker = root.join(".ai-trace-summary-migration.json");
    regular(&marker)?;
    if read_private_value(&marker)?
        .as_ref()
        .and_then(|v| v.get("state"))
        .and_then(Value::as_str)
        == Some("complete")
    {
        return Ok(());
    }
    let target = root.join("plugin.trace.json");
    let resolved = crate::config::resolve_write_target(&target).map_err(|_| storage_error())?;
    let mut trace = read_value(&resolved)?.unwrap_or_else(|| json!({}));
    if !trace.is_object() {
        return Err(ServiceError::new(
            "unavailable",
            "Trace settings must be an object",
        ));
    }
    if trace.get("summarizePrompts").is_some() {
        return durable_write(&marker, b"{\"version\":1,\"state\":\"complete\"}");
    }
    let legacy = read_value(&root.join("plugin.openai-image.json"))?;
    if legacy
        .as_ref()
        .and_then(|v| v.get("titleGenerator"))
        .and_then(Value::as_str)
        != Some("disabled")
    {
        return Ok(());
    }
    durable_write(&marker, b"{\"version\":1,\"state\":\"pending\"}")?;
    trace["summarizePrompts"] = json!(false);
    durable_write(
        &resolved,
        &serde_json::to_vec_pretty(&trace).map_err(|_| storage_error())?,
    )?;
    durable_write(&marker, b"{\"version\":1,\"state\":\"complete\"}")
}
pub fn write_trace_config(root: &Path, data: &str) -> Result<()> {
    if data.len() > MAX_CONFIG {
        return Err(ServiceError::invalid("Trace configuration is too large"));
    }
    let store = Store::new(root.into());
    let _guard = store.lock()?;
    migrate_summary_locked(root)?;
    let target = root.join("plugin.trace.json");
    let resolved = crate::config::resolve_write_target(&target).map_err(|_| storage_error())?;
    let mut incoming: Value = serde_json::from_str(data)
        .map_err(|_| ServiceError::invalid("Malformed Trace configuration"))?;
    if !incoming.is_object() {
        return Err(ServiceError::invalid(
            "Trace configuration must be an object",
        ));
    }
    if incoming.get("summarizePrompts").is_none() {
        if let Some(summary) =
            read_value(&resolved)?.and_then(|v| v.get("summarizePrompts").cloned())
        {
            incoming["summarizePrompts"] = summary;
        }
    }
    durable_write(
        &resolved,
        &serde_json::to_vec_pretty(&incoming).map_err(|_| storage_error())?,
    )
}
