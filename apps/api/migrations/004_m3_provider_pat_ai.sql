CREATE TABLE personal_access_tokens (
    id uuid PRIMARY KEY,
    name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
    token_prefix text NOT NULL CHECK (char_length(token_prefix) BETWEEN 8 AND 32),
    token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
    scopes text[] NOT NULL CHECK (
        scopes <@ ARRAY[
            'records:read', 'records:write', 'attachments:read',
            'artifacts:write', 'tasks:run', 'sensitive:read'
        ]::text[]
        AND array_position(scopes, NULL) IS NULL
    ),
    created_at timestamptz NOT NULL,
    last_used_at timestamptz,
    expires_at timestamptz,
    revoked_at timestamptz
);

CREATE INDEX personal_access_tokens_active_idx
    ON personal_access_tokens (created_at DESC, id DESC) WHERE revoked_at IS NULL;

CREATE TABLE provider_configs (
    id uuid PRIMARY KEY,
    provider_key text NOT NULL UNIQUE CHECK (
        char_length(provider_key) BETWEEN 1 AND 64
        AND provider_key = lower(provider_key)
        AND provider_key ~ '^[a-z0-9][a-z0-9_-]*$'
    ),
    display_name text NOT NULL CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 120),
    protocol text NOT NULL CHECK (protocol IN (
        'openai-completions', 'openai-responses', 'anthropic-messages'
    )),
    base_url text NOT NULL CHECK (char_length(base_url) BETWEEN 1 AND 2048),
    api_key_ciphertext bytea,
    api_key_tail text CHECK (api_key_tail IS NULL OR char_length(api_key_tail) BETWEEN 1 AND 8),
    enabled boolean NOT NULL DEFAULT true,
    deleted_at timestamptz,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    CHECK (deleted_at IS NULL OR (enabled = false AND api_key_ciphertext IS NULL AND api_key_tail IS NULL))
);

CREATE TABLE provider_models (
    id uuid PRIMARY KEY,
    provider_config_id uuid NOT NULL REFERENCES provider_configs(id) ON DELETE RESTRICT,
    model_id text NOT NULL CHECK (char_length(btrim(model_id)) BETWEEN 1 AND 200),
    display_name text NOT NULL CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 120),
    context_window integer CHECK (context_window IS NULL OR context_window > 0),
    max_output_tokens integer CHECK (max_output_tokens IS NULL OR max_output_tokens > 0),
    supports_tools boolean NOT NULL DEFAULT false,
    supports_vision boolean NOT NULL DEFAULT false,
    enabled boolean NOT NULL DEFAULT true,
    deleted_at timestamptz,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    UNIQUE (provider_config_id, model_id),
    CHECK (max_output_tokens IS NULL OR context_window IS NULL OR max_output_tokens < context_window),
    CHECK (deleted_at IS NULL OR enabled = false)
);

CREATE INDEX provider_models_provider_active_idx
    ON provider_models (provider_config_id, display_name, id) WHERE deleted_at IS NULL;

CREATE TABLE app_settings (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    theme_default text NOT NULL DEFAULT 'dark' CHECK (theme_default IN ('dark', 'light', 'system')),
    sensitive_display_mode text NOT NULL DEFAULT 'masked' CHECK (sensitive_display_mode = 'masked'),
    sensitive_ai_policy text NOT NULL DEFAULT 'redact' CHECK (sensitive_ai_policy IN ('block', 'redact', 'allow')),
    scheduled_organize text NOT NULL DEFAULT 'off' CHECK (scheduled_organize IN ('off', 'daily', 'weekly')),
    schedule_timezone text NOT NULL DEFAULT 'Asia/Shanghai' CHECK (char_length(schedule_timezone) BETWEEN 1 AND 120),
    schedule_local_time time NOT NULL DEFAULT '03:00',
    schedule_weekday smallint NOT NULL DEFAULT 1 CHECK (schedule_weekday BETWEEN 1 AND 7),
    default_organize_model_id uuid REFERENCES provider_models(id) ON DELETE SET NULL,
    default_review_model_id uuid REFERENCES provider_models(id) ON DELETE SET NULL,
    default_vision_model_id uuid REFERENCES provider_models(id) ON DELETE SET NULL,
    updated_at timestamptz NOT NULL
);

INSERT INTO app_settings (singleton, updated_at) VALUES (true, now());

CREATE TABLE ai_task_runs (
    id uuid PRIMARY KEY,
    task_type text NOT NULL CHECK (task_type IN (
        'organize_record', 'review_record', 'analyze_image', 'batch_organize'
    )),
    item_id uuid REFERENCES knowledge_items(id) ON DELETE CASCADE,
    parent_task_id uuid REFERENCES ai_task_runs(id) ON DELETE CASCADE,
    trigger_type text NOT NULL CHECK (trigger_type IN ('manual', 'scheduled', 'external')),
    schedule_key text,
    model_id uuid REFERENCES provider_models(id) ON DELETE RESTRICT,
    status text NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
    sensitive_policy text NOT NULL CHECK (sensitive_policy IN ('block', 'redact', 'allow')),
    prompt_version text NOT NULL CHECK (char_length(prompt_version) BETWEEN 1 AND 80),
    schema_version text NOT NULL CHECK (char_length(schema_version) BETWEEN 1 AND 20),
    input_snapshot jsonb NOT NULL CHECK (jsonb_typeof(input_snapshot) = 'object'),
    retry_of_task_id uuid REFERENCES ai_task_runs(id) ON DELETE SET NULL,
    claim_attempt smallint NOT NULL DEFAULT 0 CHECK (claim_attempt BETWEEN 0 AND 2),
    lease_owner text CHECK (lease_owner IS NULL OR char_length(lease_owner) <= 120),
    lease_expires_at timestamptz,
    heartbeat_at timestamptz,
    queued_at timestamptz NOT NULL,
    started_at timestamptz,
    finished_at timestamptz,
    cancel_requested_at timestamptz,
    error_code text CHECK (error_code IS NULL OR char_length(error_code) <= 80),
    error_detail text CHECK (error_detail IS NULL OR char_length(error_detail) <= 500),
    batch_summary jsonb CHECK (batch_summary IS NULL OR jsonb_typeof(batch_summary) = 'object'),
    input_tokens bigint CHECK (input_tokens IS NULL OR input_tokens >= 0),
    output_tokens bigint CHECK (output_tokens IS NULL OR output_tokens >= 0),
    CHECK ((task_type = 'batch_organize') = (item_id IS NULL)),
    CHECK (parent_task_id IS NULL OR task_type <> 'batch_organize'),
    CHECK (trigger_type = 'external' OR task_type = 'batch_organize' OR model_id IS NOT NULL)
);

CREATE UNIQUE INDEX ai_task_runs_active_item_type
    ON ai_task_runs (item_id, task_type) WHERE status IN ('queued', 'running');
CREATE UNIQUE INDEX ai_task_runs_schedule_key
    ON ai_task_runs (schedule_key) WHERE schedule_key IS NOT NULL AND trigger_type = 'scheduled';
CREATE INDEX ai_task_runs_queue_idx
    ON ai_task_runs (queued_at, id) WHERE status = 'queued' AND task_type <> 'batch_organize';
CREATE INDEX ai_task_runs_item_idx ON ai_task_runs (item_id, queued_at DESC, id DESC);

CREATE TABLE ai_task_events (
    id bigserial PRIMARY KEY,
    task_id uuid NOT NULL REFERENCES ai_task_runs(id) ON DELETE CASCADE,
    event_type text NOT NULL CHECK (char_length(event_type) BETWEEN 1 AND 80),
    summary text CHECK (summary IS NULL OR char_length(summary) <= 500),
    details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
    created_at timestamptz NOT NULL
);

CREATE INDEX ai_task_events_task_idx ON ai_task_events (task_id, id);
CREATE INDEX ai_task_events_retention_idx ON ai_task_events (created_at);

CREATE TABLE ai_artifacts (
    id uuid PRIMARY KEY,
    item_id uuid NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
    task_run_id uuid NOT NULL UNIQUE REFERENCES ai_task_runs(id) ON DELETE CASCADE,
    artifact_type text NOT NULL CHECK (artifact_type IN (
        'organized_record', 'correctness_review', 'image_analysis'
    )),
    version_number integer NOT NULL CHECK (version_number > 0),
    schema_version text NOT NULL CHECK (char_length(schema_version) BETWEEN 1 AND 20),
    content jsonb NOT NULL CHECK (jsonb_typeof(content) = 'object'),
    generator text NOT NULL CHECK (generator IN ('builtin_worker', 'external_agent', 'migration')),
    model_name text CHECK (model_name IS NULL OR char_length(model_name) <= 200),
    prompt_version text CHECK (prompt_version IS NULL OR char_length(prompt_version) <= 80),
    created_at timestamptz NOT NULL,
    invalidated_at timestamptz,
    UNIQUE (item_id, artifact_type, version_number)
);

CREATE INDEX ai_artifacts_item_type_idx
    ON ai_artifacts (item_id, artifact_type, version_number DESC);

CREATE TABLE item_active_artifacts (
    item_id uuid NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
    artifact_type text NOT NULL CHECK (artifact_type IN (
        'organized_record', 'correctness_review', 'image_analysis'
    )),
    artifact_id uuid NOT NULL UNIQUE REFERENCES ai_artifacts(id) ON DELETE CASCADE,
    activated_at timestamptz NOT NULL,
    PRIMARY KEY (item_id, artifact_type)
);

CREATE TABLE artifact_sources (
    artifact_id uuid NOT NULL REFERENCES ai_artifacts(id) ON DELETE CASCADE,
    raw_record_id uuid NOT NULL REFERENCES raw_records(id) ON DELETE CASCADE,
    fragment_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
    PRIMARY KEY (artifact_id, raw_record_id)
);

ALTER TABLE search_fragments
    ADD COLUMN artifact_id uuid REFERENCES ai_artifacts(id) ON DELETE CASCADE;

ALTER TABLE search_fragments
    ADD CONSTRAINT search_fragments_single_content_source
    CHECK (NOT (raw_record_id IS NOT NULL AND artifact_id IS NOT NULL));

CREATE UNIQUE INDEX search_fragments_artifact_ordinal
    ON search_fragments (artifact_id, ordinal) WHERE artifact_id IS NOT NULL;

---- create above / drop below ----

DROP INDEX IF EXISTS search_fragments_artifact_ordinal;
ALTER TABLE search_fragments DROP CONSTRAINT IF EXISTS search_fragments_single_content_source;
ALTER TABLE search_fragments DROP COLUMN IF EXISTS artifact_id;
DROP TABLE IF EXISTS artifact_sources;
DROP TABLE IF EXISTS item_active_artifacts;
DROP TABLE IF EXISTS ai_artifacts;
DROP TABLE IF EXISTS ai_task_events;
DROP TABLE IF EXISTS ai_task_runs;
DROP TABLE IF EXISTS app_settings;
DROP TABLE IF EXISTS provider_models;
DROP TABLE IF EXISTS provider_configs;
DROP TABLE IF EXISTS personal_access_tokens;
