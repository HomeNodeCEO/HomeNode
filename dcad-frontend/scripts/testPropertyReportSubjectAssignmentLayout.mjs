import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../src/pages/PropertyReport.tsx', import.meta.url), 'utf8');

function tailwindFlexOrder(openingTag) {
  const classMatch = openingTag.match(/className\s*=\s*["']([^"']*)["']/);
  assert.doesNotMatch(openingTag, /className\s*=\s*\{/, 'dynamic order classes need rendered coverage');
  const orderTokens = (classMatch?.[1] ?? '').split(/\s+/).filter(token => /(?:^|:)order-/.test(token) || /^-order-/.test(token));
  assert.ok(orderTokens.length <= 1, 'only one unprefixed numeric order utility is supported');
  if (!orderTokens.length) return 0;
  const [orderToken] = orderTokens;
  assert.match(orderToken, /^(?:order-\d+|-order-\d+)$/, `unsupported Tailwind order utility: ${orderToken}`);
  return orderToken.startsWith('-order-') ? -Number(orderToken.slice(7)) : Number(orderToken.slice(6));
}

function openingTagAt(index) {
  const end = source.indexOf('>', index);
  assert.ok(end >= index, 'expected a complete opening tag');
  return source.slice(index, end + 1);
}

test('visual-order guard rejects unsupported responsive and symbolic utilities', () => {
  for (const className of ['order-last', 'order-[7]', 'sm:order-0', 'order-first order-1']) {
    assert.throws(() => tailwindFlexOrder(`<section className="${className}">`));
  }
  assert.equal(tailwindFlexOrder('<section className="order-2">'), 2);
  assert.equal(tailwindFlexOrder('<section className="-order-2">'), -2);
});

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
