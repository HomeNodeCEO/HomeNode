# Recorded housing: versioned Dallas County alias

New Custom captures retain an internal housing interpretation choice before
source acquisition. The new dictionary recognizes only the whole normalized
county values `DALLAS` and `DALLAS COUNTY`; normalization remains trim plus case.
The latter is the literal emitted by the local residential-target importer
(`dcad-scraper-with-api/scraper/dcad/import_residential_targets.py`). No numeric
class, generic `SingleFamily` label, attachment, or source permission is inferred.

## Original capture binding and replay

The owner, not an API request or saved editor selection, creates
`recorded_housing_interpretation: {id, revision, content_sha256}`. It is part of
the hashed original acquisition intent and prepare input. The study blob retains
`recorded_housing_interpretation: {profile_ref, definition_blob}`. The original
definition's exact bytes and reference, mapping, intent and study marker must
agree before retained source pages are opened. Missing, replaced, malformed or
cross-mapping originals fail; they never fall back to the old dictionary.

| Housing marker | Reported-sale marker | Study version | Intent version (shared/private) |
| --- | --- | --- | --- |
| absent | absent | 1 | 1 / 2 |
| absent | present | 2 | 3 / 4 |
| present | absent | 3 | 5 / 6 |
| present | present | 4 | 7 / 8 |

No schema, context-header, checkpoint, report methodology, source query, grant,
selection, Apply or signing change is required. Registered operation retries
reopen their original graph. An unregistered retry is a new acquisition attempt
whose new intent pins the current choice; no old blob is relabeled or scanned.

Absent-marker captures always keep housing version1 and their original exact
mapping4/5 profile and stock composition version1. Legacy getters still default
to version1. New marked captures use housing version2:

| Mapping | Profile | Revision | SHA-256 |
| --- | --- | --- | --- |
| 4 | custom-recorded-housing-v3 | 3 | 03857dd5dee53b922f4d4f540c385fb65125ff55300d409af4fe547026fa88dc |
| 5 | custom-recorded-housing-v4 | 4 | 11db17964e872f315959b71c211f8ad6dc434b092508c32713f3928b061dd6ca |

Stock composition version2 (`custom-current-stock-composition-v2`, revision2,
SHA-256 `38c5d3a8f4682e4ccb589148b4bb5d8c43f3545d36746c1fd6dda585eef534f2`)
changes only its id, revision and exact housing profile pair. It retains all
binning, denominators and limits. The existing optional transport slot remains
`stock_composition_v1`; its internal version/profile discriminates old/new
content. Available and unavailable envelopes preserve the same housing/stock
version, including output-byte-limit fallback. Browser checks require the exact
matched pair; recommendation policy v3 and all score weights remain unchanged.

## Limits and verification

This resolves a county vocabulary gap only. Housing remains a current recorded
observation, not verified property classification or retrospective stock. Saved
subject and retained-public observations retain precedence: an explicit Unknown
still blocks CAD fallback even when the new county alias resolves nearby stock.
All parcel conflicts/partial states and current-date safeguards remain intact.
Old captures are not repaired by opening them under new server code.

Focused tests pin full original mapping4/5 housing and stock canonical hashes,
new definition hashes, exact aliases, malformed profile refusal, unknown subject
precedence, full-account/parcel coverage, sync/cooperative/public parity and
versioned unavailable envelopes. Separate retention tests exercise genuinely new
acquisition/prepare/persist/reopen, stored definitions and owner admission;
producer-to-browser tests check both fixed profile pairs. No real appraisal or
production source data is included in these fixtures.
