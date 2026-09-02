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

export interface PropertyTaxDatabaseDefaults {
  loaded: boolean;
  taxYear: number | null;
  neighborhoodCode: string;
}

export interface PropertyTaxAnalysisContext {
  taxYear: number;
  neighborhoodCode: string;
  taxYearSource: 'workfile' | 'database' | 'system';
  neighborhoodCodeSource: 'workfile' | 'database' | 'missing';
  warnings: string[];
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

function validTaxYear(value: unknown): number | null {
  const normalized = Number(value);
  return Number.isInteger(normalized) && normalized >= 2000 && normalized <= 2200
    ? normalized
    : null;
}

/**
 * Resolve non-blocking analysis inputs without writing database-derived values
 * into the canonical protest revision. Explicit workfile values always win;
 * otherwise the latest property record is used, with a visible review flag.
 */
export function resolvePropertyTaxAnalysisContext(
  workfileData: PropertyTaxWorkfileData | null | undefined,
  databaseDefaults: PropertyTaxDatabaseDefaults,
  systemYear = new Date().getFullYear(),
): PropertyTaxAnalysisContext {
  const workspace = readPropertyTaxWorkspace(workfileData);
  const subject = recordAt(workfileData || {}, 'subject');
  const savedNeighborhoodCode = textAt(subject, 'district_neighborhood_code');
  const savedTaxYear = validTaxYear(workspace.taxYear);
  const databaseTaxYear = validTaxYear(databaseDefaults.taxYear);
  const fallbackSystemYear = validTaxYear(systemYear) || 2000;
  const databaseNeighborhoodCode = databaseDefaults.neighborhoodCode.trim();
  const warnings: string[] = [];

  const taxYear = savedTaxYear || databaseTaxYear || fallbackSystemYear;
  const taxYearSource = savedTaxYear
    ? 'workfile' as const
    : databaseTaxYear
      ? 'database' as const
      : 'system' as const;
  const neighborhoodCode = savedNeighborhoodCode || databaseNeighborhoodCode;
  const neighborhoodCodeSource = savedNeighborhoodCode
    ? 'workfile' as const
    : databaseNeighborhoodCode
      ? 'database' as const
      : 'missing' as const;

  if (!savedTaxYear && databaseTaxYear) {
    warnings.push(`Tax year is not saved in this workfile; using the most recent database tax year, ${databaseTaxYear}.`);
  } else if (!savedTaxYear && !databaseTaxYear && databaseDefaults.loaded) {
    warnings.push(`Tax year is unavailable in the workfile and property database; using ${taxYear} for the sale search and flagging it for review.`);
  }
  if (!savedNeighborhoodCode && databaseNeighborhoodCode) {
    warnings.push(`Neighborhood is not saved in this workfile; using the most recent database code, ${databaseNeighborhoodCode}.`);
  } else if (!savedNeighborhoodCode && !databaseNeighborhoodCode && databaseDefaults.loaded) {
    warnings.push('The DCAD neighborhood is unavailable in the workfile and property database; recommendations and analysis will continue without neighborhood filtering and remain flagged for review.');
  }

  return {
    taxYear,
    neighborhoodCode,
    taxYearSource,
    neighborhoodCodeSource,
    warnings,
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
