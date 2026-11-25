-- DEV/STAGING ONLY. Production is forward-fix: these tables hold the customer's source history and are never dropped there.
DROP TABLE IF EXISTS builder.vcs_blobs;
DROP TABLE IF EXISTS builder.vcs_repo_state;
DROP FUNCTION IF EXISTS builder.vcs_repo_state_guard();
DROP FUNCTION IF EXISTS builder.vcs_immutable();
DROP INDEX IF EXISTS builder.git_repos_id_org_idx;
