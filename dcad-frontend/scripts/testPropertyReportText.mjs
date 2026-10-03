import assert from 'node:assert/strict';
import test from 'node:test';
import { reportTitleCase, reportAddress, reportZip5, reportNeighborhoodName } from '../src/lib/propertyReportText.ts';
import { editablePropertyReportSectionValue } from '../src/lib/propertyReportEditableSections.ts';
import { propertyReportLocationContext } from '../src/lib/propertyReportHydration.ts';
import { assignmentDraftFromDetail } from '../src/lib/propertyReportAssignment.ts';

test('report casing changes letters only and preserves established spelling, acronyms and name order', () => {
  for (const [raw, expected] of [
    ['MORGAN EXAMPLE', 'Morgan Example'], ['TAYLOR CASEY JR & SAMPLE JORDAN', 'Taylor Casey Jr & Sample Jordan'],
    ["O'NEILL ANNE-MARIE", "O'Neill Anne-Marie"], ['McDonald DeVito LLC', 'McDonald DeVito LLC'],
    ['JOSÉ ÁLVAREZ', 'José Álvarez'], ['al in', 'Al In'], ['OWNER II & OWNER III', 'Owner II & Owner III'],
  ]) assert.equal(reportTitleCase(raw), expected);
  assert.equal(reportTitleCase(null), '');
  assert.equal(reportTitleCase({}), '');
});

test('address display uses title case, postal state codes and ZIP5 without rewriting a street number', () => {
  assert.equal(reportAddress('100 EXAMPLE DR'), '100 Example Dr');
  assert.equal(reportAddress('400 TEST AVENUE, AUSTIN TX 78701-0001'), '400 Test Avenue, Austin TX 78701');
  assert.equal(reportAddress('12 IN THE WOODS DR'), '12 In The Woods Dr');
  assert.equal(reportAddress('PO BOX 32, DALLAS TX 75201'), 'PO Box 32, Dallas TX 75201');
  assert.equal(reportAddress('12345-6789 HIGHWAY RD'), '12345-6789 Highway Rd');
  assert.equal(reportZip5('75060-1234'), '75060');
  assert.equal(reportZip5('00001-0002'), '00001');
  assert.equal(reportZip5('750601234'), '75060');
  assert.equal(reportAddress('100 EXAMPLE DR, IRVING, TEXAS 750601234'), '100 Example Dr, Irving, Texas 75060');
  for (const value of ['7506', '75060-3', 'abc75060']) assert.equal(reportZip5(value), value);
});

test('neighborhood display removes only a terminal numeric phase, not internal digits or raw legal text', () => {
  assert.equal(reportNeighborhoodName('EXAMPLE PARK 04'), 'Example Park');
  assert.equal(reportNeighborhoodName('  EXAMPLE PARK 4  '), 'Example Park');
  assert.equal(reportNeighborhoodName('PARK 51 ESTATES'), 'Park 51 Estates');
  assert.equal(reportNeighborhoodName('EXAMPLE PARK IV'), 'Example Park IV');
});

test('Subject editor displays formatted values without mutating retained CAD and evidence facts', () => {
  const detail = {
    urar_subject: { borrower_name: 'MORGAN EXAMPLE', listing_history_summary: 'Subject was listed on 04/19/2026 for $345,000, no reductions in list price, on the market for 68 days, under current contract on 07/15/2026' },
    property_location: { address: '100 EXAMPLE DR', city: 'IRVING', state: 'TX', postal_code: '75060-1234', subdivision: 'EXAMPLE PARK 4', census_tract: '001234' },
    owner: { owner_name: 'TAYLOR CASEY JR', parties: [{ owner_name: 'TAYLOR CASEY JR', ownership_pct: 50 }, { owner_name: 'SAMPLE JORDAN', ownership_pct: 50 }] },
    legal_description: { lines: ['EXAMPLE PARK 4', 'BLK 1 LOT 2'] },
  };
  const before = structuredClone(detail);
  const editor = editablePropertyReportSectionValue('report.subject_identification', { detail, inspectionDetails: {}, additionalImprovements: [] });
  assert.equal(editor.property_location.address, '100 Example Dr');
  assert.equal(editor.property_location.city, 'Irving');
  assert.equal(editor.property_location.postal_code, '75060');
  assert.equal(editor.property_location.subdivision, 'Example Park');
  assert.equal(editor.property_location.census_tract, '12.34');
  assert.equal(editor.urar_subject.borrower_name, 'Morgan Example');
  assert.equal(editor.owner.parties[1].owner_name, 'Sample Jordan');
  assert.equal(editor.urar_subject.listing_history_summary, before.urar_subject.listing_history_summary);
  assert.deepEqual(editor.legal_description.lines, before.legal_description.lines);
  assert.deepEqual(detail, before);
  const context = propertyReportLocationContext(detail.property_location);
  assert.equal(context.streetAddress, '100 Example Dr');
  assert.equal(context.city, 'Irving'); assert.equal(context.postalCode, '75060');
  assert.equal(context.documentReviewSubjectAddress, '100 EXAMPLE DR, IRVING, TX, 75060-1234');
});

test('lender address hydration is formatted and explicit PUD None stays false', () => {
  const source = { lender_client_address: '400 TEST AVENUE, AUSTIN TX 78701', pud: false, hoa_dues_amount: '' };
  const copy = structuredClone(source);
  assert.equal(assignmentDraftFromDetail(source).lender_client_address, '400 Test Avenue, Austin TX 78701');
  assert.equal(assignmentDraftFromDetail(source).pud, false);
  assert.deepEqual(source, copy);
});
