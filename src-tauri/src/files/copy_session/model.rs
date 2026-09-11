//! Ordered copy intent and outcomes. No filesystem access or renderer state.
use crate::{error::AppError, files::mutation::FileMutationReceipt};
use serde::{Deserialize, Serialize};
use std::{
    path::{Component, Path},
    sync::Arc,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// The wire shape of one ordered session request. Copies and moves are the
/// same intent to the session engine; only the effect differs.
pub(crate) struct SessionRequest {
    pub request_id: String,
    pub sources: Vec<String>,
    pub dest_dir: String,
    pub job_id: u64,
    pub shared: bool,
}

pub(crate) struct Request {
    pub sources: Arc<Vec<String>>,
    pub destination: String,
}

impl Request {
    pub(crate) fn new(sources: Vec<String>, destination: String) -> Result<Self, AppError> {
        // Include repeated destination storage in the budget: every successful
        // receipt carries a destination path, even for tiny source spellings.
        let bytes = sources.iter().try_fold(0usize, |bytes, source| {
            bytes
                .checked_add(source.len())?
                .checked_add(destination.len())
        });
        if sources.is_empty() || sources.len() > 32_768 || bytes.is_none_or(|n| n > 8 * 1024 * 1024)
        {
            return Err(AppError::InvalidPath(
                "Selection exceeds its count or path-size limit".into(),
            ));
        }
        for (path, source) in
            std::iter::once((&destination, false)).chain(sources.iter().map(|path| (path, true)))
        {
            let native = Path::new(path);
            if path.contains('\0')
                || !native.is_absolute()
                || (source && native.file_name().is_none())
                || native
                    .components()
                    .any(|part| matches!(part, Component::ParentDir))
            {
                return Err(AppError::InvalidPath(
                    "A session requires absolute paths without parent traversal or NUL bytes"
                        .into(),
                ));
            }
        }
        // Order and duplicates are meaningful: two same-parent requests can
        // produce two uniquely named copies. Never reserve hypothetical names.
        Ok(Self {
            sources: Arc::new(sources),
            destination,
        })
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Choice {
    Overwrite,
    Skip,
    Cancel,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Decision {
    pub choice: Choice,
    pub apply_to_all: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Conflict {
    pub file_name: String,
    pub source_path: String,
    pub remaining: usize,
    pub source_size: u64,
    pub source_modified: String,
    pub dest_size: u64,
    pub dest_modified: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum Event {
    Ready,
    Conflict {
        item: usize,
        nonce: String,
        conflict: Conflict,
    },
    Started {
        item: usize,
        total: usize,
    },
    Progress {
        item: usize,
        progress: crate::progress::ByteProgress,
    },
    Completed {
        item: usize,
        total: usize,
        entry: Option<crate::files::FileEntry>,
    },
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub(crate) enum ItemOutcome {
    Succeeded { receipt: Box<FileMutationReceipt> },
    Skipped,
    Failed { error: String },
    Uncertain { error: String },
    Unstarted,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Outcome {
    /// Position is the identity, including repeated source paths.
    pub items: Vec<ItemOutcome>,
    pub cancelled: bool,
    pub warnings: Vec<String>,
    #[serde(skip)]
    pub refresh_dirs: Vec<String>,
}

impl Outcome {
    pub(crate) fn changed(&self) -> bool {
        self.items.iter().any(|item| {
            matches!(
                item,
                ItemOutcome::Succeeded { .. } | ItemOutcome::Uncertain { .. }
            )
        })
    }
}
