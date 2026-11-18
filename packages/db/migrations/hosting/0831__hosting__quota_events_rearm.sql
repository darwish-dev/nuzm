-- M06 S26: a quota dimension re-arms when usage falls back below its soft limit: the service deletes the (site, dim) notification markers of a non-monthly dimension.
GRANT DELETE ON hosting.quota_events TO nuzm_app, nuzm_worker;
