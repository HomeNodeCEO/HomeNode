# Cooperative Custom neighborhood report preparation

This is a scheduling change, not a new report or source interpretation profile.
The existing synchronous APIs and asynchronous owner consume the same kernels.

## Work split into checkpoints

- Both indexed observation previews now delegate their existing batches to the
  report owner instead of draining them synchronously inside one report stage.
- Member normalization and canonical content hashing yield every 125 members.
- Publication normalization, independent population-content verification and
  final member freezing use the same bounded checkpoints. Sources and major
  validation boundaries also yield.
- Selected CAD account-reference assembly yields every 125 accounts before
  creating its population source. Each dense reference still hashes the full
  original preview row, including facts outside the displayed metrics. Normal
  full-row reports retain their original representation and ordering. Temporary
  assembly wrappers are released after the population is complete.

The report owner's original deep input seal, checks before and after each
iterator step, cancellation cleanup and final authorization remain in place.
The internal iterator bridges must only be suspended by an owner with sealed
caller inputs and exclusively owned derived arrays. They emit no source rows,
partial reports, hashes or authority receipts at checkpoints.

## Preserved guarantees

All original row, publication, storage, account-link and source limits remain.
Publication independently re-normalizes and re-hashes the complete member
content; this is not replaced with trust in a previous validation result.
No member sampling, cap increase, source grant, schema, calculation, API or
report-Apply change is introduced. Pre-change complete V1/V2 publication and
legacy/Witness2 report hashes are pinned in regression tests.

## Measurement limits

This does not make every operation asynchronous. Sorting, member-set hashing,
individual bounded row/source processing and reported-sales interpretation
still have synchronous portions. Follow-up
dense measurements must report the longest processing interval and health
probe delay as well as total elapsed time. Test-helper setup/assertion work is
not production-owner work. Callback ordinals must not be presented as semantic
stage names without an explicit source-bound stage contract.

These tests do not establish production throughput, source rights, historical
CAD availability or complete provider coverage. Boundary and statistics are
still accepted only as one coherent reviewed report group.
