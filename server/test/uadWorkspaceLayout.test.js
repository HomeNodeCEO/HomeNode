import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const read = (relative) => fs.readFileSync(path.resolve(directory, relative), "utf8");

test("the UAD workspace uses a naturally scrolling aligned left section navigator", () => {
  const entry = read("../../dcad-frontend/src/features/uad/pages/UadWorkspaceEntry.tsx");
  const editor = read("../../dcad-frontend/src/features/uad/components/UadWorkfileEditor.tsx");

  assert.match(entry, /w-full max-w-none/);
  assert.match(editor, /lg:grid-cols-\[24%_74%\]/);
  assert.doesNotMatch(editor, /lg:max-h-\[calc\(100vh-6rem\)\]/);
  assert.doesNotMatch(editor, /lg:overflow-y-auto/);
  assert.doesNotMatch(editor, /lg:sticky lg:top-20/);
  assert.doesNotMatch(editor, /mt-6 overflow-hidden rounded-2xl/);
  assert.match(editor, /aria-current=\{active \? "step" : undefined\}/);
  assert.match(editor, /grid-cols-\[5rem_minmax\(0,1fr\)\]/);
  assert.match(editor, /w-full px-3 py-3 text-left/);
  assert.match(editor, /grid w-full grid-cols-\[5rem_minmax\(0,1fr\)\]/);
  assert.match(editor, /col-span-2 justify-self-end whitespace-nowrap text-right font-semibold text-black/);
  assert.doesNotMatch(editor, /pl-\[5\.5rem\]/);
});

test("the subject workfile chooser is collapsed and the status tiles are compact", () => {
  const entry = read("../../dcad-frontend/src/features/uad/pages/UadWorkspaceEntry.tsx");
  const workfiles = entry.indexOf("UAD workfiles for this subject");

  assert.ok(entry.lastIndexOf("<details", workfiles) >= 0, "workfile list should use a details disclosure");
  assert.match(entry, /mt-4 grid gap-2 md:grid-cols-3/);
  assert.match(entry, /rounded-lg border border-slate-200 bg-slate-50 px-3 py-2/);
  assert.match(entry, /Show files/);
});

test("completion, delivery, and active-section guidance start collapsed above the form", () => {
  const editor = read("../../dcad-frontend/src/features/uad/components/UadWorkfileEditor.tsx");
  const details = editor.indexOf('<details className="group mb-5');
  const suggestions = editor.indexOf("<UadCompletionSuggestionPanel", details);
  const packagePanel = editor.indexOf("<UadSubmissionPackagePanel", details);
  const listingGuidance = editor.indexOf("Use a minimum one-year lookback", details);
  const detailsEnd = editor.indexOf("</details>", details);
  const formContent = editor.indexOf('activeSection === "reconciliation"', detailsEnd);

  assert.ok(details >= 0, "collapsed workfile tools should exist");
  assert.ok(suggestions > details, "completion suggestions should be inside the collapsed tools");
  assert.ok(packagePanel > suggestions, "the delivery package should follow the completion tools");
  assert.ok(listingGuidance > packagePanel, "active-section guidance should share the collapsed tools");
  assert.ok(detailsEnd > listingGuidance, "the guidance should be inside the collapsed details element");
  assert.ok(formContent > detailsEnd, "the editable section content should remain outside the collapsed tools");
});
