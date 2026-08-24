import fs from "node:fs/promises";
import path from "node:path";

import { createRedTeamAccessTokenFactory } from "../src/modules/uad/uadRedTeamAuthorization.js";

const API_ORIGIN = "https://homenode-api-redteam.onrender.com";
const APP_ORIGIN = "https://homenode-uad-redteam.onrender.com";
const FIXTURE_ACCOUNT_ID = "UAD-REDTEAM-SFR-0001";
const FIXTURE_FILE_NUMBER = "HN-REDTEAM-ORG-A-0001";
const outputDirectory = path.resolve(process.env.UAD_REDTEAM_BROWSER_OUTPUT_DIRECTORY || "uad-redteam-browser");

function requiredRedTeamOrigin(value, expected, code) {
  const parsed = new URL(String(value || expected));
  if (parsed.origin !== expected || !parsed.hostname.includes("redteam")) throw new Error(code);
  return parsed.origin;
}

const apiOrigin = requiredRedTeamOrigin(process.env.UAD_REDTEAM_BASE_URL, API_ORIGIN, "invalid_uad_redteam_api_url");
const appOrigin = requiredRedTeamOrigin(process.env.UAD_REDTEAM_APP_URL, APP_ORIGIN, "invalid_uad_redteam_app_url");
const fixtureAccountId = String(process.env.UAD_REDTEAM_FIXTURE_ACCOUNT_ID || FIXTURE_ACCOUNT_ID).trim();
if (fixtureAccountId !== FIXTURE_ACCOUNT_ID) throw new Error("invalid_uad_redteam_browser_fixture");

const getAccessToken = createRedTeamAccessTokenFactory({
  privateKeyPem: process.env.UAD_REDTEAM_JWT_PRIVATE_KEY,
  keyId: process.env.UAD_REDTEAM_JWT_KEY_ID,
  issuer: process.env.UAD_REDTEAM_OIDC_ISSUER,
  audience: process.env.UAD_REDTEAM_OIDC_AUDIENCE,
  subjectsJson: process.env.UAD_REDTEAM_OIDC_SUBJECTS_JSON,
  unprovisionedSubject: process.env.UAD_REDTEAM_UNPROVISIONED_SUBJECT,
});

await fs.mkdir(outputDirectory, { recursive: true });
const evidence = {
  ok: false,
  profile: "uad_redteam_authenticated_browser_v1",
  synthetic_only: true,
  fixture_account_id: fixtureAccountId,
  fixture_file_number: FIXTURE_FILE_NUMBER,
  checks: {},
  api: { request_count: 0, failure_count: 0, failures: [] },
  browser: { page_errors: [], console_errors: [] },
};

let browser;
let page;
try {
  const { chromium } = await import("playwright");
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    colorScheme: "light",
    serviceWorkers: "block",
    viewport: { width: 1600, height: 1200 },
  });
  const accessToken = await getAccessToken("assigned_appraiser_a");
  await context.addInitScript((token) => {
    Object.defineProperty(window, "homenodeAuth", {
      configurable: false,
      enumerable: false,
      value: Object.freeze({ getAccessToken: async () => token }),
      writable: false,
    });
  }, accessToken);
  page = await context.newPage();
  page.on("pageerror", (error) => {
    evidence.browser.page_errors.push(String(error?.message || error).slice(0, 500));
  });
  page.on("console", (message) => {
    if (message.type() === "error") evidence.browser.console_errors.push(message.text().slice(0, 500));
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.origin !== apiOrigin) return;
    evidence.api.request_count += 1;
    if (response.status() >= 400) {
      evidence.api.failure_count += 1;
      evidence.api.failures.push({
        method: response.request().method(),
        path: url.pathname,
        status: response.status(),
      });
    }
  });

  await page.goto(`${appOrigin}/uad-3.6/${encodeURIComponent(fixtureAccountId)}`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await page.getByRole("heading", { name: "UAD 3.6 Workspace" }).waitFor({ timeout: 30_000 });
  await page.getByText(FIXTURE_FILE_NUMBER, { exact: true }).waitFor({ timeout: 30_000 });
  evidence.checks.authenticated_workspace_loaded = !(await page.getByText("invalid_access_token", { exact: true }).count());

  const workfileCard = page.locator("article").filter({ hasText: FIXTURE_FILE_NUMBER }).first();
  await workfileCard.getByRole("button", { name: "Open Assignment & Subject" }).click();
  await page.getByRole("heading", { name: FIXTURE_FILE_NUMBER, exact: true }).waitFor({ timeout: 30_000 });
  await page.getByRole("heading", { name: "Appraiser signature and credential snapshot" }).waitFor({ timeout: 30_000 });
  evidence.checks.editor_loaded = true;
  evidence.checks.signature_ui_present = true;

  await page.getByRole("button", { name: /^Section 22: Sales Comparison Approach/ }).click();
  await page.getByText("Section 22O subject Summary redisplays", { exact: true }).waitFor({ timeout: 15_000 }).catch(() => {});
  const salesSection = await page.locator("main").innerText();
  const comparableLabels = salesSection.match(/Sales Comparable\s+\d+/g) || [];
  evidence.checks.sales_comparison_section_loaded = salesSection.includes("Sections 22A–22Q");
  evidence.checks.sales_comparable_count = new Set(comparableLabels).size;
  evidence.checks.sales_rich_fixture = evidence.checks.sales_comparable_count >= 3;

  await page.getByRole("button", { name: /^Section 26: Reconciliation/ }).click();
  await page.getByText("Canonical values redisplayed in Section 26", { exact: true }).waitFor({ timeout: 15_000 });
  const reconciliationText = await page.locator("main").innerText();
  evidence.checks.reconciliation_section_loaded = reconciliationText.includes("Canonical values redisplayed in Section 26");
  evidence.checks.sales_conclusion_present = /Sales Comparison[\s\S]*\$[0-9]/.test(reconciliationText);

  await page.screenshot({ fullPage: true, path: path.join(outputDirectory, "authenticated-workfile.png") });
  evidence.browser.page_errors = evidence.browser.page_errors.slice(0, 20);
  evidence.browser.console_errors = evidence.browser.console_errors.slice(0, 20);
  evidence.api.failures = evidence.api.failures.slice(0, 30);
  evidence.checks.no_browser_errors = evidence.browser.page_errors.length === 0;
  evidence.checks.no_api_failures = evidence.api.failure_count === 0;
  evidence.ok = Object.entries(evidence.checks).every(([key, value]) => (
    key === "sales_comparable_count" ? Number(value) >= 3 : value === true
  ));
} catch (error) {
  evidence.error = String(error?.message || error).slice(0, 1_000);
  if (page) {
    await page.screenshot({ fullPage: true, path: path.join(outputDirectory, "browser-failure.png") }).catch(() => {});
  }
} finally {
  await browser?.close().catch(() => {});
  await fs.writeFile(path.join(outputDirectory, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
}

console.log(JSON.stringify(evidence, null, 2));
if (!evidence.ok) process.exitCode = 1;
