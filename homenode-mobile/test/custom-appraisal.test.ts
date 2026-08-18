import assert from "node:assert/strict";
import test from "node:test";

import type { CustomAppraisalFieldDefinition } from "../src/api/client";
import { customAppraisalFieldChange } from "../src/customAppraisal/model";

function field(overrides: Partial<CustomAppraisalFieldDefinition> = {}): CustomAppraisalFieldDefinition {
  return {
    field_path: "custom_appraisal.property_characteristics.main_improvement.bedroom_count",
    group: "Basics",
    label: "Bedrooms",
    target_kind: "report_section",
    section_key: "report.property_characteristics",
    target_path: ["main_improvement", "bedroom_count"],
    value_type: "integer",
    minimum: 0,
    maximum: 100,
    maximum_length: null,
    multiline: false,
    ...overrides,
  };
}

test("custom appraisal inputs preserve typed values and explicit clearing", () => {
  assert.deepEqual(customAppraisalFieldChange(field(), " 4 "), { exists: true, value: 4 });
  assert.deepEqual(customAppraisalFieldChange(field(), ""), { exists: false });
  assert.deepEqual(customAppraisalFieldChange(field({ value_type: "boolean" }), "false"), {
    exists: true,
    value: false,
  });
  assert.deepEqual(customAppraisalFieldChange(field({ value_type: "condition" }), "c3-c2"), {
    exists: true,
    value: "C3-C2",
  });
  assert.throws(() => customAppraisalFieldChange(field(), "2.5"), /valid integer/);
  assert.throws(() => customAppraisalFieldChange(field(), "101"), /outside the allowed range/);
});
