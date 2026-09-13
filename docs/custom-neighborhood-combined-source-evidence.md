# Combined CAD and original sales evidence — preservation slice

Status: **dormant, opt-in infrastructure**. Custom Appraisal still captures
mapping4. This slice does not enable a new report metric, recommendation, source
permission, API mode, or production data read. Existing mapping2/3/4 captures are
never upgraded or relabeled when opened.

## Why a separate version

Existing mappings are alternatives, not cumulative formats: mapping3 retains
original sales scalar witnesses, while mapping4 retains five CAD observations.
Mapping5 retains both. Its typed values and capability gaps are unchanged; its
complete raw projection receives a new version-bound digest. Mapping5 reuses the
unchanged mapping4 admission and interpretation for base observations, rather
than introducing another implementation of CAD normalization.

`cachedSaleWitnessV2.js` preserves the existing 28 literal fields plus independent
`PriceCurrency`, `CurrentPriceCurrency`, and `ClosePriceCurrency` cells. The three
aliases have no precedence. Witness1 remains unchanged for old mapping3 replay.
Only the fixed whitelist is projected from the original stored JSONB payload;
unknown/private payload fields are not read into the application.

Absence, SQL NULL, JSON null, non-object roots, non-scalar cells, oversized cells,
and exact scalar text remain distinct. PostgreSQL converts numeric scalar values
to text before Node receives them. This preserves stored numeric precision, not
the original formatting of a JSON file before ingestion. SQL and application
checks retain the 512-byte scalar and 24,576-byte whole-witness bounds. An overflow
refuses the capture; more fields do not raise a limit or justify truncation.

Canonical sales without a source record have no witness. They do not acquire
fabricated null source fields, a CSV row, or original-source authority.

## Independent access and immutable retention

The opt-in combined reader requires its own original runtime capability. Old
mapping2/3/4 grants and different issuers cannot authorize it. Its exact market
purpose includes `source_projection`:

```json
{
  "id": "cached-combined-evidence-v1",
  "mapping_version": 5,
  "witness_version": 2,
  "fields": ["the fixed 31-field whitelist exported by cachedSaleWitnessV2.js"]
}
```

The example abbreviates `fields` for documentation only; the implementation and
tests require the exact ordered whitelist. The current production policy rejects
this expanded purpose. Synthetic tests explicitly supply a separate test grant;
those callbacks are not production authorization.

Joins, keysets, all-date seeded transactions, one-hop link closure, account
selection, read-only repeatable-read requirements, source clocks and bounds stay
unchanged. There is no new source filtering, provider request or private overlay.
The dense opt-in reader uses the existing dense CAD limits, not larger limits.

The retained query contract admits mapping5 explicitly. Preparation and replay
check every raw row against the complete mapping5 wrapper and digest, along with
all existing source chunks, routing, manifest, query, subject and selection
bindings. Only exact immutable primitive mapper outputs can reuse their own
deterministic mapping result during the current operation. Reopened/copy-created
objects must remap; that receipt never grants source access or original capture
provenance. Actual retention remains under its existing owner's authorization.

## Observations are not verified source meanings

A newer imported raw payload can coexist with an older surviving typed value.
Therefore a new raw currency or unit must not qualify that typed value, even if
the numbers happen to agree. `ClosePrice` and `CurrentPrice` remain independent.
Missing currency is not USD; an arbitrary area label is not established square
feet. A raw closing price used for an in-period closed sale will also require
compatible same-payload closing date and status evidence.

## Activation work still required

1. Review and explicitly version the production source-purpose/exposure policy.
   Keep source rights separate from having a CSV or matching a file hash.
2. Teach the Custom owner to choose the exact expanded purpose from retained
   metadata before loading source pages, with no narrower fallback. Its current
   mapping5 refusal intentionally stays in place in this preservation slice.
3. Add compatible observation, recorded-housing, CAD baseline, presentation and
   frontend contracts together. Do not lose mapping4's CAD observations or
   relabel mapping5 as mapping4 merely to satisfy an old consumer.
4. Separately define and test same-payload price/currency/area/date semantics.
   Do not remove existing unsupported-value warnings based only on retention.
5. Validate native capture, save/reopen, source-rights revocation, coherent map
   and statistics, and unchanged accepted report data on a separate QA file.

Whole-city capacity and business-date applicability remain separate work. This
format is not a cap increase, a historical-property snapshot, or proof that the
neighborhood feature is complete.

## Regression coverage

- V1 golden SQL/output and old mapper source/output parity.
- Exact scalar states, currency conflicts, large numeric text and UTF8 bounds.
- Private getters/proxies, unknown keys and source-less rows fail safely.
- Cross-version/cross-issuer grants reject before reads; production policy denial.
- Actual native SQL and combined reader checks on a verified synthetic database.
- Complete multi-page mapping5 save/reload with original values and hashes;
  tampered literal, witness version, wrapper version or digest refuses before writes.
- Full server, frontend and build checks; no production schema or data changes.
