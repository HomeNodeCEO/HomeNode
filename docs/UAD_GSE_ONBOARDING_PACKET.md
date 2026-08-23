# HomeNode UAD 3.6 GSE pre-onboarding packet

This packet prepares HomeNode to request Fannie Mae and Freddie Mac UAD
Compliance API access. It does not submit an intake form, send an email, accept
an agreement, or request credentials. Those external actions must be completed
by an authorized HomeNode representative when the company is ready.

## Current implementation baseline

| Item | HomeNode evidence | Current status |
| --- | --- | --- |
| Appendix H-1 | Joint-GSE version 1.5, published August 13, 2026; official source and normalized catalog hashes pinned | 728 of 728 active URAR rules cataloged |
| Local mappings | Existing section/editor rules mapped to official IDs | 383 mapped, exact GSE equivalence not yet claimed |
| Remaining reference rules | Official messages and logic available for remediation and response lookup | 345 cataloged as `reference_only` |
| Local delivery | Whole-workfile validation, deterministic XML/PDF/ZIP, official subschema gate, sales-rich SFR evidence | Implemented and tested separately |
| Provider adapter | Separate Fannie and Freddie OAuth clients, bounded responses, immutable correlation history | Implemented, disabled by default |
| Official provider result | Exact XML evaluated by the applicable GSE | Requires onboarding credentials and assigned test environment |
| UCDP/CU/LCA result | Lender or authorized agent delivery through UCDP | Separate from the Compliance API |

The December 2024 rollout announcement described 709 URAR rules. Appendix H-1
v1.4 later added 22 and deleted two; v1.5 deleted one more. The current workbook
therefore contains 728 active rule IDs. HomeNode derives the expected count from
the pinned v1.5 manifest instead of retaining the historical 709 constant.

## Step 1 - official specification evidence

- Fannie Mae UAD documentation:
  <https://singlefamily.fanniemae.com/delivering/uniform-mortgage-data-program/uniform-appraisal-dataset>
- Freddie Mac UAD documentation:
  <https://sf.freddiemac.com/tools-learning/uniform-mortgage-data-program/uad>
- Executable `.xlsx` source used for the import:
  <https://sf.freddiemac.com/docs/xlsx/appendix-h-1-uad-compliance-rules-urar.xlsx>
- Fannie Mae macro-enabled publication of the same joint-GSE document:
  <https://singlefamily.fanniemae.com/media/document/xlsm/appendix-h1-uad-compliance-rules-urar>

The source spreadsheet is not executed. The maintainer importer opens it with
VBA disabled, verifies the version, columns, rule IDs, severity totals, and
deleted IDs, and then generates a deterministic catalog plus an additive SQL
migration. The source workbook remains external; the repository stores its
SHA-256 and the normalized rule catalog.

To repeat a future import from `server` after downloading the official file:

```text
python scripts/importUadAppendixH.py --source=C:\path\to\official-appendix-h-1.xlsx
```

Review the generated catalog and migration. A changed count, column contract,
deleted rule, severity total, or version causes the importer to stop rather
than silently accepting a new contract.

## Step 2 - credentials and intake preparation

Fannie Mae's current public path is:

1. Review the expectations for a new technology service provider:
   <https://singlefamily.fanniemae.com/technology-integration/new-technology-service-providers>
2. Complete the TSP Intake Form when HomeNode is ready:
   <https://singlefamily.fanniemae.com/forms/tsp-intake-form>
3. Use the UAD Compliance API resources and assigned API Developer Portal after
   Fannie Mae accepts the intake:
   <https://singlefamily.fanniemae.com/technology-integration/technology-integration-resources>

Freddie Mac publishes a separate UAD Compliance API System Exhibit and performs
its own verification and credential issuance:

- UAD Compliance API System Exhibit:
  <https://sf.freddiemac.com/docs/pdf/forms/related_third_party_agreement_v5.1.pdf>
- Freddie Mac software-provider overview:
  <https://sf.freddiemac.com/tools-learning/integrations/software-providers>
- Freddie Mac UAD FAQ:
  <https://sf.freddiemac.com/faqs/uad-and-forms-redesign>

Before opening either intake, assemble the following in HomeNode's private
company records. Do not commit the completed answers or credentials:

- legal entity name, DBA/product name, address, authorized signer, and business
  and technical contacts;
- the internal-use and possible customer-use business cases;
- expected volume and any lender/AMC customers intending to use the integration;
- architecture diagram, data-flow diagram, threat model, penetration-test plan,
  incident response, business continuity, retention, and access-control summary;
- UAD version, MISMO version, supported report/property types, implementation
  timeline, staging URL, and demonstration plan;
- evidence from `npm run verify:uad:pre-onboarding` and the sales-rich signed SFR
  workflow; and
- an owner for agreements, technical integration, security review, test-case
  reconciliation, and production monitoring.

The deployment configuration is already prepared for independent provider and
environment credentials. It additionally requires an explicit hostname
allowlist. Production activation also requires a SHA-256 reference to the
external verification evidence. Endpoints, OAuth style, scopes, and credentials
must be copied exactly from the applicable onboarding materials into the
deployment secret manager; HomeNode does not guess them.

Run the disabled-state check before onboarding:

```text
npm run verify:uad:compliance-config
```

After assigned nonproduction values have been stored in the secret manager:

```text
npm run verify:uad:compliance-config -- --mode=activation
```

Neither command prints credentials, client IDs, endpoints, or allowed hosts.

## Step 3 - official scenario harness

The credentialless harness pins the two current public Fannie Mae URAR cases:

- `URAR: No UAD Findings`:
  <https://singlefamily.fanniemae.com/media/document/xml/sf1appraisalv1-no-uad-findings>
- `URAR: UAD Findings`:
  <https://singlefamily.fanniemae.com/media/document/xml/sf1appraisalv2-uad-findings-response>

After credentials are issued, run each case independently against Fannie and
Freddie in their assigned nonproduction environments. The clean case must return
no findings. The findings case must return findings whose `UAD####` identifiers
exist in the pinned Appendix H-1 catalog. Preserve request XML SHA-256, response
SHA-256, HTTP status, environment, timestamps, and provider correlation ID.
Never preserve access tokens in evidence.

The same matrix must then be run with HomeNode's sales-rich signed SFR package.
One provider's pass is never reused as the other provider's pass.

## Step 4 - failure and recovery matrix

The harness defines these required cases before external testing begins:

- malformed XML and local subschema failure;
- invalid or expired OAuth credentials;
- token and submission timeouts;
- oversized or unsupported response bodies;
- provider unavailability;
- duplicate/replayed requests; and
- a workfile revision changing while the request is outstanding.

All failures must remain bounded, credential-safe, correlated, auditable, and
closed to delivery. Provider-specific retry or idempotency behavior will be
implemented only from the assigned contract; HomeNode does not infer it from
another API.

## Step 5 - verification, production activation, and monitoring

Production activation requires all of the following for each GSE independently:

1. the official clean and findings cases pass in the assigned environment;
2. HomeNode's sales-rich SFR passes with expected PDF/XML/ZIP evidence;
3. failures and recovery behavior are demonstrated;
4. the GSE's verification is complete and its evidence SHA-256 is stored;
5. the assigned production endpoint, token endpoint, OAuth contract, scope,
   hostname allowlist, and credentials are in the deployment secret manager;
6. change approval, rollback owner, monitoring owner, and credential-rotation
   owner are recorded; and
7. the global flag and only one provider flag are enabled for the first canary.

The Compliance API evaluates data compliance. It does not submit the ZIP to
UCDP and does not return Collateral Underwriter or Loan Collateral Advisor risk
results. Lender/AMC portal access and UCDP delivery remain separate operational
onboarding tracks.

## Evidence commands

From `server`:

```text
npm run verify:uad:pre-onboarding
npm run verify:uad:compliance-config
npm test
```

The GitHub Actions workflow `UAD GSE pre-onboarding readiness` preserves the
credential-free pre-onboarding JSON artifact. Official GSE results are added
only after the applicable credentials and test authorization exist.
