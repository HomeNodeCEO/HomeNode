# Custom assignment creation: explicit appraisal date

Live neighborhood QA found that the ordinary chooser created an assignment and
subject snapshot without an effective date. A date entered in the neighborhood
observation period cannot resolve that missing assignment fact. The capture
correctly refused to fabricate it, but the user only saw generic recovery text.

The desktop Custom chooser now requests the effective date before creating the
file. The existing creation transaction records that day in the new appraisal
case and immutable subject snapshot, with the original creation event retaining
the input. The file number continues to use the creation day. Retrospective
dates and leap days are validated, not converted to today. No inspection date is
assumed. Existing files and snapshots are not rewritten.

Uncertain retries in the chooser retain their creation request ID for the same
account, workflow, organization and effective date. A changed date is a new
intent. The server refuses reuse of a Custom creation ID with a different or
omitted date, comparing against the original creation event rather than a later
mutable report state. The creation event, case, snapshot and assignment share
the existing transaction and rollback behavior.

The request field remains optional for existing native callers. UAD and Property
Tax creation receive no new date field or requirement. Organization, role,
assignment access, signing and migration behavior are unchanged.

Validation: focused input and component tests; native mobile workflow integration
asserting case/snapshot equality, same-ID retry and date conflict, and legacy
undated creation; full server/frontend suites and production build. The QA draft
and private source data are not part of this commit.

Remaining: existing undated Custom drafts need a reviewed date-establishment
workflow; this change deliberately does not mutate old case or snapshot dates.
New neighborhood capture performance and older automatic-analysis overlap remain
separate work. Never bypass historical-stock eligibility to make a test pass.
