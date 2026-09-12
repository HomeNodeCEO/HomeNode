# Broad-boundary subject query regression

Live Custom Appraisal review exposed `42P01: missing FROM-clause entry for
table "subject"` in the older boundary-generation endpoint. Its `raw_boundary`
CTE aggregates `sampled`, but the radial CASE branch referenced `subject.center`
without bringing that CTE into scope. PostgreSQL resolves that reference even
when the nonradial branch would be selected, so both modes failed.

Use a scalar `SELECT center FROM subject`, matching the existing one-subject
geometry fallback. The subject CTE is already limited to one deterministically
selected parcel. No join, candidate population, radius, geometry algorithm,
methodology version, source, authorization, persistence or API contract changes.
This repairs the older generator; it does not replace the new recorded-pocket
map or turn its parcel outlines into legal neighborhood boundaries.

The new PostGIS integration test captures the actual SQL from the public
generator. Only its parcel table reference is redirected to connection-local
synthetic temporary data in a verified loopback `*_test` database. The original
query reproduced the live 42P01 error. The corrected query passes radial,
concave, sparse-subject and missing-subject cases, checking validity, subject
coverage and the requested distance. No production parcel table is touched.
The test is included in the existing database-enabled migration CI command;
ordinary no-database server runs explicitly skip it. Existing mocked boundary
tests continue to cover profile validation and persistence.
