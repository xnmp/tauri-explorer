//! One SQLite transaction owns read-modify-write across independent app processes.
use super::model::{Document, Mutation, Seed, Snapshot};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior};
use std::{path::Path, time::Duration};
pub fn access(
    path: &Path,
    seed: Option<Seed>,
    mutation: Option<Mutation>,
) -> Result<Snapshot, String> {
    let mut connection = Connection::open(path).map_err(|error| error.to_string())?;
    connection
        .busy_timeout(Duration::from_secs(2))
        .map_err(|error| error.to_string())?;
    connection.execute_batch("CREATE TABLE IF NOT EXISTS shared_history (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL)").map_err(|error|error.to_string())?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let payload: Option<String> = transaction
        .query_row("SELECT payload FROM shared_history WHERE id=1", [], |row| {
            row.get(0)
        })
        .optional()
        .map_err(|error| error.to_string())?;
    let mut document = match payload {
        Some(payload) => {
            serde_json::from_str::<Document>(&payload).map_err(|error| error.to_string())?
        }
        None => Document::from_seed(seed.unwrap_or_default()),
    };
    if let Some(mutation) = mutation {
        document.apply(mutation).map_err(str::to_owned)?;
    }
    let snapshot = document.snapshot();
    let payload = serde_json::to_string(&document).map_err(|error| error.to_string())?;
    transaction.execute("INSERT INTO shared_history(id,payload) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",[payload]).map_err(|error|error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(snapshot)
}
