# UAD neighborhood review state model (inactive)

`dcad-frontend/src/features/uad/neighborhoodReviewModel.ts` prepares a review view and deterministic state transitions for the separate [UAD neighborhood adapter](UAD_NEIGHBORHOOD_REVIEW.md). No component, route, API client, storage, provider, authentication, report calculation or existing panel is connected or changed. This is preparation for a later reviewed integration, not an enabled feature.

## Authority and display contract

The model accepts a `NeighborhoodReviewPreview` containing the real server candidate and a **server-classified** `new`, `reuse` or `conflict` state for every member. The preview projection is a future server integration requirement; no production endpoint currently returns this new shape. Tests construct synthetic projections using the actual backend preflight helper. Equal text or a legacy source label does not establish compatible provenance, and the browser must not invent these classifications.

A complete review includes exactly the four common boundary, search, lookback and sale-count members when sales are a verified zero, or all seven members including the three price statistics when sales are positive. Displayed populations, statistics and sources must exactly cover the group's declared dependencies; missing, duplicate and unresolved evidence references reject the preview. Geographic neighborhood and market-analysis geography remain separately labeled. Effective date, cutoff, study period, search criteria, sources, member dependencies and explicit omissions remain visible in the view model.

Browser checks are fail-closed presentation checks, not a security boundary or a second statistical engine. The server must still regenerate and validate the candidate, catalog release, current workfile identity, occupancy, provenance, permissions, signature state and revision inside the eventual atomic transaction. Hashes detect changes; they do not grant authorization. The model does not recompute sale summaries or claim Section 17/report/GSE completeness.

## Selection and concurrency

- A loaded or refreshed group starts unselected and unconfirmed. Selection includes **every** member, including compatible reused values; there is no per-field acceptance path. Confirmation is a separate appraiser action.
- A conflict blocks the whole group and preserves existing report data. Dirty, unknown-dirty, read-only, signed, locked, incomplete and pending-operation states also block apply.
- The host supplies a non-secret `sessionKey` that changes with authenticated session/organization context. It must never be an access token or credential. Workfile/report identity, revision, specification, session, permission, lifecycle and dirty-state changes invalidate the preview and confirmation.
- Every refresh increments an operation generation. Older successes and failures cannot replace a newer review, including A-to-B-to-A navigation at the same revision.
- One apply remains pending for its workfile/session even if dirty/revision state changes. Context changes do not cancel an already-sent server operation. Its late result can clear the pending marker but cannot overwrite newer editor state, restore confirmation or announce an unrelated save.
- A refresh during apply also invalidates the result generation. On an uncertain or stale result, the host must refresh authoritative report state before allowing a new attempt; it must not automatically retry an old command.

`beginNeighborhoodReviewApply` returns a command, not a network request. Its body contains full selected IDs, confirmation, preserve-existing, expected revision and candidate/binding digests, never browser-supplied field values. A later component should use the existing authenticated request mechanisms rather than introduce another login/session path.

## Save results and integration boundary

`finishNeighborhoodReviewApply` accepts a separate **committed result** shape. `prepareUadNeighborhoodApply` returning `ready` is only a plan and is deliberately rejected as save success. A future transaction adapter must emit `applied` only after canonical values, provenance, receipt, audit and exactly one revision have committed together. Its workfile, group, candidate digest, counts and accepted/current revisions must match the pending operation.

An exact `already_applied` receipt replay announces that no additional changes were made and produces no new-mutation event. This includes a lost prior acknowledgment: the server may report acceptance at `expected_revision + 1` even though the local editor still displays the earlier revision. The host must honor `state.needsRefresh` and reload the authoritative saved report/revision even when `mutation` is null; absence of a new-mutation event never means the local editor is current. Structured acceptance metadata retains the original accepted revision for evidence/debugging without using revision numbers in the everyday save message. Failed, malformed, conflicting or unconfirmed results require a refresh; they never announce success.

The eventual host must reconcile the returned mutation descriptor with authoritative saved workfile state and existing autosave notifications. This module neither saves local edits nor makes a persistence guarantee. Signed report/export evidence must still use the saved receipt and requested saved revision, not a new browser preview or the latest research.

## Verification and activation prerequisites

Run from the repository root with Node 22:

```sh
node --experimental-strip-types --test dcad-frontend/scripts/testUadNeighborhoodReview.mjs
```

The suite uses real backend candidates, write plans and receipt validation with synthetic data only. Coverage includes exact request parity, zero/positive groups, mixed reused/new values, manual conflicts, unknown/signature state, source/dependency display, selection, refresh/navigation races, duplicate results and receipt replay. A simulated committed-result fixture is not proof of a database commit. Standalone strict TypeScript checking validates the model without installing new dependencies.

Before activation: finish the authorized stored-context and occupancy resolver, server preview projection and atomic receipt persistence; agree on committed-result normalization; connect the existing review panel without partial-skip behavior; test authenticated multi-organization access, actual transactions, autosave interactions, browser navigation and revision-bound exports in isolated staging. Coordinate route, authentication, storage and merge ownership. This slice does not authorize any of those activation steps by itself.
