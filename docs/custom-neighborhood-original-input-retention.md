# Original Custom acquisition input retention

`customCohortCaptureInputs.js` is the concrete retention component of the Custom
context-capture coordinator. It does not publish a context, select a current
assessment, write report sections, acquire clients, or end transactions.

## Owner and input contract

The owner supplies `prepareCustomCohortCaptureInputs` with the already-consumed
original cached acquisition handoff, original spatial membership, verified
retained subject and its reference, prepared selector, study settings, retained
acquisition intent, and source-operation start/end timestamps. It must establish
original same-process provenance and fresh assignment/market permission; neither
serialized data nor matching hashes supplies that authority.

The intent is `{reference, body}`. Its body contains `intent_version: 1`, the
lowercase UUID `operation_id`, trusted `actor_user_id`, `subject_inputs`, exact
subject `target`, `effective_date`, `study`, and UTC6 database `created_at`.
The coordinator retains this body before starting source acquisition. Study is
exactly `{profile_id: 'custom-simple-suburban-radius-v1', observation_period:
{start_date, end_date}, knowledge_cutoff: null}`. The selector's source digest
identifies the actual spatial membership result, not source trust.

Preparation checks exact subject/target/date/selection bindings, the original
query bundle and both query hashes, source partition and routing closure,
original spatial membership digest, full one-hop transaction closure, and
matching source/spatial snapshot descriptors. It requires
`intent.created_at <= started_at <= capture_observed_at <= completed_at`.
These read timestamps do not imply a successful retention COMMIT.

## Four retained dependency references

- `snapshot_evidence`: reuses the verified original subject snapshot reference.
- `subject_dependencies`: original subject/material references, the actual
  installed material profile definition, and the recorded subject point.
- `selection_input`: the existing retained query index; original compact JSON;
  original acquisition, request and capture metadata; complete selector and
  account roster; spatial parcel originals; full transaction-closure collections;
  every source payload and original snapshot descriptor; and complete record
  routing. Nothing is reduced to counts or a replacement digest.
- `study_input`: exact target/effective date and retained study settings, explicitly
  retaining current-mutable-source semantics and unestablished eligibility.

These version-1 storage records are descriptive dependency graphs, not factual
eligibility decisions or a new permission/issuer protocol. Raw mapping versions
come from the actual captured metadata; original v1 bytes are not relabeled v2.

Preparation preflights the entire graph before any database call. Source payload
blobs retain their original canonical bytes. Spatial, closure, roster and routing
collections use ordered pages, preserving every entry and its position. Blob
limits remain 1.5 MB canonical UTF-8, 100,000 nodes and depth 35. Pages contain at
most 250 entries and 1.3 MB of encoded work. The graph additionally bounds unique
blobs to 4,000, logical blob-reference traversals to 12,000, and combined encoded
work/referenced bytes to 192 MB. Every logical reference occurrence is charged,
including duplicate hashes and cached reads. Overflow fails, never truncates.
Whole graph comparisons use bounded per-entry traversal, not a giant canonical
JSON document that would incorrectly apply a one-blob limit to many blobs.

`persistCustomCohortCaptureInputs(client, scopeJson, prepared)` requires the exact
original prepared object. Before INSERT, it verifies existing subject/intent
bytes and the subject repository's real original-dependency checks. It calls the
existing selection repository's `retain` and immutable blob repository's `put`;
the returned value is exactly the four references above. Owner-controlled actual
transaction identity is checked before writes and at completion. Errors propagate
for owner rollback; returned references are not a durable-success receipt.

`loadCustomCohortCaptureInputs(client, scopeJson, refs)` follows the complete
bounded graph, reopens original subject/query inputs using the existing
repositories, reconstructs the original collections, and repeats preparation and
exact four-reference comparison. Missing/corrupt/foreign/partial inputs fail.
It returns the intent, study, subject reference and descriptive summary, with
`authority: not_established`. Its deeply frozen internal `retained_inputs` also
contains the fully reopened original graph, including the capture's explicit
`unsupported_capabilities`, so the next consumer need not reread mutable cache
rows. This graph is not an HTTP response and never restores a consumed acquisition
WeakMap handle or establishes current factual authority.
Fresh permission, current material comparison, original operation/actor matching,
and replay decisions remain the coordinator's responsibility.

Focused tests use the actual source/spatial readers, access factory, original
handoff and repositories over explicit query fakes. They are not PostgreSQL or
provider-coverage proof. Native coordinator verification is a separate check.
