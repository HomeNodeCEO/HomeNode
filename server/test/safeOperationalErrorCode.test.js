import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { safeOperationalErrorCode } from "../src/security/safeOperationalErrorCode.js";

test("logs only bounded SQLSTATE and known network diagnostic classes", () => {
  assert.equal(safeOperationalErrorCode({ code: "23505", message: "private database URL" }), "23505");
  assert.equal(safeOperationalErrorCode({ code: "42P01", message: "private table" }), "42P01");
  assert.equal(safeOperationalErrorCode({ code: "ECONNRESET", message: "private socket" }), "ECONNRESET");
  assert.equal(safeOperationalErrorCode({ code: "ETIMEDOUT" }), "ETIMEDOUT");
  for (const code of ["secret", "token\nforged-log-line", "123456", "", null, 42]) {
    assert.equal(safeOperationalErrorCode({ code, message: "private detail" }), "unknown");
  }
  assert.equal(safeOperationalErrorCode(new Error("postgresql://private-user:private-password@example/db")), "unknown");
  assert.equal(safeOperationalErrorCode(null), "unknown");
  let codeReads = 0;
  assert.equal(safeOperationalErrorCode({
    get code() {
      codeReads += 1;
      return codeReads === 1 ? "23505" : "TOKEN";
    },
  }), "23505");
  assert.equal(codeReads, 1);
  assert.equal(safeOperationalErrorCode({ get code() { throw new Error("private detail"); } }), "unknown");
});

test("unexpected router and idle-pool errors use only safe diagnostic classes", async () => {
  for (const relativePath of ["../src/modules/mobile/auth.js", "../src/modules/mobile/router.js",
    "../src/modules/uad/router.js", "../src/oldServer.js"]) {
    const source = await readFile(new URL(relativePath, import.meta.url), "utf8");
    assert.match(source, /safeOperationalErrorCode\(error\)/);
    assert.doesNotMatch(source, /console\.error\([^\n]*,\s*error\s*\)/);
    assert.doesNotMatch(source, /console\.error\([^\n]*error\?\.message/);
  }
});
