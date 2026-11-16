-- Dev/staging reversal ONLY. Usage and rating data are financial records: never dropped in production (forward fix).
DROP VIEW IF EXISTS metering.v_margin;
DROP SCHEMA IF EXISTS metering CASCADE;
