import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDocumentFieldCandidates,
  classifyDocument,
  findZoningDescriptionInPages,
} from "../src/services/documentIntelligence.js";

test("document classification recognizes the appraisal document families", () => {
  assert.equal(classifyDocument({ pages: ["ONE TO FOUR FAMILY RESIDENTIAL CONTRACT Earnest Money"] }), "purchase_contract");
  assert.equal(classifyDocument({ pages: ["APPRAISAL ENGAGEMENT LETTER Scope of Work"] }), "engagement_letter");
  assert.equal(classifyDocument({ pages: ["MULTIPLE LISTING SERVICE MLS # 21062330"] }), "mls_sheet");
  assert.equal(classifyDocument({ pages: ["Official Zoning Map Zoning Districts"] }), "zoning_map");
});

test("labeled fields retain the verbatim source text and normalized money", () => {
  const candidates = buildDocumentFieldCandidates({
    documentType: "purchase_contract",
    pages: ["Contract Price: $425,000\nEarnest Money: $5,000\nSeller: Jordan Example"],
  });
  assert.deepEqual(
    candidates.find((candidate) => candidate.field_key === "contract_price"),
    {
      field_key: "contract_price",
      raw_value: "$425,000",
      normalized_value: "425000.00",
      page_number: 1,
      confidence: 0.86,
      evidence_excerpt: "Contract Price: $425,000",
      extraction_method: "labeled_text",
    },
  );
  assert.equal(candidates.find((candidate) => candidate.field_key === "seller_name")?.raw_value, "Jordan Example");
});

test("zoning description suggestion uses the exact official line associated with the code", () => {
  const suggestion = findZoningDescriptionInPages([
    "Legend\nSF-7 - Single-Family Residential-7 (minimum 7,000 square foot lots)\nC-1 - Commercial",
  ], "SF-7");
  assert.equal(suggestion?.raw_value, "Single-Family Residential-7 (minimum 7,000 square foot lots)");
  assert.equal(suggestion?.page_number, 1);
  assert.equal(suggestion?.extraction_method, "zoning_code_context");
});

test("zoning documents do not emit unrelated contract candidates", () => {
  const candidates = buildDocumentFieldCandidates({
    documentType: "zoning_ordinance",
    pages: ["EFFECTIVE DATE.\nR-S - Single-Family District"],
  });
  assert.equal(candidates.some((candidate) => candidate.field_key === "contract_date"), false);
});
