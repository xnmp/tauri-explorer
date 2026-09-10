//! Whole-selection preparation on the existing blocking worker. Preparation
//! has no filesystem effects; execution consumes aligned, bounded item plans.
use super::{
    plan::{LayoutPlan, Prepared},
    random_bytes, rename_noreplace_at, Context,
};
use crate::{
    error::AppError,
    files::{
        entry_version::EntryVersion,
        file_identity::version_from_metadata,
        mutation::PublishedEntry,
        recovery::resources::{self, Access, Scope, SelectionIndex, SelectionRole},
        trash_artifact::TrashSuccess,
    },
};
use std::{
    collections::{HashSet, VecDeque},
    fs, io,
    path::{Path, PathBuf},
    sync::Arc,
};

const MAX_PLAN_BYTES: usize = 32 * 1024 * 1024;
type Item = Result<Box<Prepared>, String>;

pub(crate) struct PreparedSelection {
    paths: Arc<Vec<String>>,
    next: usize,
    items: VecDeque<Item>,
}

struct Budget {
    used: usize,
    maximum: usize,
}

impl Budget {
    fn add(&mut self, bytes: usize) -> Result<(), AppError> {
        self.used = self.used.saturating_add(bytes);
        if self.used > self.maximum {
            return Err(AppError::InvalidPath(
                "Trash selection exceeds its prepared memory budget".into(),
            ));
        }
        Ok(())
    }
}

impl Context {
    pub(crate) fn prepare_selection(
        &self,
        paths: Arc<Vec<String>>,
    ) -> Result<PreparedSelection, AppError> {
        self.prepare_selection_with(paths, &mut random_bytes, MAX_PLAN_BYTES, None)
    }

    /// Prepare deletion of the exact native object published by an ordinary
    /// copy. The publication is consumed by this worker and must agree with the
    /// captured physical path, parent and complete entry version before any
    /// trash destination can be created.
    pub(crate) fn prepare_publication(
        &self,
        paths: Arc<Vec<String>>,
        publication: Arc<PublishedEntry>,
    ) -> Result<PreparedSelection, AppError> {
        self.prepare_selection_with(
            paths,
            &mut random_bytes,
            MAX_PLAN_BYTES,
            Some(publication.as_ref()),
        )
    }

    fn prepare_selection_with(
        &self,
        paths: impl Into<Arc<Vec<String>>>,
        random: &mut impl FnMut(&mut [u8]) -> io::Result<()>,
        maximum: usize,
        publication: Option<&PublishedEntry>,
    ) -> Result<PreparedSelection, AppError> {
        let paths = paths.into();
        let mut budget = Budget { used: 0, maximum };
        budget.add(
            paths
                .capacity()
                .saturating_mul(std::mem::size_of::<String>()),
        )?;
        budget.add(paths.len().saturating_mul(std::mem::size_of::<Item>()))?;
        for path in paths.iter() {
            budget.add(path.capacity())?;
        }
        let mut index = SelectionIndex::default();
        // Observe the entire requested namespace before destination planning:
        // a candidate/layout failure cannot erase a selected ancestor or alias.
        let sources = observe_sources(&paths, &mut index, &mut budget)?;
        if let Some(expected) = publication {
            expected.version.validate()?;
            let [source] = sources.as_slice() else {
                return Err(AppError::InvalidPath(
                    "A published copy inverse requires exactly one source".into(),
                ));
            };
            if source.path != expected.path
                || source.version.as_ref() != Some(&expected.version)
                || source.parent != expected.parent
            {
                return Err(AppError::Other(
                    "Published copy identity changed before trash preparation".into(),
                ));
            }
        }
        let mut items = VecDeque::with_capacity(paths.len());
        let mut layouts = HashSet::<Arc<LayoutPlan>>::new();
        for (path, source) in paths.iter().zip(sources) {
            let prepared = match source.version {
                None => Err(AppError::NotFound(path.clone())),
                Some(expected) => self.prepare(&source.path, random).and_then(|prepared| {
                    if prepared.original_path != source.path
                        || prepared.source_version != expected
                        || prepared.source_parent_identity.object() != source.parent
                    {
                        Err(AppError::Other(
                            "Trash source changed during selection preparation".into(),
                        ))
                    } else {
                        Ok(prepared)
                    }
                }),
            };
            let prepared = match prepared {
                Ok(mut prepared) => {
                    budget.add(prepared.retained_bytes())?;
                    share_layout(&mut prepared.layout, &mut layouts, &mut budget)?;
                    if let Some(fallback) = &mut prepared.fallback {
                        share_layout(fallback, &mut layouts, &mut budget)?;
                    }
                    Ok(Box::new(prepared))
                }
                Err(error) => {
                    let message = error.to_string();
                    budget.add(message.capacity())?;
                    Err(message)
                }
            };
            items.push_back(prepared);
        }
        // Unique layouts are captured once; repeated directory trees do not
        // amplify every file into another retained layout or resource set.
        for layout in &layouts {
            layout.visit_resources(|path, access, scope, role| {
                index.insert(&resources::capture(path, access, scope)?, role)?;
                Ok(())
            })?;
        }
        for prepared in items.iter().flatten() {
            prepared.visit_artifacts(|path, scope| {
                index.insert(
                    &resources::capture(path, Access::Write, scope)?,
                    SelectionRole::Exclusive,
                )?;
                Ok(())
            })?;
        }
        Ok(PreparedSelection {
            paths,
            next: 0,
            items,
        })
    }
}

struct ObservedSource {
    path: PathBuf,
    version: Option<EntryVersion>,
    parent: crate::files::object_id::ObjectId,
}

fn observe_sources(
    paths: &[String],
    index: &mut SelectionIndex,
    budget: &mut Budget,
) -> Result<Vec<ObservedSource>, AppError> {
    budget.add(
        paths
            .len()
            .saturating_mul(std::mem::size_of::<ObservedSource>()),
    )?;
    let mut observed = Vec::with_capacity(paths.len());
    for path in paths {
        let mut claims = resources::capture_requests(&[resources::Request {
            path: Path::new(path).to_owned(),
            access: Access::Write,
            scope: Scope::Subtree,
        }])?
        .into_iter();
        let source = claims
            .next()
            .expect("capture retains the primary request first");
        let version = match fs::symlink_metadata(&source.path.0) {
            Ok(metadata) => Some(version_from_metadata(&metadata)?),
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        };
        if source.object != version.as_ref().map(|version| version.object) {
            return Err(AppError::Other(
                "Trash source changed during namespace capture".into(),
            ));
        }
        index.insert(
            &source,
            SelectionRole::Source {
                directory: version.as_ref().is_some_and(|version| version.directory),
            },
        )?;
        for dependency in claims {
            index.insert(&dependency, SelectionRole::Shared)?;
        }
        budget.add(source.path.0.capacity())?;
        observed.push(ObservedSource {
            path: source.path.0,
            version,
            parent: *source
                .ancestors
                .first()
                .expect("validated source has a parent identity"),
        });
    }
    Ok(observed)
}

fn share_layout(
    layout: &mut Arc<LayoutPlan>,
    shared: &mut HashSet<Arc<LayoutPlan>>,
    budget: &mut Budget,
) -> Result<(), AppError> {
    if let Some(existing) = shared.get(layout) {
        *layout = Arc::clone(existing);
    } else {
        // Conservatively include a hash table bucket and its occupancy slack.
        budget.add(layout.retained_bytes() + 4 * std::mem::size_of::<Arc<LayoutPlan>>())?;
        shared.insert(Arc::clone(layout));
    }
    Ok(())
}

impl PreparedSelection {
    pub(crate) fn execute_next(&mut self, requested: &str) -> Result<TrashSuccess, AppError> {
        if self.paths.get(self.next).map(String::as_str) != Some(requested) {
            return Err(AppError::WorkerFailed(
                "Trash execution does not match its prepared selection".into(),
            ));
        }
        let prepared = self.items.pop_front().ok_or_else(|| {
            AppError::WorkerFailed("Trash execution exceeded its prepared selection".into())
        })?;
        self.next += 1;
        prepared.map_err(AppError::Other)?.execute_with(
            rename_noreplace_at,
            |source, files, info| {
                source.sync()?;
                files.sync()?;
                info.sync()
            },
        )
    }
}

#[cfg(test)]
#[path = "../../../test_support/freedesktop_trash_selection.rs"]
mod tests;
