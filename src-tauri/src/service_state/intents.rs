//! Immutable semantic intent excludes incidental handles and preparation tokens.
use super::{
    model::*,
    rules::*,
    store::{sql, Store},
};
use rusqlite::{params, Connection, OptionalExtension};
pub(super) const INTENT_SCHEMA: i64 = 0x5445_4932;
pub(super) const INTENT_TABLE: &str = "CREATE TABLE operation_intents(consumer TEXT NOT NULL,operation TEXT NOT NULL,semantic_digest TEXT NOT NULL,PRIMARY KEY(consumer,operation)); PRAGMA application_id=1413826866;";
pub(super) fn same_input_content(a: &[ArtifactDescriptor], b: &[ArtifactDescriptor]) -> bool {
    a.len() == b.len()
        && a.iter().zip(b).all(|(a, b)| {
            a.sha256 == b.sha256 && a.byte_length == b.byte_length && a.media_type == b.media_type
        })
}
fn stored(conn: &Connection, a: &Admission) -> Result<Option<String>> {
    let value: Option<String> = conn
        .query_row(
            "SELECT semantic_digest FROM operation_intents WHERE consumer=?1 AND operation=?2",
            params![a.consumer.package_id, a.operation_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(sql)?;
    if value.as_ref().is_some_and(|value| !digest(value)) {
        return Err(reject("durable semantic intent digest is malformed"));
    }
    Ok(value)
}
pub(super) fn attach_or_match(conn: &Connection, a: &Admission, semantic: &str) -> Result<()> {
    if !digest(semantic) {
        return Err(reject("invalid semantic intent digest"));
    }
    if let Some(old) = stored(conn, a)? {
        if old != semantic {
            return Err(reject(
                "operation ID conflicts with its original semantic request",
            ));
        }
        return Ok(());
    }
    if a.phase != AdmissionPhase::Reserved {
        return Err(crate::error::AppError::MutationUncertain(
            "Existing operation has no semantic request evidence; query its original status before repeating work".into(),
        ));
    }
    conn.execute(
        "INSERT INTO operation_intents(consumer,operation,semantic_digest)VALUES(?1,?2,?3)",
        params![a.consumer.package_id, a.operation_id, semantic],
    )
    .map_err(sql)?;
    Ok(())
}
impl Store {
    pub fn reserve_intent(&self, admission: Admission, semantic_digest: &str) -> Result<Admission> {
        self.reserve_with_intent(admission, Some(semantic_digest))
    }
    pub(super) fn validate_intents(&self) -> Result<()> {
        let conn = self.connect()?;
        let mut query = conn
            .prepare("SELECT consumer,operation FROM operation_intents")
            .map_err(sql)?;
        let rows = query
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(sql)?;
        for row in rows {
            let (consumer, op) = row.map_err(sql)?;
            let a = Self::record(&conn, &consumer, &op)?
                .ok_or_else(|| reject("durable semantic intent has no admission"))?;
            stored(&conn, &a)?.ok_or_else(|| reject("durable semantic intent disappeared"))?;
        }
        Ok(())
    }
}
