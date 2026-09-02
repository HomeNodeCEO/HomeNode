export const MOBILE_WORKFLOW_TYPES = Object.freeze([
  "custom_appraisal",
  "uad_3_6",
  "property_tax_protest",
]);

const WORKFLOW_PREFIXES = Object.freeze({
  custom_appraisal: "CA",
  uad_3_6: "3.6",
  property_tax_protest: "PT",
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

export function reportFilePrefix(workflowType) {
  return WORKFLOW_PREFIXES[normalizeWorkflowType(workflowType)];
}

export function formatReportFileNumber({ workflowType, calendarYear, sequenceNumber }) {
  const prefix = reportFilePrefix(workflowType);
  const year = normalizeCalendarYear(calendarYear);
  const sequence = Number(sequenceNumber);
  if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > 999_999_999) {
    throw new Error("invalid_sequence_number");
  }
  return `${prefix}-${year}-${String(sequence).padStart(6, "0")}`;
}

export function normalizeAssignmentDate(value = new Date(), { timeZone = "America/Chicago" } = {}) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new Error("invalid_assignment_date");
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(value);
    const part = (type) => parts.find((item) => item.type === type)?.value;
    return `${part("year")}-${part("month")}-${part("day")}`;
  }
  const date = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("invalid_assignment_date");
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error("invalid_assignment_date");
  }
  return date;
}

export function formatDailyAssignmentFileNumber({ workflowType, assignmentDate, sequenceNumber }) {
  const prefix = reportFilePrefix(workflowType);
  const date = normalizeAssignmentDate(assignmentDate);
  const sequence = Number(sequenceNumber);
  if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > 999_999_999) {
    throw new Error("invalid_sequence_number");
  }
  const year = Number(date.slice(0, 4));
  const start = Date.UTC(year, 0, 1);
  const current = Date.parse(`${date}T00:00:00.000Z`);
  const dayOfYear = Math.floor((current - start) / 86_400_000) + 1;
  return `${prefix}-${year}-${String(dayOfYear).padStart(3, "0")}-${String(sequence).padStart(2, "0")}`;
}

export async function allocateReportFileNumber(client, {
  organizationId,
  workflowType,
  assignmentDate = new Date(),
}) {
  const organization = String(organizationId || "").trim();
  if (!organization) throw new Error("invalid_organization_id");
  const workflow = normalizeWorkflowType(workflowType);
  const date = normalizeAssignmentDate(assignmentDate);
  const { rows } = await client.query(
    `INSERT INTO app.report_file_daily_counters (
       organization_id, assignment_date, next_value
     ) VALUES ($1, $2::date, 2)
     ON CONFLICT (organization_id, assignment_date)
     DO UPDATE SET next_value = app.report_file_daily_counters.next_value + 1,
                   updated_at = now()
     RETURNING next_value - 1 AS sequence_number`,
    [organization, date],
  );
  const sequenceNumber = Number(rows[0].sequence_number);
  return Object.freeze({
    workflowType: workflow,
    assignmentDate: date,
    sequenceNumber,
    fileNumber: formatDailyAssignmentFileNumber({
      workflowType: workflow,
      assignmentDate: date,
      sequenceNumber,
    }),
  });
}
