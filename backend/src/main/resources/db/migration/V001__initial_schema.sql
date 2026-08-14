CREATE TABLE IF NOT EXISTS category (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    description TEXT,
    active_template_version_id TEXT,
    archived_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    lock_version INTEGER NOT NULL DEFAULT 0 CHECK (lock_version >= 0),
    FOREIGN KEY (active_template_version_id) REFERENCES template_version(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS criterion (
    id TEXT PRIMARY KEY NOT NULL,
    category_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (category_id) REFERENCES category(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS template_version (
    id TEXT PRIMARY KEY NOT NULL,
    category_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0),
    status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'retired')),
    published_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    lock_version INTEGER NOT NULL DEFAULT 0 CHECK (lock_version >= 0),
    CHECK ((status = 'draft' AND published_at IS NULL) OR (status IN ('published', 'retired') AND published_at IS NOT NULL)),
    UNIQUE (category_id, version),
    FOREIGN KEY (category_id) REFERENCES category(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS template_criterion (
    template_version_id TEXT NOT NULL,
    criterion_id TEXT NOT NULL,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    description TEXT,
    min_value TEXT NOT NULL CHECK (length(trim(min_value)) > 0),
    max_value TEXT NOT NULL CHECK (length(trim(max_value)) > 0),
    step_value TEXT NOT NULL CHECK (length(trim(step_value)) > 0),
    position INTEGER NOT NULL CHECK (position >= 0),
    required INTEGER NOT NULL CHECK (required IN (0, 1)),
    PRIMARY KEY (template_version_id, criterion_id),
    UNIQUE (template_version_id, position),
    FOREIGN KEY (template_version_id) REFERENCES template_version(id) ON DELETE CASCADE,
    FOREIGN KEY (criterion_id) REFERENCES criterion(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS entity (
    id TEXT PRIMARY KEY NOT NULL,
    category_id TEXT NOT NULL,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    description TEXT,
    archived_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    lock_version INTEGER NOT NULL DEFAULT 0 CHECK (lock_version >= 0),
    FOREIGN KEY (category_id) REFERENCES category(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS reviewer (
    id TEXT PRIMARY KEY NOT NULL,
    display_name TEXT NOT NULL CHECK (length(trim(display_name)) > 0),
    archived_at TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS review (
    id TEXT PRIMARY KEY NOT NULL,
    entity_id TEXT NOT NULL,
    reviewer_id TEXT NOT NULL,
    template_version_id TEXT NOT NULL,
    reviewed_at TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('draft', 'final', 'superseded')),
    supersedes_review_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    lock_version INTEGER NOT NULL DEFAULT 0 CHECK (lock_version >= 0),
    CHECK (supersedes_review_id IS NULL OR supersedes_review_id <> id),
    FOREIGN KEY (entity_id) REFERENCES entity(id) ON DELETE RESTRICT,
    FOREIGN KEY (reviewer_id) REFERENCES reviewer(id) ON DELETE RESTRICT,
    FOREIGN KEY (template_version_id) REFERENCES template_version(id) ON DELETE RESTRICT,
    FOREIGN KEY (supersedes_review_id) REFERENCES review(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_review_supersedes
    ON review(supersedes_review_id) WHERE supersedes_review_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS score (
    review_id TEXT NOT NULL,
    criterion_id TEXT NOT NULL,
    tick_index INTEGER NOT NULL CHECK (tick_index >= 0),
    PRIMARY KEY (review_id, criterion_id),
    FOREIGN KEY (review_id) REFERENCES review(id) ON DELETE CASCADE,
    FOREIGN KEY (criterion_id) REFERENCES criterion(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS relation_type (
    id TEXT PRIMARY KEY NOT NULL,
    key TEXT NOT NULL UNIQUE CHECK (length(trim(key)) > 0),
    forward_label TEXT NOT NULL CHECK (length(trim(forward_label)) > 0),
    inverse_label TEXT NOT NULL CHECK (length(trim(inverse_label)) > 0),
    hierarchical INTEGER NOT NULL CHECK (hierarchical IN (0, 1)),
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS entity_relation (
    id TEXT PRIMARY KEY NOT NULL,
    source_entity_id TEXT NOT NULL,
    target_entity_id TEXT NOT NULL,
    relation_type_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (source_entity_id, target_entity_id, relation_type_id),
    FOREIGN KEY (source_entity_id) REFERENCES entity(id) ON DELETE RESTRICT,
    FOREIGN KEY (target_entity_id) REFERENCES entity(id) ON DELETE RESTRICT,
    FOREIGN KEY (relation_type_id) REFERENCES relation_type(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS access_token (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    token_hash TEXT NOT NULL UNIQUE CHECK (length(trim(token_hash)) > 0),
    created_at TEXT NOT NULL,
    revoked_at TEXT
);

-- Browser sessions are operational authorization state and are intentionally excluded from portable exports.
-- Both hashes are SHA-256 hex strings; the raw cookie value is never stored.
CREATE TABLE IF NOT EXISTS web_session (
    session_hash TEXT PRIMARY KEY NOT NULL CHECK (length(session_hash) = 64),
    identity_kind TEXT NOT NULL CHECK (identity_kind IN ('admin', 'access_token')),
    credential_hash TEXT NOT NULL CHECK (length(credential_hash) = 64),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    revoked_at TEXT,
    CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS idx_criterion_category ON criterion(category_id);
CREATE INDEX IF NOT EXISTS idx_template_version_category_status ON template_version(category_id, status, version DESC);
CREATE INDEX IF NOT EXISTS idx_entity_category_active_name ON entity(category_id, archived_at, name, id);
CREATE INDEX IF NOT EXISTS idx_review_entity_reviewed ON review(entity_id, reviewed_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_review_status_reviewed ON review(status, reviewed_at DESC);
CREATE INDEX IF NOT EXISTS idx_review_template_version ON review(template_version_id);
CREATE INDEX IF NOT EXISTS idx_review_reviewer_reviewed ON review(reviewer_id, reviewed_at DESC);
CREATE INDEX IF NOT EXISTS idx_entity_relation_source_type ON entity_relation(source_entity_id, relation_type_id);
CREATE INDEX IF NOT EXISTS idx_entity_relation_target_type ON entity_relation(target_entity_id, relation_type_id);
CREATE INDEX IF NOT EXISTS idx_web_session_expiry ON web_session(expires_at);
CREATE INDEX IF NOT EXISTS idx_web_session_credential ON web_session(identity_kind, credential_hash);

INSERT OR IGNORE INTO reviewer (id, display_name, archived_at, created_at)
VALUES ('00000000-0000-0000-0000-000000000001', 'Default reviewer', NULL, '1970-01-01T00:00:00.000000000Z');
