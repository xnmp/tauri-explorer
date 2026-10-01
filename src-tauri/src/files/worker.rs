//! A worker owns its execution resources through work and capture destruction.
//! The enclosing async caller may disappear without shortening that lifetime.
//! Returned values must be data, not independent effectful cleanup owners: the
//! job releases its owner before the caller consumes or drops the return value.
use crate::diagnostics::{panic_message, Warnings};
use crate::error::AppError;
use std::{
    panic::{catch_unwind, AssertUnwindSafe},
    sync::{Arc, Mutex},
};

/// A confirmed filesystem result and later cleanup diagnostics are independent.
#[derive(Debug)]
pub(crate) struct Completion<T> {
    pub result: Result<T, AppError>,
    pub warning: Option<String>,
}

/// Effectful resources belong to the explicit context; work has no owned
/// captures whose destruction could precede publication of its return value.
pub(crate) async fn run_blocking_context<C, T>(
    mut context: C,
    work: fn(&mut C) -> Result<T, AppError>,
) -> Completion<T>
where
    C: Send + 'static,
    T: Send + 'static,
{
    let reported = Arc::new(Mutex::new(None));
    let writer = Arc::clone(&reported);
    let worker = tauri::async_runtime::spawn_blocking(move || {
        // Work and context cleanup are distinct unwind boundaries. In particular
        // a work panic must stop unwinding before a panicking context destructor.
        let result = catch_unwind(AssertUnwindSafe(|| work(&mut context)))
            .unwrap_or_else(|payload| Err(AppError::WorkerFailed(panic_message(payload.as_ref()))));
        *writer.lock().unwrap_or_else(|error| error.into_inner()) = Some(result);
        catch_unwind(AssertUnwindSafe(|| drop(context)))
            .err()
            .map(|payload| panic_message(payload.as_ref()))
    });
    let cleanup = match worker.await {
        Ok(cleanup) => cleanup,
        Err(error) => Some(error.to_string()),
    };
    let result = reported
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .take();
    match (result, cleanup) {
        (Some(Ok(value)), cleanup) => Completion {
            result: Ok(value),
            warning: cleanup.map(|message| {
                bounded(format!(
                    "File operation finished, but worker cleanup failed: {message}"
                ))
            }),
        },
        (Some(Err(error)), None) => Completion {
            result: Err(error),
            warning: None,
        },
        (Some(Err(error)), Some(cleanup)) => Completion {
            result: Err(AppError::WorkerFailed(bounded(format!(
                "{error}\nWorker cleanup failed: {cleanup}"
            )))),
            warning: None,
        },
        (None, failure) => Completion {
            result: Err(AppError::WorkerFailed(bounded(
                failure.unwrap_or_else(|| "File worker did not report an outcome".into()),
            ))),
            warning: None,
        },
    }
}

fn bounded(message: String) -> String {
    let warnings: Warnings = std::iter::once(message).collect();
    warnings.into_vec().join("\n")
}

pub(super) struct Job<O, F> {
    // Declaration order also protects a queued job that is dropped without
    // running: work captures are destroyed before their owner.
    work: F,
    owner: O,
}

impl<O, F> Job<O, F> {
    pub(super) fn new(owner: O, work: F) -> Self {
        Self { work, owner }
    }

    pub(super) fn run<T>(self) -> T
    where
        F: FnOnce() -> T,
    {
        self.run_with(|work| work())
    }

    pub(super) fn run_with<T>(self, execute: impl FnOnce(F) -> T) -> T {
        let Self { work, owner } = self;
        let result = execute(work);
        drop(owner);
        result
    }
}

pub(super) async fn run_blocking_owned<O, T, F>(owner: O, work: F) -> Result<T, AppError>
where
    O: Send + 'static,
    T: Send + 'static,
    F: FnOnce() -> Result<T, AppError> + Send + 'static,
{
    let job = Job::new(owner, work);
    match tauri::async_runtime::spawn_blocking(move || job.run()).await {
        Ok(result) => result,
        Err(error) => Err(AppError::WorkerFailed(error.to_string())),
    }
}

#[cfg(test)]
#[path = "../../test_support/file_worker_completion.rs"]
mod tests;
