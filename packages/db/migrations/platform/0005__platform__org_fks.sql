-- M01 S03: org_id on platform tables now references tenancy.organizations (docs/05 rule 2 allows this FK only).
ALTER TABLE platform.operations ADD FOREIGN KEY (org_id) REFERENCES tenancy.organizations(id);
ALTER TABLE platform.operation_steps ADD FOREIGN KEY (org_id) REFERENCES tenancy.organizations(id);
ALTER TABLE platform.outbox ADD FOREIGN KEY (org_id) REFERENCES tenancy.organizations(id);
ALTER TABLE platform.idempotency_keys ADD FOREIGN KEY (org_id) REFERENCES tenancy.organizations(id);
ALTER TABLE platform.notifications ADD FOREIGN KEY (org_id) REFERENCES tenancy.organizations(id);
ALTER TABLE platform.feature_flags ADD FOREIGN KEY (org_id) REFERENCES tenancy.organizations(id);
