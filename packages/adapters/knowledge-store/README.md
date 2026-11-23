# @nuzm/adapter-knowledge-store

Object-store port of the AI Intelligence Center (ADR-065, D-42) and its adapters: the development filesystem adapter and the S3-compatible adapter
(own SigV4 signer, server-side encryption that is verified, presigned reads, private-bucket self-test). Packages are untrusted data: this layer only stores and
returns bytes, it never opens them. `src/testing/fake-s3.ts` is a signature-verifying S3 fake for tests; it is not exported from the package index.
