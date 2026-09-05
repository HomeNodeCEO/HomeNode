import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import PropertyTaxEvidenceDocumentCenter from '@/components/PropertyTaxEvidenceDocumentCenter';
import {
  getComparableRecommendations,
  type PropertyTaxProtestFile,
} from '@/lib/api';
import { editorCredentialForRequest } from '@/lib/editorCredential';
import { useApplicationAuth } from '@/features/auth/ApplicationAuth';
import { readPropertyTaxCase } from '@/lib/propertyTaxCase';
import {
  getPropertyTaxProtestFile,
  updatePropertyTaxProtestFile,
} from '@/lib/propertyTaxApi';
import {
  analyzePropertyTaxComparables,
  DALLAS_RESIDENTIAL_COMPARABLE_POLICY,
  type PropertyTaxComparableAnalysisResult,
  type PropertyTaxComparableSubject,
} from '@/lib/propertyTaxComparableAnalysis';
import {
  gridRowComparableCandidate,
  mergePropertyTaxComparableRows,
  patchPropertyTaxComparableRow,
  readPropertyTaxComparableGrid,
  recommendedSaleGridRow,
  writePropertyTaxComparableGrid,
  type PropertyTaxComparableGridRow,
} from '@/lib/propertyTaxComparableGrid';
import {
  readPropertyTaxWorkspace,
  resolvePropertyTaxAnalysisContext,
  type PropertyTaxAnalysisContext,
  type PropertyTaxDatabaseDefaults,
} from '@/lib/propertyTaxWorkspace';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function finite(value: unknown): number | null {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function currency(value: number | null | undefined): string {
  if (!Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(Number(value));
}

function comparableSubject(
  file: PropertyTaxProtestFile,
  analysisContext: PropertyTaxAnalysisContext,
): PropertyTaxComparableSubject {
  const workspace = readPropertyTaxWorkspace(file.workfile_data);
  const caseData = readPropertyTaxCase(file.workfile_data);
  const subject = record(file.workfile_data.subject);
  return {
    accountId: file.account_id,
    valuationDate: `${analysisContext.taxYear}-01-01`,
    districtAppraisedValue: workspace.districtAppraisedValue,
    propertyUse: caseData.propertyUse || 'single_family_residential',
    neighborhoodCode: analysisContext.neighborhoodCode,
    buildingClass: caseData.buildingClass,
    historicDistrictName: caseData.historicDistrictName,
    livingAreaSqft: finite(subject.living_area_sqft),
    siteSizeSqft: finite(subject.site_size_sqft),
    bedroomCount: finite(subject.bedroom_count),
    bathCount: finite(subject.bath_count),
    garageSpaces: finite(subject.garage_spaces),
    ageYears: finite(subject.age_years),
    pool: subject.pool === true || subject.pool === 'yes',
    solarPanels: subject.solar_panels === true || subject.solar_panels === 'yes',
  };
}

function rowAdjustedValue(row: PropertyTaxComparableGridRow): number | null {
  if (!Number.isFinite(row.salePrice)) return row.districtAdjustedValue;
  return Number(row.salePrice) - Number(row.concessions || 0) + Number(row.adjustmentAmount || 0);
}

function sameValue(left: string, right: string): boolean {
  return left.trim().toLocaleLowerCase('en-US') === right.trim().toLocaleLowerCase('en-US');
}

export default function PropertyTaxComparableGrid({
  accountId,
  file,
  databaseDefaults,
  onFileSaved,
}: {
  accountId: string;
  file: PropertyTaxProtestFile;
  databaseDefaults: PropertyTaxDatabaseDefaults;
  onFileSaved: (file: PropertyTaxProtestFile) => void;
}) {
  const { required: authenticationRequired, session } = useApplicationAuth();
  const storedGrid = useMemo(() => readPropertyTaxComparableGrid(file.workfile_data), [file.workfile_data]);
  const [rows, setRows] = useState<PropertyTaxComparableGridRow[]>(storedGrid.rows);
  const [loadingRecommendations, setLoadingRecommendations] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const automaticRecommendationFile = useRef('');
  const caseData = useMemo(() => readPropertyTaxCase(file.workfile_data), [file.workfile_data]);
  const workspace = useMemo(() => readPropertyTaxWorkspace(file.workfile_data), [file.workfile_data]);
  const analysisContext = useMemo(
    () => resolvePropertyTaxAnalysisContext(file.workfile_data, databaseDefaults),
    [databaseDefaults, file.workfile_data],
  );
  const subject = useMemo(() => comparableSubject(file, analysisContext), [analysisContext, file]);
  const canAttestComparables = !authenticationRequired || Boolean(
    session?.user_id === file.assigned_appraiser_user_id
      && session.organizations.some((organization) => (
        organization.organization_id === file.organization_id
        && organization.permissions.property_tax_protest?.sign
      )),
  );

  useEffect(() => {
    setRows(readPropertyTaxComparableGrid(file.workfile_data).rows);
  }, [file.tax_protest_file_id, file.revision, file.workfile_data]);

  const analysis = useMemo<PropertyTaxComparableAnalysisResult | null>(() => {
    if (!rows.length) return null;
    try {
      return analyzePropertyTaxComparables({
        subject,
        candidates: rows.map((row) => gridRowComparableCandidate(row, subject)),
      });
    } catch {
      return null;
    }
  }, [rows, subject]);
  const decisions = useMemo(() => new Map(
    (analysis?.candidateDecisions || []).map((decision) => [decision.saleId, decision]),
  ), [analysis]);

  const stageDistrictComparables = useCallback((incoming: PropertyTaxComparableGridRow[]) => {
    if (!incoming.length) return;
    setRows((current) => {
      const merged = mergePropertyTaxComparableRows(current, incoming);
      const added = merged.length - current.length;
      if (added > 0) setMessage(`${added} district-used comparable sale${added === 1 ? '' : 's'} staged for verification. Save the grid to retain them in this protest file.`);
      return merged;
    });
  }, []);

  const loadRecommendations = useCallback(async (automatic = false) => {
    setLoadingRecommendations(true);
    if (!automatic) setMessage('');
    try {
      const response = await getComparableRecommendations({
        subjectAccountId: accountId,
        propertyTaxFileId: file.tax_protest_file_id,
        analysisAsOf: subject.valuationDate,
        periodMonths: 24,
        limit: 50,
        searchProfile: 'urban_moderate',
      });
      const recommendationOrder = response.recommended_sales || [];
      const seenSales = new Set<string>();
      const candidates = recommendationOrder.filter((sale) => {
        const key = String(sale.source_record_id ?? sale.sale_id ?? '');
        if (!key || seenSales.has(key)) return false;
        seenSales.add(key);
        return (
          sale.housingTypeCompatible !== false
          && sale.recommendationExclusionReason !== 'housing_type_mismatch'
          && (!subject.neighborhoodCode || sameValue(sale.neighborhood_code || '', subject.neighborhoodCode))
          && (!subject.buildingClass || sameValue(sale.cad_building_class || '', subject.buildingClass))
        );
      }).slice(0, DALLAS_RESIDENTIAL_COMPARABLE_POLICY.maximumSelectedComparables);
      const incoming = candidates
        .map((sale) => recommendedSaleGridRow(sale, {
          propertyUse: subject.propertyUse,
          neighborhoodCode: subject.neighborhoodCode,
        }))
        .filter((row): row is PropertyTaxComparableGridRow => Boolean(row));
      setRows((current) => mergePropertyTaxComparableRows(current, incoming));
      setMessage(incoming.length
        ? `${incoming.length} ${subject.neighborhoodCode ? 'same-neighborhood ' : ''}recommended sale${incoming.length === 1 ? '' : 's'} added to the draft grid.`
        : subject.neighborhoodCode
          ? 'No recommended sales matched the available DCAD neighborhood and building-class boundary.'
          : 'No recommended sales were available for the current search window; the missing neighborhood remains flagged for review.');
    } catch (error) {
      if (!automatic) setMessage(error instanceof Error ? error.message : 'Comparable recommendations could not be loaded.');
    } finally {
      setLoadingRecommendations(false);
    }
  }, [accountId, file.tax_protest_file_id, subject]);

  useEffect(() => {
    const savedContextComplete = Boolean(workspace.taxYear && caseData.neighborhoodCode);
    const recommendationKey = `${file.tax_protest_file_id}:${subject.valuationDate}:${subject.neighborhoodCode}`;
    if ((!databaseDefaults.loaded && !savedContextComplete)
        || rows.length || automaticRecommendationFile.current === recommendationKey) return;
    automaticRecommendationFile.current = recommendationKey;
    void loadRecommendations(true);
  }, [caseData.neighborhoodCode, databaseDefaults.loaded, file.tax_protest_file_id, loadRecommendations, rows.length, subject, workspace.taxYear]);

  const updateRow = (id: string, patch: Partial<PropertyTaxComparableGridRow>) => {
    setRows((current) => current.map((row) => (
      row.id === id ? patchPropertyTaxComparableRow(row, patch) : row
    )));
  };

  const addBlankDistrictRow = () => {
    const id = `district:manual:${crypto.randomUUID()}`;
    setRows((current) => mergePropertyTaxComparableRows(current, [{
      id,
      source: 'district_evidence',
      sourceLabel: 'District evidence manual entry',
      sourceReference: 'manual district evidence review',
      documentId: null,
      documentPage: null,
      saleId: id,
      accountId: '',
      address: '',
      saleDate: '',
      salePrice: null,
      districtAdjustedValue: null,
      concessions: null,
      adjustmentAmount: 0,
      propertyUse: subject?.propertyUse || 'single_family_residential',
      neighborhoodCode: subject?.neighborhoodCode || '',
      buildingClass: subject?.buildingClass || '',
      livingAreaSqft: null,
      siteSizeSqft: null,
      yearBuilt: null,
      bedroomCount: null,
      bathCount: null,
      garageSpaces: null,
      pool: null,
      reviewStatus: 'needs_review',
      armsLength: false,
    }]));
  };

  const saveGrid = async () => {
    const editorKey = editorCredentialForRequest();
    if (!editorKey) {
      setMessage('Sign in or enter an editor key before saving the comparable grid.');
      return;
    }
    setSaving(true);
    setMessage('');
    try {
      const saved = await updatePropertyTaxProtestFile(
        accountId,
        file.tax_protest_file_id,
        {
          expected_revision: file.revision,
          workfile_data: writePropertyTaxComparableGrid(
            file.workfile_data,
            rows,
            DALLAS_RESIDENTIAL_COMPARABLE_POLICY.version,
          ),
          reviewer: 'HomeNode Property Tax comparable review',
        },
        editorKey,
      );
      const refreshed = await getPropertyTaxProtestFile(accountId, saved.tax_protest_file_id);
      const current = refreshed || saved;
      onFileSaved(current);
      setMessage(`Comparable grid saved in ${current.file_number} revision ${current.revision}.`);
    } catch (error) {
      const text = error instanceof Error ? error.message : 'The comparable grid could not be saved.';
      setMessage(text === 'property_tax_comparable_reverification_required'
        ? 'Comparable facts changed after verification. Save them as needing review, then review and attest the saved revision again.'
        : text === 'property_tax_comparable_housing_type_conflict'
        ? 'A verified comparable must have the same confirmed housing type as the single-family subject. Keep the row unverified or remove it.'
        : text === 'property_tax_protest_revision_conflict'
        || text === 'property_tax_protest_save_operation_conflict'
        ? 'A newer protest revision exists. Refresh the canonical file before saving this grid.'
        : text);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50/40 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-xs font-semibold uppercase tracking-[0.14em] text-emerald-700">Shared calculation engine · Property Tax persistence</div>
          <h3 className="mt-1 text-lg font-semibold text-slate-950">Comparable sales grid</h3>
          <p className="mt-1 max-w-3xl text-sm text-slate-600">
            Recommended MLS sales and district-used sales appear together, retain their source, and save only to {file.file_number}. Current adjustment entries use the shared appraisal math; district-specific rules will be layered in later.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="hn-action-secondary rounded-lg px-3 py-2 text-sm font-semibold" onClick={() => void loadRecommendations(false)} disabled={loadingRecommendations}>
            {loadingRecommendations ? 'Finding sales…' : 'Add recommended sales'}
          </button>
          <button type="button" className="hn-action-secondary rounded-lg px-3 py-2 text-sm font-semibold" onClick={addBlankDistrictRow}>Add district sale</button>
          <button type="button" className="hn-action-primary rounded-lg px-4 py-2 text-sm font-semibold" onClick={() => void saveGrid()} disabled={saving}>
            {saving ? 'Saving grid…' : 'Save comparable grid'}
          </button>
        </div>
      </div>

      {analysisContext.warnings.map((warning) => (
        <div key={warning} className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {warning}
        </div>
      ))}
      {message && <div className="mt-3 rounded-lg border border-emerald-100 bg-white px-3 py-2 text-sm text-slate-700">{message}</div>}
      {!canAttestComparables && (
        <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          You may stage unverified sale facts. Only the assigned appraiser can verify a sale, attest arm&apos;s-length status, approve an adjustment, or alter a previously attested row.
        </div>
      )}

      <div className="mt-4 overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="min-w-[1500px] w-full border-collapse text-left text-xs">
          <thead className="bg-slate-100 text-slate-700">
            <tr>
              {['Source', 'Review', 'Address', 'Sale date', 'Sale price', 'District adjusted', 'GLA', 'Year', 'Beds', 'Baths', 'Garage', 'Neighborhood', 'Class', 'Current adjustment', 'Adjusted indication', 'Analysis', ''].map((label) => (
                <th key={label} className="border-b border-slate-200 px-2 py-2 font-semibold">{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const decision = decisions.get(row.id);
              const rowAttestationLocked = !canAttestComparables && (
                row.reviewStatus === 'verified'
                || row.armsLength
                || row.adjustmentAmount !== 0
              );
              return (
                <tr key={row.id} className="border-b border-slate-100 align-top last:border-0">
                  <td className="px-2 py-2">
                    <span className={`inline-block rounded-full px-2 py-1 text-[10px] font-semibold uppercase ${row.source === 'district_evidence' ? 'bg-violet-100 text-violet-800' : 'bg-blue-100 text-blue-800'}`}>{row.source === 'district_evidence' ? 'District' : 'Recommended'}</span>
                    <div className="mt-1 max-w-32 truncate text-[10px] text-slate-500" title={row.sourceReference}>{row.sourceLabel}</div>
                  </td>
                  <td className="px-2 py-2">
                    <label className="flex items-center gap-1 whitespace-nowrap"><input type="checkbox" disabled={!canAttestComparables} checked={row.reviewStatus === 'verified'} onChange={(event) => updateRow(row.id, { reviewStatus: event.target.checked ? 'verified' : 'needs_review' })} /> Verified</label>
                    <label className="mt-1 flex items-center gap-1 whitespace-nowrap"><input type="checkbox" disabled={!canAttestComparables} checked={row.armsLength} onChange={(event) => updateRow(row.id, { armsLength: event.target.checked })} /> Arm&apos;s length</label>
                  </td>
                  <td className="px-2 py-2"><input aria-label="Comparable address" disabled={rowAttestationLocked} className="w-44 rounded border border-slate-300 px-2 py-1" value={row.address} onChange={(event) => updateRow(row.id, { address: event.target.value })} /></td>
                  <td className="px-2 py-2"><input aria-label="Comparable sale date" disabled={rowAttestationLocked} type="date" className="w-32 rounded border border-slate-300 px-2 py-1" value={row.saleDate} onChange={(event) => updateRow(row.id, { saleDate: event.target.value })} /></td>
                  <td className="px-2 py-2"><input aria-label="Comparable sale price" disabled={rowAttestationLocked} type="number" className="w-28 rounded border border-slate-300 px-2 py-1" value={row.salePrice ?? ''} onChange={(event) => updateRow(row.id, { salePrice: finite(event.target.value) })} /></td>
                  <td className="px-2 py-2 font-medium text-violet-800">{currency(row.districtAdjustedValue)}</td>
                  <td className="px-2 py-2"><input aria-label="Comparable living area" disabled={rowAttestationLocked} type="number" className="w-20 rounded border border-slate-300 px-2 py-1" value={row.livingAreaSqft ?? ''} onChange={(event) => updateRow(row.id, { livingAreaSqft: finite(event.target.value) })} /></td>
                  <td className="px-2 py-2"><input aria-label="Comparable year built" disabled={rowAttestationLocked} type="number" className="w-20 rounded border border-slate-300 px-2 py-1" value={row.yearBuilt ?? ''} onChange={(event) => updateRow(row.id, { yearBuilt: finite(event.target.value) })} /></td>
                  <td className="px-2 py-2"><input aria-label="Comparable bedrooms" disabled={rowAttestationLocked} type="number" className="w-16 rounded border border-slate-300 px-2 py-1" value={row.bedroomCount ?? ''} onChange={(event) => updateRow(row.id, { bedroomCount: finite(event.target.value) })} /></td>
                  <td className="px-2 py-2"><input aria-label="Comparable bathrooms" disabled={rowAttestationLocked} type="number" step="0.5" className="w-16 rounded border border-slate-300 px-2 py-1" value={row.bathCount ?? ''} onChange={(event) => updateRow(row.id, { bathCount: finite(event.target.value) })} /></td>
                  <td className="px-2 py-2"><input aria-label="Comparable garage spaces" disabled={rowAttestationLocked} type="number" className="w-16 rounded border border-slate-300 px-2 py-1" value={row.garageSpaces ?? ''} onChange={(event) => updateRow(row.id, { garageSpaces: finite(event.target.value) })} /></td>
                  <td className="px-2 py-2"><input aria-label="Comparable neighborhood" disabled={rowAttestationLocked} className="w-28 rounded border border-slate-300 px-2 py-1" value={row.neighborhoodCode} onChange={(event) => updateRow(row.id, { neighborhoodCode: event.target.value })} /></td>
                  <td className="px-2 py-2"><input aria-label="Comparable building class" disabled={rowAttestationLocked} className="w-20 rounded border border-slate-300 px-2 py-1" value={row.buildingClass} onChange={(event) => updateRow(row.id, { buildingClass: event.target.value })} /></td>
                  <td className="px-2 py-2"><input aria-label="Comparable adjustment" disabled={!canAttestComparables} type="number" className="w-28 rounded border border-slate-300 px-2 py-1" value={row.adjustmentAmount || ''} onChange={(event) => updateRow(row.id, { adjustmentAmount: finite(event.target.value) || 0 })} /></td>
                  <td className="px-2 py-2 font-semibold text-slate-900">{currency(rowAdjustedValue(row))}</td>
                  <td className="max-w-48 px-2 py-2 text-[10px] leading-4 text-slate-600">{decision?.eligible ? `Eligible · similarity ${decision.similarityScore}` : decision?.exclusionCodes.join(', ').replaceAll('_', ' ') || 'Needs complete sale data'}</td>
                  <td className="px-2 py-2"><button type="button" disabled={rowAttestationLocked} className="text-rose-700 underline disabled:cursor-not-allowed disabled:text-slate-400" onClick={() => setRows((current) => current.filter((candidate) => candidate.id !== row.id))}>Remove</button></td>
                </tr>
              );
            })}
            {!rows.length && <tr><td colSpan={17} className="px-4 py-8 text-center text-sm text-slate-500">Recommended sales load from the latest available property data. Upload district evidence below to stage the district&apos;s sales in the same grid.</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-slate-200 bg-white p-3"><div className="text-[10px] font-semibold uppercase text-slate-500">Grid rows</div><div className="mt-1 text-lg font-semibold">{rows.length}</div></div>
        <div className="rounded-lg border border-slate-200 bg-white p-3"><div className="text-[10px] font-semibold uppercase text-slate-500">Eligible selections</div><div className="mt-1 text-lg font-semibold">{analysis?.selectedComparables.length || 0}</div></div>
        <div className="rounded-lg border border-slate-200 bg-white p-3"><div className="text-[10px] font-semibold uppercase text-slate-500">Current indicated median</div><div className="mt-1 text-lg font-semibold">{currency(analysis?.indicatedMarketValue)}</div></div>
      </div>
      {analysis?.diagnostics.map((diagnostic) => <p key={diagnostic} className="mt-2 text-xs text-amber-800">{diagnostic}</p>)}
      <p className="mt-2 text-xs text-slate-500">
        Analysis date: January 1, {analysisContext.taxYear} ({analysisContext.taxYearSource}).
        {analysisContext.neighborhoodCode
          ? ` Recommendation boundary: DCAD neighborhood ${analysisContext.neighborhoodCode} (${analysisContext.neighborhoodCodeSource})${caseData.buildingClass ? ` · building class ${caseData.buildingClass}` : ''}.`
          : ' No neighborhood boundary is available; candidate neighborhood remains a reviewer flag.'}
      </p>

      <PropertyTaxEvidenceDocumentCenter
        accountId={accountId}
        file={file}
        onDistrictComparables={stageDistrictComparables}
      />
    </section>
  );
}
