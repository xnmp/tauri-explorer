//! Pure validation of exported Linux portal parent identifiers.
use std::ffi::CString;

#[derive(Debug, PartialEq)]
pub(super) enum Parent {
    Wayland(CString),
    X11(u32),
}

pub(super) fn parse(identifier: &str) -> Option<Parent> {
    if identifier.len() > 4096 {
        return None;
    }
    if let Some(handle) = identifier.strip_prefix("wayland:") {
        if handle.is_empty() {
            return None;
        }
        return CString::new(handle).ok().map(Parent::Wayland);
    }
    let xid = u32::from_str_radix(identifier.strip_prefix("x11:")?, 16).ok()?;
    (xid != 0).then_some(Parent::X11(xid))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn portal_parent_identifiers_are_validated_without_native_calls() {
        assert_eq!(parse("x11:abcdef"), Some(Parent::X11(0xabcdef)));
        assert_eq!(
            parse("wayland:exported-handle"),
            Some(Parent::Wayland(CString::new("exported-handle").unwrap()))
        );
        for invalid in [
            "",
            "x11:0",
            "x11:-1",
            "x11:100000000",
            "x11:not-hex",
            "wayland:",
            "wayland:a\0b",
            "other:handle",
        ] {
            assert_eq!(parse(invalid), None, "{invalid:?}");
        }
        assert_eq!(parse(&format!("wayland:{}", "a".repeat(4097))), None);
    }
}
