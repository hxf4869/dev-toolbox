CREATE TABLE aliyun_service_settings (
    id smallint PRIMARY KEY CHECK (id = 1),
    access_key_id_ciphertext bytea,
    access_key_secret_ciphertext bytea,
    access_key_id_tail text,
    professional_scene text CHECK (
        professional_scene IS NULL
        OR professional_scene IN ('title', 'description', 'communication', 'medical', 'social', 'finance')
    ),
    auto_use_professional boolean NOT NULL DEFAULT true,
    general_monthly_limit integer NOT NULL DEFAULT 950000
        CHECK (general_monthly_limit BETWEEN 1 AND 1000000),
    professional_monthly_limit integer NOT NULL DEFAULT 950000
        CHECK (professional_monthly_limit BETWEEN 1 AND 1000000),
    ocr_monthly_limit integer NOT NULL DEFAULT 190 CHECK (ocr_monthly_limit BETWEEN 1 AND 200),
    owner_concurrency smallint NOT NULL DEFAULT 1 CHECK (owner_concurrency BETWEEN 1 AND 3),
    global_concurrency smallint NOT NULL DEFAULT 3 CHECK (global_concurrency BETWEEN 1 AND 10),
    credential_version bigint NOT NULL DEFAULT 0,
    last_success_at timestamptz,
    last_failure_at timestamptz,
    last_failure_category text CHECK (
        last_failure_category IS NULL
        OR last_failure_category IN (
            'credential_invalid', 'permission_denied', 'service_not_open', 'account_arrears',
            'unsupported_language', 'input_too_long', 'invalid_image', 'throttled',
            'timeout', 'unavailable', 'unknown'
        )
    ),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT aliyun_settings_credentials_consistent CHECK (
        (
            access_key_id_ciphertext IS NULL
            AND access_key_secret_ciphertext IS NULL
            AND access_key_id_tail IS NULL
        )
        OR (
            access_key_id_ciphertext IS NOT NULL
            AND access_key_secret_ciphertext IS NOT NULL
            AND access_key_id_tail IS NOT NULL
        )
    ),
    CONSTRAINT aliyun_settings_global_covers_owner CHECK (global_concurrency >= owner_concurrency)
);

INSERT INTO aliyun_service_settings (id, created_at, updated_at) VALUES (1, now(), now());

CREATE TABLE aliyun_usage_months (
    month_start date NOT NULL CHECK (extract(day from month_start) = 1),
    meter text NOT NULL CHECK (meter IN ('mt_general', 'mt_professional', 'ocr_general')),
    used_units bigint NOT NULL DEFAULT 0 CHECK (used_units >= 0),
    reserved_units bigint NOT NULL DEFAULT 0 CHECK (reserved_units >= 0),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (month_start, meter)
);

CREATE TABLE aliyun_usage_calls (
    request_key uuid PRIMARY KEY,
    owner_id uuid NOT NULL REFERENCES owner_account(id),
    operation text NOT NULL
        CHECK (operation IN ('translate_general', 'translate_professional', 'ocr_general')),
    meter text NOT NULL CHECK (meter IN ('mt_general', 'mt_professional', 'ocr_general')),
    month_start date NOT NULL CHECK (extract(day from month_start) = 1),
    reserved_units bigint NOT NULL CHECK (reserved_units >= 0),
    counted_units bigint NOT NULL DEFAULT 0 CHECK (counted_units >= 0),
    status text NOT NULL
        CHECK (status IN ('reserved', 'succeeded', 'released', 'failed_counted', 'uncertain')),
    upstream_request_id text,
    failure_category text CHECK (
        failure_category IS NULL
        OR failure_category IN (
            'credential_invalid', 'permission_denied', 'service_not_open', 'account_arrears',
            'unsupported_language', 'input_too_long', 'invalid_image', 'throttled',
            'timeout', 'unavailable', 'unknown'
        )
    ),
    created_at timestamptz NOT NULL DEFAULT now(),
    settled_at timestamptz
);

-- Sole additional index: crash-recovery scans reserved calls by created_at.
CREATE INDEX aliyun_usage_calls_reserved_recovery_idx
    ON aliyun_usage_calls (created_at)
    WHERE status = 'reserved';

---- create above / drop below ----

DROP INDEX IF EXISTS aliyun_usage_calls_reserved_recovery_idx;

DROP TABLE IF EXISTS aliyun_usage_calls;
DROP TABLE IF EXISTS aliyun_usage_months;
DROP TABLE IF EXISTS aliyun_service_settings;
