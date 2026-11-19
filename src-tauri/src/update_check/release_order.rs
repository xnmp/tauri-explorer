//! Release chronology across the version reset (#1783).
//!
//! Versions went 0.1–0.9, then 1.0–1.28, then back to 0.28 for the alpha
//! line. Plain version order would call every alpha release older than the
//! 1.x line it replaced, so the updater (which only offers newer versions)
//! would strand 1.x installs. Ordering by era first, then by version, follows
//! the order releases were actually published:
//!
//! | era | versions                         |
//! | --- | -------------------------------- |
//! | 0   | 0.0 – 0.27 (the first 0.x line)  |
//! | 1   | 1.0 – 1.28 (the retired 1.x line)|
//! | 2   | 0.28 and later, then 1.29+, 2.x… |
//!
//! Era 2 is ordinary version order, so leaving alpha later (1.29.0 or 2.0.0)
//! still counts as newer than every alpha release.

/// The first minor of the alpha line, and the last minor of the 1.x line.
const RESET_MINOR: u64 = 28;

/// Dotted numeric segments without any pre-release or build suffix; a
/// non-numeric segment counts as 0.
fn segments(version: &str) -> Vec<u64> {
    core(version)
        .split('.')
        .map(|s| {
            s.chars()
                .take_while(|c| c.is_ascii_digit())
                .collect::<String>()
                .parse()
                .unwrap_or(0)
        })
        .collect()
}

/// The version without its `v` prefix, pre-release (`-rc.1`) or build
/// (`+abc`) suffix.
fn core(version: &str) -> &str {
    let version = version.trim_start_matches('v');
    version.split(['-', '+']).next().unwrap_or(version)
}

/// SemVer pre-release identifiers (`rc.1` in `0.29.0-rc.1`), if any. Build
/// metadata does not affect order.
fn pre_release(version: &str) -> Option<&str> {
    let version = version.trim_start_matches('v');
    let without_build = version.split('+').next().unwrap_or(version);
    without_build.split_once('-').map(|(_, pre)| pre)
}

fn era(segments: &[u64]) -> u8 {
    let major = segments.first().copied().unwrap_or(0);
    let minor = segments.get(1).copied().unwrap_or(0);
    match (major, minor) {
        (0, m) if m < RESET_MINOR => 0,
        (1, m) if m <= RESET_MINOR => 1,
        _ => 2,
    }
}

/// Whether `candidate` was released after `current`. Missing segments
/// compare as 0, so `0.9` and `0.9.0` are the same release. A pre-release
/// precedes its release (`0.29.0-rc.1` < `0.29.0`); two pre-releases of the
/// same version are not reordered.
pub fn is_newer(candidate: &str, current: &str) -> bool {
    let (c, i) = (segments(candidate), segments(current));
    let (era_c, era_i) = (era(&c), era(&i));
    if era_c != era_i {
        return era_c > era_i;
    }
    for at in 0..c.len().max(i.len()) {
        let (a, b) = (
            c.get(at).copied().unwrap_or(0),
            i.get(at).copied().unwrap_or(0),
        );
        if a != b {
            return a > b;
        }
    }
    pre_release(candidate).is_none() && pre_release(current).is_some()
}

#[cfg(test)]
mod tests {
    use super::is_newer;

    /// Era, version and pre-release order, shared with release.yml's
    /// `isReleasedAfter` (scripts/update-channel.mjs) so the two cannot drift
    /// (#1803): each vector is `[candidate, current, expected]`.
    #[test]
    fn shared_release_order_vectors() {
        let vectors: Vec<(String, String, bool)> = serde_json::from_str(include_str!(
            "../../test_support/release-order-vectors.json"
        ))
        .unwrap();
        assert!(vectors.len() > 30, "{} vectors", vectors.len());
        for (candidate, current, expected) in vectors {
            assert_eq!(
                is_newer(&candidate, &current),
                expected,
                "is_newer({candidate:?}, {current:?})"
            );
        }
    }

    /// Lenient inputs only the updater accepts (the release tooling refuses
    /// anything but SemVer): missing segments compare as 0.
    #[test]
    fn missing_segments_compare_as_zero() {
        assert!(!is_newer("0.9", "0.9.0"));
        assert!(!is_newer("", ""));
        assert!(is_newer("0.10", "0.9.9"));
    }

    #[test]
    fn malformed_segments_compare_as_zero() {
        assert!(!is_newer("abc", "0.0.1"));
        assert!(is_newer("1.0.0-rc1", "0.9.9"));
        assert!(!is_newer("x.y.z", "1.28.1"));
    }
}
