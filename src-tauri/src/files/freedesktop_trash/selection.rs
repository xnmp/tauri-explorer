//! Whole-selection preparation on the existing blocking worker. Preparation
//! has no filesystem effects; execution consumes aligned, bounded item plans.
use super::{
    plan::{LayoutPlan, Prepared},
    random_bytes, rename_noreplace_at, Context,
};
use crate::{
    error::AppError,
    files::{
        mutation::PublishedEntry,
        prepared_selection::{self, ObservedSource, Preparation, SelectionItem, MAX_PLAN_BYTES},
        recovery::resources::{self, Access, SelectionRole},
        trash_artifact::TrashSuccess,
    },
};
use std::{collections::HashSet, io, path::Path, sync::Arc};

pub(crate) type PreparedSelection = prepared_selection::PreparedSelection<Box<Prepared>>;

impl SelectionItem for Box<Prepared> {
    const NOUN: &'static str = "Trash";
    const EXECUTION: &'static str = "Trash execution";

    fn retained_bytes(&self) -> usize {
        Prepared::retained_bytes(self)
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
        PreparedSelection::prepare(paths.into(), maximum, |selection, paths| {
            // Observe the entire requested namespace before destination
            // planning: a candidate/layout failure cannot erase a selected
            // ancestor or alias.
            let sources = observe_sources(paths, publication, selection)?;
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
                        share_layout(&mut prepared.layout, &mut layouts, selection)?;
                        if let Some(fallback) = &mut prepared.fallback {
                            share_layout(fallback, &mut layouts, selection)?;
                        }
                        Ok(Box::new(prepared))
                    }
                    Err(error) => Err(error),
                };
                selection.push(prepared)?;
            }
            // Unique layouts are captured once; repeated directory trees do not
            // amplify every file into another retained layout or resource set.
            for layout in &layouts {
                layout.visit_resources(|path, access, scope, role| {
                    selection.claim(&resources::capture(path, access, scope)?, role)?;
                    Ok(())
                })?;
            }
            selection.claim_prepared(|prepared, claims| {
                prepared.visit_artifacts(|path, scope| {
                    claims.insert(
                        &resources::capture(path, Access::Write, scope)?,
                        SelectionRole::Exclusive,
                    )?;
                    Ok(())
                })
            })
        })
    }
}

fn observe_sources(
    paths: &[String],
    publication: Option<&PublishedEntry>,
    selection: &mut Preparation<Box<Prepared>>,
) -> Result<Vec<ObservedSource>, AppError> {
    selection.retain(
        paths
            .len()
            .saturating_mul(std::mem::size_of::<ObservedSource>()),
    )?;
    let mut observed = Vec::with_capacity(paths.len());
    for path in paths {
        // A publication carries native authority even when its display key
        // cannot represent the physical filename as UTF-8.
        observed.push(
            selection.observe(
                publication.map_or_else(|| Path::new(path), |entry| entry.path.as_path()),
            )?,
        );
    }
    Ok(observed)
}

fn share_layout(
    layout: &mut Arc<LayoutPlan>,
    shared: &mut HashSet<Arc<LayoutPlan>>,
    selection: &mut Preparation<Box<Prepared>>,
) -> Result<(), AppError> {
    if let Some(existing) = shared.get(layout) {
        *layout = Arc::clone(existing);
    } else {
        // Conservatively include a hash table bucket and its occupancy slack.
        selection.retain(layout.retained_bytes() + 4 * std::mem::size_of::<Arc<LayoutPlan>>())?;
        shared.insert(Arc::clone(layout));
    }
    Ok(())
}

impl PreparedSelection {
    pub(crate) fn execute_next(&mut self, requested: &str) -> Result<TrashSuccess, AppError> {
        self.run_next(requested, |prepared| {
            prepared.execute_with(rename_noreplace_at, |source, files, info| {
                source.sync()?;
                files.sync()?;
                info.sync()
            })
        })
    }
}

#[cfg(test)]
#[path = "../../../test_support/freedesktop_trash_selection.rs"]
mod tests;
