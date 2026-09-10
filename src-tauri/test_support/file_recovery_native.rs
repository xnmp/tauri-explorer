//! Opt-in native acceptance fixture and receipts, absent from ordinary builds.
//! Seed via the production executor before creating any window; no renderer can
//! choose seed paths or inject recovery authority. Never overwrite fixture files.
use super::{
    coordinator::Coordinator,
    model::{NativePath, OperationSpec, RecoverySnapshot, ReplacementSpec},
    replacement_execution::ReplacementExecution,
    resources::{Access, Request, Scope},
};
use crate::files::{
    file_identity::{of_file, version_from_metadata},
    native_directory::Directory,
};
use std::{
    fs,
    io::Write,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
};
use tauri::{ipc::Channel, Manager};

static LOG: Mutex<()> = Mutex::new(());
static REGISTRATION: AtomicU64 = AtomicU64::new(1);

fn directory() -> Option<PathBuf> {
    std::env::var_os("TAURI_E2E_FILE_RECOVERY_DIR").map(PathBuf::from)
}

fn record(value: serde_json::Value) {
    let Some(directory) = directory() else { return };
    let _guard = LOG.lock().unwrap();
    let result = (|| -> std::io::Result<()> {
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(directory.join("channels.jsonl"))?;
        serde_json::to_writer(&mut file, &value)?;
        file.write_all(b"\n")
    })();
    if let Err(error) = result {
        eprintln!("recovery acceptance receipt failed: {error}");
    }
}

pub(crate) fn released(label: &str, session: &str, token: u64) {
    record(
        serde_json::json!({"event":"unsubscribe", "pid":std::process::id(),
        "label":label, "session":session, "token":token.to_string()}),
    );
}

/// Own the actual CommandArg channel. The drop receipt follows destruction of
/// its final wrapper-owned reference, including Tauri's WebView send/drop closures.
pub(super) struct ObservedChannel {
    channel: Option<Channel<RecoverySnapshot>>,
    registration: u64,
}

impl ObservedChannel {
    pub(super) fn new(
        channel: Channel<RecoverySnapshot>,
        label: &str,
        session: &str,
        token: u64,
    ) -> Self {
        let registration = REGISTRATION.fetch_add(1, Ordering::Relaxed);
        record(
            serde_json::json!({"event":"received", "pid":std::process::id(),
            "registration":registration.to_string(), "label":label, "session":session,
            "token":token.to_string(), "channel":channel.id()}),
        );
        Self {
            channel: Some(channel),
            registration,
        }
    }
    pub(super) fn send(&self, snapshot: RecoverySnapshot) -> tauri::Result<()> {
        let channel = self.channel.as_ref().unwrap();
        record(serde_json::json!({"event":"send", "pid":std::process::id(),
            "registration":self.registration.to_string(), "revision":snapshot.revision.to_string()}));
        channel.send(snapshot)
    }
}

impl Drop for ObservedChannel {
    fn drop(&mut self) {
        let channel = self.channel.take().unwrap();
        drop(channel);
        record(
            serde_json::json!({"event":"dropped", "pid":std::process::id(),
            "registration":self.registration.to_string()}),
        );
    }
}

pub(crate) fn seed(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let Some(directory) = directory() else {
        return Ok(());
    };
    let directory = fs::canonicalize(directory)?;
    let fixture = directory.join("replacement");
    fs::create_dir(&fixture)?; // A reused harness profile fails instead of replacing evidence.
    let source = fixture.join("source.txt");
    let target = fixture.join("target.txt");
    fs::write(&source, b"native copied payload\n")?;
    fs::write(&target, b"native original payload\n")?;
    let mut random = [0; 32];
    getrandom::fill(&mut random)?;
    let token = hex::encode(random);
    let root = fixture.join(format!(".tauri-explorer-recovery-{token}"));
    let storage = app.path().app_local_data_dir()?.join("file-recovery");
    fs::create_dir_all(storage.parent().unwrap())?;
    let coordinator = Coordinator::open(&storage)?;
    let reservation = coordinator.reserve(vec![
        Request {
            path: source.clone(),
            access: Access::Read,
            scope: Scope::Subtree,
        },
        Request {
            path: target.clone(),
            access: Access::Write,
            scope: Scope::Subtree,
        },
        Request {
            path: root.clone(),
            access: Access::Write,
            scope: Scope::Subtree,
        },
    ])?;
    let spec = ReplacementSpec {
        artifact_token: token,
        source: NativePath(source.clone()),
        source_version: version_from_metadata(&fs::symlink_metadata(&source)?)?,
        target: NativePath(target.clone()),
        root: NativePath(root.clone()),
        parent: of_file(&Directory::open(&fixture)?.file)?,
        original: version_from_metadata(&fs::symlink_metadata(&target)?)?,
    };
    let operation = reservation
        .promote(OperationSpec::CopyReplacement(spec))
        .map_err(|failure| failure.error)?;
    let mut execution = ReplacementExecution::prepare(operation)?;
    let mut progress = crate::progress::ProgressTracker::new(None, "copy", "cancelled", 0, 0, None);
    execution.stage_copy(&mut progress)?;
    execution.displace_copy()?;
    execution.publish_copy()?;
    let id = execution.operation.intent().id.clone();
    drop(execution); // Abandoned native owner; durable records and both payloads remain.
    fs::write(
        directory.join("fixture.json"),
        serde_json::to_vec(&serde_json::json!({
            "pid":std::process::id(), "id":id, "source":source, "target":target, "root":root,
        }))?,
    )?;
    Ok(())
}
