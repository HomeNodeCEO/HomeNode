import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const read = (relative) => fs.readFileSync(path.resolve(directory, relative), "utf8");

test("the shared HomeNode theme uses the approved purple and gold design tokens", () => {
  const css = read("../../dcad-frontend/src/index.css");

  assert.match(css, /--hn-midnight: #120d24/);
  assert.match(css, /--hn-violet: #6d28d9/);
  assert.match(css, /--hn-gold: #c6a15b/);
  assert.match(css, /--hn-app-bg: #f7f6fa/);
  assert.match(css, /\.hn-action-primary/);
  assert.match(css, /\.hn-action-gold/);
  assert.match(css, /\.hn-navigation-button-active/);
  assert.doesNotMatch(css, /#e32ff7|#c71bd9|HomeNode magenta/i);
});

test("the application frame and primary workflow entry points share the theme", () => {
  const sources = [
    "../../dcad-frontend/src/features/auth/ApplicationAuth.tsx",
    "../../dcad-frontend/src/features/uad/pages/UadWorkspaceEntry.tsx",
    "../../dcad-frontend/src/pages/PropertySearch.tsx",
    "../../dcad-frontend/src/pages/PropertyReport.tsx",
    "../../dcad-frontend/src/pages/PropertyTaxProtest.tsx",
  ].map(read);

  for (const source of sources) assert.match(source, /hn-app-(shell|header)/);
  assert.match(sources[0], /hn-action-primary/);
  assert.match(sources[1], /hn-workspace-surface/);
  assert.match(sources[2], /hn-workspace-surface/);
  assert.match(sources[4], /hn-action-gold/);
});

test("UAD navigation uses themed navigation states without changing its approved geometry", () => {
  const editor = read("../../dcad-frontend/src/features/uad/components/UadWorkfileEditor.tsx");

  assert.match(editor, /hn-navigation-button/);
  assert.match(editor, /hn-navigation-button-active/);
  assert.match(editor, /lg:grid-cols-\[20%_78%\]/);
  assert.match(editor, /grid-cols-\[5rem_minmax\(0,1fr\)\]/);
  assert.match(editor, /gap-x-2 gap-y-4/);
});

test("the application theme remains print safe", () => {
  const css = read("../../dcad-frontend/src/index.css");

  assert.match(css, /@media print/);
  assert.match(css, /background: #fff !important/);
  assert.match(css, /color: #000 !important/);
});
