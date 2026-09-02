import assert from "node:assert/strict";
import test from "node:test";

import {
  buildUadPublicRecordOwners,
  uadPublicRecordOwnerNameValues,
} from "../src/modules/uad/publicRecordOwners.js";
import { getUadEditorSections } from "../src/modules/uad/fieldCatalog.js";

test("maps an appraisal-district individual name into UAD owner name parts", () => {
  assert.deepEqual(uadPublicRecordOwnerNameValues("PATTERSON GREGORY SCOTT"), [
    { uid: "1000.0022", context_key: "owner", value: "GREGORY" },
    { uid: "1000.0174", context_key: "owner", value: "SCOTT" },
    { uid: "1000.0023", context_key: "owner", value: "PATTERSON" },
  ]);
});

test("preserves legal-entity public-record owners verbatim", () => {
  assert.deepEqual(uadPublicRecordOwnerNameValues("Example Holdings, LLC"), [
    { uid: "1000.0024", context_key: "owner", value: "Example Holdings, LLC" },
  ]);
});

test("builds distinct owner parties from the latest public-record party rows", () => {
  const owners = buildUadPublicRecordOwners({
    owner_summary: { tax_year: 2026, owner_name: "PATTERSON GREGORY SCOTT & GINA R PATTERSON" },
    owner_parties: [
      { tax_year: 2026, owner_name: "PATTERSON GREGORY SCOTT", ownership_pct: 50 },
      { tax_year: 2026, owner_name: "GINA R PATTERSON", ownership_pct: 50 },
    ],
  });
  assert.equal(owners.length, 2);
  assert.equal(owners[0].values.find((value) => value.uid === "1000.0023")?.value, "PATTERSON");
  assert.equal(owners[1].values.find((value) => value.uid === "1000.0022")?.value, "GINA");
  assert.equal(owners[1].values.find((value) => value.uid === "1000.0023")?.value, "PATTERSON");
  assert.equal(owners[1].ownershipPercent, 50);
});

test("falls back to a split owner summary when party rows are unavailable", () => {
  const owners = buildUadPublicRecordOwners({
    owner_summary: { tax_year: 2026, owner_name: "LOREDO LORENZO JR & THOMPSON ANDI" },
    owner_parties: [],
  });
  assert.equal(owners.length, 2);
  assert.deepEqual(owners.map((owner) => owner.name), ["LOREDO LORENZO JR", "THOMPSON ANDI"]);
  assert.equal(owners[0].values.find((value) => value.uid === "1000.0175")?.value, "JR");
});

test("Section 2 exposes current public-record owners as reviewable repeatable parties", () => {
  const assignment = getUadEditorSections().find((section) => section.key === "assignment");
  const owners = assignment.groups.find((group) => group.entityType === "assignment_owner");
  assert.equal(owners.name, "Current owner of public record");
  assert.equal(owners.addLabel, "Add owner");
  assert.ok(owners.fields.every((field) => field.entityType === "assignment_owner"));
});
