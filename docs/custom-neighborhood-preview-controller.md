# Custom neighborhood observation-preview controller

`dcad-frontend/src/features/neighborhood/customCohortPreviewController.ts` is a request lifecycle owner, not a mounted report component or an Apply/signing owner. The application must supply its existing authenticated transport and dispose this controller when the file, session, or component is closed. No credentials, browser storage, authorization policy, global polling, or workfile saving are added.

## Host API

Create with `createCustomCohortPreviewController({ transport, timer, onChange, debounceMs? })`. The timer has `set(callback, delayMs)` and `clear(handle)` and follows normal asynchronous timer semantics. Debouncing defaults to 250 milliseconds. `transport(request, { signal })` receives the detached account ID, canonical string assignment ID, exact context reference, selection, and `include_map`; it returns the parsed authorized HTTP preview envelope. Read `getState()`, call `setSelection(input)` when pockets change, call `setSelection(null)` to clear, and `dispose()` permanently on unmount/session loss.

A 65-second deadline covers digest preparation and transport together, aborts a hung request, and marks any previous group stale without retrying. `requestTimeoutMs` can shorten that deadline but cannot extend it. Selection JSON is capped at 3,900,000 UTF-8 bytes, leaving room for the target/context envelope under the route's 4 MB body limit.

Identical selections do not restart a pending request or implicitly retry a failed one. A deliberate retry can clear then reselect, or a later UI may expose an explicit refresh operation; there is no automatic retry loop. A changed target or context clears all earlier values immediately. A changed selection within the same context preserves the entire last result only as `freshness: stale` while the new request settles. A response failure preserves that same stale group, never half of a newer group. Invalid input clears data and cancels in-flight work.

The host should render `group` as a unit, including its own `binding`, and label stale groups visibly. It must not recolor selected parcels from `requested` while continuing to show the earlier group's numbers. The `requested` input describes pending intent, not the currently displayed evidence. The controller never reports observation previews as report-ready.

## Coherent acceptance

Each operation binds the exact account, assignment, context ID/revision/digest, selection revision, and selection-content fingerprint. SHA-256 is computed with Web Crypto over UTF-8 JSON with no whitespace:

```text
{"pockets":[{"account_ids":[...],"id":"...","label":"..."}],"revision":1}
```

Pockets are sorted by ID and account IDs are sorted using JavaScript code-unit comparison. Labels are not trimmed or Unicode-normalized; invalid text and duplicate pocket/account IDs are rejected. Property key order is exactly as shown. An injected digest is available for tests. This digest detects mismatches; it does not grant access or establish market-data truth. A generation guard checks again after digest completion and transport completion, so cancelled or late promises cannot update a different operation even when the transport ignores aborts.

Both the outer response and `summary.binding` must match. Summary versions, observation-only state, and blocked Apply are checked. The summary producer remains responsible for metric semantics and whitelisting; this controller independently bounds its copy to 2,000,000 UTF-8 bytes, 150,000 nodes, and depth 24. Map payloads are bounded, checked for supported parcel polygon shapes, detached and frozen. There is no geometry repair, simplification, circular fallback, or topology claim.

Initial requests ask for geometry. Later requests may omit it only when a complete available parcel map is cached for that exact target and context. On acceptance of matching new statistics, the controller reuses the same coordinate arrays and updates selection flags/counts together. An omitted map without such a cache is refused. Explicit map unavailability replaces, rather than silently reuses, a previous map and forces the next request to ask for geometry again. An empty pocket selection selects zero accounts; the full parcel outlines remain visible for possible re-inclusion.

## Tests and remaining integration

`dcad-frontend/scripts/testCustomCohortPreviewController.mjs` runs with the existing Node strip-types test suite. It uses an injected clock, controlled transport promises, and the real Web Crypto digest in a dedicated test. Coverage includes debounce, mutation after submission, late success/failure, target/context changes, empty selection, omitted/unavailable geometry, wrong bindings, bounds, failure without retries, disposal, and rendering-callback reentrancy.

These are controller tests, not live browser or appraisal-accuracy acceptance. Mounting the reviewed pocket/map UI with its authenticated transport, source policy, and later explicit coherent report Apply remains the host integration work.

## Authenticated HTTP transport

`customCohortPreviewTransport.ts` posts only `assignment_file_id`, `context_ref`, `selection`, and `include_map` to `/api/accounts/:id/neighborhood-cohort/preview`. Account IDs are encoded as one path segment. It sends one request without retrying 429s or transient failures. The caller's AbortSignal is preserved through token lookup, request, and streamed body reading. A late response after cancellation is discarded and its stream cancelled.

`customCohortPreviewApi.ts` is the configured application caller: it uses the existing `fetchWithApplicationAuthentication` and `makeUrl`, without modifying sessions, cookies, tokens, API configuration, or the shared API module. It intentionally avoids `fetchJSON`, whose independent timeout controller replaces a caller-supplied signal. The preview controller provides this transport's finite overall deadline.

Success JSON is limited to 18,000,000 actual decoded UTF-8 bytes, including when Content-Length is absent or understates a compressed/chunked response. Error JSON is separately limited to 16,000 bytes and user-facing error messages to 500 characters; HTML error bodies are not displayed. The stream has a bounded chunk count, invalid UTF-8/JSON is rejected, and over-limit or cancelled streams are closed. The request body is capped at 4,000,000 bytes.

The cross-layer test additionally runs actual cached row mappings, 80 synthetic transaction observations, the numeric producer, the summary formatter, and exact EWKB parcel-map producer through controller acceptance, then narrows to one pocket and zero pockets. This establishes representation compatibility and no thirty-sale truncation, not source authority or live property accuracy. A mounted application UI and live-file acceptance remain unfinished.
