import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../src/pages/PropertyReport.tsx', import.meta.url), 'utf8');

function tailwindFlexOrder(openingTag) {
  const orderMatch = openingTag.match(/\border-(-?\d+)\b/);
  return orderMatch ? Number(orderMatch[1]) : 0;
}

function openingTagAt(index) {
  const end = source.indexOf('>', index);
  assert.ok(end >= index, 'expected a complete opening tag');
  return source.slice(index, end + 1);
}

test('document evidence precedes one combined subject and assignment section', () => {
  const documents = source.indexOf('<AssignmentDocumentCenter');
  const combined = source.indexOf('title="Subject and Assignment"');
  const following = source.indexOf('title="Listings, Contracts, and Sales History"');

  assert.ok(documents >= 0 && documents < combined);
  const combinedOpeningStart = source.lastIndexOf('<SummarySection', combined);
  assert.ok(combinedOpeningStart >= documents);
  assert.ok(
    tailwindFlexOrder(openingTagAt(documents)) < tailwindFlexOrder(openingTagAt(combinedOpeningStart)),
    'the rendered flex order must keep document evidence above subject and assignment',
  );
  assert.equal((source.match(/<AssignmentDocumentCenter/g) ?? []).length, 1);
  assert.equal((source.match(/title="Subject and Assignment"/g) ?? []).length, 1);
  assert.doesNotMatch(source, /title="Subject Identification"|title="Assignment Details"/);

  const section = source.slice(combined, following);
  assert.match(section, /label="Parcel \/ Account Number"/);
  assert.match(section, /<h3[^>]*>Assignment Scope<\/h3>/);
  assert.match(section, /<legend[^>]*>Assignment Type<\/legend>/);
  assert.match(section, /Save Assignment Details/);
});
