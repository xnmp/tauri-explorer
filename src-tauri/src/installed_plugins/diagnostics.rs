//! Raw child stderr is bounded in memory and never forwarded to UI/logs.
use std::collections::VecDeque;
const MAX_BYTES: usize = 32 * 1024;
#[derive(Default)]
pub(super) struct Diagnostics { bytes: VecDeque<u8> }
impl Diagnostics {
    pub(super) fn push(&mut self, bytes: &[u8]) {
        if bytes.len() >= MAX_BYTES { self.bytes.clear(); self.bytes.extend(&bytes[bytes.len()-MAX_BYTES..]); return; }
        let excess = (self.bytes.len() + bytes.len()).saturating_sub(MAX_BYTES);
        self.bytes.drain(..excess);
        self.bytes.extend(bytes);
    }
    pub(super) fn classification(&self) -> &'static str {
        let bytes: Vec<_> = self.bytes.iter().copied().collect();
        if bytes.windows(b"error while loading shared libraries".len()).any(|part| part == b"error while loading shared libraries") {
            "backend_dependency_missing"
        } else { "backend_disconnected" }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn diagnostics_are_bounded_and_only_classified_messages_escape() {
        let mut diagnostics = Diagnostics::default();
        diagnostics.push(&vec![b'x'; 100_000]);
        diagnostics.push(b"Bearer secret full prompt error while loading shared libraries: private/path");
        assert!(diagnostics.bytes.len() <= MAX_BYTES);
        assert_eq!(diagnostics.classification(), "backend_dependency_missing");
        diagnostics.push(&vec![b'x'; MAX_BYTES]);
        assert_eq!(diagnostics.classification(), "backend_disconnected");
    }
}
