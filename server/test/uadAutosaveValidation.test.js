import assert from "node:assert/strict";
import test from "node:test";

import {
  UAD_PHASE_ONE_FIELDS,
  normalizeAndValidateUadValue,
  validateUadSectionValues,
} from "../src/modules/uad/fieldCatalog.js";

test("autosave permits a temporarily blank required field without weakening manual validation", () => {
  const field = UAD_PHASE_ONE_FIELDS.find((candidate) => candidate.required && !candidate.entityType);
  assert.ok(field);

  const explicitSave = normalizeAndValidateUadValue(field, null);
  const autosave = normalizeAndValidateUadValue(field, null, { allowIncomplete: true });
  assert.equal(explicitSave.error?.code, "required");
  assert.deepEqual(autosave, { value: null, error: null });

  const submitted = [{ context_key: field.contextKey, uid: field.uid, value: null }];
  assert.equal(validateUadSectionValues(field.section, submitted).errors.length, 1);
  assert.equal(validateUadSectionValues(field.section, submitted, { allowIncomplete: true }).errors.length, 0);
});

test("autosave still rejects malformed nonblank UAD values", () => {
  const field = UAD_PHASE_ONE_FIELDS.find((candidate) => candidate.dataType === "integer");
  assert.ok(field);
  const result = normalizeAndValidateUadValue(field, 1.5, { allowIncomplete: true });
  assert.equal(result.error?.code, "integer");
});
