# Custom download response metadata

Successful Custom workfile JSON downloads expose only `Content-Disposition` and `X-HomeNode-Immutable` to an already-allowed browser origin. Successful PDF downloads additionally expose `X-HomeNode-Report-Pages`. These fixed response-specific lists let the existing browser downloader retain the canonical filename, signed/draft flag and PDF page count.

This does not add an origin, request header, credential rule or permission. Workflow and assignment access still precede download preparation. Ordinary reads, preflight responses and authorization/service failures do not receive these exposure lists. There is no wildcard or global CORS change. Bodies, filename sanitization, immutable artifacts, ETags, `no-store` and security headers remain unchanged; ETags are not newly exposed to browser scripts.

Integration tests compose the existing CORS middleware with the actual read router and synthetic access/data dependencies. Node fetch does not simulate browser CORS filtering, so tests explicitly assert the exact exposure header as well as unchanged metadata/body bytes and denied-route behavior.

A supplementary two-origin browser check used this router and the existing CORS middleware with synthetic dependencies. The unpatched negative control hid all three headers; the fixed responses exposed the exact JSON/PDF lists for both draft and signed fixtures while preserving identical bytes. ETags remained hidden, and denied assignments and ordinary reads exposed no download metadata. This was a browser-header visibility check, not a production authentication or PDF-rendering test.
