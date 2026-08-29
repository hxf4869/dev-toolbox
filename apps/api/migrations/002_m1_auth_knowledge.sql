CREATE TABLE owner_account (
    id uuid PRIMARY KEY,
    username text NOT NULL UNIQUE CHECK (char_length(username) BETWEEN 1 AND 120),
    password_hash text NOT NULL,
    totp_secret_ciphertext bytea,
    totp_enabled_at timestamptz,
    password_changed_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    CHECK ((totp_secret_ciphertext IS NULL) = (totp_enabled_at IS NULL))
);

CREATE UNIQUE INDEX owner_account_singleton ON owner_account ((true));

CREATE TABLE auth_challenges (
    id uuid PRIMARY KEY,
    owner_account_id uuid NOT NULL REFERENCES owner_account(id) ON DELETE CASCADE,
    mode text NOT NULL CHECK (mode IN ('mfa_verify', 'totp_enroll')),
    pending_totp_secret_ciphertext bytea,
    failed_attempts smallint NOT NULL DEFAULT 0 CHECK (failed_attempts BETWEEN 0 AND 5),
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    created_at timestamptz NOT NULL
);

CREATE INDEX auth_challenges_owner_active_idx
    ON auth_challenges (owner_account_id, expires_at DESC)
    WHERE consumed_at IS NULL;

CREATE TABLE mfa_recovery_codes (
    id uuid PRIMARY KEY,
    code_hash text NOT NULL UNIQUE,
    used_at timestamptz,
    created_at timestamptz NOT NULL
);

CREATE TABLE trusted_devices (
    id uuid PRIMARY KEY,
    token_hash bytea NOT NULL UNIQUE,
    display_name text NOT NULL CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 120),
    created_at timestamptz NOT NULL,
    last_used_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz
);

CREATE TABLE auth_sessions (
    id uuid PRIMARY KEY,
    token_hash bytea NOT NULL UNIQUE,
    csrf_token_hash bytea NOT NULL,
    trusted_device_id uuid REFERENCES trusted_devices(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL,
    last_seen_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    client_ip inet,
    user_agent text CHECK (user_agent IS NULL OR char_length(user_agent) <= 512)
);

CREATE INDEX auth_sessions_active_idx ON auth_sessions (expires_at DESC) WHERE revoked_at IS NULL;

CREATE TABLE security_events (
    id uuid PRIMARY KEY,
    event_type text NOT NULL CHECK (char_length(event_type) BETWEEN 1 AND 80),
    client_ip inet,
    user_agent text CHECK (user_agent IS NULL OR char_length(user_agent) <= 512),
    details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
    created_at timestamptz NOT NULL
);

CREATE INDEX security_events_created_idx ON security_events (created_at DESC);

CREATE TABLE knowledge_items (
    id uuid PRIMARY KEY,
    title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
    title_origin text NOT NULL CHECK (title_origin IN ('generated', 'user', 'ai_applied')),
    note text CHECK (note IS NULL OR char_length(note) <= 2000),
    sensitivity text NOT NULL CHECK (sensitivity IN ('normal', 'sensitive', 'unknown')),
    favorite boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    deleted_at timestamptz
);

CREATE TABLE raw_records (
    id uuid PRIMARY KEY,
    item_id uuid NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
    record_role text NOT NULL CHECK (record_role IN ('primary', 'supplement', 'migration_copy')),
    source_type text NOT NULL CHECK (source_type IN ('web_capture', 'browser_extension', 'api', 'notion_migration', 'wecom_migration', 'system')),
    content_kind text NOT NULL CHECK (content_kind IN ('text', 'image', 'file', 'mixed')),
    content_format text NOT NULL CHECK (content_format IN ('plain_text', 'markdown')),
    body text NOT NULL CHECK (octet_length(body) <= 1048576),
    declared_sensitivity text NOT NULL CHECK (declared_sensitivity IN ('normal', 'sensitive', 'unknown')),
    captured_at timestamptz NOT NULL,
    effective_captured_at timestamptz NOT NULL,
    source_external_id text CHECK (source_external_id IS NULL OR char_length(source_external_id) <= 500),
    source_path text CHECK (source_path IS NULL OR char_length(source_path) <= 2048),
    source_created_at timestamptz,
    source_updated_at timestamptz,
    source_time_quality text NOT NULL CHECK (source_time_quality IN ('exact', 'estimated', 'unknown')),
    source_metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(source_metadata) = 'object'),
    created_at timestamptz NOT NULL,
    CHECK (content_kind IN ('image', 'file', 'mixed') OR char_length(btrim(body)) > 0)
);

CREATE UNIQUE INDEX raw_records_one_primary_per_item
    ON raw_records (item_id) WHERE record_role = 'primary';
CREATE UNIQUE INDEX raw_records_source_external_id
    ON raw_records (source_type, source_external_id) WHERE source_external_id IS NOT NULL;
CREATE INDEX raw_records_item_effective_idx ON raw_records (item_id, effective_captured_at DESC, id DESC);

CREATE TABLE attachments (
    id uuid PRIMARY KEY,
    raw_record_id uuid NOT NULL REFERENCES raw_records(id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('image', 'file')),
    original_name text NOT NULL CHECK (char_length(original_name) BETWEEN 1 AND 1024),
    display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 255),
    storage_key text NOT NULL UNIQUE,
    client_media_type text CHECK (client_media_type IS NULL OR char_length(client_media_type) <= 255),
    media_type text NOT NULL CHECK (char_length(media_type) BETWEEN 1 AND 255),
    content_sha256 bytea NOT NULL CHECK (octet_length(content_sha256) = 32),
    size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 0 AND 20971520),
    width integer CHECK (width IS NULL OR width > 0),
    height integer CHECK (height IS NULL OR height > 0),
    status text NOT NULL CHECK (status IN ('ready', 'missing', 'pending_delete')),
    created_at timestamptz NOT NULL
);

CREATE INDEX attachments_record_idx ON attachments (raw_record_id, created_at, id);

CREATE TABLE search_fragments (
    id uuid PRIMARY KEY,
    item_id uuid NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
    raw_record_id uuid REFERENCES raw_records(id) ON DELETE CASCADE,
    source_kind text NOT NULL CHECK (source_kind IN ('title', 'metadata', 'raw_text', 'code', 'filename', 'ai_text', 'image_text')),
    ordinal integer NOT NULL CHECK (ordinal >= 0),
    fragment_version smallint,
    start_byte integer,
    end_byte integer,
    content text NOT NULL,
    normalized_content text NOT NULL,
    search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, normalized_content)) STORED,
    weight smallint NOT NULL CHECK (weight BETWEEN 1 AND 4),
    active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL,
    CHECK ((source_kind IN ('raw_text', 'code')) = (raw_record_id IS NOT NULL)),
    CHECK ((raw_record_id IS NULL AND fragment_version IS NULL AND start_byte IS NULL AND end_byte IS NULL)
        OR (raw_record_id IS NOT NULL AND fragment_version IS NOT NULL AND start_byte IS NOT NULL AND end_byte IS NOT NULL
            AND start_byte >= 0 AND end_byte >= start_byte))
);

CREATE UNIQUE INDEX search_fragments_raw_version_ordinal
    ON search_fragments (raw_record_id, fragment_version, ordinal) WHERE raw_record_id IS NOT NULL;
CREATE INDEX search_fragments_item_active_idx ON search_fragments (item_id, active);
CREATE INDEX search_fragments_trgm_idx ON search_fragments USING gin (normalized_content gin_trgm_ops);
CREATE INDEX search_fragments_vector_idx ON search_fragments USING gin (search_vector);

CREATE TABLE idempotency_records (
    actor_type text NOT NULL CHECK (actor_type IN ('session', 'pat')),
    actor_id uuid NOT NULL,
    route_key text NOT NULL CHECK (char_length(route_key) BETWEEN 1 AND 120),
    idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
    created_item_id uuid NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
    created_raw_record_id uuid REFERENCES raw_records(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    PRIMARY KEY (actor_type, actor_id, route_key, idempotency_key)
);

---- create above / drop below ----

DROP TABLE IF EXISTS idempotency_records;
DROP TABLE IF EXISTS search_fragments;
DROP TABLE IF EXISTS attachments;
DROP TABLE IF EXISTS raw_records;
DROP TABLE IF EXISTS knowledge_items;
DROP TABLE IF EXISTS security_events;
DROP TABLE IF EXISTS auth_sessions;
DROP TABLE IF EXISTS trusted_devices;
DROP TABLE IF EXISTS mfa_recovery_codes;
DROP TABLE IF EXISTS auth_challenges;
DROP INDEX IF EXISTS owner_account_singleton;
DROP TABLE IF EXISTS owner_account;
