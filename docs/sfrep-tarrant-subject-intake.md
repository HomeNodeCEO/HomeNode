# Tarrant CAD and appraisal-order Subject intake

The legacy 1004 and 2055 use the same reviewed Subject projection. This change
does not add a form-specific exception, new OCR dependency, database migration,
or shared-account write.

## Source handling

- The True Prodigy Tarrant **Property Summary Report** PDF stores labels before
  values in its text stream. The adapter reads first-page label/value geometry,
  separates ACCOUNT / OWNER columns, and uses LOCATION rather than the owner's
  mailing address. Property ID must agree with the printed PID header. Legal
  and neighborhood come from the legal description. County requires the printed
  Tarrant County taxing unit, not just the provider's branding.
- A Values-only print can suggest its PID but cannot supply missing owner,
  legal, or situs information. A PID alone cannot prove that a namespaced
  HomeNode account is the PDF's subject.
- Internal Tarrant `TA` plus 15-digit account keys are not county APNs. Do not
  derive a Property ID by stripping prefixes/zeros. Without an explicit native
  county ID, an exact subject street/locality match is still required. Known
  contradictory native IDs remain quarantined.
- The verified E Street appraisal-order layout reads the explicitly labeled
  property-address row, not the following `( Additional Resources )` label.
  Bounded multiline client fields retain their continuation text. Borrower is
  page-cited from its labeled row. Multiple property-address records fail closed.
- A printed Foreclosure, Liquidation, or REO purpose becomes the existing Other
  assignment choice plus its exact explanation, not Purchase or Refinance.
  Both Other fields must survive review and conflict checks together. Purchase,
  Refinance, and the existing supported loan purposes retain their vocabulary.

## Review and export

All extracted values remain suggestions. Normal appraiser confirmation persists
assignment-scoped report values and evidence receipts. Re-extraction invalidates
changed candidates; it does not silently approve them. Manual edits, explicit
blanks, signed-workfile locks, wrong-property checks, input bounds, and source
priorities remain in force. Optional RPTI PDF attachment selection is independent
of field extraction and persistence.

Realist remains the latest tax-year/total-tax source. The matched HomeNode Census
lookup remains the tract source. Under the user's requested date-window rule,
a reviewed terminal MLS status and an end date before the prior twelve-month
window default the offering checkbox to No. An old listing whose reviewed end
date overlaps the window defaults to Yes. An old start date alone, unknown end,
active/ambiguous status, conflicting dates, or a future date cannot establish No.
The No default retains all source/date receipts and a source-limited review flag:
an uploaded historical listing is not a comprehensive search for other listings.
Appraiser overrides remain authoritative and dated-source changes invalidate
stale receipts. No additional listing history or missing facts are invented.

`server/test/tarrantSubjectIntake.test.js` uses synthetic geometry and generated
PDFs to exercise stream-order handling, identity isolation, mixed/oversized input,
assignment continuations, Other pairing, saved receipts, and equal 1004/2055 XML.
Original appraisal documents and private QA exports must not enter the repository.

## Browser/export contract

The browser accepts both reviewed and saved historical-listing receipts only
under the explicit ended-interval rules. It verifies the calendar window,
terminal status, coherent start/end dates, candidate/document bindings, every
historical source group, and the Yes/No destination. A pre-window start date
alone still cannot imply No. Fields-only exports retain this evidence without
requiring the source PDFs as report addenda. The public preview producer is
tested against the actual browser validator for both 1004 and 2055 forms.
