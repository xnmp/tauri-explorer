CREATE TABLE IF NOT EXISTS recovery_meta (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    revision INTEGER NOT NULL CHECK (revision >= 0)
);
INSERT OR IGNORE INTO recovery_meta(singleton, revision) VALUES(1, 0);
CREATE TABLE IF NOT EXISTS recovery_records (
    id TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('operation', 'reservation')),
    generation INTEGER NOT NULL CHECK (generation > 0),
    payload BLOB NOT NULL CHECK (length(payload) <= 33554432)
);
CREATE INDEX IF NOT EXISTS recovery_records_kind ON recovery_records(kind);
PRAGMA user_version = 1;
