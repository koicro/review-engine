ALTER TABLE template_version ADD COLUMN properties_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE review ADD COLUMN properties_json TEXT NOT NULL DEFAULT '{}';
