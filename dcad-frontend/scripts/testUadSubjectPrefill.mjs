import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const api = readFileSync(new URL("../src/features/uad/api.ts", import.meta.url), "utf8");
const parsed = ts.createSourceFile("api.ts", api, ts.ScriptTarget.Latest, true);
const source = parsed.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === "prefillUadSubject").getText(parsed);
const compiled = ts.transpileModule(source.replace(/^export /, ""), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const create = new Function("uadFetchJSON", "makeUrl", "announceUadWorkfileMutation", `${compiled}; return prefillUadSubject;`);

test("subject initializer uses authenticated POST, no client facts, and announces only real changes", async () => {
  const calls = []; const notifications = [];
  let changed = 3;
  const initialize = create(async (...args) => { calls.push(args); return { changed_field_count: changed }; }, (url) => url, (id) => notifications.push(id));
  await initialize("file/id");
  assert.deepEqual(calls[0], ["/api/uad/workfiles/file%2Fid/subject-prefill", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }]);
  assert.deepEqual(notifications, ["file/id"]);
  changed = 0;
  await initialize("file/id");
  assert.equal(notifications.length, 1);
});

test("read-only and signed reports remain readable; other prefill errors are not silently accepted", async () => {
  for (const message of ["uad_workfile_access_denied", "uad_workfile_status_locked", "uad_subject_snapshot_conflict", "Request timed out"]) {
    const initialize = create(async () => { throw new Error(message); }, (url) => url, () => assert.fail("Must not announce a refused write"));
    if (["uad_workfile_access_denied", "uad_workfile_status_locked"].includes(message)) await initialize("file");
    else await assert.rejects(initialize("file"), { message });
  }
});

test("editor initializes once per workfile before reading, guards stale loads, and leaves saved data accessible on prefill failure", () => {
  const editor = readFileSync(new URL("../src/features/uad/components/UadWorkfileEditor.tsx", import.meta.url), "utf8");
  assert.match(editor, /subjectPrefillRef\.current\?\.workfileId !== workfileId/);
  assert.ok(editor.indexOf("await subjectPrefillRef.current.request") < editor.indexOf("await getUadEditor(workfileId)"));
  assert.match(editor, /generation !== loadGenerationRef\.current/);
  assert.match(editor, /Your saved fields are still available/);
  assert.match(editor, /subjectPrefillWarning && <div role="status"/);
});
