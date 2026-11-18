-- M06: a FAILED site (creation never completed, reservation released) must not keep its name: the customer retries with the same name and a new quote.
DROP INDEX hosting.sites_org_name_idx;
CREATE UNIQUE INDEX sites_org_name_idx ON hosting.sites (org_id, lower(name)) WHERE status NOT IN ('deleted','failed');
