use super::*;
use credentials::{MemorySecrets, SecretStore};
use std::{
    fs,
    io::{Read, Write},
    net::TcpListener,
    path::Path,
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
#[cfg(unix)]
fn fake_cli(path: &Path, kind: &str, delay: bool) -> std::path::PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let script = path.join(kind);
    let source = format!(
        r#"#!/usr/bin/env python3
import sys,json,os,time
if '--help' in sys.argv:
 print('--ignore-user-config --ignore-rules --ephemeral --json --model --safe-mode --restricted --tools --setting-sources --strict-mcp-config --no-session-persistence --output-format');sys.exit(0)
a=sys.argv
assert '--model' in a and a[a.index('--model')+1]=='fixture-model'
assert os.getcwd()!={repo:?}
input=sys.stdin.read()
assert 'An example prompt' in input
if {kind:?}=='codex':
 assert '--ignore-user-config' in a and '--ignore-rules' in a and '--ephemeral' in a
 assert 'shell_tool' in a and 'hooks' in a and 'apps' in a
else:
 assert '--safe-mode' in a and '--restricted' in a and '--strict-mcp-config' in a
 assert a[a.index('--tools')+1]=='' and a[a.index('--setting-sources')+1]==''
if {delay}:
 time.sleep(3)
if {kind:?}=='codex':
 print(json.dumps({{'type':'item.completed','item':{{'type':'reasoning','text':'Do not return reasoning'}}}}))
 print(json.dumps({{'type':'item.completed','item':{{'type':'agent_message','text':'Fixture title'}}}}))
 print(json.dumps({{'type':'turn.completed','usage':{{'input_tokens':10,'output_tokens':2}}}}))
else:
 print(json.dumps({{'type':'result','subtype':'success','is_error':False,'result':'Fixture title'}}))
"#,
        repo = std::env::current_dir().unwrap().to_string_lossy(),
        kind = kind,
        delay = if delay { "True" } else { "False" }
    );
    fs::write(&script, source).unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
    script
}
#[cfg(unix)]
#[tokio::test]
async fn both_cli_adapters_enforce_isolated_args_and_extract_final_text() {
    for kind in ["codex", "claude"] {
        let root = tempfile::tempdir().unwrap();
        let executable = fake_cli(root.path(), kind, false);
        let mut c = config_http("https://example.test/v1");
        c.profiles[0].model = "fixture-model".into();
        c.profiles[0].connection = if kind == "codex" {
            Connection::Codex {
                executable_path: executable.to_string_lossy().into(),
            }
        } else {
            Connection::Claude {
                executable_path: executable.to_string_lossy().into(),
            }
        };
        let profile = c.profiles.remove(0);
        let request: Request = serde_json::from_value(request("x")).unwrap();
        let now = Instant::now();
        let control = Control {
            cancelled: AtomicBool::new(false),
            active: AtomicBool::new(false),
            deadline: Mutex::new(now + Duration::from_secs(2)),
            started: now,
            owner: Arc::new(|| false),
        };
        let result = tokio::task::spawn_blocking(move || {
            adapters::candidate_cli_for_test(&profile, &request, &control)
        })
        .await
        .unwrap()
        .unwrap();
        assert_eq!(result, "Fixture title");
    }
}
#[cfg(unix)]
#[tokio::test]
async fn cli_deadline_terminates_owned_process_before_return() {
    let root = tempfile::tempdir().unwrap();
    let executable = fake_cli(root.path(), "codex", true);
    let mut c = config_http("https://example.test/v1");
    c.profiles[0].model = "fixture-model".into();
    c.profiles[0].connection = Connection::Codex {
        executable_path: executable.to_string_lossy().into(),
    };
    let profile = c.profiles.remove(0);
    let request: Request = serde_json::from_value(request("x")).unwrap();
    let now = Instant::now();
    let control = Control {
        cancelled: AtomicBool::new(false),
        active: AtomicBool::new(false),
        deadline: Mutex::new(now + Duration::from_millis(150)),
        started: now,
        owner: Arc::new(|| false),
    };
    let started = Instant::now();
    assert_eq!(
        tokio::task::spawn_blocking(move || adapters::candidate_cli_for_test(
            &profile, &request, &control
        ))
        .await
        .unwrap()
        .unwrap_err()
        .code,
        "timed_out"
    );
    assert!(started.elapsed() < Duration::from_secs(2));
}

#[tokio::test]
async fn cancellation_before_admission_never_reaches_provider() {
    let (_root, service) = fixture_service(config_http("http://127.0.0.1:1/v1"));
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
    store
        .fail_next_commit_after_replace
        .store(true, Ordering::Relaxed);
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
    service
        .store
        .save(config_http("http://127.0.0.1:1/v1"), 0)
        .unwrap();
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
    let reserve = local_slots().acquire_many_owned(3).await.unwrap();
    let task =
        tokio::spawn(service.generate("plugin:a".into(), request("x"), Arc::new(|| false), None));
    tokio::task::spawn_blocking(move || started_rx.recv_timeout(Duration::from_secs(2)).unwrap())
        .await
        .unwrap();
    task.abort();
    let _ = task.await;
    let (_other_root, other) = fixture_service(config_http("http://127.0.0.1:1/v1"));
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
#[cfg(unix)]
#[tokio::test]
async fn unavailable_cli_never_starts_executable_even_for_describe() {
    use std::os::unix::fs::PermissionsExt;
    for kind in ["codex", "claude"] {
        let root = tempfile::tempdir().unwrap();
        let marker = root.path().join("must-not-start");
        let executable = root.path().join(kind);
        fs::write(
            &executable,
            format!(
                "#!/usr/bin/env python3\nopen({:?},'w').write('started')\n",
                marker.to_string_lossy()
            ),
        )
        .unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        let mut config = config_http("https://fixture.test/v1");
        config.profiles[0].connection = if kind == "codex" {
            Connection::Codex {
                executable_path: executable.to_string_lossy().into(),
            }
        } else {
            Connection::Claude {
                executable_path: executable.to_string_lossy().into(),
            }
        };
        let (_config_root, service) = fixture_service(config);
        let described = service.describe().unwrap();
        assert!(!described.available);
        assert_eq!(described.error.unwrap().code, "unavailable");
        assert_eq!(
            service
                .generate("plugin:a".into(), request("x"), Arc::new(|| false), None)
                .await
                .unwrap_err()
                .code,
            "unavailable"
        );
        assert!(!marker.exists());
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
        base_url: "http://127.0.0.1:1/v1".into(),
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
    let (_root, service) = fixture_service(config_http("http://127.0.0.1:1/v1"));
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
