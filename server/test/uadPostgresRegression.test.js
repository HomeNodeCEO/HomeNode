import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("keeps reused UAD audit parameters on their PostgreSQL UUID type", () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(
    path.resolve(directory, "../src/modules/uad/workfiles.js"),
    "utf8",
  );
  assert.match(source, /\$1::uuid, \$2::uuid/);
  assert.match(source, /\(\$1::uuid\)::text/);
});


test("keeps completion-apply audit parameters on their PostgreSQL UUID type", () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(
    path.resolve(directory, "../src/modules/uad/completionApply.js"),
    "utf8",
  );
  assert.match(source, /\$1::uuid,[\s\S]*\(\$1::uuid\)::text/);
});
