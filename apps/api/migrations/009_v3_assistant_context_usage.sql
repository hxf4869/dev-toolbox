-- Legacy input counts omit cache hits, so their complete context usage is unknown.
ALTER TABLE assistant_runs
    ADD COLUMN answer_context_tokens bigint CHECK (answer_context_tokens >= 0);

---- create above / drop below ----

ALTER TABLE assistant_runs DROP COLUMN answer_context_tokens;
