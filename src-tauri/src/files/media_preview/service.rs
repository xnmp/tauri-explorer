//! Bounded native capabilities; no caller-controlled pathname reaches HTTP.
use super::super::{file_identity, native_directory::Directory, object_id::ObjectId};
use crate::{error::AppError, renderer_owner::Owner};
use std::{
    collections::HashMap,
    ffi::OsString,
    fs::File,
    io,
    path::Path,
    sync::{Arc, Mutex},
    time::SystemTime,
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

pub(super) const CHUNK_BYTES: usize = 64 * 1024;
const MAX_LEASES: usize = 64;
const MAX_OWNER_LEASES: usize = 4;

pub(super) struct Service {
    leases: Mutex<HashMap<String, Arc<Lease>>>,
    pub opens: Arc<Semaphore>,
    pub streams: Arc<Semaphore>,
}
pub(super) struct Lease {
    pub renderer: Owner,
    pub lifetime: Owner,
    phase: Mutex<Phase>,
}
enum Phase {
    Provisional,
    Preparing,
    Ready(Arc<MediaFile>),
    Retired,
}

pub(super) struct MediaFile {
    parent: Directory,
    name: OsString,
    // Pin the admitted object so replacement cannot reuse its identity.
    original: File,
    identity: ObjectId,
    pub size: u64,
    modified: SystemTime,
    pub mime: &'static str,
}
pub(super) struct StreamFile {
    pub file: File,
    // Every blocking read retains this guard, even after its body is dropped.
    _permit: OwnedSemaphorePermit,
}
fn unavailable(message: &str) -> AppError {
    AppError::Other(message.into())
}

impl Default for Service {
    fn default() -> Self {
        Self {
            leases: Mutex::new(HashMap::new()),
            opens: Arc::new(Semaphore::new(4)),
            streams: Arc::new(Semaphore::new(16)),
        }
    }
}
impl Lease {
    pub fn active(&self) -> bool {
        self.renderer.active() && self.lifetime.active()
    }
    fn retire(&self) {
        self.lifetime.retire();
        *self.phase.lock().unwrap() = Phase::Retired;
    }
    pub fn file(&self) -> Option<Arc<MediaFile>> {
        if !self.active() {
            return None;
        }
        match &*self.phase.lock().unwrap() {
            Phase::Ready(file) => Some(file.clone()),
            _ => None,
        }
    }
    pub async fn retired(&self) {
        tokio::select! { _ = self.renderer.retired() => {}, _ = self.lifetime.retired() => {} }
    }
}
impl Service {
    #[cfg(feature = "e2e-hooks")]
    pub fn counts(&self) -> (usize, usize, usize) {
        (
            self.leases
                .lock()
                .unwrap()
                .values()
                .filter(|lease| lease.active())
                .count(),
            4 - self.opens.available_permits(),
            16 - self.streams.available_permits(),
        )
    }
    pub fn begin(&self, owner: Owner) -> Result<String, AppError> {
        let mut leases = self.leases.lock().unwrap();
        leases.retain(|_, lease| lease.active());
        if !owner.active() {
            return Err(unavailable("Video preview renderer was replaced"));
        }
        if leases.len() >= MAX_LEASES
            || leases
                .values()
                .filter(|lease| lease.renderer.same(&owner))
                .count()
                >= MAX_OWNER_LEASES
        {
            return Err(unavailable(
                "Too many video previews are open. Close another preview and try again.",
            ));
        }
        let mut bytes = [0; 24];
        getrandom::fill(&mut bytes)
            .map_err(|_| unavailable("Cannot create a video preview capability"))?;
        let token = hex::encode(bytes);
        if leases.contains_key(&token) {
            return Err(unavailable(
                "Cannot create a unique video preview capability",
            ));
        }
        leases.insert(
            token.clone(),
            Arc::new(Lease {
                renderer: owner,
                lifetime: Owner::default(),
                phase: Mutex::new(Phase::Provisional),
            }),
        );
        Ok(token)
    }
    pub fn lookup(&self, token: &str) -> Option<Arc<Lease>> {
        self.leases
            .lock()
            .unwrap()
            .get(token)
            .filter(|lease| lease.active())
            .cloned()
    }
    pub fn release(&self, token: &str, owner: &Owner) {
        let lease = {
            let mut leases = self.leases.lock().unwrap();
            if !leases
                .get(token)
                .is_some_and(|lease| lease.renderer.same(owner))
            {
                return;
            }
            leases.remove(token)
        };
        if let Some(lease) = lease {
            lease.retire();
        }
    }
    pub fn retire_owners(&self) {
        let retired = {
            let mut leases = self.leases.lock().unwrap();
            let keys: Vec<_> = leases
                .iter()
                .filter(|(_, lease)| !lease.renderer.active())
                .map(|(key, _)| key.clone())
                .collect();
            keys.into_iter()
                .filter_map(|key| leases.remove(&key))
                .collect::<Vec<_>>()
        };
        for lease in retired {
            lease.retire();
        }
    }
    pub async fn prepare(
        &self,
        token: &str,
        owner: &Owner,
        path: String,
        allowed: impl Fn(&Path) -> bool + Send + 'static,
    ) -> Result<(), AppError> {
        let lease = self
            .lookup(token)
            .filter(|lease| lease.renderer.same(owner))
            .ok_or_else(|| unavailable("Video preview was released"))?;
        // Busy admission leaves a provisional capability available for retry.
        // Once transitioned, every accepted worker retains this permit.
        let permit = self
            .opens
            .clone()
            .try_acquire_owned()
            .map_err(|_| unavailable("Video file access is busy. Try again."))?;
        {
            let mut phase = lease.phase.lock().unwrap();
            if !matches!(*phase, Phase::Provisional) {
                return Err(unavailable("Video preview is already preparing or ready"));
            }
            *phase = Phase::Preparing;
        }
        // The blocking worker owns admission until it really returns.
        let admitted = lease.clone();
        let result = super::super::run_blocking(move || {
            let _permit = permit;
            if !admitted.active() {
                return Err(unavailable("Video preview was released"));
            }
            MediaFile::open(Path::new(&path), allowed).map(Arc::new)
        })
        .await;
        let mut phase = lease.phase.lock().unwrap();
        if !lease.active() {
            return Err(unavailable("Video preview was released"));
        }
        match result {
            Ok(file) => {
                *phase = Phase::Ready(file);
                Ok(())
            }
            Err(error) => {
                *phase = Phase::Retired;
                lease.lifetime.retire();
                Err(error)
            }
        }
    }
}

fn mime(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "mp4" | "m4v" => Some("video/mp4"),
        "mov" => Some("video/quicktime"),
        "webm" => Some("video/webm"),
        "mkv" => Some("video/x-matroska"),
        "avi" => Some("video/x-msvideo"),
        "wmv" => Some("video/x-ms-wmv"),
        "flv" => Some("video/x-flv"),
        "mpg" | "mpeg" => Some("video/mpeg"),
        _ => None,
    }
}
impl MediaFile {
    fn open(path: &Path, allowed: impl Fn(&Path) -> bool) -> Result<Self, AppError> {
        let mime =
            mime(path).ok_or_else(|| unavailable("This file type is not a video preview"))?;
        if !allowed(path) {
            return Err(AppError::PermissionDenied(
                "This location is outside the video preview scope".into(),
            ));
        }
        let canonical = std::fs::canonicalize(path)?;
        if !allowed(&canonical) {
            return Err(AppError::PermissionDenied(
                "The video target is outside the preview scope".into(),
            ));
        }
        let parent = Directory::open(
            canonical
                .parent()
                .ok_or_else(|| unavailable("Video has no parent directory"))?,
        )?;
        let name = canonical
            .file_name()
            .ok_or_else(|| unavailable("Video has no filename"))?
            .to_os_string();
        let original = parent.open_file(&name)?;
        let metadata = original.metadata()?;
        if !metadata.is_file() {
            return Err(unavailable("Video preview requires a regular file"));
        }
        Ok(Self {
            identity: file_identity::of_file(&original)?,
            size: metadata.len(),
            modified: metadata.modified()?,
            parent,
            name,
            original,
            mime,
        })
    }
    pub fn open_stream(&self, permit: OwnedSemaphorePermit) -> io::Result<Arc<StreamFile>> {
        let file = self.parent.open_file(&self.name)?;
        let metadata = file.metadata()?;
        if !metadata.is_file()
            || file_identity::of_file(&file)? != self.identity
            || metadata.len() != self.size
            || metadata.modified()? != self.modified
            || file_identity::of_file(&self.original)? != self.identity
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Video changed; select it again to reload",
            ));
        }
        Ok(Arc::new(StreamFile {
            file,
            _permit: permit,
        }))
    }
}
pub(super) fn read_chunk(file: &File, offset: u64, remaining: u64) -> io::Result<bytes::Bytes> {
    let mut bytes = vec![0; remaining.min(CHUNK_BYTES as u64) as usize];
    #[cfg(unix)]
    let count = {
        use std::os::unix::fs::FileExt;
        file.read_at(&mut bytes, offset)?
    };
    #[cfg(windows)]
    let count = {
        use std::os::windows::fs::FileExt;
        file.seek_read(&mut bytes, offset)?
    };
    if count == 0 && remaining != 0 {
        return Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "Video ended before the declared range",
        ));
    }
    #[cfg(feature = "e2e-hooks")]
    super::metrics::record_read(count);
    bytes.truncate(count);
    Ok(bytes::Bytes::from(bytes))
}
