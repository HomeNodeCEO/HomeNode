import assert from "node:assert/strict";
import test from "node:test";

import { validateUadSubschema } from "../src/modules/uad/uadSubschema.js";
import { buildUadMismoXml, getUadXmlMappingSummary } from "../src/modules/uad/uadXml.js";

const RELEASE_KEY = "uad-3.6-2026-08-13-h1.5";

function editorFixture() {
  const propertyId = "00000000-0000-4000-8000-000000000001";
  const dwellingId = "00000000-0000-4000-8000-000000000002";
  const unitId = "00000000-0000-4000-8000-000000000003";
  const parcelId = "00000000-0000-4000-8000-000000000004";
  const comparableId = "00000000-0000-4000-8000-000000000005";
  return {
    workfile: { specification_release_key: RELEASE_KEY },
    entities: [
      { id: propertyId, parent_entity_id: null, entity_type: "property", entity_identifier: "subject", ordinal: 1 },
      { id: dwellingId, parent_entity_id: propertyId, entity_type: "dwelling", entity_identifier: "dwelling-1", ordinal: 1 },
      { id: unitId, parent_entity_id: dwellingId, entity_type: "unit", entity_identifier: "unit-1", ordinal: 1 },
      { id: parcelId, parent_entity_id: propertyId, entity_type: "site_parcel", entity_identifier: "parcel-1", ordinal: 1 },
      { id: comparableId, parent_entity_id: null, entity_type: "sales_comparable", entity_identifier: "sales-comparable-1", ordinal: 1 },
    ],
    values: [
      { entity_id: comparableId, context_key: "sales_comparable_address", uid: "1800.0001", value: "1911 Snowmass Ln" },
      { entity_id: unitId, context_key: "unit", uid: "0700.0140", value: { amount: 2015, unit: "SquareFeet" } },
      { entity_id: parcelId, context_key: "site_parcel", uid: "1500.0022", value: { amount: 0.31, unit: "Acres" } },
      { entity_id: dwellingId, context_key: "dwelling", uid: "0300.0011", value: "1998" },
      { entity_id: null, context_key: "subject_address", uid: "0100.0007", value: "1909 Snowmass Ln & Unit A" },
    ],
  };
}

test("locked delivery mapping covers every HomeNode UAD unique ID", () => {
  assert.deepEqual(getUadXmlMappingSummary(), {
    specification_release_key: RELEASE_KEY,
    delivery_specification_version: "1.4",
    subschema_version: "1.3",
    mismo_reference_model_identifier: "3.6.0366",
    source_sha256: "10f470ed53ee6f70404aad850f3f3c15aaee9489f654535ee0a3e5d1a8adee29",
    mapped_unique_ids: 834,
    mapped_entity_types: 87,
  });
});

test("MISMO XML generation is deterministic and preserves subject/comparable identity", () => {
  const editor = editorFixture();
  const first = buildUadMismoXml(editor);
  const second = buildUadMismoXml({ ...editor, values: [...editor.values].reverse() });

  assert.equal(first.xml, second.xml);
  assert.equal(first.checksum_sha256, second.checksum_sha256);
  assert.equal(first.byte_size, Buffer.byteLength(first.xml, "utf8"));
  assert.match(first.xml, /MISMOReferenceModelIdentifier="3\.6\.0366"/);
  assert.match(first.xml, /<PROPERTY xlink:label="PROPERTY_SubjectProperty">/);
  assert.match(first.xml, /<PROPERTY ValuationUseType="SalesComparable" xlink:label="PROPERTY_SalesComparable1">/);
  assert.match(first.xml, /<AddressLineText>1909 Snowmass Ln &amp; Unit A<\/AddressLineText>/);
  assert.match(first.xml, /<UnitStandardAboveGradeFinishedAreaMeasure AreaUnitOfMeasureType="SquareFeet">2015<\/UnitStandardAboveGradeFinishedAreaMeasure>/);
  assert.match(first.xml, /<ParcelAreaMeasure AreaUnitOfMeasureType="Acres">0\.31<\/ParcelAreaMeasure>/);
});

test("MISMO XML generation places Section 26 conclusions and client conditions in their official structures", () => {
  const editor = editorFixture();
  const conditionId = "00000000-0000-4000-8000-000000000006";
  const subjectProperty = editor.entities.find((entity) => entity.entity_type === "property");
  const defectId = "00000000-0000-4000-8000-000000000007";
  editor.entities.push({
    id: conditionId,
    parent_entity_id: null,
    entity_type: "additional_requested_conditional_valuation",
    entity_identifier: "client-condition-1",
    ordinal: 1,
  });
  editor.entities.push({
    id: defectId,
    parent_entity_id: subjectProperty.id,
    entity_type: "site_defect",
    entity_identifier: "site-defect-1",
    ordinal: 1,
  });
  editor.values.push(
    { entity_id: null, context_key: "reconciliation", uid: "1300.0017", value: 305000 },
    { entity_id: null, context_key: "reconciliation", uid: "1300.0010", value: ["AsIs"] },
    { entity_id: null, context_key: "reconciliation", uid: "1300.0013", value: 45 },
    { entity_id: conditionId, context_key: "additional_requested_conditional_valuation", uid: "1300.0022", value: ["SubjectToRepair"] },
    { entity_id: conditionId, context_key: "additional_requested_conditional_valuation", uid: "1300.0027", value: 310000 },
    { entity_id: null, context_key: "defect_summary", uid: "3900.0001", value: "Itemized" },
    { entity_id: null, context_key: "defect_summary", uid: "3900.0002", value: 1250 },
    { entity_id: defectId, context_key: "site_defect", uid: "3900.0126", value: 1250 },
  );

  const generated = buildUadMismoXml(editor);

  assert.match(generated.xml, /<OpinionOfValueAmount>305000<\/OpinionOfValueAmount>/);
  assert.match(generated.xml, /<PropertyValuationConditionalConclusionType>AsIs<\/PropertyValuationConditionalConclusionType>/);
  assert.match(generated.xml, /<MarketingOrExposureDaysCount>45<\/MarketingOrExposureDaysCount>/);
  assert.match(generated.xml, /<ADDITIONAL_REQUESTED_CONDITIONAL_VALUATION>/);
  assert.match(generated.xml, /<PropertyValuationConditionalConclusionType>SubjectToRepair<\/PropertyValuationConditionalConclusionType>/);
  assert.match(generated.xml, /<AdditionalOpinionOfValueAmount>310000<\/AdditionalOpinionOfValueAmount>/);
  assert.match(generated.xml, /<CostToRepairType>Itemized<\/CostToRepairType>/);
  assert.match(generated.xml, /<DefectItemEstimatedCostToRepairAmount>1250<\/DefectItemEstimatedCostToRepairAmount>/);
  assert.match(generated.xml, /<DefectCostToRepairTotalAmount>1250<\/DefectCostToRepairTotalAmount>/);
});

test("the official subschema validator returns blocking structural findings", async () => {
  const generated = buildUadMismoXml(editorFixture());
  const validation = await validateUadSubschema(generated.xml);

  assert.equal(validation.valid, false);
  assert.equal(validation.subschema_version, "1.3");
  assert.match(validation.validator_version, /xmllint-wasm-5\.3\.0$/);
  assert.match(validation.schema_sha256, /^[a-f0-9]{64}$/);
  assert.ok(validation.errors.some((error) => error.message.includes("VALUATION_REPORT")));
  assert.ok(validation.errors.some((error) => error.message.includes("PARTIES")));
  assert.ok(validation.errors.some((error) => error.message.includes("SIGNATORIES")));
});

test("generation refuses workfiles tied to another specification release", () => {
  const editor = editorFixture();
  editor.workfile.specification_release_key = "future-release";
  assert.throws(() => buildUadMismoXml(editor), /uad_xml_specification_release_mismatch/);
});
