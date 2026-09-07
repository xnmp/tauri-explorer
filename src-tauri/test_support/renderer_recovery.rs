//! Opt-in Linux acceptance harness for recovery of one retained native WebView.
//! This module is compiled only with `e2e-renderer-recovery`; it does not define
//! application crash-recovery policy.

use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::Manager;
use webkit2gtk::glib::object::ObjectType;
use webkit2gtk::{
    glib, SnapshotOptions, SnapshotRegion, WebProcessTerminationReason, WebView, WebViewExt,
};

const STEP_TIMEOUT: Duration = Duration::from_secs(20);
const POLL_INTERVAL: Duration = Duration::from_millis(50);
static TOKEN: AtomicU64 = AtomicU64::new(1);

type HarnessResult<T> = Result<T, String>;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Identity {
    process_id: u32,
    window_label: String,
    webview_address: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CycleEvidence {
    cycle: usize,
    termination_reason: String,
    old_session: String,
    new_session: String,
    old_lease_id: String,
    new_lease_id: String,
    repo_root: String,
    old_lease_reclaimed: bool,
    old_acquire_rejected: bool,
    stale_release_ignored: bool,
    mutation_started_at: u128,
    watcher_observed_at: u64,
    watcher_received_at: u64,
    marker: String,
    entries: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PublishedState {
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    cycle: Option<usize>,
    process_id: u32,
    window_label: String,
    webview_address: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    cycles: Vec<CycleEvidence>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Clone)]
struct Lease {
    id: String,
    repo_root: String,
    log_dir: PathBuf,
}

pub fn start(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let Some(directory) = std::env::var_os("TAURI_E2E_RECOVERY_DIR").map(PathBuf::from) else {
        return Ok(());
    };
    let fallback = Identity {
        process_id: std::process::id(),
        window_label: "main".into(),
        webview_address: "unavailable".into(),
    };
    if let Err(error) = validate_fixture(&directory) {
        fail_and_exit(app, &directory, &fallback, Vec::new(), error);
        return Ok(());
    }

    let Some(webview) = app.get_webview_window("main") else {
        fail_and_exit(
            app,
            &directory,
            &fallback,
            Vec::new(),
            "main WebView was not created".into(),
        );
        return Ok(());
    };
    let app_for_webview = app.clone();
    let window_label = webview.label().to_owned();
    let failed_directory = directory.clone();
    if let Err(error) = webview.with_webview(move |native| {
        let view = native.inner();
        let identity = Identity {
            process_id: std::process::id(),
            window_label,
            webview_address: format!("{:p}", view.as_ptr()),
        };
        let (termination_send, termination_receive) = tokio::sync::mpsc::unbounded_channel();
        view.connect_web_process_terminated(move |_, reason| {
            let _ = termination_send.send(reason);
        });

        let app_for_run = app_for_webview.clone();
        let directory_for_run = directory.clone();
        glib::MainContext::ref_thread_default().spawn_local(async move {
            let result =
                run_scenario(&view, &directory_for_run, &identity, termination_receive).await;
            match result {
                Ok(evidence) => {
                    if let Err(error) = publish(
                        &directory_for_run,
                        &identity,
                        "passed",
                        None,
                        evidence.clone(),
                        None,
                    ) {
                        fail_and_exit(&app_for_run, &directory_for_run, &identity, evidence, error);
                        return;
                    }
                    app_for_run.exit(0);
                }
                Err((evidence, error)) => {
                    fail_and_exit(&app_for_run, &directory_for_run, &identity, evidence, error)
                }
            }
        });
    }) {
        fail_and_exit(
            app,
            &failed_directory,
            &fallback,
            Vec::new(),
            format!("failed to retain native WebView: {error}"),
        );
    }
    Ok(())
}

fn validate_fixture(directory: &Path) -> HarnessResult<()> {
    for path in [
        directory.join("survivor.txt"),
        directory.join("repository-0/.git"),
        directory.join("repository-1/.git"),
        directory.join("repository-2/.git"),
    ] {
        if !path.exists() {
            return Err(format!("recovery fixture is missing {}", path.display()));
        }
    }
    Ok(())
}

async fn run_scenario(
    view: &WebView,
    directory: &Path,
    identity: &Identity,
    mut terminations: tokio::sync::mpsc::UnboundedReceiver<WebProcessTerminationReason>,
) -> Result<Vec<CycleEvidence>, (Vec<CycleEvidence>, String)> {
    let mut evidence = Vec::new();
    let result = async {
        wait_for(view, "initial Explorer listing", || {
            "(() => document.documentElement.dataset.e2eHooksReady === 'true' && \
             document.querySelectorAll('.explorer-pane').length === 1 && \
             [...document.querySelectorAll('.entry-name')].some(node => node.textContent === 'survivor.txt'))()"
                .into()
        })
        .await?;

        let previous_session = invoke(view, "native_resource_session", json!({})).await?;
        let mut previous_session = string_result(&previous_session, "initial Git session")?;
        let initial_repo = directory.join("repository-0");
        let mut previous_lease = acquire(view, &initial_repo, "initial-watch").await?;

        for cycle in 1..=2 {
            while terminations.try_recv().is_ok() {}
            let realm_token = format!(
                "renderer-recovery-realm-{cycle}-{}",
                TOKEN.fetch_add(1, Ordering::Relaxed)
            );
            let realm_token_json = encode(&realm_token)?;
            evaluate(
                view,
                &format!(
                    "(() => {{ window.__TAURI_E2E_RECOVERY_REALM__ = {realm_token_json}; return true; }})()"
                ),
            )
            .await?;
            let reclamation = format!(
                "Reclaimed Git observation for retired ownership: {}",
                previous_lease.repo_root
            );
            let reclamations_before = log_occurrences(&previous_lease.log_dir, &reclamation)?;
            publish(
                directory,
                identity,
                "armed",
                Some(cycle),
                evidence.clone(),
                None,
            )?;

            // No JavaScript or reload is attempted while waiting for native
            // retirement. The runner kills the real WebKitWebProcess here.
            let reason = wait_for_termination(&mut terminations).await?;
            if reason != WebProcessTerminationReason::Crashed {
                return Err(format!(
                    "renderer ended for {reason:?}, not from the runner's crash signal"
                ));
            }
            wait_for_reclamation(
                &previous_lease.log_dir,
                &reclamation,
                reclamations_before,
            )
            .await?;

            // This is test-controller behavior on the retained GTK object, not
            // application recovery policy. A committed reload advances the
            // production Git generation before the new realm can invoke IPC.
            view.reload();
            wait_for(view, "recovered E2E hooks", || {
                "document.documentElement.dataset.e2eHooksReady === 'true' && \
                 typeof window.__TAURI_E2E_RECOVERY_REALM__ === 'undefined'".into()
            })
            .await?;

            let current_session = invoke(view, "native_resource_session", json!({})).await?;
            let current_session = string_result(&current_session, "recovered Git session")?;
            if current_session == previous_session {
                return Err("renderer recovery reused the previous Git session".into());
            }

            let repository = directory.join(format!("repository-{cycle}"));
            let current_lease = acquire(view, &repository, &format!("watch-{cycle}")).await?;
            let obsolete = invoke_outcome(
                view,
                "git_watch_repo",
                json!({
                    "repoPath": current_lease.repo_root,
                    "sessionId": previous_session,
                }),
            )
            .await?;
            let obsolete_error = obsolete.get("error").map(Value::to_string).unwrap_or_default();
            if obsolete.get("ok").and_then(Value::as_bool) != Some(false)
                || !obsolete_error.contains("Native resource renderer was replaced")
            {
                return Err(format!(
                    "obsolete Git acquisition was not rejected by the generation guard: {obsolete}"
                ));
            }

            let stale_release = invoke_outcome(
                view,
                "git_unwatch_repo",
                json!({
                    "leaseId": current_lease.id,
                    "sessionId": previous_session,
                }),
            )
            .await?;
            if stale_release.get("ok").and_then(Value::as_bool) != Some(true) {
                return Err("stale release was not an idempotent no-op".into());
            }

            let marker = format!("observed-after-crash-{cycle}.txt");
            let mutation_started_at = epoch_millis()?;
            let marker_path = PathBuf::from(&current_lease.repo_root).join(&marker);
            std::fs::write(&marker_path, format!("recovery cycle {cycle}"))
                .map_err(|error| format!("failed to create watcher marker: {error}"))?;
            let repo_json = encode(&current_lease.repo_root)?;
            let marker_path_json = encode(&marker_path.to_string_lossy())?;
            let receipt = wait_for_value(view, "repo-qualified watcher receipt", || {
                format!(
                    "(() => {{ const changes = JSON.parse(document.documentElement.dataset.e2eGitChanges ?? '[]'); \
                     return changes.find(change => change.repoRoot === {repo_json} && change.source === 'watcher' \
                     && Number.isFinite(change.observedAt) && change.observedAt >= {mutation_started_at} \
                     && Array.isArray(change.paths) && change.paths.includes({marker_path_json}) \
                     && Number.isFinite(change.receivedAt) && change.receivedAt >= change.observedAt) ?? null; }})()"
                )
            })
            .await?;
            let watcher_observed_at = receipt
                .get("observedAt")
                .and_then(Value::as_u64)
                .ok_or_else(|| "watcher receipt omitted observedAt".to_owned())?;
            let watcher_received_at = receipt
                .get("receivedAt")
                .and_then(Value::as_u64)
                .ok_or_else(|| "watcher receipt omitted receivedAt".to_owned())?;

            navigate_through_address_bar(view, &current_lease.repo_root).await?;
            let marker_json = encode(&marker)?;
            wait_for(view, "recovered marker listing", || {
                format!(
                    "[...document.querySelectorAll('.explorer-pane .entry-name')].some(node => node.textContent === {marker_json})"
                )
            })
            .await?;
            let entries = evaluate(
                view,
                "[...document.querySelectorAll('.explorer-pane .entry-name')].map(node => node.textContent ?? '')",
            )
            .await?
            .as_array()
            .ok_or_else(|| "recovered listing did not return entry names".to_owned())?
            .iter()
            .map(|entry| {
                entry
                    .as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| "recovered listing contained a non-string name".to_owned())
            })
            .collect::<HarnessResult<Vec<_>>>()?;

            evidence.push(CycleEvidence {
                cycle,
                termination_reason: format!("{reason:?}"),
                old_session: previous_session,
                new_session: current_session.clone(),
                old_lease_id: previous_lease.id,
                new_lease_id: current_lease.id.clone(),
                repo_root: current_lease.repo_root.clone(),
                old_lease_reclaimed: true,
                old_acquire_rejected: true,
                stale_release_ignored: true,
                mutation_started_at,
                watcher_observed_at,
                watcher_received_at,
                marker,
                entries,
            });
            previous_session = current_session;
            previous_lease = current_lease;
        }

        save_snapshot(view, &directory.join("recovered.png")).await?;
        Ok(())
    }
    .await;
    match result {
        Ok(()) => Ok(evidence),
        Err(error) => Err((evidence, error)),
    }
}

async fn acquire(view: &WebView, repository: &Path, token_prefix: &str) -> HarnessResult<Lease> {
    let result = operation(
        view,
        "watch-acquire",
        repository.to_string_lossy().as_ref(),
        token_prefix,
    )
    .await?;
    let result = result
        .get("result")
        .ok_or_else(|| "watch-acquire response omitted result".to_owned())?;
    let lease = result
        .get("lease")
        .ok_or_else(|| "watch-acquire response omitted lease".to_owned())?;
    Ok(Lease {
        id: required_string(lease, "id")?,
        repo_root: required_string(lease, "repoRoot")?,
        log_dir: PathBuf::from(required_string(result, "logDir")?),
    })
}

async fn operation(
    view: &WebView,
    operation: &str,
    target: &str,
    token_prefix: &str,
) -> HarnessResult<Value> {
    let token = format!(
        "renderer-recovery-{token_prefix}-{}",
        TOKEN.fetch_add(1, Ordering::Relaxed)
    );
    let token_json = encode(&token)?;
    let operation_json = encode(operation)?;
    let target_json = encode(target)?;
    evaluate(
        view,
        &format!(
            "(() => {{ delete document.documentElement.dataset.e2eWindowResult; \
             window.dispatchEvent(new CustomEvent('e2e-window-operation', {{ detail: {{ \
             token: {token_json}, op: {operation_json}, target: {target_json} }} }})); return true; }})()"
        ),
    )
    .await?;
    let response = wait_for_value(view, operation, || {
        format!(
            "(() => {{ const raw = document.documentElement.dataset.e2eWindowResult; \
             if (!raw) return null; const value = JSON.parse(raw); \
             return value.token === {token_json} ? value : null; }})()"
        )
    })
    .await?;
    if let Some(error) = response.get("error").and_then(Value::as_str) {
        return Err(format!("{operation} failed: {error}"));
    }
    Ok(response)
}

async fn invoke(view: &WebView, command: &str, arguments: Value) -> HarnessResult<Value> {
    let outcome = invoke_outcome(view, command, arguments).await?;
    if outcome.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(format!(
            "{command} failed: {}",
            outcome.get("error").unwrap_or(&Value::Null)
        ));
    }
    Ok(outcome.get("result").cloned().unwrap_or(Value::Null))
}

async fn invoke_outcome(view: &WebView, command: &str, arguments: Value) -> HarnessResult<Value> {
    let token = format!(
        "renderer-recovery-invoke-{}",
        TOKEN.fetch_add(1, Ordering::Relaxed)
    );
    let token_json = encode(&token)?;
    let command_json = encode(command)?;
    let arguments_json = encode(&arguments)?;
    evaluate(
        view,
        &format!(
            "(() => {{ const root = document.documentElement; delete root.dataset.e2eRecoveryInvoke; \
             const bridge = window.__TAURI_INTERNALS__; \
             if (!bridge || typeof bridge.invoke !== 'function') {{ \
               root.dataset.e2eRecoveryInvoke = JSON.stringify({{ token: {token_json}, ok: false, error: 'Tauri invoke bridge missing' }}); \
             }} else {{ bridge.invoke({command_json}, {arguments_json}).then( \
               result => root.dataset.e2eRecoveryInvoke = JSON.stringify({{ token: {token_json}, ok: true, result }}), \
               error => root.dataset.e2eRecoveryInvoke = JSON.stringify({{ token: {token_json}, ok: false, error }})); }} \
             return true; }})()"
        ),
    )
    .await?;
    wait_for_value(view, command, || {
        format!(
            "(() => {{ const raw = document.documentElement.dataset.e2eRecoveryInvoke; \
             if (!raw) return null; const value = JSON.parse(raw); \
             return value.token === {token_json} ? value : null; }})()"
        )
    })
    .await
}

async fn navigate_through_address_bar(view: &WebView, target: &str) -> HarnessResult<()> {
    evaluate(
        view,
        "(() => { const bar = document.querySelector('.explorer-pane .breadcrumbs-container'); \
         if (!bar) return false; bar.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; })()",
    )
    .await?;
    wait_for(view, "address input", || {
        "document.querySelector('.explorer-pane .path-input') !== null".into()
    })
    .await?;
    let target_json = encode(target)?;
    evaluate(
        view,
        &format!(
            "(() => {{ const input = document.querySelector('.explorer-pane .path-input'); \
             if (!(input instanceof HTMLInputElement)) return false; \
             Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, {target_json}); \
             input.dispatchEvent(new Event('input', {{ bubbles: true }})); \
             input.dispatchEvent(new KeyboardEvent('keydown', {{ key: 'Enter', code: 'Enter', bubbles: true }})); \
             return true; }})()"
        ),
    )
    .await?;
    let target_json = encode(target)?;
    wait_for(view, "address navigation", || {
        format!("document.querySelector('.status-path')?.getAttribute('title') === {target_json}")
    })
    .await
}

async fn evaluate(view: &WebView, script: &str) -> HarnessResult<Value> {
    // Returning a JSON string lets us use JSCValue's Display implementation;
    // javascriptcore-rs is intentionally only a transitive dependency here.
    let wrapped = format!("JSON.stringify(({script}))");
    let value = view
        .evaluate_javascript_future(&wrapped, None, None)
        .await
        .map_err(|error| format!("native JavaScript evaluation failed: {error}"))?;
    let json = value.to_string();
    serde_json::from_str(&json)
        .map_err(|error| format!("invalid JavaScript result {json}: {error}"))
}

async fn wait_for<F>(view: &WebView, description: &str, script: F) -> HarnessResult<()>
where
    F: Fn() -> String,
{
    wait_for_value(view, description, script).await.map(|_| ())
}

async fn wait_for_value<F>(view: &WebView, description: &str, script: F) -> HarnessResult<Value>
where
    F: Fn() -> String,
{
    let deadline = Instant::now() + STEP_TIMEOUT;
    loop {
        let last_error = match evaluate(view, &script()).await {
            Ok(value) if value != Value::Null && value != Value::Bool(false) => return Ok(value),
            Ok(_) => None,
            Err(error) => Some(error),
        };
        if Instant::now() >= deadline {
            let detail = last_error
                .map(|error| format!("; last evaluation error: {error}"))
                .unwrap_or_default();
            return Err(format!("timed out waiting for {description}{detail}"));
        }
        glib::timeout_future(POLL_INTERVAL).await;
    }
}

async fn wait_for_reclamation(
    log_dir: &Path,
    marker: &str,
    previous_count: usize,
) -> HarnessResult<()> {
    let deadline = Instant::now() + STEP_TIMEOUT;
    loop {
        if log_occurrences(log_dir, marker)? > previous_count {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(format!("old Git owner was not reclaimed: {marker}"));
        }
        glib::timeout_future(POLL_INTERVAL).await;
    }
}

async fn wait_for_termination(
    terminations: &mut tokio::sync::mpsc::UnboundedReceiver<WebProcessTerminationReason>,
) -> HarnessResult<WebProcessTerminationReason> {
    glib::future_with_timeout(STEP_TIMEOUT, terminations.recv())
        .await
        .map_err(|_| "timed out waiting for native renderer termination".to_owned())?
        .ok_or_else(|| "native termination listener was disconnected".to_owned())
}

fn log_occurrences(directory: &Path, marker: &str) -> HarnessResult<usize> {
    let entries = std::fs::read_dir(directory).map_err(|error| {
        format!(
            "failed to read log directory {}: {error}",
            directory.display()
        )
    })?;
    let mut count = 0;
    for entry in entries {
        let entry = entry.map_err(|error| format!("failed to read log entry: {error}"))?;
        if entry.path().extension().and_then(|value| value.to_str()) != Some("log") {
            continue;
        }
        let contents = std::fs::read_to_string(entry.path())
            .map_err(|error| format!("failed to read {}: {error}", entry.path().display()))?;
        count += contents.matches(marker).count();
    }
    Ok(count)
}

async fn save_snapshot(view: &WebView, path: &Path) -> HarnessResult<()> {
    let surface = view
        .snapshot_future(SnapshotRegion::Visible, SnapshotOptions::NONE)
        .await
        .map_err(|error| format!("native WebView snapshot failed: {error}"))?;
    let image_surface = surface
        .map_to_image(None)
        .map_err(|error| format!("failed to map WebView snapshot: {error}"))?;
    let width = image_surface.width();
    let height = image_surface.height();
    if width <= 0 || height <= 0 {
        return Err("native WebView snapshot was empty".into());
    }
    drop(image_surface);
    let pixbuf = gtk::gdk::pixbuf_get_from_surface(&surface, 0, 0, width, height)
        .ok_or_else(|| "failed to convert WebView snapshot to a GDK pixbuf".to_owned())?;
    pixbuf
        .savev(path, "png", &[])
        .map_err(|error| format!("failed to save {}: {error}", path.display()))
}

fn epoch_millis() -> HarnessResult<u128> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .map_err(|error| format!("system clock predates Unix epoch: {error}"))
}

fn required_string(value: &Value, key: &str) -> HarnessResult<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| format!("response omitted string field {key}"))
}

fn string_result(value: &Value, description: &str) -> HarnessResult<String> {
    value
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| format!("{description} was not a string: {value}"))
}

fn encode<T: Serialize + ?Sized>(value: &T) -> HarnessResult<String> {
    serde_json::to_string(value).map_err(|error| format!("failed to encode script value: {error}"))
}

fn publish(
    directory: &Path,
    identity: &Identity,
    status: &'static str,
    cycle: Option<usize>,
    evidence: Vec<CycleEvidence>,
    error: Option<String>,
) -> HarnessResult<()> {
    let state = PublishedState {
        status,
        cycle,
        process_id: identity.process_id,
        window_label: identity.window_label.clone(),
        webview_address: identity.webview_address.clone(),
        cycles: evidence,
        error,
    };
    let temporary = directory.join("state.tmp");
    let destination = directory.join("state.json");
    let bytes = serde_json::to_vec_pretty(&state)
        .map_err(|error| format!("failed to serialize recovery state: {error}"))?;
    std::fs::write(&temporary, bytes)
        .map_err(|error| format!("failed to write {}: {error}", temporary.display()))?;
    std::fs::rename(&temporary, &destination)
        .map_err(|error| format!("failed to publish {}: {error}", destination.display()))
}

fn fail_and_exit(
    app: &tauri::AppHandle,
    directory: &Path,
    identity: &Identity,
    evidence: Vec<CycleEvidence>,
    error: String,
) {
    if let Err(publish_error) = publish(
        directory,
        identity,
        "failed",
        None,
        evidence,
        Some(error.clone()),
    ) {
        log::error!("renderer recovery failed: {error}; state publication failed: {publish_error}");
    } else {
        log::error!("renderer recovery failed: {error}");
    }
    app.exit(1);
}
