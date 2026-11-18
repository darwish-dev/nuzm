-- DEV/STAGING ONLY (M12 S55); production is forward-fix and review history is never dropped there.
DROP TABLE IF EXISTS audit.access_reviews;
DROP FUNCTION IF EXISTS audit.access_review_guard();
