# UAD 3.6 local validation gate

HomeNode validates the entire saved UAD workfile before any future XML, PDF,
signature, or submission-package step may treat it as ready. This gate reuses
the same official-field and cross-record rules that protect every section save;
it does not create a second interpretation of the appraisal.

## API

- `GET /api/uad/workfiles/:workfileId/validation` returns the latest local run,
  its persisted findings, and whether that result is still ready for export.
- `POST /api/uad/workfiles/:workfileId/validation` validates the current locked
  revision, persists one `local_compliance` run and its findings, and records a UAD
  audit event. Each run also stores a deterministic SHA-256 digest of the field,
  entity, asset, and sketch state that was actually validated.

A passing run moves an editable workfile to `ready`. A run with any fatal
finding leaves it in `draft`. Signed, exported, submitted, and cancelled files
cannot be revalidated through this endpoint.

Any later section, repeatable-entity, sketch, or asset mutation returns the
workfile to `draft`. The older run remains in the audit trail, but it can no
longer satisfy `ready_for_export`; the changed workfile must pass a new run.

## What the local gate checks

- every required and conditionally required field in every applicable section;
- field types, formats, enumerations, bounds, and the locked field catalog;
- repeatable-entity, parent-child, asset, and cross-section consistency rules;
- appraiser confirmation for visible HomeNode-prefilled or imported values;
- the exact workfile revision and UAD specification release used by the run.

Calculated, read-only values are evaluated by their owning server rules and do
not require a separate appraiser-confirmation finding.

## Persistence and export contract

Runs are stored in `appraisal.uad_validation_runs`; individual actionable
results are stored in `appraisal.uad_validation_findings`. Starting a new local
run supersedes open findings from older local runs without deleting history.
The run metadata records the validator version, applicable sections, and input
record counts.

Future artifact generation must require all of the following:

1. the latest local run has `status = passed`;
2. its revision matches `uad_workfiles.current_revision`;
3. the workfile itself has `status = ready`; and
4. a freshly computed input digest matches the run's `input_digest_sha256`; and
5. its specification release matches the generator's locked mapping release.

The API exposes the first three checks as `ready_for_export`. Deterministic
MISMO 3.6 generation and GSE subschema validation are the next layer; external
Fannie Mae or Freddie Mac Compliance API results remain separate validator
types and cannot overwrite the local audit trail.
