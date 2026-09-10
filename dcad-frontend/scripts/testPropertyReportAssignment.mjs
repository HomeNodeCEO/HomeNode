import assert from "node:assert/strict";
import test from "node:test";

import {
  assignmentDraftFromDetail,
  assignmentValidationErrors,
} from "../src/lib/propertyReportAssignment.ts";
import { propertyReportLocationContext, retainPropertyReportUnemploymentComparisons } from "../src/lib/propertyReportHydration.ts";

for (const observed of [false, true]) for (const zip of [undefined, null, '', '  ', 0, '3.5'])
  for (const city of [undefined, null, '', '  ', 0, '4.5']) {
    test(`comparison hydration preserves prior ${observed}/${JSON.stringify(zip)}/${JSON.stringify(city)} semantics`, () => {
      const server = Object.freeze({ neighborhood_unemployment_pct: 'server-zip', neighborhood_city_unemployment_pct: 'server-city',
        neighborhood_unemployment_source: 'server-source', unrelated: 'server' });
      const current = Object.freeze({ neighborhood_unemployment_pct: zip, neighborhood_city_unemployment_pct: city,
        neighborhood_unemployment_zip: 'synthetic-zip', neighborhood_unemployment_source: 'zip-source',
        neighborhood_unemployment_dataset_year: 2024, neighborhood_unemployment_variable: 'zip-variable',
        neighborhood_city_unemployment_name: 'synthetic-city', neighborhood_city_unemployment_source: 'city-source',
        neighborhood_city_unemployment_dataset_year: 2023, neighborhood_city_unemployment_variable: 'city-variable', unrelated: 'draft' });
      const nonblank = value => value !== null && value !== undefined && (typeof value !== 'string' || value.trim().length > 0);
      const expected = { ...server };
      if (observed) for (const [value, keys] of [[zip, ['neighborhood_unemployment_pct', 'neighborhood_unemployment_zip',
        'neighborhood_unemployment_source', 'neighborhood_unemployment_dataset_year', 'neighborhood_unemployment_variable']],
      [city, ['neighborhood_city_unemployment_pct', 'neighborhood_city_unemployment_name', 'neighborhood_city_unemployment_source',
        'neighborhood_city_unemployment_dataset_year', 'neighborhood_city_unemployment_variable']]]) {
        if (nonblank(value)) for (const key of keys) expected[key] = current[key];
      }
      const result = retainPropertyReportUnemploymentComparisons(server, current, observed);
      assert.deepEqual(result, expected); assert.equal(result === server, !observed);
    });
  }

test('location hydration retains literal address/default state and ZIP-only digits exactly', () => {
  const fixtures = [undefined, null, {}, { address: '  ', city: 'City', postal_code: '75001-1234' },
    { address: ' 123 Main ', city: ' City ', state: '', postal_code: '75001-1234' },
    { address: 0, state: null, postal_code: 75001 }, { address: 'Main', state: ' ', postal_code: 'abc12-34567' }];
  for (const value of fixtures) {
    const before = structuredClone(value), street = String(value?.address || '').trim();
    const display = (item, fallback = 'Not reported') => item == null || (typeof item === 'string' && !item.trim()) ? fallback : String(item);
    const address = display(value?.address, 'Property address unavailable');
    const expected = { documentReviewSubjectAddress: street
      ? [street, value?.city, value?.state || 'TX', value?.postal_code].map(item => String(item || '').trim()).filter(Boolean).join(', ')
      : '', censusZip: String(value?.postal_code || '').replace(/\D/g, '').slice(0, 5),
      streetAddress: address.split(',')[0].trim() || address, city: display(value?.city), state: display(value?.state, 'TX'), postalCode: display(value?.postal_code) };
    assert.deepEqual(propertyReportLocationContext(value), expected); assert.deepEqual(value, before);
  }
});

test("assignment hydration preserves explicit values and clones arrays", () => {
  const source = {
    pud: true,
    subject_conforms_to_neighborhood: false,
    assignment_types: ["purchase_transaction"],
    contract_closing_date: "2026-09-24",
    contract_property_condition: "as_is",
    lender_revision_count: -2,
  };
  const draft = assignmentDraftFromDetail(source);
  assert.equal(draft.pud, true);
  assert.equal(draft.subject_conforms_to_neighborhood, false);
  assert.deepEqual(draft.assignment_types, ["purchase_transaction"]);
  assert.notEqual(draft.assignment_types, source.assignment_types);
  assert.equal(draft.contract_closing_date, "2026-09-24");
  assert.equal(draft.contract_property_condition, "as_is");
  assert.equal(draft.lender_revision_count, 0);
});

test("assignment validation retains established PUD and explanation rules", () => {
  assert.deepEqual(
    assignmentValidationErrors({ pud: true }),
    ["Enter HOA dues and a frequency, or explain why they are unavailable."],
  );
  assert.deepEqual(
    assignmentValidationErrors({ pud: true, hoa_explanation: "Not provided by management" }),
    [],
  );
  assert.deepEqual(
    assignmentValidationErrors({ occupancy: "unknown" }),
    ["Explain why occupancy is unknown."],
  );
});

test("assignment validation retains established contract safeguards", () => {
  const errors = assignmentValidationErrors({
    subject_under_contract: true,
    assignment_types: [],
    contract_arms_length: null,
    contract_price: "",
    contract_date: "",
    contract_closing_date: "",
    seller_matches_public_records: null,
  });
  assert.deepEqual(errors, [
    "Subject Under Contract requires Purchase Transaction in Assignment Details.",
    "Select Yes or No for Arms Length.",
    "Enter the subject contract price.",
    "Enter a valid subject contract date.",
    "Enter a valid contract closing date.",
    "Select Yes or No for whether the seller matches public records.",
  ]);
});

test("assignment validation retains land-use and nonconformity checks", () => {
  const errors = assignmentValidationErrors({
    subject_conforms_to_neighborhood: false,
    neighborhood_land_use_one_unit_pct: 40,
    neighborhood_land_use_two_to_four_unit_pct: 10,
    neighborhood_land_use_multifamily_pct: 10,
    neighborhood_land_use_commercial_pct: 10,
    neighborhood_land_use_other_vacant_pct: 10,
  });
  assert.deepEqual(errors, [
    "Select the subject's neighborhood nonconformity type.",
    "Explain why the subject does not conform to the neighborhood.",
    "Present land use percentages must total 100%.",
  ]);
});
