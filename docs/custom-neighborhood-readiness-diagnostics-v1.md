# Custom neighborhood report readiness diagnostics

Incomplete reports keep the existing generic candidate issue and append the
checked geographic-neighborhood reason codes after full publication and
candidate validation. Codes are deduplicated in their original order. This
explains missing cardinal descriptions or a boundary that does not cover the
recorded subject point without exposing saved free text or source payloads.

This projection changes only the outer diagnostic list. The candidate,
assessment, publication bundle, binding and ready-report results are unchanged.
It does not make incomplete geography acceptable, skip any source or membership
validation, or publish a partial boundary/statistics group. The owner still
rechecks rights and file state before returning even an incomplete response.

Regression tests pin pre-change full content excluding only the intentionally
expanded diagnostic list, and retain complete ready-result hashes. Coverage
includes both sale interpreters, synchronous/cooperative parity, cancellation,
malformed-input precedence, final authorization/state fences, private-text
omission, no publication writes on incomplete results and exact saved replay.

This improves the explanation of a checked refusal; it is not a timeout or
large-population performance fix.
