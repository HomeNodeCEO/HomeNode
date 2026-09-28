import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(
  new URL("../../.github/workflows/custom-signed-artifact-staging-audit.yml", import.meta.url),
  "utf8",
);

// Inspect only direct children at each YAML indentation level. A matching line in
// another job or step must not satisfy this security-sensitive workflow contract.
function entriesAt(lines, indent) {
  const entries = [];
  for (const line of lines) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const depth = line.match(/^ */)[0].length;
    if (depth === indent) {
      entries.push({ head: line.trim(), body: [] });
    } else {
      assert.ok(depth > indent && entries.length > 0, `unexpected YAML indentation: ${line}`);
      entries.at(-1).body.push(line);
    }
  }
  return entries;
}

function child(entries, head) {
  const matches = entries.filter((entry) => entry.head === head);
  assert.equal(matches.length, 1, `expected one ${head} entry`);
  return matches[0];
}

function heads(entries) {
  return entries.map((entry) => entry.head);
}

function assertWorkflowContract(source) {
  const root = entriesAt(source.split(/\r?\n/), 0);
  assert.deepEqual(heads(root), [
    "name: Custom signed artifact staging audit",
    "on:",
    "permissions:",
    "concurrency:",
    "jobs:",
  ]);
  assert.deepEqual(heads(entriesAt(child(root, "on:").body, 2)), ["workflow_dispatch:"]);
  assert.deepEqual(heads(entriesAt(child(root, "permissions:").body, 2)), ["contents: read"]);
  assert.deepEqual(heads(entriesAt(child(root, "concurrency:").body, 2)), [
    "group: custom-signed-artifact-staging-audit",
    "cancel-in-progress: false",
  ]);

  const jobs = entriesAt(child(root, "jobs:").body, 2);
  assert.deepEqual(heads(jobs), ["read-only-audit:"]);
  const job = entriesAt(jobs[0].body, 4);
  assert.deepEqual(heads(job), [
    "if: github.ref == 'refs/heads/main'",
    "runs-on: ubuntu-latest",
    "environment: custom-signed-artifact-staging-audit",
    "timeout-minutes: 10",
    "defaults:",
    "steps:",
  ]);
  const defaults = entriesAt(child(job, "defaults:").body, 6);
  assert.deepEqual(heads(defaults), ["run:"]);
  assert.deepEqual(heads(entriesAt(defaults[0].body, 8)), ["working-directory: server"]);

  const steps = entriesAt(child(job, "steps:").body, 6);
  assert.equal(steps.length, 6);
  for (const [index, action] of ["checkout", "setup-node"].entries()) {
    assert.match(steps[index].head, new RegExp(`^- uses: actions/${action}@[0-9a-f]{40}(?: # .+)?$`));
  }
  assert.deepEqual(heads(entriesAt(steps[0].body, 8)), ["with:"]);
  assert.deepEqual(heads(entriesAt(entriesAt(steps[0].body, 8)[0].body, 10)), [
    "persist-credentials: false",
  ]);
  assert.deepEqual(heads(entriesAt(steps[1].body, 8)), ["with:"]);
  assert.deepEqual(heads(entriesAt(entriesAt(steps[1].body, 8)[0].body, 10)), [
    "node-version: 22",
  ]);

  assert.equal(steps[2].head, "- name: Install locked production dependencies without lifecycle scripts");
  assert.deepEqual(heads(entriesAt(steps[2].body, 8)), [
    "run: npm ci --omit=dev --ignore-scripts --no-audit --no-fund",
  ]);

  const audits = [
    ["Audit signed snapshot and artifact links", "audit:custom-signed-artifacts"],
    ["Audit stored signed PDF bytes", "audit:custom-signed-pdf-content"],
    ["Audit current verified photo coverage", "audit:custom-signed-photo-coverage"],
  ];
  for (const [index, [name, command]] of audits.entries()) {
    const step = steps[index + 3];
    assert.equal(step.head, `- name: ${name}`);
    const fields = entriesAt(step.body, 8);
    assert.deepEqual(heads(fields), ["env:", `run: npm run ${command}`]);
    assert.deepEqual(heads(entriesAt(fields[0].body, 10)), [
      "DATABASE_URL: ${{ secrets.STAGING_SIGNED_ARTIFACT_AUDIT_DATABASE_URL }}",
    ]);
  }
}

test("signed-artifact staging audit has a manual, main-only, read-only workflow contract", () => {
  assertWorkflowContract(workflow);
});

test("workflow contract rejects automatic triggers, altered guards, secret leakage, and mutable actions", () => {
  assert.throws(() => assertWorkflowContract(workflow.replace(
    "  workflow_dispatch:",
    "  push:\n  workflow_dispatch:",
  )));
  assert.throws(() => assertWorkflowContract(workflow.replace(
    "    if: github.ref == 'refs/heads/main'",
    "    if: github.ref == 'refs/heads/staging'",
  )));
  assert.throws(() => assertWorkflowContract(workflow.replace(
    "    steps:",
    "    env:\n      DATABASE_URL: ${{ secrets.STAGING_SIGNED_ARTIFACT_AUDIT_DATABASE_URL }}\n    steps:",
  )));
  assert.throws(() => assertWorkflowContract(workflow.replace(
    "      - name: Install locked production dependencies without lifecycle scripts",
    "      - name: Install locked production dependencies without lifecycle scripts\n        env:\n          DATABASE_URL: ${{ secrets.STAGING_SIGNED_ARTIFACT_AUDIT_DATABASE_URL }}",
  )));
  assert.throws(() => assertWorkflowContract(workflow.replace(
    "          DATABASE_URL: ${{ secrets.STAGING_SIGNED_ARTIFACT_AUDIT_DATABASE_URL }}",
    "          DATABASE_URL: ${{ secrets.DATABASE_URL }}",
  )));
  assert.throws(() => assertWorkflowContract(workflow.replace(
    /actions\/checkout@[0-9a-f]{40}/,
    "actions/checkout@v7",
  )));
});
