import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { SummarySection } from '@/components/PropertyReportControls';
import type { CustomCohortPreviewGroup } from '../customCohortPreviewController';
import type { MarketConditionsDraft } from '@/lib/marketConditionsDraft';
import type { AcceptedNeighborhoodState } from '../customNeighborhoodAcceptedState';
import type { CustomNeighborhoodReportBridge } from '../useCustomNeighborhoodReportBridge';
import type { SubjectNeighborhoodSummaryInput } from '@/lib/subjectNeighborhoodSummary';
import { neighborhoodSummaryTemplate, refreshNeighborhoodSummaryTemplate, NEIGHBORHOOD_TEMPLATE_REVIEW_ITEMS } from '@/lib/neighborhoodSummaryTemplate';

const CustomNeighborhoodAcceptedSummary = lazy(() => import('./CustomNeighborhoodAcceptedSummary'));
const CustomNeighborhoodAcceptedOutline = lazy(() => import('./CustomNeighborhoodAcceptedOutline'));
const CustomNeighborhoodWorkspaceHost = lazy(() => import('./CustomNeighborhoodWorkspaceHost'));
const MarketConditionsAnalysis = lazy(() => import('@/components/MarketConditionsAnalysis'));

interface Props {
  neighborhoodSummary: string;
  onNeighborhoodSummaryChange: (value: string) => void;
  summaryTemplate?: string;
  summaryInput?: SubjectNeighborhoodSummaryInput;
  summaryReadOnly?: boolean;
  onGeneratedSummary?: (value: string, reviewItems: readonly string[]) => void;
  onLocationTypeChange?: (value: string) => void;
  workspace: CustomNeighborhoodReportBridge;
  acceptedNeighborhood: AcceptedNeighborhoodState | null;
  assignmentFilesError: boolean;
  assignmentFilesLoaded: boolean;
  hasActiveAssignmentFile: boolean;
  accountId?: string;
  assignmentFileId?: number | null;
  effectiveDate?: string | null;
  marketConditionsDraft: MarketConditionsDraft | null;
  onMarketConditionsChange: (draft: MarketConditionsDraft | null) => void;
}

function Loading({ label }: { label: string }) {
  return <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">Loading {label}...</div>;
}

function appliedStatus(props: Props): string {
  if (props.acceptedNeighborhood?.status === 'legacy') {
    return 'No reviewed neighborhood group has been applied to this file yet. Complete the exploration above, then apply its boundary and statistics together.';
  }
  if (props.acceptedNeighborhood?.message) return props.acceptedNeighborhood.message;
  if (props.assignmentFilesError) return 'The appraisal files could not be loaded. Reload to retry before changing neighborhood data.';
  if (props.assignmentFilesLoaded && !props.hasActiveAssignmentFile) return 'Choose or start an appraisal file to review and save its neighborhood analysis.';
  return 'Loading the saved neighborhood selection...';
}

/** One visible Custom Appraisal neighborhood workflow. Exploration stays out
 * of beforeprint preparation; accepted boundary/statistics remain one group,
 * while market trend analysis is an explicit independent calculation. */
export default function CustomNeighborhoodCharacteristicsSection(props: Props) {
  const [explorationArea, setExplorationArea] = useState<CustomCohortPreviewGroup | null>(null);
  const [includesTownhomes, setIncludesTownhomes] = useState(false);
  const onAnalysisSelection = useCallback((group: CustomCohortPreviewGroup | null, townhomes?: boolean) => {
    setExplorationArea(group);
    if (group) setIncludesTownhomes(townhomes === true);
  }, []);
  const { summaryReadOnly, summaryInput, onGeneratedSummary, neighborhoodSummary, summaryTemplate } = props;
  useEffect(() => {
    if (summaryReadOnly || !summaryInput || !onGeneratedSummary) return;
    const next = refreshNeighborhoodSummaryTemplate(neighborhoodSummary, summaryTemplate, { ...summaryInput, includesTownhomes }, explorationArea);
    if (next !== null) onGeneratedSummary(next, NEIGHBORHOOD_TEMPLATE_REVIEW_ITEMS);
  }, [summaryReadOnly, summaryInput, summaryTemplate, neighborhoodSummary, onGeneratedSummary, explorationArea, includesTownhomes]);
  return <SummarySection title="Neighborhood Characteristics"
    subtitle="Explore the complete captured area, review exact selected statistics, apply one boundary-and-statistics group, and reconcile market conditions"
    manuallyVerified={props.acceptedNeighborhood?.status === 'accepted'}>
    <section className="mb-4 rounded-xl border border-violet-200 bg-white p-4" aria-label="Neighborhood summary">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label htmlFor="custom-neighborhood-summary" className="block text-sm font-semibold text-slate-950">Neighborhood summary</label>
        <div className="flex flex-wrap items-center gap-2">
        {summaryInput && onGeneratedSummary && <button type="button" className="hn-action-secondary btn btn-sm normal-case"
          disabled={summaryReadOnly} onClick={() => onGeneratedSummary(neighborhoodSummaryTemplate({ ...summaryInput, includesTownhomes }, explorationArea), NEIGHBORHOOD_TEMPLATE_REVIEW_ITEMS)}>Use template</button>}
        {props.onLocationTypeChange && <label className="inline-flex items-center gap-2 text-xs font-medium text-violet-950">Location
          <select className="select select-bordered select-sm bg-white" aria-label="Neighborhood location classification"
            value={props.summaryInput?.locationType || ''} disabled={props.summaryReadOnly}
            onChange={event => props.onLocationTypeChange?.(event.target.value)}>
            <option value="">Select location</option><option value="urban">Urban</option><option value="suburban">Suburban</option><option value="rural">Rural</option>
          </select>
        </label>}
        </div>
      </div>
      <textarea id="custom-neighborhood-summary" className="textarea textarea-bordered mt-2 min-h-32 w-full bg-white"
        value={props.neighborhoodSummary} onChange={event => props.onNeighborhoodSummaryChange(event.target.value)}
        maxLength={8000} disabled={props.summaryReadOnly} placeholder="Enter the appraiser-reviewed neighborhood description." />
    </section>
    <div className="print:hidden">
      {props.workspace.message && <p role={props.workspace.status === 'unavailable' ? 'alert' : 'status'} className="mb-3 text-sm">
        {props.workspace.message}
      </p>}
      {props.workspace.status === 'unavailable' && <button type="button" className="hn-action-secondary btn btn-sm normal-case"
        onClick={props.workspace.retry}>Reload neighborhood workspace</button>}
      {props.workspace.hostProps && <Suspense fallback={<Loading label="saved neighborhood workspace" />}>
        <CustomNeighborhoodWorkspaceHost {...props.workspace.hostProps} onAnalysisSelection={onAnalysisSelection} />
      </Suspense>}
    </div>

    <section className="mt-4 border-t border-violet-200 pt-4" aria-label="Applied neighborhood characteristics">
      <div className="mb-3"><h3 className="text-base font-semibold text-slate-950">Applied neighborhood characteristics and market observations</h3>
        <p className="mt-1 text-xs text-slate-600">Applying the reviewed neighborhood reloads its boundary and statistics here as one indivisible report group.</p></div>
      <Suspense fallback={<Loading label="applied neighborhood characteristics" />}>
        {props.acceptedNeighborhood?.status === 'accepted' ? <div className="space-y-3">
          <CustomNeighborhoodAcceptedOutline assessment={props.acceptedNeighborhood.assessment} />
          <CustomNeighborhoodAcceptedSummary assessment={props.acceptedNeighborhood.assessment} />
        </div> : <p role="status" className="rounded-xl border border-violet-200 bg-violet-50 p-4 text-sm text-violet-950">
          {appliedStatus(props)}
        </p>}
      </Suspense>
    </section>

    {props.accountId && props.assignmentFileId ? <section className="mt-4 border-t border-violet-200 pt-4" aria-label="Market conditions analysis">
      <Suspense fallback={<Loading label="market conditions analysis" />}>
        <MarketConditionsAnalysis key={`${props.accountId}:${props.assignmentFileId}`} subjectAccountId={props.accountId}
          assignmentFileId={props.assignmentFileId} initialDraft={props.marketConditionsDraft}
          initialAsOfDate={props.effectiveDate}
          geography={props.summaryInput?.locationType || null}
          onCompletionChange={props.onMarketConditionsChange} explorationArea={explorationArea} embedded />
      </Suspense>
    </section> : null}
  </SummarySection>;
}
