//! Windows directory spelling from stored entry names.

use super::WindowsSpelling;
use std::{ffi::OsStr, os::windows::ffi::OsStrExt};
use windows::{
    core::PCWSTR,
    Win32::{
        Globalization::{CompareStringOrdinal, CSTR_EQUAL},
        Storage::FileSystem::{
            FindClose, FindExInfoStandard, FindExSearchNameMatch, FindFirstFileExW,
            FIND_FIRST_EX_CASE_SENSITIVE, FIND_FIRST_EX_FLAGS, WIN32_FIND_DATAW,
        },
    },
};

pub(super) fn resolve(path: &str) -> String {
    let Some(spelling) = WindowsSpelling::parse(path) else {
        return path.to_owned();
    };
    if !spelling.stored_case {
        return WindowsSpelling::join(&spelling.root, &spelling.components);
    }
    let mut resolved = Vec::with_capacity(spelling.components.len());
    let mut resolving = true;
    for component in spelling.components {
        // FindFirstFileExW matches `*`, `?`, `<`, `>` and `"` as wildcards,
        // and `..` would resolve lexically. Neither can name a stored entry.
        if component == ".." || component.contains(['*', '?', '<', '>', '"']) {
            resolving = false;
        }
        let stored = resolving
            .then(|| {
                let probe = WindowsSpelling::join(
                    &spelling.root,
                    &[resolved.as_slice(), std::slice::from_ref(&component)].concat(),
                );
                stored_name(&probe, &component)
            })
            .flatten();
        resolved.push(stored.unwrap_or(component));
    }
    WindowsSpelling::join(&spelling.root, &resolved)
}

/// The stored spelling of the last component of `probe`, if `requested` names
/// that entry by a case variant of its long or 8.3 name.
fn stored_name(probe: &str, requested: &str) -> Option<String> {
    let found = find(probe, false)?;
    if found.name == requested {
        return Some(found.name);
    }
    if same_ignoring_case(&found.name, requested) {
        // A case-sensitive directory can hold both spellings; keep an exact one.
        if find(probe, true).is_some_and(|exact| exact.name == requested) {
            return Some(requested.to_owned());
        }
        // A case-insensitive search can still return `Docs` for a nonexistent
        // `docs` inside a per-directory case-sensitive NTFS directory. Verify
        // that Windows itself resolves the requested spelling before adopting
        // the insensitive match; symlink_metadata keeps a final reparse point
        // as the named entry rather than following its target.
        if std::fs::symlink_metadata(probe).is_err() {
            return None;
        }
        return Some(found.name);
    }
    (!found.short.is_empty()
        && same_ignoring_case(&found.short, requested)
        && std::fs::symlink_metadata(probe).is_ok())
    .then_some(found.short)
}

struct Found {
    name: String,
    short: String,
}

fn find(path: &str, case_sensitive: bool) -> Option<Found> {
    let wide: Vec<u16> = OsStr::new(path).encode_wide().chain(Some(0)).collect();
    let mut data = WIN32_FIND_DATAW::default();
    let flags = if case_sensitive {
        FIND_FIRST_EX_CASE_SENSITIVE
    } else {
        FIND_FIRST_EX_FLAGS(0)
    };
    // SAFETY: `wide` is NUL-terminated and outlives the call, and `data` is a
    // writable WIN32_FIND_DATAW, the buffer FindExInfoStandard requires. The
    // returned search handle is closed before either buffer is released.
    let handle = unsafe {
        FindFirstFileExW(
            PCWSTR(wide.as_ptr()),
            FindExInfoStandard,
            (&mut data as *mut WIN32_FIND_DATAW).cast(),
            FindExSearchNameMatch,
            None,
            flags,
        )
    }
    .ok()?;
    // SAFETY: `handle` is the live search handle returned above.
    let _ = unsafe { FindClose(handle) };
    Some(Found {
        name: terminated(&data.cFileName)?,
        short: terminated(&data.cAlternateFileName)?,
    })
}

fn terminated(units: &[u16]) -> Option<String> {
    let end = units
        .iter()
        .position(|unit| *unit == 0)
        .unwrap_or(units.len());
    String::from_utf16(&units[..end]).ok()
}

/// NTFS name equality: ordinal, ignoring case.
fn same_ignoring_case(left: &str, right: &str) -> bool {
    let left: Vec<u16> = left.encode_utf16().collect();
    let right: Vec<u16> = right.encode_utf16().collect();
    // SAFETY: both slices are live for the duration of this synchronous call.
    (unsafe { CompareStringOrdinal(&left, &right, true) }) == CSTR_EQUAL
}
