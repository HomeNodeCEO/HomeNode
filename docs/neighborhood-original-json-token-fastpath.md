# Original JSON token fast path

The original-token scanner now takes the exact interior substring for a JSON
string without escapes. Escaped strings still use the original `JSON.parse`
path. The complete grammar scan, Unicode validation, duplicate-key comparison,
UTF-8 charges, numeric checks, failure precedence and all size limits remain.

This is not a cache or a validation shortcut. No new trusted-input mode or
cross-request retained state is introduced. The existing index consumer already
retains its original text alongside the index; keys may share that string's
backing storage and must not be treated as independently sized allocations.

Regression tests compare complete pre-change result bytes/hashes in all three
scanner modes, including every indexed span/counter. Additional tests cover
mixed escaped/plain tokens, alias keys, prototype names, malformed Unicode,
maximum byte/key/node/depth sizes and exact classified failures.

No API, database schema, appraisal calculation, source entitlement or scoring
policy changes. End-to-end latency must be measured separately; fewer per-token
parser calls alone do not establish a production response-time guarantee.
