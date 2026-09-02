import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  countyFromAccount,
  legalDescriptionFromAccount,
  legalDescriptionFromDetail,
  mailingAddressFromDetail,
  mapscoFromDetail,
  ownerNameFromDetail,
  signupErrorMessage,
  subjectAddressFromAccount,
  subjectAddressFromDetail,
} from '../src/features/signup/signupPrefill.ts';

test('signup prefill reads supported account and legacy detail shapes', () => {
  const account = {
    account: { county: 'COLLIN county', address: '123 Main St' },
    legal_current: { legal_lines: ['LOT 1', 'BLOCK A'] },
  };
  const detail = {
    detail: {
      property_location: { address: '456 Legacy Ln', mapsco: '12-A' },
      owner: { mailing_address: 'PO Box 1, Dallas, TX 75201' },
      legal_description: { lines: ['TRACT 2', 'CITY BLOCK 3'] },
    },
    owner: { owner_name: 'Example Owner' },
  };

  assert.equal(countyFromAccount(account), 'COLLIN county');
  assert.equal(subjectAddressFromAccount(account), '123 Main St');
  assert.equal(legalDescriptionFromAccount(account), 'LOT 1\nBLOCK A');
  assert.equal(subjectAddressFromDetail(detail), '456 Legacy Ln');
  assert.equal(mapscoFromDetail(detail), '12-A');
  assert.equal(mailingAddressFromDetail(detail), 'PO Box 1, Dallas, TX 75201');
  assert.equal(legalDescriptionFromDetail(detail), 'TRACT 2\nCITY BLOCK 3');
  assert.equal(ownerNameFromDetail(detail), 'Example Owner');
});

test('owner lookup preserves multi-owner and history fallbacks', () => {
  assert.equal(ownerNameFromDetail({
    owner: { multi_owner: [{ owner_name: 'Second Shape' }] },
  }), 'Second Shape');
  assert.equal(ownerNameFromDetail({
    history: { owner_history: [{ owner: 'Historical Owner' }] },
  }), 'Historical Owner');
});

test('signup prefill rejects malformed objects at text boundaries', () => {
  const malformed = {
    account: { county: { hidden: true }, address: ['unsafe'] },
    legal_current: { legal_lines: [{ hidden: true }, ' VALID '] },
    detail: {
      property_location: { address: { unsafe: true }, mapsco: [] },
      owner: { mailing_address: { unsafe: true } },
      legal_description: { lines: [{ unsafe: true }, ' SAFE '] },
    },
    owner: { owner_name: { unsafe: true } },
  };
  assert.equal(countyFromAccount(malformed), '');
  assert.equal(subjectAddressFromAccount(malformed), '');
  assert.equal(legalDescriptionFromAccount(malformed), 'VALID');
  assert.equal(subjectAddressFromDetail(malformed), '');
  assert.equal(mapscoFromDetail(malformed), '');
  assert.equal(mailingAddressFromDetail(malformed), '');
  assert.equal(legalDescriptionFromDetail(malformed), 'SAFE');
  assert.equal(ownerNameFromDetail(malformed), '');
});

test('signup errors are bounded and do not stringify arbitrary payloads', () => {
  assert.equal(signupErrorMessage(new Error('Request timed out')), 'Request timed out');
  assert.equal(signupErrorMessage({ message: 'Invalid submission' }), 'Invalid submission');
  assert.equal(signupErrorMessage({ secret: 'do not show' }), 'Submit failed');
  assert.equal(signupErrorMessage(new Error('x'.repeat(200))).length, 160);
});

test('the signup form boundary contains no explicit any or raw submission fetch', async () => {
  const source = await readFile(new URL('../src/pages/SignUpForm.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bas any\b|:\s*any\b|<any>|Record<string,\s*any>/);
  assert.doesNotMatch(source, /fetch\(api\.makeUrl\('\/api\/signup\/email'/);
  assert.match(source, /api\.fetchJSON/);
  assert.match(source, /legalDescriptionFromDetail\(det\) \|\| legalFromDetail/);
});
