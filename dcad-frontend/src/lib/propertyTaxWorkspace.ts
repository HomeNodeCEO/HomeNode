export type PropertyTaxWorkfileData = Record<string, unknown>;

export interface PropertyTaxWorkspaceSnapshot {
  conditionRating: string;
  qualityRating: string;
  conditionNotes: string;
  defectsDeferredMaintenance: string;
  repairCostToCure: number | null;
  repairCostToCureNotes: string;
  taxYear: number | null;
  districtAppraisedValue: number | null;
  requestedMarketValue: number | null;
  appraiserOpinionOfValue: number | null;
  salesComparisonNotes: string;
  adjustmentNotes: string;
  districtEvidenceSummary: string;
  protestRationale: string;
  appraiserComments: string;
}

function recordAt(source: PropertyTaxWorkfileData, key: string): Record<string, unknown> {
  const value = source[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function textAt(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === 'string' ? value.trim() : '';
}

function numberAt(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  if (value == null || value === '') return null;
  const normalized = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(normalized) ? normalized : null;
}

export function readPropertyTaxWorkspace(
  workfileData: PropertyTaxWorkfileData | null | undefined,
): PropertyTaxWorkspaceSnapshot {
  const source = workfileData || {};
  const subject = recordAt(source, 'subject');
  const condition = recordAt(source, 'condition');
  const valuation = recordAt(source, 'valuation');
  const analysis = recordAt(source, 'analysis');
  const inspection = recordAt(source, 'inspection');

  return {
    conditionRating: textAt(subject, 'condition_rating'),
    qualityRating: textAt(subject, 'quality_rating'),
    conditionNotes: textAt(subject, 'condition_notes'),
    defectsDeferredMaintenance: textAt(condition, 'defects_deferred_maintenance'),
    repairCostToCure: numberAt(condition, 'repair_cost_to_cure'),
    repairCostToCureNotes: textAt(condition, 'repair_cost_to_cure_notes'),
    taxYear: numberAt(valuation, 'tax_year'),
    districtAppraisedValue: numberAt(valuation, 'district_appraised_value'),
    requestedMarketValue: numberAt(valuation, 'requested_market_value'),
    appraiserOpinionOfValue: numberAt(valuation, 'appraiser_opinion_of_value'),
    salesComparisonNotes: textAt(analysis, 'sales_comparison_notes'),
    adjustmentNotes: textAt(analysis, 'adjustment_notes'),
    districtEvidenceSummary: textAt(analysis, 'district_evidence_summary'),
    protestRationale: textAt(analysis, 'protest_rationale'),
    appraiserComments: textAt(inspection, 'appraiser_comments'),
  };
}

function currency(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(value);
}

export function buildPropertyTaxSummary({
  subject,
  snapshot,
}: {
  subject: string;
  snapshot: PropertyTaxWorkspaceSnapshot;
}): string {
  const normalizedSubject = subject.trim() || 'the subject property';
  const paragraphs: string[] = [];
  const valueParts: string[] = [];

  if (snapshot.taxYear != null) valueParts.push(`tax year ${snapshot.taxYear}`);
  if (snapshot.districtAppraisedValue != null) {
    valueParts.push(`a district appraised value of ${currency(snapshot.districtAppraisedValue)}`);
  }
  if (snapshot.requestedMarketValue != null) {
    valueParts.push(`a requested market value of ${currency(snapshot.requestedMarketValue)}`);
  }
  if (snapshot.appraiserOpinionOfValue != null) {
    valueParts.push(`an appraiser opinion of value of ${currency(snapshot.appraiserOpinionOfValue)}`);
  }
  if (valueParts.length) {
    paragraphs.push(`The property-tax protest for ${normalizedSubject} addresses ${valueParts.join(', ')}.`);
  } else {
    paragraphs.push(`This property-tax protest summary concerns ${normalizedSubject}.`);
  }

  if (snapshot.salesComparisonNotes) paragraphs.push(snapshot.salesComparisonNotes);
  if (snapshot.adjustmentNotes) paragraphs.push(snapshot.adjustmentNotes);

  const conditionParts = [
    snapshot.conditionRating ? `Condition rating: ${snapshot.conditionRating}.` : '',
    snapshot.qualityRating ? `Quality rating: ${snapshot.qualityRating}.` : '',
    snapshot.conditionNotes,
    snapshot.defectsDeferredMaintenance,
  ].filter(Boolean);
  if (conditionParts.length) paragraphs.push(conditionParts.join(' '));

  if (snapshot.repairCostToCure != null || snapshot.repairCostToCureNotes) {
    const cost = snapshot.repairCostToCure == null
      ? 'The cost-to-cure analysis remains under review.'
      : `The canonical workfile identifies ${currency(snapshot.repairCostToCure)} in repair cost to cure.`;
    paragraphs.push([cost, snapshot.repairCostToCureNotes].filter(Boolean).join(' '));
  }

  if (snapshot.districtEvidenceSummary) paragraphs.push(snapshot.districtEvidenceSummary);
  if (snapshot.protestRationale) paragraphs.push(snapshot.protestRationale);
  if (snapshot.appraiserComments) paragraphs.push(snapshot.appraiserComments);

  return paragraphs.join('\n\n');
}
