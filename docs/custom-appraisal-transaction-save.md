# Custom section saves inside an owner transaction

`saveCustomAppraisalWorkfileSectionInTransaction(client, input)` reuses the ordinary Custom section normalizers, account/assignment check, workfile lock, signed-state check, optimistic section revision, values/history writes, and timestamp updates. It accepts the same section input as `saveCustomAppraisalWorkfileSection(pool, input)`.

The existing pool entrypoint keeps its schema preparation, transaction lifecycle, return shape, rollback, and connection release. Existing API routes continue to call that entrypoint. Cost, income, sales-comparison and final-reconciliation calculations are unchanged.

The new entrypoint requires an already prepared schema and an exclusively owned PostgreSQL client in an explicit write transaction. A savepoint rejects accidental autocommit before data writes. The helper never begins or commits a transaction, rolls back the owner's transaction, releases its connection, or grants authorization. On any error, the owner must roll back the entire operation; this includes failures after the helper returns. A returned section is not proof of durable COMMIT.

## Neighborhood integration

The future Custom Apply owner must perform current organization/assignment authorization, validate and lock its original coherent boundary/population/statistics group and revisions, save the complete mapped values, and record the verified acceptance/audit in the same transaction before COMMIT. Any conflict or failed final write must abort all changes. The save helper is not an acceptance token and cannot validate source authority or replace the shared group validator.

At the base of this change, the shared `recordNeighborhoodApplicationAcceptance` writer AND its PostgreSQL trigger deliberately support UAD only. That refusal is preserved. Custom acceptance still requires its separately reviewed persistence integration; do not feed it a UAD identity or bypass the trigger. This change activates no neighborhood route or UI.

Native tests cover explicit-transaction enforcement, uncommitted visibility, a real late SQL failure and full rollback, commit/reopen, stale revisions, multi-save rollback, competing-writer locks, signed-file protection, account mismatch and retained connection ownership. The existing PostgreSQL integration suite calls the same checks with its real synthetic assignment fixture.
