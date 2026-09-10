//! Retained native handles for one planned replacement artifact root.
//! Phase ownership and user-file effects remain with the replacement executor.

use super::{
    model::{DurableIntent, ObjectId, StagedPayload},
    private_storage::validate_directory,
    storage::Catalog,
};
use crate::{error::AppError, files::file_identity::of_file, files::native_directory::Directory};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{ffi::OsString, io, io::Write, path::PathBuf};

const MANIFEST_ID: &str = "manifest";

#[path = "replacement_transfer.rs"]
mod transfer;

#[path = "replacement_restore.rs"]
mod restore;

/// A verified target parent and the exact absent root name planned by the
/// durable intent. Opening an anchor never creates or repairs filesystem data.
pub(super) struct Anchor {
    parent: Directory,
    parent_path: PathBuf,
    parent_identity: ObjectId,
    root_path: PathBuf,
    root_name: OsString,
    original: ObjectId,
    intent_digest: [u8; 32],
}

/// The exact private root reached through both its retained handle and its
/// planned parent entry. Dropping it never removes recovery data.
pub(super) struct Root {
    parent: Directory,
    parent_path: PathBuf,
    parent_identity: ObjectId,
    directory: Directory,
    path: PathBuf,
    name: OsString,
    identity: ObjectId,
    original: ObjectId,
    intent_digest: [u8; 32],
}

#[derive(Serialize)]
#[serde(deny_unknown_fields)]
struct BorrowedManifest<'a> {
    intent: &'a DurableIntent,
    root: ObjectId,
}

impl Anchor {
    pub(super) fn open(intent: &DurableIntent) -> Result<Self, AppError> {
        intent.validate()?;
        let intent_digest = digest(intent)?;
        let spec = intent.operation.replacement()?;
        let parent_path = spec
            .target
            .0
            .parent()
            .ok_or_else(|| invalid("Recovery replacement target has no parent"))?
            .to_owned();
        let root_parent = spec
            .root
            .0
            .parent()
            .ok_or_else(|| invalid("Recovery replacement root has no parent"))?;
        let root_name = spec
            .root
            .0
            .file_name()
            .ok_or_else(|| invalid("Recovery replacement root has no name"))?
            .to_owned();
        let expected_name =
            OsString::from(format!(".tauri-explorer-recovery-{}", spec.artifact_token));
        if root_parent != parent_path || root_name != expected_name {
            return Err(invalid(
                "Recovery replacement root is not the exact planned child of its target parent",
            ));
        }
        let parent = Directory::open(&parent_path)?;
        if of_file(&parent.file)? != spec.parent {
            return Err(invalid(
                "Recovery replacement target parent changed before artifact access",
            ));
        }
        Ok(Self {
            parent,
            parent_path,
            parent_identity: spec.parent,
            root_path: spec.root.0.clone(),
            root_name,
            original: spec.original.object,
            intent_digest,
        })
    }

    /// Exclusively create the one root named by the intent. Any error leaves
    /// possible evidence in place for the phase owner to inspect.
    pub(super) fn create(self) -> Result<Root, AppError> {
        self.verify_parent_namespace()?;
        let directory = self.parent.create_directory(&self.root_name)?;
        validate_directory(&directory)?;
        directory.sync()?;
        self.parent.sync()?;
        let root = self.finish(directory)?;
        root.verify_namespace()?;
        Ok(root)
    }

    /// Open only the expected root identity. This path is read-only and never
    /// adopts another private directory at the planned name.
    pub(super) fn open_existing(self, expected: ObjectId) -> Result<Root, AppError> {
        self.verify_parent_namespace()?;
        let directory = self.parent.open_existing(&self.root_name)?;
        validate_directory(&directory)?;
        let actual = of_file(&directory.file)?;
        if actual != expected {
            return Err(invalid(
                "Recovery replacement artifact root identity changed",
            ));
        }
        let root = self.finish(directory)?;
        if root.identity != expected {
            return Err(invalid(
                "Recovery replacement artifact root changed while opening",
            ));
        }
        root.verify_namespace()?;
        Ok(root)
    }

    fn finish(self, directory: Directory) -> Result<Root, AppError> {
        let identity = of_file(&directory.file)?;
        if !identity.same_volume(self.parent_identity)
            || identity == self.parent_identity
            || identity == self.original
        {
            return Err(invalid(
                "Recovery replacement artifact root aliases user data or another volume",
            ));
        }
        Ok(Root {
            parent: self.parent,
            parent_path: self.parent_path,
            parent_identity: self.parent_identity,
            directory,
            path: self.root_path,
            name: self.root_name,
            identity,
            original: self.original,
            intent_digest: self.intent_digest,
        })
    }

    fn verify_parent_namespace(&self) -> Result<(), AppError> {
        let named = Directory::open(&self.parent_path)?;
        if of_file(&named.file)? != self.parent_identity
            || of_file(&self.parent.file)? != self.parent_identity
        {
            return Err(invalid(
                "Recovery replacement target parent namespace changed",
            ));
        }
        Ok(())
    }
}

impl Root {
    /// Validate immutable copy/payload authority independently of its current
    /// native position. Endpoint observations decide which effect is possible.
    fn verify_copy_evidence(
        &self,
        intent: &DurableIntent,
        staged: &StagedPayload,
    ) -> Result<(), AppError> {
        use super::model::{OperationState, Phase, ReplacementState};
        intent.validate()?;
        OperationState::Replacement(ReplacementState {
            effect_revision: 0,
            root: Some(self.identity),
            phase: Phase::Staged,
            published: Some(staged.clone()),
            error: None,
        })
        .validate(intent)?;
        self.verify_manifest(intent)
    }

    pub(super) fn identity(&self) -> ObjectId {
        self.identity
    }

    /// Build only the fixed unpublished payload. The executor must first persist
    /// StageIntent. Errors retain partial data for explicit reconciliation.
    pub(super) fn copy_payload(
        &self,
        intent: &DurableIntent,
        progress: &mut impl crate::files::anchored_copy::CopyProgress,
    ) -> Result<StagedPayload, AppError> {
        use crate::files::{anchored_copy, file_identity::version_at};
        self.verify_manifest(intent)?;
        let spec = intent.operation.replacement()?;
        let claim = intent
            .resources
            .iter()
            .find(|resource| resource.path == spec.source)
            .ok_or_else(|| invalid("Recovery copy lacks source authority"))?;
        let source_parent = Directory::open(
            spec.source
                .0
                .parent()
                .ok_or_else(|| invalid("Recovery copy source has no parent"))?,
        )?;
        let source_name = spec
            .source
            .0
            .file_name()
            .ok_or_else(|| invalid("Recovery copy source has no name"))?;
        let expected = &spec.source_version;
        if claim.ancestors.first() != Some(&of_file(&source_parent.file)?)
            || claim.object != Some(expected.object)
            || version_at(&source_parent, source_name)? != *expected
            || version_at(
                &self.parent,
                spec.target
                    .0
                    .file_name()
                    .ok_or_else(|| invalid("Recovery copy target has no name"))?,
            )? != spec.original
        {
            return Err(invalid(
                "Recovery copy source or destination changed before staging",
            ));
        }
        let copied = anchored_copy::copy_entry(
            &source_parent,
            source_name,
            &self.directory,
            std::ffi::OsStr::new("publication"),
            &spec.source.0,
            expected,
            progress,
        )?;
        if of_file(
            &Directory::open(
                spec.source
                    .0
                    .parent()
                    .ok_or_else(|| invalid("Recovery copy source has no parent"))?,
            )?
            .file,
        )? != of_file(&source_parent.file)?
        {
            return Err(invalid(
                "Recovery copy source parent namespace changed during staging",
            ));
        }
        self.verify_manifest(intent)?;
        Ok(StagedPayload {
            version: copied.version,
            final_mode: copied.final_mode,
        })
    }

    /// Verify the retained handles and both planned namespace links without
    /// creating, repairing or replacing any entry.
    pub(super) fn verify_namespace(&self) -> Result<(), AppError> {
        if of_file(&self.parent.file)? != self.parent_identity
            || of_file(&self.directory.file)? != self.identity
        {
            return Err(invalid("Recovery replacement retained handle changed"));
        }
        validate_directory(&self.directory)?;
        let named_parent = Directory::open(&self.parent_path)?;
        if of_file(&named_parent.file)? != self.parent_identity {
            return Err(invalid(
                "Recovery replacement target parent namespace changed",
            ));
        }
        let named_root = named_parent.open_existing(&self.name)?;
        validate_directory(&named_root)?;
        if of_file(&named_root.file)? != self.identity {
            return Err(invalid(
                "Recovery replacement artifact root namespace changed",
            ));
        }
        Ok(())
    }

    /// Publish the fixed local manifest through the same framed, exclusive and
    /// synchronized format as the global recovery catalog.
    pub(super) fn publish_manifest(&self, intent: &DurableIntent) -> Result<(), AppError> {
        let payload = self.manifest_payload(intent)?;
        self.verify_namespace()?;
        self.catalog()?.ensure_exact(MANIFEST_ID, &payload)?;
        self.verify_namespace()?;
        Ok(())
    }

    /// Read and compare an existing manifest. Missing or malformed evidence is
    /// an error and is never recreated by verification.
    pub(super) fn verify_manifest(&self, intent: &DurableIntent) -> Result<(), AppError> {
        let payload = self.manifest_payload(intent)?;
        self.verify_namespace()?;
        self.catalog()?.read_exact(MANIFEST_ID, &payload)?;
        self.verify_namespace()?;
        Ok(())
    }

    fn catalog(&self) -> Result<Catalog, AppError> {
        let directory = Directory {
            file: self.directory.file.try_clone()?,
        };
        Ok(Catalog::open(directory)?)
    }

    fn manifest_payload(&self, intent: &DurableIntent) -> Result<Vec<u8>, AppError> {
        if digest(intent)? != self.intent_digest {
            return Err(invalid(
                "Recovery replacement intent differs from this artifact root owner",
            ));
        }
        let spec = intent.operation.replacement()?;
        if spec.root.0 != self.path
            || spec.root.0.parent() != Some(self.parent_path.as_path())
            || spec.parent != self.parent_identity
            || spec.original.object != self.original
            || !self.identity.same_volume(spec.parent)
            || self.identity == spec.parent
            || self.identity == spec.original.object
            || intent.resources.iter().any(|resource| {
                resource.path == spec.source && resource.object == Some(self.identity)
            })
        {
            return Err(invalid(
                "Recovery replacement manifest does not belong to this artifact root",
            ));
        }
        serde_json::to_vec(&BorrowedManifest {
            intent,
            root: self.identity,
        })
        .map_err(|error| invalid(&format!("Could not encode recovery manifest: {error}")))
    }
}

fn digest(intent: &DurableIntent) -> Result<[u8; 32], AppError> {
    struct DigestWriter(Sha256);

    impl Write for DigestWriter {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.0.update(bytes);
            Ok(bytes.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    intent.validate()?;
    let mut writer = DigestWriter(Sha256::new());
    serde_json::to_writer(&mut writer, intent)
        .map_err(|error| invalid(&format!("Could not hash recovery intent: {error}")))?;
    Ok(writer.0.finalize().into())
}

fn invalid(message: &str) -> AppError {
    io::Error::new(io::ErrorKind::InvalidData, message.to_owned()).into()
}

#[cfg(test)]
#[path = "../../../test_support/recovery_replacement_artifact.rs"]
mod tests;

#[cfg(test)]
use super::model::OperationSpec;
