# Appraisal History and Safe Replication

HomeNode keeps a reusable property identity while treating every appraisal assignment as a separate, time-specific record. The history and replication layer applies only to Custom Appraisal and UAD 3.6 files; Property Tax Protest remains unchanged.

## Data model

- `app.appraisal_cases` represents one appraisal assignment and its purpose and relevant dates.
- `app.appraisal_subject_snapshots` stores an immutable, report-specific capture of the subject facts used for that assignment.
- `app.report_files.appraisal_case_id` and `subject_snapshot_id` connect existing Custom and UAD files to that history without replacing their current canonical data.
- `app.appraisal_file_replications` records the source, target, mode, attestation, prior snapshot, and whether mutable subject data was copied.

The migration is additive. Existing property, Custom Appraisal, UAD, and tax-protest records are not deleted or rewritten. Existing Custom and UAD report files receive a distinct historical case and snapshot during backfill.

## Replication modes

### New assignment template

This is the safe default for a later appraisal. It creates a new appraisal case and captures the target's current facts. The earlier snapshot is retained for review, but condition, quality, GLA, parcels, legal descriptions, improvements, photos, sketches, and other mutable facts are not silently copied into the new assignment.

The UI presents prior-versus-current summary differences and marks the new file as requiring change review.

### Same-assignment alternate format

This creates the other supported report format for the same assignment. It requires an explicit attestation that the assignment and effective-date context are unchanged. The two files share the same appraisal case and subject snapshot. Conflicting dates are rejected.

This mode establishes safe identity and lineage. Full field-by-field transformation between Custom and UAD report schemas belongs in the shared report-completion adapter phase; it is not inferred by this history layer.

## API

- `GET /api/accounts/:accountId/appraisal-history` lists Custom and UAD files, snapshot summaries, prior/current differences, and lineage.
- `POST /api/accounts/:accountId/appraisal-history/:reportFileId/replicate` creates a guarded replication target. It uses the existing editor-key protection.

New Custom and UAD files created through mobile or desktop entry points are registered automatically. History summaries include condition, quality, GLA, aggregate site size, parcels and legal descriptions, verified photos, and sketch availability when those values exist in the source workflow.

## Deployment

The server migration registry includes `20260920_appraisal_history_replication.sql`, so the existing mobile migration command applies it idempotently:

```bash
cd server
npm run migrate:mobile
```

The database role needs the same schema-change privileges used by the earlier mobile and UAD migrations.

## Next integration phase

Build shared, versioned report-completion adapters above the existing Custom logic. Those adapters should produce a canonical analysis result for neighborhood and market analysis, comparable discovery and ranking, adjustments, reconciliation, and location influences, then map that result into Custom and UAD classifications separately. Assignment-scoped subject facts must always come from the selected snapshot, never from a timeless property row.
