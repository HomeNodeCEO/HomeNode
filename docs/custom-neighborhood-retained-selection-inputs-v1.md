# Custom neighborhood retained selection inputs

This slice connects the complete original `local-capture-v3` query evidence
bundle to the retained Custom subject inputs introduced in PR #668. It is an
internal retention repository, not an activated neighborhood workflow or the
accepted c74 issuer-context contract.

## What is retained

`createCustomCohortSelectionRepository(client, scopeJson)` uses the same closed
organization/report/assignment/account scope and existing immutable blob store
as the subject repository. `retain(subjectReference, originalBundleJson)`:

1. Runs the existing full query-evidence validator, preserving the original
   compact metadata, both selection hashes, every account and every page.
2. Preflights all immutable storage representations before inserting anything.
3. Requires an actual caller-owned PostgreSQL transaction and loads the original
   subject bundle with current file/organization/account integrity checks.
4. Requires exact organization, case, snapshot, account, Custom report,
   assignment and effective-date agreement between those original inputs.
5. Stores the original constituent blobs and a small immutable reference index.

The reference index uses `selection_input_version: 1` and
`usage: retained_selection_inputs_only`. It is deliberately NOT a
`SelectionInputBlob`, `ContextRef`, private acquisition handle, licensed-source
grant, or current-head selection. Its hash establishes retained-byte identity
only. The returned load result explicitly says `authority: not_established`.

## Reload and failure behavior

`load(selectionReference)` rechecks actual target integrity, follows the original
subject and query blobs, then runs the same whole-bundle validator and target
comparison again. It does not query today's sales, replace the subject snapshot,
repair account ordering, drop missing pages, reduce the sample, change dates, or
turn unknown coverage into complete coverage. Missing or corrupt input fails
the whole load. Changing current physical inputs or archiving the file does not
rewrite history; caller-owned current read permission is still required.

The existing limits remain in force: up to 50,000 selected accounts, 1,000
accounts per page, bounded complete evidence and individual storage blobs.
Overflow is refused, never truncated. The caller must bound the whole operation
and roll back on any error. The repository does not acquire/release clients,
commit/roll back, retry a source query, run migrations, mutate current heads or
change appraisal fields. No HTTP endpoint or authentication policy changes.

## Verification

- Complete 3-, 1,001- and 50,000-account round trips and exact replay.
- Wrong report, assignment, case, snapshot, organization, account, workflow and
  date cannot be paired even when query hashes are self-consistent.
- Missing pages, corruption, substituted hashes, duplicate refs and invented
  authority fields fail explicitly.
- Autocommit refusal and original database error propagation without retries.
- Ordinary CI-only PostgreSQL: complete multi-page commit/reopen, foreign target
  denial, historical reads after current edits, and rollback of an alternative.
- Shared synthetic fixtures reduce test duplication; they are not source or
  license evidence.

## Remaining integration

The sole active Custom task still needs to install the actual immutable issuer
context/study settings, original private acquisition lifecycle and deadlines,
source/fact support, numeric normalization, and one coherent boundary/pocket/
statistics Apply-save-reopen operation. Do not mount this repository directly
as a generic blob endpoint or treat a retained query index as permission to use
MLS data. Current-access checks and original source/license provenance belong
to the coordinated runtime, not to hashes or caller-supplied flags.
