# Custom retained sale meaning: local observations

`createCustomCohortSaleMeaningResolver(preparationInput)` constructs the existing
exact-context decision-evidence resolver internally. `deriveEvidenceRef(sourceRef,
recordId)` and `resolveMeaning(JSON.stringify(reference))` use its seven-part
immutable captured-record address. No caller-selected profile, `supported` flag,
provider classification, database connection or source query is accepted.

The installed `getCustomSaleMeaningProfile()` is a content-addressed versioned
definition of **local mapping-v2 column meaning**, not a provider dictionary or
permission grant. Each result binds the context, target, study, complete evidence
reference, candidate key and profile digest. Existing capture versions are not
rewritten; unsupported mappings reject, without guessing a compatible version.

## Implemented interpretation

- Source and canonical closing-date columns remain separate exact date observations.
- CurrentPrice remains current-price evidence, never a verified ClosePrice or
  automatic substitute for a missing canonical sale price.
- Price and area decimals keep their original string/scale. Comparison removes
  only insignificant trailing fractional zeros and does not use floating point.
- Source living/lot-area magnitudes retain unknown units; living area is not
  certified GLA at sale. Zero DOM is a real observation; invalid, blank, absent
  and SQL NULL are distinct. DOM counting/reset convention remains unverified.
- Structural style, derived housing description and attachment description are
  literal strings, not a verified housing taxonomy or an eligibility decision.
  A local `listing` marker does not mean an active listing as of a historical date.
- Canonical/source date, price and account disagreements are explicit. Missing
  and invalid comparison fields remain counted. Agreement is not independent
  confirmation: ingestion can have copied one value to both columns.
- Comparison membership comes from the same retained canonical identity, not a
  price/address heuristic or asserted economic equivalence. Current closure
  admission rejects duplicate canonical IDs before any partial interpretation.

The output is bounded to 32 KiB and never includes full raw payloads or source
remarks. Comparisons over more than 1,000 same-canonical records fail atomically;
no first-30/top-N sample or silent clipping is used. This is internal output;
literal text must still be rendered as text, not HTML. Results remain
`observations_only`, with unknown provider meaning, currency, source-area units,
historical applicability, completion, consideration, transaction equivalence,
economic-property membership and market eligibility. No assessment or Apply is
created, and no accepted report data is changed.

## Concrete path to source-supported interpretation

The actual CSV importer (`dcad-scraper-with-api/scraper/dcad/import_sales.py`)
uses `MlsStatus == Closed` for its local closed-sale marker and writes
`CurrentPrice` to the canonical sale price. Its stable row hash may be an MLS
identity rather than row content. Reimports overwrite the latest file SHA and
`raw_payload`, while COALESCE retains older typed fields. Consequently a latest
CSV SHA alone cannot attribute every current value to that file/revision.
Trestle can also fall back from absent ClosePrice to ListPrice for a closed row;
agreement with a canonical price is therefore not proof of closing consideration.

The separately installed mapping3 capture extension now retains `mls_status` and an allowlisted
source-field witness from **existing** `raw_payload` columns; it need not expose
all raw payload/private remarks or initially change the database schema. Compare
each typed value with the exact witnessed raw field under an installed extractor
revision. A blank/missing/mismatched latest raw field cannot claim an older
COALESCE-preserved typed value. Preserve its generic stored observation instead.
That extension uses an explicit new projection version and retains old v2
behavior; it does not retrofit evidence into old contexts.

Once genuine exporter/provider definitions are available, bind each reviewed
meaning profile to an explicit provider/schema/extractor revision and immutable
field witness. This can establish what an ordinary source-reported date, price,
area or housing code means once for that source revision. It does not establish
historical physical condition, parcel allocation, complete economic interests,
or acceptable market conditions by itself. Current CSV retention discarded unit
headers and has no per-field import lineage; missing original meanings require
the original export/configuration or prospective immutable import observations.
Neither this module nor a source-rights activation fills those evidence gaps.

## Mapping3 literal-witness interpretation

`createCustomCohortSaleWitnessMeaningResolver(preparationInput)` in the additive
`customCohortSaleWitnessMeaningResolver.js` follows the same exact retained-record
binding. Its installed `getCustomSaleWitnessMeaningProfile()` is separate from
the unchanged v2 profile. Original mapping3 records are required: caller flags,
old v2 records, mixed versions or a forged source reference cannot select it.

The result retains all 28 literal witness keys with their original JSON type and
presence state. Missing keys, SQL/JSON null, blank strings, numeric zero, false,
non-scalar fields and oversized fields remain distinguishable. Interpretations
and exact typed-to-literal comparisons are diagnostics, not a provider data
dictionary or proof that the latest raw field originally supplied a coalesced
typed value. ClosePrice, CurrentPrice and ListPrice remain separate fields;
neither missing price nor unit is filled from a different field or default.

An observed `USD`, `Closed` or area-unit string remains source-reported literal
text. It does not authorize exposure or certify currency, completed sale status,
historical GLA, complete interests or market eligibility. The output remains
observations-only with blocked Apply. It is not selected by a public route or
default producer in this change.

Observation preview/catalog consumers can now follow the original mapping3
metadata without modifying old snapshots. They still show current CAD records,
stored canonical transactions and source observations as distinct populations,
not a supported report assessment. No statistical formula, legal subdivision
claim, recommendation selection or accepted report field changes here.

V2 tests retain the unchanged `decisionEvidenceFixture`. The isolated mapping3
fixture executes its installed reader/access plus actual capture/persist/reopen
contracts over bounded query fakes, with synthetic selected witness cells. It
does not relabel the v2 fixture or pretend to validate the real SQL expression;
the separate native witness tests cover that expression. No live source grant
or production activation is introduced.
