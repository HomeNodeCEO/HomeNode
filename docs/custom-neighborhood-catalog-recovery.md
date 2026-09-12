# Custom neighborhood catalog recovery

Capture registration and catalog preparation are separate operations. A failed
catalog does not imply that source capture failed. Keep the saved operation ID;
explicit resume reopens the registered evidence instead of collecting a new study.
No report section is applied by either operation.

## Dense proximity compatibility

The proximity reader now uses the same admitted capture-version record allowance
as the parcel map and indexed observations. Legacy captures retain their 100,000
record ceiling. Dense CAD captures follow their original bounded metadata; this
helper does not establish authority or accept new source facts.

Native distance geometry/query/output ceilings are unchanged. When a complete
dense map exceeds those independent geometry ceilings, proximity is unavailable
for the whole study, not a partial prefix. Other recommendation factors and the
complete catalog remain available. No scoring weights or thresholds changed.

Validation used an actual retained synthetic PostgreSQL graph: 38,106 accounts,
38,347 parcels, 116,621 source records, and 887 recorded groups. The old proximity
guard threw before map admission. The corrected guard preserves all groups and
explicitly reports proximity capacity exhaustion. The full web-host recommendation
test runs under a 384 MiB V8 heap with concurrent health requests.

## Operational diagnostics

Read diagnostics use closed action/family/check labels. They cover plain Error
coordinator/context validators as well as TypeError observation/presentation
validators. Unknown text is never echoed. Public responses, authorization and
report adoption remain unchanged; logging failures cannot change recovery.
