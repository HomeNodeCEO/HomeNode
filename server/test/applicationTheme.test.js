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
  assert.match(css, /--hn-violet: #7551a2/);
  assert.match(css, /--hn-gold: #c6a15b/);
  assert.match(css, /--hn-app-bg: #f3eff7/);
  assert.match(css, /--hn-champagne: #fff8e8/);
  assert.match(css, /\.hn-action-primary/);
  assert.match(css, /\.hn-action-gold/);
  assert.match(css, /\.hn-navigation-button-active/);
  assert.doesNotMatch(css, /#e32ff7|#c71bd9|HomeNode magenta/i);
});

test("shared theme foregrounds retain readable contrast on their light and dark surfaces", () => {
  const css = read("../../dcad-frontend/src/index.css");
  const token = (name) => {
    const match = css.match(new RegExp(`--hn-${name}:\\s*(#[0-9a-f]{6})`, "i"));
    assert.ok(match, `Missing color token ${name}`);
    return match[1];
  };
  const luminance = (hex) => {
    const channels = hex.slice(1).match(/../g).map((value) => {
      const channel = parseInt(value, 16) / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  for (const [foreground, background] of [
    ["champagne", "violet"], ["champagne", "violet-hover"],
    ["champagne", "lavender-hover"], ["champagne-muted", "deep-purple"],
    ["midnight", "gold"], ["text", "surface"], ["muted", "surface-muted"],
  ]) {
    const light = luminance(token(foreground));
    const dark = luminance(token(background));
    const ratio = (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05);
    assert.ok(ratio >= 4.5, `${foreground} on ${background}: ${ratio.toFixed(2)}:1`);
  }
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
