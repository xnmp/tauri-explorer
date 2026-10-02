//! One ordered input stream per terminal (#882).
//!
//! Separate Tauri invocations are unordered: every async command is spawned
//! onto the multi-threaded runtime, so two `terminal_write` calls issued in
//! order can reach this module in either order (#709). Each write therefore
//! carries the caller's sequence number, starting at 0 for every terminal.
//! [`TerminalInput`] admits writes strictly in sequence order, holding early
//! arrivals until the gap before them fills. A sequence number that was
//! already admitted is ignored and reported as a duplicate, so a caller that
//! did not see a write's outcome can resend it, or learn that the number is
//! spent.
//!
//! Admitted bytes go through one channel to one writer thread per PTY
//! ([`run_input_writer`]), so a blocked PTY never blocks the caller or the
//! terminal registry. Input admitted before the shell starts (typeahead) is
//! held, bounded by [`TYPEAHEAD_LIMIT`], and handed to the writer ahead of
//! everything admitted later. Typeahead that overflows the bound is discarded
//! whole: none of it reaches the shell.

use std::collections::BTreeMap;
use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, Sender};

/// Typeahead held before the shell starts. Once a chunk does not fit, ALL
/// pre-start input is discarded: what was already held, the chunk, and
/// everything else written before the shell starts. Delivering any part of it
/// could leave a partial command on the prompt (`rm -rf ./` held, the path
/// paste dropped) for the user's next Enter to run.
pub(super) const TYPEAHEAD_LIMIT: usize = 64 * 1024;

/// Lost gaps remembered so a late write into one is reported as `lost`.
const LOST_RANGES_KEPT: usize = 16;

/// Early arrivals held while waiting for a missing sequence number. A caller
/// that keeps one write in flight never reaches this; it bounds memory if a
/// caller loses a write outright, after which the gap is declared lost.
const REORDER_LIMIT: usize = 1024;

/// What happened to one `terminal_write`, reported to the caller so it can
/// surface discarded typeahead (the frontend warns and logs it).
#[derive(Debug, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputReceipt {
    /// Bytes this write caused to be discarded because the typeahead buffer
    /// was full. Zero for an ordinary write.
    dropped_bytes: usize,
    /// The sequence number was already admitted, so this data was ignored. A
    /// caller that reused the number after an unseen outcome resends its data
    /// under the next one.
    duplicate: bool,
    /// The sequence number fell in a gap that was already declared lost (see
    /// `REORDER_LIMIT`), so this data was ignored. Unlike a duplicate it was
    /// never delivered, but resending it now would reorder the stream.
    lost: bool,
}

impl InputReceipt {
    #[cfg(test)]
    pub(super) fn dropped_bytes(&self) -> usize {
        self.dropped_bytes
    }

    #[cfg(test)]
    pub(super) fn duplicate(&self) -> bool {
        self.duplicate
    }

    #[cfg(test)]
    pub(super) fn lost(&self) -> bool {
        self.lost
    }
}

/// The sequencer and typeahead buffer in front of one PTY writer.
pub(super) struct TerminalInput {
    next_seq: u64,
    early: BTreeMap<u64, Vec<u8>>,
    typeahead: Vec<u8>,
    typeahead_full: bool,
    sink: Option<Sender<Vec<u8>>>,
    /// Half-open sequence ranges skipped as lost, newest last.
    lost: Vec<std::ops::Range<u64>>,
}

impl TerminalInput {
    pub(super) fn new() -> Self {
        Self {
            next_seq: 0,
            early: BTreeMap::new(),
            typeahead: Vec::new(),
            typeahead_full: false,
            sink: None,
            lost: Vec::new(),
        }
    }

    /// Admit the write numbered `seq`. Bytes reach the PTY in sequence order
    /// no matter which order the writes arrive in; a sequence number that was
    /// already admitted is ignored and reported as a duplicate.
    pub(super) fn submit(&mut self, seq: u64, data: Vec<u8>) -> InputReceipt {
        let mut receipt = InputReceipt::default();
        if seq < self.next_seq || self.early.contains_key(&seq) {
            if self.lost.iter().any(|range| range.contains(&seq)) {
                receipt.lost = true;
            } else {
                receipt.duplicate = true;
            }
            return receipt;
        }
        self.early.insert(seq, data);
        if self.early.len() > REORDER_LIMIT && !self.early.contains_key(&self.next_seq) {
            let resume = *self.early.keys().next().expect("early is non-empty");
            log::warn!(
                "terminal input: writes {}..{resume} never arrived; continuing without them",
                self.next_seq
            );
            if self.lost.len() == LOST_RANGES_KEPT {
                self.lost.remove(0);
            }
            self.lost.push(self.next_seq..resume);
            self.next_seq = resume;
        }
        while let Some(chunk) = self.early.remove(&self.next_seq) {
            self.next_seq += 1;
            receipt.dropped_bytes += self.deliver(chunk);
        }
        receipt
    }

    /// Connect the running PTY's writer. Held typeahead goes first, so no
    /// later write can overtake it; typeahead that overflowed was already
    /// discarded whole, so none of it is delivered.
    pub(super) fn attach(&mut self, sink: Sender<Vec<u8>>) {
        let typeahead = std::mem::take(&mut self.typeahead);
        if !typeahead.is_empty() {
            let _ = sink.send(typeahead);
        }
        self.typeahead_full = false;
        self.sink = Some(sink);
    }

    /// Returns the number of bytes discarded.
    fn deliver(&mut self, chunk: Vec<u8>) -> usize {
        if chunk.is_empty() {
            return 0;
        }
        if let Some(sink) = &self.sink {
            // A closed channel means the writer thread already stopped for a
            // cancelled terminal; the input has nowhere left to go.
            let _ = sink.send(chunk);
            return 0;
        }
        if self.typeahead_full {
            return chunk.len();
        }
        if self.typeahead.len() + chunk.len() > TYPEAHEAD_LIMIT {
            self.typeahead_full = true;
            let held = std::mem::take(&mut self.typeahead).len();
            return held + chunk.len();
        }
        self.typeahead.extend_from_slice(&chunk);
        0
    }
}

/// The per-PTY writer thread's body: write each admitted chunk in channel
/// order until the terminal is cancelled or its input is dropped with the
/// registry entry. Failures are logged here because no caller is waiting.
pub(super) fn run_input_writer(
    mut writer: impl Write,
    input: Receiver<Vec<u8>>,
    cancelled: &AtomicBool,
) {
    let mut reported = false;
    while let Ok(chunk) = input.recv() {
        if cancelled.load(Ordering::Relaxed) {
            break;
        }
        if let Err(error) = writer.write_all(&chunk).and_then(|()| writer.flush()) {
            // One entry per stream: a dead PTY fails every later write too.
            if !reported {
                log::warn!("terminal input write failed: {error}");
                reported = true;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    fn attached() -> (TerminalInput, mpsc::Receiver<Vec<u8>>) {
        let (sender, receiver) = mpsc::channel();
        let mut input = TerminalInput::new();
        input.attach(sender);
        (input, receiver)
    }

    fn received(receiver: &mpsc::Receiver<Vec<u8>>) -> String {
        let bytes: Vec<u8> = receiver.try_iter().flatten().collect();
        String::from_utf8(bytes).unwrap()
    }

    #[test]
    fn writes_arriving_out_of_order_reach_the_pty_in_sequence_order() {
        let (mut input, receiver) = attached();
        input.submit(2, b"c".to_vec());
        input.submit(1, b"b".to_vec());
        assert_eq!(
            received(&receiver),
            "",
            "nothing passes the missing write 0"
        );
        input.submit(0, b"a".to_vec());
        input.submit(3, b"d".to_vec());
        assert_eq!(received(&receiver), "abcd");
    }

    #[test]
    fn a_retried_write_is_delivered_once_and_reported_as_a_duplicate() {
        let (mut input, receiver) = attached();
        assert!(!input.submit(0, b"ls\r".to_vec()).duplicate());
        assert!(input.submit(0, b"ls\r".to_vec()).duplicate());
        assert!(!input.submit(2, b"!".to_vec()).duplicate());
        assert!(input.submit(2, b"!".to_vec()).duplicate(), "held early");
        input.submit(1, b"x".to_vec());
        assert_eq!(received(&receiver), "ls\rx!");
    }

    #[test]
    fn typeahead_is_held_until_the_shell_starts_and_precedes_later_input() {
        let mut input = TerminalInput::new();
        input.submit(0, b"echo ".to_vec());
        input.submit(1, b"early".to_vec());
        let (sender, receiver) = mpsc::channel();
        input.attach(sender);
        input.submit(2, b"\r".to_vec());
        assert_eq!(received(&receiver), "echo early\r");
    }

    #[test]
    fn overflowing_typeahead_discards_all_pre_start_input() {
        let mut input = TerminalInput::new();
        let held = TYPEAHEAD_LIMIT - 1;
        assert_eq!(input.submit(0, vec![b'a'; held]).dropped_bytes(), 0);
        // The chunk that does not fit takes the held prefix with it.
        assert_eq!(input.submit(1, b"paste".to_vec()).dropped_bytes(), held + 5);
        // A later chunk that would fit is discarded too.
        assert_eq!(input.submit(2, b"\r".to_vec()).dropped_bytes(), 1);
        let (sender, receiver) = mpsc::channel();
        input.attach(sender);
        assert_eq!(input.submit(3, b"after".to_vec()).dropped_bytes(), 0);
        assert_eq!(received(&receiver), "after");
    }

    #[test]
    fn enter_after_the_start_runs_nothing_typed_before_an_overflow() {
        let mut input = TerminalInput::new();
        input.submit(0, b"rm -rf ./".to_vec());
        input.submit(1, vec![b'p'; TYPEAHEAD_LIMIT]);
        let (sender, receiver) = mpsc::channel();
        input.attach(sender);
        input.submit(2, b"\r".to_vec());
        assert_eq!(received(&receiver), "\r");
    }

    #[test]
    fn typeahead_exactly_at_the_limit_is_kept() {
        let mut input = TerminalInput::new();
        assert_eq!(
            input.submit(0, vec![b'a'; TYPEAHEAD_LIMIT]).dropped_bytes(),
            0
        );
        let (sender, receiver) = mpsc::channel();
        input.attach(sender);
        assert_eq!(received(&receiver).len(), TYPEAHEAD_LIMIT);
    }

    #[test]
    fn one_byte_past_the_limit_discards_the_full_buffer_too() {
        let mut input = TerminalInput::new();
        input.submit(0, vec![b'a'; TYPEAHEAD_LIMIT]);
        assert_eq!(
            input.submit(1, b"b".to_vec()).dropped_bytes(),
            TYPEAHEAD_LIMIT + 1
        );
    }

    #[test]
    fn a_single_oversized_typeahead_chunk_is_discarded_whole() {
        let mut input = TerminalInput::new();
        let receipt = input.submit(0, vec![b'x'; TYPEAHEAD_LIMIT + 1]);
        assert_eq!(receipt.dropped_bytes(), TYPEAHEAD_LIMIT + 1);
        let (sender, receiver) = mpsc::channel();
        input.attach(sender);
        assert_eq!(received(&receiver), "");
    }

    #[test]
    fn large_input_after_the_shell_starts_is_never_capped() {
        let (mut input, receiver) = attached();
        let receipt = input.submit(0, vec![b'p'; TYPEAHEAD_LIMIT * 4]);
        assert_eq!(receipt.dropped_bytes(), 0);
        assert_eq!(received(&receiver).len(), TYPEAHEAD_LIMIT * 4);
    }

    #[test]
    fn a_lost_write_stops_holding_later_input_once_the_reorder_window_fills() {
        let (mut input, receiver) = attached();
        input.submit(0, b"a".to_vec());
        // Write 1 is never sent.
        for seq in 2..=(REORDER_LIMIT as u64 + 1) {
            input.submit(seq, b"-".to_vec());
        }
        assert_eq!(received(&receiver), "a", "a bounded wait for the gap");
        input.submit(REORDER_LIMIT as u64 + 2, b"z".to_vec());
        let delivered = received(&receiver);
        assert_eq!(delivered.len(), REORDER_LIMIT + 1);
        assert!(delivered.ends_with("-z"));
        // The lost write, arriving late, cannot jump the queue, and is
        // reported as lost rather than as an already-delivered duplicate.
        let late = input.submit(1, b"late".to_vec());
        assert!(late.lost() && !late.duplicate());
        assert_eq!(received(&receiver), "");
        assert!(input.submit(0, b"a".to_vec()).duplicate());
    }

    #[test]
    fn concurrent_callers_are_serialized_by_sequence_number() {
        let (input, receiver) = attached();
        let input = Arc::new(Mutex::new(input));
        let alphabet: Vec<u8> = (b'a'..=b'z').chain(b'0'..=b'9').collect();
        let barrier = Arc::new(std::sync::Barrier::new(alphabet.len()));
        let threads: Vec<_> = alphabet
            .iter()
            .enumerate()
            .map(|(seq, &byte)| {
                let input = input.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    input.lock().unwrap().submit(seq as u64, vec![byte]);
                })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
        assert_eq!(received(&receiver).as_bytes(), alphabet.as_slice());
    }

    /// A writer whose first write blocks until the test releases it.
    struct GatedWriter {
        gate: mpsc::Receiver<()>,
        written: Arc<Mutex<Vec<u8>>>,
    }

    impl Write for GatedWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            let _ = self.gate.recv();
            self.written.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn a_blocked_pty_writer_never_blocks_submission_or_reorders_it() {
        let (gate_tx, gate) = mpsc::channel();
        let written = Arc::new(Mutex::new(Vec::new()));
        let (sender, receiver) = mpsc::channel();
        let writer = GatedWriter {
            gate,
            written: written.clone(),
        };
        let thread = std::thread::spawn(move || {
            run_input_writer(writer, receiver, &AtomicBool::new(false));
        });
        let mut input = TerminalInput::new();
        input.attach(sender);
        for (seq, chunk) in ["one ", "two ", "three"].iter().enumerate() {
            // Returns while the writer thread is stuck on the first chunk.
            input.submit(seq as u64, chunk.as_bytes().to_vec());
        }
        for _ in 0..3 {
            gate_tx.send(()).unwrap();
        }
        drop(input);
        thread.join().unwrap();
        assert_eq!(&*written.lock().unwrap(), b"one two three");
    }

    #[test]
    fn a_cancelled_terminal_writes_nothing_further() {
        let written = Arc::new(Mutex::new(Vec::new()));
        struct Recording(Arc<Mutex<Vec<u8>>>);
        impl Write for Recording {
            fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(buf);
                Ok(buf.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let (sender, receiver) = mpsc::channel();
        sender.send(b"stale".to_vec()).unwrap();
        let cancelled = AtomicBool::new(true);
        let (done_tx, done_rx) = mpsc::channel();
        let recording = Recording(written.clone());
        std::thread::scope(|scope| {
            scope.spawn(|| {
                run_input_writer(recording, receiver, &cancelled);
                done_tx.send(()).unwrap();
            });
            assert!(
                done_rx.recv_timeout(Duration::from_secs(5)).is_ok(),
                "the writer stops for a cancelled terminal even while its sender lives"
            );
        });
        drop(sender);
        assert!(written.lock().unwrap().is_empty());
    }
}
