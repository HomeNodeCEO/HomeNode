# Mobile inspection completion

Phase 11 adds a guarded **Finish inspection on site** action to the private
HomeNode mobile client. Completion closes field capture for one inspection
session and hands its selected typed appraisal file to desktop review. It does
not sign, transmit, certify, or submit an appraisal report.

## Two-level readiness check

The phone first checks its encrypted SQLite queues:

- sparse field and repeatable UAD operations have synchronized;
- local field conflicts have been resolved;
- photo drafts are uploaded/verified or explicitly excluded; and
- any saved sketch draft has synchronized.

HomeNode then checks PostgreSQL while holding the selected session and file
boundary:

- unresolved server/mobile field conflicts are zero;
- pending or conflicted proposals for the selected workflow are zero;
- UAD repeatable-entity proposals are resolved for a UAD 3.6 file;
- every registered inspection photo is verified, excluded, or deleted; and
- if a sketch exists, its current revision is appraiser-confirmed.

A missing sketch is disclosed but does not by itself block this lifecycle
transition. The selected report workflow's validation rules remain responsible
for deciding whether a sketch or any other exhibit is required before report
signing or submission.

## API

- `GET /api/mobile/inspection-sessions/:id/completion-readiness` returns the
  current owned session, required checks, open counts, and blocker keys.
- `POST /api/mobile/inspection-sessions/:id/complete` accepts a
  `client_operation_id` and `base_session_revision`. It repeats the prior result
  for the same request, rejects stale revisions, and returns HTTP 409 with the
  latest readiness details when blockers remain.

The successful transaction sets the session status to `completed`, records the
appraiser and completion summary, increments only the inspection-session
revision, and appends inspection and report-file audit events. It deliberately
does not increment the appraisal report's registry revision because no report
content is changed.

Completed sessions are read-only. Existing sparse edits, proposal creation,
photos, and sketches already enforce this lock; Phase 11 also applies it to
manual sketch writes. A later visit uses a new or existing active session on
the appropriate versioned appraisal file instead of reopening or overwriting
the completed field record.

## Identity and deployment boundary

The routes remain behind the existing managed OIDC, organization membership,
and appraiser-role controls. Deploying this phase does not enable the mobile
API. WorkOS staging activation, identity mapping, and
`MOBILE_INSPECTION_ENABLED=true` remain separate deliberate configuration
steps.
