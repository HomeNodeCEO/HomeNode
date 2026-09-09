# Retained local sale-field witness

`cachedSaleWitness.js` exports a fixed `CACHED_SALE_WITNESS_SQL` expression,
`CACHED_SALE_WITNESS_FIELDS`, frozen byte limits, and
`prepareCachedSaleWitness(value)`. Additive mapping wrappers and an explicitly
selected internal reader can retain this witness. Existing reader/Custom producer
defaults, mapping-v2 bytes, schemas, rights grants and report behavior are unchanged.

## Shape and limits

The closed witness has `witness_version: 1`, `root_state`, `root_json_type`, and
`fields` containing exactly the 28 installed literal keys. Root states distinguish
SQL NULL, JSON null, a non-object JSON value, and an object. Non-object roots do
not provide evidence of field absence; their field states are `payload_unavailable`.
Only a missing key in an actual object becomes `absent`.

Each field contains `{state, json_type, value_text, utf8_bytes}`. States are
`absent`, `json_null`, `scalar`, `non_scalar`, `oversize`, or
`payload_unavailable`. A scalar's stored JSON type remains separate from its text:
blank text, zero, false and null cannot collapse into the same observation.
Objects/arrays retain only their type, not their contents or an inferred taxonomy.

SQL extracts only fixed allowlisted keys from the fixed `src` alias. It does not
transfer the complete raw payload or enumerate arbitrary/private fields. Strings,
numbers and booleans become text in PostgreSQL before the Node JSON parser sees
them. This preserves **stored JSONB scalar precision**, not original provider
bytes. Each scalar is limited to 512 UTF-8 bytes; oversized values retain only
their type and byte count. A 24-KiB total ceiling also counts JSON encoding.
PostgreSQL's JSONB text representation may be larger than compact JSON; its
check is intentionally conservative.

An entire SQL expression result of NULL is reserved for total encoding overflow.
It is not a missing-payload result: that has a complete `sql_null`-root witness.
The validator rejects the overflow sentinel as `witness_byte_limit`. A consumer
must fail the capture atomically, not replace NULL with `{}` or continue with a
silently clipped witness. Invalid shapes, malformed metadata and unknown versions
also reject; valid `oversize`/`non_scalar` entries remain explicitly unavailable
for interpretation. No result claims all sales or source fields are complete.

Admission rejects getters, proxies, nonplain objects and unknown fields before
invoking user properties. It returns a detached deeply frozen result. Text is
literal evidence and must not be rendered as HTML.

## What the witness can and cannot prove

CSV ingestion retains trimmed selected fields, not original CSV bytes; unlisted
headers are discarded. Its `CurrentPrice` can populate canonical `sale_price`.
Trestle retains its parsed record but may use ListPrice when a closed listing has
no ClosePrice, and may derive living/lot area from alternate fields. Its HTTP JSON
parser can already have rounded numeric values before JSONB persistence. Both
ingestion paths replace raw payloads while preserving older typed fields with
COALESCE. A latest file hash, status, provider name or matching typed/raw value
does not prove per-field import lineage or independent corroboration.

Literal keys such as `ClosePrice`, `Currency`, `LivingAreaUnits`, and
`PropertySubType` are retained only if present. This utility does not declare
their official provider meaning, apply default currency/area units, label source
living area as historical GLA, infer closed consideration, or establish market
eligibility. Conflicting fields remain separate witnesses. A future reviewed
resolver needs an independently grounded provider/schema/extractor definition
and exact retained references; provider rights are a separate prerequisite.

## Integration boundary

`createNeighborhoodSaleWitnessSourceReader` requires capabilities created by
`createNeighborhoodSaleWitnessReadAccess`. Its purpose includes the fixed
`cached-sale-scalar-witness-v1` projection and its 28 keys. A v2 capability cannot
authorize v3 reads, nor vice versa; caller fields cannot select a profile. The
existing closed production source policy rejects the expanded purpose unchanged.
Synthetic tests explicitly authorize it; there is no production grant or mount.

The v3 reader extends only the installed transaction SELECT list and requires
the existing `mls_status`, `source_row_number` and `raw_payload` columns. Missing
columns or a malformed/over-budget witness fail the whole capture, without v2
fallback. Other joins, identity closure, keyset paging, query/byte limits and
source dates are unchanged. The v2 default uses its original SQL and mappers.

The unchanged `local-capture-v3` envelope now explicitly admits mapping3 as well
as old1/2. Original-input retention validates v3 row wrappers against the
installed mapping and reopens their exact hashes. Authorized reopen selects its
purpose from bounded immutable compact metadata before any retained MLS graph
load, not from the current factory default. Old v1/v2 bytes are never relabeled,
remapped or enriched. Existing preview/catalog and sale-meaning consumers remain
v2-only; a supported v3 interpreter and intentional Custom activation come next.

Focused tests cover shape, precision, presence, bounds, privacy vocabulary,
non-invocation of getters/proxies, original v2 behavior, cross-profile denial and
original-input retention/reopen. `cachedSaleWitnessDatabaseChecks.js` runs the
actual expression over literal synthetic JSONB values, testing precise numeric
text, null/non-object roots, private-field omission and both byte-limit guards.
These checks establish local observation integrity, not provider truth.
`cachedSaleWitnessReaderDatabaseChecks.js` additionally runs the actual extended
reader and one-hop identity resolver in one caller-owned read-only snapshot,
checks the original one-use handoff and all row/query/source hashes, and confirms
that conflicting source/canonical prices remain unresolved observations. Both
native helpers run through the existing canonical-migration integration wrapper.
