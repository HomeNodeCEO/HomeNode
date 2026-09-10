# Recorded housing categories for Custom neighborhood review

New Custom neighborhood captures use the existing mapping4 CAD projection. It adds five fixed CAD fields to the retained snapshot: class code, class description, use description, structure description and the local built-up indicator. It does not add MLS fields, expand transaction/account access, or change source-rights policy. Existing mapping2/3 contexts reopen from their original bytes without automatic recapture. Mapping4 remains a current observation, not a reconstruction of historical housing stock.

## Interpretation and scoring

`customCohortRecordedHousing.js` interprets a small versioned dictionary of whole-value labels and documented Dallas legacy categories. Numeric class/structure codes are not guessed. The dictionary distinguishes detached single-family, townhouse, condominium, duplex, apartment, mobile home and manufactured home. A broad one-unit classification does not establish a specific housing type. A category describes recorded housing, not completed construction, unit ownership, verified condition or market eligibility.

The source references are the official [DCAD legacy-to-PTAD cross-reference](https://www.dallascad.org/ViewPDFs.aspx?id=%5C%5CDCAD.ORG%5CWEB%5CWEBDATA%5CWEBFORMS%5COther%5CPTAD_PROP_CLASS.pdf&type=1), effective tax year 2022, and [DCAD's 2025 detached single-family summary](https://www.dallascad.org/ViewPDFs.aspx?id=%5C%5CDCAD.ORG%5CWEB%5CWEBDATA%5CWEBFORMS%5CAVG+HOUSE+VAL%5C2025AvgValSFR.pdf&type=1), which identifies category A11 as detached. Their category meanings do not verify any individual property or historical date. The dictionary identity is hashed as representation provenance, not permission or authority.

All retained parcel observations count. Contradictory known categories remain conflicting; known-plus-unresolved parcels remain partial. No first-parcel choice or majority vote resolves ambiguity. Saved subject housing observations take precedence over retained public observations, then the subject's captured CAD category. Explicit null, blank, unsupported or conflicting saved data is not silently replaced by another source. Source labels and confidence values do not confer verification.

Policy `custom-current-observation-review-v3` keeps GLA 40%, year-built similarity 30%, housing type 20%, and the remaining three factors equally dividing 10%. When both subject and candidate categories are observed, an exact category match contributes the full housing factor and a different category contributes zero. Unknowns remain unscored; the lower/upper similarity bounds retain the missing weight. Every account stays in the denominator. This is an initial review heuristic, not measured statistical reliability or an appraisal conclusion.

The v3 evidence mode explicitly distinguishes housing-only from housing plus recorded parcel-point proximity. No radius is invented when proximity is absent. The public response contains compact coverage and subject-category summaries, not account-level housing lists. Existing descriptive CAD literal distributions remain unchanged and separately labeled.

## Report and operational safety

- Pocket selection does not recapture source data or change the fixed comparison population.
- Boundary and statistics still enter the accepted report as one reviewed group; a new recommendation does not alter it.
- Read-only and historical-stock safeguards, exact assignment/organization access and final source-policy checks are unchanged.
- Existing contexts and v1/v2 recommendation fixtures retain their original version behavior.
- New native tests exercise the actual mapping4 capture, retained replay, category comparison, catalog, PostgreSQL failure/retry and unchanged accepted report.
- The pocket-card layout uses a scoped stacked grid to prevent the global button flex rule from squeezing labels and coverage into narrow columns.

Further source dictionaries can be added only with explicit provenance, unknown/conflict tests and a new interpretation version. Do not silently broaden this dictionary to make more properties appear similar.
