-- M10A integration with the real M09: `builder.projects.type` was a CHECK list of `website` only ("M10 extends it with webapp|mobile in its own migration", M09 contract §4).
-- Expand-only: the existing rows (all `website`) stay valid. `mobile` is listed so that M10B needs no second change of the same constraint; no mobile code runs before M10B.
-- Web-app versions carry no website site model: their `site_model` is the fixed marker {"kind":"webapp"} (the files are the source of truth).
ALTER TABLE builder.projects DROP CONSTRAINT projects_type_check;
ALTER TABLE builder.projects ADD CONSTRAINT projects_type_check CHECK (type IN ('website','webapp','mobile'));
