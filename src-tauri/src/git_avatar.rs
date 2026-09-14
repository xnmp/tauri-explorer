//! Best-effort, privacy-gated author-avatar resolution and disk caching.
use base64::Engine;
use sha2::{Digest, Sha256};
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime};

const MAX_AVATAR_BYTES: usize = 256 * 1024;
const MAX_AVATAR_DIMENSION: u32 = 512;
const MISSING_TTL: Duration = Duration::from_secs(24 * 60 * 60);
const MAX_CACHE_ENTRIES: usize = 512;
const MAX_CACHE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_ACTIVE_FETCHES: usize = 4;

fn normalized_email(email: &str) -> String {
    email.trim().to_ascii_lowercase()
}
fn valid_github_login(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 39
        && !value.starts_with('-')
        && !value.ends_with('-')
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}
fn resolve_avatar_url(email: &str, gravatar_enabled: bool) -> Option<String> {
    let normalized = normalized_email(email);
    if normalized.is_empty() {
        return None;
    }
    const HOST: &str = "@users.noreply.github.com";
    if normalized.ends_with(HOST) {
        let local = &normalized[..normalized.len() - HOST.len()];
        if let Some((id, login)) = local.split_once('+') {
            if !id.is_empty()
                && id.bytes().all(|byte| byte.is_ascii_digit())
                && valid_github_login(login)
            {
                return Some(format!("https://avatars.githubusercontent.com/u/{id}?s=64"));
            }
        }
        return valid_github_login(local)
            .then(|| format!("https://avatars.githubusercontent.com/{local}?s=64"));
    }
    gravatar_enabled.then(|| {
        let hash = format!("{:x}", md5::compute(normalized.as_bytes()));
        format!("https://www.gravatar.com/avatar/{hash}?s=64&d=404")
    })
}
fn cache_paths(cache_dir: &Path, url: &str) -> (PathBuf, PathBuf) {
    let key = hex::encode(Sha256::digest(url.as_bytes()));
    (
        cache_dir.join(format!("{key}.image")),
        cache_dir.join(format!("{key}.missing")),
    )
}
fn image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.len() > MAX_AVATAR_BYTES {
        return None;
    }
    let format = image::guess_format(bytes).ok()?;
    let mime = match format {
        image::ImageFormat::Png => "image/png",
        image::ImageFormat::Jpeg => "image/jpeg",
        image::ImageFormat::WebP => "image/webp",
        _ => return None,
    };
    let (width, height) = image::ImageReader::with_format(Cursor::new(bytes), format)
        .into_dimensions()
        .ok()?;
    (width > 0 && height > 0 && width <= MAX_AVATAR_DIMENSION && height <= MAX_AVATAR_DIMENSION)
        .then_some(mime)
}
fn fresh_missing(path: &Path) -> bool {
    path.metadata()
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| SystemTime::now().duration_since(modified).ok())
        .is_some_and(|age| age < MISSING_TTL)
}
fn load_valid(path: &Path) -> Option<Vec<u8>> {
    let metadata = path.metadata().ok()?;
    if metadata.len() > MAX_AVATAR_BYTES as u64 {
        let _ = std::fs::remove_file(path);
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    if image_mime(&bytes).is_some() {
        Some(bytes)
    } else {
        let _ = std::fs::remove_file(path);
        None
    }
}
fn publish(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let temp = path.with_extension(format!("tmp-{}", std::process::id()));
    let result = std::fs::write(&temp, bytes).and_then(|()| std::fs::rename(&temp, path));
    if result.is_err() {
        let _ = std::fs::remove_file(temp);
    }
    result
}
fn prune_cache_to_with<F>(
    cache_dir: &Path,
    max_entries: usize,
    max_bytes: u64,
    mut remove_file: F,
) where
    F: FnMut(&Path) -> std::io::Result<()>,
{
    let Ok(entries) = std::fs::read_dir(cache_dir) else {
        return;
    };
    let mut files: Vec<_> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if path
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extension.starts_with("tmp-"))
            {
                let _ = remove_file(&path);
                return None;
            }
            let metadata = entry.metadata().ok()?;
            metadata.is_file().then(|| {
                (
                    path,
                    metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                    metadata.len(),
                )
            })
        })
        .collect();
    files.sort_by_key(|(_, modified, _)| *modified);
    let mut bytes: u64 = files.iter().map(|(_, _, len)| *len).sum();
    while files.len() > max_entries || bytes > max_bytes {
        let Some((path, _, len)) = files.first().cloned() else {
            break;
        };
        files.remove(0);
        if remove_file(&path).is_ok() {
            bytes = bytes.saturating_sub(len);
        }
    }
}
fn prune_cache_to(cache_dir: &Path, max_entries: usize, max_bytes: u64) {
    prune_cache_to_with(cache_dir, max_entries, max_bytes, |path| {
        std::fs::remove_file(path)
    });
}
fn load_or_fetch<F>(
    cache_dir: &Path,
    email: &str,
    gravatar_enabled: bool,
    fetch: F,
) -> Option<Vec<u8>>
where
    F: FnOnce(&str) -> Result<Vec<u8>, ()>,
{
    let url = resolve_avatar_url(email, gravatar_enabled)?;
    std::fs::create_dir_all(cache_dir).ok()?;
    prune_cache_to(cache_dir, MAX_CACHE_ENTRIES, MAX_CACHE_BYTES);
    let (image_path, missing_path) = cache_paths(cache_dir, &url);
    if let Some(bytes) = load_valid(&image_path) {
        return Some(bytes);
    }
    if fresh_missing(&missing_path) {
        return None;
    }
    match fetch(&url).ok().filter(|bytes| image_mime(bytes).is_some()) {
        Some(bytes) => {
            let _ = std::fs::remove_file(&missing_path);
            publish(&image_path, &bytes).ok()?;
            prune_cache_to(cache_dir, MAX_CACHE_ENTRIES, MAX_CACHE_BYTES);
            Some(bytes)
        }
        None => {
            let _ = std::fs::write(missing_path, []);
            prune_cache_to(cache_dir, MAX_CACHE_ENTRIES, MAX_CACHE_BYTES);
            None
        }
    }
}
fn fetch_avatar(url: &str) -> Result<Vec<u8>, ()> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(8)))
        .build()
        .into();
    agent
        .get(url)
        .header("User-Agent", "tauri-explorer-author-avatars")
        .call()
        .map_err(|_| ())?
        .body_mut()
        .with_config()
        .limit((MAX_AVATAR_BYTES + 1) as u64)
        .read_to_vec()
        .map_err(|_| ())
}
fn lookup(email: &str, gravatar_enabled: bool) -> Option<Vec<u8>> {
    static FETCH_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    let _guard = FETCH_LOCK.get_or_init(|| Mutex::new(())).lock().ok()?;
    let cache_dir = dirs::cache_dir()?.join("tauri-explorer").join("avatars");
    load_or_fetch(&cache_dir, email, gravatar_enabled, fetch_avatar)
}
#[tauri::command]
pub async fn git_author_avatar(email: String, gravatar_enabled: bool) -> Option<String> {
    static ACTIVE_FETCHES: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
    let permit = ACTIVE_FETCHES
        .get_or_init(|| Arc::new(tokio::sync::Semaphore::new(MAX_ACTIVE_FETCHES)))
        .clone()
        .acquire_owned()
        .await
        .ok()?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let bytes = lookup(&email, gravatar_enabled)?;
        let mime = image_mime(&bytes)?;
        Some(format!(
            "data:{mime};base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        ))
    })
    .await
    .ok()
    .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::io::Write;
    #[test]
    fn github_noreply_addresses_use_bounded_github_urls() {
        assert_eq!(
            resolve_avatar_url("12345+octocat@users.noreply.github.com", false).as_deref(),
            Some("https://avatars.githubusercontent.com/u/12345?s=64")
        );
        assert_eq!(
            resolve_avatar_url("octocat@users.noreply.github.com", false).as_deref(),
            Some("https://avatars.githubusercontent.com/octocat?s=64")
        );
    }
    #[test]
    fn ordinary_email_never_routes_to_gravatar_without_consent() {
        assert_eq!(resolve_avatar_url("person@example.com", false), None);
        assert!(resolve_avatar_url("person@example.com", true)
            .is_some_and(|url| url.starts_with("https://www.gravatar.com/avatar/")
                && url.ends_with("?s=64&d=404")));
    }
    #[test]
    fn no_consent_never_reaches_the_downloader() {
        let temp = tempfile::tempdir().unwrap();
        let calls = Cell::new(0);
        assert_eq!(
            load_or_fetch(temp.path(), "person@example.com", false, |_| {
                calls.set(calls.get() + 1);
                Err(())
            }),
            None
        );
        assert_eq!(calls.get(), 0);
    }
    #[test]
    fn valid_download_is_reused_from_disk_without_a_second_request() {
        let temp = tempfile::tempdir().unwrap();
        let calls = Cell::new(0);
        let png = include_bytes!("../icons/32x32.png").to_vec();
        let first = load_or_fetch(
            temp.path(),
            "octocat@users.noreply.github.com",
            false,
            |_| {
                calls.set(calls.get() + 1);
                Ok(png.clone())
            },
        );
        let second = load_or_fetch(
            temp.path(),
            "octocat@users.noreply.github.com",
            false,
            |_| {
                calls.set(calls.get() + 1);
                Err(())
            },
        );
        assert_eq!(first, Some(png.clone()));
        assert_eq!(second, Some(png));
        assert_eq!(calls.get(), 1);
    }
    #[test]
    fn failed_download_is_negative_cached() {
        let temp = tempfile::tempdir().unwrap();
        let calls = Cell::new(0);
        for _ in 0..2 {
            assert_eq!(
                load_or_fetch(
                    temp.path(),
                    "octocat@users.noreply.github.com",
                    false,
                    |_| {
                        calls.set(calls.get() + 1);
                        Err(())
                    }
                ),
                None
            );
        }
        assert_eq!(calls.get(), 1);
    }
    #[test]
    fn corrupt_and_oversized_downloads_degrade_to_no_image() {
        let corrupt = tempfile::tempdir().unwrap();
        assert_eq!(
            load_or_fetch(
                corrupt.path(),
                "octocat@users.noreply.github.com",
                false,
                |_| Ok(b"not an image".to_vec())
            ),
            None
        );
        let oversized = tempfile::tempdir().unwrap();
        assert_eq!(
            load_or_fetch(
                oversized.path(),
                "octocat@users.noreply.github.com",
                false,
                |_| Ok(vec![0; MAX_AVATAR_BYTES + 1])
            ),
            None
        );
    }
    #[test]
    fn production_http_reader_rejects_a_response_above_the_byte_limit() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let body = vec![b'x'; MAX_AVATAR_BYTES + 1];
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .unwrap();
            stream.write_all(&body).unwrap();
        });
        assert!(fetch_avatar(&format!("http://{address}/avatar")).is_err());
        server.join().unwrap();
    }
    #[test]
    fn production_lookup_path_prunes_disk_cache_to_its_bound() {
        let temp = tempfile::tempdir().unwrap();
        let png = include_bytes!("../icons/32x32.png").to_vec();
        for index in 0..(MAX_CACHE_ENTRIES + 4) {
            assert!(load_or_fetch(
                temp.path(),
                &format!("user-{index}@users.noreply.github.com"),
                false,
                |_| Ok(png.clone()),
            )
            .is_some());
        }
        let entries: Vec<_> = std::fs::read_dir(temp.path()).unwrap().collect();
        assert!(entries.len() <= MAX_CACHE_ENTRIES);
        let bytes = entries
            .into_iter()
            .map(|entry| entry.unwrap().metadata().unwrap().len())
            .sum::<u64>();
        assert!(bytes <= MAX_CACHE_BYTES);

        let byte_limited = tempfile::tempdir().unwrap();
        let mut padded = png;
        padded.resize(MAX_AVATAR_BYTES, 0);
        let count = (MAX_CACHE_BYTES as usize / padded.len()) + 4;
        for index in 0..count {
            assert!(load_or_fetch(
                byte_limited.path(),
                &format!("bytes-{index}@users.noreply.github.com"),
                false,
                |_| Ok(padded.clone()),
            )
            .is_some());
        }
        let retained_bytes = std::fs::read_dir(byte_limited.path())
            .unwrap()
            .map(|entry| entry.unwrap().metadata().unwrap().len())
            .sum::<u64>();
        assert!(retained_bytes <= MAX_CACHE_BYTES);
    }
    #[test]
    fn failed_deletions_exhaust_prune_candidates_without_panicking() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("old.image"), [1; 8]).unwrap();
        std::fs::write(temp.path().join("new.image"), [2; 8]).unwrap();
        let attempts = Cell::new(0);

        prune_cache_to_with(temp.path(), usize::MAX, 0, |_| {
            attempts.set(attempts.get() + 1);
            Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "deterministic deletion failure",
            ))
        });

        assert_eq!(attempts.get(), 2);
        assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 2);
    }
    #[test]
    fn interrupted_publication_files_are_removed_before_lookup() {
        let temp = tempfile::tempdir().unwrap();
        let url = resolve_avatar_url("octocat@users.noreply.github.com", false).unwrap();
        let (image_path, _) = cache_paths(temp.path(), &url);
        let interrupted = image_path.with_extension("tmp-interrupted");
        std::fs::write(&interrupted, b"partial image bytes").unwrap();
        let png = include_bytes!("../icons/32x32.png").to_vec();

        assert_eq!(
            load_or_fetch(
                temp.path(),
                "octocat@users.noreply.github.com",
                false,
                |_| Ok(png.clone())
            ),
            Some(png)
        );
        assert!(!interrupted.exists());
    }
    #[test]
    fn corrupt_cached_image_is_replaced_by_a_valid_download() {
        let temp = tempfile::tempdir().unwrap();
        let url = resolve_avatar_url("octocat@users.noreply.github.com", false).unwrap();
        let (image_path, _) = cache_paths(temp.path(), &url);
        std::fs::write(&image_path, b"truncated cache entry").unwrap();
        let png = include_bytes!("../icons/32x32.png").to_vec();
        let calls = Cell::new(0);

        assert_eq!(
            load_or_fetch(
                temp.path(),
                "octocat@users.noreply.github.com",
                false,
                |_| {
                    calls.set(calls.get() + 1);
                    Ok(png.clone())
                }
            ),
            Some(png.clone())
        );
        assert_eq!(calls.get(), 1);
        assert_eq!(std::fs::read(image_path).unwrap(), png);
    }
}
