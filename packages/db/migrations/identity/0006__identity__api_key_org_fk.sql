ALTER TABLE identity.api_keys ADD FOREIGN KEY (org_id) REFERENCES tenancy.organizations(id);
