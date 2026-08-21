# UAD 3.6 MISMO XML export

HomeNode generates UAD XML inside the existing Node service and stores successful artifacts in the existing private R2 bucket. It does not introduce a separate UAD service, database, or authentication boundary.

## Locked technical sources

- Appendix A-1 URAR Delivery Specification: version 1.4, SHA-256 `10f470ed53ee6f70404aad850f3f3c15aaee9489f654535ee0a3e5d1a8adee29`.
- GSE UAD 3.6 combined subschema: version 1.3, main XSD SHA-256 `0bb6650ab465753fe2023be14d414ad6db45820201b7fdee1d90023e49cbf129`.
- MISMO reference model identifier: `3.6.0366`.
- Local XSD engine: `xmllint-wasm` 5.3.0 (libxml2 compiled to WebAssembly).

The generated runtime mapping contains every one of the 845 unique Appendix A IDs currently represented by HomeNode's 952 context-aware editor fields. It preserves the XML sort number, XPath, data point, measurement attribute, supported attribute value, property context, and implementation note needed by the generator.

The official combined XSD and its local dependencies live in `src/modules/uad/spec/subschema/v1.3`. Validation performs no network access and never follows an XML-supplied machine path.

## Generation gate

`POST /api/uad/workfiles/:workfileId/artifacts/xml` performs these steps:

1. Locks the workfile.
2. Requires workfile status `ready` or `signed` and a passed `local_compliance` run for the current revision.
3. Recomputes the exact editor/entity/asset/sketch SHA-256 digest and rejects stale validation.
4. Builds deterministic UTF-8 MISMO XML from the saved, appraiser-reviewed workfile state. A signed revision also supplies immutable appraiser/supervisory credential snapshots and execution dates for the official `PARTY` and `SIGNATORY` structures.
5. Validates that XML against the checked-in official GSE subschema.
6. Persists a `local_schema` validation run and every XSD finding.
7. Creates or replaces the revision-specific `xml` artifact record.
8. Uploads only schema-valid XML to the private R2 bucket, using a content-addressed object key.

A schema failure is a completed validation result, not an export. The artifact remains `failed`, the findings display in the UAD editor, and no downloadable object is uploaded.

`GET /api/uad/workfiles/:workfileId/artifacts/xml` returns the latest artifact, the latest official schema run, and a short-lived signed download URL only when the artifact is ready and current.

## Determinism and workfile isolation

- Identical saved workfile state produces identical XML bytes and SHA-256.
- Subject PROPERTY is separate from every SalesComparable and PropertyAnalyzedNotUsed PROPERTY repeat.
- Repeatable HomeNode entities map to repeatable MISMO containers by their stable entity IDs and ordinals.
- Measurement units are written as the official MISMO attributes.
- Boolean values are lowercase XML values.
- XML text and attributes are escaped.
- Generated object keys contain organization, workfile, revision, artifact type, checksum, and sanitized filename.
- Any later section, entity, photo, or sketch mutation returns the workfile to draft and makes the prior artifact non-current.

## Current boundary

The generator intentionally does not invent missing report data. HomeNode currently maps the implemented editor scope through Section 26 Reconciliation and Section 29 Certifications and Scope of Work. Section 29 includes the required indicators, conditional assignment-specific text, prior-services disclosure, inspection attestation, and Appendix H consistency warnings. Signed revisions generate official appraiser/supervisory `PARTY` and `SIGNATORY` structures from credential snapshots rather than mutable live profiles.

The official subschema still requires later system/package structures such as Valuation Software Systems, Views, About Versions, Document Classification, Service Detail, and the native PDF reference. Until those system-owned structures and the remaining optional valuation approaches are implemented, the official schema gate will continue to report their absence as blocking findings. Those findings provide the ordered backlog for the next implementation phase.

This local schema gate is separate from Appendix H compliance validation and from Fannie Mae/Freddie Mac submission APIs. XML must pass both the local readiness rules and this official XSD gate before the later compliance and submission-package phases can run.
