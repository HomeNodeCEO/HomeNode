export const MOBILE_WORKFLOW_TYPES = Object.freeze([
  "custom_appraisal",
  "uad_3_6",
  "property_tax_protest",
]);

const WORKFLOW_PREFIXES = Object.freeze({
  custom_appraisal: "CA",
  uad_3_6: "UAD",
  property_tax_protest: "PTP",
});

export function normalizeWorkflowType(value) {
  const workflowType = String(value || "").trim().toLowerCase();
  if (!MOBILE_WORKFLOW_TYPES.includes(workflowType)) throw new Error("invalid_workflow_type");
  return workflowType;
}

export function normalizeCalendarYear(value = new Date().getUTCFullYear()) {
  const calendarYear = Number(value);
  if (!Number.isInteger(calendarYear) || calendarYear < 2000 || calendarYear > 2200) {
    throw new Error("invalid_calendar_year");
  }
  return calendarYear;
}

export function formatReportFileNumber({ workflowType, calendarYear, sequenceNumber }) {
  const workflow = normalizeWorkflowType(workflowType);
  const year = normalizeCalendarYear(calendarYear);
  const sequence = Number(sequenceNumber);
  if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > 999_999_999) {
    throw new Error("invalid_sequence_number");
  }
  return `HN-${WORKFLOW_PREFIXES[workflow]}-${year}-${String(sequence).padStart(6, "0")}`;
}

export async function allocateReportFileNumber(client, {
  organizationId,
  workflowType,
  calendarYear = new Date().getUTCFullYear(),
}) {
  const organization = String(organizationId || "").trim();
  if (!organization) throw new Error("invalid_organization_id");
  const workflow = normalizeWorkflowType(workflowType);
  const year = normalizeCalendarYear(calendarYear);
  const { rows } = await client.query(
    `INSERT INTO app.report_file_number_counters (
       organization_id, workflow_type, calendar_year, next_value
     ) VALUES ($1, $2, $3, 2)
     ON CONFLICT (organization_id, workflow_type, calendar_year)
     DO UPDATE SET next_value = app.report_file_number_counters.next_value + 1,
                   updated_at = now()
     RETURNING next_value - 1 AS sequence_number`,
    [organization, workflow, year],
  );
  const sequenceNumber = Number(rows[0].sequence_number);
  return Object.freeze({
    workflowType: workflow,
    calendarYear: year,
    sequenceNumber,
    fileNumber: formatReportFileNumber({
      workflowType: workflow,
      calendarYear: year,
      sequenceNumber,
    }),
  });
}
