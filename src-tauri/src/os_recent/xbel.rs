//! Linux adapter: the freedesktop/GTK `recently-used.xbel` bookmark file.
//!
//! Each `<bookmark href="file:///…" modified="…" visited="…">` records a file
//! some application registered as recently used. The newest of `visited` and
//! `modified` is the last-open time. The parsed index is cached keyed by the
//! file's identity (path, mtime, size) so repeated batches never reparse, and
//! the file is read only up to [`MAX_BYTES`].
use super::OsRecentSource;
use chrono::DateTime;
use quick_xml::{
    events::{BytesStart, Event},
    reader::Reader,
    XmlVersion,
};
use std::collections::HashMap;
use std::ffi::OsString;
use std::io::Read;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

/// A real history file is a few hundred KiB; anything larger is skipped.
pub(super) const MAX_BYTES: u64 = 8 * 1024 * 1024;

/// Last-open time (epoch ms) by decoded path bytes (Linux paths need not be UTF-8).
pub(super) type Index = HashMap<Vec<u8>, i64>;

/// `$XDG_DATA_HOME/recently-used.xbel`, defaulting to `~/.local/share`.
fn default_location() -> Option<PathBuf> {
    let data_home = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .or_else(|| dirs::home_dir().map(|home| home.join(".local/share")))?;
    Some(data_home.join("recently-used.xbel"))
}

/// Decode a `file://` URI into the path bytes it names; other schemes, remote
/// hosts and relative references are not local files.
fn href_to_path(href: &str) -> Option<Vec<u8>> {
    let rest = href.strip_prefix("file://")?;
    let rest = rest.strip_prefix("localhost").unwrap_or(rest);
    if !rest.starts_with('/') {
        return None;
    }
    let decoded: Vec<u8> = percent_encoding::percent_decode_str(rest).collect();
    (!decoded.contains(&0)).then_some(decoded)
}

fn parse_time(value: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(value.trim())
        .ok()
        .map(|time| time.timestamp_millis())
        .filter(|at| *at > 0)
}

fn bookmark(tag: &BytesStart<'_>) -> Option<(Vec<u8>, i64)> {
    let (mut href, mut at) = (None, None::<i64>);
    for attribute in tag.attributes().flatten() {
        let Ok(value) = attribute.normalized_value(XmlVersion::Implicit1_0) else {
            continue;
        };
        match attribute.key.as_ref() {
            "href" => href = href_to_path(&value),
            "visited" | "modified" => at = at.max(parse_time(&value)),
            _ => {}
        }
    }
    Some((href?, at?))
}

/// Parse a document. A malformed tail keeps the bookmarks read before it;
/// duplicate hrefs keep the newest time.
pub(super) fn parse(bytes: &[u8]) -> Index {
    let mut reader = Reader::from_reader(bytes);
    let mut index = Index::new();
    let mut buffer = Vec::new();
    loop {
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Start(tag) | Event::Empty(tag))
                if tag.local_name().as_ref() == "bookmark" =>
            {
                if let Some((path, at)) = bookmark(&tag) {
                    index
                        .entry(path)
                        .and_modify(|current| *current = (*current).max(at))
                        .or_insert(at);
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            Ok(_) => {}
        }
        buffer.clear();
    }
    index
}

#[derive(Clone, PartialEq, Eq)]
struct Identity {
    path: PathBuf,
    modified: Option<SystemTime>,
    len: u64,
}

/// Parsed-file cache: reparses only when the file's identity changes.
pub(super) struct XbelCache {
    entry: Mutex<Option<(Identity, Arc<Index>)>>,
    warned: AtomicBool,
}

impl XbelCache {
    pub(super) const fn new() -> Self {
        Self {
            entry: Mutex::new(None),
            warned: AtomicBool::new(false),
        }
    }

    fn warn_once(&self, message: &str) {
        if !self.warned.swap(true, Ordering::Relaxed) {
            log::warn!("{message}");
        }
    }

    /// The index for the file at `path`; empty when it is absent, too large or unreadable.
    pub(super) fn index(&self, path: &Path) -> Arc<Index> {
        let Ok(metadata) = std::fs::metadata(path) else {
            log::debug!("recently-used.xbel not available at {}", path.display());
            return Arc::default();
        };
        if metadata.len() > MAX_BYTES {
            self.warn_once("recently-used.xbel is too large; OS open times are skipped");
            return Arc::default();
        }
        let identity = Identity {
            path: path.to_path_buf(),
            modified: metadata.modified().ok(),
            len: metadata.len(),
        };
        let mut slot = self
            .entry
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if let Some((cached, index)) = slot.as_ref() {
            if *cached == identity {
                return Arc::clone(index);
            }
        }
        let mut bytes = Vec::new();
        let read = std::fs::File::open(path)
            .and_then(|file| file.take(MAX_BYTES + 1).read_to_end(&mut bytes));
        let index = match read {
            Ok(_) if bytes.len() as u64 <= MAX_BYTES => Arc::new(parse(&bytes)),
            Ok(_) => {
                self.warn_once("recently-used.xbel grew past its size limit; skipped");
                Arc::default()
            }
            Err(error) => {
                self.warn_once(&format!("recently-used.xbel could not be read: {error}"));
                Arc::default()
            }
        };
        *slot = Some((identity, Arc::clone(&index)));
        index
    }
}

static SYSTEM_CACHE: XbelCache = XbelCache::new();

pub(super) struct XbelSource {
    location: Option<PathBuf>,
    cache: &'static XbelCache,
}

impl XbelSource {
    pub(super) fn system() -> Self {
        Self {
            location: default_location(),
            cache: &SYSTEM_CACHE,
        }
    }

    #[cfg(test)]
    fn at(location: PathBuf, cache: &'static XbelCache) -> Self {
        Self {
            location: Some(location),
            cache,
        }
    }
}

impl OsRecentSource for XbelSource {
    fn opened_at(&self, paths: &[String]) -> HashMap<String, i64> {
        let Some(location) = &self.location else {
            return HashMap::new();
        };
        let index = self.cache.index(location);
        if index.is_empty() {
            return HashMap::new();
        }
        paths
            .iter()
            .filter_map(|path| {
                let key = OsString::from(path);
                index.get(key.as_bytes()).map(|at| (path.clone(), *at))
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HEAD: &str = r#"<?xml version="1.0" encoding="UTF-8"?><xbel version="1.0" xmlns:bookmark="http://www.freedesktop.org/standards/desktop-bookmarks">"#;

    fn doc(body: &str) -> String {
        format!("{HEAD}{body}</xbel>")
    }

    fn at(iso: &str) -> i64 {
        parse_time(iso).unwrap()
    }

    #[test]
    fn visited_and_modified_use_the_newest() {
        let index = parse(
            doc(r#"<bookmark href="file:///a.txt" added="2020-01-01T00:00:00Z" modified="2024-03-01T10:00:00Z" visited="2024-02-01T10:00:00Z"><info/></bookmark>
                   <bookmark href="file:///b.txt" visited="2024-05-01T00:00:00.5Z"/>
                   <bookmark href="file:///c.txt" modified="2023-01-01T00:00:00Z"/>"#)
            .as_bytes(),
        );
        assert_eq!(index[b"/a.txt".as_slice()], at("2024-03-01T10:00:00Z"));
        assert_eq!(
            index[b"/b.txt".as_slice()],
            at("2024-05-01T00:00:00Z") + 500
        );
        assert_eq!(index[b"/c.txt".as_slice()], at("2023-01-01T00:00:00Z"));
    }

    #[test]
    fn hrefs_are_percent_decoded_including_non_utf8_bytes() {
        let index = parse(
            doc(r#"<bookmark href="file:///home/me/My%20Doc%C3%A9.txt" visited="2024-01-01T00:00:00Z"/>
                   <bookmark href="file:///tmp/bad%FF%FEname" visited="2024-01-02T00:00:00Z"/>
                   <bookmark href="file://localhost/srv/a&amp;b.txt" visited="2024-01-03T00:00:00Z"/>"#)
            .as_bytes(),
        );
        assert!(index.contains_key("/home/me/My Docé.txt".as_bytes()));
        assert!(index.contains_key(b"/tmp/bad\xff\xfename".as_slice()));
        assert!(index.contains_key(b"/srv/a&b.txt".as_slice()));
    }

    #[test]
    fn non_file_missing_and_bad_entries_are_ignored() {
        let index = parse(
            doc(
                r#"<bookmark href="https://example.com/x" visited="2024-01-01T00:00:00Z"/>
                   <bookmark href="file://remote-host/x" visited="2024-01-01T00:00:00Z"/>
                   <bookmark href="relative/x" visited="2024-01-01T00:00:00Z"/>
                   <bookmark href="file:///no-time"/>
                   <bookmark href="file:///bad-time" visited="yesterday"/>
                   <bookmark href="file:///nul%00" visited="2024-01-01T00:00:00Z"/>
                   <bookmark visited="2024-01-01T00:00:00Z"/>"#,
            )
            .as_bytes(),
        );
        assert!(index.is_empty());
    }

    #[test]
    fn duplicate_hrefs_keep_the_newest_time() {
        let index = parse(
            doc(
                r#"<bookmark href="file:///d" visited="2024-06-01T00:00:00Z"/>
                   <bookmark href="file:///d" visited="2022-06-01T00:00:00Z"/>"#,
            )
            .as_bytes(),
        );
        assert_eq!(index.len(), 1);
        assert_eq!(index[b"/d".as_slice()], at("2024-06-01T00:00:00Z"));
    }

    #[test]
    fn malformed_documents_keep_what_preceded_the_damage() {
        let good = r#"<bookmark href="file:///ok" visited="2024-01-01T00:00:00Z"/>"#;
        let index = parse(format!("{HEAD}{good}<bookmark href=\"file:///x\" <<<").as_bytes());
        assert!(index.contains_key(b"/ok".as_slice()));
        assert!(parse(b"not xml at all \xff\x00").is_empty());
        assert!(parse(b"").is_empty());
    }

    fn write(path: &Path, body: &str) {
        std::fs::write(path, doc(body)).unwrap();
    }

    #[test]
    fn source_looks_up_requested_paths_and_reparses_only_on_change() {
        static LOCAL: XbelCache = XbelCache::new();
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("recently-used.xbel");
        write(
            &file,
            r#"<bookmark href="file:///a" visited="2024-01-01T00:00:00Z"/>"#,
        );
        let source = XbelSource::at(file.clone(), &LOCAL);
        let paths = vec!["/a".to_string(), "/b".to_string()];

        let first = source.opened_at(&paths);
        assert_eq!(first.len(), 1);
        assert_eq!(first["/a"], at("2024-01-01T00:00:00Z"));
        let cached = LOCAL.index(&file);
        assert!(
            Arc::ptr_eq(&cached, &LOCAL.index(&file)),
            "unchanged file is not reparsed"
        );

        write(
            &file,
            r#"<bookmark href="file:///a" visited="2025-01-01T00:00:00Z"/><bookmark href="file:///b" visited="2025-02-01T00:00:00Z"/>"#,
        );
        let second = source.opened_at(&paths);
        assert_eq!(second["/a"], at("2025-01-01T00:00:00Z"));
        assert_eq!(second["/b"], at("2025-02-01T00:00:00Z"));
    }

    #[test]
    fn same_size_rewrite_with_new_mtime_invalidates() {
        static LOCAL: XbelCache = XbelCache::new();
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("x.xbel");
        let body = |year: &str| {
            format!(r#"<bookmark href="file:///a" visited="{year}-01-01T00:00:00Z"/>"#)
        };
        write(&file, &body("2020"));
        let source = XbelSource::at(file.clone(), &LOCAL);
        assert_eq!(
            source.opened_at(&["/a".into()])["/a"],
            at("2020-01-01T00:00:00Z")
        );
        write(&file, &body("2021"));
        let handle = std::fs::File::options().write(true).open(&file).unwrap();
        handle
            .set_modified(SystemTime::now() + std::time::Duration::from_secs(5))
            .unwrap();
        assert_eq!(
            source.opened_at(&["/a".into()])["/a"],
            at("2021-01-01T00:00:00Z")
        );
    }

    #[test]
    fn missing_oversized_and_unreadable_sources_are_empty() {
        static MISSING: XbelCache = XbelCache::new();
        static HUGE: XbelCache = XbelCache::new();
        static DIR: XbelCache = XbelCache::new();
        let dir = tempfile::tempdir().unwrap();
        let missing = XbelSource::at(dir.path().join("absent.xbel"), &MISSING);
        assert!(missing.opened_at(&["/a".into()]).is_empty());

        let huge = dir.path().join("huge.xbel");
        let mut body = doc(r#"<bookmark href="file:///a" visited="2024-01-01T00:00:00Z"/>"#);
        body.push_str(&" ".repeat(MAX_BYTES as usize));
        std::fs::write(&huge, body).unwrap();
        assert!(XbelSource::at(huge, &HUGE)
            .opened_at(&["/a".into()])
            .is_empty());

        assert!(XbelSource::at(dir.path().to_path_buf(), &DIR)
            .opened_at(&["/a".into()])
            .is_empty());
    }
}
