import assert from "node:assert/strict";
import test from "node:test";

import {
  editorKeyMatches,
  normalizeHousingProfileUpdate,
} from "../src/util/housingProfileEdit.js";

test("editorKeyMatches requires the complete configured key", () => {
  assert.equal(editorKeyMatches("correct-key", "correct-key"), true);
  assert.equal(editorKeyMatches("correct", "correct-key"), false);
  assert.equal(editorKeyMatches("", ""), false);
});

test("normalizeHousingProfileUpdate preserves verified classification details", () => {
  assert.deepEqual(
    normalizeHousingProfileUpdate({
      housing_type: " Condo/Townhome ",
      attachment_type: "ATTACHED",
      architectural_style: " Traditional ",
      source_url: "https://example.com/mls/123",
      source_record_reference: "MLS 123",
      notes: "Verified against the MLS listing.",
    }),
    {
      structuralStyle: "Condo/Townhome",
      housingType: "Condo/Townhome",
      attachmentType: "attached",
      architecturalStyle: "Traditional",
      sourceUrl: "https://example.com/mls/123",
      sourceRecordReference: "MLS 123",
      notes: "Verified against the MLS listing.",
    },
  );
});

test("normalizeHousingProfileUpdate requires housing type and validates the source", () => {
  assert.throws(
    () => normalizeHousingProfileUpdate({ housing_type: " " }),
    /missing_housing_type/,
  );
  assert.throws(
    () =>
      normalizeHousingProfileUpdate({
        housing_type: "Duplex",
        attachment_type: "side-by-side",
      }),
    /invalid_attachment_type/,
  );
  assert.throws(
    () =>
      normalizeHousingProfileUpdate({
        housing_type: "Duplex",
        attachment_type: "attached",
        source_url: "javascript:alert(1)",
      }),
    /invalid_source_url/,
  );
});
