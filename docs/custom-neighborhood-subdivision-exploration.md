# Custom neighborhood subdivision exploration

## Interaction contract

The existing Custom parcel map, colors and report workflow are unchanged. This adds a transient parent/phase review layer over the complete checked recorded-CAD catalog.

- Below map zoom15, a deliberate parcel or parent-label click includes all captured recorded groups in its recognized subdivision family and opens its details. Existing unrelated choices are preserved. Already-included families cause no new save.
- At zoom15 and above, a click only inspects the recorded phase/group. The appraiser explicitly keeps, includes or excludes it.
- Zoom, label toggles, modal navigation, search and list pagination never change inclusion. Saved exclusions survive reopen. Clicking the parent again explicitly includes its captured phases again.
- Keyboard users can select a recorded group in the existing list, then choose **Review subdivision and phases**. This opens details without changing inclusion; **Include all phases** is an explicit equivalent to the broad map action.
- The dialog shows all/partial/no inclusion from the last saved selection, not an optimistic write. Existing save, recovery, read-only and pending-capture guards still apply. A successful saved selection drives one coherent map/statistics preview. Failed statistics inspection does not undo saved choices.

## Identity and evidence

`customCohortSubdivisionFamilies.ts` defines profile1. It never changes accounts, recorded labels, leaf IDs, source authority or persisted selection versions. It recognizes narrow terminal `PH`/`PHASE` plus positive integer1–999, and repeated bare-number candidates such as `EXAMPLE PARK 1` / `EXAMPLE PARK 4`. Case/whitespace and the existing enumerated DFW County suffix equivalence are supported. Directions, punctuation and internal numbers are preserved.

Mixed bare-number and `PH`/`PHASE` names with the same exact base and recognized county identity can share a candidate review family. For example, `EXAMPLE PARK 3` and `EXAMPLE PARK PH 3` remain distinct raw-label phase rows, with separate original IDs and exclusions; the shared number does not establish phase equivalence. Any bare-number member keeps the family's basis `candidate_numbered_name`, independent of catalog order.

Road-number names, ambiguous repeated suffixes within the same grammar, unknown county identity and unsupported suffixes do not create an assumed parent. An unqualified base label remains a separate recorded group; it is not silently absorbed. `NO` is not a supported phase marker: `EXAMPLE PARK NO 5` does not join `EXAMPLE PARK`. Incomplete catalogs retain the existing unresolved-group fallback. Original recorded groups remain visible so an appraiser can still include these cases manually.

Exact normalized full-name records under the recognized county aliases (for example Dallas / DALLAS COUNTY) represent one phase review row with a union of all original leaf IDs. This handles small supplemental rows without dropping the larger CAD group or leaving one county spelling included after phase removal. Same-grammar duplicate suffix wording (`PH 1` versus `PHASE 1`, or `SEC 2` versus `SECTION 2`) remains ambiguous rather than guessed. A bounded terminal `SEC n` / `SECTION n` beneath a numbered phase is retained as a separate child row under the parent; nested unknown syntax is not stripped. Near-map phase labels use one retained anchor across the equivalent recorded rows, and inspection/removal includes all their original accounts.

These are recorded-name review families, **not verified legal subdivision/phase boundaries**. “All phases” means every recognized captured leaf, not properties outside the retained discovery radius/city or phases absent from CAD names. Similar age or nearby geometry alone never joins differently named subdivisions.

Year-built/GLA/site summaries come from the existing exact-union inspection request. Whole-parent statistics use all original account IDs once, not averages of phase medians. Each phase can be inspected independently, including when excluded. Current retained year-built observations are not automatically historical building-stock evidence. Year-built differences remain review evidence and do not automatically discard a later phase.

The optional location review checks complete same-context retained geometry coverage and reports angular bounding extents. It scans actual retained parcel coordinates, not label anchors. Incomplete or wrapped geometry withholds the combined extent. Extent overlap does not establish parcel adjacency or a measured distance between homes, so this advisory is not an automatic name-disambiguation or age/proximity clustering rule. A stronger automatic spatial/age identity method would need its own explicit policy and evidence, not reuse a subject-distance coverage count as phase-to-phase distance.

Existing phase similarity remains explicitly **to the subject property**, not to an invented subject-subdivision distribution or a reliability score. Builder, HOA, amenities and verified zoning remain unavailable where this retained view does not supply them.

## Subject pointer and performance

Every retained parcel belonging to the exact subject account gets a `SUBJECT` pointer at one recorded exterior-ring vertex. Multiple subject parcels are marked individually; absent subject geometry is stated rather than substituting a nearby parcel. This is not a rooftop or surveyed point. Subject marker hit-testing takes priority over an overlapping label or parcel.

The parent label uses an existing child anchor, chosen deterministically by highest captured member count then leaf ID. Parent and phase text share one MapLibre label source and switch at zoom15 using a renderer expression. Zoom/highlighting do not replace parcel geometry, issue source requests or write the checkpoint. All colors remain per original recorded group. Parent inspection requests one no-map union; phase inspection is lazy, not one request per phase on open. Returning to a previously unmounted inspection may reread that summary; no cross-inspection cache is claimed.

## Verification

Focused tests exercise family partition/counts through50,000 accounts and1,024 groups; ambiguous names/county isolation; full geometry coverage and wrapped/missing geometries; map live-zoom clicks; no-write zoom; subject marker identity/hit priority; one guarded family selection intent; coherent saved-ACK behavior; phase exclusions; keyboard/modal/focus behavior; and exact parent-union inspection identity. Existing report calculations, source ingestion, authentication, SQL schemas and report Apply rules are untouched.
