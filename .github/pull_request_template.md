## Purpose

Describe the user-visible outcome and why this change is needed.

## Scope

- Areas changed:
- Areas intentionally not changed:
- Related issue, task, or architecture decision:

## Validation

- [ ] Backend tests pass (`cd server && npm test`)
- [ ] Frontend builds (`cd dcad-frontend && npm run build`)
- [ ] Relevant frontend test scripts pass
- [ ] I tested the affected workflow manually, or explained why that is unnecessary
- [ ] Screenshots are attached for visible UI changes

## Data and deployment safety

- [ ] This PR contains no secrets, credentials, production exports, or personal data
- [ ] Database changes use a new reviewed migration and include rollback/recovery notes
- [ ] This PR does not run a production migration, backfill, or external write merely by merging
- [ ] Render/environment changes are documented and require separate owner authorization

## UAD / appraisal changes

Complete this section when the PR touches appraisal or UAD behavior.

- [ ] The change follows `docs/architecture/ADR-001-uad-integration-boundary.md`
- [ ] The exact official UAD 3.6 source, appendix/version, and rule identifiers are cited
- [ ] Imported source data remains distinguishable from appraiser-verified data
- [ ] Shared appraisal behavior was not duplicated in a UAD-only implementation
- [ ] New validation or mapping behavior includes regression tests

## Reviewer notes

Call out migration risk, unresolved questions, deliberate tradeoffs, and the best files to review first.
