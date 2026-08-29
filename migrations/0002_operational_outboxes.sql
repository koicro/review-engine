-- Operational coordination state for cross-service R2 cleanup and atomic imports.

CREATE TABLE IF NOT EXISTS r2_deletion (
    storage_key TEXT PRIMARY KEY NOT NULL,
    requested_at TEXT NOT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    last_attempt_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_r2_deletion_requested
    ON r2_deletion(requested_at, storage_key);

CREATE TABLE IF NOT EXISTS import_lock (
    id TEXT PRIMARY KEY NOT NULL,
    created_at TEXT NOT NULL
);
