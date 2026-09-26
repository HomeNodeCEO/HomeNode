import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(
  new URL("../../.github/workflows/custom-signed-artifact-staging-audit.yml", import.meta.url),
  "utf8",
);

test("signed-artifact staging audit is manual, main-only, and uses a dedicated secret", () => {
  assert.match(workflow, /\bworkflow_dispatch:/);
  assert.doesNotMatch(workflow, /\b(?:push|pull_request|schedule):/);
  assert.match(workflow, /if: github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /environment: custom-signed-artifact-staging-audit/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /DATABASE_URL: \$\{\{ secrets\.STAGING_SIGNED_ARTIFACT_AUDIT_DATABASE_URL \}\}/);
  assert.doesNotMatch(workflow, /\$\{\{ secrets\.DATABASE_URL \}\}/);
});

test("signed-artifact staging audit runs only the three aggregate read-only CLIs", () => {
  const commands = [...workflow.matchAll(/^\s+run: (.+)$/gm)].map((match) => match[1]);
  assert.deepEqual(commands, [
    "npm ci --omit=dev --ignore-scripts --no-audit --no-fund",
    "npm run audit:custom-signed-artifacts",
    "npm run audit:custom-signed-pdf-content",
    "npm run audit:custom-signed-photo-coverage",
  ]);
  assert.doesNotMatch(workflow, /\b(?:migrate|backfill|repair|deploy|upload-artifact)\b/);
});
