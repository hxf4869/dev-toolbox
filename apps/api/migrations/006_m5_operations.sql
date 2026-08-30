ALTER TABLE provider_configs
    ADD COLUMN last_tested_at timestamptz,
    ADD COLUMN last_test_status text CHECK (last_test_status IN ('ok', 'credentials_invalid', 'unavailable')),
    ADD COLUMN last_test_latency_ms integer CHECK (last_test_latency_ms IS NULL OR last_test_latency_ms >= 0),
    ADD COLUMN last_test_failure_category text CHECK (
        last_test_failure_category IS NULL
        OR last_test_failure_category IN ('credentials_invalid', 'unavailable')
    ),
    ADD CONSTRAINT provider_configs_test_result_consistent CHECK (
        (last_tested_at IS NULL AND last_test_status IS NULL AND last_test_latency_ms IS NULL AND last_test_failure_category IS NULL)
        OR (
            last_tested_at IS NOT NULL
            AND last_test_status IS NOT NULL
            AND (last_test_status = 'ok') = (last_test_failure_category IS NULL)
        )
    );

-- Keep the existing GIN trigram index for literal substring searches. The
-- expression is intentionally identical to the fuzzy predicate in search.go,
-- so PostgreSQL can use a more selective GiST bitmap for similarity matching
-- instead of rechecking a broad lossy GIN bitmap at the v1 acceptance scale.
CREATE INDEX search_fragments_fuzzy_gist_idx
    ON search_fragments USING gist ((normalized_content || '') gist_trgm_ops(siglen=64))
    WHERE active;

---- create above / drop below ----

DROP INDEX IF EXISTS search_fragments_fuzzy_gist_idx;

ALTER TABLE provider_configs
    DROP CONSTRAINT IF EXISTS provider_configs_test_result_consistent,
    DROP COLUMN IF EXISTS last_test_failure_category,
    DROP COLUMN IF EXISTS last_test_latency_ms,
    DROP COLUMN IF EXISTS last_test_status,
    DROP COLUMN IF EXISTS last_tested_at;
