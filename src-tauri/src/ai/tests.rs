use super::*;
use credentials::{MemorySecrets, SecretStore};
#[cfg(unix)]
use std::path::Path;
use std::{
    fs,
    io::{Read, Write},
    net::TcpListener,
    sync::mpsc,
};
fn config_http(root: &str) -> Configuration {
    Configuration {
        schema_version: 1,
        revision: 0,
        enabled: true,
        default_profile_id: Some("http".into()),
        profiles: vec![Profile {
            id: "http".into(),
            name: "Local fixture".into(),
            model: "editable-model".into(),
            timeout_ms: 45_000,
            connection: Connection::Chat {
                base_url: root.into(),
                allow_insecure_http: true,
                credential: Credential::None,
            },
        }],
    }
}
fn request(id: &str) -> Value {
    json!({"requestId":id,"instructions":"Summarize input","input":"An example prompt","maxOutputTokens":64,"timeoutMs":2000})
}
fn fixture_service(config: Configuration) -> (tempfile::TempDir, &'static Service) {
    let root = tempfile::tempdir().unwrap();
    let service = Box::leak(Box::new(Service::new(
        root.path().into(),
        Arc::new(MemorySecrets::default()),
    )));
    service.store.save(config, 0).unwrap();
    (root, service)
}
/// Tests that saturate the process-wide local worker semaphore run one at a
/// time. Its FIFO fairness otherwise lets one test's `acquire_many(4)` queue
/// ahead of another test's own single acquire while that test holds three
/// permits, stalling every text test until a timeout breaks the cycle.
static LOCAL_SLOT_SATURATION: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
/// A loopback root whose connections close at once. Unlike a closed port,
/// this fails immediately on Windows too, where refused connects are retried.
fn closed_root() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            drop(stream);
        }
    });
    format!("http://{address}/v1")
}
fn http_fixture(
    status: &str,
    body: String,
    delay: Duration,
) -> (String, mpsc::Receiver<String>, std::thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let (tx, rx) = mpsc::channel();
    let status = status.to_owned();
    let handle = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut bytes = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            let n = stream.read(&mut chunk).unwrap();
            if n == 0 {
                break;
            }
            bytes.extend_from_slice(&chunk[..n]);
            if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                let header = String::from_utf8_lossy(&bytes[..end]).to_ascii_lowercase();
                let length = header
                    .lines()
                    .find_map(|l| l.strip_prefix("content-length: "))
                    .and_then(|s| s.parse::<usize>().ok())
                    .unwrap_or(0);
                if bytes.len() >= end + 4 + length {
                    break;
                }
            }
        }
        tx.send(String::from_utf8(bytes).unwrap()).unwrap();
        std::thread::sleep(delay);
        let response = format!(
            "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let _ = stream.write_all(response.as_bytes());
    });
    (format!("http://{address}/nested/v1"), rx, handle)
}
#[test]
fn validation_preserves_api_prefix_and_rejects_secret_urls() {
    for base in [
        "https://example.test/prefix/v1",
        "https://example.test/prefix/v1/",
    ] {
        let root = api_root(base, false).unwrap();
        assert_eq!(
            root.join("chat/completions").unwrap().as_str(),
            "https://example.test/prefix/v1/chat/completions"
        );
    }
    for base in [
        "https://key@example.test/v1",
        "https://example.test/v1?api_key=x",
        "https://example.test/#key",
        "http://public.test/v1",
        "file:///tmp/x",
    ] {
        assert!(api_root(base, false).is_err());
    }
    assert!(api_root("http://127.0.0.1:8888/v1", false).is_ok());
    let mut c = config_http("https://example.test/v1");
    c.default_profile_id = None;
    assert!(validate_configuration(&mut c).is_err());
    c.enabled = false;
    assert!(validate_configuration(&mut c).is_ok());
    c.profiles[0].model.clear();
    assert!(validate_configuration(&mut c).is_err());
}
#[test]
fn request_contract_bounds_utf8_and_options() {
    let mut r: Request = serde_json::from_value(request("ok")).unwrap();
    r.input = "😄".repeat(16384);
    assert!(validate_request(&r).is_err());
    r.instructions.clear();
    assert!(validate_request(&r).is_ok());
    r.max_output_tokens = 0;
    assert!(validate_request(&r).is_err());
    r.max_output_tokens = 64;
    r.timeout_ms = Some(45_001);
    assert!(validate_request(&r).is_err());
}
#[test]
fn fingerprints_ignore_credential_and_name_but_follow_model_endpoint() {
    let c = config_http("https://example.test/v1");
    let mut p = c.profiles[0].clone();
    let fingerprint = p.context(1).fingerprint;
    p.name = "Renamed".into();
    *p.connection.credential_mut().unwrap() = Credential::Secret {
        id: "rotation".into(),
    };
    assert_eq!(fingerprint, p.context(50).fingerprint);
    p.model = "other".into();
    assert_ne!(fingerprint, p.context(50).fingerprint);
}
#[test]
fn malformed_newer_schema_and_symlinks_never_enable_defaults() {
    let root = tempfile::tempdir().unwrap();
    let store = storage::Store::new(root.path().into());
    assert!(store.read().unwrap().enabled);
    fs::write(root.path().join("ai-connections.json"), "{").unwrap();
    assert!(store.read().unwrap_err().message.contains("malformed"));
    fs::write(
        root.path().join("ai-connections.json"),
        r#"{"schemaVersion":99}"#,
    )
    .unwrap();
    assert!(store.read().unwrap_err().message.contains("schema"));
    #[cfg(unix)]
    {
        fs::remove_file(root.path().join("ai-connections.json")).unwrap();
        std::os::unix::fs::symlink(
            root.path().join("missing.json"),
            root.path().join("ai-connections.json"),
        )
        .unwrap();
        assert!(store.read().is_err());
    }
}
#[test]
fn config_cas_and_credential_mutation_are_publicly_sanitized() {
    let root = tempfile::tempdir().unwrap();
    let store = storage::Store::new(root.path().into());
    let fake = MemorySecrets::default();
    let c = store
        .save(config_http("https://example.test/v1"), 0)
        .unwrap();
    assert_eq!(c.revision, 1);
    assert_eq!(
        store.save(c.clone(), 0).unwrap_err().code,
        "configuration_changed"
    );
    let c = store
        .credential("http", Some("secret-value"), 1, &fake)
        .unwrap();
    assert_eq!(c.revision, 2);
    let sanitized = store.sanitized(c.clone(), &fake);
    assert_eq!(sanitized["profiles"][0]["hasCredential"], true);
    assert!(!sanitized.to_string().contains("secret-value"));
    assert!(!fs::read_to_string(root.path().join("ai-connections.json"))
        .unwrap()
        .contains("secret-value"));
    let (p, revision, key) = store.snapshot(&fake, Some(2)).unwrap();
    assert_eq!(key.as_deref(), Some("secret-value"));
    assert_eq!(revision, 2);
    let old = p.connection.credential().unwrap().clone();
    let c = store
        .credential("http", Some("replacement"), 2, &fake)
        .unwrap();
    assert_eq!(c.revision, 3);
    assert_eq!(key.as_deref(), Some("secret-value"));
    if let Credential::Secret { id } = old {
        assert!(fake.get("http", &id).unwrap().is_none());
    }
    let c = store.credential("http", None, 3, &fake).unwrap();
    assert_eq!(
        store.sanitized(c, &fake)["profiles"][0]["hasCredential"],
        false
    );
}
#[test]
fn forged_secret_references_are_rejected() {
    let root = tempfile::tempdir().unwrap();
    let store = storage::Store::new(root.path().into());
    let mut c = config_http("https://example.test/v1");
    *c.profiles[0].connection.credential_mut().unwrap() = Credential::Secret {
        id: "foreign-record".into(),
    };
    assert_eq!(store.save(c, 0).unwrap_err().code, "invalid_request");
}
#[test]
fn independent_stores_cas_without_lost_updates() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().to_path_buf();
    let barrier = Arc::new(std::sync::Barrier::new(2));
    let workers: Vec<_> = (0..2)
        .map(|i| {
            let root = path.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                let store = storage::Store::new(root);
                let mut c = config_http("https://example.test/v1");
                c.profiles[0].name = format!("Writer {i}");
                barrier.wait();
                store.save(c, 0)
            })
        })
        .collect();
    let results: Vec<_> = workers.into_iter().map(|w| w.join().unwrap()).collect();
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    assert_eq!(storage::Store::new(path).read().unwrap().revision, 1);
}
#[test]
fn summary_migration_copies_off_once_without_image_provider() {
    let root = tempfile::tempdir().unwrap();
    fs::write(
        root.path().join("plugin.openai-image.json"),
        r#"{"titleGenerator":"disabled"}"#,
    )
    .unwrap();
    storage::migrate_summary(root.path()).unwrap();
    let path = root.path().join("plugin.trace.json");
    let value: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(value["summarizePrompts"], false);
    fs::write(&path, r#"{"summarizePrompts":true,"unrelated":7}"#).unwrap();
    storage::migrate_summary(root.path()).unwrap();
    let value: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    assert_eq!(value["summarizePrompts"], true);
    assert_eq!(value["unrelated"], 7);
}
#[cfg(unix)]
#[test]
fn summary_migration_respects_legacy_symlink_targets() {
    let root = tempfile::tempdir().unwrap();
    let target = tempfile::tempdir().unwrap();
    let legacy = target.path().join("legacy.json");
    fs::write(&legacy, r#"{"titleGenerator":"disabled"}"#).unwrap();
    std::os::unix::fs::symlink(&legacy, root.path().join("plugin.openai-image.json")).unwrap();
    let trace = target.path().join("trace.json");
    fs::write(&trace, r#"{"unrelated":2}"#).unwrap();
    let link = root.path().join("plugin.trace.json");
    std::os::unix::fs::symlink(&trace, &link).unwrap();
    storage::migrate_summary(root.path()).unwrap();
    assert!(fs::symlink_metadata(link).unwrap().file_type().is_symlink());
    let value: Value = serde_json::from_slice(&fs::read(trace).unwrap()).unwrap();
    assert_eq!(value["summarizePrompts"], false);
    assert_eq!(value["unrelated"], 2);
}
#[tokio::test]
async fn chat_generation_sends_native_auth_and_returns_context() {
    let body=json!({"model":"actual-provider-model","choices":[{"finish_reason":"stop","message":{"content":"  Expected title  "}}],"usage":{"prompt_tokens":12,"completion_tokens":3}}).to_string();
    let (url, received, worker) = http_fixture("200 OK", body, Duration::ZERO);
    let (root, service) = fixture_service(config_http(&url));
    let c = service
        .store
        .credential("http", Some("fixture-secret"), 1, service.secrets.as_ref())
        .unwrap();
    let result = service
        .generate(
            "plugin:a:1".into(),
            request("same"),
            Arc::new(|| false),
            None,
        )
        .await
        .unwrap();
    assert_eq!(result.text, "Expected title");
    assert_eq!(
        result.context.actual_model.as_deref(),
        Some("actual-provider-model")
    );
    assert_eq!(result.context.configuration_revision, c.revision);
    let sent = received.recv().unwrap();
    assert!(sent.starts_with("POST /nested/v1/chat/completions "));
    assert!(sent
        .to_ascii_lowercase()
        .contains("authorization: bearer fixture-secret"));
    assert!(sent.contains("editable-model"));
    worker.join().unwrap();
    drop(root);
}
#[tokio::test]
async fn messages_returns_only_final_text_and_required_headers() {
    let body=json!({"model":"claude-fixture","stop_reason":"end_turn","content":[{"type":"thinking","thinking":"do not show"},{"type":"text","text":"Expected "},{"type":"text","text":"title"}],"usage":{"input_tokens":12,"output_tokens":3}}).to_string();
    let (url, received, worker) = http_fixture("200 OK", body, Duration::ZERO);
    let mut config = config_http(&url);
    config.profiles[0].connection = Connection::Messages {
        base_url: url,
        allow_insecure_http: true,
        credential: Credential::None,
    };
    let (_root, service) = fixture_service(config);
    service
        .store
        .credential("http", Some("fixture-secret"), 1, service.secrets.as_ref())
        .unwrap();
    let result = service
        .generate(
            "plugin:a:1".into(),
            request("same"),
            Arc::new(|| false),
            None,
        )
        .await
        .unwrap();
    assert_eq!(result.text, "Expected title");
    let sent = received.recv().unwrap().to_ascii_lowercase();
    assert!(sent.starts_with("post /nested/v1/messages "));
    assert!(sent.contains("x-api-key: fixture-secret"));
    assert!(sent.contains("anthropic-version: 2023-06-01"));
    worker.join().unwrap();
}
#[tokio::test]
async fn provider_errors_never_echo_response_and_redirect_is_not_followed() {
    for (status, body, expected) in [
        (
            "401 Unauthorized",
            "secret raw diagnostics",
            "authentication_failed",
        ),
        (
            "302 Found\r\nLocation: http://127.0.0.1:1/leak",
            "secret raw diagnostics",
            "provider_failed",
        ),
        (
            "429 Too Many Requests\r\nRetry-After: 7",
            "secret raw diagnostics",
            "rate_limited",
        ),
        (
            "200 OK",
            "invalid JSON secret raw diagnostics",
            "invalid_response",
        ),
    ] {
        let (url, _received, worker) = http_fixture(status, body.into(), Duration::ZERO);
        let (_root, service) = fixture_service(config_http(&url));
        let error = service
            .generate("plugin:a".into(), request("x"), Arc::new(|| false), None)
            .await
            .unwrap_err();
        assert_eq!(error.code, expected);
        assert!(!error.message.contains("secret raw"));
        if expected == "rate_limited" {
            assert_eq!(error.retry_after_ms, Some(7000));
        }
        worker.join().unwrap();
    }
}
#[tokio::test]
async fn oversize_response_is_rejected() {
    let (url, _received, worker) =
        http_fixture("200 OK", "x".repeat(256 * 1024 + 1), Duration::ZERO);
    let (_root, service) = fixture_service(config_http(&url));
    assert_eq!(
        service
            .generate("plugin:a".into(), request("x"), Arc::new(|| false), None)
            .await
            .unwrap_err()
            .code,
        "invalid_response"
    );
    worker.join().unwrap();
}
#[tokio::test]
async fn revision_mismatch_and_dead_owner_never_dispatch() {
    let (_root, service) = fixture_service(config_http("http://127.0.0.1:1/v1"));
    let mut r = request("x");
    r["expectedConfigurationRevision"] = json!(0);
    assert_eq!(
        service
            .generate("plugin:a".into(), r, Arc::new(|| false), None)
            .await
            .unwrap_err()
            .code,
        "configuration_changed"
    );
    assert_eq!(
        service
            .generate("plugin:a".into(), request("x"), Arc::new(|| true), None)
            .await
            .unwrap_err()
            .code,
        "cancelled"
    );
}
#[tokio::test]
async fn http_cancellation_is_scoped_and_owner_death_stops_work() {
    let (url, received, worker) = http_fixture(
        "200 OK",
        json!({"choices":[{"finish_reason":"stop","message":{"content":"late"}}]}).to_string(),
        Duration::from_millis(150),
    );
    let (_root, service) = fixture_service(config_http(&url));
    let dead = Arc::new(AtomicBool::new(false));
    let observed = dead.clone();
    let task = tokio::spawn(service.generate(
        "plugin:a:1".into(),
        request("same"),
        Arc::new(move || observed.load(Ordering::Acquire)),
        None,
    ));
    tokio::task::spawn_blocking(move || received.recv().unwrap())
        .await
        .unwrap();
    assert!(service.cancel("plugin:b:1", "same"));
    dead.store(true, Ordering::Release);
    assert_eq!(task.await.unwrap().unwrap_err().code, "cancelled");
    worker.join().unwrap();
}
#[tokio::test]
async fn queue_deadline_includes_wait_and_quota_is_bounded() {
    let (_root, service) = fixture_service(config_http("http://127.0.0.1:1/v1"));
    let permits = service.slots.clone().acquire_many_owned(4).await.unwrap();
    let mut r = request("queued");
    r["timeoutMs"] = json!(30);
    let started = Instant::now();
    assert_eq!(
        service
            .generate("plugin:a".into(), r, Arc::new(|| false), None)
            .await
            .unwrap_err()
            .code,
        "timed_out"
    );
    assert!(started.elapsed() < Duration::from_secs(1));
    drop(permits);
    let r: Request = serde_json::from_value(request("quota")).unwrap();
    let admissions: Vec<_> = (0..8)
        .map(|i| {
            let mut r = r.clone();
            r.request_id = format!("{i}");
            service.admit("a".into(), &r, Arc::new(|| false)).unwrap()
        })
        .collect();
    assert_eq!(
        service
            .admit("a".into(), &r, Arc::new(|| false))
            .err()
            .unwrap()
            .code,
        "capacity_reached"
    );
    assert!(service.admit("b".into(), &r, Arc::new(|| false)).is_ok());
    drop(admissions);
}
#[tokio::test]
async fn cancellation_before_admission_never_reaches_provider() {
    let (_root, service) = fixture_service(config_http(&closed_root()));
    assert!(service.cancel("plugin:a", "not-yet-admitted"));
    let error = service
        .generate(
            "plugin:a".into(),
            request("not-yet-admitted"),
            Arc::new(|| false),
            None,
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "cancelled");
    let other = service
        .generate(
            "plugin:b".into(),
            request("not-yet-admitted"),
            Arc::new(|| false),
            None,
        )
        .await
        .unwrap_err();
    assert_eq!(other.code, "provider_failed");
}
#[tokio::test]
async fn incomplete_or_refused_provider_output_is_not_a_title() {
    for body in [
        json!({"choices":[{"finish_reason":"length","message":{"content":"partial"}}]}),
        json!({"choices":[{"finish_reason":"stop","message":{"content":"refused","refusal":"cannot comply"}}]}),
        json!({"choices":[{"message":{"content":"missing completion marker"}}]}),
    ] {
        let (url, _received, worker) = http_fixture("200 OK", body.to_string(), Duration::ZERO);
        let (_root, service) = fixture_service(config_http(&url));
        assert_eq!(
            service
                .generate("plugin:a".into(), request("x"), Arc::new(|| false), None)
                .await
                .unwrap_err()
                .code,
            "invalid_response"
        );
        worker.join().unwrap();
    }
}
#[test]
fn first_run_text_migration_keeps_codex_path_and_destination_wins() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("plugin.openai-image.json");
    fs::write(&path,r#"{"titleCodexPath":"  /legacy/codex  ","codexPath":"/image/codex","titleGenerator":"disabled","apiKey":"never-import-this"}"#).unwrap();
    let store = storage::Store::new(root.path().into());
    let mut config = store.read().unwrap();
    assert!(
        matches!(&config.profiles[0].connection,Connection::Codex{executable_path}if executable_path=="/legacy/codex")
    );
    assert!(!fs::read_to_string(root.path().join("ai-connections.json"))
        .unwrap()
        .contains("never-import-this"));
    config.profiles[0].connection = Connection::Codex {
        executable_path: "/destination/codex".into(),
    };
    store.save(config, 0).unwrap();
    fs::write(path, r#"{"titleCodexPath":"/changed/codex"}"#).unwrap();
    assert!(
        matches!(&store.read().unwrap().profiles[0].connection,Connection::Codex{executable_path}if executable_path=="/destination/codex")
    );
}
#[test]
fn native_trace_writes_keep_explicit_preference_and_copy_off() {
    let root = tempfile::tempdir().unwrap();
    fs::write(
        root.path().join("plugin.openai-image.json"),
        r#"{"titleGenerator":"disabled"}"#,
    )
    .unwrap();
    storage::write_trace_config(root.path(), r#"{"unrelated":5}"#).unwrap();
    let value: Value =
        serde_json::from_slice(&fs::read(root.path().join("plugin.trace.json")).unwrap()).unwrap();
    assert_eq!(value["summarizePrompts"], false);
    assert_eq!(value["unrelated"], 5);
    storage::write_trace_config(root.path(), r#"{"summarizePrompts":true,"unrelated":8}"#).unwrap();
    storage::migrate_summary(root.path()).unwrap();
    let value: Value =
        serde_json::from_slice(&fs::read(root.path().join("plugin.trace.json")).unwrap()).unwrap();
    assert_eq!(value["summarizePrompts"], true);
    assert_eq!(value["unrelated"], 8);
}
fn write_trace_over_malformed(legacy: Option<&str>) -> (tempfile::TempDir, Result<()>) {
    let root = tempfile::tempdir().unwrap();
    if let Some(legacy) = legacy {
        fs::write(root.path().join("plugin.openai-image.json"), legacy).unwrap();
    }
    fs::write(root.path().join("plugin.trace.json"), "{ not json").unwrap();
    let result = storage::write_trace_config(root.path(), r#"{"unrelated":9}"#);
    (root, result)
}
#[test]
fn trace_save_repairs_a_hand_broken_trace_config() {
    let (root, saved) = write_trace_over_malformed(None);
    saved.expect("a whole-blob save overwrites a malformed file, as before");
    let value: Value =
        serde_json::from_slice(&fs::read(root.path().join("plugin.trace.json")).unwrap()).unwrap();
    assert_eq!(value["unrelated"], 9);
}
#[test]
fn trace_save_repairing_malformed_config_still_migrates_a_valid_legacy_off_switch() {
    let (root, saved) = write_trace_over_malformed(Some(r#"{"titleGenerator":"disabled"}"#));
    saved.unwrap();
    let value: Value =
        serde_json::from_slice(&fs::read(root.path().join("plugin.trace.json")).unwrap()).unwrap();
    assert_eq!(value["unrelated"], 9);
    assert_eq!(value["summarizePrompts"], false, "legacy setting not lost");
}
#[test]
fn reading_a_malformed_trace_config_is_not_blocked_by_migration() {
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("plugin.trace.json"), "{ not json").unwrap();
    fs::write(
        root.path().join("plugin.openai-image.json"),
        r#"{"titleGenerator":"disabled"}"#,
    )
    .unwrap();
    assert_eq!(
        storage::migrate_summary(root.path()).unwrap(),
        storage::SummaryMigration::Skipped
    );
    assert_eq!(
        fs::read_to_string(root.path().join("plugin.trace.json")).unwrap(),
        "{ not json",
        "migration never rewrites an unparseable destination"
    );
}
#[test]
fn trace_save_is_not_blocked_by_a_malformed_legacy_image_file() {
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("plugin.openai-image.json"), "{ nope").unwrap();
    storage::write_trace_config(root.path(), r#"{"unrelated":4}"#).unwrap();
    let value: Value =
        serde_json::from_slice(&fs::read(root.path().join("plugin.trace.json")).unwrap()).unwrap();
    assert_eq!(value["unrelated"], 4);
    assert_eq!(
        fs::read_to_string(root.path().join("plugin.openai-image.json")).unwrap(),
        "{ nope"
    );
    // Once the legacy file is repaired the pending migration still applies.
    fs::write(
        root.path().join("plugin.openai-image.json"),
        r#"{"titleGenerator":"disabled"}"#,
    )
    .unwrap();
    storage::migrate_summary(root.path()).unwrap();
    let value: Value =
        serde_json::from_slice(&fs::read(root.path().join("plugin.trace.json")).unwrap()).unwrap();
    assert_eq!(value["summarizePrompts"], false);
}
#[test]
fn stale_config_temp_files_are_swept_by_prefix_only() {
    let root = tempfile::tempdir().unwrap();
    // Crash debris from durable_write: can contain a plaintext API key.
    let stale = root.path().join(".ai-config-write-AbC123");
    fs::write(&stale, r#"{"apiKey":"leaked"}"#).unwrap();
    let old = std::time::SystemTime::now() - Duration::from_secs(3600);
    fs::File::options()
        .write(true)
        .open(&stale)
        .unwrap()
        .set_modified(old)
        .unwrap();
    let fresh = root.path().join(".ai-config-write-live");
    fs::write(&fresh, "in-flight").unwrap();
    let bystander = root.path().join(".tmpUnrelated");
    fs::write(&bystander, "not ours").unwrap();
    fs::File::options()
        .write(true)
        .open(&bystander)
        .unwrap()
        .set_modified(old)
        .unwrap();
    drop(storage::Store::new(root.path().into()).lock().unwrap());
    assert!(!stale.exists(), "stale writer temp removed");
    assert!(fresh.exists(), "a live writer's temp is left alone");
    assert!(bystander.exists(), "other files are never touched");
}
#[test]
fn failed_durable_write_leaves_no_temp_file_behind() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("plugin.openai-image.json");
    storage::fault::inject(
        "plugin.openai-image.json",
        storage::fault::Replace::AfterReplace,
    );
    assert!(storage::durable_write(&path, br#"{"apiKey":"secret"}"#).is_err());
    let leftovers: Vec<_> = fs::read_dir(root.path())
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .filter(|n| n != "plugin.openai-image.json")
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
}
#[test]
fn superseded_secret_is_removed_when_replacement_committed_but_confirmation_failed() {
    let root = tempfile::tempdir().unwrap();
    let store = storage::Store::new(root.path().into());
    let secrets = MemorySecrets::default();
    store
        .save(config_http("https://fixture.test/v1"), 0)
        .unwrap();
    store
        .credential("http", Some("first-key"), 1, &secrets)
        .unwrap();
    assert_eq!(secrets.count(), 1);
    storage::fault::inject("ai-connections.json", storage::fault::Replace::AfterReplace);
    assert!(store
        .credential("http", Some("second-key"), 2, &secrets)
        .is_err());
    let (_, _, credential) = store.snapshot(&secrets, None).unwrap();
    assert_eq!(credential.as_deref(), Some("second-key"));
    assert_eq!(secrets.count(), 1, "the superseded key is not orphaned");
}
#[test]
fn durable_replacement_replaces_existing_document() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("existing.json");
    storage::durable_write(&path, b"{\"version\":1}").unwrap();
    storage::durable_write(&path, b"{\"version\":2}").unwrap();
    assert_eq!(fs::read(path).unwrap(), b"{\"version\":2}");
}
#[test]
fn cas_child_writer() {
    let Some(root) = std::env::var_os("TE_AI_CAS_CHILD_ROOT") else {
        return;
    };
    let store = storage::Store::new(root.into());
    match store.save(config_http("https://fixture.test/v1"), 0) {
        Ok(_) => {}
        Err(error) if error.code == "configuration_changed" => std::process::exit(2),
        Err(error) => panic!("{error}"),
    }
}
#[test]
fn cross_process_cas_has_one_winner() {
    let root = tempfile::tempdir().unwrap();
    let binary = std::env::current_exe().unwrap();
    let mut first = std::process::Command::new(&binary)
        .args(["--exact", "ai::tests::cas_child_writer"])
        .env("TE_AI_CAS_CHILD_ROOT", root.path())
        .stdout(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let mut second = std::process::Command::new(binary)
        .args(["--exact", "ai::tests::cas_child_writer"])
        .env("TE_AI_CAS_CHILD_ROOT", root.path())
        .stdout(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let a = first.wait().unwrap().code().unwrap();
    let b = second.wait().unwrap().code().unwrap();
    assert!((a == 0 && b == 2) || (a == 2 && b == 0));
    assert_eq!(
        storage::Store::new(root.path().into())
            .read()
            .unwrap()
            .revision,
        1
    );
}
#[test]
fn credential_remains_readable_after_post_replace_sync_failure() {
    let root = tempfile::tempdir().unwrap();
    let store = storage::Store::new(root.path().into());
    let secrets = MemorySecrets::default();
    store
        .save(config_http("https://fixture.test/v1"), 0)
        .unwrap();
    storage::fault::inject("ai-connections.json", storage::fault::Replace::AfterReplace);
    assert_eq!(
        store
            .credential("http", Some("retained-after-commit"), 1, &secrets)
            .unwrap_err()
            .code,
        "unavailable"
    );
    let (profile, revision, credential) = store.snapshot(&secrets, None).unwrap();
    assert_eq!(revision, 2);
    assert_eq!(credential.as_deref(), Some("retained-after-commit"));
    assert_eq!(
        store.sanitized(store.read().unwrap(), &secrets)["profiles"][0]["hasCredential"],
        true
    );
    assert!(matches!(
        profile.connection.credential(),
        Some(Credential::Secret { .. })
    ));
}
#[tokio::test]
async fn aborted_snapshot_keeps_local_worker_slot_until_io_finishes() {
    struct SlowSecret {
        started: std::sync::Mutex<Option<mpsc::Sender<()>>>,
        release: std::sync::Mutex<mpsc::Receiver<()>>,
    }
    impl SecretStore for SlowSecret {
        fn get(&self, _: &str, _: &str) -> Result<Option<String>> {
            if let Some(started) = self.started.lock().unwrap().take() {
                started.send(()).unwrap();
                self.release.lock().unwrap().recv().unwrap();
            }
            Ok(Some("fixture-key".into()))
        }
        fn put(&self, _: &str, _: &str, _: &str) -> Result<()> {
            Ok(())
        }
        fn remove(&self, _: &str, _: &str) -> Result<()> {
            Ok(())
        }
    }
    let root = tempfile::tempdir().unwrap();
    let service = Box::leak(Box::new(Service::new(
        root.path().into(),
        Arc::new(MemorySecrets::default()),
    )));
    service.store.save(config_http(&closed_root()), 0).unwrap();
    service
        .store
        .credential("http", Some("fixture-key"), 1, service.secrets.as_ref())
        .unwrap();
    // Use a second service on the same committed directory to isolate the gate.
    let (started_tx, started_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let service = Box::leak(Box::new(Service::new(
        root.path().into(),
        Arc::new(SlowSecret {
            started: std::sync::Mutex::new(Some(started_tx)),
            release: std::sync::Mutex::new(release_rx),
        }),
    )));
    let _exclusive = LOCAL_SLOT_SATURATION.lock().await;
    let reserve = local_slots().acquire_many_owned(3).await.unwrap();
    let task =
        tokio::spawn(service.generate("plugin:a".into(), request("x"), Arc::new(|| false), None));
    tokio::task::spawn_blocking(move || started_rx.recv_timeout(Duration::from_secs(2)).unwrap())
        .await
        .unwrap();
    task.abort();
    let _ = task.await;
    let (_other_root, other) = fixture_service(config_http(&closed_root()));
    let mut blocked = request("blocked");
    blocked["timeoutMs"] = json!(30);
    assert_eq!(
        other
            .generate("plugin:b".into(), blocked, Arc::new(|| false), None)
            .await
            .unwrap_err()
            .code,
        "timed_out"
    );
    release_tx.send(()).unwrap();
    assert_eq!(
        other
            .generate(
                "plugin:b".into(),
                request("resumed"),
                Arc::new(|| false),
                None
            )
            .await
            .unwrap_err()
            .code,
        "provider_failed"
    );
    drop(reserve);
}
#[test]
fn interrupted_text_migration_converges_using_committed_destination() {
    let root = tempfile::tempdir().unwrap();
    let store = storage::Store::new(root.path().into());
    store.read().unwrap();
    fs::write(
        root.path().join(".ai-text-migration.json"),
        r#"{"version":1,"state":"pending"}"#,
    )
    .unwrap();
    let config = store.read().unwrap();
    assert_eq!(config.revision, 0);
    let marker: Value =
        serde_json::from_slice(&fs::read(root.path().join(".ai-text-migration.json")).unwrap())
            .unwrap();
    assert_eq!(marker["state"], "complete");
}
#[test]
fn deleting_profile_retires_its_owned_credential() {
    let root = tempfile::tempdir().unwrap();
    let store = storage::Store::new(root.path().into());
    let secrets = MemorySecrets::default();
    store
        .save(config_http("https://fixture.test/v1"), 0)
        .unwrap();
    let mut config = store
        .credential("http", Some("fixture-key"), 1, &secrets)
        .unwrap();
    let reference = config.profiles[0].connection.credential().cloned().unwrap();
    config.enabled = false;
    config.default_profile_id = None;
    config.profiles.clear();
    let saved = store.save_with_secrets(config, 2, Some(&secrets)).unwrap();
    assert_eq!(saved.revision, 3);
    if let Credential::Secret { id } = reference {
        assert!(secrets.get("http", &id).unwrap().is_none());
    }
}
/// Describe and check only run the CLI's `--help`; generation goes through
/// the enabled isolated adapter and returns only the final text.
#[cfg(unix)]
#[tokio::test]
async fn cli_profiles_describe_by_help_probe_and_generate_titles() {
    use super::cli_tests::{fake_cli, kinds, profile, success_output};
    for (kind, help) in kinds() {
        let root = tempfile::tempdir().unwrap();
        let executable = fake_cli(root.path(), kind, help, &success_output(kind), 0);
        let mut config = config_http("https://fixture.test/v1");
        config.profiles[0] = Profile {
            id: "http".into(),
            ..profile(kind, &executable, "fixture-model")
        };
        let (_config_root, service) = fixture_service(config);
        let described = service.describe().unwrap();
        assert!(described.available, "{kind}: {:?}", described.error);
        assert!(
            !root.path().join("run.json").exists(),
            "{kind}: describe never generates"
        );
        // A generous deadline: this asserts the enabled path, not timing.
        let mut slow_host = request("x");
        slow_host["timeoutMs"] = json!(20_000);
        let result = service
            .generate("plugin:a".into(), slow_host, Arc::new(|| false), None)
            .await
            .unwrap();
        assert_eq!(result.text, "Fixture title", "{kind}");
        assert!(root.path().join("run.json").exists());
    }
}
#[test]
fn ai_configuration_watch_observes_only_committed_file_names() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path();
    assert_eq!(
        crate::config_watch::watched_config_name(path, &path.join("ai-connections.json")),
        Some("ai-connections.json".into())
    );
    assert_eq!(
        crate::config_watch::watched_config_name(path, &path.join(".ai-connections.lock")),
        None
    );
    assert_eq!(
        crate::config_watch::watched_config_name(path, &path.join(".tmp-ai-connections.json")),
        None
    );
}
#[tokio::test]
async fn describe_dead_owner_never_reads_native_configuration() {
    assert_eq!(
        describe_owned(Arc::new(|| true)).await.unwrap_err().code,
        "cancelled"
    );
}
#[tokio::test]
async fn describe_cancels_while_waiting_for_bounded_local_workers() {
    let _exclusive = LOCAL_SLOT_SATURATION.lock().await;
    let held = local_slots().acquire_many_owned(4).await.unwrap();
    let dead = Arc::new(AtomicBool::new(false));
    let observed = dead.clone();
    let task = tokio::spawn(describe_owned(Arc::new(move || {
        observed.load(Ordering::Acquire)
    })));
    tokio::task::yield_now().await;
    dead.store(true, Ordering::Release);
    assert_eq!(task.await.unwrap().unwrap_err().code, "cancelled");
    drop(held);
}
#[tokio::test]
async fn profile_switch_keeps_admitted_endpoint_and_context() {
    let(url,received,worker)=http_fixture("200 OK",json!({"model":"old-provider-model","choices":[{"finish_reason":"stop","message":{"content":"Old profile title"}}]}).to_string(),Duration::from_millis(120));
    let (_root, service) = fixture_service(config_http(&url));
    let task =
        tokio::spawn(service.generate("plugin:a".into(), request("old"), Arc::new(|| false), None));
    let sent = tokio::task::spawn_blocking(move || received.recv().unwrap())
        .await
        .unwrap();
    assert!(sent.contains("editable-model"));
    let mut config = service.store.read().unwrap();
    config.profiles[0].model = "new-model".into();
    config.profiles[0].connection = Connection::Chat {
        base_url: closed_root(),
        allow_insecure_http: true,
        credential: Credential::None,
    };
    let switched = service.store.save(config, 1).unwrap();
    assert_eq!(switched.revision, 2);
    let old = task.await.unwrap().unwrap();
    assert_eq!(old.text, "Old profile title");
    assert_eq!(old.context.configuration_revision, 1);
    assert_eq!(old.context.requested_model, "editable-model");
    let mut next = request("new");
    next["expectedConfigurationRevision"] = json!(2);
    assert_eq!(
        service
            .generate("plugin:a".into(), next, Arc::new(|| false), None)
            .await
            .unwrap_err()
            .code,
        "provider_failed"
    );
    worker.join().unwrap();
}
#[cfg(unix)]
#[test]
fn legacy_fifo_source_and_target_fail_promptly_without_holding_config_lock() {
    use std::os::unix::ffi::OsStrExt;
    fn fifo(path: &Path) {
        let name = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
    }
    let root = tempfile::tempdir().unwrap();
    fifo(&root.path().join("plugin.openai-image.json"));
    let store = storage::Store::new(root.path().into());
    let started = Instant::now();
    assert_eq!(store.read().unwrap_err().code, "unavailable");
    assert!(started.elapsed() < Duration::from_secs(1));
    assert!(store.lock().is_ok());
    fs::remove_file(root.path().join("plugin.openai-image.json")).unwrap();
    fs::write(
        root.path().join("plugin.openai-image.json"),
        r#"{"titleGenerator":"disabled"}"#,
    )
    .unwrap();
    fifo(&root.path().join("plugin.trace.json"));
    let started = Instant::now();
    assert_eq!(
        storage::migrate_summary(root.path()).unwrap_err().code,
        "unavailable"
    );
    assert!(started.elapsed() < Duration::from_secs(1));
    assert!(store.lock().is_ok());
}
#[cfg(unix)]
#[test]
fn legacy_symlink_to_fifo_is_rejected_and_regular_target_still_migrates() {
    use std::os::unix::ffi::OsStrExt;
    let root = tempfile::tempdir().unwrap();
    let external = tempfile::tempdir().unwrap();
    let target = external.path().join("legacy.json");
    let name = std::ffi::CString::new(target.as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
    std::os::unix::fs::symlink(&target, root.path().join("plugin.openai-image.json")).unwrap();
    let store = storage::Store::new(root.path().into());
    let started = Instant::now();
    assert!(store.read().is_err());
    assert!(started.elapsed() < Duration::from_secs(1));
    fs::remove_file(&target).unwrap();
    fs::write(&target, r#"{"titleCodexPath":"/legacy/codex"}"#).unwrap();
    let config = store.read().unwrap();
    assert!(
        matches!(&config.profiles[0].connection,Connection::Codex{executable_path}if executable_path=="/legacy/codex")
    );
    assert!(
        fs::symlink_metadata(root.path().join("plugin.openai-image.json"))
            .unwrap()
            .file_type()
            .is_symlink()
    );
}
#[tokio::test]
async fn cancellation_quota_cannot_exhaust_other_callers() {
    let (_root, service) = fixture_service(config_http(&closed_root()));
    for i in 0..100 {
        assert!(service.cancel("plugin:a", &format!("cancel-{i}")));
    }
    assert_eq!(
        service
            .generate("plugin:a".into(), request("new"), Arc::new(|| false), None)
            .await
            .unwrap_err()
            .code,
        "capacity_reached"
    );
    assert_eq!(
        service
            .generate("plugin:b".into(), request("new"), Arc::new(|| false), None)
            .await
            .unwrap_err()
            .code,
        "provider_failed"
    );
}
#[test]
fn text_fingerprint_follows_endpoint_and_transport_and_is_canonical() {
    use sha2::{Digest, Sha256};
    let chat = config_http("https://example.test/v1").profiles.remove(0);
    let base = chat.context(1).fingerprint;
    // Independent golden over the documented canonical tuple.
    assert_eq!(
        base,
        hex::encode(Sha256::digest(
            br#"["text-adapter-v1","openai-chat-completions","https://example.test/v1","editable-model"]"#
        ))
    );
    let mut cosmetic = chat.clone();
    cosmetic.name = "Renamed".into();
    cosmetic.timeout_ms = 1000;
    assert_eq!(cosmetic.context(99).fingerprint, base);
    let with = |connection: Connection| Profile {
        connection,
        ..chat.clone()
    };
    let http = |url: &str, messages: bool| {
        let (base_url, allow_insecure_http, credential) = (url.into(), false, Credential::None);
        with(if messages {
            Connection::Messages {
                base_url,
                allow_insecure_http,
                credential,
            }
        } else {
            Connection::Chat {
                base_url,
                allow_insecure_http,
                credential,
            }
        })
    };
    let variants = [
        // Endpoint: another host, and another path prefix on the same host.
        http("https://other.test/v1", false),
        http("https://example.test/proxy/v1", false),
        // Transport: the same URL and model spoken as Anthropic Messages.
        http("https://example.test/v1", true),
        with(Connection::Codex {
            executable_path: "/opt/fixture/cli".into(),
        }),
        with(Connection::Claude {
            executable_path: "/opt/fixture/cli".into(),
        }),
        with(Connection::Codex {
            executable_path: "/opt/other/cli".into(),
        }),
    ];
    let mut seen = std::collections::HashSet::from([base]);
    for variant in &variants {
        assert_eq!(
            variant.context(1).fingerprint,
            variant.context(7).fingerprint
        );
        assert!(
            seen.insert(variant.context(1).fingerprint),
            "{:?} shares a fingerprint",
            variant.connection
        );
    }
}
#[test]
fn native_profile_validation_rejects_unknown_transport_wrong_types_and_duplicates() {
    let valid = serde_json::to_value(config_http("https://example.test/v1")).unwrap();
    let mut accepted = parse_configuration(valid.clone()).unwrap();
    validate_configuration(&mut accepted).unwrap();
    let edit = |change: &dyn Fn(&mut Value)| {
        let mut value = valid.clone();
        change(&mut value);
        value
    };
    let rejected = [
        edit(&|v| v["profiles"][0]["transport"] = json!("openai-responses")),
        edit(&|v| v["profiles"][0]["transport"] = json!(7)),
        edit(&|v| v["profiles"][0]["timeoutMs"] = json!("45000")),
        edit(&|v| v["profiles"][0]["timeoutMs"] = json!(-1)),
        edit(&|v| v["profiles"][0]["model"] = json!(5)),
        edit(&|v| v["profiles"][0]["model"] = Value::Null),
        edit(&|v| v["profiles"][0]["allowInsecureHttp"] = json!("yes")),
        edit(&|v| v["profiles"][0]["credential"] = json!("none")),
        edit(&|v| v["profiles"][0]["credential"] = json!({"kind":"keychain"})),
        edit(&|v| v["profiles"][0]["executablePath"] = json!("/usr/bin/codex")),
        edit(&|v| v["profiles"] = json!({"http": {}})),
        edit(&|v| v["enabled"] = json!("true")),
        edit(&|v| v["revision"] = json!(-1)),
        edit(&|v| v["defaultProfileId"] = json!(3)),
        edit(&|v| {
            let duplicate = v["profiles"][0].clone();
            v["profiles"].as_array_mut().unwrap().push(duplicate);
        }),
        edit(&|v| v["defaultProfileId"] = json!("absent")),
    ];
    let root = tempfile::tempdir().unwrap();
    let store = storage::Store::new(root.path().into());
    store.save(accepted, 0).unwrap();
    let committed = fs::read(root.path().join("ai-connections.json")).unwrap();
    for (index, value) in rejected.into_iter().enumerate() {
        let error = parse_configuration(value).and_then(|mut config| {
            validate_configuration(&mut config)?;
            // A native save must refuse it as well, not only this validator.
            store.save(config, 1)
        });
        assert_eq!(error.unwrap_err().code, "invalid_request", "case {index}");
    }
    assert_eq!(
        fs::read(root.path().join("ai-connections.json")).unwrap(),
        committed
    );
    // Duplicate IDs reach the store directly and are still refused.
    let mut duplicate = config_http("https://example.test/v1");
    duplicate.profiles.push(duplicate.profiles[0].clone());
    assert_eq!(
        store.save(duplicate, 1).unwrap_err().code,
        "invalid_request"
    );
    assert_eq!(store.read().unwrap().revision, 1);
}
#[test]
fn refused_windows_style_replacement_never_commits_or_overwrites_explicit_settings() {
    use storage::fault::{inject, Replace};
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("ai-connections.json");
    let store = storage::Store::new(root.path().into());
    let secrets = MemorySecrets::default();
    let mut explicit = config_http("https://explicit.test/v1");
    explicit.enabled = false;
    explicit.profiles[0].model = "explicit-model".into();
    store.save(explicit, 0).unwrap();
    let committed = fs::read(&path).unwrap();
    let residue = || {
        let mut names: Vec<_> = fs::read_dir(root.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        names
    };
    let files = residue();
    // A sharing violation refuses the replacement: no revision is reported,
    // the explicit document stays byte-identical and no temporary remains.
    let mut edit = store.read().unwrap();
    edit.profiles[0].model = "edited-model".into();
    inject("ai-connections.json", Replace::Refused);
    assert_eq!(store.save(edit.clone(), 1).unwrap_err().code, "unavailable");
    assert_eq!(fs::read(&path).unwrap(), committed);
    assert_eq!(residue(), files);
    let current = store.read().unwrap();
    assert_eq!((current.revision, current.enabled), (1, false));
    assert_eq!(current.profiles[0].model, "explicit-model");
    // The CAS revision did not advance, so the same edit can be retried.
    assert_eq!(store.save(edit, 1).unwrap().revision, 2);
    // A refused credential rotation keeps the old key and leaks no new secret.
    store
        .credential("http", Some("first-key"), 2, &secrets)
        .unwrap();
    inject("ai-connections.json", Replace::Refused);
    assert!(store
        .credential("http", Some("second-key"), 3, &secrets)
        .is_err());
    let current = store.read().unwrap();
    let key = credentials::resolve(&current.profiles[0], &secrets).unwrap();
    assert_eq!((current.revision, key.as_deref()), (3, Some("first-key")));
    assert_eq!(secrets.count(), 1);
    // A newer or corrupt document is never replaced by a save.
    for unreadable in [r#"{"schemaVersion":2,"revision":9}"#, "{"] {
        fs::write(&path, unreadable).unwrap();
        assert!(store
            .save(config_http("https://default.test/v1"), 3)
            .is_err());
        assert!(store.read().is_err());
        assert_eq!(fs::read(&path).unwrap(), unreadable.as_bytes());
    }
}
#[test]
fn refused_first_run_and_trace_writes_keep_state_unpublished() {
    use storage::fault::{inject, Replace};
    let root = tempfile::tempdir().unwrap();
    let store = storage::Store::new(root.path().into());
    // Refused first-run creation reports no in-memory default as committed.
    inject("ai-connections.json", Replace::Refused);
    assert_eq!(store.read().unwrap_err().code, "unavailable");
    assert!(!root.path().join("ai-connections.json").exists());
    assert_eq!(store.read().unwrap().revision, 0);
    // An explicit Trace preference is not replaced by the legacy "disabled".
    fs::write(
        root.path().join("plugin.openai-image.json"),
        r#"{"titleGenerator":"disabled"}"#,
    )
    .unwrap();
    let trace = root.path().join("plugin.trace.json");
    fs::write(&trace, r#"{"summarizePrompts":true,"unrelated":1}"#).unwrap();
    inject("plugin.trace.json", Replace::Refused);
    assert!(storage::write_trace_config(root.path(), r#"{"unrelated":2}"#).is_err());
    assert_eq!(
        fs::read(&trace).unwrap(),
        br#"{"summarizePrompts":true,"unrelated":1}"#
    );
    storage::write_trace_config(root.path(), r#"{"unrelated":2}"#).unwrap();
    let value: Value = serde_json::from_slice(&fs::read(&trace).unwrap()).unwrap();
    assert_eq!(value, json!({"summarizePrompts":true,"unrelated":2}));
}
#[tokio::test]
async fn http_empty_or_textless_bodies_are_classified_invalid() {
    let chat_missing = json!({"choices":[{"finish_reason":"stop","message":{"role":"assistant"}}]});
    let messages_missing =
        json!({"stop_reason":"end_turn","content":[{"type":"text"}]}).to_string();
    for (body, messages) in [
        (String::new(), false),
        (String::new(), true),
        (chat_missing.to_string(), false),
        (messages_missing, true),
        (
            json!({"stop_reason":"end_turn","content":[]}).to_string(),
            true,
        ),
    ] {
        let (url, received, worker) = http_fixture("200 OK", body.clone(), Duration::ZERO);
        let mut config = config_http(&url);
        if messages {
            config.profiles[0].connection = Connection::Messages {
                base_url: url,
                allow_insecure_http: true,
                credential: Credential::None,
            };
        }
        let (_root, service) = fixture_service(config);
        let error = service
            .generate("plugin:a".into(), request("x"), Arc::new(|| false), None)
            .await
            .unwrap_err();
        assert_eq!(error.code, "invalid_response", "{body}");
        assert!(!error.message.contains("assistant"));
        received.recv().unwrap();
        worker.join().unwrap();
    }
}
