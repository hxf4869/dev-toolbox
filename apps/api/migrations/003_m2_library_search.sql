CREATE TABLE folders (
    id uuid PRIMARY KEY,
    parent_id uuid REFERENCES folders(id) ON DELETE RESTRICT,
    name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
    sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    CHECK (parent_id IS NULL OR parent_id <> id)
);

CREATE UNIQUE INDEX folders_root_name_unique
    ON folders (lower(name)) WHERE parent_id IS NULL;
CREATE UNIQUE INDEX folders_child_name_unique
    ON folders (parent_id, lower(name)) WHERE parent_id IS NOT NULL;
CREATE INDEX folders_parent_order_idx ON folders (parent_id, sort_order, lower(name), id);

ALTER TABLE knowledge_items
    ADD COLUMN folder_id uuid REFERENCES folders(id) ON DELETE RESTRICT;

CREATE INDEX knowledge_items_folder_active_idx
    ON knowledge_items (folder_id, updated_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX knowledge_items_recent_active_idx
    ON knowledge_items (updated_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX knowledge_items_trash_idx
    ON knowledge_items (deleted_at DESC, id DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX knowledge_items_favorite_idx
    ON knowledge_items (updated_at DESC, id DESC) WHERE deleted_at IS NULL AND favorite;
CREATE INDEX knowledge_items_sensitivity_idx
    ON knowledge_items (sensitivity, updated_at DESC, id DESC) WHERE deleted_at IS NULL;

CREATE TABLE tags (
    id uuid PRIMARY KEY,
    name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 40),
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
);

CREATE UNIQUE INDEX tags_name_unique ON tags (lower(name));

CREATE TABLE item_tags (
    item_id uuid NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
    tag_id uuid NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL,
    PRIMARY KEY (item_id, tag_id)
);

CREATE INDEX item_tags_tag_item_idx ON item_tags (tag_id, item_id);

CREATE TABLE raw_record_relations (
    from_record_id uuid NOT NULL REFERENCES raw_records(id) ON DELETE CASCADE,
    to_record_id uuid NOT NULL REFERENCES raw_records(id) ON DELETE CASCADE,
    relation_type text NOT NULL CHECK (relation_type IN ('supplements', 'supersedes', 'migration_duplicate')),
    origin text NOT NULL CHECK (origin IN ('user', 'migration', 'ai_suggestion')),
    confirmed boolean NOT NULL,
    created_at timestamptz NOT NULL,
    PRIMARY KEY (from_record_id, to_record_id, relation_type),
    CHECK (from_record_id <> to_record_id)
);

CREATE INDEX raw_record_relations_target_idx
    ON raw_record_relations (to_record_id, created_at, from_record_id);

CREATE TABLE attachment_derivatives (
    id uuid PRIMARY KEY,
    attachment_id uuid NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind = 'thumbnail'),
    storage_key text NOT NULL UNIQUE,
    media_type text NOT NULL CHECK (char_length(media_type) BETWEEN 1 AND 255),
    size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
    created_at timestamptz NOT NULL,
    UNIQUE (attachment_id, kind)
);

---- create above / drop below ----

DROP TABLE IF EXISTS attachment_derivatives;
DROP TABLE IF EXISTS raw_record_relations;
DROP TABLE IF EXISTS item_tags;
DROP TABLE IF EXISTS tags;
DROP INDEX IF EXISTS knowledge_items_sensitivity_idx;
DROP INDEX IF EXISTS knowledge_items_favorite_idx;
DROP INDEX IF EXISTS knowledge_items_trash_idx;
DROP INDEX IF EXISTS knowledge_items_recent_active_idx;
DROP INDEX IF EXISTS knowledge_items_folder_active_idx;
ALTER TABLE knowledge_items DROP COLUMN IF EXISTS folder_id;
DROP TABLE IF EXISTS folders;
