ALTER TABLE app_settings
    ADD COLUMN auto_activate_organized boolean NOT NULL DEFAULT true,
    ADD COLUMN schedule_organize_model_id uuid REFERENCES provider_models(id) ON DELETE SET NULL,
    ADD COLUMN schedule_vision_model_id uuid REFERENCES provider_models(id) ON DELETE SET NULL,
    ADD COLUMN schedule_sensitive_policy text NOT NULL DEFAULT 'block'
        CHECK (schedule_sensitive_policy IN ('block', 'redact', 'allow'));

---- create above / drop below ----

ALTER TABLE app_settings
    DROP COLUMN IF EXISTS schedule_sensitive_policy,
    DROP COLUMN IF EXISTS schedule_vision_model_id,
    DROP COLUMN IF EXISTS schedule_organize_model_id,
    DROP COLUMN IF EXISTS auto_activate_organized;
