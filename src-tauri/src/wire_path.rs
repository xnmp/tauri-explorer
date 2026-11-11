//! The one conversion between native paths and the strings that carry them
//! across IPC and through backend `String` fields (#1592, ADR 0031).
//!
//! A native name is a byte string on Unix, and it need not be UTF-8. Every
//! path/name string the backend hands out is in canonical *wire form*:
//!
//! - valid UTF-8 containing no U+EF80–U+EFFF is unchanged (borrowed, no copy);
//! - every byte of an invalid UTF-8 sequence, and every byte of a genuine
//!   U+EF80–U+EFFF character, becomes `char(0xEF00 + byte)`.
//!
//! Escapes only ever stand for bytes `>= 0x80`, so ASCII is untouched: `/`,
//! `.`, `..`, NUL, splitting, `parent`/`file_name`/`join`/`components` and
//! prefix or extension checks give the same answers on a wire string as on
//! the raw bytes. Decoding accepts only canonical input (it re-encodes the
//! result and requires the original string back), so string equality is path
//! equality and no wire text can name two different files.
//!
//! The format is permanent once persisted (history, settings, bookmarks).
//! `wire_path` is the only str↔OsStr conversion for paths (`clippy.toml`
//! bans `to_string_lossy` on paths elsewhere); a mutating command decodes its
//! wire paths here, or refuses an escaped path with [`refuse_escaped`].
//!
//! Windows (phase 1): native names are UTF-16 and ill-formed UTF-16 is still
//! converted lossily, as before. Well-formed names use the same wire form as
//! Unix, so a genuine U+EF80–U+EFFF character round-trips; decoding requires
//! the escapes to spell valid UTF-8 (an escape for an ill-formed name cannot
//! be produced and is rejected).
use crate::error::AppError;
use std::borrow::Cow;
use std::ffi::OsStr;
use std::path::Path;

/// First character of the reserved escape block (`0xEF00 + 0x80`).
const FIRST_ESCAPE: u32 = 0xEF80;
/// Last character of the reserved escape block (`0xEF00 + 0xFF`).
const LAST_ESCAPE: u32 = 0xEFFF;
/// The escape for byte `b` is `char(ESCAPE_BASE + b)`.
const ESCAPE_BASE: u32 = 0xEF00;

/// User-facing refusal for commands that do not support escaped names yet.
pub(crate) const UNSUPPORTED_ENCODING: &str =
    "This action does not support names with invalid text encoding yet";
const NON_CANONICAL: &str = "non-canonical path encoding";

fn is_reserved(c: char) -> bool {
    (FIRST_ESCAPE..=LAST_ESCAPE).contains(&(c as u32))
}

/// Whether `text` contains an escape (or a raw reserved character, which is
/// never canonical). Reserved characters encode as `EE BE xx` / `EE BF xx`.
pub(crate) fn has_escape(text: &str) -> bool {
    text.as_bytes()
        .windows(2)
        .any(|pair| pair[0] == 0xEE && matches!(pair[1], 0xBE | 0xBF))
}

fn escape(byte: u8) -> char {
    debug_assert!(byte >= 0x80, "ASCII is never escaped");
    char::from_u32(ESCAPE_BASE + u32::from(byte)).expect("reserved block is scalar values")
}

/// Wire form of a native byte string. Pure; available on every platform for
/// byte-oriented sources such as `git status -z` output.
pub(crate) fn encode_bytes(bytes: &[u8]) -> Cow<'_, str> {
    if let Ok(text) = std::str::from_utf8(bytes) {
        if !has_escape(text) {
            return Cow::Borrowed(text);
        }
    }
    let mut out = String::with_capacity(bytes.len() + 8);
    for chunk in bytes.utf8_chunks() {
        for c in chunk.valid().chars() {
            if is_reserved(c) {
                let mut buffer = [0; 4];
                for &byte in c.encode_utf8(&mut buffer).as_bytes() {
                    out.push(escape(byte));
                }
            } else {
                out.push(c);
            }
        }
        // Invalid sequences only ever contain bytes >= 0x80: ASCII is valid.
        out.extend(chunk.invalid().iter().map(|&byte| escape(byte)));
    }
    Cow::Owned(out)
}

/// The native bytes a wire string names, or `InvalidPath` for non-canonical
/// input. Pure; the platform adapters below build native values from it.
pub(crate) fn decode_bytes(wire: &str) -> Result<Cow<'_, [u8]>, AppError> {
    if !has_escape(wire) {
        return Ok(Cow::Borrowed(wire.as_bytes()));
    }
    let mut bytes = Vec::with_capacity(wire.len());
    for c in wire.chars() {
        if is_reserved(c) {
            bytes.push((c as u32 - ESCAPE_BASE) as u8);
        } else {
            let mut buffer = [0; 4];
            bytes.extend_from_slice(c.encode_utf8(&mut buffer).as_bytes());
        }
    }
    if encode_bytes(&bytes) != wire {
        return Err(AppError::InvalidPath(NON_CANONICAL.into()));
    }
    Ok(Cow::Owned(bytes))
}

/// Wire form of a native name or path.
#[cfg(unix)]
pub(crate) fn encode(native: &OsStr) -> Cow<'_, str> {
    use std::os::unix::ffi::OsStrExt;
    encode_bytes(native.as_bytes())
}

/// Wire form of a native name or path. Ill-formed UTF-16 stays lossy until
/// the Windows phase of #1592.
#[cfg(not(unix))]
#[allow(clippy::disallowed_methods)] // The one sanctioned lossy conversion.
pub(crate) fn encode(native: &OsStr) -> Cow<'_, str> {
    match native.to_string_lossy() {
        Cow::Borrowed(text) => encode_bytes(text.as_bytes()),
        Cow::Owned(text) => Cow::Owned(encode_bytes(text.as_bytes()).into_owned()),
    }
}

/// Wire form of a native path.
pub(crate) fn encode_path(path: &Path) -> Cow<'_, str> {
    encode(path.as_os_str())
}

/// Owned wire form, for code that stores a native path in a `String` field.
pub(crate) trait ToWire {
    fn to_wire(&self) -> String;
}

impl ToWire for OsStr {
    fn to_wire(&self) -> String {
        encode(self).into_owned()
    }
}

impl ToWire for Path {
    fn to_wire(&self) -> String {
        encode_path(self).into_owned()
    }
}

/// The native name or path a canonical wire string names.
#[cfg(unix)]
pub(crate) fn decode_name(wire: &str) -> Result<Cow<'_, OsStr>, AppError> {
    use std::os::unix::ffi::{OsStrExt, OsStringExt};
    Ok(match decode_bytes(wire)? {
        Cow::Borrowed(bytes) => Cow::Borrowed(OsStr::from_bytes(bytes)),
        Cow::Owned(bytes) => Cow::Owned(std::ffi::OsString::from_vec(bytes)),
    })
}

/// The native name or path a canonical wire string names. Windows names are
/// UTF-16, so the escaped bytes must spell valid UTF-8.
#[cfg(not(unix))]
pub(crate) fn decode_name(wire: &str) -> Result<Cow<'_, OsStr>, AppError> {
    Ok(match decode_bytes(wire)? {
        Cow::Borrowed(_) => Cow::Borrowed(OsStr::new(wire)),
        Cow::Owned(bytes) => Cow::Owned(
            String::from_utf8(bytes)
                .map_err(|_| AppError::InvalidPath(UNSUPPORTED_ENCODING.into()))?
                .into(),
        ),
    })
}

/// The native path a canonical wire string names.
pub(crate) fn decode(wire: &str) -> Result<Cow<'_, Path>, AppError> {
    Ok(match decode_name(wire)? {
        Cow::Borrowed(name) => Cow::Borrowed(Path::new(name)),
        Cow::Owned(name) => Cow::Owned(name.into()),
    })
}

/// Display text for a wire string: each run of escapes becomes the bytes it
/// stands for, shown lossily (invalid bytes as U+FFFD). For messages and logs
/// only; never an identity.
pub(crate) fn lossy(wire: &str) -> Cow<'_, str> {
    if !has_escape(wire) {
        return Cow::Borrowed(wire);
    }
    let mut out = String::with_capacity(wire.len());
    let mut run = Vec::new();
    for c in wire.chars() {
        if is_reserved(c) {
            run.push((c as u32 - ESCAPE_BASE) as u8);
            continue;
        }
        if !run.is_empty() {
            out.push_str(&String::from_utf8_lossy(&run));
            run.clear();
        }
        out.push(c);
    }
    out.push_str(&String::from_utf8_lossy(&run));
    Cow::Owned(out)
}

/// Wire-string path algebra. Escapes stand only for bytes >= 0x80, so these
/// `Path` operations on the wire spelling give exactly the wire form of the
/// same operation on the native path, without decoding.
pub(crate) fn parent(wire: &str) -> Option<&str> {
    Path::new(wire).parent().map(|parent| {
        parent
            .to_str()
            .expect("a prefix of wire text at a separator is text")
    })
}

/// The final component of a wire path, as a wire name.
pub(crate) fn file_name(wire: &str) -> Option<&str> {
    Path::new(wire)
        .file_name()
        .map(|name| name.to_str().expect("a wire component is text"))
}

/// `parent` joined with `name`, both in wire form, as a wire path.
pub(crate) fn join(parent: &str, name: &str) -> String {
    Path::new(parent)
        .join(name)
        .into_os_string()
        .into_string()
        .expect("joined wire text is text")
}

/// The native spelling of a wire path or name as text, for an action that
/// cannot yet carry native bytes (phase 2 of #1592). Names that are valid
/// Unicode — including genuine U+EF80–U+EFFF characters — are returned
/// decoded; a name whose native bytes are not text is refused with
/// `UNSUPPORTED_ENCODING` before any side effect. Callers must use the
/// returned text, never the wire string.
pub(crate) fn native_text(wire: &str) -> Result<Cow<'_, str>, AppError> {
    match decode_bytes(wire)? {
        Cow::Borrowed(_) => Ok(Cow::Borrowed(wire)),
        Cow::Owned(bytes) => String::from_utf8(bytes)
            .map(Cow::Owned)
            .map_err(|_| AppError::InvalidPath(UNSUPPORTED_ENCODING.into())),
    }
}

/// Refuse every escaped path, including genuine U+EF80–U+EFFF names, for
/// callers whose borrowed results cannot hold decoded text (the literal git
/// index path validator; phase 2 of #1592).
pub(crate) fn refuse_escaped(wire: &str) -> Result<&str, AppError> {
    if has_escape(wire) {
        return Err(AppError::InvalidPath(UNSUPPORTED_ENCODING.into()));
    }
    Ok(wire)
}

#[cfg(test)]
#[path = "../test_support/wire_path_test.rs"]
mod tests;
