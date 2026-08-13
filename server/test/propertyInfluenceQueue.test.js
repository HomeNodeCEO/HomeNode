import assert from "node:assert/strict";
import test from "node:test";

import { runWithConcurrency } from "../src/services/propertyInfluenceQueue.js";

test("property influence work respects its concurrency ceiling and processes every item", async () => {
  const items = Array.from({ length: 17 }, (_, index) => index + 1);
  const processed = [];
  let active = 0;
  let peak = 0;

  await runWithConcurrency(items, 4, async (item) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, item % 3));
    processed.push(item);
    active -= 1;
  });

  assert.equal(peak, 4);
  assert.deepEqual(processed.toSorted((left, right) => left - right), items);
});

test("property influence concurrency is safely bounded for empty and invalid inputs", async () => {
  let calls = 0;
  await runWithConcurrency([], 50, async () => { calls += 1; });
  await runWithConcurrency(["only"], 0, async () => { calls += 1; });
  assert.equal(calls, 1);
});
