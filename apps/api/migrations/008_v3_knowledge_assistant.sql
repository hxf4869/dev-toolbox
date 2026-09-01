CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE provider_model_reasoning_options (
    model_id uuid NOT NULL REFERENCES provider_models(id) ON DELETE CASCADE,
    reasoning_effort text NOT NULL CHECK (reasoning_effort IN (
        'minimal', 'low', 'medium', 'high', 'xhigh', 'max'
    )),
    display_name text NOT NULL CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 40),
    sort_order smallint NOT NULL CHECK (sort_order BETWEEN 0 AND 100),
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    PRIMARY KEY (model_id, reasoning_effort)
);

CREATE UNIQUE INDEX provider_model_reasoning_options_display_name
    ON provider_model_reasoning_options (model_id, lower(btrim(display_name)));

CREATE TABLE assistant_model_preferences (
    model_id uuid PRIMARY KEY REFERENCES provider_models(id) ON DELETE CASCADE,
    last_reasoning_effort text CHECK (last_reasoning_effort IS NULL OR last_reasoning_effort IN (
        'minimal', 'low', 'medium', 'high', 'xhigh', 'max'
    )),
    last_used_at timestamptz NOT NULL
);

CREATE INDEX assistant_model_preferences_recent_idx
    ON assistant_model_preferences (last_used_at DESC, model_id);

CREATE TABLE assistant_embedding_config (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    base_url text CHECK (base_url IS NULL OR char_length(base_url) BETWEEN 1 AND 2048),
    api_key_ciphertext bytea,
    api_key_tail text CHECK (api_key_tail IS NULL OR char_length(api_key_tail) BETWEEN 1 AND 8),
    model_id text CHECK (model_id IS NULL OR char_length(btrim(model_id)) BETWEEN 1 AND 200),
    display_name text CHECK (display_name IS NULL OR char_length(btrim(display_name)) BETWEEN 1 AND 120),
    dimensions integer CHECK (dimensions IS NULL OR dimensions BETWEEN 1 AND 16000),
    enabled boolean NOT NULL DEFAULT false,
    generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
    status text NOT NULL DEFAULT 'unconfigured' CHECK (status IN (
        'unconfigured', 'indexing', 'ready', 'failed', 'disabled'
    )),
    last_error_code text CHECK (last_error_code IS NULL OR char_length(last_error_code) <= 80),
    updated_at timestamptz NOT NULL
);

CREATE UNIQUE INDEX assistant_embedding_config_singleton ON assistant_embedding_config ((true));

INSERT INTO assistant_embedding_config (singleton, updated_at) VALUES (true, now());

CREATE TABLE assistant_fragment_embeddings (
    fragment_id uuid PRIMARY KEY REFERENCES search_fragments(id) ON DELETE CASCADE,
    source_created_at timestamptz NOT NULL,
    generation bigint NOT NULL CHECK (generation >= 1),
    sensitivity_snapshot text NOT NULL CHECK (sensitivity_snapshot IN ('normal', 'sensitive', 'unknown')),
    policy_snapshot text NOT NULL CHECK (policy_snapshot IN ('block', 'redact', 'allow')),
    state text NOT NULL CHECK (state IN ('pending', 'running', 'ready', 'failed', 'excluded')),
    embedding vector,
    dimensions integer CHECK (dimensions IS NULL OR dimensions BETWEEN 1 AND 16000),
    attempt smallint NOT NULL DEFAULT 0 CHECK (attempt BETWEEN 0 AND 2),
    lease_owner text CHECK (lease_owner IS NULL OR char_length(lease_owner) <= 120),
    lease_version integer CHECK (lease_version IS NULL OR lease_version >= 1),
    lease_expires_at timestamptz,
    heartbeat_at timestamptz,
    error_code text CHECK (error_code IS NULL OR char_length(error_code) <= 80),
    error_detail text CHECK (error_detail IS NULL OR char_length(error_detail) <= 500),
    indexed_at timestamptz,
    updated_at timestamptz NOT NULL,
    CHECK ((state = 'ready') = (embedding IS NOT NULL)),
    CHECK ((state = 'ready') = (dimensions IS NOT NULL))
);

CREATE INDEX assistant_fragment_embeddings_pending_idx
    ON assistant_fragment_embeddings (generation, policy_snapshot, updated_at, fragment_id)
    WHERE state = 'pending';
CREATE INDEX assistant_fragment_embeddings_running_lease_idx
    ON assistant_fragment_embeddings (lease_expires_at)
    WHERE state = 'running';
CREATE INDEX assistant_fragment_embeddings_generation_idx
    ON assistant_fragment_embeddings (generation, state);

CREATE TABLE assistant_folders (
    id uuid PRIMARY KEY,
    name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
);

CREATE UNIQUE INDEX assistant_folders_name_unique ON assistant_folders (lower(btrim(name)));

CREATE TABLE assistant_conversations (
    id uuid PRIMARY KEY,
    folder_id uuid REFERENCES assistant_folders(id) ON DELETE SET NULL,
    title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 120),
    title_origin text NOT NULL CHECK (title_origin IN ('provisional', 'generated', 'user')),
    pinned_at timestamptz,
    archived_at timestamptz,
    selected_model_id uuid REFERENCES provider_models(id) ON DELETE SET NULL,
    selected_reasoning_effort text CHECK (selected_reasoning_effort IS NULL OR selected_reasoning_effort IN (
        'minimal', 'low', 'medium', 'high', 'xhigh', 'max'
    )),
    next_message_sequence bigint NOT NULL DEFAULT 1 CHECK (next_message_sequence >= 1),
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
);

CREATE INDEX assistant_conversations_list_idx
    ON assistant_conversations (pinned_at DESC NULLS LAST, updated_at DESC, id DESC);
CREATE INDEX assistant_conversations_folder_idx
    ON assistant_conversations (folder_id, pinned_at DESC NULLS LAST, updated_at DESC, id DESC);

CREATE TABLE assistant_conversation_summaries (
    conversation_id uuid PRIMARY KEY REFERENCES assistant_conversations(id) ON DELETE CASCADE,
    through_message_sequence bigint NOT NULL CHECK (through_message_sequence >= 0),
    content jsonb NOT NULL CHECK (jsonb_typeof(content) = 'object'),
    model_snapshot jsonb NOT NULL CHECK (jsonb_typeof(model_snapshot) = 'object'),
    updated_at timestamptz NOT NULL
);

CREATE TABLE assistant_messages (
    id uuid PRIMARY KEY,
    conversation_id uuid NOT NULL REFERENCES assistant_conversations(id) ON DELETE CASCADE,
    sequence bigint NOT NULL CHECK (sequence >= 1),
    role text NOT NULL CHECK (role IN ('user', 'assistant')),
    content text NOT NULL CHECK (
        (role = 'user' AND octet_length(content) <= 32768)
        OR (role = 'assistant' AND octet_length(content) <= 4194304)
    ),
    reasoning_content text CHECK (
        reasoning_content IS NULL
        OR (role = 'assistant' AND octet_length(reasoning_content) <= 4194304)
    ),
    status text NOT NULL CHECK (status IN ('complete', 'streaming', 'stopped', 'failed')),
    current_run_id uuid,
    created_at timestamptz NOT NULL,
    completed_at timestamptz,
    UNIQUE (conversation_id, sequence)
);

CREATE INDEX assistant_messages_conversation_idx
    ON assistant_messages (conversation_id, sequence DESC);

CREATE TABLE assistant_runs (
    id uuid PRIMARY KEY,
    conversation_id uuid NOT NULL REFERENCES assistant_conversations(id) ON DELETE CASCADE,
    input_message_id uuid NOT NULL REFERENCES assistant_messages(id) ON DELETE CASCADE,
    output_message_id uuid NOT NULL REFERENCES assistant_messages(id) ON DELETE CASCADE,
    retry_of_run_id uuid REFERENCES assistant_runs(id) ON DELETE SET NULL,
    client_request_id uuid NOT NULL UNIQUE,
    request_snapshot jsonb NOT NULL CHECK (jsonb_typeof(request_snapshot) = 'object'),
    status text NOT NULL DEFAULT 'queued' CHECK (status IN (
        'queued', 'running', 'succeeded', 'failed', 'stopped'
    )),
    phase text CHECK (phase IS NULL OR phase IN (
        'rewrite', 'embedding', 'retrieval', 'answer', 'finalizing'
    )),
    provider_id uuid NOT NULL,
    provider_display_name text NOT NULL,
    model_id uuid NOT NULL REFERENCES provider_models(id) ON DELETE RESTRICT,
    model_display_name text NOT NULL,
    upstream_model_id text NOT NULL,
    protocol text NOT NULL,
    base_url text NOT NULL,
    context_window integer NOT NULL CHECK (context_window > 0),
    max_output_tokens integer NOT NULL CHECK (max_output_tokens > 0),
    reasoning_effort text CHECK (reasoning_effort IS NULL OR reasoning_effort IN (
        'minimal', 'low', 'medium', 'high', 'xhigh', 'max'
    )),
    reasoning_display_name text,
    sensitive_policy text NOT NULL CHECK (sensitive_policy IN ('block', 'redact', 'allow')),
    effective_sensitive_policy text NOT NULL CHECK (effective_sensitive_policy IN ('block', 'redact', 'allow')),
    prompt_version text NOT NULL CHECK (char_length(prompt_version) BETWEEN 1 AND 80),
    retrieval_version text NOT NULL CHECK (char_length(retrieval_version) BETWEEN 1 AND 80),
    knowledge_state text NOT NULL CHECK (knowledge_state IN ('ready', 'unavailable')),
    evidence_state text CHECK (evidence_state IS NULL OR evidence_state IN (
        'matched', 'not_found', 'unavailable'
    )),
    claim_attempt smallint NOT NULL DEFAULT 0 CHECK (claim_attempt BETWEEN 0 AND 2),
    lease_owner text CHECK (lease_owner IS NULL OR char_length(lease_owner) <= 120),
    lease_version integer CHECK (lease_version IS NULL OR lease_version > 0),
    lease_expires_at timestamptz,
    heartbeat_at timestamptz,
    stop_requested_at timestamptz,
    rewrite_input_tokens bigint CHECK (rewrite_input_tokens IS NULL OR rewrite_input_tokens >= 0),
    rewrite_output_tokens bigint CHECK (rewrite_output_tokens IS NULL OR rewrite_output_tokens >= 0),
    answer_input_tokens bigint CHECK (answer_input_tokens IS NULL OR answer_input_tokens >= 0),
    answer_output_tokens bigint CHECK (answer_output_tokens IS NULL OR answer_output_tokens >= 0),
    rewrite_ms integer CHECK (rewrite_ms IS NULL OR rewrite_ms >= 0),
    embedding_ms integer CHECK (embedding_ms IS NULL OR embedding_ms >= 0),
    retrieval_ms integer CHECK (retrieval_ms IS NULL OR retrieval_ms >= 0),
    reasoning_ms integer CHECK (reasoning_ms IS NULL OR reasoning_ms >= 0),
    answer_ms integer CHECK (answer_ms IS NULL OR answer_ms >= 0),
    created_at timestamptz NOT NULL,
    queued_at timestamptz NOT NULL,
    started_at timestamptz,
    finished_at timestamptz,
    error_code text CHECK (error_code IS NULL OR char_length(error_code) <= 80),
    error_detail text CHECK (error_detail IS NULL OR char_length(error_detail) <= 500),
    CHECK (
        (sensitive_policy = 'block' AND effective_sensitive_policy = 'block')
        OR (sensitive_policy = 'redact' AND effective_sensitive_policy IN ('redact', 'block'))
        OR (sensitive_policy = 'allow')
    ),
    CHECK ((reasoning_effort IS NULL) = (reasoning_display_name IS NULL))
);

CREATE UNIQUE INDEX assistant_runs_active_conversation
    ON assistant_runs (conversation_id) WHERE status IN ('queued', 'running');
CREATE INDEX assistant_runs_queue_idx
    ON assistant_runs (queued_at, id) WHERE status = 'queued';
CREATE INDEX assistant_runs_running_lease_idx
    ON assistant_runs (lease_expires_at) WHERE status = 'running';

ALTER TABLE assistant_messages
    ADD CONSTRAINT assistant_messages_current_run_fk
    FOREIGN KEY (current_run_id) REFERENCES assistant_runs(id) ON DELETE SET NULL;

CREATE TABLE assistant_run_sources (
    run_id uuid NOT NULL REFERENCES assistant_runs(id) ON DELETE CASCADE,
    ordinal smallint NOT NULL CHECK (ordinal BETWEEN 1 AND 8),
    fragment_id uuid REFERENCES search_fragments(id) ON DELETE SET NULL,
    item_id uuid REFERENCES knowledge_items(id) ON DELETE SET NULL,
    artifact_id uuid REFERENCES ai_artifacts(id) ON DELETE SET NULL,
    source_kind text NOT NULL CHECK (source_kind IN (
        'title', 'metadata', 'raw_text', 'code', 'ai_text', 'image_text'
    )),
    title_snapshot text NOT NULL,
    excerpt_snapshot text NOT NULL,
    locator_snapshot jsonb NOT NULL CHECK (jsonb_typeof(locator_snapshot) = 'object'),
    retrieval_rank smallint NOT NULL CHECK (retrieval_rank BETWEEN 1 AND 8),
    cited_number smallint CHECK (cited_number IS NULL OR cited_number BETWEEN 1 AND 8),
    created_at timestamptz NOT NULL,
    PRIMARY KEY (run_id, ordinal)
);

CREATE UNIQUE INDEX assistant_run_sources_cited_number
    ON assistant_run_sources (run_id, cited_number) WHERE cited_number IS NOT NULL;
CREATE INDEX assistant_run_sources_item_idx ON assistant_run_sources (item_id) WHERE item_id IS NOT NULL;

CREATE TABLE assistant_run_events (
    run_id uuid NOT NULL REFERENCES assistant_runs(id) ON DELETE CASCADE,
    sequence bigint NOT NULL CHECK (sequence >= 1),
    event_id uuid NOT NULL,
    event_type text NOT NULL CHECK (event_type IN (
        'run.status', 'sources.ready', 'reasoning.delta', 'reasoning.completed',
        'answer.delta', 'answer.citation', 'usage.updated'
    )),
    payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    created_at timestamptz NOT NULL,
    PRIMARY KEY (run_id, sequence),
    UNIQUE (run_id, event_id)
);

---- create above / drop below ----

DROP TABLE IF EXISTS assistant_run_events;
DROP TABLE IF EXISTS assistant_run_sources;
ALTER TABLE assistant_messages DROP CONSTRAINT IF EXISTS assistant_messages_current_run_fk;
DROP TABLE IF EXISTS assistant_runs;
DROP TABLE IF EXISTS assistant_messages;
DROP TABLE IF EXISTS assistant_conversation_summaries;
DROP TABLE IF EXISTS assistant_conversations;
DROP TABLE IF EXISTS assistant_folders;
DROP INDEX IF EXISTS assistant_fragment_embeddings_generation_idx;
DROP INDEX IF EXISTS assistant_fragment_embeddings_running_lease_idx;
DROP INDEX IF EXISTS assistant_fragment_embeddings_pending_idx;
DROP TABLE IF EXISTS assistant_fragment_embeddings;
DROP INDEX IF EXISTS assistant_embedding_config_singleton;
DROP TABLE IF EXISTS assistant_embedding_config;
DROP INDEX IF EXISTS assistant_model_preferences_recent_idx;
DROP TABLE IF EXISTS assistant_model_preferences;
DROP INDEX IF EXISTS provider_model_reasoning_options_display_name;
DROP TABLE IF EXISTS provider_model_reasoning_options;
DROP EXTENSION IF EXISTS vector;
