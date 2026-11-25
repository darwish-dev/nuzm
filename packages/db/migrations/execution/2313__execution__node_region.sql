-- P3-S02: nodes carry a data region (Master decision, residency at placement). Expand only: one nullable column. NULL means "region unknown", which a residency-enforcing
-- RealRuntimeService treats as a REFUSAL (fail closed) unless the platform configured the service synthetic-only. The region of a node is public platform data.
ALTER TABLE execution.runtime_nodes ADD COLUMN data_region text CHECK (data_region IS NULL OR data_region ~ '^[a-z0-9][a-z0-9-]{1,40}$');
