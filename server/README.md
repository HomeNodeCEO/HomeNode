Signup Email Setup

- Frontend proxy to Node API
  - Create `dcad-frontend/.env.local` with: `VITE_PROXY_TARGET=http://127.0.0.1:4000`

- Configure SMTP for the Node server
  - Copy `server/.env.example` to `server/.env` and fill one of the SMTP options. Example (Gmail with app password):
    - `SMTP_URL=smtps://YOUR_GMAIL_ADDRESS:APP_PASSWORD@smtp.gmail.com:465`
    - `MAIL_FROM=YOUR_GMAIL_ADDRESS`
  - Ensure CORS allows the Vite dev server:
    - `CORS_ORIGIN=http://localhost:5173,http://127.0.0.1:5173`

- Run services
  - Server: `cd server && npm install && npm run start`
  - Frontend: `cd dcad-frontend && npm install && npm run dev`

- Testing
  - Open `http://localhost:5173/signup`, draw a signature, enter owner name + telephone, click "Submit Enrollment".
  - If SMTP is not configured, the server returns HTTP 500 with `{ error: "smtp_not_configured" }`.

Phase 2 property context

- `npm run maintenance:context` refreshes Census TIGER roads/railroads, FEMA
  NFHL flood zones, registered official municipal zoning layers, and then the
  stored property influence queue. The web request path reads the local mirror
  only; a failed external refresh preserves the last successful data.
- Dallas and Garland official zoning are the initial municipal sources.
  Additional DFW cities should be registered jurisdiction by jurisdiction.
- Gridics PropZone is registered as the second-priority zoning fallback. It
  remains disabled until a licensed API agreement supplies credentials,
  coverage, and permitted use terms. A missing municipal layer must never be
  silently represented as verified zoning.
- Comparable recommendations use influence-first ordering only after at least
  80% of eligible sales have stored influence context. The established
  location/GLA/age/site/recency score remains the safe fallback while coverage
  is lower.
- TODO: add the Secondary Comparable Sales Grid. It will retain sales that are
  weaker overall but provide relevant evidence for a defining feature such as
  commercial adjacency, railroad proximity, flood-zone exposure, corner lot,
  or another mapped external influence.

