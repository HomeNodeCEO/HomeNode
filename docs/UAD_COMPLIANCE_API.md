# UAD 3.6 Compliance API readiness

HomeNode's internal use of its own appraisal application does not require the
software to be sold or endorsed. Production access to a GSE UAD Compliance API
does, however, require the applicable GSE onboarding and verification process.
Credentials are an integration dependency, not a prerequisite for building the
editor, local rules, MISMO XML, subschema validation, or native URAR rendering.

## Delivery sequence

1. Keep Appendix A field mappings and Appendix H rules versioned by UAD release.
2. Require a persisted, passing whole-workfile local validation run for the
   current locked revision (see `UAD_LOCAL_VALIDATION.md`).
3. Generate deterministic MISMO 3.6 XML from that revision.
4. Validate well-formed XML and the current GSE UAD subschema locally.
5. Complete GSE technology-provider onboarding and obtain nonproduction
   application credentials for the assigned ACPT/CLVE test environment.
6. Submit the official scenarios, reconcile Compliance API findings with local
   results, and retain request/response correlation metadata without logging
   access tokens or sensitive report contents.
7. Complete verification before production credentials are enabled.
8. Store production credentials only in the deployment secret manager, rotate
   them independently for each GSE/environment, and keep the integration behind
   a disabled-by-default feature flag.

The Compliance API is a delivery gate. It does not replace HomeNode's local
validation engine, because the editor must give appraisers actionable feedback
before an appraisal is submitted.

## Configuration contract

The planned adapter supports separate Fannie Mae and Freddie Mac credentials.
No endpoint or credential is committed to the repository. The official values
provided during onboarding will populate these deployment secrets:

- `UAD_COMPLIANCE_API_ENABLED`
- `FANNIE_UAD_COMPLIANCE_ENVIRONMENT`
- `FANNIE_UAD_COMPLIANCE_BASE_URL`
- `FANNIE_UAD_COMPLIANCE_TOKEN_URL`
- `FANNIE_UAD_COMPLIANCE_CLIENT_ID`
- `FANNIE_UAD_COMPLIANCE_CLIENT_SECRET`
- `FANNIE_UAD_COMPLIANCE_SCOPE`
- `FREDDIE_UAD_COMPLIANCE_ENVIRONMENT`
- `FREDDIE_UAD_COMPLIANCE_BASE_URL`
- `FREDDIE_UAD_COMPLIANCE_TOKEN_URL`
- `FREDDIE_UAD_COMPLIANCE_CLIENT_ID`
- `FREDDIE_UAD_COMPLIANCE_CLIENT_SECRET`
- `FREDDIE_UAD_COMPLIANCE_SCOPE`
- `UAD_COMPLIANCE_API_TIMEOUT_MS`

## Official starting points

- Fannie Mae UAD resources:
  <https://singlefamily.fanniemae.com/delivering/uniform-mortgage-data-program/uniform-appraisal-dataset>
- Fannie Mae technology integration resources:
  <https://singlefamily.fanniemae.com/technology-integration/technology-integration-resources>
- Freddie Mac UAD and Forms Redesign FAQ:
  <https://sf.freddiemac.com/faqs/uad-and-forms-redesign>

The team should re-check the official onboarding instructions and assigned URLs
at credential issuance time; endpoints and portal procedures are external
configuration and may change independently of HomeNode releases.
