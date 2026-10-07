//! Validated immutable plugin payloads. Installation never evaluates plugin code.
use crate::error::AppError;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    fs::{self, File},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
};

/// SDK versions this host can run. SDK 2 adds file views, Preview-info
/// sections and Preview targets; SDK 1 packages keep working unchanged.
pub(super) const SDK_VERSIONS: std::ops::RangeInclusive<u32> = 1..=2;
pub(super) const SVELTE_VERSION: &str = "5.56.3";
const MAX_ARCHIVE: u64 = 256 * 1024 * 1024;
const MAX_PAYLOAD: u64 = 512 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Manifest {
    pub format_version: u32,
    pub id: String,
    pub name: String,
    pub description: String,
    pub version: String,
    pub sdk_version: u32,
    pub svelte_version: String,
    pub target: String,
    pub frontend: String,
    pub styles: String,
    pub backend: String,
    pub contributions: Vec<String>,
    #[serde(default)]
    pub provenance: bool,
    #[serde(default)]
    pub initial_data_files: Vec<String>,
    #[serde(default)]
    pub state_files: Vec<String>,
    pub files: BTreeMap<String, Payload>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Payload {
    size: u64,
    sha256: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Installed {
    pub manifest: Manifest,
    #[serde(default = "enabled_by_default")]
    pub enabled: bool,
    pub digest: String,
}

fn enabled_by_default() -> bool {
    true
}

fn invalid(message: impl Into<String>) -> AppError {
    AppError::Other(message.into())
}

fn open_regular(path: &Path) -> std::io::Result<File> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "Plugin data must be a regular file",
        ));
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path)?;
    if !file.metadata()?.is_file() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "Plugin data must be a regular file",
        ));
    }
    Ok(file)
}

fn read_regular(path: &Path, limit: u64) -> std::io::Result<Vec<u8>> {
    let file = open_regular(path)?;
    if file.metadata()?.len() > limit {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "Plugin data exceeds its size limit",
        ));
    }
    let mut bytes = vec![];
    file.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "Plugin data exceeds its size limit",
        ));
    }
    Ok(bytes)
}
fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'-')
        })
        && value
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_lowercase())
}
fn portable_path(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 200
        && !value.contains(['\\', ':', '\0'])
        && !value.starts_with('/')
        && value
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
        && Path::new(value)
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
}
fn target() -> String {
    let arch = std::env::consts::ARCH;
    let suffix = match std::env::consts::OS {
        "linux" => "unknown-linux-gnu",
        "macos" => "apple-darwin",
        "windows" => "pc-windows-msvc",
        other => other,
    };
    format!("{arch}-{suffix}")
}

impl Manifest {
    pub(super) fn validate(&self) -> Result<(), AppError> {
        if self.format_version != 1
            || !SDK_VERSIONS.contains(&self.sdk_version)
            || self.svelte_version != SVELTE_VERSION
        {
            return Err(invalid("Incompatible plugin SDK or Svelte runtime"));
        }
        if self.target != target() {
            return Err(invalid(format!(
                "Plugin targets {}; this host requires {}",
                self.target,
                target()
            )));
        }
        if !identifier(&self.id)
            || self.name.is_empty()
            || self.name.len() > 200
            || self.description.len() > 2000
        {
            return Err(invalid("Invalid plugin identity"));
        }
        if self.version.len() > 40
            || self.version.split('.').count() != 3
            || !self
                .version
                .split('.')
                .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
        {
            return Err(invalid("Invalid plugin version"));
        }
        let entries = [&self.frontend, &self.styles, &self.backend];
        if self.files.len() != 3
            || !self.frontend.ends_with(".js")
            || !self.styles.ends_with(".css")
            || entries.iter().collect::<HashSet<_>>().len() != 3
            || entries.iter().any(|path| !self.files.contains_key(*path))
        {
            return Err(invalid(
                "Plugin must declare its frontend, styles and native backend",
            ));
        }
        let mut total = 0u64;
        for (name, file) in &self.files {
            if !portable_path(name)
                || file.size == 0
                || file.sha256.len() != 64
                || !file.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
            {
                return Err(invalid("Invalid plugin payload declaration"));
            }
            total = total
                .checked_add(file.size)
                .ok_or_else(|| invalid("Plugin size overflow"))?;
            if total > MAX_PAYLOAD
                || (name == &self.frontend || name == &self.styles) && file.size > 5 * 1024 * 1024
            {
                return Err(invalid("Plugin payload exceeds size limits"));
            }
        }
        if self.contributions.is_empty()
            || self.contributions.len() > 16
            || self.contributions.iter().any(|id| !identifier(id))
            || self.contributions.iter().collect::<HashSet<_>>().len() != self.contributions.len()
        {
            return Err(invalid("Invalid plugin contributions"));
        }
        if self.state_files.len() > 16
            || self
                .state_files
                .iter()
                .any(|file| !portable_path(file) || file.len() > 180 || file.contains('/'))
            || self.initial_data_files.len() > 16
            || self
                .initial_data_files
                .iter()
                .any(|file| !portable_path(file) || file.contains('/'))
        {
            return Err(invalid("Invalid initial plugin data files"));
        }
        Ok(())
    }
}

pub(super) fn list(root: &Path) -> Result<Vec<Installed>, AppError> {
    match read_regular(&root.join("installed.json"), 1024 * 1024) {
        Ok(bytes) if bytes.len() <= 1024 * 1024 => {
            let entries: Vec<Installed> = serde_json::from_slice(&bytes)
                .map_err(|error| invalid(format!("Invalid installed plugin index: {error}")))?;
            if entries.len() > 64
                || entries.iter().any(|entry| {
                    !identifier(&entry.manifest.id)
                        || entry.digest.len() != 64
                        || !entry.digest.bytes().all(|byte| byte.is_ascii_hexdigit())
                        || entry.manifest.files.keys().any(|name| !portable_path(name))
                })
            {
                return Err(invalid("Invalid installed plugin index"));
            }
            Ok(entries)
        }
        Ok(_) => Err(invalid("Installed plugin index exceeds size limit")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(vec![]),
        Err(error) => Err(error.into()),
    }
}

pub(super) fn write_index(root: &Path, index: &[Installed]) -> Result<(), AppError> {
    let mut stage = tempfile::NamedTempFile::new_in(root)?;
    serde_json::to_writer(&mut stage, index).map_err(|error| invalid(error.to_string()))?;
    stage.flush()?;
    stage.as_file().sync_all()?;
    stage
        .persist(root.join("installed.json"))
        .map_err(|error| AppError::from(error.error))?;
    #[cfg(unix)]
    {
        File::open(root)?.sync_all()?;
    }
    Ok(())
}

pub(super) fn payload_path(root: &Path, installed: &Installed) -> PathBuf {
    root.join("payloads").join(&installed.digest)
}

pub(super) fn backend_path(root: &Path, installed: &Installed) -> Result<PathBuf, AppError> {
    installed.manifest.validate()?;
    let base = fs::canonicalize(payload_path(root, installed))?;
    let binary = fs::canonicalize(base.join(&installed.manifest.backend))?;
    if !binary.starts_with(&base) {
        return Err(invalid("Plugin backend escapes its payload"));
    }
    let declared = &installed.manifest.files[&installed.manifest.backend];
    let mut file = open_regular(&binary)?.take(declared.size + 1);
    if file.get_ref().metadata()?.len() != declared.size {
        return Err(invalid("Installed backend changed"));
    }
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    if hex::encode(hasher.finalize()) != declared.sha256 {
        return Err(invalid("Installed backend changed"));
    }
    Ok(binary)
}

pub(super) fn prepare(root: &Path, archive: &Path) -> Result<Installed, AppError> {
    if !archive.is_absolute() {
        return Err(invalid("Plugin archive path must be absolute"));
    }
    let bytes = read_regular(archive, MAX_ARCHIVE)?;
    let digest = hex::encode(Sha256::digest(&bytes));
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes))
        .map_err(|error| invalid(format!("Invalid plugin archive: {error}")))?;
    if zip.len() != 4 {
        return Err(invalid("Plugin archive contains undeclared entries"));
    }
    let manifest: Manifest = {
        let mut entry = zip
            .by_name("manifest.json")
            .map_err(|_| invalid("Plugin manifest is missing"))?;
        let mut content = vec![];
        (&mut entry).take(64 * 1024 + 1).read_to_end(&mut content)?;
        if content.len() > 64 * 1024 {
            return Err(invalid("Plugin manifest exceeds size limit"));
        }
        serde_json::from_slice(&content)
            .map_err(|error| invalid(format!("Invalid plugin manifest: {error}")))?
    };
    manifest.validate()?;
    fs::create_dir_all(root.join("payloads"))?;
    let staging = tempfile::Builder::new()
        .prefix(".install-")
        .tempdir_in(root.join("payloads"))?;
    let mut names = HashSet::new();
    for index in 0..zip.len() {
        let mut entry = zip
            .by_index(index)
            .map_err(|error| invalid(error.to_string()))?;
        let name = entry.name().to_owned();
        if !names.insert(name.clone())
            || !portable_path(&name)
            || entry.is_dir()
            || entry
                .unix_mode()
                .is_some_and(|mode| mode & 0o170000 != 0 && mode & 0o170000 != 0o100000)
        {
            return Err(invalid(
                "Plugin archive contains duplicate, special or unsafe entries",
            ));
        }
        if name == "manifest.json" {
            continue;
        }
        let declared = manifest
            .files
            .get(&name)
            .ok_or_else(|| invalid("Plugin archive contains an undeclared file"))?;
        if entry.size() != declared.size {
            return Err(invalid("Plugin payload size differs from its manifest"));
        }
        let path = staging.path().join(&name);
        fs::create_dir_all(
            path.parent()
                .ok_or_else(|| invalid("Invalid payload path"))?,
        )?;
        let mut output = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)?;
        let mut hasher = Sha256::new();
        let mut total = 0u64;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let count = entry.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            total = total
                .checked_add(count as u64)
                .ok_or_else(|| invalid("Payload size overflow"))?;
            if total > declared.size {
                return Err(invalid("Plugin payload exceeds declared size"));
            }
            hasher.update(&buffer[..count]);
            output.write_all(&buffer[..count])?;
        }
        if total != declared.size || hex::encode(hasher.finalize()) != declared.sha256 {
            return Err(invalid("Plugin payload digest differs from its manifest"));
        }
        output.sync_all()?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(
                &path,
                fs::Permissions::from_mode(if name == manifest.backend {
                    0o700
                } else {
                    0o600
                }),
            )?;
        }
    }
    let installed = Installed {
        manifest,
        digest,
        enabled: true,
    };
    let destination = payload_path(root, &installed);
    if !destination.exists() {
        fs::rename(staging.path(), &destination)?;
    }
    Ok(installed)
}

pub(super) fn publish(root: &Path, installed: Installed) -> Result<Installed, AppError> {
    let mut index = list(root)?;
    if index.iter().any(|previous| {
        previous.manifest.id != installed.manifest.id
            && (previous.manifest.provenance && installed.manifest.provenance
                || previous
                    .manifest
                    .contributions
                    .iter()
                    .any(|id| installed.manifest.contributions.contains(id)))
    }) {
        return Err(invalid(
            "Plugin contribution or provenance provider is already installed",
        ));
    }
    index.retain(|previous| previous.manifest.id != installed.manifest.id);
    index.push(installed.clone());
    write_index(root, &index)?;
    Ok(installed)
}

pub(super) fn uninstall(root: &Path, id: &str) -> Result<(), AppError> {
    let mut index = list(root)?;
    index.retain(|entry| entry.manifest.id != id);
    write_index(root, &index)
    // Immutable payloads and user data remain for restart/rollback; future GC
    // may retire versions only after their process and webview leases drain.
}

pub(super) fn frontend_asset(root: &Path, path: &str) -> Result<(Vec<u8>, &'static str), AppError> {
    let segments: Vec<_> = path.trim_start_matches('/').split('/').collect();
    if segments.len() < 3 {
        return Err(invalid("Invalid plugin asset path"));
    }
    let installed = list(root)?
        .into_iter()
        .find(|entry| entry.manifest.id == segments[0] && entry.digest == segments[1])
        .ok_or_else(|| invalid("Plugin asset is not installed"))?;
    let relative = segments[2..].join("/");
    let mime = if relative == installed.manifest.frontend {
        "text/javascript"
    } else if relative == installed.manifest.styles {
        "text/css"
    } else {
        return Err(invalid("Plugin asset is not public"));
    };
    let base = fs::canonicalize(payload_path(root, &installed))?;
    let asset = fs::canonicalize(base.join(&relative))?;
    if !asset.starts_with(&base) {
        return Err(invalid("Plugin asset escapes payload"));
    }
    let declaration = &installed.manifest.files[&relative];
    let bytes = read_regular(&asset, declaration.size.min(5 * 1024 * 1024))?;
    if bytes.len() as u64 != declaration.size
        || hex::encode(Sha256::digest(&bytes)) != declaration.sha256
    {
        return Err(invalid("Installed plugin asset changed"));
    }
    Ok((bytes, mime))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn archive(directory: &Path, mutate: impl FnOnce(&mut Manifest)) -> PathBuf {
        let contents = [
            ("frontend/index.js", b"export const plugins=[];".as_slice()),
            ("frontend/index.css", b"body{}".as_slice()),
            ("backend/worker", b"native fixture".as_slice()),
        ];
        let mut manifest = Manifest {
            format_version: 1,
            id: "example.plugin".into(),
            name: "Example".into(),
            description: "Fixture".into(),
            version: "1.0.0".into(),
            sdk_version: 1,
            svelte_version: SVELTE_VERSION.into(),
            target: target(),
            frontend: "frontend/index.js".into(),
            styles: "frontend/index.css".into(),
            backend: "backend/worker".into(),
            contributions: vec!["example".into()],
            provenance: false,
            initial_data_files: vec![],
            state_files: vec!["history.sqlite".into()],
            files: contents
                .iter()
                .map(|(name, bytes)| {
                    (
                        name.to_string(),
                        Payload {
                            size: bytes.len() as u64,
                            sha256: hex::encode(Sha256::digest(bytes)),
                        },
                    )
                })
                .collect(),
        };
        mutate(&mut manifest);
        let path = directory.join("fixture.teplugin");
        let mut zip = zip::ZipWriter::new(File::create(&path).unwrap());
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("manifest.json", options).unwrap();
        serde_json::to_writer(&mut zip, &manifest).unwrap();
        for (name, bytes) in contents {
            zip.start_file(name, options).unwrap();
            zip.write_all(bytes).unwrap();
        }
        zip.finish().unwrap();
        path
    }
    #[test]
    fn installing_serves_only_declared_frontend_assets_and_removal_preserves_payload() {
        let profile = tempfile::tempdir().unwrap();
        let root = profile.path().join("plugins");
        let input = archive(profile.path(), |_| {});
        let installed = publish(&root, prepare(&root, &input).unwrap()).unwrap();
        assert_eq!(list(&root).unwrap().len(), 1);
        let base = format!("/{}/{}/", installed.manifest.id, installed.digest);
        assert_eq!(
            frontend_asset(&root, &format!("{base}frontend/index.js"))
                .unwrap()
                .0,
            b"export const plugins=[];"
        );
        assert!(frontend_asset(&root, &format!("{base}backend/worker")).is_err());
        assert!(frontend_asset(&root, &format!("{base}../installed.json")).is_err());
        let payload = payload_path(&root, &installed);
        uninstall(&root, &installed.manifest.id).unwrap();
        assert!(list(&root).unwrap().is_empty());
        assert!(payload.join("backend/worker").is_file());
    }
    #[test]
    fn incompatible_or_corrupted_archives_never_activate() {
        for invalid_case in 0..4 {
            let profile = tempfile::tempdir().unwrap();
            let root = profile.path().join("plugins");
            let input = archive(profile.path(), |manifest| match invalid_case {
                0 => manifest.svelte_version = "5.56.2".into(),
                1 => manifest.target = "different-target".into(),
                2 => manifest.files.get_mut("backend/worker").unwrap().sha256 = "0".repeat(64),
                _ => manifest.frontend = "../outside.js".into(),
            });
            assert!(prepare(&root, &input).is_err());
            assert!(list(&root).unwrap().is_empty());
        }
    }
    #[test]
    fn edited_backend_payload_is_rejected_before_execution() {
        let profile = tempfile::tempdir().unwrap();
        let root = profile.path().join("plugins");
        let input = archive(profile.path(), |_| {});
        let installed = publish(&root, prepare(&root, &input).unwrap()).unwrap();
        fs::write(
            payload_path(&root, &installed).join("backend/worker"),
            b"altered worker",
        )
        .unwrap();
        assert!(backend_path(&root, &installed).is_err());
    }
}
