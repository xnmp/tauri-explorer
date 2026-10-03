//! Durable, read-only provenance for committed image transformations.
//! Artifact identity includes content and path; source revisions are never
//! inferred from a filename after it has changed.
use crate::{config, error::AppError, image_crop};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::Read,
    path::Path,
    time::Duration,
};

const MAX_IMAGE_BYTES: u64 = 200 * 1024 * 1024;

pub(crate) struct CropMetadata {
    pub source_path: String,
    pub source_digest: String,
    pub rect: image_crop::CropRect,
    pub viewport: image_crop::SvgViewport,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Artifact {
    id: i64,
    path: String,
    digest: String,
    created_at: String,
    generating_run: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Run {
    id: i64,
    operation: String,
    parameters: serde_json::Value,
    created_at: String,
    input_ids: Vec<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TraceGraph {
    current_artifact_id: i64,
    artifacts: Vec<Artifact>,
    runs: Vec<Run>,
}

fn sql(error: rusqlite::Error) -> AppError {
    AppError::Other(format!("Trace database: {error}"))
}

fn connection_at(path: &Path) -> Result<Connection, AppError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)
        {
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
        let metadata = fs::symlink_metadata(path)?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(AppError::Other(
                "Trace database must be a regular file".into(),
            ));
        }
        if metadata.permissions().mode() & 0o077 != 0 {
            fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
        }
    }
    let connection = Connection::open(path).map_err(sql)?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(sql)?;
    connection
        .execute_batch(
            "PRAGMA foreign_keys=ON;
         CREATE TABLE IF NOT EXISTS artifacts (
           id INTEGER PRIMARY KEY,
           path TEXT NOT NULL,
           digest TEXT NOT NULL,
           created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
           generating_run INTEGER REFERENCES runs(id)
         );
         CREATE INDEX IF NOT EXISTS artifacts_by_path ON artifacts(path, digest, id DESC);
         CREATE TABLE IF NOT EXISTS runs (
           id INTEGER PRIMARY KEY,
           operation TEXT NOT NULL,
           parameters TEXT NOT NULL,
           created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         );
         CREATE TABLE IF NOT EXISTS run_inputs (
           run_id INTEGER NOT NULL REFERENCES runs(id),
           artifact_id INTEGER NOT NULL REFERENCES artifacts(id),
           position INTEGER NOT NULL,
           PRIMARY KEY (run_id, position)
         );",
        )
        .map_err(sql)?;
    Ok(connection)
}

fn database_path() -> Result<std::path::PathBuf, AppError> {
    Ok(config::config_dir()?.join("trace.sqlite"))
}

fn digest(path: &Path) -> Result<String, AppError> {
    let mut file = File::open(path)?;
    if file.metadata()?.len() > MAX_IMAGE_BYTES {
        return Err(AppError::Other(
            "Image exceeds Trace's 200 MiB revision limit".into(),
        ));
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
    Ok(hex::encode(hasher.finalize()))
}

/// Called inside the accepted crop's detached native completion task. A
/// metadata failure becomes a warning; the committed image is never undone.
pub(crate) fn record_crop(
    metadata: CropMetadata,
    output_path: &str,
    output_digest: &str,
) -> Result<(), AppError> {
    record_crop_at(&database_path()?, metadata, output_path, output_digest)
}

fn record_crop_at(
    database: &Path,
    metadata: CropMetadata,
    output_path: &str,
    output_digest: &str,
) -> Result<(), AppError> {
    let source_path = fs::canonicalize(&metadata.source_path)?
        .to_string_lossy()
        .into_owned();
    let output_path = fs::canonicalize(output_path)?
        .to_string_lossy()
        .into_owned();
    let mut connection = connection_at(database)?;
    let tx = connection.transaction().map_err(sql)?;
    let source_id: Option<i64> = tx
        .query_row(
            "SELECT id FROM artifacts WHERE path=?1 AND digest=?2 ORDER BY id DESC LIMIT 1",
            params![source_path, metadata.source_digest],
            |row| row.get(0),
        )
        .optional()
        .map_err(sql)?;
    let source_id = match source_id {
        Some(id) => id,
        None => {
            tx.execute(
                "INSERT INTO artifacts(path,digest) VALUES (?1,?2)",
                params![source_path, metadata.source_digest],
            )
            .map_err(sql)?;
            tx.last_insert_rowid()
        }
    };
    let parameters = serde_json::to_string(&serde_json::json!({
        "rect": metadata.rect,
        "viewport": metadata.viewport,
    }))
    .map_err(|error| AppError::Other(error.to_string()))?;
    tx.execute(
        "INSERT INTO runs(operation,parameters) VALUES ('image.crop',?1)",
        [parameters],
    )
    .map_err(sql)?;
    let run_id = tx.last_insert_rowid();
    tx.execute(
        "INSERT INTO run_inputs(run_id,artifact_id,position) VALUES (?1,?2,0)",
        params![run_id, source_id],
    )
    .map_err(sql)?;
    tx.execute(
        "INSERT INTO artifacts(path,digest,generating_run) VALUES (?1,?2,?3)",
        params![output_path, output_digest, run_id],
    )
    .map_err(sql)?;
    tx.commit().map_err(sql)?;
    Ok(())
}

fn graph_for_path_at(database: &Path, path: &Path) -> Result<Option<TraceGraph>, AppError> {
    if !path.is_absolute() || !path.is_file() {
        return Ok(None);
    }
    if !database.exists() {
        return Ok(None);
    }
    let connection = connection_at(database)?;
    let resolved = fs::canonicalize(path)?;
    let path_text = resolved.to_string_lossy();
    let known: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM artifacts WHERE path=?1)",
            [path_text.as_ref()],
            |row| row.get(0),
        )
        .map_err(sql)?;
    if !known {
        return Ok(None);
    }
    let current_digest = digest(path)?;
    let current: Option<i64> = connection
        .query_row(
            "SELECT id FROM artifacts WHERE path=?1 AND digest=?2 ORDER BY id DESC LIMIT 1",
            params![path_text.as_ref(), current_digest],
            |row| row.get(0),
        )
        .optional()
        .map_err(sql)?;
    let Some(current_artifact_id) = current else {
        return Ok(None);
    };
    let mut graph = TraceGraph {
        current_artifact_id,
        artifacts: Vec::new(),
        runs: Vec::new(),
    };
    let mut pending = vec![current_artifact_id];
    let mut seen = HashSet::new();
    while let Some(id) = pending.pop() {
        if !seen.insert(id) {
            continue;
        }
        if seen.len() > 1024 {
            return Err(AppError::Other("Trace graph exceeds 1024 artifacts".into()));
        }
        let artifact = connection
            .query_row(
                "SELECT id,path,digest,created_at,generating_run FROM artifacts WHERE id=?1",
                [id],
                |row| {
                    Ok(Artifact {
                        id: row.get(0)?,
                        path: row.get(1)?,
                        digest: row.get(2)?,
                        created_at: row.get(3)?,
                        generating_run: row.get(4)?,
                    })
                },
            )
            .map_err(sql)?;
        if let Some(run_id) = artifact.generating_run {
            let mut run = connection
                .query_row(
                    "SELECT id,operation,parameters,created_at FROM runs WHERE id=?1",
                    [run_id],
                    |row| {
                        let parameters: String = row.get(2)?;
                        Ok(Run {
                            id: row.get(0)?,
                            operation: row.get(1)?,
                            parameters: serde_json::from_str(&parameters).unwrap_or_default(),
                            created_at: row.get(3)?,
                            input_ids: Vec::new(),
                        })
                    },
                )
                .map_err(sql)?;
            let mut statement = connection
                .prepare("SELECT artifact_id FROM run_inputs WHERE run_id=?1 ORDER BY position")
                .map_err(sql)?;
            run.input_ids = statement
                .query_map([run_id], |row| row.get(0))
                .map_err(sql)?
                .collect::<Result<Vec<i64>, _>>()
                .map_err(sql)?;
            pending.extend(run.input_ids.iter().copied());
            graph.runs.push(run);
        }
        graph.artifacts.push(artifact);
    }
    Ok(Some(graph))
}

#[tauri::command]
pub(crate) async fn trace_for_image(path: String) -> Result<Option<TraceGraph>, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        graph_for_path_at(&database_path()?, Path::new(&path))
    })
    .await
    .map_err(|error| AppError::Other(format!("Trace query failed: {error}")))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn crop(source: &Path) -> CropMetadata {
        CropMetadata {
            source_path: source.to_string_lossy().into_owned(),
            source_digest: digest(source).unwrap(),
            rect: image_crop::CropRect {
                left: 1,
                top: 2,
                right: 11,
                bottom: 12,
            },
            viewport: image_crop::SvgViewport {
                width: 20,
                height: 20,
            },
        }
    }

    #[test]
    fn crop_chain_is_durable_and_bound_to_exact_output_revision() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("trace.sqlite");
        let source = dir.path().join("source.png");
        let first = dir.path().join("first.png");
        let second = dir.path().join("second.png");
        std::fs::write(&source, b"source pixels").unwrap();
        std::fs::write(&first, b"first crop").unwrap();
        record_crop_at(
            &db,
            crop(&source),
            first.to_str().unwrap(),
            &digest(&first).unwrap(),
        )
        .unwrap();
        std::fs::write(&second, b"second crop").unwrap();
        record_crop_at(
            &db,
            crop(&first),
            second.to_str().unwrap(),
            &digest(&second).unwrap(),
        )
        .unwrap();

        let graph = graph_for_path_at(&db, &second).unwrap().unwrap();
        assert_eq!(graph.artifacts.len(), 3);
        assert_eq!(graph.runs.len(), 2);
        assert_eq!(
            graph
                .runs
                .iter()
                .map(|run| run.operation.as_str())
                .collect::<Vec<_>>(),
            ["image.crop", "image.crop"]
        );
        assert!(graph
            .artifacts
            .iter()
            .any(|artifact| artifact.path == source.to_string_lossy()));

        std::fs::write(&second, b"changed outside the app").unwrap();
        assert!(graph_for_path_at(&db, &second).unwrap().is_none());
    }

    #[test]
    fn replacement_after_publication_cannot_be_attributed_to_crop() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("trace.sqlite");
        let source = dir.path().join("source.png");
        let output = dir.path().join("output.png");
        fs::write(&source, b"source pixels").unwrap();
        fs::write(&output, b"encoded crop").unwrap();
        let intended_digest = digest(&output).unwrap();
        fs::write(&output, b"replaced by another process").unwrap();
        record_crop_at(
            &db,
            crop(&source),
            output.to_str().unwrap(),
            &intended_digest,
        )
        .unwrap();
        assert!(graph_for_path_at(&db, &output).unwrap().is_none());
    }

    #[cfg(unix)]
    #[test]
    fn trace_database_is_private_even_when_an_old_file_is_too_permissive() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("trace.sqlite");
        connection_at(&db).unwrap();
        assert_eq!(
            fs::metadata(&db).unwrap().permissions().mode() & 0o777,
            0o600
        );
        fs::set_permissions(&db, fs::Permissions::from_mode(0o644)).unwrap();
        connection_at(&db).unwrap();
        assert_eq!(
            fs::metadata(&db).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}
