import assert from "node:assert/strict";
import test from "node:test";

import {
  EMPTY_ZONING_EVIDENCE_DRAFT,
  zoningDraftFromEvidence,
} from "../src/lib/zoningEvidencePresentation.ts";

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

test("review-required zoning prefills the best suggestion and official contact phones", () => {
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
  assert.match(draft.confirmationReference, /Planning & Zoning: 972-707-3878/);
  assert.match(draft.confirmationReference, /Building Inspections: 972-780-5000/);
});
