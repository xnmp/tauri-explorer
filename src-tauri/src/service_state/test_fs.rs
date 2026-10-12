//! Faults and power-loss snapshots around production filesystem boundaries.
//! SQLite retains real FULL-synchronous transactions. Entry durability and file
//! content durability are tracked independently, including partial writes.
use std::{
    collections::{BTreeMap, HashMap},
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock, Weak},
};
pub(crate) fn for_root(root: &Path) -> Arc<TestFs> {
    static ROOTS: OnceLock<Mutex<HashMap<PathBuf, Weak<TestFs>>>> = OnceLock::new();
    let mut roots = ROOTS.get_or_init(Default::default).lock().unwrap();
    roots.retain(|_, x| x.strong_count() > 0);
    if let Some(fs) = roots.get(root).and_then(Weak::upgrade) {
        return fs;
    }
    let fs = Arc::new(TestFs::default());
    roots.insert(root.into(), Arc::downgrade(&fs));
    fs
}

#[derive(Default)]
pub(crate) struct TestFs(Mutex<State>);
#[derive(Default)]
struct State {
    checkpoint: Option<&'static str>,
    checkpoint_hits: BTreeMap<&'static str, u64>,
    unlink: bool,
    sync: bool,
    removed: BTreeMap<PathBuf, Vec<u8>>,
    removed_aliases: BTreeMap<PathBuf, (String, Vec<PathBuf>)>,
    entries: BTreeMap<PathBuf, Entry>,
    contents: BTreeMap<PathBuf, Vec<u8>>,
}
#[derive(Clone)]
enum Entry {
    Missing,
    Directory,
    File(Vec<u8>),
}
fn is_data_path(path: &Path) -> bool {
    path.file_name()
        .is_some_and(|name| name == "stdout" || name == "stderr")
        || path
            .parent()
            .and_then(Path::file_name)
            .is_some_and(|name| name == "bytes" || name == "stages")
}
impl TestFs {
    pub fn crash_at(&self, name: &'static str) {
        self.0.lock().unwrap().checkpoint = Some(name);
    }
    pub fn checkpoint_hits(&self, name: &'static str) -> u64 {
        *self
            .0
            .lock()
            .unwrap()
            .checkpoint_hits
            .get(name)
            .unwrap_or(&0)
    }
    pub fn checkpoint(&self, name: &'static str) -> super::rules::Result<()> {
        let mut state = self.0.lock().unwrap();
        *state.checkpoint_hits.entry(name).or_default() += 1;
        if state.checkpoint == Some(name) {
            state.checkpoint = None;
            return Err(crate::error::AppError::Other(format!(
                "injected aggregate crash: {name}"
            )));
        }
        Ok(())
    }
    /// Call before a real creation or write. An absent entry may disappear even
    /// after its contents are synced until its parent directory is synced.
    pub fn before_mutation(&self, path: &Path) {
        let mut state = self.0.lock().unwrap();
        if path.is_dir() {
            return;
        }
        let content = fs::read(path).unwrap_or_default();
        if !path.exists() {
            state.entries.entry(path.into()).or_insert(Entry::Missing);
        }
        state.contents.entry(path.into()).or_insert(content);
    }
    pub fn created(&self, path: &Path) {
        let mut state = self.0.lock().unwrap();
        state.entries.entry(path.into()).or_insert(Entry::Missing);
        state.contents.entry(path.into()).or_insert_with(Vec::new);
    }
    pub fn file_synced(&self, path: &Path) {
        self.0.lock().unwrap().contents.remove(path);
    }
    pub fn before_rename(&self, source: &Path, target: &Path) {
        let mut state = self.0.lock().unwrap();
        for path in [source, target] {
            let entry = if path.is_dir() {
                Entry::Directory
            } else if let Ok(bytes) = fs::read(path) {
                Entry::File(bytes)
            } else {
                Entry::Missing
            };
            state.entries.entry(path.into()).or_insert(entry);
        }
    }
    pub fn unflushed_bytes(&self) -> u64 {
        self.0
            .lock()
            .unwrap()
            .removed
            .values()
            .map(|v| v.len() as u64)
            .sum()
    }
    pub fn possible_file_identity(&self, path: &Path) -> String {
        crate::files::model_file_identity(path).unwrap_or_else(|_| {
            self.0
                .lock()
                .unwrap()
                .removed_aliases
                .get(path)
                .map(|(id, _)| id.clone())
                .unwrap_or_else(|| format!("path:{}", path.display()))
        })
    }
    pub fn unflushed_data_paths(&self) -> Vec<(PathBuf, u64)> {
        let state = self.0.lock().unwrap();
        let mut paths = BTreeMap::new();
        for (path, bytes) in state.removed.iter().chain(state.contents.iter()) {
            if is_data_path(path) {
                paths
                    .entry(path.clone())
                    .and_modify(|len: &mut u64| *len = (*len).max(bytes.len() as u64))
                    .or_insert(bytes.len() as u64);
            }
        }
        for (path, entry) in &state.entries {
            if let Entry::File(bytes) = entry {
                if is_data_path(path) {
                    paths
                        .entry(path.clone())
                        .and_modify(|len| *len = (*len).max(bytes.len() as u64))
                        .or_insert(bytes.len() as u64);
                }
            }
        }
        paths.into_iter().collect()
    }
    pub fn contains_unflushed_data(&self, bytes: &[u8]) -> bool {
        let state = self.0.lock().unwrap();
        state
            .removed
            .iter()
            .chain(state.contents.iter())
            .any(|(p, v)| is_data_path(p) && v == bytes)
            || state
                .entries
                .iter()
                .any(|(p, v)| is_data_path(p) && matches!(v, Entry::File(v) if v == bytes))
    }
    pub fn faults(&self, unlink: bool, sync: bool) {
        let mut state = self.0.lock().unwrap();
        state.unlink = unlink;
        state.sync = sync;
    }
    pub fn unlink(&self, path: &Path) -> std::io::Result<()> {
        let mut state = self.0.lock().unwrap();
        if state.unlink {
            return Err(std::io::Error::other("injected unlink failure"));
        }
        let bytes = state
            .contents
            .get(path)
            .cloned()
            .or_else(|| fs::read(path).ok());
        let newly_created = matches!(state.entries.get(path), Some(Entry::Missing));
        let identity = crate::files::model_file_identity(path).ok();
        let aliases = identity
            .as_ref()
            .map(|id| {
                fs::read_dir(path.parent().unwrap())
                    .into_iter()
                    .flatten()
                    .filter_map(|entry| entry.ok())
                    .map(|e| e.path())
                    .filter(|other| {
                        other != path
                            && crate::files::model_file_identity(other).ok().as_ref() == Some(id)
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        fs::remove_file(path)?;
        if !newly_created {
            if let Some(identity) = identity {
                state
                    .removed_aliases
                    .entry(path.into())
                    .or_insert((identity, aliases));
            }
            if let Some(bytes) = bytes {
                state.removed.entry(path.into()).or_insert(bytes);
            }
        }
        Ok(())
    }
    pub fn sync(&self, dir: &Path) -> std::io::Result<()> {
        self.sync_in(dir, true)
    }
    /// Artifact cleanup faults do not inject a separate lifecycle-index fault.
    pub fn sync_lifecycle(&self, dir: &Path) -> std::io::Result<()> {
        self.sync_in(dir, false)
    }
    fn sync_in(&self, dir: &Path, inject: bool) -> std::io::Result<()> {
        let mut state = self.0.lock().unwrap();
        if inject && state.sync {
            return Err(std::io::Error::other("injected directory sync failure"));
        }
        crate::durable_dir::sync(dir)?;
        state.removed.retain(|p, _| p.parent() != Some(dir));
        state.removed_aliases.retain(|p, _| p.parent() != Some(dir));
        state.entries.retain(|p, _| p.parent() != Some(dir));
        state
            .contents
            .retain(|p, _| p.parent() != Some(dir) || p.exists());
        Ok(())
    }
    pub fn power_loss(&self) {
        let mut state = self.0.lock().unwrap();
        let entries = std::mem::take(&mut state.entries);
        // Discard absent-at-barrier descendants before their parents.
        for (path, entry) in entries.iter().rev() {
            if matches!(entry, Entry::Missing) {
                if path.is_dir() {
                    let _ = fs::remove_dir_all(path);
                } else {
                    let _ = fs::remove_file(path);
                }
            }
        }
        for (path, entry) in entries {
            match entry {
                Entry::Missing => {}
                Entry::Directory => {
                    fs::create_dir_all(path).unwrap();
                }
                Entry::File(bytes) => {
                    if let Some(parent) = path.parent() {
                        fs::create_dir_all(parent).unwrap();
                    }
                    fs::write(path, bytes).unwrap();
                }
            }
        }
        for (path, bytes) in std::mem::take(&mut state.contents) {
            if path.is_file() {
                fs::write(path, bytes).unwrap();
            }
        }
        let aliases = std::mem::take(&mut state.removed_aliases);
        let mut restored_ids = BTreeMap::<String, String>::new();
        let mut restored_sources = BTreeMap::<String, PathBuf>::new();
        for (path, bytes) in std::mem::take(&mut state.removed) {
            let source = aliases.get(&path).and_then(|(identity, paths)| {
                if let Some(source) = restored_sources.get(identity) {
                    return Some(source);
                }
                let expected = restored_ids.get(identity).unwrap_or(identity);
                paths.iter().find(|p| {
                    crate::files::model_file_identity(p).ok().as_ref() == Some(expected)
                        && fs::read(p).ok().as_ref() == Some(&bytes)
                })
            });
            if let Some(source) = source {
                fs::hard_link(source, &path).unwrap();
            } else {
                fs::write(&path, bytes).unwrap();
            }
            if let Some((old, _)) = aliases.get(&path) {
                restored_sources.entry(old.clone()).or_insert(path.clone());
                restored_ids.insert(
                    old.clone(),
                    crate::files::model_file_identity(&path).unwrap(),
                );
            }
        }
        state.unlink = false;
        state.sync = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn interrupted_hard_link_cleanup_restores_one_physical_object() {
        let root = tempfile::tempdir().unwrap();
        let oracle = TestFs::default();
        let pending = root.path().join("original.pending");
        let published = root.path().join("original.bin");
        fs::write(&pending, b"sole original").unwrap();
        fs::hard_link(&pending, &published).unwrap();
        oracle.unlink(&pending).unwrap();
        oracle.unlink(&published).unwrap();
        oracle.power_loss();
        assert_eq!(
            crate::files::model_file_identity(&pending).unwrap(),
            crate::files::model_file_identity(&published).unwrap()
        );
        assert_eq!(fs::read(&pending).unwrap(), b"sole original");
    }

    #[test]
    fn file_sync_does_not_durably_create_its_directory_entry() {
        let root = tempfile::tempdir().unwrap();
        let oracle = TestFs::default();
        let path = root.path().join("stdout");
        oracle.before_mutation(&path);
        fs::write(&path, b"paid image").unwrap();
        crate::durable_dir::sync_file(&path).unwrap();
        oracle.file_synced(&path);
        oracle.power_loss();
        assert!(!path.exists());
    }
    #[test]
    fn durable_entry_with_unsynced_partial_write_restores_previous_contents() {
        let root = tempfile::tempdir().unwrap();
        let oracle = TestFs::default();
        let path = root.path().join("stdout");
        oracle.before_mutation(&path);
        fs::write(&path, b"paid image").unwrap();
        crate::durable_dir::sync_file(&path).unwrap();
        oracle.file_synced(&path);
        oracle.sync(root.path()).unwrap();
        oracle.before_mutation(&path);
        fs::write(&path, b"partial").unwrap();
        oracle.power_loss();
        assert_eq!(fs::read(path).unwrap(), b"paid image");
    }
    #[test]
    fn directory_sync_does_not_imply_file_content_sync() {
        let root = tempfile::tempdir().unwrap();
        let oracle = TestFs::default();
        let path = root.path().join("stdout");
        oracle.before_mutation(&path);
        fs::write(&path, b"partial").unwrap();
        oracle.sync(root.path()).unwrap();
        oracle.power_loss();
        assert_eq!(fs::read(path).unwrap(), b"");
    }
    #[test]
    fn unflushed_rename_restores_both_original_names_and_contents() {
        let root = tempfile::tempdir().unwrap();
        let oracle = TestFs::default();
        let source = root.path().join("source");
        let target = root.path().join("target");
        fs::write(&source, b"new").unwrap();
        fs::write(&target, b"old").unwrap();
        oracle.before_rename(&source, &target);
        fs::rename(&source, &target).unwrap();
        oracle.power_loss();
        assert_eq!(fs::read(source).unwrap(), b"new");
        assert_eq!(fs::read(target).unwrap(), b"old");
    }
    #[test]
    fn unflushed_creation_then_unlink_never_resurrects_a_new_file() {
        let root = tempfile::tempdir().unwrap();
        let oracle = TestFs::default();
        let path = root.path().join("stdout");
        oracle.before_mutation(&path);
        fs::write(&path, b"partial").unwrap();
        oracle.unlink(&path).unwrap();
        oracle.power_loss();
        assert!(!path.exists());
    }
}
