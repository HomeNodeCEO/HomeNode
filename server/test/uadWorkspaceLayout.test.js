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
  assert.match(editor, /lg:grid-cols-\[20%_78%\]/);
  assert.doesNotMatch(editor, /lg:max-h-\[calc\(100vh-6rem\)\]/);
  assert.doesNotMatch(editor, /lg:overflow-y-auto/);
  assert.doesNotMatch(editor, /lg:sticky lg:top-20/);
  assert.doesNotMatch(editor, /mt-6 overflow-hidden rounded-2xl/);
  assert.match(editor, /aria-current=\{active \? "step" : undefined\}/);
  assert.match(editor, /grid-cols-\[5rem_minmax\(0,1fr\)\]/);
  assert.match(editor, /w-full px-3 py-3\.5 text-left/);
  assert.match(editor, /grid w-full grid-cols-\[5rem_minmax\(0,1fr\)\]/);
  assert.match(editor, /gap-x-2 gap-y-4/);
  assert.match(editor, /col-span-2 justify-self-start whitespace-nowrap text-left font-semibold text-black/);
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

test("successful UAD autosaves apply the save response without reloading the full editor", () => {
  const editor = read("../../dcad-frontend/src/features/uad/components/UadWorkfileEditor.tsx");
  const successStart = editor.indexOf("let latestResult: UadSectionSaveResult | null = null");
  const successEnd = editor.indexOf("} catch (reason)", successStart);
  const successPath = editor.slice(successStart, successEnd);

  assert.ok(successStart >= 0, "autosave should retain the latest section-save response");
  assert.ok(successEnd > successStart, "autosave success path should be inspectable");
  assert.match(successPath, /values: latestResult\.values/);
  assert.match(successPath, /completion: latestResult\.completion/);
  assert.doesNotMatch(successPath, /getUadEditor\(workfileId\)/);
  assert.match(editor.slice(successEnd), /getUadEditor\(workfileId\)/, "conflict recovery should still reload authoritative state");
});

test("the UAD close-report action saves pending changes before returning to property search", () => {
  const entry = read("../../dcad-frontend/src/features/uad/pages/UadWorkspaceEntry.tsx");
  const editor = read("../../dcad-frontend/src/features/uad/components/UadWorkfileEditor.tsx");
  const closeStart = editor.indexOf("async function handleCloseReport()");
  const closeEnd = editor.indexOf("\n  }", closeStart);
  const closePath = editor.slice(closeStart, closeEnd);

  assert.ok(closeStart >= 0, "the UAD editor should expose a close-report handler");
  assert.match(closePath, /dirtyKeysRef\.current\.size && !\(await persistAutosave\(\)\)/);
  assert.match(closePath, /onClose\(\)/);
  assert.match(editor, /← Close Report/);
  assert.match(entry, /onClose=\{\(\) => navigate\("\/"\)\}/);
});
