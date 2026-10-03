# Manual product release approval

The repository owner authorized separating web/backend release decisions from
native mobile releases on October 3, 2026. This is a trusted-maintainer,
manual-merge policy, not an assertion that native vulnerabilities are fixed.

## Required release decision

`HomeNode release approval` is a commit **status**, issued outside candidate PR
workflows by the authorized maintainer after independent review. Publish it on
both the exact PR head and its current tested merge commit. The evidence must
identify the PR, head SHA, current main/base SHA, tested merge SHA and its parents,
review disposition, product scope, and the current audit/test results.

Before merging, verify the actual status creator and linked evidence on both
SHAs. A similarly named check/job, a stale status, or a missing/pending status is
not approval. Candidate workflows must not issue this approval. There is no
automatic merge based solely on a matching check name. This policy assumes the
owner and same-repository workflow writers are trusted; it is not protection
against a malicious maintainer who can change repository settings.

Every existing required check remains required except the globally applied
`pnpm-audit` requirement, which is replaced by this product release decision.
Strict up-to-date checking, PR review-thread resolution, CodeQL requirements,
deletion/force-push protections, and the absence of bypass actors remain intact.
The raw `pnpm-audit` workflow still runs unchanged and remains visibly failed
when it reports vulnerabilities. Its name, threshold, findings and exit status
must not be altered to manufacture a successful audit.

## Web/backend-only approval

The maintainer may approve an exact web/backend-only change despite an existing
native advisory only after verifying all of the following:

- No net changes to native source, manifests, lockfiles, patches, build inputs,
  signing/release inputs or native/shared build configuration.
- Independently reviewed build manifests, lifecycle scripts, lockfiles, imports,
  and actual deployment roots/commands establish that the released web/backend
  artifacts do not consume the affected native dependencies. Path names alone
  are not sufficient evidence of artifact isolation.
- The raw audit is a completed advisory result, not an installation failure,
  network outage, missing report, cancellation, or incomplete evidence.
- All required web/backend/Python dependency checks, builds, database migration,
  authorization/security and product tests pass on the current change. Shared
  backend behavior remains compatible with native clients.
- Every actionable review finding is fixed or explicitly reconciled with
  supporting evidence. No unresolved release-blocking finding is waived.
- The approval explicitly records **native-release-hold**. It does not authorize
  native binaries, EAS or OTA publishing.

Any native/build/policy/unknown-scope change requires separate independent
review; do not infer eligibility from a previous web-only approval. A native
release additionally requires its raw mobile audit to pass. No advisory exception
or upstream-fix claim is created by this policy.

## Freshness and deployment

After final review, fetch the live PR and main state again. Verify that the tested
merge has exactly the expected base and head parents. Publish statuses only for
those exact identities and link the review evidence. Use an expected-head merge
guard; if head or base changes, stop, retest/review the new state, and publish a
new decision. Never copy a prior success to a new commit without review.

Confirm backend migration and route readiness before serving frontend code that
depends on them. Render auto-deploy settings can make a merge itself a release;
temporarily hold frontend auto-deploy when needed, deploy the verified backend
commit first, then the matching frontend, and test only in authorized QA files.
Do not overwrite an appraiser's genuine report for acceptance testing.

## Bootstrap and future automation

During the initial transition, add the new required status while retaining the
old mobile requirement. Independently approve the exact transition tuple and
verify both real statuses before removing only the global mobile requirement.
There must be no interval with neither release requirement present. Preserve
the original ruleset for rollback and compare every unrelated rule unchanged.

The automatic product classifier is a separate, unpublished design draft. It is
not activated by this manual policy. A future trusted-base automation must not
execute candidate code with privileges and must retain explicit status/run
provenance checks or use a genuinely identity-bound trusted publisher. Do not
claim check-name matching alone is source-authenticated enforcement.

GitHub's relevant status/check precedence is documented in
[troubleshooting required status checks](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks).
