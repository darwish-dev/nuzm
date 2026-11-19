-- DEV/STAGING ONLY (production is forward-fix). Fails when an artifact of an M10 kind exists (artifacts are immutable and never deleted): reversal is possible only on an empty M10 history.
ALTER TABLE ai.artifacts DROP CONSTRAINT artifacts_type_check;
ALTER TABLE ai.artifacts ADD CONSTRAINT artifacts_type_check CHECK (type IN ('requirements','architecture','page','change_set','site_model','evaluation_report'));
