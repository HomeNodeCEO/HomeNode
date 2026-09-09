import assert from "node:assert/strict";
import test from "node:test";
import { captureCustomNeighborhoodDraftReportBinding } from "../src/services/neighborhoodAssessment/customDraftReportBinding.js";
const input = () => ({ accountId: "ACCOUNT-1", assignmentFileId: 10,
  section: { revision: 3, value: { accepted_editor_revision: 3, operation_id: "abc" } } });
const binding = () => ({ id: "11111111-0000-4000-8000-000000000001", organization_id: "22222222-0000-4000-8000-000000000002",
  custom_assignment_file_id: "10", account_id: "ACCOUNT-1", workflow_type: "custom_appraisal", uad_workfile_id: null, tax_protest_file_id: null });

test("absent section enables legacy only after authoritative absence of section and acceptance", async () => {
  const options = input(); delete options.section;
  assert.equal(await captureCustomNeighborhoodDraftReportBinding({ query: async (sql, params) => {
    assert.match(sql, /custom-neighborhood-draft:verify-absent/);
    assert.match(sql, /accepted.assignment_file_id=f.id/);
    assert.match(sql, /w.status='draft'/);
    assert.deepEqual(params, [10, "ACCOUNT-1", "neighborhood_assessment"]);
    return { rowCount: 1, rows: [{ assignment_file_id: "10", account_id: "ACCOUNT-1", has_section: false, has_acceptance: false }] };
  } }, options), null);
});
for (const flags of [{ has_section: false, has_acceptance: true }, { has_section: true, has_acceptance: false },
  { has_section: false }, { has_section: false, has_acceptance: null }]) {
  test(`absent response cannot hide retained or concurrent analysis: ${JSON.stringify(flags)}`, async () => {
    const options = input(); delete options.section;
    await assert.rejects(captureCustomNeighborhoodDraftReportBinding({ query: async () => ({ rowCount: 1,
      rows: [{ assignment_file_id: "10", account_id: "ACCOUNT-1", ...flags }] }) }, options), /saved_group_unavailable/);
  });
}

test("draft binding uses one exact current scope/section/receipt/history statement without writes", async () => {
  const calls = [], row = binding(), options = input();
  const result = await captureCustomNeighborhoodDraftReportBinding({ query: async (sql, params) => {
    calls.push({ sql, params }); return { rowCount: 1, rows: [row] };
  } }, options);
  assert.deepEqual(result, { report_files: [row] }); assert.equal(calls.length, 1);
  const { sql, params } = calls[0];
  assert.deepEqual(params.slice(0,4), [10, "ACCOUNT-1", "neighborhood_assessment", 3]);
  assert.deepEqual(JSON.parse(params[4]), options.section.value);
  assert.doesNotMatch(sql, /ORDER BY|LIMIT|\b(?:INSERT|UPDATE|DELETE|CREATE|BEGIN|COMMIT)\b/);
  for (const match of ["r.organization_id=f.organization_id", "s.section_value=$5::jsonb", "h.section_value=s.section_value",
    "accepted.section_json_utf8::jsonb=s.section_value", "assessment.appraisal_case_id=r.appraisal_case_id",
    "assessment.subject_snapshot_id=r.subject_snapshot_id", "appraisal_case.organization_id=r.organization_id",
    "subject_snapshot.appraisal_case_id=appraisal_case.id", "COALESCE(subject_snapshot.effective_date,appraisal_case.effective_date)",
    "subject_snapshot.effective_date=appraisal_case.effective_date", "w.status='draft'", "app.custom_appraisal_signed_snapshots"]) {
    assert.ok(sql.includes(match), match);
  }
});

for (const result of [{ rowCount: 0, rows: [] }, { rowCount: 2, rows: [binding(), binding()] },
  { rowCount: 1, rows: [{ ...binding(), account_id: "OTHER" }] },
  { rowCount: 1, rows: [{ ...binding(), custom_assignment_file_id: 11 }] },
  { rowCount: 1, rows: [{ ...binding(), workflow_type: "uad_3_6" }] },
  { rowCount: 1, rows: [{ ...binding(), uad_workfile_id: "different" }] }]) {
  test(`missing/ambiguous/foreign report binding cannot print legacy values: ${JSON.stringify(result)}`, async () => {
    await assert.rejects(captureCustomNeighborhoodDraftReportBinding({ query: async () => result }, input()), /saved_group_unavailable/);
  });
}

for (const mutate of [options => { options.section = null; }, options => { options.section.revision = 4; },
  options => { options.assignmentFileId = 0; }, options => { options.accountId = "../../other"; }]) {
  test(`invalid exact-section inputs fail before DB query: ${mutate}`, async () => {
    const options = input(); mutate(options);
    await assert.rejects(captureCustomNeighborhoodDraftReportBinding({ query: async () => assert.fail("unexpected query") }, options), /saved_group_unavailable/);
  });
}
