-- DEV/STAGING ONLY. Production is forward-fix: these tables hold the customer's source history and are never dropped there.
DROP TABLE IF EXISTS builder.vcs_refs;
DROP FUNCTION IF EXISTS builder.vcs_ref_guard();
DROP TABLE IF EXISTS builder.vcs_commits;
DROP TABLE IF EXISTS builder.vcs_trees;
