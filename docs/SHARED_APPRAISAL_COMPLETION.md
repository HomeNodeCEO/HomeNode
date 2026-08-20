# Shared Appraisal Completion Adapter

HomeNode exposes one versioned, workflow-neutral analysis document for Custom Appraisal and UAD 3.6 files. The adapter is deliberately read-only: it does not rewrite either workfile or infer a new assignment.

## Endpoint

`GET /api/accounts/:accountId/appraisal-history/:reportFileId/completion`

The response contains:

- the target report-file identity and workflow;
- the exact appraisal case and immutable subject snapshot used by the assignment;
- subject identity and characteristics captured in that snapshot;
- neighborhood, market, comparable-sales, adjustment, location-influence, approach, and final-reconciliation results;
- readiness blockers and warnings;
- source section revisions and a deterministic SHA-256 provenance digest.

The endpoint accepts only UUID report-file identifiers. It returns bounded `400`, `404`, or `409` errors for invalid identifiers, missing history records, missing snapshots, or unavailable same-assignment Custom sources.

## Source and assignment rules

Custom Appraisal is the current analysis source because that workflow contains HomeNode's developed market, comparable, adjustment, approach, and reconciliation sections.

A UAD 3.6 file may consume that analysis only when it shares both:

1. the same `appraisal_case_id`; and
2. the same `subject_snapshot_id`.

That is the guarded same-assignment alternate-format path created by appraisal history replication. A later assignment, even for the same parcel, receives a different case and snapshot and cannot silently inherit the prior analysis.

Assignment-scoped subject facts are read exclusively from `app.appraisal_subject_snapshots.subject_data`. The adapter does not accept the current, timeless property row as a substitute.

## Versioning and provenance

- `schema_version` changes when the canonical response contract changes incompatibly.
- `adapter_version` identifies the mapping implementation.
- `source.section_revisions` records the Custom workfile revisions used.
- `provenance.source_digest_sha256` changes when the assignment snapshot identity, relevant section revisions, or canonical analyses change. Request time is excluded from the digest.

Consumers must preserve unknown fields and select a mapper compatible with the reported schema version.

## Current boundary

This first stage provides the stable canonical contract and read-only API. It intentionally does not write UAD fields. The next stage is a field-by-field UAD mapper that translates this document into explicit UAD 3.6 classifications while preserving UAD validation, review, and certification controls. Any ambiguous or unsupported mapping must remain review-required rather than being guessed.
