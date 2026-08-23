CREATE TABLE picture_asset (
    id TEXT PRIMARY KEY NOT NULL,
    file_name TEXT NOT NULL CHECK (length(trim(file_name)) BETWEEN 1 AND 255),
    content_type TEXT NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp', 'image/gif')),
    size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 1 AND 100000000),
    storage_key TEXT NOT NULL UNIQUE CHECK (length(trim(storage_key)) > 0),
    created_at TEXT NOT NULL
);

CREATE TABLE review_picture (
    review_id TEXT NOT NULL,
    picture_id TEXT NOT NULL,
    position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 2),
    PRIMARY KEY (review_id, picture_id),
    UNIQUE (review_id, position),
    FOREIGN KEY (review_id) REFERENCES review(id) ON DELETE CASCADE,
    FOREIGN KEY (picture_id) REFERENCES picture_asset(id) ON DELETE RESTRICT
);

CREATE INDEX idx_review_picture_asset ON review_picture(picture_id);
