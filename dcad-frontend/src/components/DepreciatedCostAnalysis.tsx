import { useEffect, useMemo, useState } from 'react';
import * as api from '@/lib/api';
import type { DepreciatedCostAdjustmentResponse, DepreciatedCostTarget } from '@/lib/api';
import type { CostApproachDraft, CostApproachLine } from '@/lib/costApproach';
import type {
  AppliedGroupedAdjustment,
  GroupedAdjustmentImpactPreview,
} from '@/components/GroupedAdjustmentAnalysis';

type EvidenceOption = {
  id: string;
  label: string;
  description: string;
  suggestedTarget: DepreciatedCostTarget;
  unitCost: number;
};

function numeric(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function money(value: number | null | undefined, digits = 0) {
  if (value == null || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

function inferTarget(description: string): DepreciatedCostTarget {
  const normalized = description.toLowerCase();
  if (/garage|carport|parking/.test(normalized)) return 'garage';
  if (/pool|spa/.test(normalized)) return 'pool';
  return 'pool';
}

function targetLabel(target: DepreciatedCostTarget) {
  if (target === 'living_area') return 'Gross Living Area (per SF)';
  if (target === 'garage') return 'Garage / Parking (per space)';
  return 'Pool (present versus absent)';
}

export default function DepreciatedCostAnalysis({
  subjectAccountId,
  assignmentFileId,
  appliedAdjustments,
  getImpactPreview,
  onApplyAdjustment,
  onRemoveAdjustment,
}: {
  subjectAccountId: string;
  assignmentFileId?: number | null;
  appliedAdjustments: Record<string, AppliedGroupedAdjustment>;
  getImpactPreview: (adjustment: AppliedGroupedAdjustment) => GroupedAdjustmentImpactPreview;
  onApplyAdjustment: (adjustment: AppliedGroupedAdjustment) => void;
  onRemoveAdjustment: (adjustmentId: string) => void;
}) {
  const [costApproach, setCostApproach] = useState<CostApproachDraft | null>(null);
  const [canonicalName, setCanonicalName] = useState('');
  const [sourceId, setSourceId] = useState('dwelling');
  const [target, setTarget] = useState<DepreciatedCostTarget>('living_area');
  const [description, setDescription] = useState('Dwelling replacement cost');
  const [unitCost, setUnitCost] = useState('');
  const [factorPercent, setFactorPercent] = useState('100');
  const [result, setResult] = useState<DepreciatedCostAdjustmentResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [calculating, setCalculating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadCostEvidence = async () => {
    if (!assignmentFileId) {
      setCostApproach(null);
      setError('Create or open an appraisal file before using Depreciated Cost.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await api.getCustomAppraisalWorkfile(subjectAccountId, assignmentFileId);
      const section = response.workfile.sections.cost_approach?.value as CostApproachDraft | undefined;
      setCostApproach(section || null);
      setCanonicalName(response.workfile.canonical_file_name);
      if (!section) setError('Develop and save the Cost Approach first so this study has an identified cost source and depreciation support.');
    } catch (loadError) {
      setCostApproach(null);
      setError(loadError instanceof Error ? loadError.message : 'Cost Approach evidence could not be loaded.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void loadCostEvidence(); }, [subjectAccountId, assignmentFileId]);

  const evidenceOptions = useMemo<EvidenceOption[]>(() => {
    if (!costApproach) return [];
    const options: EvidenceOption[] = [];
    if (numeric(costApproach.cost_per_sqft) > 0) {
      options.push({
        id: 'dwelling',
        label: `Dwelling base cost · ${money(costApproach.cost_per_sqft, 2)}/SF`,
        description: 'Dwelling replacement cost',
        suggestedTarget: 'living_area',
        unitCost: numeric(costApproach.cost_per_sqft),
      });
    }
    (costApproach.other_improvements || []).forEach((line: CostApproachLine, index) => {
      const quantity = Math.max(1, numeric(line.quantity, 1));
      const perUnit = line.unit === 'ea'
        ? numeric(line.unit_cost)
        : numeric(line.total_cost) || numeric(line.unit_cost) * quantity;
      if (perUnit <= 0) return;
      options.push({
        id: line.id || `cost-line-${index + 1}`,
        label: `${line.description || `Other improvement ${index + 1}`} · ${money(perUnit, 2)} cost unit`,
        description: line.description || `Other improvement ${index + 1}`,
        suggestedTarget: inferTarget(line.description || ''),
        unitCost: perUnit,
      });
    });
    return options;
  }, [costApproach]);

  useEffect(() => {
    if (!evidenceOptions.length) return;
    const selected = evidenceOptions.find((option) => option.id === sourceId) || evidenceOptions[0];
    setSourceId(selected.id);
    setTarget(selected.suggestedTarget);
    setDescription(selected.description);
    setUnitCost(String(selected.unitCost));
    setResult(null);
  }, [costApproach]);

  const depreciationPercent = useMemo(() => {
    if (!costApproach) return 0;
    const replacementCost = numeric(costApproach.replacement_cost_new);
    if (replacementCost > 0) {
      return Math.min(100, numeric(costApproach.total_depreciation) / replacementCost * 100);
    }
    return Math.min(100, numeric(costApproach.physical_depreciation_percent));
  }, [costApproach]);

  const selectEvidence = (id: string) => {
    const selected = evidenceOptions.find((option) => option.id === id);
    if (!selected) return;
    setSourceId(selected.id);
    setTarget(selected.suggestedTarget);
    setDescription(selected.description);
    setUnitCost(String(selected.unitCost));
    setResult(null);
  };

  const calculate = async () => {
    if (!costApproach) return;
    setCalculating(true);
    setError(null);
    setResult(null);
    try {
      setResult(await api.calculateDepreciatedCostAdjustment({
        targetDimension: target,
        description,
        unitCost: numeric(unitCost),
        localMultiplier: numeric(costApproach.local_multiplier, 1) || 1,
        entrepreneurialIncentivePercent: numeric(costApproach.entrepreneurial_incentive_percent),
        depreciationPercent,
        factorPercent: numeric(factorPercent, 100),
        sourceName: costApproach.source_name,
        sourceReference: costApproach.source_reference,
        asOfDate: costApproach.as_of_date,
      }));
    } catch (calculateError) {
      setError(calculateError instanceof Error ? calculateError.message : 'The depreciated-cost adjustment could not be calculated.');
    } finally {
      setCalculating(false);
    }
  };

  const adjustment = useMemo<AppliedGroupedAdjustment | null>(() => {
    if (!result) return null;
    return {
      id: `depreciated_cost:${result.target_dimension}`,
      marketKey: 'cost_approach',
      marketLabel: `${result.source_name || 'Saved Cost Approach'} · ${result.as_of_date || 'effective date not reported'}`,
      dimensionKey: result.target_dimension,
      dimensionLabel: targetLabel(result.target_dimension),
      transitionId: result.target_dimension,
      transitionLabel: result.description,
      fromGroupValue: result.target_dimension === 'pool' ? false : 0,
      toGroupValue: result.target_dimension === 'pool' ? true : 1,
      optionId: 'depreciated_cost_per_unit',
      optionLabel: 'Replacement cost new less depreciation',
      basis: 'depreciated_cost',
      reliability: costApproach?.developed ? 'strong' : 'limited',
      baseAmount: result.depreciated_cost_per_unit,
      factorPercent: result.factor_percent,
      amount: result.recommended_adjustment,
    };
  }, [result, costApproach?.developed]);
  const preview = adjustment ? getImpactPreview(adjustment) : null;
  const applied = adjustment ? appliedAdjustments[adjustment.id] : null;

  return <div className="p-5">
    <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-5">
      <div className="text-lg font-semibold text-indigo-950">Depreciated Cost</div>
      <p className="mt-2 text-sm leading-6 text-indigo-900">Develops a feature adjustment from the saved Cost Approach: replacement cost new, less the workfile’s accrued depreciation, with optional factoring. Land is intentionally excluded because it is not a depreciable improvement.</p>
    </div>

    <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-3"><div><div className="text-xs font-semibold uppercase text-slate-500">Cost evidence</div><div className="font-semibold">{canonicalName || 'Current appraisal file'}</div></div><button type="button" onClick={() => void loadCostEvidence()} disabled={loading} className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:bg-slate-300">{loading ? 'Refreshing…' : 'Refresh Cost Evidence'}</button></div>
      {costApproach ? <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-5">{[
        ['Source', costApproach.source_name || 'Not identified'],
        ['Effective date', costApproach.as_of_date || 'Not reported'],
        ['Local multiplier', numeric(costApproach.local_multiplier, 1).toFixed(3)],
        ['Incentive', `${numeric(costApproach.entrepreneurial_incentive_percent).toFixed(1)}%`],
        ['Accrued depreciation', `${depreciationPercent.toFixed(1)}%`],
      ].map(([label, value]) => <div key={label} className="rounded-lg bg-slate-50 p-3"><div className="text-xs uppercase text-slate-500">{label}</div><strong className="text-sm">{value}</strong></div>)}</div> : null}
      {costApproach && !costApproach.developed ? <p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">The saved Cost Approach is still incomplete. This calculation remains available for testing, but its applied adjustment is marked limited until the Cost Approach is fully developed.</p> : null}
    </div>

    {error ? <div className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{error}</div> : null}
    {costApproach && evidenceOptions.length ? <div className="mt-4 grid gap-4 lg:grid-cols-2">
      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h3 className="font-semibold text-slate-900">Adjustment evidence and target</h3>
        <label className="mt-3 grid gap-1 text-sm"><span className="text-xs font-semibold uppercase text-slate-500">Saved cost line</span><select value={sourceId} onChange={(event) => selectEvidence(event.target.value)} className="rounded border border-slate-300 px-3 py-2">{evidenceOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
        <label className="mt-3 grid gap-1 text-sm"><span className="text-xs font-semibold uppercase text-slate-500">Apply to grid row</span><select value={target} onChange={(event) => { setTarget(event.target.value as DepreciatedCostTarget); setResult(null); }} className="rounded border border-slate-300 px-3 py-2"><option value="living_area">Gross Living Area (per SF)</option><option value="garage">Garage / Parking (per space)</option><option value="pool">Pool (present versus absent)</option></select></label>
        <label className="mt-3 grid gap-1 text-sm"><span className="text-xs font-semibold uppercase text-slate-500">Cost description</span><input value={description} onChange={(event) => { setDescription(event.target.value); setResult(null); }} className="rounded border border-slate-300 px-3 py-2" /></label>
        <label className="mt-3 grid gap-1 text-sm"><span className="text-xs font-semibold uppercase text-slate-500">Cost per adjustment unit</span><input type="number" min="0" step="0.01" value={unitCost} onChange={(event) => { setUnitCost(event.target.value); setResult(null); }} className="rounded border border-slate-300 px-3 py-2" /></label>
        <label className="mt-3 grid gap-1 text-sm"><span className="text-xs font-semibold uppercase text-slate-500">Apply Factoring %</span><input type="number" min="0" max="500" value={factorPercent} onChange={(event) => { setFactorPercent(event.target.value); setResult(null); }} className="rounded border border-slate-300 px-3 py-2" /></label>
        <button type="button" onClick={() => void calculate()} disabled={calculating || !description.trim() || numeric(unitCost) <= 0} className="mt-4 w-full rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white disabled:bg-slate-300">{calculating ? 'Calculating…' : 'Calculate Depreciated Cost'}</button>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h3 className="font-semibold text-slate-900">Calculated support</h3>
        {result ? <div className="mt-3 space-y-3">
          <div className="grid grid-cols-2 gap-2">{[
            ['Replacement cost new', money(result.replacement_cost_new_per_unit, result.target_dimension === 'living_area' ? 2 : 0)],
            ['Accrued depreciation', money(result.depreciation_per_unit, result.target_dimension === 'living_area' ? 2 : 0)],
            ['Depreciated cost', money(result.depreciated_cost_per_unit, result.target_dimension === 'living_area' ? 2 : 0)],
            ['Factored adjustment', money(result.recommended_adjustment, result.target_dimension === 'living_area' ? 2 : 0)],
          ].map(([label, value]) => <div key={label} className="rounded-lg bg-slate-50 p-3"><div className="text-xs uppercase text-slate-500">{label}</div><strong>{value}</strong></div>)}</div>
          <div className="rounded-lg bg-indigo-50 p-3 text-sm text-indigo-950">{targetLabel(result.target_dimension)} · grid preview affects <strong>{preview?.affectedCount || 0}</strong> of <strong>{preview?.selectedCount || 0}</strong> selected comparables.</div>
          <button type="button" onClick={() => adjustment && (applied ? onRemoveAdjustment(adjustment.id) : onApplyAdjustment(adjustment))} className={`w-full rounded-lg px-4 py-2 text-sm font-semibold text-white ${applied ? 'bg-red-700' : 'bg-emerald-700'}`}>{applied ? 'Remove Adjustment' : 'Apply Adjustment'}</button>
        </div> : <p className="mt-3 text-sm text-slate-600">Select the relevant saved cost evidence and calculate the supported adjustment. No amount is applied until you press Apply Adjustment.</p>}
      </section>
    </div> : null}
  </div>;
}
