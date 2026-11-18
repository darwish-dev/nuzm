-- DEV/STAGING ONLY. Production is forward-fix: repositories hold the customer's source and test runs are evidence; neither is dropped.
DROP TABLE IF EXISTS builder.test_runs;
DROP FUNCTION IF EXISTS builder.test_run_guard();
DROP TABLE IF EXISTS builder.git_repos;
DROP FUNCTION IF EXISTS builder.git_repo_guard();
