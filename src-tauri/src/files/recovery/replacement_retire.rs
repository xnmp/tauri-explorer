//! Identity-checked planning, removal and measurement of one artifact root's
//! contents. Every removal here is authorized by the caller's journaled discard
//! intent; nothing in this file decides *whether* an artifact may be destroyed.

use super::super::{model::DurableIntent, model::EntryVersion, move_cleanup::Plan};
use super::Root;
use crate::files::recovery::artifact_layout::probe;
use crate::{error::AppError, files::native_directory::Directory};
use std::{ffi::OsStr, io};

/// Recovery roots are our own private storage; these bounds exist so a
/// substituted or pathological namespace cannot make measurement unbounded.
const MAX_DEPTH: usize = 256;
const MAX_ENTRIES: usize = 65_536;
const MANIFEST: &str = "manifest.intent";

impl Root {
    /// Bounded measurement of every payload entry a root retains, excluding
    /// its own manifest, so retained bytes are accounted even before a
    /// retirement plan exists. `None` means the walk exceeded its bounds; it
    /// is never reported as zero.
    pub(in crate::files::recovery) fn measure_payload(&self) -> Result<Option<u64>, AppError> {
        let mut budget = MAX_ENTRIES;
        let mut total = 0u64;
        for name in self.directory.names(MAX_ENTRIES)? {
            if name == MANIFEST {
                continue;
            }
            match measure(&self.directory, &name, 0, &mut budget) {
                Ok(bytes) => total = total.saturating_add(bytes),
                // Over bounds is unknown, never zero.
                Err(_) => return Ok(None),
            }
        }
        Ok(Some(total))
    }

    /// A root owns an exact child set: its manifest and at most its one
    /// expected payload. A missing manifest is acceptable only after a
    /// journaled removal consumed the payload; a mismatching manifest is never
    /// treated as missing.
    pub(in crate::files::recovery) fn verify_retirement(
        &self,
        intent: &DurableIntent,
        expected: Option<&(&str, Vec<EntryVersion>)>,
        plan: Option<&Plan>,
        removing: bool,
    ) -> Result<(), AppError> {
        self.verify_namespace()?;
        let names = self.directory.names(3)?;
        let manifest = OsStr::new(MANIFEST);
        let payload_name = expected.map(|(name, _)| OsStr::new(name));
        if names
            .iter()
            .any(|name| name != manifest && Some(name.as_os_str()) != payload_name)
        {
            return Err(invalid(
                "Recovery artifact contains an unplanned entry; evidence is preserved",
            ));
        }
        let payload_present =
            payload_name.is_some_and(|name| names.iter().any(|entry| entry == name));
        if names.iter().any(|name| name == manifest) {
            self.verify_manifest(intent)?;
        } else if !removing || payload_present {
            return Err(invalid(
                "Recovery artifact manifest is missing before payload removal",
            ));
        }
        if let Some((name, versions)) = expected {
            match probe(&self.directory, OsStr::new(name))? {
                Some(actual) if versions.contains(&actual) => {}
                // An explicitly authorized tree can be partially unlinked at a
                // crash. Keep requiring its exact directory object and metadata
                // other than the size/mtime changed by removing its children.
                Some(actual)
                    if removing
                        && versions.iter().any(|version| {
                            actual.directory
                                && version.directory
                                && actual.object == version.object
                                && actual.mode == version.mode
                                && actual.uid == version.uid
                                && actual.gid == version.gid
                        }) => {}
                None if removing => {}
                _ => {
                    return Err(invalid(
                        "Retained recovery payload changed or disappeared; evidence is preserved",
                    ))
                }
            }
        }
        if let Some(plan) = plan {
            plan.verify(&self.directory, &self.path, removing)?;
        }
        self.verify_namespace()
    }

    pub(in crate::files::recovery) fn plan_retirement(
        &self,
        intent: &DurableIntent,
        expected: Option<&(&str, Vec<EntryVersion>)>,
    ) -> Result<Plan, AppError> {
        self.verify_retirement(intent, expected, None, false)?;
        let plan = Plan::capture(&self.directory, &self.path, expected.map(|(name, _)| *name))?;
        plan.validate(
            &self.path,
            expected.map(|(name, versions)| (*name, versions.as_slice())),
        )?;
        self.verify_retirement(intent, expected, None, false)?;
        plan.verify(&self.directory, &self.path, false)?;
        Ok(plan)
    }

    /// Read-only proof, before the discard decision is journaled, that this
    /// user may unlink every planned entry, the manifest and the root itself.
    pub(in crate::files::recovery) fn preflight_retirement(
        &self,
        plan: &Plan,
    ) -> Result<(), AppError> {
        for directory in [&self.parent, &self.directory] {
            directory.permits_entry_removal().map_err(|error| {
                AppError::PermissionDenied(format!(
                    "Discard cannot remove this recovery folder ({error}). \
                     Nothing was removed and its recovery record is unchanged."
                ))
            })?;
        }
        plan.preflight(&self.directory, &self.path)
    }

    /// Remove the recorded child first and the manifest last. This never
    /// sweeps arbitrary entries in a root: only the captured plan is removed.
    pub(in crate::files::recovery) fn retire_artifacts(
        self,
        intent: &DurableIntent,
        expected: Option<&(&str, Vec<EntryVersion>)>,
        plan: &Plan,
        checkpoint: &mut impl FnMut(&'static str) -> Result<(), AppError>,
    ) -> Result<(), AppError> {
        self.verify_retirement(intent, expected, Some(plan), true)?;
        if expected.is_some() {
            plan.remove(&self.directory, &self.path, checkpoint)?;
            self.directory.sync()?;
            checkpoint("payload-removed")?;
        }
        self.verify_retirement(intent, None, Some(plan), true)?;
        let manifest = OsStr::new(MANIFEST);
        if self.directory.entry_exists(manifest)? {
            self.verify_manifest(intent)?;
            self.directory.unlink(manifest, false)?;
            self.directory.sync()?;
        }
        checkpoint("manifest-removed")?;
        self.verify_namespace()?;
        // rmdir refuses any unexpected entry that arrived after verification.
        self.parent.unlink(&self.name, true)?;
        self.parent.sync()?;
        if self.parent.entry_exists(&self.name)? {
            return Err(invalid(
                "Recovery artifact root reappeared after retirement",
            ));
        }
        Ok(())
    }
}

fn measure(
    parent: &Directory,
    name: &OsStr,
    depth: usize,
    budget: &mut usize,
) -> Result<u64, AppError> {
    if depth > MAX_DEPTH {
        return Err(invalid("Recovery artifact exceeds its measurement depth"));
    }
    *budget = budget
        .checked_sub(1)
        .ok_or_else(|| invalid("Recovery artifact exceeds its measurement entry limit"))?;
    let stat = parent.stat(name)?;
    let bytes = u64::try_from(stat.st_size).unwrap_or(0);
    if stat.st_mode & libc::S_IFMT != libc::S_IFDIR {
        return Ok(bytes);
    }
    let directory = parent.open_existing(name)?;
    let mut total = bytes;
    for child in directory.names(MAX_ENTRIES)? {
        total = total.saturating_add(measure(&directory, &child, depth + 1, budget)?);
    }
    Ok(total)
}

fn invalid(message: &str) -> AppError {
    io::Error::new(io::ErrorKind::InvalidData, message.to_owned()).into()
}
