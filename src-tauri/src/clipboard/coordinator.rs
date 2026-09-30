//! The process-wide file clipboard model (#835, #871).
//!
//! Every window's Copy, Cut, Paste and rename passes through one coordinator
//! on one worker thread, so each observation and mutation is ordered. The app
//! publishes a selection (entries plus Copy/Cut) and mirrors its paths to the
//! OS clipboard. A revision changes whenever the clipboard's meaning changes,
//! including when another program replaces it; revisions guard clear, rename
//! and the Cut lease. A Cut exists only while the backend proves our write
//! still owns the OS clipboard, so an external replacement (even one with the
//! same paths) can never be moved as our Cut.

use super::backend::{ClipboardBackend, ClipboardOperation, SelectionOwner};
use crate::error::AppError;
use serde_json::Value;

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileClipboardSnapshot {
    pub(super) revision: u64,
    /// The app's own entries, or `None` for an external (or consumed) list.
    pub(super) entries: Option<Vec<Value>>,
    pub(super) paths: Vec<String>,
    pub(super) operation: Option<ClipboardOperation>,
    pub(super) mirror_error: Option<String>,
}

/// Which clipboard revision's Cut a paste currently holds (#871). Every window
/// shares the one worker, so claims are ordered with every publish; only the
/// claimant moves the files. A lease on an older revision is simply stale.
#[derive(Default)]
struct CutLease {
    leased: Option<u64>,
}

impl CutLease {
    fn claim(&mut self, current: u64, requested: u64, is_cut: bool) -> bool {
        if !is_cut || current != requested || self.leased == Some(current) {
            return false;
        }
        self.leased = Some(current);
        true
    }

    /// Return an unfinished paste's Cut so it stays pasteable.
    fn release(&mut self, current: u64, requested: u64) -> bool {
        if current != requested || self.leased != Some(requested) {
            return false;
        }
        self.leased = None;
        true
    }
}

/// The app's own published selection.
struct AppSelection {
    entries: Vec<Value>,
    operation: ClipboardOperation,
}

/// A Copy whose OS mirror write failed. The app keeps offering its Copy while
/// the OS clipboard still looks as it did right after the failed write; any
/// observed change means another program acted later, and its list wins.
struct FailedMirror {
    error: String,
    baseline_paths: Vec<String>,
    baseline_owner: SelectionOwner,
}

/// The result of one mirror write.
enum Mirror {
    /// The backend proved that this write, carrying this token, owns the OS
    /// clipboard.
    Owned(String),
    /// Written, but ownership cannot be proven on this backend.
    Unproven,
    Failed(AppError),
}

pub(super) struct FileClipboardCoordinator {
    backend: Box<dyn ClipboardBackend>,
    revision: u64,
    selection: Option<AppSelection>,
    /// The paths last observed on (or mirrored to) the OS clipboard.
    paths: Vec<String>,
    /// The ownership token observed with `paths`.
    token: Option<String>,
    failed_mirror: Option<FailedMirror>,
    cut_lease: CutLease,
}

impl FileClipboardCoordinator {
    pub(super) fn new(backend: Box<dyn ClipboardBackend>) -> Self {
        Self {
            backend,
            revision: 0,
            selection: None,
            paths: Vec::new(),
            token: None,
            failed_mirror: None,
            cut_lease: CutLease::default(),
        }
    }

    /// Observe the OS clipboard, adopting any external change as a new
    /// revision with no app entries.
    pub(super) fn snapshot(&mut self) -> Result<FileClipboardSnapshot, AppError> {
        let observed = match self.backend.read_files() {
            Ok(paths) => paths,
            Err(_) if self.failed_copy_mirror().is_some() => return Ok(self.current()),
            Err(error) => return Err(error),
        };
        let unchanged_since_failure = self
            .failed_copy_mirror()
            .filter(|failed| failed.baseline_paths == observed)
            .map(|failed| failed.baseline_owner);
        if let Some(baseline_owner) = unchanged_since_failure {
            if baseline_owner.unchanged_at(self.backend.selection_owner()) {
                return Ok(self.current());
            }
        }
        let owner_token = self.backend.owner_token();
        if owner_token != self.token || observed != self.paths {
            self.adopt_external(observed, owner_token);
        }
        Ok(self.current())
    }

    pub(super) fn publish(
        &mut self,
        entries: Vec<Value>,
        operation: &str,
    ) -> Result<FileClipboardSnapshot, AppError> {
        let operation = ClipboardOperation::parse(operation)?;
        let paths = entries
            .iter()
            .map(|entry| {
                entry_path(entry)
                    .map(str::to_owned)
                    .ok_or_else(missing_path)
            })
            .collect::<Result<Vec<_>, _>>()?;
        if paths.is_empty() {
            return Err(AppError::InvalidPath("No paths to copy".into()));
        }
        if operation == ClipboardOperation::Cut {
            if let Some(reason) = self.backend.cut_unavailable_reason() {
                return Err(AppError::Other(reason.into()));
            }
        }
        let mirror = self.mirror(&paths, operation)?;
        if operation == ClipboardOperation::Cut && !matches!(mirror, Mirror::Owned(_)) {
            return Err(AppError::Other(
                "Could not verify native Cut clipboard ownership".into(),
            ));
        }
        self.selection = Some(AppSelection { entries, operation });
        self.commit_mirror(paths, mirror);
        Ok(self.current())
    }

    /// Consume the app's selection at `revision` (a finished Cut). The OS
    /// clipboard keeps the paths for subsequent Copy paste.
    pub(super) fn clear(&mut self, revision: u64) -> Result<bool, AppError> {
        let current = self.snapshot()?;
        if current.revision != revision || self.selection.is_none() {
            return Ok(false);
        }
        self.revision = self.revision.wrapping_add(1);
        self.selection = None;
        Ok(true)
    }

    /// Claim the Cut at `revision` for one paste. Fails when another paste
    /// holds it, when it was consumed or replaced, or when it is a Copy.
    pub(super) fn claim_cut(&mut self, revision: u64) -> Result<bool, AppError> {
        let current = self.snapshot()?;
        let is_cut = self
            .selection
            .as_ref()
            .is_some_and(|selection| selection.operation == ClipboardOperation::Cut);
        Ok(self.cut_lease.claim(current.revision, revision, is_cut))
    }

    pub(super) fn release_cut(&mut self, revision: u64) -> bool {
        self.cut_lease.release(self.revision, revision)
    }

    /// Follow a rename of one selected entry, re-mirroring the new path list.
    pub(super) fn rekey(
        &mut self,
        revision: u64,
        old_path: &str,
        entry: Value,
    ) -> Result<Option<FileClipboardSnapshot>, AppError> {
        let current = self.snapshot()?;
        if current.revision != revision {
            return Ok(None);
        }
        let Some(selection) = self.selection.as_ref() else {
            return Ok(None);
        };
        let Some(index) = selection
            .entries
            .iter()
            .position(|candidate| entry_path(candidate) == Some(old_path))
        else {
            return Ok(None);
        };
        let operation = selection.operation;
        let new_path = entry_path(&entry).ok_or_else(missing_path)?.to_owned();
        let Some(path_index) = self.paths.iter().position(|path| path == old_path) else {
            return Ok(None);
        };
        let mut paths = self.paths.clone();
        paths[path_index] = new_path;
        let mirror = self.mirror(&paths, operation)?;
        if operation == ClipboardOperation::Cut && !matches!(mirror, Mirror::Owned(_)) {
            return Err(AppError::Other(
                "Could not verify native Cut after rename".into(),
            ));
        }
        if let Some(selection) = self.selection.as_mut() {
            selection.entries[index] = entry;
        }
        self.commit_mirror(paths, mirror);
        Ok(Some(self.current()))
    }

    fn current(&self) -> FileClipboardSnapshot {
        FileClipboardSnapshot {
            revision: self.revision,
            entries: self
                .selection
                .as_ref()
                .map(|selection| selection.entries.clone()),
            paths: self.paths.clone(),
            operation: self.selection.as_ref().map(|selection| selection.operation),
            mirror_error: self
                .failed_mirror
                .as_ref()
                .map(|failed| failed.error.clone()),
        }
    }

    /// The failed mirror that still stands in for the OS clipboard: only an
    /// unconsumed Copy survives a failed write.
    fn failed_copy_mirror(&self) -> Option<&FailedMirror> {
        let is_copy = self
            .selection
            .as_ref()
            .is_some_and(|selection| selection.operation == ClipboardOperation::Copy);
        self.failed_mirror.as_ref().filter(|_| is_copy)
    }

    fn adopt_external(&mut self, paths: Vec<String>, token: Option<String>) {
        self.revision = self.revision.wrapping_add(1);
        self.selection = None;
        self.paths = paths;
        self.token = token;
        self.failed_mirror = None;
    }

    fn mirror(
        &mut self,
        paths: &[String],
        operation: ClipboardOperation,
    ) -> Result<Mirror, AppError> {
        let token = new_clipboard_token()?;
        Ok(match self.backend.write_files(paths, operation, &token) {
            Ok(()) if self.backend.owner_token().as_deref() == Some(token.as_str()) => {
                Mirror::Owned(token)
            }
            Ok(()) => Mirror::Unproven,
            Err(error) => Mirror::Failed(error),
        })
    }

    /// Record a mirror write as the new revision of the app's selection.
    fn commit_mirror(&mut self, paths: Vec<String>, mirror: Mirror) {
        let (token, failed_mirror) = match mirror {
            Mirror::Owned(token) => (Some(token), None),
            Mirror::Unproven => (None, None),
            // Observed only after a failure, so a successful Copy costs no
            // extra OS read (a PowerShell spawn on Windows). Failures
            // cluster: when this read fails too, the list last observed
            // before the write stands in, so recovering reads cannot let
            // that older list displace the accepted Copy.
            Mirror::Failed(error) => (
                None,
                Some(FailedMirror {
                    error: error.to_string(),
                    baseline_paths: self
                        .backend
                        .read_files()
                        .unwrap_or_else(|_| self.paths.clone()),
                    baseline_owner: self.backend.selection_owner(),
                }),
            ),
        };
        self.revision = self.revision.wrapping_add(1);
        self.paths = paths;
        self.token = token;
        self.failed_mirror = failed_mirror;
    }
}

fn entry_path(entry: &Value) -> Option<&str> {
    entry.get("path").and_then(Value::as_str)
}

fn missing_path() -> AppError {
    AppError::InvalidPath("Clipboard entry has no path".into())
}

fn new_clipboard_token() -> Result<String, AppError> {
    let mut nonce = [0u8; 16];
    getrandom::fill(&mut nonce)
        .map_err(|error| AppError::Other(format!("Clipboard token unavailable: {error}")))?;
    Ok(nonce.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[cfg(test)]
mod cut_lease_tests {
    use super::CutLease;

    #[test]
    fn only_one_paste_claims_a_cut_revision() {
        let mut lease = CutLease::default();
        assert!(lease.claim(7, 7, true));
        assert!(
            !lease.claim(7, 7, true),
            "a second window must not move the same Cut"
        );
    }

    #[test]
    fn released_cut_can_be_claimed_again() {
        let mut lease = CutLease::default();
        assert!(lease.claim(7, 7, true));
        assert!(lease.release(7, 7));
        assert!(lease.claim(7, 7, true));
    }

    #[test]
    fn copies_stale_revisions_and_foreign_releases_are_refused() {
        let mut lease = CutLease::default();
        assert!(!lease.claim(7, 7, false), "a Copy is never claimed");
        assert!(!lease.claim(8, 7, true), "a replaced Cut cannot be claimed");
        assert!(!lease.release(7, 7), "nothing is leased");
        assert!(lease.claim(7, 7, true));
        assert!(!lease.release(7, 6));
        assert!(
            !lease.claim(7, 7, true),
            "a mismatched release keeps the lease"
        );
    }

    #[test]
    fn a_new_revision_is_claimable_despite_an_older_lease() {
        let mut lease = CutLease::default();
        assert!(lease.claim(7, 7, true));
        // The clipboard moved on (new Cut, rekey, external replacement): the
        // old lease is stale and neither blocks nor can release the new one.
        assert!(!lease.release(8, 7));
        assert!(lease.claim(8, 8, true));
    }
}

#[cfg(test)]
mod coordinator_tests {
    use super::*;
    use crate::clipboard::fake_backend::{Capabilities, FakeOs};
    use serde_json::json;

    fn entry(path: &str) -> Value {
        let name = path.rsplit('/').next().unwrap_or(path);
        json!({ "name": name, "path": path })
    }

    fn coordinator(capabilities: Capabilities) -> (FakeOs, FileClipboardCoordinator) {
        let os = FakeOs::default();
        let coordinator = FileClipboardCoordinator::new(os.backend(capabilities));
        (os, coordinator)
    }

    fn paths(snapshot: &FileClipboardSnapshot) -> Vec<&str> {
        snapshot.paths.iter().map(String::as_str).collect()
    }

    fn is_external(snapshot: &FileClipboardSnapshot) -> bool {
        snapshot.entries.is_none() && snapshot.operation.is_none()
    }

    #[test]
    fn copy_is_mirrored_and_stays_the_apps_selection() {
        for capabilities in [Capabilities::OWNED, Capabilities::COPY_ONLY] {
            let (os, mut clipboard) = coordinator(capabilities);
            let published = clipboard
                .publish(vec![entry("/tmp/a.txt")], "copy")
                .unwrap();
            assert_eq!(published.operation, Some(ClipboardOperation::Copy));
            assert_eq!(published.entries, Some(vec![entry("/tmp/a.txt")]));
            assert_eq!(published.mirror_error, None);
            assert_eq!(os.paths(), vec!["/tmp/a.txt"]);

            let observed = clipboard.snapshot().unwrap();
            assert_eq!(observed, published, "an unchanged OS list keeps the Copy");
        }
    }

    #[test]
    fn a_successful_copy_does_not_read_the_os_clipboard_first() {
        for capabilities in [Capabilities::OWNED, Capabilities::COPY_ONLY] {
            let (os, mut clipboard) = coordinator(capabilities);
            clipboard
                .publish(vec![entry("/tmp/a.txt")], "copy")
                .unwrap();
            assert_eq!(
                os.reads(),
                0,
                "each read is a process spawn on real backends"
            );
        }
    }

    #[test]
    fn an_external_copy_replaces_the_apps_selection() {
        let (os, mut clipboard) = coordinator(Capabilities::COPY_ONLY);
        let copy = clipboard
            .publish(vec![entry("/tmp/a.txt")], "copy")
            .unwrap();
        os.external_copy(&["/tmp/other.txt"]);

        let observed = clipboard.snapshot().unwrap();
        assert!(observed.revision > copy.revision);
        assert!(is_external(&observed));
        assert_eq!(paths(&observed), vec!["/tmp/other.txt"]);
        assert_eq!(
            clipboard.snapshot().unwrap(),
            observed,
            "observing the same external list again is not a new revision"
        );
    }

    #[test]
    fn cut_fails_closed_where_ownership_cannot_be_proven() {
        let (os, mut clipboard) = coordinator(Capabilities::COPY_ONLY);
        let error = clipboard
            .publish(vec![entry("/tmp/a.txt")], "cut")
            .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("Cut requires native clipboard ownership"),
            "{error}"
        );
        assert!(os.paths().is_empty(), "a refused Cut never touches the OS");
        let observed = clipboard.snapshot().unwrap();
        assert_eq!(observed.revision, 0);
        assert!(is_external(&observed));
    }

    #[test]
    fn cut_fails_when_the_write_does_not_prove_ownership() {
        let unverifiable = Capabilities {
            admits_cut: true,
            proves_ownership: false,
            tracks_owner: false,
        };
        let (os, mut clipboard) = coordinator(unverifiable);
        let copy = clipboard
            .publish(vec![entry("/tmp/copy.txt")], "copy")
            .unwrap();
        let error = clipboard
            .publish(vec![entry("/tmp/a.txt")], "cut")
            .unwrap_err();
        assert!(
            error.to_string().contains("Could not verify native Cut"),
            "{error}"
        );
        // The unproven write still reached the OS, which now lists the other
        // file: that is observed as an external list, never as our Cut.
        assert_eq!(os.paths(), vec!["/tmp/a.txt"]);
        let observed = clipboard.snapshot().unwrap();
        assert!(observed.revision > copy.revision);
        assert!(is_external(&observed));
    }

    #[test]
    fn a_cut_whose_write_fails_is_refused_and_keeps_the_previous_selection() {
        let (os, mut clipboard) = coordinator(Capabilities::OWNED);
        let copy = clipboard
            .publish(vec![entry("/tmp/copy.txt")], "copy")
            .unwrap();
        os.fail_writes(true);
        let error = clipboard
            .publish(vec![entry("/tmp/a.txt")], "cut")
            .unwrap_err();
        assert!(
            error.to_string().contains("Could not verify native Cut"),
            "{error}"
        );
        assert_eq!(clipboard.snapshot().unwrap(), copy);
    }

    #[test]
    fn an_owned_cut_is_lost_to_an_external_copy_of_the_same_paths() {
        let (os, mut clipboard) = coordinator(Capabilities::OWNED);
        let cut = clipboard.publish(vec![entry("/tmp/a.txt")], "cut").unwrap();
        assert_eq!(cut.operation, Some(ClipboardOperation::Cut));
        assert_eq!(clipboard.snapshot().unwrap(), cut);

        os.external_copy(&["/tmp/a.txt"]);
        let observed = clipboard.snapshot().unwrap();
        assert_eq!(paths(&observed), vec!["/tmp/a.txt"]);
        assert!(is_external(&observed), "paths alone never prove our Cut");
        assert_eq!(
            clipboard.snapshot().unwrap(),
            observed,
            "the adopted external list is stable"
        );
        assert!(!clipboard.claim_cut(cut.revision).unwrap());
        assert!(!clipboard.claim_cut(observed.revision).unwrap());
        assert!(!clipboard.clear(cut.revision).unwrap());
        assert_eq!(
            clipboard
                .rekey(cut.revision, "/tmp/a.txt", entry("/tmp/b.txt"))
                .unwrap(),
            None
        );
    }

    #[test]
    fn clear_consumes_only_the_current_revision_and_keeps_the_os_paths() {
        let (os, mut clipboard) = coordinator(Capabilities::OWNED);
        let cut = clipboard.publish(vec![entry("/tmp/a.txt")], "cut").unwrap();
        assert!(!clipboard.clear(cut.revision + 1).unwrap());
        assert!(clipboard.clear(cut.revision).unwrap());
        assert!(!clipboard.clear(cut.revision).unwrap(), "already consumed");

        let observed = clipboard.snapshot().unwrap();
        assert!(observed.revision > cut.revision);
        assert!(is_external(&observed));
        assert_eq!(paths(&observed), vec!["/tmp/a.txt"]);
        assert_eq!(
            os.paths(),
            vec!["/tmp/a.txt"],
            "external Copy paste still works"
        );
        assert!(
            !clipboard.clear(observed.revision).unwrap(),
            "nothing of ours to clear"
        );
    }

    #[test]
    fn rekey_follows_a_rename_and_remirrors_the_list() {
        let (os, mut clipboard) = coordinator(Capabilities::COPY_ONLY);
        let copy = clipboard
            .publish(vec![entry("/tmp/a.txt"), entry("/tmp/b.txt")], "copy")
            .unwrap();

        let renamed = clipboard
            .rekey(copy.revision, "/tmp/a.txt", entry("/tmp/renamed.txt"))
            .unwrap()
            .expect("rename of a selected entry");
        assert!(renamed.revision > copy.revision);
        assert_eq!(paths(&renamed), vec!["/tmp/renamed.txt", "/tmp/b.txt"]);
        assert_eq!(
            renamed.entries,
            Some(vec![entry("/tmp/renamed.txt"), entry("/tmp/b.txt")])
        );
        assert_eq!(renamed.operation, Some(ClipboardOperation::Copy));
        assert_eq!(os.paths(), vec!["/tmp/renamed.txt", "/tmp/b.txt"]);
        assert_eq!(clipboard.snapshot().unwrap(), renamed);
    }

    #[test]
    fn rekey_ignores_stale_revisions_and_unselected_paths() {
        let (os, mut clipboard) = coordinator(Capabilities::COPY_ONLY);
        let copy = clipboard
            .publish(vec![entry("/tmp/a.txt")], "copy")
            .unwrap();
        assert_eq!(
            clipboard
                .rekey(copy.revision + 1, "/tmp/a.txt", entry("/tmp/x.txt"))
                .unwrap(),
            None
        );
        assert_eq!(
            clipboard
                .rekey(copy.revision, "/tmp/unselected.txt", entry("/tmp/x.txt"))
                .unwrap(),
            None
        );
        let error = clipboard
            .rekey(copy.revision, "/tmp/a.txt", json!({ "name": "x.txt" }))
            .unwrap_err();
        assert!(matches!(error, AppError::InvalidPath(_)), "{error}");
        assert_eq!(os.paths(), vec!["/tmp/a.txt"]);
        assert_eq!(clipboard.snapshot().unwrap(), copy);
    }

    #[test]
    fn a_renamed_cut_must_be_reverified() {
        let (os, mut clipboard) = coordinator(Capabilities::OWNED);
        let cut = clipboard.publish(vec![entry("/tmp/a.txt")], "cut").unwrap();
        os.fail_writes(true);
        let error = clipboard
            .rekey(cut.revision, "/tmp/a.txt", entry("/tmp/b.txt"))
            .unwrap_err();
        assert!(error.to_string().contains("after rename"), "{error}");
        assert_eq!(clipboard.snapshot().unwrap(), cut, "the Cut is unchanged");

        os.fail_writes(false);
        let renamed = clipboard
            .rekey(cut.revision, "/tmp/a.txt", entry("/tmp/b.txt"))
            .unwrap()
            .expect("rename of the cut entry");
        assert_eq!(renamed.operation, Some(ClipboardOperation::Cut));
        assert_eq!(clipboard.snapshot().unwrap(), renamed);
    }

    #[test]
    fn a_cut_is_claimed_by_one_paste_at_a_time_and_only_at_its_revision() {
        let (_, mut clipboard) = coordinator(Capabilities::OWNED);
        let cut = clipboard.publish(vec![entry("/tmp/a.txt")], "cut").unwrap();
        assert!(clipboard.claim_cut(cut.revision).unwrap());
        assert!(
            !clipboard.claim_cut(cut.revision).unwrap(),
            "a second window loses"
        );
        assert!(clipboard.release_cut(cut.revision));
        assert!(
            clipboard.claim_cut(cut.revision).unwrap(),
            "released Cuts stay pasteable"
        );

        let renamed = clipboard
            .rekey(cut.revision, "/tmp/a.txt", entry("/tmp/b.txt"))
            .unwrap()
            .expect("rename of the cut entry");
        assert!(
            !clipboard.claim_cut(cut.revision).unwrap(),
            "rekey replaced it"
        );
        assert!(
            !clipboard.release_cut(cut.revision),
            "a stale lease cannot release"
        );
        assert!(clipboard.claim_cut(renamed.revision).unwrap());

        let copy = clipboard
            .publish(vec![entry("/tmp/c.txt")], "copy")
            .unwrap();
        assert!(
            !clipboard.claim_cut(copy.revision).unwrap(),
            "a Copy is never claimed"
        );
    }

    #[test]
    fn a_consumed_cut_cannot_be_claimed() {
        let (_, mut clipboard) = coordinator(Capabilities::OWNED);
        let cut = clipboard.publish(vec![entry("/tmp/a.txt")], "cut").unwrap();
        assert!(clipboard.claim_cut(cut.revision).unwrap());
        assert!(clipboard.clear(cut.revision).unwrap());
        let after = clipboard.snapshot().unwrap();
        assert!(!clipboard.claim_cut(after.revision).unwrap());
        assert!(!clipboard.release_cut(cut.revision));
    }

    #[test]
    fn malformed_publishes_are_rejected_without_touching_the_os() {
        let (os, mut clipboard) = coordinator(Capabilities::OWNED);
        let invalid = clipboard
            .publish(vec![entry("/tmp/a.txt")], "move")
            .unwrap_err();
        assert!(invalid.to_string().contains("Invalid clipboard operation"));
        let empty = clipboard.publish(Vec::new(), "copy").unwrap_err();
        assert!(matches!(empty, AppError::InvalidPath(_)), "{empty}");
        for malformed in [json!({ "name": "a" }), json!({ "path": 7 }), Value::Null] {
            let error = clipboard
                .publish(vec![entry("/tmp/a.txt"), malformed], "copy")
                .unwrap_err();
            assert!(matches!(error, AppError::InvalidPath(_)), "{error}");
        }
        assert!(os.paths().is_empty());
        assert_eq!(clipboard.snapshot().unwrap().revision, 0);
    }

    #[test]
    fn an_unreadable_os_clipboard_is_an_error_without_a_failed_mirror() {
        let (os, mut clipboard) = coordinator(Capabilities::OWNED);
        let cut = clipboard.publish(vec![entry("/tmp/a.txt")], "cut").unwrap();
        os.fail_reads(true);
        assert!(clipboard.snapshot().is_err());
        assert!(
            clipboard.claim_cut(cut.revision).is_err(),
            "a claim observes the OS first"
        );
        os.fail_reads(false);
        assert!(clipboard.claim_cut(cut.revision).unwrap());
    }

    #[test]
    fn a_failed_copy_mirror_stays_usable_until_the_os_clipboard_changes() {
        for capabilities in [Capabilities::OWNED, Capabilities::COPY_ONLY] {
            let (os, mut clipboard) = coordinator(capabilities);
            os.external_copy(&["/tmp/baseline.txt"]);
            clipboard.snapshot().unwrap();
            os.fail_writes(true);
            let copy = clipboard
                .publish(vec![entry("/tmp/failed.txt")], "copy")
                .unwrap();
            assert_eq!(
                copy.mirror_error.as_deref(),
                Some("simulated write failure")
            );
            assert_eq!(copy.entries, Some(vec![entry("/tmp/failed.txt")]));
            assert_eq!(os.paths(), vec!["/tmp/baseline.txt"]);

            assert_eq!(clipboard.snapshot().unwrap(), copy);
            os.fail_reads(true);
            assert_eq!(
                clipboard.snapshot().unwrap(),
                copy,
                "an unreadable OS clipboard keeps the accepted Copy"
            );
            os.fail_reads(false);

            os.external_copy(&["/tmp/external.txt"]);
            let observed = clipboard.snapshot().unwrap();
            assert!(is_external(&observed), "a later external Copy wins");
            assert_eq!(paths(&observed), vec!["/tmp/external.txt"]);
            assert_eq!(observed.mirror_error, None);
        }
    }

    #[test]
    fn a_new_owner_with_identical_paths_ends_a_failed_mirror_where_owners_are_tracked() {
        let (os, mut clipboard) = coordinator(Capabilities::OWNED);
        os.external_copy(&["/tmp/baseline.txt"]);
        os.fail_writes(true);
        let copy = clipboard
            .publish(vec![entry("/tmp/failed.txt")], "copy")
            .unwrap();
        assert_eq!(clipboard.snapshot().unwrap(), copy);

        os.external_copy(&["/tmp/baseline.txt"]);
        let observed = clipboard.snapshot().unwrap();
        assert!(is_external(&observed));
        assert_eq!(paths(&observed), vec!["/tmp/baseline.txt"]);
    }

    #[test]
    fn identical_path_replacement_is_indistinguishable_without_owner_identity() {
        // Documented limit (#835): without owner identity an external Copy of
        // the unchanged list cannot be told apart; both sides are Copies.
        let (os, mut clipboard) = coordinator(Capabilities::COPY_ONLY);
        os.external_copy(&["/tmp/baseline.txt"]);
        os.fail_writes(true);
        let copy = clipboard
            .publish(vec![entry("/tmp/failed.txt")], "copy")
            .unwrap();
        os.external_copy(&["/tmp/baseline.txt"]);
        assert_eq!(clipboard.snapshot().unwrap(), copy);
    }

    #[test]
    fn a_consumed_failed_copy_yields_to_the_os_list() {
        let (os, mut clipboard) = coordinator(Capabilities::COPY_ONLY);
        os.external_copy(&["/tmp/baseline.txt"]);
        os.fail_writes(true);
        let copy = clipboard
            .publish(vec![entry("/tmp/failed.txt")], "copy")
            .unwrap();
        assert!(clipboard.clear(copy.revision).unwrap());
        let observed = clipboard.snapshot().unwrap();
        assert!(is_external(&observed));
        assert_eq!(paths(&observed), vec!["/tmp/baseline.txt"]);
    }

    #[test]
    fn an_unreadable_clipboard_after_a_failed_write_keeps_the_accepted_copy() {
        // Failures cluster: the read right after a failed write can fail too.
        // The older OS list must not displace the Copy once reads recover.
        for capabilities in [Capabilities::OWNED, Capabilities::COPY_ONLY] {
            let (os, mut clipboard) = coordinator(capabilities);
            os.external_copy(&["/tmp/older.txt"]);
            clipboard.snapshot().unwrap();
            os.fail_writes(true);
            os.fail_reads(true);
            let copy = clipboard
                .publish(vec![entry("/tmp/accepted.txt")], "copy")
                .unwrap();
            assert!(copy.mirror_error.is_some());
            os.fail_reads(false);
            assert_eq!(clipboard.snapshot().unwrap(), copy);

            os.external_copy(&["/tmp/newer.txt"]);
            let observed = clipboard.snapshot().unwrap();
            assert!(is_external(&observed), "a later external Copy still wins");
            assert_eq!(paths(&observed), vec!["/tmp/newer.txt"]);
        }
    }

    #[test]
    fn an_unknown_owner_never_proves_a_failed_mirror_unchanged() {
        let (os, mut clipboard) = coordinator(Capabilities::OWNED);
        os.external_copy(&["/tmp/baseline.txt"]);
        os.fail_writes(true);
        os.owner_unknown(true);
        clipboard
            .publish(vec![entry("/tmp/failed.txt")], "copy")
            .unwrap();
        let observed = clipboard.snapshot().unwrap();
        assert!(is_external(&observed), "fail toward the OS list");
        assert_eq!(paths(&observed), vec!["/tmp/baseline.txt"]);
    }

    #[test]
    fn a_rename_of_a_copy_survives_a_failed_mirror_write() {
        let (os, mut clipboard) = coordinator(Capabilities::COPY_ONLY);
        let copy = clipboard
            .publish(vec![entry("/tmp/a.txt")], "copy")
            .unwrap();
        os.fail_writes(true);
        let renamed = clipboard
            .rekey(copy.revision, "/tmp/a.txt", entry("/tmp/b.txt"))
            .unwrap()
            .expect("a Copy follows the rename in-app");
        assert_eq!(paths(&renamed), vec!["/tmp/b.txt"]);
        assert!(renamed.mirror_error.is_some());
        assert_eq!(os.paths(), vec!["/tmp/a.txt"]);
        assert_eq!(clipboard.snapshot().unwrap(), renamed);
    }

    #[test]
    fn a_renamed_cut_whose_write_cannot_be_proven_is_refused() {
        let (os, mut clipboard) = coordinator(Capabilities::OWNED);
        let cut = clipboard.publish(vec![entry("/tmp/a.txt")], "cut").unwrap();
        os.withhold_tokens(true);
        let error = clipboard
            .rekey(cut.revision, "/tmp/a.txt", entry("/tmp/b.txt"))
            .unwrap_err();
        assert!(error.to_string().contains("after rename"), "{error}");
        let observed = clipboard.snapshot().unwrap();
        assert_ne!(
            observed.operation,
            Some(ClipboardOperation::Cut),
            "an unproven write never leaves a Cut behind"
        );
        assert!(!clipboard.claim_cut(observed.revision).unwrap());
    }

    #[test]
    fn a_successful_write_clears_an_earlier_mirror_error() {
        let (os, mut clipboard) = coordinator(Capabilities::COPY_ONLY);
        os.fail_writes(true);
        let failed = clipboard
            .publish(vec![entry("/tmp/a.txt")], "copy")
            .unwrap();
        assert!(failed.mirror_error.is_some());
        os.fail_writes(false);
        let renamed = clipboard
            .rekey(failed.revision, "/tmp/a.txt", entry("/tmp/b.txt"))
            .unwrap()
            .expect("rename of a failed-mirror Copy");
        assert_eq!(renamed.mirror_error, None);
        assert_eq!(os.paths(), vec!["/tmp/b.txt"]);
        assert_eq!(clipboard.snapshot().unwrap(), renamed);
    }
}
