# Custom neighborhood review-command history

This is an internal persistence component for the saved Custom neighborhood
workflow. A retained review is provenance, **not automatically a supported fact,
market-eligible sale, source permission, signing authority or report acceptance**.
No route or production activation is added by this component.

`createCustomCohortReviewRepository(client, scopeJson)` accepts an exact
organization/report/assignment/account scope and a checked-out transaction client.
`append(commandJson, actorUserId)` takes the existing bounded v1 command grammar;
the authenticated actor must be supplied separately by the authorized owner.
`getOperation(operationId)` retrieves only that scope's immutable history.

## Owner responsibilities

Before any retained MLS evidence read, including retry and history access, the
owner must check the existing application and exact assignment policies plus
independent source-retention/exposure permission. A user display name, role label,
client boolean or previously saved hash is not authorization. The owner retains
finite operation/query/lock deadlines and controls the outer READ COMMITTED
transaction. Success from `append` is `durability: caller_transaction`; the owner
must COMMIT before telling the browser that the review is saved. This repository
must never be exposed as a generic authenticated blob or command-write endpoint.

## Exact binding and concurrency

The writer loads the actual scoped context header and its entire retained graph.
It reuses the existing subject repository to compare actual material inputs and
effective date under the draft/signature guards and ordered target locks.
It then locks the immutable context row; only subsequent statements read the
latest generation and predecessor. An old REPEATABLE READ snapshot is rejected
by the existing subject repository. A savepoint also rejects autocommit before
any read or write and rolls back this group's blobs and row on failure.

New explicit Custom adapter rules:

- One immutable context defines one study: study ID = context ID, definition
  revision = `"1"`, definition hash = retained `header.study_input` content hash.
- The generation is context-wide. Every successful new append increments it once.
- The predecessor is the latest review for the exact subject, claim kind and
  qualifier—not the latest unrelated review in the context.
- Decision ID = operation UUID in this Custom adapter. Organization + operation
  UUID is unique, so a retry cannot silently move to a different file or context.
- Referenced decisions must be exact, same-context, earlier-generation, and not
  superseded when the new review is appended. This is reference integrity, not
  a claim that their contents are true or meet the new claim's factual needs.

Exact command-and-actor retries return their original record before checking the
now-stale generation. They do not write another revision, replay a previous
selection, or recalculate an older diagnostic. Changed commands or actors conflict.
An unknown COMMIT outcome can therefore be resolved by a fresh authorized exact
operation lookup/retry, never by generating a different operation automatically.

## Storage and limits

The new append-only table references the full existing context target, an existing
actor UUID, organization-scoped canonical evidence bytes, and a same-context,
same-fact predecessor. Generations are exact PostgreSQL bigint strings; overflow
is rejected. Canonical review envelopes are limited to 128 KB and retain the
command plus compact observation diagnostic, not another copy of the source graph.
Reopen verifies both blob integrity and agreement with typed index columns.
UPDATE, DELETE and TRUNCATE are rejected even when a statement matches no rows.

The authenticated runtime owner, supported-fact interpretation, recommendation
assembly and report Apply integration remain separate. No accepted report
section, photo, contract, PDF, signature or authentication policy is changed here.
