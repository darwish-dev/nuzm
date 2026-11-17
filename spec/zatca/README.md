# spec/zatca — pinned e-invoicing specification (M03 S11)

**Status: BLOCKED — no official ZATCA documents have been supplied (M03 prompt §4 item 12, HG-03-03).**
`spec/zatca/official/` is empty. Until the owner supplies the official specification set (XML implementation standard, data dictionary, security
features, XSD/Schematron, sample documents), nothing in this repository is a statement of what ZATCA requires.

What exists instead is a **synthetic profile** (`synthetic-profile.yaml`): a self-consistent, documented stand-in built from the structure in
docs/11 §5 and publicly known UBL 2.1 conventions, used to build and test the whole pipeline (documents, XML, hash chain, QR, signing, archive)
without claiming conformance. Every output is `NOT VERIFIED vs ZATCA`. Real codes, namespaces, QR tag rules, canonicalization, signature
algorithm parameters, CSR extensions and VAT-number rules must be re-pinned from the official documents; the pipeline reads them from the
profile, not from code, so that is a configuration and test-golden change plus a review, not a rewrite.

Files

- `VERSION` — pinned version (UNPINNED), checksum of `official/`, and the hash of the generator sources. `pnpm zatca:guard` fails when the
  generator changes without a version bump note (`CHANGELOG.md`), as docs/11 §5 requires.
- `synthetic-profile.yaml` — the synthetic profile (SYNTHETIC-NOT-OFFICIAL).
- `official/` — where the owner-supplied documents go (empty).
