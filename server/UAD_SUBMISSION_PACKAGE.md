# UAD 3.6 revision-scoped submission package

HomeNode builds a private, revision-bound delivery ZIP only after the canonical UAD workfile passes every local gate. This workflow is isolated from the Custom Appraisal and Property Tax report paths.

## Required sequence

1. Save the canonical UAD workfile and run whole-workfile validation.
2. Generate and review the native legal-size PDF.
3. Generate MISMO 3.6 XML. The official UAD subschema must pass.
4. Sign the same revision with an immutable appraiser credential snapshot.
5. Generate the submission package.

Package generation refuses stale input digests, mismatched revisions, unsigned workfiles, missing artifacts, failed schema validation, or XML whose external image-reference count differs from the current verified delivery assets.

## Package layout

```text
<file-number>-revision-<revision>.zip
├── <file-number>.pdf
├── <file-number>.xml
└── Images/
    ├── 001-<asset-id>-<sanitized-original-name>
    └── ...
```

`images-manifest.json` is generated and retained as a separate private audit
artifact. It is intentionally not inserted into the delivery ZIP because the
official UCDP examples contain only the XML, PDF, and `Images/` directory.

The XML uses the Appendix A image structure and references external files with `\\Images\...` object URLs. HomeNode maps verified evidence to the subject/comparable property inspection, room, interior component, vehicle storage, amenity, or defect branch based on its canonical entity relationship. Supported delivery MIME types are the official Appendix A image MIME enumerations plus PDF exhibits.

The ZIP writer is deterministic: entries are sorted, stored without platform-dependent compression metadata, and use fixed timestamps. Rebuilding unchanged bytes produces the same SHA-256 digest.

## Integrity and privacy

- All source objects are fetched from private object storage with short-lived signed requests.
- Declared byte sizes and any prior SHA-256 digests must match downloaded bytes.
- A missing asset digest is calculated during packaging and saved back to the verified asset row.
- The public manifest includes package paths, report context, size, and digest, but never private object keys or storage credentials.
- PDF, XML, manifest, and ZIP artifacts use content-addressed, organization/workfile/revision-scoped object keys.
- A package is marked ready and the workfile becomes `exported` only after both manifest and ZIP uploads succeed.

## API

- `GET /api/uad/workfiles/:workfileId/artifacts/submission-package`
- `POST /api/uad/workfiles/:workfileId/artifacts/submission-package`

The response contains separate `manifest` and `package` artifact records. A short-lived download URL is returned only for a ready artifact on the current signed, exported, or submitted revision.

## Important boundary

Local schema validation and package integrity are necessary but do not prove lender or GSE acceptance. External Fannie Mae/Freddie Mac compliance credentials, environment onboarding, submission responses, and any lender-specific requirements remain separate gates.
