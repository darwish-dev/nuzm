-- DEV/STAGING ONLY. Production is forward-fix: skill reviews, instruction versions and webhook deliveries are evidence and are not dropped.
DROP TABLE IF EXISTS builder.claude_code_sessions;
DROP TABLE IF EXISTS builder.github_events;
DROP FUNCTION IF EXISTS builder.github_event_guard();
DROP TABLE IF EXISTS builder.github_repos;
DROP TABLE IF EXISTS builder.github_connections;
DROP TABLE IF EXISTS builder.instruction_versions;
DROP FUNCTION IF EXISTS builder.instruction_version_guard();
DROP TABLE IF EXISTS builder.project_instructions;
DROP FUNCTION IF EXISTS builder.project_instructions_guard();
DROP TABLE IF EXISTS builder.project_skills;
DROP TABLE IF EXISTS builder.skill_reviews;
DROP FUNCTION IF EXISTS builder.skill_review_guard();
DROP TABLE IF EXISTS builder.skill_versions;
DROP FUNCTION IF EXISTS builder.skill_version_guard();
DROP TABLE IF EXISTS builder.skills;
DROP FUNCTION IF EXISTS builder.skill_guard();
