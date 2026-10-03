//! Immutable image capture and validation. The renderer edits captured bytes,
//! never a mutable asset URL. Save execution rechecks this exact source.
use crate::{error::AppError, image_crop};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

// Keep the IPC capture bounded independently of the encoder's output limit.
const MAX_CAPTURE_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SourceRevision {
    digest: String,
    size: u64,
    modified_seconds: u64,
    modified_nanos: u32,
    identity: String,
    readonly: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Capture {
    path: String,
    revision: SourceRevision,
    data_url: String,
    format: &'static str,
}

fn changed() -> AppError {
    AppError::Other("The original image changed. Close the crop editor and open it again.".into())
}

fn observation(file: &File) -> Result<SourceRevision, AppError> {
    let metadata = file.metadata()?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() > MAX_CAPTURE_BYTES
    {
        return Err(AppError::Other(
            "Crop requires a regular image file of at most 32 MiB".into(),
        ));
    }
    let modified = metadata
        .modified()?
        .duration_since(UNIX_EPOCH)
        .map_err(|error| AppError::Other(error.to_string()))?;
    #[cfg(unix)]
    let identity = {
        use std::os::unix::fs::MetadataExt;
        format!(
            "{}:{}:{}:{}:{}",
            metadata.dev(),
            metadata.ino(),
            metadata.mode(),
            metadata.uid(),
            metadata.gid()
        )
    };
    #[cfg(windows)]
    let identity = {
        use std::{mem::size_of, os::windows::io::AsRawHandle};
        use windows::Win32::{
            Foundation::HANDLE,
            Storage::FileSystem::{FileIdInfo, GetFileInformationByHandleEx, FILE_ID_INFO},
        };
        let mut info = FILE_ID_INFO::default();
        // SAFETY: borrowed live handle and exact writable FILE_ID_INFO buffer.
        unsafe {
            GetFileInformationByHandleEx(
                HANDLE(file.as_raw_handle()),
                FileIdInfo,
                (&mut info as *mut FILE_ID_INFO).cast(),
                size_of::<FILE_ID_INFO>() as u32,
            )
        }
        .map_err(|error| AppError::Other(error.to_string()))?;
        format!(
            "{}:{}",
            info.VolumeSerialNumber,
            hex::encode(info.FileId.Identifier)
        )
    };
    #[cfg(not(any(unix, windows)))]
    return Err(AppError::Other(
        "Image crop is unsupported on this host".into(),
    ));
    #[cfg(any(unix, windows))]
    Ok(SourceRevision {
        digest: String::new(),
        size: metadata.len(),
        modified_seconds: modified.as_secs(),
        modified_nanos: modified.subsec_nanos(),
        identity,
        readonly: metadata.permissions().readonly(),
    })
}

/// Retain one file handle across observation, bounded reading and final checks.
/// A symlink leaf is refused; parent aliases are resolved once at capture.
pub(super) fn read_source(
    path: &Path,
) -> Result<(Vec<u8>, SourceRevision, fs::Permissions), AppError> {
    if fs::symlink_metadata(path)?.file_type().is_symlink() {
        return Err(AppError::Other(
            "Open the image itself to crop it; symbolic links cannot be cropped".into(),
        ));
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(windows::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT.0);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let mut file = options.open(path)?;
    let mut before = observation(&file)?;
    let permissions = file.metadata()?.permissions();
    let mut bytes = Vec::with_capacity(before.size as usize);
    (&mut file)
        .take(MAX_CAPTURE_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_CAPTURE_BYTES
        || before != observation(&file)?
        || bytes.len() as u64 != before.size
    {
        return Err(changed());
    }
    // Reopening is a namespace check only. All returned bytes came from the
    // retained handle; a replacement with identical contents still changes ID.
    if before != observation(&options.open(path)?)? {
        return Err(changed());
    }
    before.digest = hex::encode(Sha256::digest(&bytes));
    Ok((bytes, before, permissions))
}

pub(super) fn verify_source(
    path: &Path,
    expected: &SourceRevision,
) -> Result<(Vec<u8>, fs::Permissions), AppError> {
    let (bytes, revision, permissions) = read_source(path)?;
    if &revision != expected {
        return Err(changed());
    }
    Ok((bytes, permissions))
}

fn capture(path: PathBuf) -> Result<Capture, AppError> {
    capture_with_preview_limit(path, MAX_CAPTURE_BYTES)
}

fn capture_with_preview_limit(path: PathBuf, preview_limit: u64) -> Result<Capture, AppError> {
    let parent = fs::canonicalize(
        path.parent()
            .ok_or_else(|| AppError::InvalidPath("Image has no parent directory".into()))?,
    )?;
    let path = parent.join(
        path.file_name()
            .ok_or_else(|| AppError::InvalidPath("Image has no filename".into()))?,
    );
    let (bytes, revision, _) = read_source(&path)?;
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let (format, mime) = match extension.as_str() {
        "jpg" | "jpeg" => ("JPEG", "image/jpeg"),
        "png" => ("PNG", "image/png"),
        "gif" => ("GIF", "image/gif"),
        "webp" => ("WebP", "image/webp"),
        "bmp" => ("BMP", "image/bmp"),
        "svg" => ("SVG", "image/svg+xml"),
        "avif" => ("AVIF", "image/png"),
        "icns" => ("ICNS", "image/png"),
        _ => {
            return Err(AppError::Other(
                "This image format cannot be cropped".into(),
            ))
        }
    };
    if image_crop::format_name(&bytes)? != format {
        return Err(AppError::Other("The image contents do not match its filename extension; correct the extension before cropping".into()));
    }
    let preview = if format == "ICNS" {
        image_crop::icon_preview(&bytes)?
    } else {
        image_crop::canonical_preview(&bytes)?.unwrap_or(bytes)
    };
    if preview.len() as u64 > preview_limit {
        return Err(AppError::Other(
            "Normalized image preview exceeds the crop capture size limit".into(),
        ));
    }
    Ok(Capture {
        path: path.to_string_lossy().into_owned(),
        revision,
        format,
        data_url: format!("data:{mime};base64,{}", STANDARD.encode(preview)),
    })
}

#[tauri::command]
pub(crate) async fn capture_image_crop(
    window: tauri::Window,
    session_id: String,
    path: String,
) -> Result<Capture, AppError> {
    let owner = crate::renderer_owner::acquire_owner(&window, &session_id)?;
    super::worker::run_blocking_owned(owner, move || capture(PathBuf::from(path))).await
}

#[derive(Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum Destination {
    Copy { name: String },
    Replace,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SaveRequest {
    path: String,
    revision: SourceRevision,
    rect: image_crop::CropRect,
    viewport: image_crop::SvgViewport,
    destination: Destination,
}

pub(crate) struct SavePlan {
    source: PathBuf,
    target: PathBuf,
    request: SaveRequest,
}

impl SavePlan {
    pub(crate) fn trace_metadata(&self) -> crate::trace::CropMetadata {
        crate::trace::CropMetadata {
            source_path: self.source.to_string_lossy().into_owned(),
            source_digest: self.request.revision.digest.clone(),
            rect: self.request.rect,
            viewport: self.request.viewport,
        }
    }

    pub(crate) fn new(request: SaveRequest) -> Result<Self, AppError> {
        let source = PathBuf::from(&request.path);
        if !source.is_absolute() {
            return Err(AppError::InvalidPath(
                "Crop requires an absolute source path".into(),
            ));
        }
        image_crop::dimensions(request.viewport.width, request.viewport.height)?;
        request
            .rect
            .validate(request.viewport.width, request.viewport.height)?;
        if request.revision.digest.len() != 64
            || !request
                .revision
                .digest
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
            || request.revision.identity.len() > 128
            || request.revision.size > MAX_CAPTURE_BYTES
            || request.revision.modified_nanos >= 1_000_000_000
        {
            return Err(AppError::Other("Invalid captured image revision".into()));
        }
        let target = match &request.destination {
            Destination::Replace => source.clone(),
            Destination::Copy { name } => {
                super::entry_plan::validate_entry_name(name)?;
                let source_extension = source
                    .extension()
                    .and_then(|extension| extension.to_str())
                    .unwrap_or_default();
                let extension = Path::new(name)
                    .extension()
                    .and_then(|extension| extension.to_str())
                    .unwrap_or_default();
                if !source_extension.eq_ignore_ascii_case(extension) {
                    return Err(AppError::Other(
                        "Keep the original image extension when saving a crop".into(),
                    ));
                }
                let target = source
                    .parent()
                    .ok_or_else(|| AppError::InvalidPath("Image has no parent directory".into()))?
                    .join(name);
                if target == source {
                    return Err(AppError::Other(
                        "Choose a separate copy filename, or confirm replacement of the original"
                            .into(),
                    ));
                }
                target
            }
        };
        Ok(Self {
            source,
            target,
            request,
        })
    }
    pub(crate) fn affected_dirs(&self) -> Vec<String> {
        self.target
            .parent()
            .map(|path| path.to_string_lossy().into_owned())
            .into_iter()
            .collect()
    }
    fn execute(self, runtime: &super::admission::Runtime) -> Result<ExecutedCrop, AppError> {
        let (bytes, permissions) = verify_source(&self.source, &self.request.revision)?;
        let encoded = image_crop::encode_with_viewport(
            &bytes,
            self.request.rect,
            Some(self.request.viewport),
        )?;
        let output_digest = hex::encode(Sha256::digest(&encoded));
        // Unsupported codecs and invalid crops fail before any filesystem effect.
        drop(bytes);
        verify_source(&self.source, &self.request.revision)?;
        let parent = self
            .target
            .parent()
            .ok_or_else(|| AppError::InvalidPath("Crop destination has no parent".into()))?;
        #[cfg(target_os = "linux")]
        let parent_identity =
            super::file_identity::of_file(&super::native_directory::Directory::open(parent)?.file)?;
        let stage = super::publication::StagedEntry::prepare(parent, |path| {
            let mut writer = fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(path)?;
            writer.write_all(&encoded)?;
            writer.set_permissions(permissions)?;
            writer.sync_all()?;
            Ok(())
        })?;
        verify_source(&self.source, &self.request.revision)?;
        #[cfg(target_os = "linux")]
        if matches!(self.request.destination, Destination::Replace)
            && super::recovery::Runtime::DURABLE
        {
            // Keep the independent generated source and its parent alive through
            // displacement AND publication. Completed Undo owns journal artifacts.
            return runtime
                .replace_generated(stage.payload(), &self.target, &self.request.revision)
                .map(|receipt| ExecutedCrop {
                    receipt,
                    output_digest,
                });
        }
        let _ = runtime;
        let publish = || {
            #[cfg(target_os = "linux")]
            {
                let publication =
                    stage.publish_observed_in(&self.target, Some(&parent_identity))?;
                let mut receipt =
                    super::mutation::FileMutationReceipt::committed(&publication.path);
                receipt.publication = Some(publication.into());
                Ok(receipt)
            }
            #[cfg(not(target_os = "linux"))]
            {
                stage.publish(&self.target)?;
                Ok(super::mutation::FileMutationReceipt::committed(
                    &self.target,
                ))
            }
        };
        let receipt = match self.request.destination {
            Destination::Copy { .. } => publish(),
            Destination::Replace => {
                let (mut receipt, displaced) = super::replacement::replace_verified(
                    &self.target,
                    |held| verify_source(held, &self.request.revision).map(|_| ()),
                    publish,
                )?;
                // Transient replacement has no retained native undo authority.
                // A Copy inverse would incorrectly delete the replacement.
                receipt.publication = None;
                displaced.discard();
                Ok(receipt)
            }
        }?;
        Ok(ExecutedCrop {
            receipt,
            output_digest,
        })
    }
}

impl super::admission::Plan for SavePlan {
    #[cfg(target_os = "linux")]
    fn resources(&self) -> Vec<super::recovery::ResourceRequest> {
        use super::recovery::{Access, ResourceRequest, Scope};
        vec![
            ResourceRequest {
                path: self.target.clone(),
                access: Access::Write,
                scope: Scope::Subtree,
            },
            ResourceRequest {
                path: self.source.clone(),
                access: Access::Read,
                scope: Scope::Entry,
            },
        ]
    }
    #[cfg(target_os = "linux")]
    fn resolve(mut self, paths: impl Iterator<Item = PathBuf>) -> Result<Self, AppError> {
        let [target, source]: [_; 2] = paths
            .collect::<Vec<_>>()
            .try_into()
            .map_err(|_| AppError::Other("Invalid crop admission bindings".into()))?;
        if source.parent() != target.parent()
            || source.file_name() != self.source.file_name()
            || target.file_name() != self.target.file_name()
            || (matches!(self.request.destination, Destination::Replace) && source != target)
        {
            return Err(AppError::Other(
                "Image crop paths changed during admission".into(),
            ));
        }
        self.source = source;
        self.target = target;
        Ok(self)
    }
}

pub(crate) struct Outcome {
    pub(crate) completion: super::WorkerCompletion<super::mutation::FileMutationReceipt>,
    pub(crate) affected: Vec<String>,
    pub(crate) output_digest: Option<String>,
}

struct ExecutedCrop {
    receipt: super::mutation::FileMutationReceipt,
    output_digest: String,
}

fn completed(completion: super::WorkerCompletion<ExecutedCrop>, affected: Vec<String>) -> Outcome {
    let (result, output_digest) = match completion.result {
        Ok(executed) => (Ok(executed.receipt), Some(executed.output_digest)),
        Err(error) => (Err(error), None),
    };
    Outcome {
        completion: super::WorkerCompletion {
            result,
            warning: completion.warning,
        },
        affected,
        output_digest,
    }
}
impl super::admission::Settle for Outcome {
    fn refused(error: AppError) -> Self {
        Self {
            completion: super::WorkerCompletion {
                result: Err(error),
                warning: None,
            },
            affected: Vec::new(),
            output_digest: None,
        }
    }
    fn unretired(&mut self, error: AppError) {
        let warning = super::admission::unretired_warning("Image crop", &error);
        self.completion.warning = Some(match self.completion.warning.take() {
            Some(previous) => format!("{previous}\n{warning}"),
            None => warning,
        });
    }
}
pub(crate) async fn execute(plan: SavePlan, runtime: &super::admission::Runtime) -> Outcome {
    let worker_runtime = runtime.clone();
    #[cfg(target_os = "linux")]
    if super::recovery::Runtime::DURABLE && matches!(plan.request.destination, Destination::Replace)
    {
        // Durable replacement reserves its own exact source/target/artifact
        // claims. An outer transient reservation would conflict with them.
        let affected = plan.affected_dirs();
        let completion = super::run_blocking_context((Some(plan), worker_runtime), |work| {
            work.0.take().expect("crop executes once").execute(&work.1)
        })
        .await;
        return completed(completion, affected);
    }
    super::admission::admitted_execute(plan, runtime, move |plan, owner| async move {
        let affected = plan.affected_dirs();
        let completion = super::run_blocking_context((Some(plan), worker_runtime, owner), |work| {
            work.0.take().expect("crop executes once").execute(&work.1)
        })
        .await;
        completed(completion, affected)
    })
    .await
}

#[cfg(test)]
#[path = "../../test_support/image_crop_capture.rs"]
mod tests;
