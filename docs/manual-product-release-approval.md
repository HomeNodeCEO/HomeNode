# Product release controls

The owner introduced a manual `HomeNode release approval` commit status on
October 3, 2026 to separate web/backend releases from unresolved native mobile
dependency advisories. On October 4, 2026, the owner explicitly directed its
removal. The status is no longer required by the active **Protect main** GitHub
ruleset (ID `21594102`). Do not wait for, manufacture, or publish that retired
status as a prerequisite to merging a PR.

## Current branch protection

Use the normal protected PR merge path. The ruleset still requires its web,
server, Python, dependency, migration, red-team, and CodeQL checks; current
requirements are authoritative in GitHub. PR review-thread resolution, strict
up-to-date status checks, deletion and force-push protection, and the absence of
bypass actors remain in place. Do not use an administrator bypass to merge a PR
that does not meet the active requirements.

The raw `pnpm-audit` workflow continues to run and display its result, but it is
not a required check for `main`. As of this policy change it still reports two
native mobile dependency advisories. A failing audit must not be relabeled as
passing, hidden, or described as a fixed vulnerability. The removed manual
status does not authorize a native binary, EAS, or OTA release; native release
remains on hold until its dependency findings are resolved and verified.

## Deployment and review

Resolve actionable code and security-review findings before merge. Verify the
current PR head, base, and required checks immediately before merging. A
passing CodeRabbit status may mean its review was skipped or rate-limited; read
the actual review disposition instead of treating that status as substantive
review.

Render auto-deploy can make a merge a production release. For changes that
depend on backend behavior, confirm the compatible backend and migrations are
ready before frontend deployment. Use authorized QA files for live acceptance
testing and leave genuine appraiser reports unchanged.
