//! Capability and HTTP outcomes against the production service and real TCP.
//! These tests do not claim media decoder, native WebView, or immutable-snapshot proof.
use super::{http, service::Service};
use crate::renderer_owner::Owner;
use std::{
    collections::HashMap,
    fs::{self, File, FileTimes},
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    sync::Arc,
    time::{Duration, SystemTime},
};
use tempfile::TempDir;

struct Fixture {
    root: TempDir,
    server: Arc<http::Server>,
    owner: Owner,
    token: String,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.server.stop.retire();
        self.owner.retire();
        self.server.service.retire_owners();
    }
}

impl Fixture {
    async fn new(bytes: &[u8]) -> Self {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("clip.mp4");
        fs::write(&path, bytes).unwrap();
        let server = http::start(Arc::new(Service::default())).await.unwrap();
        let owner = Owner::default();
        let token = server.service.begin(owner.clone()).unwrap();
        server
            .service
            .prepare(&token, &owner, path.to_string_lossy().into_owned(), |_| {
                true
            })
            .await
            .unwrap();
        Self {
            root,
            server,
            owner,
            token,
        }
    }

    async fn request(&self, method: &str, headers: &str) -> Reply {
        request(&self.server, &self.token, method, headers).await
    }
}

#[derive(Debug)]
struct Reply {
    status: u16,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

fn parse_reply(raw: &[u8]) -> Reply {
    let boundary = raw.windows(4).position(|part| part == b"\r\n\r\n").unwrap();
    let mut lines = std::str::from_utf8(&raw[..boundary]).unwrap().split("\r\n");
    let status = lines
        .next()
        .unwrap()
        .split_whitespace()
        .nth(1)
        .unwrap()
        .parse()
        .unwrap();
    let headers = lines
        .map(|line| {
            let (name, value) = line.split_once(':').unwrap();
            (name.to_ascii_lowercase(), value.trim().to_string())
        })
        .collect();
    Reply {
        status,
        headers,
        body: raw[boundary + 4..].to_vec(),
    }
}

async fn exchange(address: SocketAddr, message: String) -> Reply {
    let raw = tokio::task::spawn_blocking(move || {
        let mut socket = TcpStream::connect_timeout(&address, Duration::from_secs(5)).unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        socket
            .set_write_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        socket.write_all(message.as_bytes()).unwrap();
        let mut raw = Vec::new();
        socket.read_to_end(&mut raw).unwrap();
        raw
    })
    .await
    .unwrap();
    parse_reply(&raw)
}

async fn request(server: &http::Server, token: &str, method: &str, headers: &str) -> Reply {
    exchange(
        server.address,
        format!(
            "{method} /media/{token} HTTP/1.1\r\nHost: {}\r\n{headers}\r\n",
            server.address
        ),
    )
    .await
}

fn assert_bytes(reply: &Reply, status: u16, bytes: &[u8], content_range: Option<&str>) {
    assert_eq!(reply.status, status, "{reply:?}");
    assert_eq!(reply.body, bytes);
    assert_eq!(
        reply.headers.get("content-length").unwrap(),
        &bytes.len().to_string()
    );
    assert_eq!(
        reply.headers.get("content-type").map(String::as_str),
        Some("video/mp4")
    );
    assert_eq!(
        reply.headers.get("accept-ranges").map(String::as_str),
        Some("bytes")
    );
    assert_eq!(
        reply.headers.get("cache-control").map(String::as_str),
        Some("no-store")
    );
    assert_eq!(
        reply
            .headers
            .get("x-content-type-options")
            .map(String::as_str),
        Some("nosniff")
    );
    assert_eq!(
        reply.headers.get("content-range").map(String::as_str),
        content_range
    );
}

#[tokio::test]
async fn cancelled_range_waits_do_not_delay_a_later_real_read() {
    use futures_util::FutureExt;
    let service = Service::default();
    let owner = Owner::default();
    let token = service.begin(owner).unwrap();
    let lease = service.lookup(&token).unwrap();
    lease.admit_read(1024 * 1024).await.unwrap();
    for _ in 0..1024 {
        let _ = lease.admit_read(64 * 1024).now_or_never();
    }
    tokio::time::timeout(Duration::from_millis(250), lease.admit_read(64 * 1024))
        .await
        .expect("cancelled requests charged unconsumed transfer")
        .unwrap();
}

#[tokio::test]
async fn concurrent_range_admission_shares_one_burst_and_rate_budget() {
    let service = Service::default();
    let owner = Owner::default();
    let token = service.begin(owner).unwrap();
    let lease = service.lookup(&token).unwrap();
    lease.admit_read(1024 * 1024).await.unwrap();
    let started = std::time::Instant::now();
    let consume = || async {
        for _ in 0..128 {
            lease.admit_read(64 * 1024).await?;
        }
        Ok::<_, std::io::Error>(())
    };
    let (first, second) = tokio::join!(consume(), consume());
    first.unwrap();
    second.unwrap();
    assert!(
        started.elapsed() >= Duration::from_millis(900),
        "parallel ranges bypassed the aggregate 16 MiB/s allowance"
    );
}

#[tokio::test]
async fn renderer_retirement_cancels_queued_read_admission_promptly() {
    use futures_util::FutureExt;
    let service = Service::default();
    let owner = Owner::default();
    let token = service.begin(owner.clone()).unwrap();
    let lease = service.lookup(&token).unwrap();
    lease.admit_read(1024 * 1024).await.unwrap();
    let pending = lease.admit_read(1024 * 1024);
    tokio::pin!(pending);
    assert!(pending.as_mut().now_or_never().is_none());
    owner.retire();
    let result = tokio::time::timeout(Duration::from_millis(250), pending)
        .await
        .unwrap();
    assert_eq!(result.unwrap_err().kind(), std::io::ErrorKind::Interrupted);
}

#[tokio::test]
async fn exact_full_closed_open_suffix_and_clamped_ranges() {
    let fixture = Fixture::new(b"0123456789").await;
    for (header, status, bytes, range) in [
        ("", 200, &b"0123456789"[..], None),
        (
            "Range: bytes=2-4\r\n",
            206,
            &b"234"[..],
            Some("bytes 2-4/10"),
        ),
        (
            "Range: bytes=7-\r\n",
            206,
            &b"789"[..],
            Some("bytes 7-9/10"),
        ),
        (
            "Range: bytes=-3\r\n",
            206,
            &b"789"[..],
            Some("bytes 7-9/10"),
        ),
        (
            "Range: bytes=8-999\r\n",
            206,
            &b"89"[..],
            Some("bytes 8-9/10"),
        ),
        (
            "Range: bytes=-999\r\n",
            206,
            &b"0123456789"[..],
            Some("bytes 0-9/10"),
        ),
        ("Range: bytes=0-0\r\n", 206, &b"0"[..], Some("bytes 0-0/10")),
    ] {
        assert_bytes(&fixture.request("GET", header).await, status, bytes, range);
    }
}

#[tokio::test]
async fn head_ignores_range_and_has_full_headers_without_a_body() {
    let fixture = Fixture::new(b"0123456789").await;
    for header in ["", "Range: bytes=2-4\r\n", "Range: bytes=999-\r\n"] {
        let reply = fixture.request("HEAD", header).await;
        assert_eq!(reply.status, 200);
        assert!(reply.body.is_empty());
        assert_eq!(
            reply.headers.get("content-length").map(String::as_str),
            Some("10")
        );
        assert_eq!(
            reply.headers.get("content-type").map(String::as_str),
            Some("video/mp4")
        );
        assert!(!reply.headers.contains_key("content-range"));
    }
}

#[tokio::test]
async fn invalid_multiple_and_unvalidated_if_range_fields_send_full_exact_bytes() {
    let fixture = Fixture::new(b"0123456789").await;
    for headers in [
        "Range: items=0-1\r\n",
        "Range: bytes=3-1\r\n",
        "Range: bytes=+1-2\r\n",
        "Range: bytes=0-1,4-5\r\n",
        "Range: bytes=0-18446744073709551616\r\n",
        "Range: bytes=0-1\r\nRange: bytes=4-5\r\n",
        "Range: bytes=2-4\r\nIf-Range: \"unknown-validator\"\r\n",
        "Range: bytes=999-\r\nIf-Range: Wed, 21 Oct 2015 07:28:00 GMT\r\n",
    ] {
        assert_bytes(
            &fixture.request("GET", headers).await,
            200,
            b"0123456789",
            None,
        );
    }
}

#[tokio::test]
async fn unsatisfied_and_empty_file_ranges_return_416_without_bytes() {
    let fixture = Fixture::new(b"0123456789").await;
    for header in [
        "Range: bytes=10-\r\n",
        "Range: bytes=99-100\r\n",
        "Range: bytes=-0\r\n",
    ] {
        let reply = fixture.request("GET", header).await;
        assert_eq!(reply.status, 416);
        assert!(reply.body.is_empty());
        assert_eq!(
            reply.headers.get("content-range").map(String::as_str),
            Some("bytes */10")
        );
    }
    let empty = Fixture::new(b"").await;
    assert_bytes(&empty.request("GET", "").await, 200, b"", None);
    let reply = empty.request("GET", "Range: bytes=0-0\r\n").await;
    assert_eq!(reply.status, 416);
    assert_eq!(
        reply.headers.get("content-range").map(String::as_str),
        Some("bytes */0")
    );
    assert!(reply.body.is_empty());
}

#[tokio::test]
async fn concurrent_multi_chunk_ranges_have_independent_exact_cursors() {
    let bytes: Vec<_> = (0..300_000)
        .map(|index| ((index * 37 + 11) % 251) as u8)
        .collect();
    let fixture = Fixture::new(&bytes).await;
    let (first, second, third, fourth) = tokio::join!(
        fixture.request("GET", "Range: bytes=0-140000\r\n"),
        fixture.request("GET", "Range: bytes=100000-299999\r\n"),
        fixture.request("GET", "Range: bytes=-80000\r\n"),
        fixture.request("GET", "Range: bytes=64000-200000\r\n"),
    );
    assert_bytes(
        &first,
        206,
        &bytes[..140_001],
        Some("bytes 0-140000/300000"),
    );
    assert_bytes(
        &second,
        206,
        &bytes[100_000..],
        Some("bytes 100000-299999/300000"),
    );
    assert_bytes(
        &third,
        206,
        &bytes[220_000..],
        Some("bytes 220000-299999/300000"),
    );
    assert_bytes(
        &fourth,
        206,
        &bytes[64_000..200_001],
        Some("bytes 64000-200000/300000"),
    );
}

#[tokio::test]
async fn busy_file_admission_is_retryable_using_the_same_capability() {
    let fixture = Fixture::new(b"ready").await;
    let token = fixture.server.service.begin(fixture.owner.clone()).unwrap();
    let held = fixture
        .server
        .service
        .opens
        .clone()
        .try_acquire_many_owned(4)
        .unwrap();
    let path = fixture
        .root
        .path()
        .join("clip.mp4")
        .to_string_lossy()
        .into_owned();
    let error = fixture
        .server
        .service
        .prepare(&token, &fixture.owner, path.clone(), |_| true)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("busy"), "{error}");
    assert_eq!(
        request(&fixture.server, &token, "GET", "").await.status,
        404
    );
    drop(held);
    fixture
        .server
        .service
        .prepare(&token, &fixture.owner, path, |_| true)
        .await
        .unwrap();
    assert_bytes(
        &request(&fixture.server, &token, "GET", "").await,
        200,
        b"ready",
        None,
    );
}

#[tokio::test]
async fn exhausted_stream_admission_returns_503_then_recovers_without_repreparing() {
    let fixture = Fixture::new(b"ready").await;
    let held = fixture
        .server
        .service
        .streams
        .clone()
        .try_acquire_many_owned(16)
        .unwrap();
    let busy = fixture.request("GET", "").await;
    assert_eq!(busy.status, 503);
    assert!(busy.body.is_empty());
    // Metadata-only HEAD does not require a streaming slot.
    assert_eq!(fixture.request("HEAD", "").await.status, 200);
    drop(held);
    assert_bytes(&fixture.request("GET", "").await, 200, b"ready", None);
}

#[tokio::test]
async fn wrong_renderer_cannot_prepare_or_release_another_renderers_capability() {
    let fixture = Fixture::new(b"owned").await;
    let other = Owner::default();
    let provisional = fixture.server.service.begin(fixture.owner.clone()).unwrap();
    let path = fixture
        .root
        .path()
        .join("clip.mp4")
        .to_string_lossy()
        .into_owned();
    assert!(fixture
        .server
        .service
        .prepare(&provisional, &other, path, |_| true)
        .await
        .is_err());
    fixture.server.service.release(&fixture.token, &other);
    assert_bytes(&fixture.request("GET", "").await, 200, b"owned", None);
    fixture
        .server
        .service
        .release(&fixture.token, &fixture.owner);
    assert_eq!(fixture.request("GET", "").await.status, 404);
}

#[tokio::test]
async fn renderer_retirement_invalidates_every_url_and_rejects_late_begin() {
    let fixture = Fixture::new(b"old renderer").await;
    fixture.owner.retire();
    fixture.server.service.retire_owners();
    assert_eq!(fixture.request("GET", "").await.status, 404);
    assert!(fixture.server.service.begin(fixture.owner.clone()).is_err());
    let fresh = Owner::default();
    let token = fixture.server.service.begin(fresh.clone()).unwrap();
    fixture
        .server
        .service
        .prepare(
            &token,
            &fresh,
            fixture
                .root
                .path()
                .join("clip.mp4")
                .to_string_lossy()
                .into_owned(),
            |_| true,
        )
        .await
        .unwrap();
    assert_bytes(
        &request(&fixture.server, &token, "GET", "").await,
        200,
        b"old renderer",
        None,
    );
    fixture.server.service.release(&token, &fresh);
}

#[test]
fn owner_and_global_capability_bounds_recover_after_release_and_retirement() {
    let service = Service::default();
    let owner = Owner::default();
    let tokens: Vec<_> = (0..4)
        .map(|_| service.begin(owner.clone()).unwrap())
        .collect();
    assert!(service.begin(owner.clone()).is_err());
    service.release(&tokens[0], &owner);
    assert!(service.begin(owner.clone()).is_ok());
    owner.retire();
    service.retire_owners();
    let owners: Vec<_> = (0..16).map(|_| Owner::default()).collect();
    for owner in &owners {
        for _ in 0..4 {
            service.begin(owner.clone()).unwrap();
        }
    }
    let fresh = Owner::default();
    assert!(service.begin(fresh.clone()).is_err());
    owners[0].retire();
    service.retire_owners();
    assert!(service.begin(fresh).is_ok());
}

#[tokio::test]
async fn denied_scope_non_video_and_directory_admission_never_publish_a_url() {
    let fixture = Fixture::new(b"good").await;
    let denied = fixture.server.service.begin(fixture.owner.clone()).unwrap();
    let path = fixture
        .root
        .path()
        .join("clip.mp4")
        .to_string_lossy()
        .into_owned();
    assert!(fixture
        .server
        .service
        .prepare(&denied, &fixture.owner, path, |_| false)
        .await
        .is_err());
    assert_eq!(
        request(&fixture.server, &denied, "GET", "").await.status,
        404
    );
    let text = fixture.root.path().join("clip.txt");
    fs::write(&text, b"not a video").unwrap();
    let directory = fixture.root.path().join("directory.mp4");
    fs::create_dir(&directory).unwrap();
    for path in [text, directory] {
        let token = fixture.server.service.begin(fixture.owner.clone()).unwrap();
        assert!(fixture
            .server
            .service
            .prepare(
                &token,
                &fixture.owner,
                path.to_string_lossy().into_owned(),
                |_| true
            )
            .await
            .is_err());
        assert_eq!(
            request(&fixture.server, &token, "GET", "").await.status,
            404
        );
    }
}

#[cfg(unix)]
#[tokio::test]
async fn an_allowed_symlink_cannot_admit_a_denied_canonical_target() {
    use std::os::unix::fs::symlink;
    let fixture = Fixture::new(b"good").await;
    let target = fixture.root.path().join("private.mp4");
    fs::write(&target, b"private").unwrap();
    let denied_target = target.canonicalize().unwrap();
    let alias = fixture.root.path().join("allowed.mp4");
    symlink(&target, &alias).unwrap();
    let token = fixture.server.service.begin(fixture.owner.clone()).unwrap();
    assert!(fixture
        .server
        .service
        .prepare(
            &token,
            &fixture.owner,
            alias.to_string_lossy().into_owned(),
            move |path| path != denied_target.as_path()
        )
        .await
        .is_err());
    assert_eq!(
        request(&fixture.server, &token, "GET", "").await.status,
        404
    );
}

#[cfg(unix)]
#[tokio::test]
async fn named_pipe_admission_finishes_with_an_error_without_waiting_for_a_writer() {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    let fixture = Fixture::new(b"good").await;
    let pipe = fixture.root.path().join("pipe.mp4");
    let native = CString::new(pipe.as_os_str().as_bytes()).unwrap();
    // SAFETY: native is a valid NUL-terminated path owned for this call.
    assert_eq!(unsafe { libc::mkfifo(native.as_ptr(), 0o600) }, 0);
    let token = fixture.server.service.begin(fixture.owner.clone()).unwrap();
    let result = tokio::time::timeout(
        Duration::from_secs(2),
        fixture.server.service.prepare(
            &token,
            &fixture.owner,
            pipe.to_string_lossy().into_owned(),
            |_| true,
        ),
    )
    .await
    .unwrap();
    assert!(result.is_err());
    assert_eq!(
        request(&fixture.server, &token, "GET", "").await.status,
        404
    );
}

#[tokio::test]
async fn replacement_and_changed_file_revision_are_rejected_before_serving_bytes() {
    let fixture = Fixture::new(b"original").await;
    let path = fixture.root.path().join("clip.mp4");
    fs::rename(&path, fixture.root.path().join("old.mp4")).unwrap();
    fs::write(&path, b"replaced").unwrap();
    let replaced = fixture.request("GET", "").await;
    assert_eq!(replaced.status, 409);
    assert!(replaced.body.is_empty());
    let fixture = Fixture::new(b"original").await;
    let path = fixture.root.path().join("clip.mp4");
    let file = File::options().write(true).open(&path).unwrap();
    file.set_len(2).unwrap();
    let changed = fixture.request("GET", "").await;
    assert_eq!(changed.status, 409);
    assert!(changed.body.is_empty());
    let fixture = Fixture::new(b"original").await;
    let path = fixture.root.path().join("clip.mp4");
    fs::write(&path, b"newbytes").unwrap();
    File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_times(
            FileTimes::new().set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000)),
        )
        .unwrap();
    let changed = fixture.request("GET", "").await;
    assert_eq!(changed.status, 409);
    assert!(changed.body.is_empty());
}

#[tokio::test]
async fn malformed_request_authority_query_method_and_body_cannot_read_media() {
    let fixture = Fixture::new(b"secret").await;
    let host = fixture.server.address;
    let path = format!("/media/{}", fixture.token);
    for (message, status) in [
        (
            format!("GET {path} HTTP/1.1\r\nHost: example.com\r\n\r\n"),
            400,
        ),
        (
            format!("GET http://example.com{path} HTTP/1.1\r\nHost: {host}\r\n\r\n"),
            400,
        ),
        (
            format!("GET {path}?path=clip.mp4 HTTP/1.1\r\nHost: {host}\r\n\r\n"),
            400,
        ),
        (
            format!("POST {path} HTTP/1.1\r\nHost: {host}\r\nContent-Length: 0\r\n\r\n"),
            405,
        ),
        (
            format!("GET {path} HTTP/1.1\r\nHost: {host}\r\nContent-Length: 1\r\n\r\nx"),
            400,
        ),
        (
            format!("GET {path}/extra HTTP/1.1\r\nHost: {host}\r\n\r\n"),
            404,
        ),
        (
            format!(
                "GET /media/{} HTTP/1.1\r\nHost: {host}\r\n\r\n",
                "0".repeat(48)
            ),
            404,
        ),
    ] {
        let reply = exchange(host, message).await;
        assert_eq!(reply.status, status);
        assert!(reply.body.is_empty());
    }
}

#[tokio::test]
async fn released_preparation_retains_admission_until_the_actual_worker_returns() {
    let fixture = Fixture::new(b"good").await;
    let token = fixture.server.service.begin(fixture.owner.clone()).unwrap();
    let (started, observed) = tokio::sync::oneshot::channel();
    let started = std::sync::Mutex::new(Some(started));
    let (unblock, blocked) = std::sync::mpsc::channel();
    let blocked = std::sync::Mutex::new(blocked);
    let service = fixture.server.service.clone();
    let owner = fixture.owner.clone();
    let preparing_token = token.clone();
    let path = fixture
        .root
        .path()
        .join("clip.mp4")
        .to_string_lossy()
        .into_owned();
    let preparing = tokio::spawn(async move {
        service
            .prepare(&preparing_token, &owner, path, move |_| {
                if let Some(started) = started.lock().unwrap().take() {
                    started.send(()).unwrap();
                    blocked
                        .lock()
                        .unwrap()
                        .recv_timeout(Duration::from_secs(5))
                        .unwrap();
                }
                true
            })
            .await
    });
    tokio::time::timeout(Duration::from_secs(2), observed)
        .await
        .unwrap()
        .unwrap();
    fixture.server.service.release(&token, &fixture.owner);
    assert_eq!(
        request(&fixture.server, &token, "GET", "").await.status,
        404
    );
    assert!(fixture
        .server
        .service
        .opens
        .clone()
        .try_acquire_many_owned(4)
        .is_err());
    unblock.send(()).unwrap();
    assert!(tokio::time::timeout(Duration::from_secs(2), preparing)
        .await
        .unwrap()
        .unwrap()
        .is_err());
    assert!(fixture
        .server
        .service
        .opens
        .clone()
        .try_acquire_many_owned(4)
        .is_ok());
    assert_eq!(
        request(&fixture.server, &token, "GET", "").await.status,
        404
    );
}

async fn stalled_client(server: &http::Server, token: &str) -> TcpStream {
    let address = server.address;
    let message = format!("GET /media/{token} HTTP/1.1\r\nHost: {address}\r\n\r\n");
    tokio::task::spawn_blocking(move || {
        let mut client = TcpStream::connect_timeout(&address, Duration::from_secs(5)).unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        client.write_all(message.as_bytes()).unwrap();
        let mut header = Vec::new();
        while !header.ends_with(b"\r\n\r\n") {
            let mut byte = [0];
            client.read_exact(&mut byte).unwrap();
            header.push(byte[0]);
            assert!(header.len() < 16 * 1024);
        }
        assert_eq!(parse_reply(&header).status, 200);
        client
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn retirement_closes_a_genuinely_stalled_socket_and_releases_stream_admission() {
    for retire_renderer in [false, true] {
        let fixture = Fixture::new(b"").await;
        fixture
            .server
            .service
            .release(&fixture.token, &fixture.owner);
        let path = fixture.root.path().join("large.mp4");
        const SIZE: u64 = 128 * 1024 * 1024;
        File::create(&path).unwrap().set_len(SIZE).unwrap();
        let token = fixture.server.service.begin(fixture.owner.clone()).unwrap();
        fixture
            .server
            .service
            .prepare(
                &token,
                &fixture.owner,
                path.to_string_lossy().into_owned(),
                |_| true,
            )
            .await
            .unwrap();
        let client = stalled_client(&fixture.server, &token).await;
        // A large unread body cannot fit in the TCP buffers; the stream is still admitted.
        assert!(fixture
            .server
            .service
            .streams
            .clone()
            .try_acquire_many_owned(16)
            .is_err());
        if retire_renderer {
            fixture.owner.retire();
            fixture.server.service.retire_owners();
        } else {
            fixture.server.service.release(&token, &fixture.owner);
        }
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if let Ok(permit) = fixture
                    .server
                    .service
                    .streams
                    .clone()
                    .try_acquire_many_owned(16)
                {
                    drop(permit);
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let received = tokio::task::spawn_blocking(move || {
            let mut client = client;
            client
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut total = 0u64;
            let mut buffer = [0; 16 * 1024];
            loop {
                match client.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(count) => total += count as u64,
                    Err(error)
                        if matches!(
                            error.kind(),
                            std::io::ErrorKind::ConnectionReset
                                | std::io::ErrorKind::ConnectionAborted
                        ) =>
                    {
                        break
                    }
                    Err(error) => panic!("retired socket stayed open: {error}"),
                }
                assert!(
                    total < SIZE,
                    "retired stream completed instead of being interrupted"
                );
            }
            total
        })
        .await
        .unwrap();
        assert!(received < SIZE);
        assert_eq!(
            request(&fixture.server, &token, "GET", "").await.status,
            404
        );
    }
}

// Companion audio (#1171): the production extractor runs a scripted ffmpeg so
// decode success, fallback, absence and cancellation are deterministic.
#[cfg(unix)]
mod companion_audio {
    use super::super::audio::{lists_audio_stream, Extractor};
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    /// Probe lists `streams`; an encode runs `encode` with `$out` as its output path.
    fn fake_ffmpeg(root: &std::path::Path, streams: &str, encode: &str) -> std::path::PathBuf {
        let script = root.join("ffmpeg");
        fs::write(
            &script,
            format!(
                "#!/bin/sh\necho \"$*\" >> \"{calls}\"\nfor a; do out=$a; done\ncase \" $* \" in\n  *\" -map \"*) {encode} ;;\n  *) printf '%s\\n' \"Input #0, mov,mp4, from 'clip.mp4':\" {streams} >&2; exit 1 ;;\nesac\n",
                calls = root.join("calls").display(),
            ),
        )
        .unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        script
    }
    const VIDEO_AND_AAC: &str =
        "'  Stream #0:0[0x1](und): Video: h264 (High), yuv420p, 1920x1080' '  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo'";
    const VIDEO_ONLY: &str = "'  Stream #0:0[0x1](und): Video: h264 (High), yuv420p, 1920x1080'";

    struct Audio {
        fixture: Fixture,
        directory: std::path::PathBuf,
        ffmpeg: std::path::PathBuf,
        token: String,
    }
    impl Audio {
        async fn new(streams: &str, encode: &str) -> Self {
            let fixture = Fixture::new(b"video bytes").await;
            let ffmpeg = fake_ffmpeg(fixture.root.path(), streams, encode);
            let directory = fixture.root.path().join("derived");
            let token = fixture.server.service.begin(fixture.owner.clone()).unwrap();
            Self {
                fixture,
                directory,
                ffmpeg,
                token,
            }
        }
        fn extractor(&self) -> Extractor {
            Extractor {
                ffmpeg: self.ffmpeg.clone(),
                directory: self.directory.clone(),
                stem: self.token.clone(),
            }
        }
        async fn prepare(&self, allowed: bool) -> Result<bool, crate::error::AppError> {
            let path = self
                .fixture
                .root
                .path()
                .join("clip.mp4")
                .to_string_lossy()
                .into_owned();
            self.fixture
                .server
                .service
                .prepare_audio(
                    &self.token,
                    &self.fixture.owner,
                    path,
                    move |_| allowed,
                    self.extractor(),
                )
                .await
        }
        async fn get(&self) -> Reply {
            request(&self.fixture.server, &self.token, "GET", "").await
        }
        fn derived(&self) -> Vec<String> {
            fs::read_dir(&self.directory)
                .map(|entries| {
                    entries
                        .flatten()
                        .map(|entry| entry.file_name().to_string_lossy().into_owned())
                        .collect()
                })
                .unwrap_or_default()
        }
        fn calls(&self) -> String {
            fs::read_to_string(self.fixture.root.path().join("calls")).unwrap_or_default()
        }
    }

    #[tokio::test]
    async fn decoded_audio_is_served_as_its_own_capability_and_deleted_on_release() {
        let audio = Audio::new(VIDEO_AND_AAC, "printf 'OPUS-AUDIO' > \"$out\"").await;
        assert!(audio.prepare(true).await.unwrap());
        let reply = audio.get().await;
        assert_eq!(reply.status, 200, "{reply:?}");
        assert_eq!(reply.body, b"OPUS-AUDIO");
        assert_eq!(
            reply.headers.get("content-type").map(String::as_str),
            Some("audio/webm")
        );
        let calls = audio.calls();
        assert!(
            calls.contains("-map 0:a:0 -vn -sn -dn -ac 2 -c:a libopus"),
            "{calls}"
        );
        assert_eq!(audio.derived(), [format!("{}.webm", audio.token)]);
        // The source video itself is never written.
        assert_eq!(
            fs::read(audio.fixture.root.path().join("clip.mp4")).unwrap(),
            b"video bytes"
        );

        audio
            .fixture
            .server
            .service
            .release(&audio.token, &audio.fixture.owner);
        assert_eq!(audio.get().await.status, 404);
        assert!(audio.derived().is_empty(), "{:?}", audio.derived());
    }

    #[tokio::test]
    async fn an_ffmpeg_without_libopus_falls_back_to_flac() {
        let audio = Audio::new(
            VIDEO_AND_AAC,
            "case \"$*\" in *libopus*) echo 'Unknown encoder libopus' >&2; printf partial > \"$out\"; exit 1 ;; esac; printf 'FLAC-AUDIO' > \"$out\"",
        ).await;
        assert!(audio.prepare(true).await.unwrap());
        let reply = audio.get().await;
        assert_eq!(reply.body, b"FLAC-AUDIO");
        assert_eq!(
            reply.headers.get("content-type").map(String::as_str),
            Some("audio/flac")
        );
        assert_eq!(audio.derived(), [format!("{}.flac", audio.token)]);
    }

    #[tokio::test]
    async fn a_video_without_audio_publishes_nothing_and_never_decodes() {
        let audio = Audio::new(VIDEO_ONLY, "printf 'X' > \"$out\"").await;
        assert!(!audio.prepare(true).await.unwrap());
        assert_eq!(audio.get().await.status, 404);
        assert!(!audio.calls().contains("-map"), "{}", audio.calls());
        assert!(audio.derived().is_empty());
    }

    #[tokio::test]
    async fn a_failed_decode_reports_an_error_and_leaves_no_file() {
        let audio = Audio::new(
            VIDEO_AND_AAC,
            "printf partial > \"$out\"; echo 'Invalid data found' >&2; exit 1",
        )
        .await;
        let error = audio.prepare(true).await.unwrap_err().to_string();
        assert!(error.contains("Invalid data found"), "{error}");
        assert_eq!(audio.get().await.status, 404);
        assert!(audio.derived().is_empty(), "{:?}", audio.derived());
    }

    #[tokio::test]
    async fn denied_scope_never_runs_ffmpeg() {
        let audio = Audio::new(VIDEO_AND_AAC, "printf 'X' > \"$out\"").await;
        assert!(audio.prepare(false).await.is_err());
        assert_eq!(audio.calls(), "");
        assert_eq!(audio.get().await.status, 404);
    }

    #[tokio::test]
    async fn release_during_decode_kills_ffmpeg_and_removes_partial_output() {
        let audio =
            Arc::new(Audio::new(VIDEO_AND_AAC, "printf partial > \"$out\"; sleep 30").await);
        let running = audio.clone();
        let prepared = tokio::spawn(async move { running.prepare(true).await });
        let started = std::time::Instant::now();
        while audio.derived().is_empty() {
            assert!(
                started.elapsed() < Duration::from_secs(10),
                "decode never started"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        audio
            .fixture
            .server
            .service
            .release(&audio.token, &audio.fixture.owner);
        let result = tokio::time::timeout(Duration::from_secs(10), prepared)
            .await
            .expect("release did not interrupt the decode")
            .unwrap();
        assert!(result.is_err());
        assert!(audio.derived().is_empty(), "{:?}", audio.derived());
        assert!(started.elapsed() < Duration::from_secs(20));
    }

    #[test]
    fn ffmpeg_stream_listing_distinguishes_audio_from_video_only_inputs() {
        let with_audio = "Input #0, matroska,webm, from 'a.mkv':\n  Metadata:\n    title: Audio: not a stream\n  Duration: 00:00:20.02, start: 0.000000, bitrate: 431 kb/s\n  Stream #0:0: Video: vp8, yuv420p(tv, progressive), 320x240, SAR 1:1 DAR 4:3, 30 fps\n  Stream #0:1: Audio: aac (LC), 48000 Hz, mono, fltp (default)\nAt least one output file must be specified\n";
        assert!(lists_audio_stream(with_audio));
        let video_only = "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'silent.mp4':\n  Metadata:\n    comment     : Audio: none\n  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p, 320x240, 30 fps\n";
        assert!(!lists_audio_stream(video_only));
    }
}
