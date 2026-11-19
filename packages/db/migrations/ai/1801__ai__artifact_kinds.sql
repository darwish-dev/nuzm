-- M10A integration with the real M09: the artifact kinds of the agent graph (requirements, app_spec, db_schema, api_contract, frontend_bundle, test_plan, deploy_plan) and the
-- kinds reserved by the M10 prompt (openapi, test_report, sbom) join M09's list. Expand-only: every existing row stays valid.
ALTER TABLE ai.artifacts DROP CONSTRAINT artifacts_type_check;
ALTER TABLE ai.artifacts ADD CONSTRAINT artifacts_type_check CHECK (type IN (
  'requirements','architecture','page','change_set','site_model','evaluation_report',
  'app_spec','db_schema','api_contract','frontend_bundle','test_plan','deploy_plan','openapi','test_report','sbom'));
