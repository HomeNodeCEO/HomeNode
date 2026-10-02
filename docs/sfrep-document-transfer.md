# SFREP document and report-field transfer

The Custom Appraisal Document Evidence Center has an **Export to SFREP** action.
Choose up to ten documents, preview their confirmed fields, then download an RPTI
package. Appraise-It Pro can open the package as a new report or import it into an
existing compatible report. Original PDFs are included as named PDF addenda when
the source-copy option is selected. This can include engagement letters, contracts,
MLS sheets, CAD records, Realist reports, and other uploaded PDFs.

## First supported form

The first field profile is the legacy FNMA 1004 (09/2011),
`FNMA-1004-0911`. Dynamic UAD 3.6 mapping and the live CefSharp bridge are future
profiles; this package must not be presented as a UAD 3.6 delivery package.
No SFREP runtime, desktop client, or SDK is required on the HomeNode server.

`sfrepReportExport.js` is a pure mapper. Each mapped value must be individually
confirmed and belong to an extraction ready for review. Its field IDs were checked
against the installed Appraise-It Pro 3.7.9 conversion dictionary and SFREP's sample.
Typical currently extracted transfers include lender/client name and address,
contract price and date, reviewed assignment type, and subject address components.
Additional verified mappings cover explicit public-record evidence candidates.
The current CAD/Realist upload path is **Other Appraisal Document**; copying those
PDFs does not imply automatic extraction of every fact inside them. The preview
lists exactly which fields will transfer and which reviewed values lack a mapping.

Empty/unknown/unconfirmed values never clear existing report fields. Conflicting
confirmed values targeting the same SFREP field are omitted and displayed for
source selection. A seller is not automatically treated as the public-record owner;
a buyer is not automatically treated as the borrower. UAD composite listing and
contract narrative fields are not populated with incomplete scalar encodings.
Assignment-type checkboxes export affirmative values only; review existing
alternative selections in SFREP after importing into a populated report.

## Server boundary

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
```

Before describing this as end-to-end verified, complete the following manual checks
in a separate synthetic report; never use an existing client report as the target:

- Open the synthetic RPTI in Appraise-It Pro and verify lender name/address,
  contract price/date, purchase checkbox, and the named PDF addendum.
- Import into a populated synthetic legacy 1004 and confirm omitted values do not
  erase existing fields; inspect mutually exclusive assignment-type checkboxes.
- Check the HomeNode dialog at desktop and narrow widths, including selection,
  preview, cancellation, and download using an authorized QA assignment.

These native-import and browser-visual checks remain unverified in the initial
implementation: the isolated desktop test window was unavailable and the browser
runtime reported no available browser. XML schema/sample validation, automated
unit/integration tests, and a production build are not substitutes for that check.

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
