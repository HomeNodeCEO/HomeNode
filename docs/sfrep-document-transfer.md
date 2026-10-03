# SFREP document and report-field transfer

The Custom Appraisal Document Evidence Center has an **Export to SFREP** action.
Review documents to populate and save the HomeNode Subject and Assignment fields.
Then choose up to ten supporting documents, preview the saved fields, and download an RPTI
package. Appraise-It Pro can open the package as a new report or import it into an
existing compatible report. Original PDFs are included as named PDF addenda when
the source-copy option is selected. This can include engagement letters, contracts,
MLS sheets, CAD records, Realist reports, and other uploaded PDFs.

## First supported form

The first field profile is the legacy FNMA 1004 (09/2011),
`FNMA-1004-0911`. Dynamic UAD 3.6 mapping and the live CefSharp bridge are future
profiles; this package must not be presented as a UAD 3.6 delivery package.
No SFREP runtime, desktop client, or SDK is required on the HomeNode server.

`sfrepReportExport.js` is a pure mapper. Document-derived values must be individually
confirmed and belong to an extraction ready for review; saved appraiser corrections
are separately identified and take precedence. Its field IDs were checked
against the installed Appraise-It Pro 3.7.9 conversion dictionary and SFREP's sample.
The page-one Subject profile extracts address components, borrower, public-record
owner, county, APN, tax year and taxes, CAD subdivision/legal description,
engagement assignment type and lender/client details, explicit PUD evidence,
HOA amount/frequency, and subject MLS listing dates. CAD/Realist PDFs currently use
**Other Appraisal Document**. Their content must identify the source; a filename
alone is not evidence. Unrecognized layouts remain available as PDF addenda.
The preview includes a 17-item Subject checklist, sources, missing fields, and
conflicts. Extraction is not confirmation: review the suggested values first.

Recognized print layouts also include DCAD Residential Account pages whose logo
is image-only, CoreLogic Property Details reports with assessment/tax tables, and
single-listing Matrix headers. DCAD owner names stop before mailing information;
numbered legal lines retain the recorded subdivision. Property Details uses the
latest complete explicit **Tax Year / Total Tax** row, not assessment values or a
jurisdiction's amount. An incomplete latest row is not silently replaced by an
older year. Layout identity, page provenance, and bounded input are required;
mixed or truncated records fail closed. Multi-listing PDFs need separate source
review rather than mixing one listing's identity with another listing's date.
The identity guard covers MLS/Listing #, No., Number and ID labels, inline or
same-page standalone values. Distinct or malformed identities stop extraction;
repeated identical IDs are compatible. An explicitly empty Matrix lease-reference
field does not create a second primary record.

Previously reviewed uploads are not silently reprocessed. Use **Re-run extraction**
to obtain the new Subject candidates; existing confirmations are preserved only
where the new field and value still match.

### Subject identity and date rules

An exact confirmed parcel ID, or confirmed street/unit plus locality, must match
the assignment's canonical subject. Contradictory identity blocks the PDF's
Subject fields; uncertain identity stays unknown. Comparable MLS sheets cannot
populate Subject merely because they are uploaded to the same file. Ambiguous
punctuated unit identifiers are not collapsed into a different unit.
Numeric APNs differing only in hyphen formatting are equivalent without dropping
leading zeroes. ZIP5 and its one consistent ZIP+4 are compatible; the complete
ZIP+4 is retained with its source. Different ZIP+4 values remain a conflict.

The exact assignment's saved effective date takes precedence, including
retrospective appraisals, then its inspection date. If neither exists, the earliest
selected, review-ready subject document's UTC upload date is a visible placeholder.
This does not write or change the report's effective date. Processing/failed uploads
cannot establish identity or supply the placeholder from stale confirmations.

A reviewed subject MLS list date within the inclusive preceding 12 calendar months
supports the offered-for-sale **Yes** checkbox. Missing MLS evidence or an older
list date does not prove **No**. Explicit reviewed negative evidence is supported;
conflicting positive/negative evidence stays unresolved. The composite offering
history narrative is not synthesized from a date alone.

Fee Simple is the requested user default, clearly marked as an assumption rather
than document evidence, and never overrides reviewed property-rights evidence.
HOA dues alone do not establish PUD status: the PUD checkbox needs explicit evidence.
Monthly/annual dues keep their reviewed frequency; quarterly dues are not silently
annualized. Unknown or negative PUD evidence emits no affirmative checkbox.

For legacy UAD, tax and HOA amounts export in whole dollars using half-up rounding
(50 cents rounds up). This is destination formatting only: the original reviewed
value and formatting rule remain visible in the preview and the source evidence
is unchanged. Conflicts are evaluated before rounding, so different cents values
cannot become apparent agreement merely because they round to the same dollar.
Legal-description and owner-name line breaks and tabs are folded into spaces for
their single-line destinations, with the original text retained. Neither recorded
description nor owner identity is truncated; unusually long text still needs a
native layout review. Contract prices and other
amount mappings are not changed by these Subject-specific formatting rules.

The exporter emits no blank field values: empty, unknown, and unconfirmed values
are omitted. Preservation of existing fields during native import into a populated
report has not yet been verified. Conflicting confirmed values targeting the same
SFREP field are omitted and displayed for source selection. A seller is not
automatically treated as the public-record owner;
a buyer is not automatically treated as the borrower. UAD composite listing and
contract narrative fields are not populated with incomplete scalar encodings.
Assignment-type checkboxes export affirmative values only; review existing
alternative selections in SFREP after importing into a populated report.
Explicit reviewed engagement purposes HELOC, RTL, bridge loan, new construction,
rehab, and DSCR export the Other checkbox and description as one coherent choice.
Conflicting purposes suppress both parts until resolved.

## Server boundary

### Saved report ownership

Custom document confirmation writes the reviewed Subject projection to
`app.custom_appraisal_sections` under `report.subject_identification`. Existing
`assignment_files.assignment_details` owns lender/client, assignment purpose and
PUD/HOA choices. These are the same values displayed/edited in Subject and Assignment;
export does not re-populate cleared report fields directly from older PDFs or CAD.
The `urar_subject` object holds borrower, assessor parcel number, tax year/amount,
rights and the prior-12-month listing answer. The account identity itself is not edited.

`report.subject_evidence` is server-owned receipt metadata, stored separately from
editable report values. The manual-section route and validator cannot write it.
The additive `20261028_custom_subject_evidence.sql` permits this key in both section
and section-history CHECK constraints, retaining every prior key. It is registered
in the shared application migration runner; do not deploy writers before migrations.

Candidate review, Subject, Assignment, receipts and history commit in one transaction
under assignment -> workfile -> document -> section locks. Locked/signed workfiles
remain protected. Existing appraiser values and explicit saved Subject blanks are
preserved. Missing Subject fields and initial empty Assignment draft defaults can
fill from reviewed evidence. Contract terms retain their existing path but cannot
override the engagement/appraiser's lender or purpose.

Export reads the saved values and revisions plus all current same-file source
records in one SQL snapshot (50 documents / 200 candidates each / 8 MiB maximum).
Every automatic value is re-proved against its current reviewed source; changed,
rejected, reprocessing, deleted or conflicting evidence cannot authorize an old
receipt. Stale values remain in HomeNode for review but are omitted from export.
Saved manual corrections are identified as appraiser edits, not source-PDF facts.
Unchanged receipts cannot authorize derived listing answers after the effective
date changes. The preview digest binds the saved revisions and the source snapshot.

Document-review responses hydrate only the matching active account/file and newer
section revisions. Manual drafts, navigation, read-only transitions and queued state
updates have independent lifecycle guards. Unsaved edits are not exported; save
them in HomeNode and preview again. Selecting PDF addenda does not choose a different
canonical report value or bypass unresolved source conflicts.

`POST /api/accounts/:id/sfrep/preview` and `/sfrep/export` use authenticated Custom
Appraisal workflow and exact assignment read access. Their input is
`assignment_file_id`, `document_ids`, `include_documents`, and `form_id`; export
also requires the `preview_digest` returned by preview. There is no public download
URL or credential-free source endpoint. Export does not modify the HomeNode report.

The source query scopes every document by account and assignment and excludes UAD
and Property Tax sources. It reads document metadata and candidates in one statement.
A digest ties download to the reviewed source versions, selection, form, and XML.
Original bytes are fetched only after scope checks, then rechecked for assignment,
size and SHA-256 integrity. Originals retain their exact bytes. The package uses
UTF-8 `Report.xml` and deterministic `Pdf/document-ID.pdf` archive paths.

The transfer is bounded to ten source documents, 200 candidates per document,
50 MiB of package payload, a 60-second transfer budget, and two concurrent exports
per server process. Slots remain held while response bytes drain. Stalled downloads
are closed; duplicate simultaneous exports for one file are refused.
All responses are private/no-store. Failures return fixed error codes and do not
expose source text, object keys, or database diagnostics.

## Verification

Tests cover confirmed-only mapping, role distinctions, destination-level conflicts,
date/money formatting, XML escaping, stale previews, assignment isolation, original
PDF integrity, download concurrency, and UI preview/download lifecycle. The sample
generator can create a synthetic package for manual testing in a separate window:

```powershell
node server/scripts/renderSfrepTransferSample.js <output-directory>
node server/scripts/renderSfrepSubjectSample.js <output-directory>
```

The Subject sample runs four generated synthetic PDFs through the actual extraction,
explicit synthetic confirmation, subject-identity, and transfer pipeline. The
automated pipeline verifies all 17 Subject checklist entries, including source
documents and the separately identified Fee Simple default. These are synthetic
test files, not completed appraisals or permission to apply unreviewed values.

A second synthetic PDF pipeline covers the actual print-layout shapes, multiple
public-record owners, display-format differences, and the tax-table boundary.
An additional private local check of seven user-provided PDFs produced 17 Subject
fields without conflicts after **simulated QA confirmation**. All seven original
PDF byte streams were preserved in a local QA RPTI package. Those PDFs, extracted
private contents, and package are outside the repository; no production review
state or appraisal was changed. This verifies extraction and packaging, not final
native form rendering or appraiser approval.

The print-layout and review-hardening follow-up passed 9,023 server tests (46 skipped, zero failures),
3,246 frontend tests, TypeScript, lint, source-size checks, and the production
build/bundle budgets. The private original-PDF package also validates against
the public AIXML 1.5 schema; all 17 exported field IDs exist in the installed
1004 dictionary. These checks do not remove the native-import release gate below.

The later frontend-only review-save correction passed all 3,381 frontend tests
(213 document-center tests; 270 in the related focused suite), plus TypeScript,
lint, source budgets, and the production build/bundle budgets. Another 109 focused
server document, ownership, authorization, and export tests passed with no backend
changes. The stale-save and navigation-lock regressions were reproduced before
their fixes; an independent read-only review reran the 213 document-center tests.

Document-center processing polls only refresh metadata. Same-document retries
and polls preserve dirty review fields and PDF-error messages, without repeatedly
downloading a failed PDF. Explicit selection retries the preview; request-generation
and assignment-scope guards reject late polls and stale responses.
Per-candidate edit versions preserve intent when a server refresh temporarily
matches a draft. Explicit review saves temporarily lock only the submitted fields,
with visible Saving feedback; metadata polls and unrelated fields remain usable.
Locks belong to the original assignment/document until that request settles, even
after switching away and back. A separate selection generation guards the entire
completion, including parent callbacks, UAD follow-on writes, nested reloads, errors,
and loading cleanup, so a late response cannot reopen the previous document or
overwrite the current review.

A successful current review acknowledges only its submitted edits. Failed reviews
and fields outside an approve-all submission remain dirty. If a later refresh shows
a dirty field as confirmed or rejected, its local draft is displayed separately as
an **Unsaved local edit**, including explicitly empty drafts; it is not silently
hidden, confirmed, or applied. Removed candidates and document/assignment changes
reset that state, and the draft notice tells reviewers to copy it before leaving.

The same operation ownership also covers re-extraction, deletion, and manual UAD
apply/synchronization continuations. A completed delete invalidates old metadata
requests so an earlier poll cannot restore the deleted selection. This does not
cancel or roll back an already-sent server mutation when the reviewer navigates.

Date-only and timezone-free printed dates retain their calendar components across
host time zones. Explicit supported numeric offsets retain UTC normalization, and
impossible calendar dates remain unresolved. Subject-only input validation applies
to engagement/MLS and Other reference-source extraction, not the explicitly typed
contract, district, zoning, and map parsers. Source hints cannot override those
explicit non-Subject types. Mixed or incomplete Other/CAD/Realist/MLS input still
fails closed; the separate PDF page/byte/text admission limits are unchanged.

These additional CodeRabbit findings were reproduced before remediation. The
document-center suite now has 307 passing cases (364 related frontend cases),
and the full frontend suite passes 3,475 tests. The final frozen server suite passes
9,099 tests (46 skipped, zero failures). Cross-timezone tests exercise UTC,
Tokyo, and Chicago, including textual GMT/UTC offsets, invalid offsets, and the
legacy contract/MLS extraction paths. A 61-case source-ownership suite includes
real in-memory 251-page PDFs to verify the existing upload rejection remains.
Private original-PDF extraction, byte-preserving packaging, and AIXML schema
validation passed again after the changes; this still is not native import QA.

A later targeted check corrected year-first textual datetimes: the earliest
complete calendar match now supplies both the date components and the time suffix,
so the clock hour cannot be mistaken for a two-digit year. Three cross-timezone
regression groups reproduced the issue before the fix, then passed; 231 related
extraction, reference-source, mapping, and Subject-pipeline tests passed. Calendar,
suffix, and explicit-zone validation remain enforced. This follow-up has no frontend
or stored-data changes. That head passed all five non-dependency CI workflows;
the separate Forge dependency gate remained failing.

### Verified native synthetic QA

Appraise-It Pro 3.7.9 successfully opened the generated
`HomeNode-SFREP-synthetic.rpti` as an isolated synthetic report. Visual inspection
confirmed `Example QA Bank`, the full lender/client address, the selected Purchase
Transaction checkbox, a contract price of `282,500`, and a contract date of
`09/30/2026`. The named **HomeNode QA source evidence** PDF addendum rendered
`SYNTHETIC EVIDENCE - NOT AN APPRAISAL`.

The report was saved as an isolated local `.rptx` and reopened. The mapped fields
were retained and the named PDF addendum rendered correctly after reopening.

SFREP displayed a file-number overflow warning in **UAD Sales Comps Adjustments**
for the long synthetic value `HOMENODE-SFREP-QA`. The value was not truncated.
Do not silently shorten or otherwise alter file numbers to suppress layout warnings;
review their presentation in SFREP.

On October 2, 2026, opening the full four-PDF Subject sample through the Windows
file association succeeded, without relying on the inaccessible nested picker.
All 17 Subject checklist values rendered, including the APN's leading zeroes.
The first import exposed native Number warnings for tax/HOA decimal places and
an Overflow warning that hid the second line of the legal description. These
warnings were reproduced before the destination-formatting correction above.

The corrected package was opened in another isolated Appraise-It Pro 3.7.9 window.
Visual and accessibility inspection confirmed APN `00001234567890000`, legal text
`EXAMPLE PARK 4 BLK 17 LT 36`, real-estate taxes `4,322` from source `4321.50`, and
annual HOA dues `120`. Those Number/Overflow warnings no longer appeared. This
sample deliberately leaves the rest of the appraisal incomplete; this is not a
claim that a complete appraisal passed UCDP validation.

The follow-up passed 9,108 server tests (46 skipped, zero failures), 3,480 frontend
tests, TypeScript, lint, source budgets, and the production build/bundle budgets.
The actual browser dialog displays the exact original value alongside the formatted
tax value and its rounding rule. Private local seven-PDF packaging/schema checks
passed again with byte-identical originals; nothing was uploaded or applied to a
production appraisal. Final-head remote checks are required after publication.

### Actual-document saved-Subject QA (October 2, 2026)

The seven user-provided test PDFs were re-extracted locally, given explicitly
simulated QA confirmations, projected into the saved Subject/Assignment model,
serialized/reloaded, and exported through the canonical saved-report path. This
produced 17 fields without conflicts and preserved all seven original byte streams.
The resulting RPTI validates against the official AIXML 1.5 schema. No production
review state or appraisal file was changed; simulated confirmations are not
appraiser approval, and this local harness is not a live PostgreSQL test.

The actual-document package opened in a separate Appraise-It Pro 3.7.9 report.
Street/locality, borrower, public-record owner, APN, tax year/amount, neighborhood,
legal description, lender/address, Purchase, Fee Simple and offered-for-sale Yes
were visually inspected. The initial owner-name line break caused a native Overflow
warning. The subsequent single-line display correction retained both names and
the exact original source, and a fresh import displayed the complete owner text
without that overflow warning. Seven named original-PDF addenda were present.
The corrected report was saved as a separate private local QA `.rptx`.

Independent review also reproduced and fixed two canonical-boundary errors:
the `property_type=PUD` alias can no longer override a cleared/negative saved PUD,
and saved street text cannot refill or conflict with independently edited locality
fields. Explicit saved owner parties and intentional Subject blanks now follow
the same precedence in the frontend and exporter. A rollback-only PostgreSQL
regression covers the new receipt key, actual writer SQL, section/history/assignment
rows, prior allowed keys, and unknown-key denial. It runs in database CI and skips
locally when no test database is configured.

### Remaining manual checks

Before describing this as fully end-to-end verified, complete these checks in
separate synthetic reports; never use an existing client report as the target:

- Import into a populated synthetic legacy 1004 and confirm omitted values do not
  erase existing fields; inspect mutually exclusive assignment-type checkboxes.
- Check the HomeNode dialog at desktop and narrow widths, including selection,
  preview, cancellation, and download using an authorized QA assignment. Local
  synthetic visual checks passed at 1100, 390, and 320 pixel frame widths, including
  all 17 checklist items, upload-date placeholder labeling, and preview invalidation
  after changing the source-copy option. No horizontal dialog overflow was observed.
  This is not a production API/download test.

Import into an existing populated report remains unverified. The native **Import
Forms** chooser exposed import options, but automation could not reliably select
RPTI because nested-modal focus/actions reset. No successful existing-report import
was observed; this automation limitation does not establish an SFREP defect.

The full Subject sample's initial import and APN display are now verified above.
Its Save As picker and populated-report Import Forms picker remain unreliable
under automation; a manual import into the existing synthetic QA report has been
requested. Save/reopen and preservation of omitted fields/alternative checkboxes
for this newer sample remain separate uncompleted checks. The installed MISMO
dictionary's specialized internal `UadAssessorsParcelNumberField` is not an RPTI
XML element: the public RPTI schema uses `TextField` for static text, and its native
APN rendering was verified without changing that public element type.

### Release gate

The feature and coordinated document-preview/batch-upload integration remain on
the feature branch until the final combined head passes protected checks. The
Python dependency repair pins `pypdf==6.19.0` (the isolated change coordinated from
security PR #1084); it does not import that PR's separate mobile Forge patch or
approve an audit exception. The mobile Forge and braces advisories still require resolution
under the existing release process. Do not disable audits or claim production
availability while that gate fails.

Field mapping evidence and format references:

- <https://api.sfrep.com/rpti/aixml_spec.html>
- <https://api.sfrep.com/rpti/intro.html>
- <https://api.sfrep.com/rpti/sample_rpti.html>
- <https://api.sfrep.com/articles/field_details.html>
- <https://api.sfrep.com/webdocs/object.html>

The next profiles should add verified composite listing/contract mappings, then
dynamic UAD 3.6, and finally live report identity binding and explicit transfer
through SFREP's web bridge. Preserve review/source provenance and the existing
assignment access boundary through each addition.
