ALTER TABLE review ADD COLUMN hidden_at TEXT;

CREATE INDEX idx_review_entity_visibility_reviewed
    ON review(entity_id, hidden_at, reviewed_at DESC, id DESC);

CREATE INDEX idx_review_status_visibility_reviewed
    ON review(status, hidden_at, reviewed_at DESC);
