# Custom neighborhood pocket records

Opening a recorded pocket still displays its independent summary without changing the saved selection. **Show records** expands the records behind that summary. This is a read-only inspection tool, not report acceptance or individual-property inclusion.

- Account observations, shared source records, in-period transaction records and omitted transactions are separate populations. Their counts are not interchangeable. Assignment-private CSV rows remain in the existing private-source review panel.
- Each request uses the checked summary's exact population descriptor and count, retained context, selection revision/hash and opaque page cursor. Pages contain at most 50 members. No total, partial page or unavailable response is silently relabelled complete.
- Only the current page is rendered. Back navigation retains bounded cursor proofs, not every fetched row. Population changes reset paging. There is no polling, mount-time member request or bulk download.
- Recorded CAD account identifiers are shown where available. Internal source/transaction identities, credentials and provider payloads are not displayed. An associated-account count is not proof of one sale per property.
- Missing, invalid and conflicting observations stay explicit. Shared recorded totals are not presented as verified property sale prices; area units, currency, historical applicability, market eligibility and reliability are not inferred where the retained source has not established them.

## Save and request ownership

The mounted Custom host supplies the same serialized request lane used by context/preview reads and workspace saves. New member reads are refused while mutation, recovery or save/sign quiescence is active. The component owns a finite abort deadline, pauses when the workspace is blocked, and ignores late replies after hiding, changing pocket/population, changing file/context/session or unmounting. Completed pages may remain visibly paused without changing accepted report data.

The existing authenticated `POST /api/accounts/:id/neighborhood-cohort/members` endpoint and server inspection policy are reused. This change adds no server route, database migration, grant, source acquisition, calculation, report schema or production activation switch. Save Everything continues to await the owned lane; an inspection cannot write a checkpoint or replace the five-part accepted report group.

## Regression coverage

Exercise exact summary/page counts, context and selection mismatch, foreign/stale cursors, oversized responses, all four population shapes, observation states, safe rendering, empty/full/partial pages, Next/Back, explicit Retry, paused/late replies and read-only Host admission. The record browser and pocket inspector must preserve the saved inclusion set and accepted report when inspecting an excluded group.
