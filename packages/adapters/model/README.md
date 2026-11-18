# @nuzm/adapter-model

`ModelAdapter` contract (docs/09 §7), the deterministic scripted/record-replay **mock** adapter and the conformance suite (M09 S37).

No real model provider is implemented here: provider choice (D-18) and the human attestation of data terms (HG-09-01) are OPEN. A real adapter is added only from the
provider's official documentation (cited in `docs/adapters/<provider>.md`) and must pass `runModelConformance`.
