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
  const auth = read("../src/features/auth/ApplicationAuth.tsx");
  assert.match(auth, /setApplicationSessionActive\(Boolean\(session\)\)/);
  assert.match(api, /isAuthenticatedSessionEditorCredential/);
  assert.match(api, /headers\.delete\('x-homenode-editor-key'\)/);
  assert.match(api, /credentials: 'include'/);
  assert.equal(
    (api.match(/fetchWithApplicationAuthentication\(/g) || []).length,
    5,
    "the shared helper plus JSON, document, workfile, and PDF calls must all use authenticated fetch",
  );
});
