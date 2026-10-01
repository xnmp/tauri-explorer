//! Windows path identity and destructive-batch validation.

use crate::error::AppError;
use std::{cmp::Ordering, os::windows::ffi::OsStrExt, path::Path};
use windows::Win32::Globalization::{
    CompareStringOrdinal, CSTR_EQUAL, CSTR_GREATER_THAN, CSTR_LESS_THAN,
};

const SLASH: u16 = b'\\' as u16;
const FORWARD_SLASH: u16 = b'/' as u16;
const VERBATIM: [u16; 4] = [SLASH, SLASH, b'?' as u16, SLASH];
const DEVICE: [u16; 4] = [SLASH, SLASH, b'.' as u16, SLASH];
// Bounds allocation and the number of component-wise ordinal comparisons.
// The aggregate still admits the BatchPlan maximum of 32,768 typical paths
// with up to 16 comparison components each.
const MAX_COMPONENTS_PER_PATH: usize = 256;
const MAX_SELECTION_COMPONENTS: usize = 524_288;
const SERVER_FORBIDDEN: [u16; 9] = [
    b':' as u16,
    b'*' as u16,
    b'?' as u16,
    b'"' as u16,
    b'<' as u16,
    b'>' as u16,
    b'|' as u16,
    b'[' as u16,
    b']' as u16,
];
const SHARE_FORBIDDEN: [u16; 13] = [
    b':' as u16,
    b'*' as u16,
    b'?' as u16,
    b'"' as u16,
    b'<' as u16,
    b'>' as u16,
    b'|' as u16,
    b'[' as u16,
    b']' as u16,
    b'+' as u16,
    b'=' as u16,
    b';' as u16,
    b',' as u16,
];
const ITEM_FORBIDDEN: [u16; 7] = [
    b':' as u16,
    b'*' as u16,
    b'?' as u16,
    b'"' as u16,
    b'<' as u16,
    b'>' as u16,
    b'|' as u16,
];

fn ordinal(left: &[u16], right: &[u16]) -> Result<Ordering, AppError> {
    match unsafe { CompareStringOrdinal(left, right, true) } {
        result if result == CSTR_LESS_THAN => Ok(Ordering::Less),
        result if result == CSTR_EQUAL => Ok(Ordering::Equal),
        result if result == CSTR_GREATER_THAN => Ok(Ordering::Greater),
        _ => Err(AppError::Other(
            "Windows could not compare native path identities".into(),
        )),
    }
}

fn equal(left: &[u16], right: &[u16]) -> Result<bool, String> {
    ordinal(left, right)
        .map(|ordering| ordering == Ordering::Equal)
        .map_err(|error| error.to_string())
}

fn drive_letter(unit: u16) -> bool {
    (b'A' as u16..=b'Z' as u16).contains(&unit) || (b'a' as u16..=b'z' as u16).contains(&unit)
}

fn verbatim_dos(units: &[u16]) -> bool {
    units.starts_with(&VERBATIM)
        && units.get(4).is_some_and(|unit| drive_letter(*unit))
        && units.get(5) == Some(&(b':' as u16))
        && units.get(6) == Some(&SLASH)
}

fn verbatim_unc(units: &[u16]) -> Result<bool, String> {
    Ok(units.starts_with(&VERBATIM)
        && units.get(7) == Some(&SLASH)
        && equal(&units[4..7], &[b'U' as u16, b'N' as u16, b'C' as u16])?)
}

/// Source-verification key. Supported aliases fold only after the common
/// parser proves their names unambiguous; device, volume, relative, and
/// ambiguous paths retain an error so verification fails closed.
#[derive(Clone, Debug)]
pub(crate) struct WindowsPathKey(Result<SelectionPath, String>);

impl WindowsPathKey {
    pub(crate) fn new(path: &Path) -> Self {
        Self(parse(path))
    }

    pub(crate) fn compare(&self, other: &Self) -> Result<Ordering, AppError> {
        match (&self.0, &other.0) {
            (Ok(left), Ok(right)) => left.compare(right),
            (Err(error), _) | (_, Err(error)) => Err(AppError::Other(error.clone())),
        }
    }
}

#[derive(Clone, Debug)]
struct SelectionPath {
    namespace: Vec<u16>,
    components: Vec<Vec<u16>>,
}

impl SelectionPath {
    fn compare(&self, other: &Self) -> Result<Ordering, AppError> {
        let root = ordinal(&self.namespace, &other.namespace)?;
        if root != Ordering::Equal {
            return Ok(root);
        }
        for (left, right) in self.components.iter().zip(&other.components) {
            let component = ordinal(left, right)?;
            if component != Ordering::Equal {
                return Ok(component);
            }
        }
        Ok(self.components.len().cmp(&other.components.len()))
    }

    fn ancestor_of(&self, other: &Self) -> Result<bool, AppError> {
        if self.components.len() >= other.components.len()
            || ordinal(&self.namespace, &other.namespace)? != Ordering::Equal
        {
            return Ok(false);
        }
        for (left, right) in self.components.iter().zip(&other.components) {
            if ordinal(left, right)? != Ordering::Equal {
                return Ok(false);
            }
        }
        Ok(true)
    }
}

fn parse(path: &Path) -> Result<SelectionPath, String> {
    let original: Vec<_> = path.as_os_str().encode_wide().collect();
    let normalized: Vec<_> = original
        .iter()
        .map(|unit| if *unit == FORWARD_SLASH { SLASH } else { *unit })
        .collect();
    if normalized.starts_with(&VERBATIM) && original.contains(&FORWARD_SLASH) {
        return Err(format!(
            "Verbatim Windows paths cannot contain forward-slash separators: {}",
            path.display()
        ));
    }

    if verbatim_dos(&normalized) {
        return parse_dos(&normalized[4..], path);
    }
    if verbatim_unc(&normalized)? {
        return parse_unc(&normalized[8..], path);
    }
    if normalized.len() >= 3
        && drive_letter(normalized[0])
        && normalized[1] == b':' as u16
        && normalized[2] == SLASH
    {
        return parse_dos(&normalized, path);
    }
    if normalized.starts_with(&[SLASH, SLASH])
        && !normalized.starts_with(&DEVICE)
        && !normalized.starts_with(&VERBATIM)
    {
        return parse_unc(&normalized[2..], path);
    }
    Err(format!(
        "Windows path identity requires an unambiguous fully qualified DOS or UNC path: {}",
        path.display()
    ))
}

fn parse_dos(units: &[u16], path: &Path) -> Result<SelectionPath, String> {
    let components = split_components(&units[3..], path)?;
    validate_items(&components, path)?;
    check_depth(1 + components.len(), path)?;
    Ok(SelectionPath {
        namespace: units[..2].to_vec(),
        components,
    })
}

fn parse_unc(units: &[u16], path: &Path) -> Result<SelectionPath, String> {
    let parts = split_components(units, path)?;
    if parts.len() < 2 {
        return Err(format!(
            "Windows UNC paths require a server and share: {}",
            path.display()
        ));
    }
    validate_server(&parts[0], path)?;
    validate_share(&parts[1], path)?;
    validate_items(&parts[2..], path)?;
    check_depth(parts.len(), path)?;
    Ok(SelectionPath {
        namespace: [
            vec![SLASH, SLASH],
            parts[0].clone(),
            vec![SLASH],
            parts[1].clone(),
        ]
        .concat(),
        components: parts[2..].to_vec(),
    })
}

fn split_components(units: &[u16], path: &Path) -> Result<Vec<Vec<u16>>, String> {
    if units.is_empty() {
        return Ok(Vec::new());
    }
    let mut components = Vec::new();
    for component in units.split(|unit| *unit == SLASH) {
        if component.is_empty() {
            return Err(format!(
                "Windows paths cannot contain repeated or trailing separators: {}",
                path.display()
            ));
        }
        if components.len() == MAX_COMPONENTS_PER_PATH {
            return Err(format!(
                "Windows path exceeds the {MAX_COMPONENTS_PER_PATH}-component limit: {}",
                path.display()
            ));
        }
        components.push(component.to_vec());
    }
    Ok(components)
}

fn check_depth(depth: usize, path: &Path) -> Result<(), String> {
    if depth > MAX_COMPONENTS_PER_PATH {
        Err(format!(
            "Windows path exceeds the {MAX_COMPONENTS_PER_PATH}-component limit: {}",
            path.display()
        ))
    } else {
        Ok(())
    }
}

fn validate_basic(component: &[u16], path: &Path) -> Result<(), String> {
    if component == [b'.' as u16] || component == [b'.' as u16, b'.' as u16] {
        return Err(format!(
            "Windows paths cannot contain dot components: {}",
            path.display()
        ));
    }
    if component.iter().any(|unit| *unit < 32) {
        return Err(format!(
            "Windows paths cannot contain control characters: {}",
            path.display()
        ));
    }
    if component
        .last()
        .is_some_and(|unit| *unit == b'.' as u16 || *unit == b' ' as u16)
    {
        return Err(format!(
            "Windows paths cannot contain components ending in a period or space: {}",
            path.display()
        ));
    }
    Ok(())
}

fn has_any(component: &[u16], forbidden: &[u16]) -> bool {
    component.iter().any(|unit| forbidden.contains(unit))
}

fn validate_server(component: &[u16], path: &Path) -> Result<(), String> {
    validate_basic(component, path)?;
    if has_any(component, &SERVER_FORBIDDEN) {
        return Err(format!(
            "Windows UNC server name is unsupported: {}",
            path.display()
        ));
    }
    Ok(())
}

fn validate_share(component: &[u16], path: &Path) -> Result<(), String> {
    validate_basic(component, path)?;
    if component.len() > 80 || has_any(component, &SHARE_FORBIDDEN) {
        return Err(format!(
            "Windows UNC share name is unsupported: {}",
            path.display()
        ));
    }
    Ok(())
}

fn validate_items(components: &[Vec<u16>], path: &Path) -> Result<(), String> {
    for component in components {
        validate_basic(component, path)?;
        if has_any(component, &ITEM_FORBIDDEN) {
            return Err(format!(
                "Windows selected-item name contains unsupported characters: {}",
                path.display()
            ));
        }
        if reserved_device(component) {
            return Err(format!(
                "Windows selected-item name is reserved by DOS: {}",
                path.display()
            ));
        }
    }
    Ok(())
}

fn reserved_device(component: &[u16]) -> bool {
    let untrimmed = component.split(|unit| *unit == b'.' as u16).next().unwrap();
    let base = trim_ascii_spaces(untrimmed);
    if [
        b"CON".as_slice(),
        b"PRN",
        b"AUX",
        b"NUL",
        b"CONIN$",
        b"CONOUT$",
    ]
    .iter()
    .any(|reserved| ascii_equal_ignore_case(base, reserved))
    {
        return true;
    }
    if base.len() == 4 {
        let numbered = ascii_equal_ignore_case(&base[..3], b"COM")
            || ascii_equal_ignore_case(&base[..3], b"LPT");
        let digit = (b'1' as u16..=b'9' as u16).contains(&base[3])
            || [0x00b9, 0x00b2, 0x00b3].contains(&base[3]);
        if numbered && digit {
            return true;
        }
    }
    false
}

fn trim_ascii_spaces(units: &[u16]) -> &[u16] {
    let end = units
        .iter()
        .rposition(|unit| *unit != b' ' as u16)
        .map_or(0, |index| index + 1);
    &units[..end]
}

fn ascii_equal_ignore_case(units: &[u16], ascii: &[u8]) -> bool {
    units.len() == ascii.len()
        && units.iter().zip(ascii).all(|(unit, byte)| {
            let folded = if (b'a' as u16..=b'z' as u16).contains(unit) {
                *unit - (b'a' - b'A') as u16
            } else {
                *unit
            };
            folded == byte.to_ascii_uppercase() as u16
        })
}

/// Reject aliases and ancestor/descendant inputs before a destructive batch.
/// Individual component byte length is unrestricted; the existing batch byte
/// budget remains authoritative for storage while these limits bound compares.
pub(crate) fn validate_selection(paths: &[String]) -> Result<(), String> {
    let mut total_components = 0usize;
    let mut parsed = Vec::with_capacity(paths.len());
    for spelling in paths {
        let parsed_path = parse(Path::new(spelling))?;
        if parsed_path.components.is_empty() {
            return Err(format!(
                "A Windows volume or share root cannot be a batch item: {spelling}"
            ));
        }
        total_components = total_components
            .checked_add(1 + parsed_path.components.len())
            .ok_or_else(|| "File batch exceeds its Windows component limit".to_owned())?;
        if total_components > MAX_SELECTION_COMPONENTS {
            return Err(format!(
                "File batch exceeds the {MAX_SELECTION_COMPONENTS}-component limit"
            ));
        }
        parsed.push(parsed_path);
    }

    let mut comparison_error = None;
    parsed.sort_unstable_by(|left, right| {
        left.compare(right).unwrap_or_else(|error| {
            comparison_error = Some(error);
            Ordering::Equal
        })
    });
    if let Some(error) = comparison_error {
        return Err(error.to_string());
    }
    for pair in parsed.windows(2) {
        if pair[0].compare(&pair[1]).map_err(|e| e.to_string())? == Ordering::Equal {
            return Err("File batch contains multiple Windows spellings of the same path".into());
        }
        if pair[0].ancestor_of(&pair[1]).map_err(|e| e.to_string())? {
            return Err("Select either a directory or its descendants in one file batch".into());
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "../../test_support/windows_paths.rs"]
mod tests;
