//! Faults around real unlink/fsync, plus a directory-entry power-loss oracle.
//! SQLite still uses its real FULL-synchronous transactions. Only unflushed
//! directory removals are restored, never committed database state.
use std::{
    collections::{BTreeMap, HashMap},
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock, Weak},
};
pub(super) fn for_root(root: &Path) -> Arc<TestFs> {
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
    unlink: bool,
    sync: bool,
    removed: BTreeMap<PathBuf, Vec<u8>>,
}
impl TestFs {
    pub fn unflushed_bytes(&self) -> u64 {
        self.0
            .lock()
            .unwrap()
            .removed
            .values()
            .map(|v| v.len() as u64)
            .sum()
    }
    pub fn unflushed_data_paths(&self) -> Vec<(PathBuf, u64)> {
        self.0
            .lock()
            .unwrap()
            .removed
            .iter()
            .filter(|(p, _)| p.extension().is_none_or(|n| n != "json"))
            .map(|(p, v)| (p.clone(), v.len() as u64))
            .collect()
    }
    pub fn contains_unflushed_data(&self, bytes: &[u8]) -> bool {
        self.0
            .lock()
            .unwrap()
            .removed
            .iter()
            .any(|(p, v)| p.extension().is_none_or(|n| n != "json") && v == bytes)
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
        let bytes = fs::read(path).ok();
        fs::remove_file(path)?;
        if let Some(bytes) = bytes {
            state.removed.entry(path.into()).or_insert(bytes);
        }
        Ok(())
    }
    pub fn sync(&self, dir: &Path) -> std::io::Result<()> {
        let mut state = self.0.lock().unwrap();
        if state.sync {
            return Err(std::io::Error::other("injected directory sync failure"));
        }
        crate::durable_dir::sync(dir)?;
        state.removed.retain(|p, _| p.parent() != Some(dir));
        Ok(())
    }
    pub fn power_loss(&self) {
        let mut state = self.0.lock().unwrap();
        for (path, bytes) in std::mem::take(&mut state.removed) {
            fs::write(path, bytes).unwrap();
        }
        state.unlink = false;
        state.sync = false;
    }
}
