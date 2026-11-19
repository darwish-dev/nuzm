-- DEV/STAGING ONLY (production is forward-fix). Fails when a webapp/mobile project exists: remove those projects first.
ALTER TABLE builder.projects DROP CONSTRAINT projects_type_check;
ALTER TABLE builder.projects ADD CONSTRAINT projects_type_check CHECK (type = 'website');
