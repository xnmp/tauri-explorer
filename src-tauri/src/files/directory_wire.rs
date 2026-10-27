//! Binary IPC representation of a directory listing (#1417); filesystem and
//! cache ownership keep ordinary entries. The decoder is
//! `src/lib/api/directory-wire.ts`; both sides share
//! `tests/fixtures/directory-wire.json`.
//!
//! A listing used to travel as JSON columns. Encoding that JSON, carrying it
//! to the webview and parsing it there took 40-45% of opening a 100k-500k
//! entry folder. This form needs no escaping, carries numbers as fixed-width
//! little-endian values, and lets the webview decode every string column with
//! one `TextDecoder` call and slice it per row. Names are split into an ASCII
//! and a non-ASCII column so one accented name does not make WebKit decode
//! (and keep) every name of the folder as a 16-bit string.
//!
//! Layout (all integers little-endian):
//!
//! | bytes            | content                                                   |
//! |------------------|-----------------------------------------------------------|
//! | 4                | magic `TEL1`                                              |
//! | 4                | u32 header length H                                       |
//! | H                | UTF-8 JSON [`Header`]                                     |
//! | 8 × count        | f64 size of each row                                      |
//! | 4 × count        | u32 UTF-16 length of each name                            |
//! | 4 × count        | u32 UTF-16 length of each modified time                   |
//! | 4 × count        | u32 UTF-16 length of each path (only without a prefix)    |
//! | 4 × count        | u32 UTF-16 length of each symlink target (only if any)    |
//! | 1 × count        | row flags, see `FLAG_*`                                   |
//! | header.bytes[i]  | the UTF-8 string columns, in [`Header::bytes`] order      |
//!
//! A path prefix is shared only when it reproduces every native presentation
//! path exactly, without frontend path normalization.
use super::{DirectoryListing, FileEntry, FileKind};
use serde::Serialize;

pub(crate) const MAGIC: &[u8; 4] = b"TEL1";

pub(crate) const FLAG_DIRECTORY: u8 = 1;
pub(crate) const FLAG_SYMLINK: u8 = 1 << 1;
pub(crate) const FLAG_GIT_REPO: u8 = 1 << 2;
/// The name is in the non-ASCII name column.
pub(crate) const FLAG_WIDE_NAME: u8 = 1 << 3;
pub(crate) const FLAG_SYMLINK_TARGET: u8 = 1 << 4;
/// Two bits: 0 unknown, 1 not empty, 2 empty.
pub(crate) const EMPTY_SHIFT: u8 = 5;

#[derive(Serialize)]
struct Header<'a, X: Serialize> {
    path: &'a str,
    path_prefix: Option<&'a str>,
    count: usize,
    /// Byte length of each UTF-8 column: ASCII names, other names, modified
    /// times, paths (0 with a prefix), symlink targets (0 when none).
    bytes: [usize; 5],
    #[serde(skip_serializing_if = "Option::is_none")]
    targets: Option<bool>,
    #[serde(flatten)]
    extra: X,
}

fn utf16_len(value: &str) -> u32 {
    let units = if value.is_ascii() {
        value.len()
    } else {
        value.encode_utf16().count()
    };
    // Names, times and paths are bounded far below 4 GiB by every platform.
    u32::try_from(units).unwrap_or(u32::MAX)
}

fn shared_prefix(entries: &[FileEntry]) -> Option<&str> {
    entries
        .first()
        .and_then(|entry| entry.path.strip_suffix(entry.name.as_str()))
        .filter(|prefix| {
            entries
                .iter()
                .all(|entry| entry.path.strip_prefix(prefix) == Some(entry.name.as_str()))
        })
}

fn flags(entry: &FileEntry) -> u8 {
    let mut flags = 0;
    if matches!(entry.kind, FileKind::Directory) {
        flags |= FLAG_DIRECTORY;
    }
    if entry.is_symlink {
        flags |= FLAG_SYMLINK;
    }
    if entry.is_git_repo {
        flags |= FLAG_GIT_REPO;
    }
    if !entry.name.is_ascii() {
        flags |= FLAG_WIDE_NAME;
    }
    if entry.symlink_target.is_some() {
        flags |= FLAG_SYMLINK_TARGET;
    }
    let empty = match entry.is_empty {
        None => 0,
        Some(false) => 1,
        Some(true) => 2,
    };
    flags | (empty << EMPTY_SHIFT)
}

/// Encode a listing, with `extra` fields (such as a watch lease) merged into
/// its header. Pure: the same listing always yields the same bytes.
///
/// Rows are visited twice: once to find a shared path prefix, once to build
/// every column. Entry strings are scattered over the heap, so the number of
/// passes, not the copying, is what this costs.
pub(crate) fn encode_listing<X: Serialize>(listing: &DirectoryListing, extra: X) -> Vec<u8> {
    let entries = listing.entries.as_slice();
    let count = entries.len();
    let prefix = shared_prefix(entries);

    let mut sizes = Vec::with_capacity(8 * count);
    let mut name_units = Vec::with_capacity(4 * count);
    let mut modified_units = Vec::with_capacity(4 * count);
    let mut path_units = Vec::with_capacity(if prefix.is_none() { 4 * count } else { 0 });
    let mut target_units = Vec::new();
    let mut flag_column = Vec::with_capacity(count);
    let mut ascii_names = Vec::new();
    let mut wide_names = Vec::new();
    let mut modified = Vec::with_capacity(19 * count);
    let mut paths = Vec::new();
    let mut targets = Vec::new();
    for (index, entry) in entries.iter().enumerate() {
        sizes.extend_from_slice(&(entry.size as f64).to_le_bytes());
        let row_flags = flags(entry);
        let units = if row_flags & FLAG_WIDE_NAME == 0 {
            ascii_names.extend_from_slice(entry.name.as_bytes());
            entry.name.len() as u32
        } else {
            wide_names.extend_from_slice(entry.name.as_bytes());
            utf16_len(&entry.name)
        };
        name_units.extend_from_slice(&units.to_le_bytes());
        modified.extend_from_slice(entry.modified.as_bytes());
        modified_units.extend_from_slice(&utf16_len(&entry.modified).to_le_bytes());
        if prefix.is_none() {
            paths.extend_from_slice(entry.path.as_bytes());
            path_units.extend_from_slice(&utf16_len(&entry.path).to_le_bytes());
        }
        if let Some(target) = &entry.symlink_target {
            if target_units.is_empty() {
                // The first target: earlier rows have none.
                target_units.resize(4 * index, 0);
            }
            targets.extend_from_slice(target.as_bytes());
            target_units.extend_from_slice(&utf16_len(target).to_le_bytes());
        } else if !target_units.is_empty() {
            target_units.extend_from_slice(&0u32.to_le_bytes());
        }
        flag_column.push(row_flags);
    }
    let has_targets = !target_units.is_empty();

    let header = serde_json::to_vec(&Header {
        path: &listing.path,
        path_prefix: prefix,
        count,
        bytes: [
            ascii_names.len(),
            wide_names.len(),
            modified.len(),
            paths.len(),
            targets.len(),
        ],
        targets: has_targets.then_some(true),
        extra,
    })
    .expect("a listing header always serializes");

    let sections = [
        &sizes,
        &name_units,
        &modified_units,
        &path_units,
        &target_units,
        &flag_column,
        &ascii_names,
        &wide_names,
        &modified,
        &paths,
        &targets,
    ];
    let mut out =
        Vec::with_capacity(8 + header.len() + sections.iter().map(|s| s.len()).sum::<usize>());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(
        &u32::try_from(header.len())
            .unwrap_or(u32::MAX)
            .to_le_bytes(),
    );
    out.extend_from_slice(&header);
    for section in sections {
        out.extend_from_slice(section);
    }
    // Every listing reply passes through here once it is encoded (#1416).
    crate::memory_release::listing_encoded(count);
    out
}

/// No extra header fields.
#[derive(Serialize)]
pub(crate) struct NoExtra {}

/// The JSON header of an encoded listing, for tests of its producers.
#[cfg(test)]
pub(crate) fn header_of(body: &[u8]) -> serde_json::Value {
    assert_eq!(&body[..4], MAGIC);
    let len = u32::from_le_bytes(body[4..8].try_into().unwrap()) as usize;
    serde_json::from_slice(&body[8..8 + len]).unwrap()
}

#[cfg(test)]
#[path = "../../test_support/directory_wire.rs"]
mod tests;
