//! Recovery-channel acceptance inside the retained GTK WebView crash controller.
use super::{
    encode, evaluate, required_string, wait_for, wait_for_value, HarnessResult, POLL_INTERVAL,
    STEP_TIMEOUT, TOKEN,
};
use serde::Serialize;
use serde_json::{json, Value};
use std::{fs, path::PathBuf, sync::atomic::Ordering, time::Instant};
use webkit2gtk::{glib, WebView};

pub(super) struct Lease {
    directory: PathBuf,
    registration: String,
    session: String,
    subscription: String,
    revision: String,
    generation: String,
    operation: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Evidence {
    old_registration: String,
    new_registration: String,
    old_session: String,
    new_session: String,
    old_channel_dropped_before_reload: bool,
    stale_acquire_rejected: bool,
    stale_release_ignored: bool,
    operation_id: String,
    before_revision: String,
    after_revision: String,
    before_generation: String,
    after_generation: String,
}

fn receipts(lease: &Lease) -> HarnessResult<Vec<Value>> {
    let text =
        fs::read_to_string(lease.directory.join("channels.jsonl")).map_err(|e| e.to_string())?;
    text[..text.rfind('\n').map_or(0, |end| end + 1)]
        .lines()
        .map(|line| serde_json::from_str(line).map_err(|e| e.to_string()))
        .collect()
}

async fn request(view: &WebView, op: &str, arguments: Value) -> HarnessResult<Value> {
    let token = format!("recovery-crash-{}", TOKEN.fetch_add(1, Ordering::Relaxed));
    let mut detail = arguments;
    detail["op"] = json!(op);
    detail["token"] = json!(token);
    let detail = encode(&detail)?;
    evaluate(view, &format!("(() => {{ window.dispatchEvent(new CustomEvent('e2e-recovery-operation', {{ detail: {detail} }})); return true; }})()")).await?;
    let token = encode(&token)?;
    wait_for_value(view, op, || format!("(() => {{ const value = JSON.parse(document.documentElement.dataset.e2eRecoveryResult ?? 'null'); return value?.token === {token} ? value : null; }})()")).await
}

fn result(envelope: &Value) -> HarnessResult<&Value> {
    if let Some(error) = envelope.get("error") {
        return Err(format!("recovery IPC failed: {error}"));
    }
    envelope
        .get("result")
        .ok_or_else(|| "missing recovery IPC result".into())
}

pub(super) async fn acquire(view: &WebView) -> HarnessResult<Option<Lease>> {
    let Some(directory) = std::env::var_os("TAURI_E2E_FILE_RECOVERY_DIR").map(PathBuf::from) else {
        return Ok(None);
    };
    wait_for(view, "automatic recovery subscription", || "document.documentElement.dataset.e2eRecoveryReady === 'true' && document.querySelector('.recovery-notice') !== null".into()).await?;
    let envelope = request(view, "subscribe", json!({})).await?;
    let result = result(&envelope)?;
    let fixture: Value = serde_json::from_slice(
        &fs::read(directory.join("fixture.json")).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let operation = required_string(&fixture, "id")?;
    let mut lease = Lease {
        directory,
        registration: String::new(),
        session: required_string(result, "sessionId")?,
        subscription: required_string(result, "subscriptionId")?,
        revision: required_string(&result["snapshot"], "revision")?,
        generation: required_string(item(&result["snapshot"], &operation)?, "generation")?,
        operation,
    };
    let matched: Vec<_> = receipts(&lease)?
        .into_iter()
        .filter(|entry| {
            entry["event"] == "received"
                && entry["label"] == "main"
                && entry["session"] == lease.session
                && entry["token"] == lease.subscription
                && entry["channel"] == result["channel"]
                && entry["pid"] == std::process::id()
        })
        .collect();
    if matched.len() != 1 {
        return Err("recovery acknowledgement did not identify one native registration".into());
    }
    lease.registration = required_string(&matched[0], "registration")?;
    Ok(Some(lease))
}

pub(super) async fn wait_for_drop(lease: &Lease) -> HarnessResult<()> {
    let deadline = Instant::now() + STEP_TIMEOUT;
    loop {
        let entries = receipts(lease)?;
        if entries.iter().any(|entry| {
            entry["event"] == "unsubscribe"
                && entry["label"] == "main"
                && entry["session"] == lease.session
                && entry["token"] == lease.subscription
        }) {
            return Err(
                "raw recovery lease was explicitly released before crash retirement".into(),
            );
        }
        if entries
            .iter()
            .any(|entry| entry["event"] == "dropped" && entry["registration"] == lease.registration)
        {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err("crashed renderer retained its native recovery channel".into());
        }
        // Only native receipt reads run here; never touch JavaScript or reload.
        glib::timeout_future(POLL_INTERVAL).await;
    }
}

fn item<'a>(snapshot: &'a Value, id: &str) -> HarnessResult<&'a Value> {
    snapshot["items"]
        .as_array()
        .and_then(|items| items.iter().find(|item| item["id"] == id))
        .ok_or_else(|| "native recovery fixture vanished".into())
}

fn advanced(before: &str, after: &str) -> HarnessResult<()> {
    let before = before.parse::<u64>().map_err(|e| e.to_string())?;
    let after = after.parse::<u64>().map_err(|e| e.to_string())?;
    if after <= before {
        return Err("recovery counter did not advance".into());
    }
    Ok(())
}

pub(super) async fn verify(
    view: &WebView,
    old: &Lease,
    current: &Lease,
) -> HarnessResult<Evidence> {
    advanced(&old.session, &current.session)?;
    let send_count = || -> HarnessResult<usize> {
        Ok(receipts(old)?
            .iter()
            .filter(|entry| entry["event"] == "send" && entry["registration"] == old.registration)
            .count())
    };
    let old_sends = send_count()?;
    let rejected = request(
        view,
        "subscribe",
        json!({"sessionId":old.session, "subscriptionId":old.subscription}),
    )
    .await?;
    if !rejected["error"]
        .as_str()
        .is_some_and(|error| error.contains("renderer was replaced"))
    {
        return Err(format!(
            "retired recovery session was not rejected: {rejected}"
        ));
    }
    result(
        &request(
            view,
            "unsubscribe",
            json!({"sessionId":old.session, "subscriptionId":old.subscription}),
        )
        .await?,
    )?;
    let envelope = request(view, "inspect", json!({"id":current.operation})).await?;
    let snapshot = result(&envelope)?;
    let revision = required_string(snapshot, "revision")?;
    let generation = required_string(item(snapshot, &current.operation)?, "generation")?;
    advanced(&current.revision, &revision)?;
    advanced(&current.generation, &generation)?;
    let expected = encode(
        &json!({"subscription":current.subscription, "revision":revision,
        "id":current.operation, "generation":generation}),
    )?;
    wait_for(view, "fresh recovery callback after native inspection", || format!(
        "(() => {{ const expected = {expected}; const value = JSON.parse(document.documentElement.dataset.e2eRecoverySnapshot ?? 'null'); return value?.subscriptionId === expected.subscription && value.snapshot.revision === expected.revision && value.snapshot.items.some(item => item.id === expected.id && item.generation === expected.generation); }})()"
    )).await?;
    if send_count()? != old_sends {
        return Err("retired recovery registration attempted another send".into());
    }
    if !receipts(current)?.iter().any(|entry| {
        entry["event"] == "send"
            && entry["registration"] == current.registration
            && entry["revision"] == revision
    }) {
        return Err("fresh recovery callback lacked its native send receipt".into());
    }
    Ok(Evidence {
        old_registration: old.registration.clone(),
        new_registration: current.registration.clone(),
        old_session: old.session.clone(),
        new_session: current.session.clone(),
        old_channel_dropped_before_reload: true,
        stale_acquire_rejected: true,
        stale_release_ignored: true,
        operation_id: current.operation.clone(),
        before_revision: current.revision.clone(),
        after_revision: revision,
        before_generation: current.generation.clone(),
        after_generation: generation,
    })
}
