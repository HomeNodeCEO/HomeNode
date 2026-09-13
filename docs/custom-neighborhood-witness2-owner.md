# Custom neighborhood source and interpretation dispatch

The Custom owner can acquire the installed combined CAD/raw-sales projection
without changing public capture requests, checkpoints, report schemas or the
map layout. This is explicit server integration, not source-rights provisioning.

## New attempts

`CUSTOM_NEIGHBORHOOD_SOURCE_MODE` is an optional trusted server setting:

| Value | New capture |
| --- | --- |
| absent or `cad4` | Existing mapping4 CAD projection and legacy interpretation |
| `combined-witness2-v1` | Combined mapping5/witness2 projection with the fixed reported-sales interpretation |

An enabled workspace rejects every other value before constructing application
resources. A disabled workspace ignores unused source settings. The default
configuration retains its previous shape. Both policy constructors validate the
trusted dataset/provider profile; invalid Unicode is rejected before startup.
Neither a browser request nor an appraisal file may choose the producer mode.

The combined mode records the exact interpretation reference in intent3 (shared)
or intent4 (shared plus the separate reviewed private import) **before** source
acquisition. Its matching issuer and dense reader use the same caller-owned
repeatable-read snapshot and existing complete membership/transaction closure.
Denied expanded rights never trigger a narrower reader fallback. The retained
study2 includes the actual canonical interpretation definition.

Source, subject, assignment, private-review and transaction fences are rechecked
before registration. Pure graph preparation still holds no database connection.
Failed acquisition is not a partially usable registered study.

## Reopening is independent of the current setting

A registered operation opens its immutable originals first. Source permission
is selected from the original mapping: 1/2/4 use the legacy purpose, 3 keeps its
distinct older witness purpose, and 5 uses the exact combined purpose. The
composition sends every projected purpose exclusively to the fixed witness2
evaluator. Unsupported projected versions deny, never fall back.

The owner verifies bounded original study/intent metadata before opening source
pages, including matching target, dates, subject reference and private presence.
Marked study2 requires mapping5 and its exact original intent3/4/profile. The
definition blob is actually read and compared with the installed fixed bytes.
The full loader then rechecks the complete original graph as before. Unknown,
missing or inconsistent markers cannot silently become legacy studies.

Only the admitted persisted marker selects the Witness2 report builder. An old
unmarked mapping5 capture retains legacy interpretation even when the current
producer is combined. A marked mapping5 capture keeps Witness2 interpretation
after the producer is switched back to CAD4. The fixed definition remains bound
to the report's retained source evidence.

An operation that never registered has no operation-to-orphan-intent index. Its
retry is a new acquisition attempt with a newly recorded intent; it is not an
implicit recovery or reinterpretation of the failed attempt's source evidence.
Concurrent registration still uses the existing exact conflict checks.

## Reports and permissions

Existing stored proposal and replacement retries reopen their original artifacts
without regenerating them. Boundary, selection, populations, statistics and
evidence remain one Apply group. Final source/report/private, editor/workspace,
subject and geography checks continue to guard publication and Apply; failure
rolls back the group. No accepted or signed report is rewritten by configuration.

Live combined acquisition additionally requires the independent exact grant in
`custom_neighborhood_witness2_source_rights_v1` for the real integrated provider
mix, plus the existing separate report/private grants where applicable. Keep the
legacy metadata subtree untouched so old captures retain their exact policy
revision. The source profile and mode setting are not grants. This change writes
no production environment values or organization metadata.

Missing raw units, currencies, dates or prices remain explicitly missing or
unsupported; no value is borrowed from a different field or source. Current CAD
stock is not historical stock. Existing retrospective refusal and all complete
population/resource limits remain. Map/inspection preview statistics retain
their existing interpretation; this source/report integration does not relabel
COD as reliability or implement the future subdivision distribution model.

## Verification

Focused tests cover both producer modes with marked/unmarked originals, old
mapping2/3/4 replay, exact profile-original reads before source pages, closed
browser requests, independent namespace denial and fresh policy checks. Actual
report proposal/Apply/replacement machinery is tested across mode changes,
including lost acknowledgments and rollback after a final permission failure.
Native disposable PostgreSQL tests separately exercise real capture SQL,
registration, exact originals and cross-mode replay; SQL doubles alone are not
treated as isolation or concurrency proof.
