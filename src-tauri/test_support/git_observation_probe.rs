//! Opt-in causal metadata for native renderer-recovery acceptance only.
//! Normal Git event payloads and observer callbacks do not compile this module.
use std::collections::VecDeque;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Observation {
    repo_root: String,
    observed_at: u64,
    paths: Vec<String>,
}

static ENABLED: OnceLock<bool> = OnceLock::new();
static OBSERVATIONS: Mutex<VecDeque<Observation>> = Mutex::new(VecDeque::new());

/// Called at actual relevant native observation, before waking the worker.
pub(crate) fn record(repo_root: &str, event: &notify::Event) {
    if !*ENABLED.get_or_init(|| std::env::var_os("TAURI_E2E_RECOVERY_DIR").is_some()) {
        return;
    }
    let Some(observed_at) = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|elapsed| u64::try_from(elapsed.as_millis()).ok())
    else {
        return;
    };
    let mut observations = OBSERVATIONS.lock().unwrap();
    if let Some(index) = observations
        .iter()
        .position(|entry| entry.repo_root == repo_root)
    {
        if observations[index].observed_at > observed_at {
            return;
        }
        observations.remove(index);
    }
    if observations.len() == 32 {
        observations.pop_front();
    }
    observations.push_back(Observation {
        repo_root: repo_root.to_owned(),
        observed_at,
        paths: event
            .paths
            .iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect(),
    });
}

/// Attach the observation to the real successful event, never to a synthetic ACK.
pub(crate) fn payload(repo_root: &str) -> Option<Observation> {
    OBSERVATIONS
        .lock()
        .unwrap()
        .iter()
        .find(|entry| entry.repo_root == repo_root)
        .cloned()
}
