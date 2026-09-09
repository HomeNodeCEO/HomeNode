# Custom recorded-pocket exploration workspace

`CustomCohortWorkspace` is an independent controlled exploration surface. Its
inputs are exact account/file identity, a retained context reference, a session
identity key, subject label and an explicit enabled flag. The production report
host is not mounted in this slice: authorized context acquisition/reopen and the
integrated market-source rights/inventory configuration remain prerequisites.
This is not completion of the supported assessment/recommendation/Apply feature.

The workspace requests the authorized recorded-name catalog once per retained
context. Equivalent React prop objects or unrelated autosave renders do not
reload it. Session, file or context changes unmount the request owners and clear
old data. There is no localStorage or workfile write callback. Failed requests
have explicit retry buttons; they do not automatically loop or retry 429s.

## Broad start, explicit inclusion

Every discovered account initially participates, including unresolved recorded
names. No 30-sale cap, target sale count or silent sample clipping is used. Named
groups come from retained CAD observations, separated by recorded county. An
unresolved group remains visible for missing/conflicting names. Colors mean
included, excluded, unresolved, inspected and subject—not unsupported similarity.

The main request sends one exact union of selected accounts. This avoids losing
unresolved members when there are 128 named groups plus unresolved observations.
The backend still computes the full all-observation baseline and selected union
from the retained context, counting each transaction/account according to its
existing population rules. Clearing all sends a genuine empty selection.

Clicking a parcel or list item identifies its recorded group. A separate
inspection request shows that group's numeric observations without adding it to
the main selection. Inspection never downloads parcel geometry; it verifies the
same target/context/revision/content binding used by the main controller.
Changing inspected group cancels/invalidates the old response. Missing builder,
HOA, amenities, legal phase identity and recommendation facts remain unknown.

## Exact map and coherent numbers

The map uses the captured original parcel FeatureCollection, preserving holes
and disconnected parts. No convex hull, buffered point, rectangular envelope or
circular substitute is drawn. Panning/zooming never changes membership or
requests more sales. New selection colors and statistics come from one accepted
controller group. Previous results stay explicitly stale until replacement;
the map hides intermediate repainting. Feature-state updates reuse unchanged
geometry instead of resending it to MapLibre on each toggle.

The basemap loader shares the existing pinned MapLibre version and DOM resource
keys, without mounting legacy market analysis, draft hydration or save effects.
Runtime failure leaves a keyboard-accessible group list and clear map error,
not an invented boundary.

Statistics use server-formatted numbers with separators and at most two decimal
places. Current CAD, recorded transactions and source-reported observations
remain separate populations. Package consideration is not presented as a
single-property sale price; unknown currency is not assigned a dollar sign.
Median is not automatically predominant value, and COD is not reliability.

The requested appraiser-reviewed recommendations, supported metrics, accepted
boundary/statistics group, city-wide expansion, source-rights activation and
live-property acceptance testing are still separate work. This workspace does
not overwrite or print an accepted neighborhood report.
