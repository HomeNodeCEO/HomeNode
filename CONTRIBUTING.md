# Contributing to HomeNode

HomeNode's `main` branch is production-bound. Render deploys from `main`, so a
branch or pull request is the review boundary for every software change.

## Required workflow

1. Update your local `main` from `origin/main`.
2. Create a focused branch. Use `uad/<short-purpose>` for UAD work and
   `feature/`, `fix/`, or `chore/` for other work.
3. Keep the branch limited to one reviewable outcome.
4. Open a pull request into `main`; never push feature work directly to
   `main`.
5. Complete the pull-request template and wait for all automated checks.
6. Obtain the required HomeNode owner/CODEOWNERS review.
7. Merge only after approval. A branch by itself does not deploy production.

Do not enable auto-merge on a draft or unreviewed pull request.

## Production and data safety

- Never commit `.env` files, database URLs, credentials, tokens, private keys,
  production exports, or personal information.
- A migration may be authored in a branch, but it must not be run against the
  production database without separate, explicit owner authorization.
- Backfills, scrapes, external API writes, Render setting changes, and GitHub
  repository setting changes also require explicit owner authorization.
- Preserve source provenance. CAD, MLS/Trestle, Census/GIS, appraiser-entered,
  and manually verified values must remain distinguishable.
- Do not change the Dallas County scraper, its queue, or its dependencies as
  part of UAD work unless the pull request is specifically approved for that
  purpose.

## UAD work

Read these files before starting:

- `docs/architecture/ADR-001-uad-integration-boundary.md`
- `docs/uad/SECOND_WORKER_HANDOFF.md`

The first UAD deliverable is an architecture and schema proposal. Do not begin
with production migrations, a new service, a PDF renderer, or an XML generator.
All UAD rules and mappings must cite the exact current official specification,
appendix/version, and applicable field or rule identifier.

## Validation

Before requesting review, run the checks relevant to your branch:

```text
cd server
npm ci
npm test

cd ../dcad-frontend
npm ci
npm run build
npm run test:adjustments
npm run test:ratings
npm run test:neighborhood
```

If a check cannot run, explain why in the pull request. Do not silently remove
or weaken a test to make a branch pass.

## Pull-request size and reviewability

Prefer small, staged pull requests. Schema design, migrations, API endpoints,
UI workflows, XML generation, and PDF generation should be separate review
steps unless they are inseparable. Include screenshots for UI changes and
tests for domain rules, calculations, mappings, and conditional requiredness.
