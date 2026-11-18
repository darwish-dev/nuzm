-- M11 S51 (owner PR to the billing module): the quota group `automation` is measured by the meter `automation.executions`. There is NO limit until the plan limits are
-- decided (HG-02-01): a group with no limit entitlement is unlimited, and the unmeasured state is reported as such.
INSERT INTO billing.quota_meters (meter_group, meter_id) VALUES ('automation','automation.executions') ON CONFLICT DO NOTHING;
