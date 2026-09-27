//! One native spelling per directory, shared by listings, watch leases, native
//! observation roots and change events (#799).
//!
//! The lease registry keys directories by string while native observation
//! compares `Path` components, so two spellings of one directory used to split
//! into two registrations that still shared one OS watch: retiring either
//! spelling removed the other's watch. Resolving every request to this one
//! spelling first gives each directory a single registration, listing and
//! event path. Resolution never follows links and never fails; a component it
//! cannot resolve keeps its requested spelling.
//!
//! - Unix normalizes lexically: repeated and trailing separators and `.`
//!   components fold. Case and symlinks name distinct directories.
//! - Windows local-drive paths also fold `/` into `\`, uppercase the drive letter, and give
//!   each existing component its stored case. An 8.3 alias keeps its stored
//!   short spelling rather than expanding. UNC server and share names keep the
//!   requested spelling, so root case variants are outside this convergence
//!   contract. Verbatim and device namespaces are literal and stay
//!   unchanged. WSL shares hold Linux filesystems and keep their case, as the
//!   frontend `directoryKey` does.

#[cfg(windows)]
#[path = "directory_identity/windows.rs"]
mod windows;

/// The single spelling under which `path` is listed and observed. On Windows
/// this reads directory entries, so call it from blocking contexts.
pub(crate) fn resolve(path: &str) -> String {
    #[cfg(windows)]
    {
        windows::resolve(path)
    }
    #[cfg(not(windows))]
    {
        lexical(path)
    }
}

#[cfg(not(windows))]
fn lexical(path: &str) -> String {
    use std::path::{Path, PathBuf};
    let normalized: PathBuf = Path::new(path).components().collect();
    match normalized.into_os_string().into_string() {
        Ok(normalized) if !normalized.is_empty() => normalized,
        _ => path.to_owned(),
    }
}

/// A fully qualified Windows spelling split for per-component resolution.
#[cfg(any(windows, test))]
#[derive(Debug, PartialEq, Eq)]
struct WindowsSpelling {
    /// `C:\` or `\\server\share`.
    root: String,
    components: Vec<String>,
    /// False on WSL shares, whose Linux filesystems are case-sensitive.
    stored_case: bool,
}

#[cfg(any(windows, test))]
impl WindowsSpelling {
    fn parse(path: &str) -> Option<Self> {
        let normalized = path.replace('/', "\\");
        // Verbatim and device paths are literal: `/`, `.` and repeated
        // separators are name characters there, not syntax to fold.
        if normalized.starts_with(r"\\?\") || normalized.starts_with(r"\\.\") {
            return None;
        }
        let bytes = normalized.as_bytes();
        if bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && bytes[2] == b'\\'
        {
            return Some(Self {
                root: format!("{}:\\", char::from(bytes[0].to_ascii_uppercase())),
                components: components(&normalized[3..]),
                stored_case: true,
            });
        }
        let mut parts = components(normalized.strip_prefix(r"\\")?);
        if parts.len() < 2 {
            return None;
        }
        let rest = parts.split_off(2);
        let wsl = ["wsl$", "wsl.localhost"]
            .iter()
            .any(|host| parts[0].eq_ignore_ascii_case(host));
        Some(Self {
            root: format!(r"\\{}\{}", parts[0], parts[1]),
            components: rest,
            stored_case: !wsl,
        })
    }

    /// The spelling of `root` followed by `components`.
    fn join(root: &str, components: &[String]) -> String {
        let mut joined = root.to_owned();
        for component in components {
            if !joined.ends_with('\\') {
                joined.push('\\');
            }
            joined.push_str(component);
        }
        joined
    }
}

#[cfg(any(windows, test))]
fn components(rest: &str) -> Vec<String> {
    rest.split('\\')
        .filter(|component| !component.is_empty() && *component != ".")
        .map(str::to_owned)
        .collect()
}

#[cfg(test)]
#[path = "../../test_support/directory_identity.rs"]
mod tests;
