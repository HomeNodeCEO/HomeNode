import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  EMPTY_ZONING_EVIDENCE_DRAFT,
  zoningDraftFromEvidence,
} from "../src/lib/zoningEvidencePresentation.ts";
import { loadTrustedRepositoryCommonJs } from "./trustedRepositoryModuleHarness.mjs";

const settle = async () => {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
};

function zoningHookHarness() {
  const cells = [];
  const layouts = [];
  const passives = [];
  const requests = [];
  let cursor = 0;
  let current;
  const same = (left, right) => (
    left?.length === right?.length
    && left.every((value, index) => Object.is(value, right[index]))
  );
  const effect = (queue, callback, dependencies) => {
    const index = cursor;
    cursor += 1;
    const previous = cells[index];
    if (!previous || !same(previous.dependencies, dependencies)) {
      const cell = { dependencies, cleanup: previous?.cleanup };
      cells[index] = cell;
      queue.push(() => {
        cell.cleanup?.();
        cell.cleanup = callback();
      });
    }
  };
  const react = {
    useState(initial) {
      const index = cursor;
      cursor += 1;
      cells[index] ??= { value: typeof initial === "function" ? initial() : initial };
      return [cells[index].value, (update) => {
        cells[index].value = typeof update === "function" ? update(cells[index].value) : update;
      }];
    },
    useRef(initial) {
      const index = cursor;
      cursor += 1;
      cells[index] ??= { current: initial };
      return cells[index];
    },
    useCallback(callback, dependencies) {
      const index = cursor;
      cursor += 1;
      if (!cells[index] || !same(cells[index].dependencies, dependencies)) {
        cells[index] = { dependencies, value: callback };
      }
      return cells[index].value;
    },
    useEffect: (callback, dependencies) => effect(passives, callback, dependencies),
    useLayoutEffect: (callback, dependencies) => effect(layouts, callback, dependencies),
  };
  const api = {
    getPropertyZoningEvidence(accountId, assignmentFileId) {
      return new Promise((resolve, reject) => {
        requests.push({ accountId, assignmentFileId, resolve, reject });
      });
    },
    getZoningDocumentDescriptionSuggestion: async () => ({ suggestion: null }),
    savePropertyZoningVerification: async () => ({ verification: null }),
  };
  const { useZoningEvidence } = loadTrustedRepositoryCommonJs(
    new URL("../src/hooks/useZoningEvidence.ts", import.meta.url),
    (name) => {
      if (name === "react") return react;
      if (name === "@/lib/api") return api;
      if (name === "@/lib/zoningEvidencePresentation") {
        return { EMPTY_ZONING_EVIDENCE_DRAFT, zoningDraftFromEvidence };
      }
      throw new Error(`unexpected zoning hook dependency: ${name}`);
    },
  );
  const stableGetEditorKey = () => "test-editor-key";
  const stableCredentialRejected = () => {};
  let options = {
    accountId: "ACCOUNT-A",
    assignmentFileId: 12,
    enabled: true,
    getEditorKey: stableGetEditorKey,
    onCredentialRejected: stableCredentialRejected,
  };
  const flush = (queue) => queue.splice(0).forEach((callback) => callback());
  const render = (patch = {}, { flushLayouts = true, flushPassives = true } = {}) => {
    options = { ...options, ...patch };
    cursor = 0;
    current = useZoningEvidence(options);
    if (flushLayouts) flush(layouts);
    if (flushPassives) flush(passives);
    return current;
  };
  render();
  return { render, requests, get view() { return current; } };
}

test("verified zoning takes precedence over automatic and PDF defaults", () => {
  const draft = zoningDraftFromEvidence({
    documents: [{ id: 12 }],
    automatic_result: { zoning_code: "PD", zoning_description: "Automatic" },
    verification: {
      source_document_id: 20,
      source_type: "manual",
      zoning_code: "SF-7",
      zoning_description: "Verified description",
      page_number: 4,
      confirmation_reference: "Call log",
      notes: "Confirmed",
      reviewer: "Appraiser",
    },
  }, EMPTY_ZONING_EVIDENCE_DRAFT);
  assert.equal(draft.sourceDocumentId, "20");
  assert.equal(draft.zoningCode, "SF-7");
  assert.equal(draft.zoningDescription, "Verified description");
  assert.equal(draft.pageNumber, "4");
});

test("official PDF and automatic zoning hydrate an unverified draft", () => {
  const draft = zoningDraftFromEvidence({
    documents: [{ id: 12 }],
    automatic_result: { zoning_code: "PD", zoning_description: "Planned development" },
    verification: null,
  }, { ...EMPTY_ZONING_EVIDENCE_DRAFT, reviewer: "Keep reviewer" });
  assert.equal(draft.sourceDocumentId, "12");
  assert.equal(draft.sourceType, "map_pdf");
  assert.equal(draft.zoningCode, "PD");
  assert.equal(draft.reviewer, "Keep reviewer");
});

test("review-required zoning prefills the best suggestion without duplicating the contact card", () => {
  const draft = zoningDraftFromEvidence({
    documents: [],
    automatic_result: null,
    suggested_result: {
      zoning_code: "PD",
      zoning_description: "Planned Development District",
    },
    verification: null,
    jurisdiction: {
      contact: {
        department: "Planning and Zoning / Permit & Inspection Services",
        planningPhone: "972-707-3878 / 972-707-3876",
        buildingPhone: "972-780-5000",
      },
    },
  }, EMPTY_ZONING_EVIDENCE_DRAFT);
  assert.equal(draft.zoningCode, "PD");
  assert.equal(draft.zoningDescription, "Planned Development District");
  assert.equal(draft.confirmationReference, "");
});

test("assignment changes clear zoning state and stale scopes cannot save", () => {
  const hookSource = fs.readFileSync(
    new URL("../src/hooks/useZoningEvidence.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    hookSource,
    /zoningEvidenceScopeRef\.current = "";[\s\S]*setZoningEvidence\(null\);[\s\S]*setZoningDraft\(EMPTY_ZONING_EVIDENCE_DRAFT\);/,
  );
  assert.match(
    hookSource,
    /useLayoutEffect\(\(\) => \{[\s\S]*zoningEvidenceScopeRef\.current = "";/,
  );
  assert.match(
    hookSource,
    /if \(zoningEvidenceScopeRef\.current !== scopeKey\) return;/,
  );
  assert.match(hookSource, /}, \[accountId, assignmentFileId\]\);/);
});

test("pending zoning saves and prefills cannot update a replacement assignment", () => {
  const hookSource = fs.readFileSync(
    new URL("../src/hooks/useZoningEvidence.ts", import.meta.url),
    "utf8",
  );
  const currentScopeGuard = /requestVersion === requestVersionRef\.current\s*&& zoningEvidenceScopeRef\.current === scopeKey/g;
  assert.equal(
    [...hookSource.matchAll(currentScopeGuard)].length,
    2,
    "save and prefill operations must each bind their updates to the captured assignment scope",
  );
  assert.match(hookSource, /const response = await savePropertyZoningVerification\([\s\S]*if \(!isCurrentScope\(\)\) return;[\s\S]*hydrateZoningEvidence\(/);
  assert.match(hookSource, /const result = await getZoningDocumentDescriptionSuggestion\([\s\S]*if \(!isCurrentScope\(\)\) return;[\s\S]*setZoningDraft\(/);
  assert.match(
    hookSource,
    /}, \[\s*accountId,\s*assignmentFileId,\s*zoningDraft\.sourceDocumentId,/,
  );
});

test("assignment scope is invalidated at commit before passive effects run", async () => {
  const harness = zoningHookHarness();
  assert.deepEqual(
    harness.requests.map(({ accountId, assignmentFileId }) => ({ accountId, assignmentFileId })),
    [{ accountId: "ACCOUNT-A", assignmentFileId: 12 }],
  );
  harness.render(
    { assignmentFileId: 13 },
    { flushLayouts: true, flushPassives: false },
  );
  harness.requests[0].resolve({
    evidence: {
      jurisdiction: { city: "Old assignment" },
      documents: [],
      automatic_result: null,
      suggested_result: null,
      verification: null,
    },
  });
  await settle();
  const viewAfterOldResponse = harness.render(
    {},
    { flushLayouts: false, flushPassives: false },
  );
  assert.equal(viewAfterOldResponse.zoningEvidence, null);
  assert.equal(viewAfterOldResponse.zoningEvidenceLoading, false);
});
