# Commercial Academy

Route: `/academy/commercial`, linked from Property Search and retained inside the existing application authentication boundary. The route is lazy loaded; no backend, database, authentication, access or native mobile changes.

The feature contains 50 original case questions in 10 modules, explanatory material before every question, explanations for all four choices, a core review path, module practice, bookmarks, missed-question review, first-attempt scoring, a direct-cap lab, a five-year DCF lab with sensitivity table and formula CSV, interview prompts and primary-source readings. All property inputs and rates are explicitly fictional educational assumptions, not current Dallas market evidence or BBG-endorsed material.

Progress is local to this browser and namespaced by the authenticated user ID (or the application's existing local mode). It is not synchronized across devices. Invalid/obsolete stored entries are dropped, and storage errors leave a session-only experience with a visible notice. Reset affects only the current account's course state.

NOI in the cases is before reserves; DCF capital and leasing costs are separate. The office model uses end-of-year, unlevered, before-income-tax cash flows and forward Year 6 NOI for an end-of-Year-5 sale. Independent base check: operating PV $2,384,257.12, sale PV $7,188,241.13, value $9,572,498.26. The apartment income bridge produces $800,000 NOI and $12,800,000 at 6.25%.

Validation: `node --experimental-strip-types --test scripts/testCommercialAcademy.mjs`, frontend typecheck and production build. Numeric tests cover the income bridge, terminal-year convention, present value, sensitivity, input bounds and spreadsheet references; progress tests cover retries and corrupt stored data. Source content is under `src/features/academy` and citations are maintained in `reference.ts`.
