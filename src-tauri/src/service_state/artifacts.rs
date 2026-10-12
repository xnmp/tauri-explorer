use super::{
    model::*,
    rules::*,
    store::{decode, encode, sql, Store},
};
use rusqlite::{params, OptionalExtension};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Cursor, Read, Write},
    path::{Path, PathBuf},
};
const INPUT: u64 = 20 * 1024 * 1024;
const TOTAL: u64 = 64 * 1024 * 1024;
const OUTPUT: u64 = 50 * 1024 * 1024;
const OUTPUT_RESERVATION: u64 = 2 * OUTPUT;
type RecoveryCounts = std::sync::Mutex<std::collections::HashMap<(String, String), usize>>;
pub(super) type OutputRecoveries = std::sync::Arc<RecoveryCounts>;
pub(super) fn output_recovery_for_root(root: &Path) -> OutputRecoveries {
    use std::{
        collections::HashMap,
        sync::{Arc, Mutex, OnceLock, Weak},
    };
    static ROOTS: OnceLock<Mutex<HashMap<PathBuf, Weak<RecoveryCounts>>>> = OnceLock::new();
    let mut roots = ROOTS.get_or_init(Default::default).lock().unwrap();
    roots.retain(|_, x| x.strong_count() > 0);
    if let Some(counts) = roots.get(root).and_then(Weak::upgrade) {
        return counts;
    }
    let counts = Arc::new(RecoveryCounts::default());
    roots.insert(root.into(), Arc::downgrade(&counts));
    counts
}
struct OriginalOutput {
    path: PathBuf,
    bytes: Vec<u8>,
    media_type: String,
    width: u32,
    height: u32,
}
fn original_output_bytes(path: &Path) -> Result<Vec<u8>> {
    if matches!(fs::symlink_metadata(path), Err(e) if e.kind() == std::io::ErrorKind::NotFound) {
        return Err(crate::error::AppError::Service {
            code: "not_found".into(),
            message: "Original output stage is missing".into(),
        });
    }
    no_links(path)?;
    let mut file = open_regular(path)?;
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(OUTPUT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| reject("original output stage is unreadable"))?;
    if bytes.is_empty() || bytes.len() as u64 > OUTPUT {
        return Err(crate::error::AppError::Service {
            code: "corrupt".into(),
            message: "Original output stage has an invalid length".into(),
        });
    }
    Ok(bytes)
}
pub(crate) struct OutputRecoveryGuard<'a> {
    store: &'a Store,
    key: (String, String),
}
impl Drop for OutputRecoveryGuard<'_> {
    fn drop(&mut self) {
        let mut permits = self
            .store
            .output_recovery
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if let Some(count) = permits.get_mut(&self.key) {
            *count -= 1;
            if *count == 0 {
                permits.remove(&self.key);
            }
        }
    }
}
impl Store {
    pub(super) fn original_writer_active(&self, consumer: &str, op: &str) -> Result<bool> {
        Ok(self
            .output_recovery
            .lock()
            .map_err(|_| reject("output recovery ownership is unavailable"))?
            .contains_key(&(consumer.into(), op.into())))
    }
    /// Settlement releases unused capacity, not the artifact's identity.
    /// Acquire the same stage + seal budget as initial admission before any
    /// writable path or new publication can consume it again.
    fn reserve_output_capacity(
        &self,
        provider: &PackageGeneration,
        consumer: &str,
        op: &str,
        handle: &str,
    ) -> Result<()> {
        #[cfg(test)]
        {
            let pause = self.pause_output_reservation.lock().unwrap().take();
            if let Some((entered, resume)) = pause {
                entered.wait();
                resume.wait();
            }
        }
        let result=self.transaction(|tx| {
            let current = Self::record(tx, consumer, op)?.ok_or_else(|| reject("output admission disappeared"))?;
            let (status, bytes):(String,i64)=tx.query_row("SELECT status,bytes FROM artifacts WHERE handle=?1 AND consumer=?2 AND operation=?3 AND kind='output'",params![handle,consumer,op],|r| Ok((r.get(0)?,r.get(1)?))).map_err(sql)?;
            if !same_owner(&current.provider, provider) || status == "released"
                || current.phase == AdmissionPhase::Released
                || (status != "sealed" && !may_finish_stage(self, tx, &current)?) {
                return Err(reject("output capacity requires an undisposed admitted artifact"));
            }
            let bytes=u64::try_from(bytes).map_err(|_|reject("negative artifact reservation"))?;
            if bytes < OUTPUT_RESERVATION {
                self.quota(tx,consumer,OUTPUT_RESERVATION-bytes,false)?;
                tx.execute("UPDATE artifacts SET bytes=?2 WHERE handle=?1",params![handle,OUTPUT_RESERVATION as i64]).map_err(sql)?;
            }
            Ok(())
        });
        if matches!(&result,Err(crate::error::AppError::Service { code,.. }) if code=="storage_full")
        {
            if let Some(job) = self.job_for_operation(consumer, op)? {
                self.mark_storage_full(&job)?;
            }
        }
        result
    }
    /// Unpaid provider reconciliation may publish its retained original copy
    /// even after Unknown was fenced. This grants stage/seal only; it never
    /// revokes the execution fence or allows a disposed output to reappear.
    pub fn output_recovery_guard(&self, a: &Admission) -> Result<OutputRecoveryGuard<'_>> {
        let key = (a.consumer.package_id.clone(), a.operation_id.clone());
        let mut permits = self
            .output_recovery
            .lock()
            .map_err(|_| reject("output recovery ownership is unavailable"))?;
        *permits.entry(key.clone()).or_default() += 1;
        Ok(OutputRecoveryGuard { store: self, key })
    }
}
fn may_finish_stage(
    store: &Store,
    connection: &rusqlite::Connection,
    admission: &Admission,
) -> Result<bool> {
    if matches!(
        admission.phase,
        AdmissionPhase::Forwarding | AdmissionPhase::Accepted | AdmissionPhase::Terminal
    ) && admission.output.is_none()
        && Store::provider_receipt_at(connection, admission)?.is_none_or(|r| {
            !matches!(
                r["execution"]["state"].as_str(),
                Some("failed" | "cancelled")
            )
        })
        && store
            .output_recovery
            .lock()
            .map_err(|_| reject("output recovery ownership is unavailable"))?
            .contains_key(&(
                admission.consumer.package_id.clone(),
                admission.operation_id.clone(),
            ))
    {
        return Ok(true);
    }
    let settled: bool = connection
        .query_row(
            "SELECT exec_released FROM operations WHERE consumer=?1 AND operation=?2",
            params![admission.consumer.package_id, admission.operation_id],
            |r| r.get(0),
        )
        .map_err(sql)?;
    if settled {
        return Ok(false);
    }
    if matches!(
        admission.phase,
        AdmissionPhase::Forwarding | AdmissionPhase::Accepted
    ) {
        return Ok(true);
    }
    if admission.phase != AdmissionPhase::Terminal || admission.output.is_some() {
        return Ok(false);
    }
    let status: Option<String> = connection
        .query_row(
            "SELECT status FROM provider_receipts WHERE consumer=?1 AND operation=?2",
            params![admission.consumer.package_id, admission.operation_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(sql)?;
    let Some(status) = status else {
        return Ok(false);
    };
    let value: serde_json::Value = decode(&status)?;
    let status = super::receipt::validate(&value, admission)?;
    Ok(status["execution"]["state"] == "succeeded" && status["delivery"]["state"] == "unavailable")
}
pub(super) fn opaque_id() -> Result<String> {
    let mut bytes = [0u8; 24];
    getrandom::fill(&mut bytes)
        .map_err(|_| reject("could not allocate opaque artifact identity"))?;
    Ok(hex::encode(bytes))
}
pub(super) fn regular_or_missing(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(m) if !m.is_file() || m.file_type().is_symlink() => Err(reject(
            "private state must contain regular files without links",
        )),
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(reject("private state is unreadable")),
    }
}
pub(super) fn private_directory(path: &Path) -> Result<()> {
    let m = fs::symlink_metadata(path).map_err(|_| reject("private directory is unreadable"))?;
    if !m.is_dir() || m.file_type().is_symlink() {
        return Err(reject(
            "private directories cannot be links or special files",
        ));
    }
    Ok(())
}
pub(super) fn canonical_regular_directory(path: &Path) -> Result<PathBuf> {
    if !path.is_absolute() {
        return Err(reject("consumer storage must be absolute"));
    }
    let path = dunce::canonicalize(path).map_err(|_| reject("consumer storage is unreadable"))?;
    private_directory(&path)?;
    Ok(path)
}
fn no_links(path: &Path) -> Result<()> {
    for parent in path.ancestors() {
        let m = fs::symlink_metadata(parent).map_err(|_| reject("artifact path is unreadable"))?;
        if m.file_type().is_symlink() {
            return Err(reject("artifact path cannot traverse links"));
        }
    }
    Ok(())
}
#[cfg(unix)]
fn open_regular_with_parent(path: &Path) -> Result<(File, Vec<(PathBuf, File)>)> {
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;
    if !path.is_absolute() {
        return Err(reject("artifact path must be absolute"));
    }
    let mut parents = vec![(
        PathBuf::from("/"),
        File::open("/").map_err(|_| reject("artifact root unavailable"))?,
    )];
    let components: Vec<_> = path
        .components()
        .filter_map(|c| match c {
            std::path::Component::RootDir => None,
            std::path::Component::Normal(n) => Some(Ok(n)),
            _ => Some(Err(reject("artifact path cannot contain traversal"))),
        })
        .collect::<Result<_>>()?;
    if components.is_empty() {
        return Err(reject("artifact path must name a file"));
    }
    for (index, component) in components.iter().enumerate() {
        let name = std::ffi::CString::new(component.as_bytes())
            .map_err(|_| reject("invalid artifact path"))?;
        let final_component = index + 1 == components.len();
        let flags = libc::O_RDONLY
            | libc::O_CLOEXEC
            | libc::O_NOFOLLOW
            | libc::O_NONBLOCK
            | libc::O_NOCTTY
            | if final_component {
                0
            } else {
                libc::O_DIRECTORY
            };
        // Every component is resolved relative to an already-open directory;
        // ancestor substitution cannot redirect this open through a symlink.
        if parents.len() > 128 {
            return Err(reject("artifact directory depth exceeds its bound"));
        }
        let fd =
            unsafe { libc::openat(parents.last().unwrap().1.as_raw_fd(), name.as_ptr(), flags) };
        if fd < 0 {
            return Err(reject("artifact could not be opened safely"));
        }
        let file = unsafe { File::from_raw_fd(fd) };
        if final_component {
            if !file
                .metadata()
                .map_err(|_| reject("artifact metadata unavailable"))?
                .is_file()
            {
                return Err(reject("artifact must be a regular file"));
            }
            return Ok((file, parents));
        }
        let path = parents.last().unwrap().0.join(component);
        parents.push((path, file));
    }
    Err(reject("artifact path must name a file"))
}
fn open_regular(path: &Path) -> Result<File> {
    #[cfg(unix)]
    return open_regular_with_parent(path).map(|(file, _)| file);
    #[cfg(not(unix))]
    {
        let mut o = OpenOptions::new();
        o.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            o.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_NOCTTY);
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            o.custom_flags(0x0020_0000);
        }
        let file = o
            .open(path)
            .map_err(|_| reject("artifact could not be opened safely"))?;
        let m = file
            .metadata()
            .map_err(|_| reject("artifact metadata unavailable"))?;
        if !m.is_file() || m.file_type().is_symlink() {
            return Err(reject("artifact must be a regular file"));
        }
        Ok(file)
    }
}
fn bounded(file: &mut File, limit: u64) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    file.take(limit.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|_| reject("artifact read failed"))?;
    if bytes.is_empty() || bytes.len() as u64 > limit {
        return Err(reject("artifact exceeds its byte limit or is empty"));
    }
    Ok(bytes)
}
pub(super) fn image(bytes: &[u8], output: bool) -> Result<(String, u32, u32)> {
    let format = image::guess_format(bytes).map_err(|_| reject("unrecognized image format"))?;
    let media = match format {
        image::ImageFormat::Png => "image/png",
        image::ImageFormat::Jpeg if !output => "image/jpeg",
        image::ImageFormat::WebP if !output => "image/webp",
        _ => return Err(reject("use PNG/JPEG/WebP inputs and PNG output")),
    };
    let (w, h) = image::ImageReader::with_format(Cursor::new(bytes), format)
        .into_dimensions()
        .map_err(|_| reject("invalid image header"))?;
    if w == 0 || h == 0 || u64::from(w) * u64::from(h) > 16_777_216 {
        return Err(reject("image exceeds 16 megapixel limit"));
    }
    let mut reader = image::ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    reader
        .decode()
        .map_err(|_| reject("image data is malformed or truncated"))?;
    Ok((media.into(), w, h))
}
// Directory-entry durability: see crate::durable_dir for the per-platform
// barrier. An unsupported flush fails the operation instead of claiming it.
/// Flushes a file verified through a read-only handle. Unix fsyncs that same
/// handle; Windows only flushes through a writable one.
fn sync_verified(file: &File, path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        let _ = path;
        file.sync_all()
    }
    #[cfg(not(unix))]
    {
        let _ = file;
        crate::durable_dir::sync_file(path)
    }
}
fn sync_directory(path: &Path) -> Result<()> {
    crate::durable_dir::sync(path).map_err(|_| reject("artifact directory sync failed"))
}
/// One artifact's exclusive IO lease. Released explicitly: closing alone
/// leaves the flock held while any concurrently spawned child (between fork
/// and exec) still has a duplicate descriptor, which made a following seal,
/// read or collection fail with "artifact IO is already owned".
/// A forked child's copy never unlocks the still-live parent's lease.
pub(crate) struct ArtifactLease<'a> {
    file: File,
    pid: u32,
    collection: Option<(&'a Store, String)>,
}
impl Drop for ArtifactLease<'_> {
    fn drop(&mut self) {
        if std::process::id() == self.pid {
            let _ = self.file.unlock();
            if let Some((store, handle)) = &self.collection {
                if let Err(error) = store.collect_artifact(handle) {
                    log::warn!("artifact lease cleanup deferred to the next sweep: {error}");
                }
            }
        }
    }
}
impl Store {
    /// Custody is evidence independently of provider receipt publication. A
    /// sealed descriptor, or original bytes awaiting sealing, keeps unpaid
    /// status recovery alive even after an older dismissal marker.
    pub(super) fn retained_output_at(
        &self,
        conn: &rusqlite::Connection,
        consumer: &str,
        op: &str,
    ) -> Result<bool> {
        if self.has_bound_host_output_at(conn, consumer, op)? {
            return Ok(true);
        }
        let artifact: Option<(String, String)> = conn.query_row(
            "SELECT a.handle,a.status FROM artifacts a JOIN operations o ON o.consumer=a.consumer AND o.operation=a.operation WHERE a.consumer=?1 AND a.operation=?2 AND a.kind='output' AND a.status!='released' AND o.phase!='released'",
            params![consumer, op], |r| Ok((r.get(0)?, r.get(1)?))).optional().map_err(sql)?;
        let Some((handle, status)) = artifact else {
            return Ok(false);
        };
        let descriptor: Option<ArtifactDescriptor> = if status == "sealed" {
            let raw: String = conn
                .query_row(
                    "SELECT descriptor FROM artifacts WHERE handle=?1",
                    [&handle],
                    |r| r.get(0),
                )
                .map_err(sql)?;
            Some(decode(&raw)?)
        } else {
            None
        };
        for path in [
            self.bytes_path(&handle)?,
            self.pending_path(&handle)?,
            self.stage_path(&handle)?,
        ] {
            let bytes = match original_output_bytes(&path) {
                Ok(bytes) => bytes,
                Err(crate::error::AppError::Service { code, .. })
                    if matches!(code.as_str(), "not_found" | "corrupt") =>
                {
                    continue
                }
                Err(cause) => return Err(cause),
            };
            if image(&bytes, true).is_ok()
                && descriptor.as_ref().is_none_or(|d| {
                    d.byte_length == bytes.len() as u64
                        && d.sha256 == hex::encode(Sha256::digest(&bytes))
                })
            {
                return Ok(true);
            }
        }
        Ok(false)
    }
    pub fn has_retained_output(&self, consumer: &str, op: &str) -> Result<bool> {
        self.retained_output_at(&self.connect()?, consumer, op)
    }
    fn artifact_disk_bytes(&self, handle: &str) -> Result<u64> {
        let mut bytes = 0u64;
        for path in [
            self.stage_path(handle)?,
            self.bytes_path(handle)?,
            self.pending_path(handle)?,
        ] {
            regular_or_missing(&path)?;
            match fs::symlink_metadata(&path) {
                Ok(metadata) => {
                    bytes = bytes
                        .checked_add(metadata.len())
                        .filter(|n| *n <= i64::MAX as u64)
                        .ok_or_else(|| reject("artifact bytes exceed accounting bound"))?
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
                Err(_) => return Err(reject("artifact bytes are unreadable")),
            }
        }
        Ok(bytes)
    }
    /// Keep artifact identity separate from unused capacity. Hold the artifact
    /// lease through settlement, reserving only retained original bytes. Work
    /// cannot start sealing between this proof and releasing unused capacity.
    pub(super) fn idle_output_reservation(
        &self,
        consumer: &str,
        op: &str,
    ) -> Result<Option<(String, u64, ArtifactLease<'_>)>> {
        let handle: Option<String> = self
            .connect()?
            .query_row(
                "SELECT handle FROM artifacts WHERE consumer=?1 AND operation=?2 AND kind='output'",
                params![consumer, op],
                |r| r.get(0),
            )
            .optional()
            .map_err(sql)?;
        let Some(handle) = handle else {
            return Ok(None);
        };
        let lease = self.lease(&handle)?;
        // Missing paths are only evidence of absence after directory removals
        // are durable. This also closes crash/reopen before a GC retry.
        self.sync_artifact_directory(&self.root.join("bytes"))?;
        self.sync_artifact_directory(&self.root.join("stages"))?;
        let bytes = self.artifact_disk_bytes(&handle)?;
        Ok(Some((handle, bytes, lease)))
    }
    /// Retry only the operation's original artifact. Missing/corrupt bytes
    /// defer delivery, never authorize automatic discard. This never creates
    /// a new provider request or stage.
    pub fn recover_original_output(
        &self,
        provider: &PackageGeneration,
        consumer: &str,
        op: &str,
    ) -> Result<Option<ArtifactDescriptor>> {
        let a = self.verify_provider(provider, consumer, op)?;
        if !self.provider_receipt(consumer, op)?.is_some_and(|r| {
            r["execution"]["state"] == "succeeded" && r["delivery"]["state"] == "unavailable"
        }) {
            return Err(reject(
                "original output recovery requires proven success with unavailable delivery",
            ));
        }
        let _recovery = self.output_recovery_guard(&a)?;
        let handle: String = self
            .connect()?
            .query_row(
                "SELECT handle FROM artifacts WHERE consumer=?1 AND operation=?2 AND kind='output'",
                params![consumer, op],
                |r| r.get(0),
            )
            .map_err(sql)?;
        match self.seal(provider, consumer, op, &handle, "image/png") {
            Ok(output) => {
                self.terminal(
                    provider,
                    consumer,
                    op,
                    Some(output.clone()),
                    a.needs_attention,
                )?;
                Ok(Some(output))
            }
            Err(crate::error::AppError::Service { code, .. })
                if matches!(code.as_str(), "not_found" | "corrupt") =>
            {
                // Both workers are idle at this recovery boundary. Retain the
                // success and original identity, but release execution/input
                // capacity and reserve only remaining physical copies.
                let reservation = self.idle_output_reservation(consumer, op)?;
                self.transaction(|tx| {
                    let current = Self::record(tx, consumer, op)?.ok_or_else(|| reject("admission disappeared"))?;
                    if current.phase != AdmissionPhase::Released && Self::provider_receipt_at(tx, &current)?.is_some_and(|r| r["execution"]["state"] == "succeeded" && r["delivery"]["state"] == "unavailable") {
                        tx.execute("UPDATE operations SET exec_released=1 WHERE consumer=?1 AND operation=?2", params![consumer,op]).map_err(sql)?;
                        tx.execute("UPDATE artifacts SET status='released' WHERE consumer=?1 AND operation=?2 AND kind='input'", params![consumer,op]).map_err(sql)?;
                        if let Some((handle, bytes, _)) = &reservation { tx.execute("UPDATE artifacts SET bytes=?2 WHERE handle=?1", params![handle,*bytes as i64]).map_err(sql)?; }
                    }
                    Ok(())
                })?;
                drop(reservation);
                self.gc()?;
                Ok(None)
            }
            Err(cause) => Err(cause),
        }
    }
    fn bytes_path(&self, handle: &str) -> Result<PathBuf> {
        if !identity(handle) {
            return Err(reject("invalid artifact handle"));
        }
        let parent = self.root.join("bytes");
        private_directory(&parent)?;
        Ok(parent.join(format!("{handle}.bin")))
    }
    fn stage_path(&self, handle: &str) -> Result<PathBuf> {
        if !identity(handle) {
            return Err(reject("invalid stage handle"));
        }
        let parent = self.root.join("stages");
        private_directory(&parent)?;
        Ok(parent.join(format!("{handle}.png")))
    }
    pub(super) fn lease(&self, handle: &str) -> Result<ArtifactLease<'_>> {
        self.artifact_lease(handle, true)
    }
    fn artifact_lease(&self, handle: &str, collect_on_drop: bool) -> Result<ArtifactLease<'_>> {
        if handle.len() != 48
            || !handle
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        {
            return Err(reject("invalid opaque artifact handle"));
        }
        let dir = self.root.join("leases");
        private_directory(&dir)?;
        let path = dir.join(format!("{handle}.lock"));
        regular_or_missing(&path)?;
        let mut o = OpenOptions::new();
        o.create(true).truncate(false).read(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            o.mode(0o600)
                .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_NOCTTY);
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            o.custom_flags(0x0020_0000);
        }
        let file = o
            .open(path)
            .map_err(|_| reject("artifact lease unavailable"))?;
        if !file
            .metadata()
            .map_err(|_| reject("artifact lease unavailable"))?
            .is_file()
        {
            return Err(reject("artifact lease must be regular"));
        }
        file.try_lock()
            .map_err(|_| reject("artifact IO is already owned"))?;
        Ok(ArtifactLease {
            file,
            pid: std::process::id(),
            collection: collect_on_drop.then(|| (self, handle.to_owned())),
        })
    }
    fn pending_path(&self, handle: &str) -> Result<PathBuf> {
        Ok(self.bytes_path(handle)?.with_extension("pending"))
    }
    fn write_sealed(&self, handle: &str, bytes: &[u8]) -> Result<()> {
        let target = self.bytes_path(handle)?;
        let pending = self.pending_path(handle)?;
        regular_or_missing(&target)?;
        regular_or_missing(&pending)?;
        if target.exists() {
            let mut file = open_regular(&target)?;
            let prior = bounded(&mut file, bytes.len() as u64)?;
            if prior != bytes {
                return Err(reject("immutable artifact conflicts with a previous seal"));
            }
            sync_verified(&file, &target).map_err(|_| reject("immutable artifact sync failed"))?;
        } else {
            // Deterministic private temporary names remain tied to their
            // durable reservation through crashes and are collectable only
            // after release. The caller retains this artifact's IO lease.
            let mut options = OpenOptions::new();
            options.write(true).create(true).truncate(false);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options
                    .mode(0o600)
                    .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_NOCTTY);
            }
            #[cfg(test)]
            self.test_fs.before_mutation(&pending);
            let mut temp = options
                .open(&pending)
                .map_err(|_| reject("artifact temporary file unavailable"))?;
            if !temp
                .metadata()
                .map_err(|_| reject("artifact temporary metadata unavailable"))?
                .is_file()
            {
                return Err(reject("artifact temporary file must be regular"));
            }
            self.checkpoint("seal-pending-created")?;
            temp.set_len(0)
                .map_err(|_| reject("artifact truncate failed"))?;
            self.checkpoint("seal-pending-truncated")?;
            #[cfg(test)]
            {
                temp.write_all(&bytes[..bytes.len() / 2])?;
                self.checkpoint("seal-pending-partial")?;
                temp.write_all(&bytes[bytes.len() / 2..])?;
            }
            #[cfg(not(test))]
            temp.write_all(bytes)?;
            self.checkpoint("seal-pending-full")?;
            temp.sync_all()
                .map_err(|_| reject("artifact write/sync failed"))?;
            #[cfg(test)]
            self.test_fs.file_synced(&pending);
            self.checkpoint("seal-file-sync")?;
            // Hard-link publication refuses an existing destination and
            // consumes no second allocation of the sealed bytes.
            #[cfg(test)]
            self.test_fs.before_mutation(&target);
            fs::hard_link(&pending, &target)
                .map_err(|_| reject("immutable artifact publication failed"))?;
            #[cfg(test)]
            self.test_fs.file_synced(&target);
            self.checkpoint("seal-published")?;
        }
        self.sync_artifact_directory(target.parent().unwrap())?;
        self.checkpoint("seal-directory-sync")?;
        match self.unlink_artifact_file(&pending) {
            Ok(()) => {
                self.checkpoint("seal-pending-unlinked")?;
                self.sync_artifact_directory(target.parent().unwrap())?;
                self.checkpoint("seal-cleanup-sync")?;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(reject("artifact temporary cleanup failed")),
        }
        Ok(())
    }
    fn verify_bytes(&self, d: &ArtifactDescriptor) -> Result<PathBuf> {
        descriptor(d)?;
        let path = self.bytes_path(&d.handle)?;
        // Typed codes let a provider report missing versus corrupt delivery.
        if matches!(fs::symlink_metadata(&path), Err(e) if e.kind() == std::io::ErrorKind::NotFound)
        {
            return Err(crate::error::AppError::Service {
                code: "not_found".into(),
                message: "Sealed artifact is missing".into(),
            });
        }
        no_links(&path)?;
        let mut file = open_regular(&path)?;
        let mut bytes = Vec::new();
        Read::by_ref(&mut file)
            .take(d.byte_length.saturating_add(1))
            .read_to_end(&mut bytes)
            .map_err(|_| reject("artifact read failed"))?;
        if bytes.len() as u64 != d.byte_length || hex::encode(Sha256::digest(&bytes)) != d.sha256 {
            return Err(crate::error::AppError::Service {
                code: "corrupt".into(),
                message: "Sealed artifact bytes do not match their descriptor".into(),
            });
        }
        Ok(path)
    }
    /// A seal metadata commit can precede stage/pending cleanup. Rebuild only
    /// the exact pinned descriptor, retaining the original copy through every
    /// failed repair. The caller holds this artifact's exclusive IO lease.
    fn restore_original_seal(
        &self,
        admission: &Admission,
        d: &ArtifactDescriptor,
        loss: crate::error::AppError,
    ) -> Result<()> {
        let pending = self.pending_path(&d.handle)?;
        let restore = |path: &Path| -> Result<bool> {
            let bytes = match original_output_bytes(path) {
                Ok(bytes) => bytes,
                Err(crate::error::AppError::Service { code, .. })
                    if matches!(code.as_str(), "not_found" | "corrupt") =>
                {
                    return Ok(false)
                }
                Err(cause) => return Err(cause),
            };
            if bytes.len() as u64 != d.byte_length
                || hex::encode(Sha256::digest(&bytes)) != d.sha256
            {
                return Ok(false);
            }
            self.reserve_output_capacity(
                &admission.provider,
                &admission.consumer.package_id,
                &admission.operation_id,
                &d.handle,
            )?;
            self.publish_original_copy(&d.handle, path, &bytes)?;
            self.verify_bytes(d)?;
            Ok(true)
        };
        for path in [self.stage_path(&d.handle)?, pending] {
            if restore(&path)? {
                return Ok(());
            }
        }
        // Acquisition may commit before provider acknowledgement. Validate its
        // pinned copy only if host copies could not restore the original seal.
        let evidence: Option<(String, String, String)> = self.connect()?.query_row(
            "SELECT e.descriptor,e.path,r.path FROM evidence e JOIN roots r ON r.package=e.consumer WHERE e.consumer=?1 AND e.operation=?2",
            params![admission.consumer.package_id, admission.operation_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        ).optional().map_err(sql)?;
        if let Some((descriptor, path, root)) = evidence {
            let path = PathBuf::from(path);
            if decode::<ArtifactDescriptor>(&descriptor)? != *d
                || !path.is_absolute()
                || !path.starts_with(Path::new(&root))
                || path.starts_with(&self.root)
            {
                return Err(reject(
                    "consumer recovery evidence conflicts with its original output",
                ));
            }
            // The read rejects links in every path component and is bounded;
            // SHA and length are checked on every retry, without altering custody.
            if restore(&path)? {
                return Ok(());
            }
        }
        Err(loss)
    }
    /// Before descriptor commitment, a valid immutable publication wins over
    /// pending and stage copies that may have changed later. Check every
    /// original before declaring loss; transient IO never authorizes discard.
    fn original_output(&self, handle: &str) -> Result<OriginalOutput> {
        let mut loss = crate::error::AppError::Service {
            code: "not_found".into(),
            message: "Original output copies are missing".into(),
        };
        for path in [
            self.bytes_path(handle)?,
            self.pending_path(handle)?,
            self.stage_path(handle)?,
        ] {
            let bytes = match original_output_bytes(&path) {
                Ok(bytes) => bytes,
                Err(cause) => {
                    if matches!(&cause, crate::error::AppError::Service { code, .. } if matches!(code.as_str(), "not_found" | "corrupt"))
                    {
                        loss = cause;
                        continue;
                    }
                    return Err(cause);
                }
            };
            if let Ok((media_type, width, height)) = image(&bytes, true) {
                return Ok(OriginalOutput {
                    path,
                    bytes,
                    media_type,
                    width,
                    height,
                });
            }
            loss = crate::error::AppError::Service {
                code: "corrupt".into(),
                message: "Original output copy is not a valid PNG".into(),
            };
        }
        Err(loss)
    }
    /// Caller owns the artifact lease and has validated this original copy.
    /// Preserve the source until publication and directory sync succeed.
    fn sync_original_copy(&self, path: &Path) -> Result<()> {
        let file = open_regular(path)?;
        #[cfg(test)]
        if self
            .fail_next_original_sync
            .swap(false, std::sync::atomic::Ordering::Relaxed)
        {
            return Err(reject("original output candidate sync failed"));
        }
        sync_verified(&file, path).map_err(|_| reject("original output candidate sync failed"))
    }
    fn publish_original_copy(&self, handle: &str, source: &Path, bytes: &[u8]) -> Result<()> {
        let target = self.bytes_path(handle)?;
        let pending = self.pending_path(handle)?;
        if source == pending {
            // A prior write may have succeeded while its data flush failed.
            // Retry that flush before changing either publication path.
            self.sync_original_copy(&pending)?;
        }
        if source != target {
            regular_or_missing(&target)?;
            match fs::remove_file(&target) {
                Ok(()) => sync_directory(target.parent().unwrap())?,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
                Err(_) => return Err(reject("original sealed output repair is unavailable")),
            }
        }
        if source == pending {
            // Never truncate the sole surviving pending publication candidate.
            fs::hard_link(&pending, &target)
                .map_err(|_| reject("original sealed output publication failed"))?;
            sync_directory(target.parent().unwrap())?;
            fs::remove_file(&pending)
                .map_err(|_| reject("original sealed output cleanup failed"))?;
            sync_directory(target.parent().unwrap())
        } else {
            self.write_sealed(handle, bytes)
        }
    }
    pub fn capture(
        &self,
        caller: &PackageGeneration,
        op: &str,
        inputs: Vec<CaptureInput>,
    ) -> Result<Vec<CapturedArtifact>> {
        generation(caller)?;
        if !identity(op) || inputs.is_empty() || inputs.len() > 8 {
            return Err(reject("capture requires 1–8 inputs and a valid operation"));
        }
        let spec = encode(&inputs)?;
        let cached = self.transaction(|tx| {
            Self::generation_admitted(tx,caller)?;
            let old: Option<(String, String, Option<String>, Option<String>)> = tx
                .query_row("SELECT owner,phase,capture_spec,captures FROM operations WHERE consumer=?1 AND operation=?2", params![caller.package_id, op], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
                })
                .optional()
                .map_err(sql)?;
            if let Some((owner, phase, old_spec, ready)) = old {
                if !same_owner(&decode::<PackageGeneration>(&owner)?, caller) || phase == "released" || old_spec.as_deref() != Some(&spec) {
                    return Err(reject("capture operation conflicts with its original snapshot"));
                }
                return ready.map(|raw| decode::<Vec<CapturedArtifact>>(&raw)).transpose();
            }
            Ok(None)
        })?;
        if let Some(cached) = cached {
            for input in &cached {
                self.verify_bytes(&input.artifact)?;
            }
            return Ok(cached);
        }
        self.restart_retained_capture(caller, op, &spec)?;
        // Open once and reserve the observed lengths before reading any image bytes.
        let mut files = Vec::new();
        let mut total = 0u64;
        for input in &inputs {
            if input.path.len() > 8192
                || input.path.contains('\0')
                || input.expected_digest.as_ref().is_some_and(|d| !digest(d))
            {
                return Err(reject("invalid capture path or expected digest"));
            }
            let physical = dunce::canonicalize(&input.path)
                .map_err(|_| reject("input image is unavailable"))?;
            let file = open_regular(&physical)?;
            let size = file
                .metadata()
                .map_err(|_| reject("input metadata unavailable"))?
                .len();
            if size == 0 || size > INPUT {
                return Err(reject("input image exceeds 20 MiB limit or is empty"));
            }
            total = total
                .checked_add(size)
                .ok_or_else(|| reject("input total overflow"))?;
            if total > TOTAL {
                return Err(reject("input images exceed 64 MiB total"));
            }
            files.push((physical, file, size, opaque_id()?));
        }
        let handles: Vec<_> = files.iter().map(|(_, _, _, h)| h.clone()).collect();
        let leases: Vec<_> = handles
            .iter()
            .map(|h| self.lease(h))
            .collect::<Result<_>>()?;
        self.transaction(|tx| {
            Self::generation_admitted(tx,caller)?;
            let existing: bool = tx
                .query_row("SELECT EXISTS(SELECT 1 FROM operations WHERE consumer=?1 AND operation=?2)", params![caller.package_id, op], |r| r.get(0))
                .map_err(sql)?;
            if existing {
                return Err(reject("capture is already in progress"));
            }
            self.quota(tx, &caller.package_id, total, true)?;
            tx.execute("INSERT INTO operations(consumer,operation,owner,capture_spec,created_at_ms)VALUES(?1,?2,?3,?4,CAST(strftime('%s','now') AS INTEGER)*1000)", params![caller.package_id, op, encode(caller)?, spec])
                .map_err(sql)?;
            for (_, _, size, h) in &files {
                tx.execute(
                    "INSERT INTO artifacts(handle,consumer,operation,kind,status,bytes)VALUES(?1,?2,?3,'input','capturing',?4)",
                    params![h, caller.package_id, op, *size as i64],
                )
                .map_err(sql)?;
            }
            Ok(())
        })?;
        let result = (|| {
            let mut captured = Vec::new();
            for ((physical, mut file, size, handle), input) in files.into_iter().zip(inputs) {
                let bytes = bounded(&mut file, size)?;
                let sha = hex::encode(Sha256::digest(&bytes));
                if input
                    .expected_digest
                    .as_ref()
                    .is_some_and(|expected| expected != &sha)
                {
                    return Err(reject("input changed from its expected digest"));
                }
                let (media, w, h) = image(&bytes, false)?;
                self.write_sealed(&handle, &bytes)?;
                let d = ArtifactDescriptor {
                    handle,
                    sha256: sha,
                    byte_length: bytes.len() as u64,
                    media_type: media,
                };
                captured.push(CapturedArtifact {
                    source_path: physical.to_string_lossy().into(),
                    artifact: d,
                    width: w,
                    height: h,
                });
            }
            self.transaction(|tx| {
                let phase: String = tx.query_row("SELECT phase FROM operations WHERE consumer=?1 AND operation=?2", params![caller.package_id, op], |r| r.get(0)).map_err(sql)?;
                if phase != "reserved" {
                    return Err(reject("capture was released before completion"));
                }
                for input in &captured {
                    tx.execute(
                        "UPDATE artifacts SET status='sealed',descriptor=?2,source=?3,width=?4,height=?5,bytes=?6 WHERE handle=?1",
                        params![input.artifact.handle, encode(&input.artifact)?, input.source_path, input.width, input.height, input.artifact.byte_length as i64],
                    )
                    .map_err(sql)?;
                }
                tx.execute("UPDATE operations SET captures=?3 WHERE consumer=?1 AND operation=?2", params![caller.package_id, op, encode(&captured)?])
                    .map_err(sql)?;
                Ok(())
            })?;
            Ok(captured)
        })();
        drop(leases);
        if result.is_err() {
            let _ = self.release_unaccepted(caller, op);
        }
        result
    }
    /// A crash before the capture receipt left no immutable input snapshot.
    /// Compatible recovery may retry the original spec only once its old IO
    /// owners have gone; completed snapshots never enter this path.
    fn restart_retained_capture(
        &self,
        caller: &PackageGeneration,
        op: &str,
        spec: &str,
    ) -> Result<()> {
        let conn = self.connect()?;
        if !self.preparation_retained_in(&conn, &caller.package_id, op)? {
            return Ok(());
        }
        let incomplete: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM operations WHERE consumer=?1 AND operation=?2 AND admission IS NULL AND phase='reserved' AND captures IS NULL AND capture_spec=?3 AND owner=?4)",params![caller.package_id,op,spec,encode(caller)?],|r|r.get(0)).map_err(sql)?;
        if !incomplete {
            return Ok(());
        }
        let mut query = conn
            .prepare(
                "SELECT handle FROM artifacts WHERE consumer=?1 AND operation=?2 AND kind='input'",
            )
            .map_err(sql)?;
        let handles = query
            .query_map(params![caller.package_id, op], |r| r.get::<_, String>(0))
            .map_err(sql)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(sql)?;
        drop(query);
        drop(conn);
        let leases = handles
            .iter()
            .map(|handle| self.lease(handle))
            .collect::<Result<Vec<_>>>()?;
        let restarted = self.transaction(|tx| {
            Self::generation_admitted(tx, caller)?;
            if !self.preparation_retained_in(tx, &caller.package_id, op)? { return Ok(false); }
            let changed = tx.execute("DELETE FROM operations WHERE consumer=?1 AND operation=?2 AND admission IS NULL AND phase='reserved' AND captures IS NULL AND capture_spec=?3 AND owner=?4",params![caller.package_id,op,spec,encode(caller)?]).map_err(sql)? > 0;
            if changed { tx.execute("UPDATE artifacts SET status='released' WHERE consumer=?1 AND operation=?2 AND kind='input'",params![caller.package_id,op]).map_err(sql)?; }
            Ok(changed)
        })?;
        self.checkpoint("recapture-retired")?;
        drop(leases);
        if restarted {
            self.collect_released(&caller.package_id, op)?;
        }
        Ok(())
    }
    pub fn stage(
        &self,
        provider: &PackageGeneration,
        consumer: &str,
        op: &str,
    ) -> Result<OutputStage> {
        let a = self.verify_provider(provider, consumer, op)?;
        if !may_finish_stage(self, &self.connect()?, &a)? {
            return Err(reject("output staging requires a forwarded admission"));
        }
        let handle: String = self
            .connect()?
            .query_row(
                "SELECT handle FROM artifacts WHERE consumer=?1 AND operation=?2 AND kind='output'",
                params![consumer, op],
                |r| r.get(0),
            )
            .map_err(sql)?;
        let _lease = self.lease(&handle)?;
        self.reserve_output_capacity(provider, consumer, op, &handle)?;
        let path = self.stage_path(&handle)?;
        regular_or_missing(&path)?;
        if !path.exists() {
            let mut o = OpenOptions::new();
            o.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                o.mode(0o600).custom_flags(libc::O_NOFOLLOW);
            }
            #[cfg(test)]
            self.test_fs.before_mutation(&path);
            let file = o
                .open(&path)
                .map_err(|_| reject("output stage creation failed"))?;
            self.checkpoint("stage-created")?;
            file.sync_all()
                .map_err(|_| reject("output stage sync failed"))?;
            #[cfg(test)]
            self.test_fs.file_synced(&path);
            self.checkpoint("stage-file-sync")?;
            self.sync_artifact_directory(path.parent().unwrap())?;
            self.checkpoint("stage-directory-sync")?;
        }
        self.transaction(|tx| {
            let current = Self::record(tx, consumer, op)?
                .ok_or_else(|| reject("stage admission disappeared"))?;
            if !may_finish_stage(self, tx, &current)? {
                return Err(reject("output staging disposition changed"));
            }
            tx.execute(
                "UPDATE artifacts SET status='staged' WHERE handle=?1 AND status='reserved'",
                [&handle],
            )
            .map_err(sql)?;
            Ok(())
        })?;
        self.checkpoint("stage-ledger")?;
        Ok(OutputStage {
            handle,
            path: path.to_string_lossy().into(),
        })
    }
    pub fn seal(
        &self,
        provider: &PackageGeneration,
        consumer: &str,
        op: &str,
        handle: &str,
        media: &str,
    ) -> Result<ArtifactDescriptor> {
        if media != "image/png" {
            return Err(reject("output must be PNG"));
        }
        let a = self.verify_provider(provider, consumer, op)?;
        if !matches!(
            a.phase,
            AdmissionPhase::Forwarding | AdmissionPhase::Accepted | AdmissionPhase::Terminal
        ) {
            return Err(reject(
                "output sealing requires an undisposed forwarded admission",
            ));
        }
        let record: (String, Option<String>) = self
            .connect()?
            .query_row(
                "SELECT status,descriptor FROM artifacts WHERE handle=?1 AND consumer=?2 AND operation=?3 AND kind='output'",
                params![handle, consumer, op],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(sql)?;
        let _lease = self.lease(handle)?;
        if record.0 == "sealed" {
            let d: ArtifactDescriptor = decode(
                &record
                    .1
                    .ok_or_else(|| reject("sealed metadata is missing"))?,
            )?;
            if d.handle != handle || a.output.as_ref().is_some_and(|output| output != &d) {
                return Err(reject(
                    "sealed output conflicts with its original stage handle",
                ));
            }
            self.exact_artifact(&self.connect()?, consumer, op, &d, "output")?;
            if let Err(cause) = self.verify_bytes(&d) {
                if matches!(&cause, crate::error::AppError::Service { code, .. } if matches!(code.as_str(), "not_found" | "corrupt"))
                {
                    self.restore_original_seal(&a, &d, cause)?;
                } else {
                    return Err(cause);
                }
            }
            self.finalize_stage(handle, &d)?;
            let current = self.verify_provider(provider, consumer, op)?;
            if current.phase == AdmissionPhase::Released {
                return Err(reject("sealed output was disposed during local recovery"));
            }
            return Ok(d);
        }
        if !may_finish_stage(self, &self.connect()?, &a)? {
            return Err(reject(
                "staged output recovery requires durable proven success with unavailable delivery",
            ));
        }
        let original = self.original_output(handle)?;
        self.reserve_output_capacity(provider, consumer, op, handle)?;
        if original.media_type != media {
            return Err(reject("output format does not match media type"));
        }
        let d = ArtifactDescriptor {
            handle: handle.into(),
            sha256: hex::encode(Sha256::digest(&original.bytes)),
            byte_length: original.bytes.len() as u64,
            media_type: original.media_type,
        };
        self.publish_original_copy(handle, &original.path, &original.bytes)?;
        self.transaction(|tx| {
            let current = Self::record(tx, consumer, op)?.ok_or_else(|| reject("admission disappeared"))?;
            if !may_finish_stage(self,tx,&current)? {
                return Err(reject("admission ended during output sealing"));
            }
            tx.execute("UPDATE artifacts SET status='sealed',descriptor=?2,width=?3,height=?4 WHERE handle=?1", params![handle, encode(&d)?, original.width, original.height])
                .map_err(sql)?;
            Ok(())
        })?;
        self.checkpoint("seal-ledger")?;
        self.finalize_stage(handle, &d)?;
        Ok(d)
    }
    fn finalize_stage(&self, handle: &str, d: &ArtifactDescriptor) -> Result<()> {
        let path = self.stage_path(handle)?;
        match self.unlink_artifact_file(&path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => {
                return Err(reject(
                    "stage cleanup failed; sealed output remains durable",
                ))
            }
        }
        self.checkpoint("seal-stage-unlinked")?;
        self.sync_artifact_directory(path.parent().unwrap())?;
        self.checkpoint("seal-stage-sync")?;
        self.transaction(|tx| {
            tx.execute(
                "UPDATE artifacts SET bytes=?2 WHERE handle=?1 AND status='sealed'",
                params![handle, d.byte_length as i64],
            )
            .map_err(sql)?;
            Ok(())
        })?;
        self.checkpoint("seal-quota")
    }
    pub fn gc(&self) -> Result<()> {
        let conn = self.connect()?;
        let mut query = conn
            .prepare("SELECT a.handle FROM artifacts a LEFT JOIN operations o ON o.consumer=a.consumer AND o.operation=a.operation WHERE a.status='released' OR o.phase='released' OR (a.kind='output' AND o.exec_released=1)")
            .map_err(sql)?;
        let handles = query
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(sql)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(sql)?;
        drop(query);
        drop(conn);
        for handle in handles {
            self.collect_artifact(&handle)?;
        }
        Ok(())
    }
    pub fn read(
        &self,
        caller: &PackageGeneration,
        consumer: &str,
        op: &str,
        d: &ArtifactDescriptor,
    ) -> Result<ArtifactPath> {
        generation(caller)?;
        let conn = self.connect()?;
        let owner: String = conn
            .query_row("SELECT owner FROM operations WHERE consumer=?1 AND operation=?2 AND phase!='released'", params![consumer, op], |r| r.get(0))
            .map_err(sql)?;
        let a = Self::record(&conn, consumer, op)?;
        let kind: String = conn
            .query_row(
                "SELECT kind FROM artifacts WHERE handle=?1 AND consumer=?2 AND operation=?3",
                params![d.handle, consumer, op],
                |r| r.get(0),
            )
            .map_err(sql)?;
        self.exact_artifact(&conn, consumer, op, d, &kind)?;
        let allowed = if same_owner(&decode::<PackageGeneration>(&owner)?, caller) {
            kind == "input"
                || a.as_ref().is_some_and(|a| {
                    a.phase == AdmissionPhase::Terminal && a.output.as_ref() == Some(d)
                })
        } else {
            a.as_ref().is_some_and(|a| {
                same_owner(&a.provider, caller)
                    && matches!(
                        a.phase,
                        AdmissionPhase::Forwarding
                            | AdmissionPhase::Accepted
                            | AdmissionPhase::Terminal
                    )
                    && (kind == "output" || a.inputs.contains(d))
            })
        };
        if !allowed {
            return Err(reject(
                "artifact read is not granted to this operation owner",
            ));
        }
        drop(conn);
        let path = self.verify_bytes(d)?;
        Ok(ArtifactPath {
            path: path.to_string_lossy().into(),
            artifact: d.clone(),
        })
    }
    pub fn acquired(
        &self,
        caller: &PackageGeneration,
        op: &str,
        d: &ArtifactDescriptor,
        evidence: &str,
    ) -> Result<TransferReceipt> {
        let a = self.verify_consumer(caller, op)?;
        if a.phase == AdmissionPhase::Released && a.output.as_ref() == Some(d) {
            if let super::receipts::TerminalDelivery::Acquired(receipt) =
                Self::terminal_delivery_at(&self.connect()?, &a)?
            {
                return Ok(TransferReceipt {
                    transfer_receipt: receipt,
                });
            }
        }
        if a.phase != AdmissionPhase::Terminal || a.output.as_ref() != Some(d) {
            return Err(reject("acquisition requires the exact terminal output"));
        }
        let root: String = self
            .connect()?
            .query_row(
                "SELECT path FROM roots WHERE package=?1",
                [&caller.package_id],
                |r| r.get(0),
            )
            .map_err(sql)?;
        let root = PathBuf::from(root);
        let path = PathBuf::from(evidence);
        if !path.is_absolute() || !path.starts_with(&root) || path.starts_with(&self.root) {
            return Err(reject(
                "acquisition evidence must be consumer-owned storage",
            ));
        }
        no_links(&path)?;
        let physical =
            dunce::canonicalize(&path).map_err(|_| reject("consumer evidence unavailable"))?;
        if !physical.starts_with(&root) || physical.starts_with(&self.root) {
            return Err(reject("consumer evidence escaped its storage root"));
        }
        #[cfg(unix)]
        let (mut file, evidence_parents) = open_regular_with_parent(&physical)?;
        #[cfg(not(unix))]
        let mut file = open_regular(&physical)?;
        let bytes = bounded(&mut file, d.byte_length)?;
        if bytes.len() as u64 != d.byte_length || hex::encode(Sha256::digest(&bytes)) != d.sha256 {
            return Err(reject("consumer copy does not match the sealed output"));
        }
        sync_verified(&file, &physical).map_err(|_| reject("consumer evidence sync failed"))?;
        #[cfg(test)]
        self.test_fs.file_synced(&physical);
        self.checkpoint("acquisition-file-sync")?;
        #[cfg(unix)]
        for (path, directory) in evidence_parents.into_iter().rev() {
            #[cfg(test)]
            if self.fail_evidence_sync_at.lock().unwrap().as_ref() == Some(&path) {
                return Err(reject("injected consumer ancestor directory sync failure"));
            }
            #[cfg(not(test))]
            let _ = path;
            directory
                .sync_all()
                .map_err(|_| reject("consumer evidence directory sync failed"))?;
        }
        #[cfg(not(unix))]
        sync_directory(physical.parent().unwrap())?;
        self.checkpoint("acquisition-directory-sync")?;
        let receipt = self.transaction(|tx| {
            let current = Self::record(tx, &caller.package_id, op)?.ok_or_else(|| reject("admission missing"))?;
            if current.phase != AdmissionPhase::Terminal || current.output.as_ref() != Some(d) {
                return Err(reject("handoff changed before evidence commit"));
            }
            // Provider discard and consumer acquisition share this IMMEDIATE
            // transaction boundary. The first durable terminal decision wins;
            // release/collection can follow independently after a crash.
            if Self::terminal_delivery_at(tx, &current)? == super::receipts::TerminalDelivery::Discarded {
                return Err(reject("discarded output cannot be acquired"));
            }
            let old: Option<(String, String)> = tx
                .query_row("SELECT receipt,descriptor FROM evidence WHERE consumer=?1 AND operation=?2", params![caller.package_id, op], |r| Ok((r.get(0)?, r.get(1)?)))
                .optional()
                .map_err(sql)?;
            if let Some((receipt, raw)) = old {
                if decode::<ArtifactDescriptor>(&raw)? != *d {
                    return Err(reject("acquisition evidence conflicts"));
                }
                return Ok(TransferReceipt { transfer_receipt: receipt });
            }
            let receipt = opaque_id()?;
            tx.execute(
                "INSERT INTO evidence(receipt,consumer,operation,descriptor,path)VALUES(?1,?2,?3,?4,?5)",
                params![receipt, caller.package_id, op, encode(d)?, physical.to_string_lossy()],
            )
            .map_err(sql)?;
            Ok(TransferReceipt { transfer_receipt: receipt })
        })?;
        self.checkpoint("acquisition-ledger")?;
        Ok(receipt)
    }
    pub(super) fn acquired_output_path_at(
        &self,
        conn: &rusqlite::Connection,
        a: &Admission,
    ) -> Result<String> {
        Self::verify_acquisition_at(
            conn,
            a,
            a.transfer_receipt
                .as_deref()
                .ok_or_else(|| reject("missing acquisition receipt"))?,
        )?;
        let (path, root): (String,String) = conn.query_row("SELECT e.path,r.path FROM evidence e JOIN roots r ON r.package=e.consumer WHERE e.consumer=?1 AND e.operation=?2", params![a.consumer.package_id,a.operation_id],|r|Ok((r.get(0)?,r.get(1)?))).map_err(sql)?;
        let path = PathBuf::from(path);
        // This is historical presentation, not a fresh file capability. The
        // acquisition commit already verified and fsynced these exact bytes.
        // Later consumer deletion/editing cannot undo delivery or veto removal.
        if !path.is_absolute() || !path.starts_with(root) || path.starts_with(&self.root) {
            return Err(reject("consumer evidence escaped its storage root"));
        }
        Ok(path.to_string_lossy().into())
    }
    pub(super) fn collect_released(&self, consumer: &str, op: &str) -> Result<()> {
        let conn = self.connect()?;
        let mut q = conn
            .prepare("SELECT handle FROM artifacts WHERE consumer=?1 AND operation=?2 AND ((kind='input' AND status='released') OR EXISTS(SELECT 1 FROM operations WHERE consumer=?1 AND operation=?2 AND phase='released'))")
            .map_err(sql)?;
        let handles = q
            .query_map(params![consumer, op], |r| r.get::<_, String>(0))
            .map_err(sql)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(sql)?;
        drop(q);
        drop(conn);
        for handle in handles {
            self.collect_artifact(&handle)?;
        }
        Ok(())
    }
    fn collect_artifact(&self, handle: &str) -> Result<()> {
        let collectable = |conn: &rusqlite::Connection| -> Result<bool> {
            let row: Option<(String,String,bool,bool)> = conn.query_row("SELECT a.consumer,a.operation,coalesce((a.status='released' OR o.phase='released'),0),coalesce((a.kind='output' AND o.exec_released=1),0) FROM artifacts a LEFT JOIN operations o ON o.consumer=a.consumer AND o.operation=a.operation WHERE a.handle=?1", [handle], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional().map_err(sql)?;
            match row {
                Some((_, _, true, _)) => Ok(true),
                Some((consumer, op, false, true)) => {
                    if self.original_writer_active(&consumer, &op)? {
                        return Ok(false);
                    }
                    Ok(!self.retained_output_at(conn, &consumer, &op)?)
                }
                _ => Ok(false),
            }
        };
        if !collectable(&self.connect()?)? {
            return Ok(());
        }
        // Collector leases do not recursively schedule their own collection.
        let Ok(_lease) = self.artifact_lease(handle, false) else {
            return Ok(());
        };
        if !collectable(&self.connect()?)? {
            return Ok(());
        }
        // The Released commit already happened. Byte removal is best-effort:
        // on failure the artifact row stays, so a later sweep retries it.
        let mut collected = true;
        for path in [
            self.bytes_path(&handle)?,
            self.pending_path(&handle)?,
            self.stage_path(&handle)?,
        ] {
            let removed = self.unlink_artifact_file(&path);
            match removed {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    log::warn!("released artifact cleanup deferred for a later sweep: {error}");
                    collected = false;
                }
            }
            // NotFound after a failed/unfinished earlier unlink still requires
            // the durability barrier before retiring its inventory and charge.
            if self
                .sync_artifact_directory(path.parent().unwrap())
                .is_err()
            {
                collected = false;
            }
        }
        self.transaction(|tx| {
            if collected {
                tx.execute("DELETE FROM artifacts WHERE handle=?1 AND (status='released' OR EXISTS(SELECT 1 FROM operations o WHERE o.consumer=artifacts.consumer AND o.operation=artifacts.operation AND o.phase='released'))", [handle])
                    .map_err(sql)?;
                // Settled identity remains eligible for late original success.
                tx.execute("UPDATE artifacts SET bytes=0 WHERE handle=?1", [handle]).map_err(sql)?;
            }
            // Failed barriers retain the previous charge: an unflushed unlink
            // can return on power loss even when stat currently says missing.
            Ok(())
        })
    }

    fn unlink_artifact_file(&self, path: &Path) -> std::io::Result<()> {
        #[cfg(test)]
        {
            self.test_fs.unlink(path)
        }
        #[cfg(not(test))]
        {
            fs::remove_file(path)
        }
    }
    fn sync_artifact_directory(&self, path: &Path) -> Result<()> {
        #[cfg(test)]
        let result = self.test_fs.sync(path);
        #[cfg(not(test))]
        let result = crate::durable_dir::sync(path);
        result.map_err(|_| reject("artifact directory sync failed"))
    }
}
impl Store {
    /// Root supplies exact proven-dead incarnations. An IO lease failure
    /// defers that operation; no lifecycle or SQLite lock waits for byte IO.
    pub fn release_preparations(&self, owner: &PackageGeneration) -> Result<usize> {
        generation(owner)?;
        let pending = self
            .preparation_rows()?
            .into_iter()
            .filter(|(_, current)| current == owner);
        let mut released = 0;
        for (op, _) in pending {
            let conn = self.connect()?;
            let mut query = conn
                .prepare("SELECT handle FROM artifacts WHERE consumer=?1 AND operation=?2")
                .map_err(sql)?;
            let handles = query
                .query_map(params![owner.package_id, op], |r| r.get::<_, String>(0))
                .map_err(sql)?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(sql)?;
            drop(query);
            drop(conn);
            let Ok(leases) = handles
                .iter()
                .map(|handle| self.lease(handle))
                .collect::<Result<Vec<_>>>()
            else {
                continue;
            };
            let changed = self.transaction(|tx| {
                if Self::preparation_owner(tx, &owner.package_id, &op)?.as_ref() != Some(owner) {
                    return Ok(false);
                }
                if self.preparation_retained_in(tx, &owner.package_id, &op)? {
                    return Ok(false);
                }
                if let Some(mut a) = Self::record(tx, &owner.package_id, &op)? {
                    a.phase = AdmissionPhase::Released;
                    a.disposition = Some("never_forwarded".into());
                    Self::persist(tx, &a)?;
                } else {
                    tx.execute(
                        "UPDATE operations SET phase='released' WHERE consumer=?1 AND operation=?2 AND phase='reserved' AND admission IS NULL",
                        params![owner.package_id, op],
                    )
                    .map_err(sql)?;
                }
                Ok(true)
            })?;
            drop(leases);
            if changed {
                self.collect_released(&owner.package_id, &op)?;
                released += 1;
            }
        }
        Ok(released)
    }
    pub(super) fn recover_unaccepted(&self) -> Result<()> {
        let conn = self.connect()?;
        let mut query = conn.prepare("SELECT owner,operation FROM operations WHERE admission IS NULL AND phase='reserved' AND captures IS NULL").map_err(sql)?;
        let pending = query
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(sql)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(sql)?;
        drop(query);
        drop(conn);
        for (raw, op) in pending {
            let owner: PackageGeneration = decode(&raw)?;
            self.recover_candidate(&owner, &op)?;
        }
        Ok(())
    }
    pub(super) fn recover_candidate(&self, owner: &PackageGeneration, op: &str) -> Result<()> {
        let conn = self.connect()?;
        let mut q = conn
            .prepare("SELECT handle FROM artifacts WHERE consumer=?1 AND operation=?2")
            .map_err(sql)?;
        let handles = q
            .query_map(params![owner.package_id, op], |r| r.get::<_, String>(0))
            .map_err(sql)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(sql)?;
        drop(q);
        drop(conn);
        let leases = handles
            .iter()
            .map(|h| self.lease(h))
            .collect::<Result<Vec<_>>>();
        if let Ok(leases) = leases {
            let changed = self.transaction(|tx| {
                if self.live_preparation_job_in(tx, &owner.package_id, op)? { return Ok(false); }
                Ok(tx
                    .execute(
                        "UPDATE operations SET phase='released' WHERE consumer=?1 AND operation=?2 AND phase='reserved' AND admission IS NULL AND captures IS NULL",
                        params![owner.package_id, op],
                    )
                    .map_err(sql)?
                    > 0)
            })?;
            drop(leases);
            if changed {
                self.collect_released(&owner.package_id, op)?;
            }
        }
        Ok(())
    }
}
