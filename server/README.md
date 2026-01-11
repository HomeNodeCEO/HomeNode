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

