# Custom neighborhood preview capacity

The public preview, catalog and member-page contracts are unchanged. Their internal calculation view now stores each account, canonical transaction and source-record observation once, with ordered indices for the all-account population, selected union and individual pockets. This removes repeated serialized evidence; it does not sample the population or weaken an output limit.

## Compatibility and safety

- The original `buildCustomCohortObservationPreview` and raw internal owner `preview()` remain expanded version 1, including their existing byte/work accounting and golden results.
- `buildCustomCohortIndexedObservationPreview` issues an internal version 2 `indexed_members_v1` view. Its full member tables and every population index are serializable and bounded. Only genuine, frozen views from this factory can be resolved; reconstructed JSON is not an indexed view or source authorization.
- Public `present`, `inspect` and `catalog` resolve only the needed population and continue returning public version 1 summaries/pages. No complete expanded view is reconstructed. Cursor identity still uses the exact ordered safe member projection, not table indices or private source IDs.
- The reported-observation assembler resolves the selected account rows from the indexed view. Selected members, source references, exact decimal results, evidence hashes and all five report suggestions remain identical. Atomic Apply, replacement, final access checks and signing controls are unchanged.
- Empty selections remain empty. Overlapping pockets retain their separate distributions while the selected union deduplicates members. All-date source records, omitted transactions, outside-account links and whole package totals retain their original meaning.

## Limits still apply

The internal preview ceiling remains **32,000,000 UTF-8 bytes**, with unchanged measurement/member-work limits. The complete actual indexed JSON is checked as well as incremental construction. Retained acquisition, source-reader, public summary/page, map, catalog and report-publication limits remain independent. An inspectable population is not automatically publishable or historically supported.

Computed preview output/work exhaustion returns HTTP 422 `neighborhood_preview_capacity_exceeded`, with no partial data or internal diagnostics. Invalid selection input remains HTTP 400. Authentication, access refusal and uncertain-operation handling take precedence.

The frontend distinguishes this exact status/code from other failures. A failed selection preview keeps the preceding map/statistics visibly stale and leaves the ordinary pocket controls available. It does not silently deselect, retry or accept partial results. A catalog failure follows the existing saved-operation recovery rules; this change does not create a bypass around pending captures or failed reloads.

## Verification and scope

Regression coverage compares expanded/indexed public summaries, catalogs and every member page/cursor for original mapping2/3/4 captures, empty/all/overlapping selections, source-only records, multi-account packages, date omissions/conflicts and exact-decimal edge cases. Complete report-result golden hashes cover shared/private/empty selections and 128 named groups plus unassigned accounts. Large synthetic tests retain every account and preserve genuine output/work refusals.

These tests do not establish real-city inventory completeness, a production latency SLA, historical housing-stock evidence or source-use rights. Repeated empty recommendation calculation remains a separate optimization opportunity; its policy and results are not changed here.
