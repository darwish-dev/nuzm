-- S04: a customer's own VPS that runs HestiaCP is registered as a node of a DIFFERENT network class. It is outside the shared-hosting network: placement, capacity and
-- plans only ever look at `shared` nodes. The customer has root on it, so Nuzm keeps a read-only panel key (readiness and link tests), never a management one.
ALTER TABLE hosting.nodes
  ADD COLUMN network_class text NOT NULL DEFAULT 'shared' CHECK (network_class IN ('shared','customer_vps')),
  ADD COLUMN owner_org_id uuid,
  ADD CONSTRAINT nodes_customer_vps_owner CHECK ((network_class = 'customer_vps') = (owner_org_id IS NOT NULL)),
  ADD CONSTRAINT nodes_customer_vps_never_shared CHECK (network_class = 'shared' OR status IN ('maintenance','retired'));
CREATE INDEX nodes_network_class_idx ON hosting.nodes (network_class, status);
