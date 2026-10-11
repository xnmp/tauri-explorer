//! Host lifetime store: recover ownership before processing package mutations.
use crate::{
    error::AppError,
    service_state::{model::Limits, Store},
};
use std::sync::{Mutex, OnceLock};
/// Only a successful open is cached. A failed open (for example a transient
/// I/O or lock error) stays retryable for the life of the process.
static STORE: OnceLock<Store> = OnceLock::new();
static OPENING: Mutex<()> = Mutex::new(());
const UNAVAILABLE: &str = "AI operation storage is unavailable; package changes require recovery";
/// Opens the profile's ledger. The caller owns the profile (see `ownership`)
/// and runs startup recovery before treating the store as ready.
pub(super) fn initialize(profile: &std::path::Path) -> Result<&'static Store, AppError> {
    let _opening = OPENING.lock().unwrap_or_else(|cause| cause.into_inner());
    if let Some(store) = STORE.get() {
        return Ok(store);
    }
    let store = Store::open(profile.join("service-state"), Limits::default()).map_err(|cause| {
        log::warn!("AI operation storage could not be opened: {cause}");
        AppError::Other(UNAVAILABLE.into())
    })?;
    Ok(STORE.get_or_init(|| store))
}
/// The opened ledger. A process that does not own the profile never opens it.
pub(super) fn store() -> Result<&'static Store, AppError> {
    STORE
        .get()
        .ok_or_else(|| AppError::Other(UNAVAILABLE.into()))
}
/// Service code for a mutation refused only because work is still owned.
/// Queued requests carrying it are retained rather than discarded.
pub(super) const PACKAGE_BUSY: &str = "package_busy";
pub(super) fn busy(message: &str) -> AppError {
    AppError::Service {
        code: PACKAGE_BUSY.into(),
        message: message.into(),
    }
}
/// Only the Linux startup queue branches on it outside tests.
#[cfg(any(target_os = "linux", test))]
pub(super) fn is_busy(error: &AppError) -> bool {
    matches!(error, AppError::Service { code, .. } if code == PACKAGE_BUSY)
}
pub(super) fn mutation_allowed_in(store: &Store, package: &str) -> Result<(), AppError> {
    if store.busy(package)? {
        return Err(busy("Package has unresolved AI operations; open Unresolved AI operations before changing it"));
    }
    Ok(())
}
pub(super) fn mutation_allowed_at(
    profile: &std::path::Path,
    package: &str,
) -> Result<(), AppError> {
    mutation_allowed_in(
        &Store::open(profile.join("service-state"), Limits::default())?,
        package,
    )
}

/// SDK1/2 consumers may reconcile shared uncertain runs as ordinary interrupted
/// work. Refuse that downgrade independently of released execution claims.
pub(super) fn candidate_state_allowed_at(
    profile: &std::path::Path,
    candidate: &super::package::Installed,
) -> Result<(), AppError> {
    mutation_allowed_at(profile, &candidate.manifest.id)?;
    if candidate.manifest.sdk_version < 3 {
        let store = Store::open(profile.join("service-state"), Limits::default())?;
        require_legacy_consumer_compatible(&store, &candidate.manifest.id)?;
    }
    Ok(())
}
pub(super) fn require_legacy_consumer_compatible(
    store: &Store,
    package: &str,
) -> Result<(), AppError> {
    if !store.legacy_consumer_compatible(package)? {
        return Err(AppError::Other("This legacy package cannot preserve retained shared AI history; keep a compatible package enabled".into()));
    }
    Ok(())
}
