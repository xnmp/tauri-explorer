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
    path::{Path, PathBuf},
    time::Duration,
};

const MAX_IMAGE_BYTES: u64 = 200 * 1024 * 1024;

pub(crate) struct CropMetadata {
    pub source_path: String,
    pub source_digest: String,
    pub rect: image_crop::CropRect,
    pub viewport: image_crop::SvgViewport,
}

pub(crate) struct OperationInput {
    pub path: String,
    pub digest: String,
}

pub(crate) struct OperationRecord {
    pub operation: String,
    pub parameters: serde_json::Value,
    pub inputs: Vec<OperationInput>,
    pub output_path: String,
    pub output_digest: String,
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
    let schema_version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(sql)?;
    if schema_version > 1 {
        return Err(AppError::Other(format!(
            "Trace database schema {schema_version} is newer than this app supports"
        )));
    }
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
         );
         CREATE INDEX IF NOT EXISTS run_inputs_by_artifact ON run_inputs(artifact_id);
         PRAGMA user_version=1;",
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

fn normalize_path(path: &Path) -> Result<String, AppError> {
    if !path.is_absolute() {
        return Err(AppError::InvalidPath(
            "Trace requires an absolute image path".into(),
        ));
    }
    let resolved = fs::canonicalize(path).or_else(|_| {
        let parent = path
            .parent()
            .ok_or_else(|| std::io::Error::other("Image has no parent"))?;
        let name = path
            .file_name()
            .ok_or_else(|| std::io::Error::other("Image has no name"))?;
        Ok::<_, std::io::Error>(fs::canonicalize(parent)?.join(name))
    })?;
    Ok(resolved.to_string_lossy().into_owned())
}

/// Called inside the accepted crop's detached native completion task. A
/// metadata failure becomes a warning; the committed image is never undone.
pub(crate) fn record_crop(
    metadata: CropMetadata,
    output_path: &str,
    output_digest: &str,
) -> Result<(), AppError> {
    record_operation(crop_record(metadata, output_path, output_digest))
}

/// Native model adapters can use the same durable boundary after publishing
/// their output. Input digests must come from the bytes actually submitted.
pub(crate) fn record_operation(record: OperationRecord) -> Result<(), AppError> {
    record_operation_at(&database_path()?, record)
}

/// Move the locator of the exact revision that Explorer renamed. Earlier
/// revisions at the old name remain historical facts; graph edges use IDs.
pub(crate) fn relocate_image(source: &Path, target: &Path) -> Result<(), AppError> {
    relocate_at(&database_path()?, source, target)
}

pub(crate) async fn relocate_after_rename(
    source: PathBuf,
    target: PathBuf,
) -> Result<(), AppError> {
    tauri::async_runtime::spawn_blocking(move || relocate_image(&source, &target))
        .await
        .map_err(|error| AppError::Other(format!("Trace relocation failed: {error}")))?
}

fn relocate_at(database: &Path, source: &Path, target: &Path) -> Result<(), AppError> {
    if !database.exists() || !target.is_file() {
        return Ok(());
    }
    let source_path = normalize_path(source)?;
    let target_path = normalize_path(target)?;
    let connection = connection_at(&database)?;
    let known: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM artifacts WHERE path=?1)",
            [source_path.as_str()],
            |row| row.get(0),
        )
        .map_err(sql)?;
    if !known {
        return Ok(());
    }
    let current_digest = digest(target)?;
    connection
        .execute(
            "UPDATE artifacts SET path=?1 WHERE id=(SELECT id FROM artifacts WHERE path=?2 AND digest=?3 ORDER BY id DESC LIMIT 1)",
            params![target_path, source_path, current_digest],
        )
        .map_err(sql)?;
    Ok(())
}

fn record_crop_at(
    database: &Path,
    metadata: CropMetadata,
    output_path: &str,
    output_digest: &str,
) -> Result<(), AppError> {
    record_operation_at(database, crop_record(metadata, output_path, output_digest))
}

fn crop_record(metadata: CropMetadata, output_path: &str, output_digest: &str) -> OperationRecord {
    OperationRecord {
        operation: "image.crop".into(),
        parameters: serde_json::json!({ "rect": metadata.rect, "viewport": metadata.viewport }),
        inputs: vec![OperationInput {
            path: metadata.source_path,
            digest: metadata.source_digest,
        }],
        output_path: output_path.into(),
        output_digest: output_digest.into(),
    }
}

fn record_operation_at(database: &Path, record: OperationRecord) -> Result<(), AppError> {
    if record.inputs.is_empty() || record.inputs.len() > 16 {
        return Err(AppError::Other(
            "Trace operation requires 1–16 inputs".into(),
        ));
    }
    if record.operation.is_empty() || record.operation.len() > 128 {
        return Err(AppError::Other("Invalid Trace operation name".into()));
    }
    let valid_digest =
        |value: &str| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit());
    if !valid_digest(&record.output_digest)
        || record
            .inputs
            .iter()
            .any(|input| !valid_digest(&input.digest))
    {
        return Err(AppError::Other("Invalid Trace content digest".into()));
    }
    let output_path = normalize_path(Path::new(&record.output_path))?;
    let mut connection = connection_at(database)?;
    let tx = connection.transaction().map_err(sql)?;
    let mut input_ids = Vec::with_capacity(record.inputs.len());
    for input in &record.inputs {
        let path = normalize_path(Path::new(&input.path))?;
        let existing: Option<i64> = tx
            .query_row(
                "SELECT id FROM artifacts WHERE path=?1 AND digest=?2 ORDER BY id DESC LIMIT 1",
                params![path, input.digest],
                |row| row.get(0),
            )
            .optional()
            .map_err(sql)?;
        let id = match existing {
            Some(id) => id,
            None => {
                tx.execute(
                    "INSERT INTO artifacts(path,digest) VALUES (?1,?2)",
                    params![path, input.digest],
                )
                .map_err(sql)?;
                tx.last_insert_rowid()
            }
        };
        input_ids.push(id);
    }
    let parameters = serde_json::to_string(&record.parameters)
        .map_err(|error| AppError::Other(error.to_string()))?;
    tx.execute(
        "INSERT INTO runs(operation,parameters) VALUES (?1,?2)",
        params![record.operation, parameters],
    )
    .map_err(sql)?;
    let run_id = tx.last_insert_rowid();
    for (position, input_id) in input_ids.into_iter().enumerate() {
        tx.execute(
            "INSERT INTO run_inputs(run_id,artifact_id,position) VALUES (?1,?2,?3)",
            params![run_id, input_id, position as i64],
        )
        .map_err(sql)?;
    }
    tx.execute(
        "INSERT INTO artifacts(path,digest,generating_run) VALUES (?1,?2,?3)",
        params![output_path, record.output_digest, run_id],
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
    let path_text = normalize_path(path)?;
    let known: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM artifacts WHERE path=?1)",
            [path_text.as_str()],
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
            params![path_text.as_str(), current_digest],
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
    let mut scheduled = HashSet::from([current_artifact_id]);
    while let Some(id) = pending.pop() {
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
            for input_id in &run.input_ids {
                if scheduled.insert(*input_id) {
                    if scheduled.len() > 1024 {
                        return Err(AppError::Other("Trace graph exceeds 1024 artifacts".into()));
                    }
                    pending.push(*input_id);
                }
            }
            graph.runs.push(run);
        }
        let mut children = connection
            .prepare("SELECT DISTINCT a.id FROM run_inputs i JOIN artifacts a ON a.generating_run=i.run_id WHERE i.artifact_id=?1 ORDER BY a.id LIMIT 1025")
            .map_err(sql)?;
        let child_ids = children
            .query_map([id], |row| row.get(0))
            .map_err(sql)?
            .collect::<Result<Vec<i64>, _>>()
            .map_err(sql)?;
        for child_id in child_ids {
            if scheduled.insert(child_id) {
                if scheduled.len() > 1024 {
                    return Err(AppError::Other("Trace graph exceeds 1024 artifacts".into()));
                }
                pending.push(child_id);
            }
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
        let branch = dir.path().join("branch.png");
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
        fs::write(&branch, b"another first crop").unwrap();
        record_crop_at(
            &db,
            crop(&source),
            branch.to_str().unwrap(),
            &digest(&branch).unwrap(),
        )
        .unwrap();

        let graph = graph_for_path_at(&db, &second).unwrap().unwrap();
        assert_eq!(graph.artifacts.len(), 4);
        assert_eq!(graph.runs.len(), 3);
        assert_eq!(
            graph
                .runs
                .iter()
                .map(|run| run.operation.as_str())
                .collect::<Vec<_>>(),
            ["image.crop", "image.crop", "image.crop"]
        );
        assert!(graph
            .artifacts
            .iter()
            .any(|artifact| artifact.path == source.to_string_lossy()));
        let source_graph = graph_for_path_at(&db, &source).unwrap().unwrap();
        assert_eq!(source_graph.artifacts.len(), 4);
        assert!(source_graph
            .artifacts
            .iter()
            .any(|artifact| artifact.path == branch.to_string_lossy()));

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

    #[test]
    fn relocated_output_retains_its_graph_identity() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("trace.sqlite");
        let source = dir.path().join("source.png");
        let output = dir.path().join("output.png");
        let renamed = dir.path().join("renamed.png");
        fs::write(&source, b"source pixels").unwrap();
        fs::write(&output, b"encoded crop").unwrap();
        record_crop_at(
            &db,
            crop(&source),
            output.to_str().unwrap(),
            &digest(&output).unwrap(),
        )
        .unwrap();
        fs::rename(&output, &renamed).unwrap();
        relocate_at(&db, &output, &renamed).unwrap();
        let graph = graph_for_path_at(&db, &renamed).unwrap().unwrap();
        assert_eq!(graph.artifacts.len(), 2);
        assert_eq!(
            graph.current_artifact_id,
            graph
                .artifacts
                .iter()
                .find(|artifact| artifact.path == renamed.to_string_lossy())
                .unwrap()
                .id
        );
        fs::rename(&renamed, &output).unwrap();
        relocate_at(&db, &renamed, &output).unwrap();
        assert!(graph_for_path_at(&db, &output).unwrap().is_some());
    }

    #[test]
    fn one_operation_can_join_two_source_revisions() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("trace.sqlite");
        let left = dir.path().join("left.png");
        let right = dir.path().join("right.png");
        let output = dir.path().join("composite.png");
        fs::write(&left, b"left").unwrap();
        fs::write(&right, b"right").unwrap();
        fs::write(&output, b"combined").unwrap();
        record_operation_at(
            &db,
            OperationRecord {
                operation: "image.compose".into(),
                parameters: serde_json::json!({"blend": "multiply"}),
                inputs: vec![
                    OperationInput {
                        path: left.to_string_lossy().into_owned(),
                        digest: digest(&left).unwrap(),
                    },
                    OperationInput {
                        path: right.to_string_lossy().into_owned(),
                        digest: digest(&right).unwrap(),
                    },
                ],
                output_path: output.to_string_lossy().into_owned(),
                output_digest: digest(&output).unwrap(),
            },
        )
        .unwrap();
        let graph = graph_for_path_at(&db, &left).unwrap().unwrap();
        assert_eq!(graph.artifacts.len(), 3);
        assert_eq!(graph.runs.len(), 1);
        assert_eq!(graph.runs[0].input_ids.len(), 2);
        assert!(graph
            .artifacts
            .iter()
            .any(|artifact| artifact.path == right.to_string_lossy()));
        assert!(graph
            .artifacts
            .iter()
            .any(|artifact| artifact.path == output.to_string_lossy()));
    }

    #[test]
    fn oversized_branching_graph_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("trace.sqlite");
        let source = dir.path().join("source.png");
        fs::write(&source, b"source pixels").unwrap();
        let mut connection = connection_at(&db).unwrap();
        let tx = connection.transaction().unwrap();
        tx.execute(
            "INSERT INTO artifacts(path,digest) VALUES (?1,?2)",
            params![source.to_str().unwrap(), digest(&source).unwrap()],
        )
        .unwrap();
        let source_id = tx.last_insert_rowid();
        for position in 0..1024 {
            tx.execute(
                "INSERT INTO runs(operation,parameters) VALUES ('image.crop','{}')",
                [],
            )
            .unwrap();
            let run_id = tx.last_insert_rowid();
            tx.execute(
                "INSERT INTO run_inputs(run_id,artifact_id,position) VALUES (?1,?2,0)",
                params![run_id, source_id],
            )
            .unwrap();
            tx.execute(
                "INSERT INTO artifacts(path,digest,generating_run) VALUES (?1,?2,?3)",
                params![format!("child-{position}.png"), "a".repeat(64), run_id],
            )
            .unwrap();
        }
        tx.commit().unwrap();
        assert!(graph_for_path_at(&db, &source)
            .err()
            .unwrap()
            .to_string()
            .contains("exceeds 1024 artifacts"));
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
