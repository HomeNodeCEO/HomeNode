# Custom neighborhood atomic persistence

`saveCustomNeighborhoodAcceptanceInTransaction` joins the real Custom workfile
section save with the immutable neighborhood acceptance repository. It is an
internal persistence service, not a browser Apply endpoint or an authorization
grant. The source/context/catalog and frontend integration still need completion.

The owning workflow must authorize the original user and exact assignment, resolve
and lock current source/editor state, validate the complete mapped group against
actual existing fields, and generate the shared application receipt before calling
this service. It must prepare the schema before its transaction and must commit
successfully before sending a successful response to the browser.

The service accepts only exact organization/report/assignment/attachment/operation
identities, original actor ID and validated receipt. It reloads the stored attachment
and reconstructs the complete section. It does not accept a browser's account ID,
reviewer name, section value, field mapping or history ID.

- First save uses `saveCustomAppraisalWorkfileSectionInTransaction` with the existing
  section-size limit, signed-state check, row locks, expected revision and history.
- Its exact history lookup and acceptance write use that same checked-out client.
- A failed step rolls back to the group's savepoint, including a late native
  acceptance failure. The outer transaction remains the caller's responsibility;
  rollback failure is reported explicitly, never converted to save success.
- An exact retry validates the stored acceptance without adding section revisions,
  history rows or timestamp updates. A changed actor, group, target, signed state
  or later section revision is not treated as that retry.
- Exact reopen uses the acceptance repository's complete stored group validation;
  no account-level or latest-result fallback is introduced.

The return value describes a transaction-local result until the owner commits.
Ordinary section saves now reject the reserved `neighborhood_assessment` section
before database work. Its existing HTTP route returns 409 with
`custom_neighborhood_acceptance_workflow_required`; other sections keep their
existing behavior. This prevents manual/autosave/legacy-import calls from silently
replacing an accepted group outside this workflow. Frontend rendering, UAD mapping,
authentication middleware and signing permissions are unchanged. Do not wire this
service directly to an unvalidated browser receipt. Legacy hydration protection
and real-file browser acceptance tests remain required before enabling the new
Apply workflow.

Tests exercise the actual save/acceptance modules together with query doubles and
with native PostgreSQL, including rollback, lock-timeout contention, exact
retry/reopen, signed/stale state and wrong-organization rejection. Synthetic fixtures are not
evidence of live source accuracy or appraiser review.
