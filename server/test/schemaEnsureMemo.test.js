import assert from "node:assert/strict";
import test from "node:test";

import { ensureAssignmentDocumentsSchema } from "../src/services/assignmentDocuments.js";
import { ensureCensusGeographySchema } from "../src/services/censusGeography.js";

for (const [name, ensureSchema] of [
  ["assignment documents", ensureAssignmentDocumentsSchema],
  ["census geography", ensureCensusGeographySchema],
]) {
  test(`${name} schema ensure shares concurrent work and skips repeated DDL after success`, async () => {
    let calls = 0;
    let release;
    const pool = {
      query: () => {
        calls += 1;
        return new Promise((resolve) => { release = resolve; });
      },
    };
    const first = ensureSchema(pool);
    const second = ensureSchema(pool);
    await Promise.resolve();
    assert.equal(calls, 1);
    release({ rows: [] });
    assert.deepEqual(await Promise.all([first, second]), [undefined, undefined]);
    await ensureSchema(pool);
    assert.equal(calls, 1);

    const otherPool = { query: async () => { calls += 1; return { rows: [] }; } };
    await ensureSchema(otherPool);
    assert.equal(calls, 2);
  });

  test(`${name} schema ensure permits retry after a startup failure`, async () => {
    let calls = 0;
    const pool = {
      query: async () => {
        calls += 1;
        if (calls === 1) throw new Error("synthetic_startup_failure");
        return { rows: [] };
      },
    };
    await assert.rejects(ensureSchema(pool), /synthetic_startup_failure/);
    await ensureSchema(pool);
    await ensureSchema(pool);
    assert.equal(calls, 2);
  });
}
