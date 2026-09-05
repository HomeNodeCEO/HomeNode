import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  readAppraisalReportDraft,
  saveAppraisalReportDraft,
} from "../src/lib/appraisalReportDraft.ts";
import {
  readMarketConditionsDraft,
  saveMarketConditionsDraft,
} from "../src/lib/marketConditionsDraft.ts";
import { browserDraftIdentityKey } from "../src/lib/browserDraftIdentity.ts";

const stored = new Map();
globalThis.window = {
  localStorage: {
    getItem: (key) => stored.get(key) ?? null,
    removeItem: (key) => stored.delete(key),
    setItem: (key, value) => stored.set(key, value),
  },
};

const salesDraft = (assignmentFileId) => ({
  version: 3,
  accountId: " account-1 ",
  assignmentFileId,
  savedAt: "2026-09-04T12:00:00.000Z",
  source: "sales-comparison-workspace",
  subject: { accountId: "ACCOUNT-1" },
  comparables: [],
  opinionOfValue: null,
  opinionAfterCostToCure: null,
  salesNotes: "",
  adjustmentNotes: "",
});

const marketDraft = (assignmentFileId) => ({
  version: 3,
  accountId: "account-1",
  assignmentFileId,
  savedAt: "2026-09-04T12:00:00.000Z",
  asOfDate: "2026-09-04",
  periodMonths: 12,
  selectedAreaKeys: [],
  response: { analyses: [] },
  reconciliation: { trendConclusion: "insufficient", reliedUponAreaKeys: [], explanation: "" },
});

const sessionOne = {
  user_id: " USER_1 ",
  organizations: [{ organization_id: "ORG_1" }, { organization_id: "org_2" }],
};
const sessionTwo = {
  user_id: "user_2",
  organizations: [{ organization_id: "org_1" }],
};

test.beforeEach(() => stored.clear());

test("sales drafts require and preserve an exact account-assignment identity", () => {
  saveAppraisalReportDraft(salesDraft(101), sessionOne);
  assert.equal(readAppraisalReportDraft("ACCOUNT-1", 101, sessionOne)?.assignmentFileId, 101);
  assert.equal(readAppraisalReportDraft("ACCOUNT-1", 202, sessionOne), null);
  assert.equal(readAppraisalReportDraft("ACCOUNT-1", 101, sessionTwo), null);
  assert.equal(readAppraisalReportDraft("ACCOUNT-1", 101), null);
});

test("unscoped and internally mismatched sales drafts are rejected", () => {
  saveAppraisalReportDraft(salesDraft(null), sessionOne);
  assert.equal(stored.size, 0);
  const identityKey = browserDraftIdentityKey(sessionOne);
  stored.set(
    `homenode-appraisal-report:ACCOUNT-1:101:${identityKey}`,
    JSON.stringify({ storageVersion: 1, identityKey, draft: salesDraft(202) }),
  );
  assert.equal(readAppraisalReportDraft("ACCOUNT-1", 101, sessionOne), null);
  stored.set("homenode-appraisal-report:ACCOUNT-1", JSON.stringify(salesDraft(null)));
  assert.equal(readAppraisalReportDraft("ACCOUNT-1", 101, sessionOne), null);
});

test("market-condition drafts are isolated by the same exact assignment identity", () => {
  saveMarketConditionsDraft(marketDraft(101), sessionOne);
  assert.equal(readMarketConditionsDraft("account-1", 101, sessionOne)?.assignmentFileId, 101);
  assert.equal(readMarketConditionsDraft("account-1", 202, sessionOne), null);
  assert.equal(readMarketConditionsDraft("account-1", 101, sessionTwo), null);
  saveMarketConditionsDraft(marketDraft(null), sessionOne);
  assert.equal(stored.size, 1);
});

const reportSource = await readFile(
  new URL("../src/pages/AppraisalReport.tsx", import.meta.url),
  "utf8",
);
const comparableSource = await readFile(
  new URL("../src/pages/ComparableSalesAnalysis.tsx", import.meta.url),
  "utf8",
);

test("report and comparison screens invalidate stale assignment responses", () => {
  assert.match(reportSource, /assignmentSelectionGenerationRef\.current \+= 1/u);
  assert.match(reportSource, /readAppraisalReportDraft\(propertyId, assignment\.id, applicationSession\)/u);
  assert.match(reportSource, /readMarketConditionsDraft\(propertyId, assignment\.id, applicationSession\)/u);
  assert.doesNotMatch(reportSource, /const assignment = selected \|\| response\.latest_file/u);
  assert.match(comparableSource, /workfileSelectionGenerationRef\.current \+= 1/u);
  assert.match(comparableSource, /pending\.draft\.assignmentFileId !== saveAssignmentFile\.id/u);
  assert.match(comparableSource, /readAppraisalReportDraft\(propertyId, assignmentFile\.id, applicationSession\)/u);
});
