//! HTTP representation planning, independent of transport and file access.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum BytePlan {
    Full,
    Partial { start: u64, length: u64 },
    Unsatisfiable,
}

/// Ignore unsupported/invalid Range fields; support one exact byte range.
/// HEAD and unvalidated If-Range callers pass None (RFC 9110 sections 14–15).
pub(super) fn byte_plan(header: Option<&str>, size: u64) -> BytePlan {
    let Some((unit, value)) = header.and_then(|header| header.split_once('=')) else {
        return BytePlan::Full;
    };
    if !unit.trim().eq_ignore_ascii_case("bytes") || value.contains(',') {
        return BytePlan::Full;
    }
    let Some((first, last)) = value.trim().split_once('-') else {
        return BytePlan::Full;
    };
    let number = |text: &str| {
        (!text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit()))
            .then(|| text.parse::<u64>().ok())
            .flatten()
    };
    if first.is_empty() {
        let Some(suffix) = number(last) else {
            return BytePlan::Full;
        };
        if suffix == 0 || size == 0 {
            return BytePlan::Unsatisfiable;
        }
        let length = suffix.min(size);
        return BytePlan::Partial {
            start: size - length,
            length,
        };
    }
    let Some(start) = number(first) else {
        return BytePlan::Full;
    };
    let end = if last.is_empty() {
        None
    } else {
        let Some(end) = number(last) else {
            return BytePlan::Full;
        };
        if end < start {
            return BytePlan::Full;
        }
        Some(end)
    };
    if start >= size {
        return BytePlan::Unsatisfiable;
    }
    let end = end.unwrap_or(size - 1).min(size - 1);
    BytePlan::Partial {
        start,
        length: end - start + 1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn plans_exact_closed_open_and_suffix_bytes() {
        for (header, start, length) in [
            ("bytes=2-4", 2, 3),
            ("bytes=7-", 7, 3),
            ("bytes=-3", 7, 3),
            ("bytes=2-999", 2, 8),
            ("bytes=-999", 0, 10),
            ("BYTES=0-0", 0, 1),
        ] {
            assert_eq!(
                byte_plan(Some(header), 10),
                BytePlan::Partial { start, length },
                "{header}"
            );
        }
    }
    #[test]
    fn unsatisfied_and_empty_representations_have_no_range() {
        for header in ["bytes=10-", "bytes=99-100", "bytes=-0"] {
            assert_eq!(byte_plan(Some(header), 10), BytePlan::Unsatisfiable);
        }
        assert_eq!(byte_plan(Some("bytes=0-0"), 0), BytePlan::Unsatisfiable);
        assert_eq!(byte_plan(None, 0), BytePlan::Full);
    }
    #[test]
    fn unsupported_and_malformed_fields_do_not_panic_or_allocate_ranges() {
        for header in [
            "items=0-1",
            "bytes=0-1,4-5",
            "bytes=3-1",
            "bytes=+1-2",
            "bytes=a-2",
            "bytes=--1",
            "bytes=",
            "bytes=18446744073709551616-",
            "bytes=0-18446744073709551616",
        ] {
            assert_eq!(byte_plan(Some(header), 10), BytePlan::Full, "{header}");
        }
        assert_eq!(
            byte_plan(Some("bytes=0-18446744073709551615"), u64::MAX),
            BytePlan::Partial {
                start: 0,
                length: u64::MAX
            }
        );
    }
}
