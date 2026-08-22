# Appraisal Delivery Hub

HomeNode keeps appraisal development independent from lender and AMC transport.
The signed report revision and its immutable generated artifacts remain the
source of truth. A portal adapter may deliver those bytes and record a receipt;
it may not modify appraisal facts or replace the signed package.

## Current delivery contract

Every HTTPS portal is supported by the `generic_manual` guided-delivery
fallback. Known platform families add tenant recognition and a stable location
for future authorized API transports. Direct submission is disabled until the
platform owner supplies integration documentation, credentials, and permission.

The first platform-family adapter is `valuelink_spur`. It matches
`*.spurams.com`, recognizes `amerimacamc.spurams.com` as AmeriMac Appraisal
Management, and automatically treats a new SPUR tenant as another ValueLink
destination rather than a new appraisal implementation.

The initial flow is:

1. Select or enter the lender/AMC portal HTTPS URL.
2. Resolve the underlying platform family and tenant.
3. Bind a delivery attempt to the current signed UAD revision and its ready ZIP
   artifact, byte count, and SHA-256 checksum.
4. Present the guided upload checklist.
5. Record the external delivery identifier or receipt after submission.

The database deliberately stores no portal password, MFA secret, access token,
API key, or session cookie. Future connectors must use deployment secret
references and the platform's approved authentication mechanism.

## Future adapters

Appraisal Scope, AppraisalPort, ValuTrac, UWM Appraisal Direct, LenderX, Mercury
Network, SFTP, and secure-email transports use the same attempt and receipt
contract. A platform-specific connector replaces only transport. It does not
fork HomeNode workfiles, UAD validation, signing, PDF generation, XML generation,
or delivery-package generation.
