//! Host lifetime store: recover ownership before processing package mutations.
use crate::{
    config,
    error::AppError,
    service_state::{model::Limits, Store},
};
use std::sync::OnceLock;
static STORE: OnceLock<Result<Store, String>> = OnceLock::new();
pub(super) fn initialize() -> Result<(), AppError> {
    let result = STORE.get_or_init(|| {
        config::config_dir()
            .and_then(|root| Store::open(root.join("service-state"), Limits::default()))
            .map_err(|_| {
                "AI operation storage is unavailable; package changes require recovery".into()
            })
    });
    result
        .as_ref()
        .map(|_| ())
        .map_err(|message| AppError::Other(message.clone()))
}
pub(super) fn store() -> Result<&'static Store, AppError> {
    initialize()?;
    STORE
        .get()
        .expect("initialized")
        .as_ref()
        .map_err(|message| AppError::Other(message.clone()))
}
pub(super) fn mutation_allowed(package: &str) -> Result<(), AppError> {
    let store = store()?;
    if store.busy(package)? {
        return Err(AppError::Other("Package has unresolved AI operations; open Unresolved AI operations before changing it".into()));
    }
    Ok(())
}
pub(super) fn mutation_allowed_at(
    profile: &std::path::Path,
    package: &str,
) -> Result<(), AppError> {
    let store = Store::open(profile.join("service-state"), Limits::default())?;
    if store.busy(package)? {
        return Err(AppError::Other("Package has unresolved AI operations; open Unresolved AI operations before changing it".into()));
    }
    Ok(())
}
