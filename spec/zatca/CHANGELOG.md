# ZATCA generator changelog

Each change to the generator sources (listed in `VERSION`) needs an entry whose hash matches `VERSION.generator.sha256`. Add it with
`pnpm zatca:guard --update "<what changed and why>"`.

- 2026-11-17 `1b8d7337cbfe8bc3` Initial pin: synthetic profile and generator (UBL body, hash chain, QR TLV, signing, CSR, validator); no official ZATCA documents supplied
- 2026-11-22 `72feedaa54e981ce` validator.ts: the UUID pattern is now imported from @nuzm/domain instead of declared locally; the pattern is character-for-character identical, no change to generated or validated output (commit 8e314fd)
- 2026-11-22 `c79aab4d57ab7ecc` guard now also hashes packages/domain/src/ids.ts, the shared UUID pattern the validator imports (hashing file text does not follow imports); no change to the generator files themselves
