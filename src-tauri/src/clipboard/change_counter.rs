//! Cut ownership proof for clipboards that number their changes (#877):
//! Windows' `GetClipboardSequenceNumber` and macOS'
//! `NSPasteboard.changeCount`.
//!
//! A backend writes the file list together with a private type carrying the
//! write's token, then observes the counter, reads the token back, and
//! observes the counter again. An unchanged counter around a matching token
//! proves that this counter value names our write: tokens are random per
//! write, so no other content carries it. Ownership then lasts exactly while
//! the counter keeps that value. Any later change ends it, including another
//! program writing an identical file list, so paths alone never keep a Cut.

/// One counter observation, or `None` when the platform could not report it.
pub(super) type Counter = Option<i64>;

#[derive(Default)]
pub(super) struct CounterOwnership {
    owned: Option<OwnedWrite>,
}

struct OwnedWrite {
    token: String,
    counter: i64,
}

impl CounterOwnership {
    /// Record the verification of a completed write of `token`: the counter
    /// `before` and `after` reading back `read_back` from the private type.
    /// A write that cannot be verified leaves no ownership; the previous
    /// write's is gone either way, because ours replaced its content.
    pub(super) fn record_write(
        &mut self,
        token: &str,
        before: Counter,
        read_back: Option<&[u8]>,
        after: Counter,
    ) {
        self.owned = match (before, after) {
            (Some(before), Some(after))
                if before == after && read_back.is_some_and(|stored| carries(stored, token)) =>
            {
                Some(OwnedWrite {
                    token: token.to_owned(),
                    counter: before,
                })
            }
            _ => None,
        };
    }

    /// The token of the recorded write while the counter, observed `now`,
    /// still names it.
    pub(super) fn owner_token(&self, now: Counter) -> Option<String> {
        let owned = self.owned.as_ref()?;
        (now == Some(owned.counter)).then(|| owned.token.clone())
    }
}

/// Whether `stored` holds exactly `token`. Trailing NULs are allowed: a
/// Windows global memory block may be larger than the size requested.
fn carries(stored: &[u8], token: &str) -> bool {
    !token.is_empty()
        && stored
            .strip_prefix(token.as_bytes())
            .is_some_and(|padding| padding.iter().all(|byte| *byte == 0))
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "3f2a9c01d4e5b6a7980123456789abcd";

    fn verified(counter: i64) -> CounterOwnership {
        let mut ownership = CounterOwnership::default();
        ownership.record_write(TOKEN, Some(counter), Some(TOKEN.as_bytes()), Some(counter));
        ownership
    }

    #[test]
    fn a_verified_write_owns_the_clipboard_until_the_counter_moves() {
        let ownership = verified(41);
        assert_eq!(ownership.owner_token(Some(41)).as_deref(), Some(TOKEN));
        assert_eq!(
            ownership.owner_token(Some(41)).as_deref(),
            Some(TOKEN),
            "observing ownership does not consume it"
        );
        assert_eq!(ownership.owner_token(Some(42)), None, "any later change");
        assert_eq!(ownership.owner_token(Some(40)), None);
    }

    #[test]
    fn an_unobservable_counter_never_proves_ownership() {
        let ownership = verified(41);
        assert_eq!(ownership.owner_token(None), None);

        let mut unobserved = CounterOwnership::default();
        unobserved.record_write(TOKEN, None, Some(TOKEN.as_bytes()), None);
        assert_eq!(unobserved.owner_token(None), None);
        unobserved.record_write(TOKEN, Some(7), Some(TOKEN.as_bytes()), None);
        assert_eq!(unobserved.owner_token(Some(7)), None);
    }

    #[test]
    fn a_change_during_verification_leaves_no_ownership() {
        // Another program wrote between our read-back and the second counter
        // observation: the first value may name either write.
        let mut ownership = CounterOwnership::default();
        ownership.record_write(TOKEN, Some(41), Some(TOKEN.as_bytes()), Some(42));
        assert_eq!(ownership.owner_token(Some(41)), None);
        assert_eq!(ownership.owner_token(Some(42)), None);
    }

    #[test]
    fn a_missing_or_foreign_token_leaves_no_ownership() {
        let other = "0000000000000000000000000000000f";
        for read_back in [
            None,
            Some(other.as_bytes()),
            Some(&TOKEN.as_bytes()[..16]),
            Some(b"".as_slice()),
            Some(b"3f2a9c01d4e5b6a7980123456789abcdX".as_slice()),
        ] {
            let mut ownership = CounterOwnership::default();
            ownership.record_write(TOKEN, Some(41), read_back, Some(41));
            assert_eq!(ownership.owner_token(Some(41)), None, "{read_back:?}");
        }
    }

    #[test]
    fn an_unverified_write_ends_the_previous_writes_ownership() {
        let mut ownership = verified(41);
        ownership.record_write("ffffffffffffffffffffffffffffffff", Some(42), None, Some(42));
        assert_eq!(ownership.owner_token(Some(41)), None);
        assert_eq!(ownership.owner_token(Some(42)), None);
    }

    #[test]
    fn a_new_verified_write_replaces_the_previous_one() {
        let mut ownership = verified(41);
        let next = "ffffffffffffffffffffffffffffffff";
        ownership.record_write(next, Some(43), Some(next.as_bytes()), Some(43));
        assert_eq!(ownership.owner_token(Some(43)).as_deref(), Some(next));
        assert_eq!(ownership.owner_token(Some(41)), None);
    }

    #[test]
    fn padded_token_blocks_are_accepted_but_other_padding_is_not() {
        assert!(carries(b"abc\0\0\0", "abc"));
        assert!(carries(b"abc", "abc"));
        assert!(!carries(b"abc \0", "abc"));
        assert!(!carries(b"\0abc", "abc"));
        assert!(!carries(b"", ""), "an empty token proves nothing");
        assert!(!carries(b"\0", ""));
    }
}
