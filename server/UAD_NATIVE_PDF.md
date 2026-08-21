# UAD 3.6 native report PDF

HomeNode renders the Uniform Residential Appraisal Report inside the existing Node service. The UAD renderer is separate from `customAppraisalReportPdf.js`; it does not change the Custom Appraisal or Property Tax outputs.

## Source of truth and gate

`POST /api/uad/workfiles/:workfileId/artifacts/pdf`:

1. Locks the UAD workfile and requires status `ready` or `signed`.
2. Requires a passed, current `local_compliance` run whose input digest still matches the editor, entity, asset, and sketch state.
3. Loads only the current UAD revision and immutable credential snapshots for that revision.
4. Loads verified report images from the private object store. JPEG and PNG display images are embedded; an unsupported original remains visible as an explicit report placeholder and remains preserved for the package workflow.
5. Renders a deterministic 612 x 1008 point legal-size PDF with conditional sections, continued-section headings, revision identifiers, page numbering, report-field labels, exhibits, and signer credentials.
6. Stores a content-addressed `pdf` artifact in the existing private R2 bucket and records its checksum, page count, renderer version, input digest, included sections, image count, and signer count.
7. Returns a short-lived signed download URL only while the artifact is ready and belongs to the current downloadable revision.

`GET /api/uad/workfiles/:workfileId/artifacts/pdf` returns the latest revision-specific result. The UAD editor provides Generate PDF, Regenerate PDF, and Review PDF controls next to the local validation and MISMO XML gates.

Any later UAD field, entity, image, or sketch mutation returns the workfile to draft. A prior PDF remains immutable in storage but is marked non-current by the API and cannot be represented as the current report.

## Layout and image boundary

The renderer follows the current Appendix C / Appendix D dynamic-report conventions: legal-size portrait pages, a Summary, numbered conditional sections, compact field tables, section continuation headings, exhibits, and a revision/footer identity on every page. It renders only saved canonical UAD values and never imports live Custom Appraisal state while creating a report.

Mobile and web clients may preserve high-quality originals in any currently accepted UAD image format. A delivery-ready PDF needs a JPEG or PNG display representation no larger than 12 MiB per image and 100 MiB for all rendered images in one report. The package phase retains the verified originals and produces the image manifest; a later media-normalization enhancement can create display copies without replacing originals.

The PDF is one required artifact, not proof of GSE acceptance. Final delivery also requires schema-valid MISMO XML, image references and package integrity, Appendix H/GSE compliance results, the applicable lender submission path, and the official onboarding credentials described in `docs/UAD_COMPLIANCE_API.md`.

## Verification

Run the deterministic renderer tests:

```sh
cd server
node --test test/uadPdf.test.js
```

Generate the sanitized visual-QA fixture:

```sh
node scripts/renderUadNativePdfSample.js ../tmp/pdfs/uad-native-report-sample.pdf
```

Render every page with Poppler and inspect the PNGs before changing layout primitives.
