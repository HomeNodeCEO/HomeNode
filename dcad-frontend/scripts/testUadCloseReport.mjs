import assert from "node:assert/strict";
import fs from "node:fs";

const entry = fs.readFileSync(new URL("../src/features/uad/pages/UadWorkspaceEntry.tsx", import.meta.url), "utf8");
const editor = fs.readFileSync(new URL("../src/features/uad/components/UadWorkfileEditor.tsx", import.meta.url), "utf8");

assert.match(entry, /hn-app-header navbar shadow-sm/);
assert.match(entry, /<h1 className="text-xl font-semibold">UAD 3\.6 Workspace<\/h1>/);
assert.match(entry, /← Close Report/);
assert.match(entry, /workfileEditorRef\.current\.closeReport\(\)/);
assert.match(entry, /ref=\{workfileEditorRef\}/);
assert.match(editor, /useImperativeHandle\(ref, \(\) => \(\{ closeReport: handleCloseReport \}\)/);
assert.equal((editor.match(/← Close Report/g) || []).length, 0);

console.log(JSON.stringify({ ready: true, profile: "uad_close_report_header_v1" }));
