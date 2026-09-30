//! An in-memory OS clipboard for coordinator and worker tests. The test holds
//! a `FakeOs` handle and acts as the other programs on the desktop; the
//! coordinator sees it only through `ClipboardBackend`.

use super::backend::{
    ClipboardBackend, ClipboardOperation, SelectionOwner, CUT_NEEDS_NATIVE_OWNERSHIP,
};
use crate::error::AppError;
use std::sync::{Arc, Mutex};

/// The owner identity of every write made through a `FakeBackend`.
const APP_OWNER: u64 = 1;

#[derive(Default)]
struct OsClipboard {
    paths: Vec<String>,
    token: Option<String>,
    owner: u64,
    last_external_owner: u64,
    reads: usize,
    fail_reads: bool,
    fail_writes: bool,
    /// Writes succeed but leave no readable token (ownership lost at once).
    withhold_tokens: bool,
    /// Owner observations fail.
    owner_unknown: bool,
}

/// What the simulated platform can prove about its writes.
#[derive(Clone, Copy)]
pub(super) struct Capabilities {
    /// The backend offers Cut before trying a write.
    pub admits_cut: bool,
    /// Writes carry a readable ownership token.
    pub proves_ownership: bool,
    /// The platform identifies the selection owner.
    pub tracks_owner: bool,
}

impl Capabilities {
    /// Like X11, Windows and macOS: provable writes and an identifiable
    /// clipboard owner (or content counter).
    pub const OWNED: Self = Self {
        admits_cut: true,
        proves_ownership: true,
        tracks_owner: true,
    };
    /// A backend that can prove nothing (X11 without a `clipboard-rs`
    /// connection): Copy only, no owner identity.
    pub const COPY_ONLY: Self = Self {
        admits_cut: false,
        proves_ownership: false,
        tracks_owner: false,
    };
}

#[derive(Clone, Default)]
pub(super) struct FakeOs(Arc<Mutex<OsClipboard>>);

impl FakeOs {
    pub fn backend(&self, capabilities: Capabilities) -> Box<dyn ClipboardBackend> {
        Box::new(FakeBackend {
            os: self.clone(),
            capabilities,
        })
    }

    fn with<T>(&self, apply: impl FnOnce(&mut OsClipboard) -> T) -> T {
        apply(&mut self.0.lock().expect("fake clipboard lock"))
    }

    /// Another program copies `paths`: a new owner, without our token.
    pub fn external_copy(&self, paths: &[&str]) {
        self.with(|os| {
            os.last_external_owner = os.last_external_owner.max(APP_OWNER) + 1;
            os.owner = os.last_external_owner;
            os.paths = paths.iter().map(|path| path.to_string()).collect();
            os.token = None;
        });
    }

    pub fn fail_writes(&self, fail: bool) {
        self.with(|os| os.fail_writes = fail);
    }

    pub fn fail_reads(&self, fail: bool) {
        self.with(|os| os.fail_reads = fail);
    }

    pub fn withhold_tokens(&self, withhold: bool) {
        self.with(|os| os.withhold_tokens = withhold);
    }

    pub fn owner_unknown(&self, unknown: bool) {
        self.with(|os| os.owner_unknown = unknown);
    }

    pub fn paths(&self) -> Vec<String> {
        self.with(|os| os.paths.clone())
    }

    /// OS file-list reads so far (each is a process spawn on real backends).
    pub fn reads(&self) -> usize {
        self.with(|os| os.reads)
    }
}

struct FakeBackend {
    os: FakeOs,
    capabilities: Capabilities,
}

impl ClipboardBackend for FakeBackend {
    fn read_files(&mut self) -> Result<Vec<String>, AppError> {
        self.os.with(|os| {
            os.reads += 1;
            if os.fail_reads {
                return Err(AppError::Other("simulated read failure".into()));
            }
            Ok(os.paths.clone())
        })
    }

    fn write_files(
        &mut self,
        paths: &[String],
        _operation: ClipboardOperation,
        token: &str,
    ) -> Result<(), AppError> {
        let proves_ownership = self.capabilities.proves_ownership;
        self.os.with(|os| {
            if os.fail_writes {
                return Err(AppError::Other("simulated write failure".into()));
            }
            os.paths = paths.to_vec();
            os.owner = APP_OWNER;
            os.token = (proves_ownership && !os.withhold_tokens).then(|| token.to_string());
            Ok(())
        })
    }

    fn owner_token(&mut self) -> Option<String> {
        self.os.with(|os| os.token.clone())
    }

    fn selection_owner(&mut self) -> SelectionOwner {
        if !self.capabilities.tracks_owner {
            return SelectionOwner::Untracked;
        }
        self.os.with(|os| {
            if os.owner_unknown {
                SelectionOwner::Unknown
            } else {
                SelectionOwner::Known(os.owner)
            }
        })
    }

    fn cut_unavailable_reason(&self) -> Option<&'static str> {
        (!self.capabilities.admits_cut).then_some(CUT_NEEDS_NATIVE_OWNERSHIP)
    }
}
