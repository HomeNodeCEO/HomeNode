import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  AUTHENTICATED_SESSION_EDITOR_CREDENTIAL,
  editorCredentialForRequest,
  forgetEditorCredential,
  isAuthenticatedSessionEditorCredential,
  readEditorCredential,
  rememberEditorCredential,
  requestEditorCredential,
  setApplicationSessionActive,
} from "../src/lib/editorCredential.ts";

const directory = path.dirname(fileURLToPath(import.meta.url));
const read = (relativePath) => fs.readFileSync(path.resolve(directory, relativePath), "utf8");

test("an authenticated application session replaces the legacy editor-key prompt", () => {
  let prompts = 0;
  globalThis.window = {
    prompt() {
      prompts += 1;
      return "legacy-personal-key";
    },
  };

  forgetEditorCredential();
  setApplicationSessionActive(true);
  assert.equal(requestEditorCredential("legacy prompt"), AUTHENTICATED_SESSION_EDITOR_CREDENTIAL);
  assert.equal(editorCredentialForRequest(), AUTHENTICATED_SESSION_EDITOR_CREDENTIAL);
  assert.equal(prompts, 0);
  assert.equal(readEditorCredential(), "");
  assert.equal(isAuthenticatedSessionEditorCredential(AUTHENTICATED_SESSION_EDITOR_CREDENTIAL), true);

  setApplicationSessionActive(false);
  assert.equal(requestEditorCredential("legacy prompt"), "legacy-personal-key");
  assert.equal(prompts, 1);
  assert.equal(readEditorCredential(), "legacy-personal-key");
});

test("the session marker is never retained as a reusable shared secret", () => {
  forgetEditorCredential();
  rememberEditorCredential(AUTHENTICATED_SESSION_EDITOR_CREDENTIAL);
  assert.equal(readEditorCredential(), "");

  rememberEditorCredential(" legacy-key ");
  setApplicationSessionActive(true);
  assert.equal(editorCredentialForRequest("another-key"), AUTHENTICATED_SESSION_EDITOR_CREDENTIAL);
  assert.equal(readEditorCredential(), "legacy-key");

  setApplicationSessionActive(false);
  assert.equal(editorCredentialForRequest(), "legacy-key");
  forgetEditorCredential();
});

test("JSON and binary API requests share cookie, token, and marker stripping", () => {
  const api = read("../src/lib/api.ts");
  const propertyTaxApi = read("../src/lib/propertyTaxApi.ts");
  const auth = read("../src/features/auth/ApplicationAuth.tsx");
  const search = read("../src/pages/PropertySearch.tsx");
  assert.match(auth, /setApplicationSessionActive\(Boolean\(session\)\)/);
  assert.match(auth, /AUTH_REQUEST_TIMEOUT_MS = 10_000/);
  assert.match(auth, /signal: controller\.signal/);
  assert.match(api, /isAuthenticatedSessionEditorCredential/);
  assert.match(api, /headers\.delete\('x-homenode-editor-key'\)/);
  assert.match(api, /credentials: 'include'/);
  assert.match(search, /await api\.fetchJSON<unknown>\(url\)/);
  assert.doesNotMatch(search, /await fetch\(url\)/);
  assert.equal(
    (api.match(/fetchWithApplicationAuthentication\(/g) || []).length
      + (propertyTaxApi.match(/fetchWithApplicationAuthentication\(/g) || []).length,
    6,
    "the shared helper plus JSON, document, Property Tax evidence, workfile, and PDF calls must all use authenticated fetch",
  );
});

test("the application shell contains render recovery and safe printable summaries", () => {
  const main = read("../src/main.tsx");
  const boundary = read("../src/components/ApplicationErrorBoundary.tsx");
  const comparable = read("../src/pages/ComparableSalesAnalysis.tsx");
  assert.match(main, /<ApplicationErrorBoundary>/);
  assert.match(boundary, /getDerivedStateFromError/);
  assert.match(boundary, /Reload workspace/);
  assert.doesNotMatch(comparable, /document\.write/);
  assert.match(comparable, /createTextNode\(line\)/);
});

test("remaining reviewed-data saves use the authenticated session path", () => {
  const comparable = read("../src/pages/ComparableSalesAnalysis.tsx");
  const propertyTaxReview = read("../src/components/PropertyTaxWorkfileReview.tsx");
  const reconciliation = read("../src/components/SalesReconciliationQueue.tsx");

  assert.match(comparable, /const requestCredential = editorCredentialForRequest\(housingEditorKey\)/);
  assert.match(comparable, /authenticatedApplicationSession/);
  assert.doesNotMatch(comparable, /if \(!housingEditorKey\.trim\(\)\)/);
  assert.match(propertyTaxReview, /const editorKey = editorCredentialForRequest\(\)/);
  assert.doesNotMatch(propertyTaxReview, /window\.prompt\([^)]*editor key/i);
  assert.match(reconciliation, /Saves use your signed-in HomeNode identity\./);
});
