# Mobile offline synchronization

Phase 3 adds a durable, conflict-aware synchronization boundary for HomeNode field inspections. PostgreSQL remains authoritative; the mobile database is an encrypted working cache and queue.

## API

All routes require the existing mobile OIDC bearer token, organization membership, and inspection-session ownership.

- `GET /api/mobile/inspection-sessions/:sessionId/snapshot` returns the session revision, latest synchronized sparse field values, and unresolved conflicts.
- `POST /api/mobile/inspection-sessions/:sessionId/sync` accepts 1–25 ordered operations.

Each operation contains:

```json
{
  "client_operation_id": "uuid",
  "operation_kind": "field.upsert",
  "base_session_revision": 1,
  "payload_sha256": "64-character lowercase SHA-256",
  "payload": {
    "field_path": "inspection.general.appraiser_comments",
    "base": { "exists": false },
    "value": "Observed on site",
    "source_type": "appraiser",
    "appraiser_confirmed": true
  }
}
```

Payload hashes use recursively key-sorted canonical JSON. Repeating the same operation UUID and hash returns the stored result. Reusing an operation UUID with different content returns a conflict.

Supported operations are `field.upsert`, `field.delete`, and `conflict.resolve`. Field paths and payload sizes are bounded. The server records provenance, the appraiser, session revision, operation result, and audit event.

## Conflict policy

The server compares the operation's field-level base with the latest synchronized value. A stale session revision can be safely rebased when that specific value is unchanged. Otherwise the operation is retained as an unresolved conflict and the inspection session enters `review_required`.

Conflict resolution is another idempotent operation:

```json
{
  "operation_kind": "conflict.resolve",
  "payload": {
    "conflict_client_operation_id": "uuid",
    "resolution": "accept_server"
  }
}
```

`accept_server` retains the current HomeNode value. `apply_mobile` requires the current session revision and creates a new applied field edit using the latest server state as its base. Neither path silently mutates the canonical Custom Appraisal or UAD target in Phase 3.

## Device storage and retry

The native app uses SQLCipher-enabled `expo-sqlite`. Its random 256-bit database password is held in the platform secure credential store. Queue rows survive process termination; interrupted `uploading` rows return to `failed` during database initialization.

Retries occur on network restoration, foreground activation, manual request, and a foreground timer. Backoff starts at two seconds, includes bounded jitter, and caps at five minutes. Permanent server conflicts stay visible for appraiser review instead of being retried as last-write-wins updates.

## Deployment

1. Run `npm run migrate:mobile` against staging before enabling the Phase 3 client.
2. Build a development or internal native binary; SQLCipher is not supported in Expo Go.
3. Exercise offline save, application restart, reconnection, idempotent retry, and both conflict decisions with sanitized staging assignments.

