-- DEV/STAGING ONLY. Production is forward-fix (attestation records and the kill-switch history are security evidence). Documented reversal of 2312 (P3-S02): 
DROP TABLE IF EXISTS execution.kill_switch;
DROP TABLE IF EXISTS execution.attestations;
DROP FUNCTION IF EXISTS execution.attestation_guard();
DROP TABLE IF EXISTS execution.runtime_nodes;
