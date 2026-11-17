# @nuzm/adapter-mock-compute

Simulator used by tests and the non-production dev stack. It models only behaviours our contract must survive and says nothing about any vendor. Control surface for tests: `inject(fault)`, `setCapabilities`, `setRegions`, `setPlans`, `setPrice`, `setConsistencyLag`, `billableCount()`, `billableByToken()`; the `clock` is a `SimClock`. See [../README.md](../README.md).
