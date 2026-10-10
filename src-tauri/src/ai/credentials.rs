//! OS credentials never cross the native service boundary. Each immutable
//! record belongs to one profile; old admissions own their resolved bytes.
use super::domain::{Credential, Profile, Result, ServiceError};
pub trait SecretStore: Send + Sync {
    fn get(&self, owner: &str, id: &str) -> Result<Option<String>>;
    fn put(&self, owner: &str, id: &str, value: &str) -> Result<()>;
    fn remove(&self, owner: &str, id: &str) -> Result<()>;
}
pub struct OsSecrets;
fn unavailable() -> ServiceError {
    ServiceError::new("not_configured","OS credential storage is unavailable or locked; unlock it or select an environment variable")
}
#[cfg(not(target_os = "linux"))]
impl OsSecrets {
    fn entry(owner: &str, id: &str) -> Result<keyring::Entry> {
        keyring::Entry::new("tauri-explorer.text.v1", &format!("{owner}:{id}"))
            .map_err(|_| unavailable())
    }
}
#[cfg(not(target_os = "linux"))]
impl SecretStore for OsSecrets {
    fn get(&self, owner: &str, id: &str) -> Result<Option<String>> {
        let _guard = interaction_guard()?;
        match Self::entry(owner, id)?.get_password() {
            Ok(s) => Ok(Some(s)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(unavailable()),
        }
    }
    fn put(&self, owner: &str, id: &str, value: &str) -> Result<()> {
        let _guard = interaction_guard()?;
        Self::entry(owner, id)?
            .set_password(value)
            .map_err(|_| unavailable())
    }
    fn remove(&self, owner: &str, id: &str) -> Result<()> {
        let _guard = interaction_guard()?;
        match Self::entry(owner, id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(unavailable()),
        }
    }
}
pub fn resolve(profile: &Profile, store: &dyn SecretStore) -> Result<Option<String>> {
    let value = match profile.connection.credential() {
        Some(Credential::Secret { id }) => store
            .get(&profile.id, id)?
            .ok_or_else(|| {
                ServiceError::new("authentication_failed", "Saved API credential is missing")
            })
            .map(Some)?,
        Some(Credential::Environment { name }) => Some(std::env::var(name).map_err(|_| {
            ServiceError::new(
                "authentication_failed",
                "Credential environment variable is missing",
            )
        })?),
        _ => None,
    };
    if value
        .as_ref()
        .is_some_and(|s| s.is_empty() || s.len() > 8192 || s.chars().any(char::is_control))
    {
        return Err(ServiceError::new(
            "authentication_failed",
            "API credential is empty or invalid",
        ));
    }
    Ok(value)
}
#[cfg(test)]
#[derive(Default)]
pub struct MemorySecrets(std::sync::Mutex<std::collections::HashMap<(String, String), String>>);
#[cfg(test)]
impl SecretStore for MemorySecrets {
    fn get(&self, o: &str, i: &str) -> Result<Option<String>> {
        Ok(self.0.lock().unwrap().get(&(o.into(), i.into())).cloned())
    }
    fn put(&self, o: &str, i: &str, s: &str) -> Result<()> {
        self.0
            .lock()
            .unwrap()
            .insert((o.into(), i.into()), s.into());
        Ok(())
    }
    fn remove(&self, o: &str, i: &str) -> Result<()> {
        self.0.lock().unwrap().remove(&(o.into(), i.into()));
        Ok(())
    }
}

/// Windows Credential Manager needs no interaction lock; a unit struct (not
/// `()`) lets callers bind the guard the same way on every platform.
#[cfg(windows)]
struct NoInteractionLock;
#[cfg(windows)]
fn interaction_guard() -> Result<NoInteractionLock> {
    Ok(NoInteractionLock)
}
#[cfg(target_os = "macos")]
fn interaction_guard() -> Result<(
    Option<security_framework::os::macos::keychain::KeychainUserInteractionLock>,
    std::sync::MutexGuard<'static, ()>,
)> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let guard = LOCK.lock().map_err(|_| unavailable())?;
    let interaction =
        if security_framework::os::macos::keychain::SecKeychain::user_interaction_allowed()
            .map_err(|_| unavailable())?
        {
            Some(
                security_framework::os::macos::keychain::SecKeychain::disable_user_interaction()
                    .map_err(|_| unavailable())?,
            )
        } else {
            None
        };
    Ok((interaction, guard))
}
#[cfg(target_os = "linux")]
impl SecretStore for OsSecrets {
    fn get(&self, owner: &str, id: &str) -> Result<Option<String>> {
        let service = linux_service()?;
        let collection = service
            .get_default_collection()
            .map_err(|_| unavailable())?;
        if collection.is_locked().map_err(|_| unavailable())? {
            return Err(unavailable());
        }
        let items = collection
            .search_items(linux_attributes(owner, id))
            .map_err(|_| unavailable())?;
        if items.is_empty() {
            return Ok(None);
        }
        if items.len() != 1 {
            return Err(unavailable());
        }
        let bytes = items[0].get_secret().map_err(|_| unavailable())?;
        String::from_utf8(bytes)
            .map(Some)
            .map_err(|_| unavailable())
    }
    fn put(&self, owner: &str, id: &str, value: &str) -> Result<()> {
        let service = linux_service()?;
        let collection = service
            .get_default_collection()
            .map_err(|_| unavailable())?;
        if collection.is_locked().map_err(|_| unavailable())? {
            return Err(unavailable());
        }
        collection
            .create_item(
                "Tauri Explorer text connection",
                linux_attributes(owner, id),
                value.as_bytes(),
                false,
                "text/plain",
            )
            .map_err(|_| unavailable())?;
        Ok(())
    }
    fn remove(&self, owner: &str, id: &str) -> Result<()> {
        let service = linux_service()?;
        let collection = service
            .get_default_collection()
            .map_err(|_| unavailable())?;
        if collection.is_locked().map_err(|_| unavailable())? {
            return Err(unavailable());
        }
        for item in collection
            .search_items(linux_attributes(owner, id))
            .map_err(|_| unavailable())?
        {
            item.delete().map_err(|_| unavailable())?;
        }
        Ok(())
    }
}
#[cfg(target_os = "linux")]
fn linux_service() -> Result<dbus_secret_service::SecretService> {
    dbus_secret_service::SecretService::connect_with_max_prompt_timeout(
        dbus_secret_service::EncryptionType::Dh,
        0,
    )
    .map_err(|_| unavailable())
}
#[cfg(target_os = "linux")]
fn linux_attributes<'a>(
    owner: &'a str,
    id: &'a str,
) -> std::collections::HashMap<&'a str, &'a str> {
    std::collections::HashMap::from([
        ("service", "tauri-explorer.text.v1"),
        ("profile", owner),
        ("record", id),
    ])
}
