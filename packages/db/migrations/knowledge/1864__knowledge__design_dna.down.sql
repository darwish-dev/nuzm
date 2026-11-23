-- DEV/STAGING ONLY. Production is forward-fix: design tokens and variants are derived evidence. Documented reversal of 1864 (SCR-K-06).
DROP TRIGGER IF EXISTS worker_derived_guard ON knowledge.theme_variants;
DROP TRIGGER IF EXISTS worker_derived_guard ON knowledge.theme_tokens;
REVOKE INSERT ON knowledge.theme_tokens, knowledge.theme_variants FROM nuzm_worker;
DROP POLICY IF EXISTS worker_knowledge ON knowledge.theme_variants;
DROP POLICY IF EXISTS worker_knowledge ON knowledge.theme_tokens;
DROP INDEX IF EXISTS knowledge.theme_variants_natural_idx;
DROP INDEX IF EXISTS knowledge.theme_tokens_natural_idx;
ALTER TABLE knowledge.theme_variants DROP CONSTRAINT IF EXISTS theme_variants_descriptor_size;
ALTER TABLE knowledge.theme_tokens DROP CONSTRAINT IF EXISTS theme_tokens_value_required;
UPDATE knowledge.theme_tokens SET value = '' WHERE value IS NULL;
ALTER TABLE knowledge.theme_tokens ALTER COLUMN value SET NOT NULL;
ALTER TABLE knowledge.theme_tokens
  DROP COLUMN IF EXISTS resolved_value, DROP COLUMN IF EXISTS dynamic, DROP COLUMN IF EXISTS origin, DROP COLUMN IF EXISTS line, DROP COLUMN IF EXISTS mode;
