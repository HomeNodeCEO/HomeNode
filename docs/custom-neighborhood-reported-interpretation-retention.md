# Retaining the chosen reported-sales interpretation

This is an additive retained-evidence format, not production activation. The
Custom owner, policies, API/checkpoint shapes and default report builders remain
unchanged. A mapping number alone never selects new report semantics.

## New original forms

An internal new-capture input may explicitly contain
`reported_sale_interpretation`, equal to the fixed witness2 interpretation
profile reference. Only original mapping5 acquisition can use that marker.

The marker is bound before retention in the acquisition intent:

| Intent version | Private CSV supplement | Reported-sale interpretation |
| --- | --- | --- |
| 1 | absent | absent; legacy behavior |
| 2 | present | absent; legacy behavior |
| 3 | absent | exact fixed profile reference |
| 4 | present | exact fixed profile reference |

Marked captures retain `study_input_version: 2` with all previous fields plus
`reported_sale_interpretation: { profile_ref, definition_blob }`. The latter is
an actual content-addressed reference to the fixed canonical definition. The
original definition is stored through the existing bounded evidence builder.
Unmarked captures retain study-input version1 and their previous exact bytes.
Selection directories, context headers and workspace checkpoints do not change.

The existing context hash includes the study-input reference, binding the exact
semantics transitively to this capture. On reopen, the loader verifies the
profile reference and reads the actual stored definition original before
rebuilding the full graph. The marker, intent version, intent reference, original
mapping and re-created study hash must agree. A missing, altered, or unknown
profile is an error, never a silent downgrade to the legacy interpretation.

This accepts only profile `custom-local-reported-sale-witness-v2`, revision `1`,
hash `831e8a1eced98b9cc8dcee3a7f4b85ec182241ff44c8de355523c0a21609283e`.
It does not accept caller-defined dictionaries or grant source/report authority.

## Replay and later activation

Previously retained mapping5 without a marker stays unmarked. Existing report
artifacts are not regenerated here. Later owner integration must dispatch from
the admitted persisted marker, not the current producer default.

The current owner reuses registered contexts by operation ID. An attempt that
failed before registration has no operation-to-intent lookup; retry is a new
acquisition attempt with a newly recorded intent. This format does not claim to
recover an orphan attempt or add a database schema/index for that purpose.

All graph/reference/byte limits, actual-original reads, source revalidation,
private-supplement authorization bindings, snapshot/transaction checks and
chronology checks remain in force. This does not broaden source access, support
retrospective CAD stock, change statistics, or independently Apply a boundary.
