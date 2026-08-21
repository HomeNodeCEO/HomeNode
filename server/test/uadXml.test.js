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
    workfile: {
      id: "00000000-0000-4000-8000-000000000000",
      file_number: "UAD-STAGING-SFR-0001",
      current_revision: 1,
      specification_release_key: RELEASE_KEY,
    },
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
    mapped_unique_ids: 845,
    mapped_system_unique_ids: 12,
    mapped_total_unique_ids: 857,
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
  assert.match(first.xml, /<ValuationReportContentIdentifier>URAR Delivery Specification v1\.4<\/ValuationReportContentIdentifier>/);
  assert.match(first.xml, /<ValuationSoftwareProductIdentifier>HOMENODE-UAD-3\.6<\/ValuationSoftwareProductIdentifier>/);
  assert.match(first.xml, /<ServiceType>Valuation<\/ServiceType>/);
  assert.match(first.xml, /<ObjectURL>\\\\UAD-STAGING-SFR-0001\.pdf<\/ObjectURL>/);
  assert.match(first.xml, /<MIMETypeIdentifier>application\/pdf<\/MIMETypeIdentifier>/);
  assert.match(first.xml, /<AboutVersionIdentifier>1<\/AboutVersionIdentifier>/);
  assert.match(first.xml, /<DocumentType>AppraisalReport<\/DocumentType>/);
  assert.match(first.xml, /<DocumentFormIssuingEntityNameType>FNM_FRE<\/DocumentFormIssuingEntityNameType>/);
  assert.match(first.xml, /<DocumentFormIssuingEntityVersionIdentifier>September 2024<\/DocumentFormIssuingEntityVersionIdentifier>/);
  assert.equal(first.system_value_count, 12);
  assert.equal(first.pdf_file_name, "UAD-STAGING-SFR-0001.pdf");
});

test("MISMO XML generation references deterministic external delivery images", async () => {
  const editor = editorFixture();
  const comparable = editor.entities.find((entity) => entity.entity_type === "sales_comparable");
  const generated = buildUadMismoXml(editor, {
    assets: [
      {
        id: "10000000-0000-4000-8000-000000000001",
        entity_id: comparable.id,
        asset_kind: "photo",
        section_number: 22,
        caption_type: "PropertyPhoto",
        caption: "Comparable one",
        object_key: "private/comparable-one.png",
        original_file_name: "Comparable One.png",
        content_type: "image/png",
        byte_size: 123,
        checksum_sha256: "a".repeat(64),
        status: "verified",
        created_at: "2026-08-20T00:00:00.000Z",
      },
      {
        id: "10000000-0000-4000-8000-000000000002",
        entity_id: null,
        asset_kind: "photo",
        section_number: 8,
        caption_type: "DwellingFront",
        caption: null,
        object_key: "private/subject-front.jpg",
        original_file_name: "Subject Front.jpg",
        content_type: "image/jpeg",
        byte_size: 456,
        checksum_sha256: "b".repeat(64),
        status: "verified",
        created_at: "2026-08-19T00:00:00.000Z",
      },
    ],
  });

  assert.equal(generated.image_reference_count, 2);
  assert.match(generated.xml, /<ImageCategoryType>DwellingFront<\/ImageCategoryType>/);
  assert.match(generated.xml, /<ImageFileLocationIdentifier>\\\\Images\\001-100000000000-Subject-Front\.jpg<\/ImageFileLocationIdentifier>/);
  assert.match(generated.xml, /<PROPERTY ValuationUseType="SalesComparable" xlink:label="PROPERTY_SalesComparable1">[\s\S]*?<ImageCategoryType>PropertyPhoto<\/ImageCategoryType>/);
  assert.match(generated.xml, /<MIMETypeIdentifier>image\/png<\/MIMETypeIdentifier>/);
  assert.doesNotMatch(generated.xml, /private\/subject-front/);
  const schema = await validateUadSubschema(generated.xml);
  assert.equal(schema.errors.some((error) => /IMAGE|ImageFileLocationIdentifier|ImageCategoryType/.test(error.message)), false);
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

test("MISMO XML generation places Section 29 values and signed credentials in official structures", () => {
  const editor = editorFixture();
  editor.values.push(
    { entity_id: null, context_key: "certification_scope", uid: "1000.0028", value: false },
    { entity_id: null, context_key: "certification_scope", uid: "2200.0062", value: false },
    { entity_id: null, context_key: "certification_intended_user", uid: "2200.0037", value: false },
    { entity_id: null, context_key: "certification_report", uid: "2200.0034", value: false },
    { entity_id: null, context_key: "certification_report", uid: "2200.0017", value: false },
    { entity_id: null, context_key: "certification_report", uid: "2200.0038", value: "InteriorAndExterior" },
  );
  const generated = buildUadMismoXml(editor, {
    signers: [{
      signer_role: "appraiser",
      execution_date: "2026-08-20",
      credential_snapshot: {
        signer: { first_name: "Taylor", middle_name: null, last_name: "Appraiser", suffix_name: null },
        organization: {
          legal_name: "HomeNode Real Estate LLC",
          display_name: "HomeNode Real Estate",
          address_line_1: "100 Test Office Dr",
          city: "Garland",
          state_code: "TX",
          postal_code: "75044",
        },
        license: {
          license_type: "CertifiedResidential",
          license_type_other_description: null,
          license_number: "STAGING-CR-0001",
          jurisdiction: "TX",
          expires_on: "2028-12-31",
        },
      },
    }],
  });

  assert.match(generated.xml, /<GovernmentAgencyAppraisalIndicator>false<\/GovernmentAgencyAppraisalIndicator>/);
  assert.match(generated.xml, /<ValuationReportInspectionCertificationType>InteriorAndExterior<\/ValuationReportInspectionCertificationType>/);
  assert.match(generated.xml, /<PARTY>/);
  assert.match(generated.xml, /<FirstName>Taylor<\/FirstName>/);
  assert.match(generated.xml, /<AppraiserCompanyName>HomeNode Real Estate<\/AppraiserCompanyName>/);
  assert.match(generated.xml, /<LicenseIdentifier>STAGING-CR-0001<\/LicenseIdentifier>/);
  assert.match(generated.xml, /<PartyRoleType>Appraiser<\/PartyRoleType>/);
  assert.match(
    generated.xml,
    /<RELATIONSHIP xlink:arcrole="urn:fdc:mismo\.org:2009:residential\/SIGNATORY_IsAssociatedWith_ROLE" xlink:from="SIGNATORY_Appraiser" xlink:to="ROLE_Appraiser"\/>/,
  );
  assert.match(generated.xml, /<SIGNATORY xlink:label="SIGNATORY_Appraiser">/);
  assert.match(generated.xml, /<ExecutionDate>2026-08-20<\/ExecutionDate>/);
  assert.equal(generated.signer_count, 1);
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
