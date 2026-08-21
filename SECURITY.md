# HomeNode security policy

## Reporting a vulnerability

Do not open a public issue containing vulnerability details, credentials,
personal information, appraisal evidence, or an exploit proof of concept.
Report security issues through this repository's private GitHub Security
Advisory reporting flow. Include the affected endpoint or component, the
minimum reproduction steps, likely impact, and whether the issue was observed
outside a synthetic test environment.

Do not test HomeNode production systems without a written, time-bounded rules
of engagement document identifying the approved hosts, identities, data, test
types, and emergency contacts. Production denial-of-service testing, data
destruction, social engineering, persistence, and access to third-party systems
are out of scope.

## Supported security boundary

HomeNode's authenticated API and database authorization are the security
boundary. Frontend validation, hidden fields, route visibility, and client-side
role checks are usability controls and must not be treated as authorization.

