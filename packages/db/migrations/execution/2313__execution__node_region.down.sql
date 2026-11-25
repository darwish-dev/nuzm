-- DEV/STAGING ONLY. Documented reversal of 2313 (P3-S02): drops the column; every node then reads as "region unknown" (placement refused when residency is enforced).
ALTER TABLE execution.runtime_nodes DROP COLUMN IF EXISTS data_region;
