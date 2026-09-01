import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const read = (relativePath) => fs.readFileSync(path.resolve(directory, relativePath), "utf8");

test("UAD exposes a prominent manual save that flushes pending fields", () => {
  const editor = read("../../dcad-frontend/src/features/uad/components/UadWorkfileEditor.tsx");

  assert.match(editor, /aria-label="Save all pending UAD changes now"/);
  assert.match(editor, /await persistAutosave\(\)/);
  assert.match(editor, /saveReason: "autosave"/, "the prominent save should retain incomplete-safe draft semantics");
  assert.match(editor, /dirty \? "Save changes" : "Save"/);
  assert.match(editor, /Review & save \$\{section\.title\}/, "formal section review should remain available");
});

test("Custom Appraisal exposes a top-level save and waits for queued workfile changes", () => {
  const report = read("../../dcad-frontend/src/pages/PropertyReport.tsx");
  const saveStart = report.indexOf("const saveCustomAppraisalNow = async () =>");
  const saveEnd = report.indexOf("const analyzeCurrentPropertyContext", saveStart);
  const savePath = report.slice(saveStart, saveEnd);

  assert.ok(saveStart >= 0 && saveEnd > saveStart, "the Custom Appraisal save path should be inspectable");
  assert.match(report, /aria-label="Save current Custom Appraisal changes now"/);
  assert.match(savePath, /await marketWorkfileSaveQueueRef\.current/);
  assert.match(savePath, /await saveAssignmentDetails\(\{ requireCompletion: false \}\)/);
  assert.match(savePath, /marketWorkfileSaveErrorRef\.current/, "a failed queued market save must block a false all-saved confirmation");
  assert.match(savePath, /All current changes are saved at/);
  assert.match(report, /assignmentSaveMessage \|\| workfileStatusMessage/, "save confirmation should be visible beside the button");
});
