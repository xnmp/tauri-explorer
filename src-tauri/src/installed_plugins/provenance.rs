//! Optional recording service. The host owns publisher leases; the package owns history.
use super::{backend, package, root};
use crate::{error::AppError, image_crop};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
};

static OWNERSHIP: Mutex<()> = Mutex::new(());
pub(super) fn ownership_guard() -> Result<std::sync::MutexGuard<'static, ()>, AppError> {
    OWNERSHIP
        .lock()
        .map_err(|_| AppError::Other("Recording ownership lock is unavailable".into()))
}
static LEASES: OnceLock<Mutex<HashMap<String, HashMap<i64, usize>>>> = OnceLock::new();
fn leases() -> &'static Mutex<HashMap<String, HashMap<i64, usize>>> {
    LEASES.get_or_init(|| Mutex::new(HashMap::new()))
}
pub(super) fn active_runs(package: &str) -> Vec<i64> {
    leases()
        .lock()
        .unwrap_or_else(|cause| cause.into_inner())
        .get(package)
        .map(|runs| runs.keys().copied().collect())
        .unwrap_or_default()
}
struct Lease {
    package: String,
    id: i64,
}
impl Drop for Lease {
    fn drop(&mut self) {
        let mut all = leases().lock().unwrap_or_else(|cause| cause.into_inner());
        if let Some(runs) = all.get_mut(&self.package) {
            runs.remove(&self.id);
        }
    }
}
#[derive(Clone, Default)]
pub(crate) struct TraceRunHandle(Option<Arc<Lease>>);
impl TraceRunHandle {
    pub(crate) fn recording(&self) -> bool {
        self.0.is_some()
    }
}
pub(crate) struct CropMetadata {
    pub source_path: String,
    pub source_digest: String,
    pub rect: image_crop::CropRect,
    pub viewport: image_crop::SvgViewport,
}
#[derive(Serialize)]
pub(crate) struct OperationInput {
    pub path: String,
    pub digest: String,
}
#[derive(Serialize)]
pub(crate) struct OperationStart {
    pub operation: String,
    pub parameters: Value,
    pub inputs: Vec<OperationInput>,
}

pub(crate) fn begin_operation(start: OperationStart) -> Result<TraceRunHandle, AppError> {
    let _guard = super::read_lifecycle()?;
    let Some(provider) = package::list(&root()?)?
        .into_iter()
        .find(|entry| entry.enabled && entry.manifest.provenance)
    else {
        return Ok(TraceRunHandle::default());
    };
    let broker = backend::ensure(&provider.manifest.id)?;
    let _ownership = ownership_guard()?;
    let result = broker.call("provenance.begin", json!({"start":start}))?;
    let id = result["id"]
        .as_i64()
        .filter(|id| *id > 0)
        .ok_or_else(|| AppError::Other("Invalid recording handle".into()))?;
    leases()
        .lock()
        .unwrap_or_else(|cause| cause.into_inner())
        .entry(provider.manifest.id.clone())
        .or_default()
        .insert(id, 1);
    Ok(TraceRunHandle(Some(Arc::new(Lease {
        package: provider.manifest.id,
        id,
    }))))
}
fn call(run: &TraceRunHandle, method: &str, mut params: Value) -> Result<(), AppError> {
    let _guard = super::read_lifecycle()?;
    let Some(lease) = &run.0 else {
        return Ok(());
    };
    params["run"] = json!({"id":lease.id});
    backend::call(&lease.package, method, params).map(|_| ())
}
pub(crate) fn begin_crop(metadata: &CropMetadata) -> Result<TraceRunHandle, AppError> {
    begin_operation(OperationStart {
        operation: "image.crop".into(),
        parameters: json!({"rect":metadata.rect,"viewport":metadata.viewport}),
        inputs: vec![OperationInput {
            path: metadata.source_path.clone(),
            digest: metadata.source_digest.clone(),
        }],
    })
}
pub(crate) fn prepare_operation_output(
    run: &TraceRunHandle,
    target: &Path,
    digest: &str,
    staged: Option<&Path>,
) -> Result<(), AppError> {
    if !run.recording() {
        return Ok(());
    }
    call(
        run,
        "provenance.prepare",
        json!({"target":target,"digest":digest,"staged":staged.ok_or_else(||AppError::Other("Recording requires publication evidence".into()))?}),
    )
}
pub(crate) use prepare_operation_output as prepare_crop_output;
#[cfg(target_os = "linux")]
pub(crate) fn prepare_linked_output(
    run: &TraceRunHandle,
    target: &Path,
    digest: &str,
    publisher: &Path,
) -> Result<(), AppError> {
    call(
        run,
        "provenance.prepareLinked",
        json!({"target":target,"digest":digest,"publisher":publisher}),
    )
}
pub(crate) fn complete_operation(run: &TraceRunHandle, path: &str) -> Result<(), AppError> {
    call(run, "provenance.complete", json!({"path":path}))
}
pub(crate) use complete_operation as complete_crop;
pub(crate) fn fail_operation(run: &TraceRunHandle, reason: &str) -> Result<(), AppError> {
    call(run, "provenance.fail", json!({"reason":reason}))
}
pub(crate) fn fail_crop(run: &TraceRunHandle) -> Result<(), AppError> {
    fail_operation(run, "crop_failed")
}
pub(crate) fn cancel_operation(run: &TraceRunHandle) -> Result<(), AppError> {
    call(run, "provenance.cancel", json!({}))
}
pub(crate) fn mark_operation_uncertain(run: &TraceRunHandle, reason: &str) -> Result<(), AppError> {
    call(run, "provenance.uncertain", json!({"reason":reason}))
}
pub(crate) fn mark_crop_uncertain(run: &TraceRunHandle) -> Result<(), AppError> {
    mark_operation_uncertain(run, "crop_completion_pending")
}
pub(crate) fn record_operation_details(
    run: &TraceRunHandle,
    details: &Value,
) -> Result<(), AppError> {
    call(run, "provenance.details", json!({"details":details}))
}
pub(crate) async fn relocate_after_rename(
    source: PathBuf,
    target: PathBuf,
) -> Result<(), AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = super::read_lifecycle()?;
        let Some(provider) = package::list(&root()?)?
            .into_iter()
            .find(|entry| entry.enabled && entry.manifest.provenance)
        else {
            return Ok(());
        };
        backend::call(
            &provider.manifest.id,
            "provenance.relocate",
            json!({"source":source,"target":target}),
        )
        .map(|_| ())
    })
    .await
    .map_err(|cause| AppError::WorkerFailed(cause.to_string()))?
}
