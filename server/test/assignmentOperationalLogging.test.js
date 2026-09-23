import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

function diagnosticLogCalls(source) {
  return [...source.matchAll(/\blogger\.(?:error|warn)\?\.\([\s\S]*?\);/g)].map((match) => match[0]);
}

test("assignment document and workfile failure sites do not log raw exceptions", async () => {
  const multilineLog = 'logger.error?.("failure",\n  safeOperationalErrorCode(error),\n  error);';
  assert.match(diagnosticLogCalls(multilineLog).join("\n"), /,\s*error\s*\)/);
  for (const path of [
    "../src/modules/assignmentFiles/documentRouter.js",
    "../src/modules/assignmentFiles/workfileReadRouter.js",
    "../src/modules/assignmentFiles/workfileMutationRouter.js",
  ]) {
    const source = await readFile(new URL(path, import.meta.url), "utf8");
    assert.match(source, /safeOperationalErrorCode\(error\)/);
    for (const call of diagnosticLogCalls(source)) {
      assert.doesNotMatch(call, /,\s*error\s*[,)]/);
      assert.doesNotMatch(call, /\berror\?\.message\b/);
    }
    assert.doesNotMatch(source, /error\?\.message \|\| error/);
  }
});
