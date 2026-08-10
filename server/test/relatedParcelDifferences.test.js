import assert from "node:assert/strict";
import test from "node:test";

import {
  markMaterialParcelDifferences,
  materialParcelDifferences,
} from "../src/util/relatedParcelDifferences.js";

const subject = {
  account_id: "SUBJECT",
  is_subject: true,
  site_address: "1909 SNOWMASS LN",
  legal_description: "LOT 15 BLOCK A",
  living_area_sqft: 1800,
  land_value: 50000,
  improvement_value: 200000,
  total_value: 250000,
  use_description: "SINGLE FAMILY",
};

test("same-address account is not material solely because its account id differs", () => {
  assert.deepEqual(materialParcelDifferences(subject, {
    ...subject,
    account_id: "ANOTHER",
    is_subject: false,
    address: "1909 Snowmass Ln, Garland, TX 75044",
  }), []);
});

test("known characteristic and value differences are identified", () => {
  assert.deepEqual(materialParcelDifferences(subject, {
    ...subject,
    account_id: "ANOTHER",
    is_subject: false,
    legal_description: "LOT 16 BLOCK A",
    living_area_sqft: 2100,
    total_value: 310000,
  }), ["Market / total value", "Living area", "Legal description"]);
});

test("unknown fields alone do not create a false parcel warning", () => {
  const marked = markMaterialParcelDifferences([
    subject,
    {
      account_id: "ANOTHER",
      is_subject: false,
      site_address: "1909 SNOWMASS LN",
      legal_description: null,
      total_value: null,
    },
  ], "SUBJECT");
  assert.equal(marked[1].materially_different, false);
  assert.deepEqual(marked[1].difference_fields, []);
});
