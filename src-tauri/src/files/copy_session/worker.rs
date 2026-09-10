//! Filesystem inspection and copy execution for the ordered session.
use super::{control::Control, model::Conflict, Inspection, Work};
use crate::{
    error::AppError,
    files::{self, file_ops, mutation::FileMutationReceipt, WorkerCompletion},
    progress::ProgressTracker,
};
#[cfg(target_os = "linux")]
use std::path::PathBuf;
use std::{fs, path::Path, sync::Arc};

#[derive(Clone)]
pub(crate) struct NativeWork {
    pub app: Option<tauri::AppHandle>,
    pub job_id: u64,
    #[cfg(target_os = "linux")]
    pub recovery: (files::recovery::Runtime, PathBuf),
}

impl Work for NativeWork {
    async fn inspect(
        &self,
        source: String,
        destination: String,
        remaining: usize,
    ) -> Result<Inspection, AppError> {
        files::run_blocking(move || inspect(source, destination, remaining)).await
    }

    async fn copy(
        &self,
        inspection: Inspection,
        overwrite: bool,
        control: Arc<Control>,
        progress: Arc<dyn Fn(crate::progress::ByteProgress) + Send + Sync>,
    ) -> WorkerCompletion<FileMutationReceipt> {
        files::run_blocking_context(
            CopyWork {
                native: self.clone(),
                inspection,
                overwrite,
                control,
                progress,
            },
            CopyWork::execute,
        )
        .await
    }
}

fn inspect(source: String, destination: String, remaining: usize) -> Result<Inspection, AppError> {
    let path = Path::new(&source);
    let name = path
        .file_name()
        .ok_or_else(|| AppError::InvalidPath("Copy source has no name".into()))?;
    // Resolve aliases per child. The following worker uses these exact physical
    // spellings even if a user retargets a symlink while answering a prompt.
    let source_parent = fs::canonicalize(
        path.parent()
            .ok_or_else(|| AppError::InvalidPath("Copy source has no parent".into()))?,
    )?;
    let physical_source = source_parent.join(name);
    let presentation = destination;
    let destination = fs::canonicalize(&presentation)?;
    if !destination.is_dir() {
        return Err(AppError::InvalidPath(
            "Copy destination is not a directory".into(),
        ));
    }
    let source_meta = fs::symlink_metadata(&physical_source)?;
    let target = destination.join(name);
    let target_meta = match fs::symlink_metadata(&target) {
        Ok(meta) => Some(meta),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.into()),
    };
    #[cfg(target_os = "linux")]
    let observation = Some(files::mutation::CopyObservation {
        source: files::file_identity::version_from_metadata(&source_meta)?,
        parent: files::file_identity::of_file(
            &files::native_directory::Directory::open(&destination)?.file,
        )?,
        target: target_meta
            .as_ref()
            .map(files::file_identity::version_from_metadata)
            .transpose()?,
    });
    let conflict = if source_parent == destination {
        None
    } else {
        target_meta.as_ref().map(|meta| {
            let original = files::metadata_to_entry_with_git_repo_probe(&target, meta, false);
            let source_entry =
                files::metadata_to_entry_with_git_repo_probe(&physical_source, &source_meta, false);
            Conflict {
                file_name: name.to_string_lossy().into_owned(),
                source_path: source.clone(),
                remaining,
                source_size: source_entry.size,
                source_modified: source_entry.modified,
                dest_size: original.size,
                dest_modified: original.modified,
            }
        })
    };
    Ok(Inspection {
        source: physical_source.to_string_lossy().into_owned(),
        destination: destination.to_string_lossy().into_owned(),
        presentation,
        conflict,
        bytes: if source_meta.is_dir() {
            0
        } else {
            source_meta.len()
        },
        #[cfg(target_os = "linux")]
        observation,
    })
}

struct CopyWork {
    native: NativeWork,
    inspection: Inspection,
    overwrite: bool,
    control: Arc<Control>,
    progress: Arc<dyn Fn(crate::progress::ByteProgress) + Send + Sync>,
}
impl CopyWork {
    fn execute(&mut self) -> Result<FileMutationReceipt, AppError> {
        let mut tracker = ProgressTracker::new(
            self.native.app.as_ref(),
            "copy-progress",
            "Copy cancelled",
            self.native.job_id,
            self.inspection.bytes,
            Some(self.control.cancelled.cancellation_flag()),
        )
        .report_to(self.progress.as_ref());
        let source = Path::new(&self.inspection.source);
        let destination = Path::new(&self.inspection.destination);
        #[cfg(target_os = "linux")]
        let result = {
            file_ops::copy_entry_tracked(
                source,
                destination,
                Some(self.overwrite),
                &mut tracker,
                self.inspection.observation.as_ref(),
                |source, _, target, tracker| {
                    self.native.recovery.0.copy_overwriting(
                        self.native.recovery.1.clone(),
                        source,
                        target,
                        self.inspection.observation.as_ref(),
                        tracker,
                    )
                },
            )
        };
        #[cfg(not(target_os = "linux"))]
        let result = file_ops::copy_entry_tracked(
            source,
            destination,
            Some(self.overwrite),
            &mut tracker,
            None,
            file_ops::copy_entry_overwriting,
        );
        result.map(|mut receipt| {
            // Preserve pane aliases only while they still name the inspected
            // directory. Native inverse keys remain physical on publication.
            if fs::canonicalize(&self.inspection.presentation)
                .ok()
                .as_deref()
                == Some(destination)
            {
                if let Some(name) = Path::new(&receipt.path).file_name() {
                    receipt.path = Path::new(&self.inspection.presentation)
                        .join(name)
                        .to_string_lossy()
                        .into_owned();
                    if let Some(entry) = &mut receipt.entry {
                        entry.path = receipt.path.clone();
                    }
                }
            }
            receipt
        })
    }
}
