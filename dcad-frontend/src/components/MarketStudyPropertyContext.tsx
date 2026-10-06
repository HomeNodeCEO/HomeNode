import { useEffect, useMemo, useRef, useState } from 'react';
import { analyzePropertyContext, savePropertyContextReview, type MarketConditionsResponse, type MarketConditionsStudyAreaKey, type PropertyComplexityAssessment, type PropertyComplexityLevel } from '@/lib/api';
import { buildMarketStudyComplexity, marketComplexityEvidenceKey, type MarketComplexityReview, type MarketStudyComplexity } from '@/lib/marketStudyComplexity';
import PropertyContextSection from './PropertyContextSection';

type Props = {
  accountId: string; assignmentFileId: number | null; response: MarketConditionsResponse | null;
  current: boolean; studySignature: string; studyRevision: number; geography?: string | null;
  reliedUpon: MarketConditionsStudyAreaKey[]; initialScreening?: MarketStudyComplexity | null;
  onChange: (screening: MarketStudyComplexity | null) => void;
};
const number = (value: number | null, suffix = '') => value === null ? '—' : `${value.toLocaleString('en-US', { maximumFractionDigits: 1 })}${suffix}`;

export default function MarketStudyPropertyContext(props: Props) {
  const { accountId, assignmentFileId, response, current, studySignature, studyRevision, geography, reliedUpon, initialScreening, onChange } = props;
  const initial = useRef(initialScreening?.studySignature === studySignature
    && (!geography || initialScreening.assessment.geography === geography) ? initialScreening : null);
  const [source, setSource] = useState<PropertyComplexityAssessment | null>(initial.current?.assessment ?? null);
  const [review, setReview] = useState<MarketComplexityReview | null>(initial.current?.review ?? null);
  const [loading, setLoading] = useState(false), [saving, setSaving] = useState(false), [message, setMessage] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [complexity, setComplexity] = useState<PropertyComplexityLevel>(initial.current?.assessment.effective_complexity ?? 'simple');
  const [notes, setNotes] = useState(initial.current?.review?.notes ?? '');
  const currentRef = useRef(props); currentRef.current = props;
  const sourceRef = useRef(source); sourceRef.current = source;
  const savedRun = useRef(initial.current ? `${studySignature}:0:${geography ?? ''}:0` : null);
  const loadKey = `${studySignature}:${studyRevision}:${geography ?? ''}:${refresh}`;
  useEffect(() => {
    if (!current || !response || !assignmentFileId || savedRun.current === loadKey) return;
    let cancelled = false;
    setLoading(true); setMessage(''); setReview(null);
    // Only subject/local influence evidence is fetched here. The completed sale
    // populations and medians are reused; no fixed-radius peer or sales rerun.
    void analyzePropertyContext(accountId, { assignmentFileId: assignmentFileId,
      geography: geography, marketStudyContextOnly: true }).then(value => {
      if (!cancelled) { savedRun.current = loadKey; setSource(value); setNotes(''); }
    }).catch(error => {
      if (!cancelled) { setSource(null); setMessage(error instanceof Error ? error.message : 'Property context could not be analyzed. Retry context.'); }
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; setLoading(false); };
  }, [loadKey, accountId, assignmentFileId, current, geography, response]);
  const screening = useMemo(() => !current || loading || savedRun.current !== loadKey || !source || !response ? null
    : buildMarketStudyComplexity(source, response, reliedUpon, studySignature, review),
  [loadKey, loading, current, reliedUpon, response, studySignature, review, source]);
  useEffect(() => { onChange(screening); }, [onChange, screening]);
  useEffect(() => { if (screening) setComplexity(screening.assessment.effective_complexity); }, [screening]);
  async function save() {
    if (!screening || !assignmentFileId || saving) return;
    const target = props, sourceAtStart = source;
    setSaving(true); setMessage('');
    try {
      const result = await savePropertyContextReview(accountId, { assignmentFileId: assignmentFileId, complexity, notes });
      if (currentRef.current.accountId !== target.accountId || currentRef.current.assignmentFileId !== target.assignmentFileId
        || currentRef.current.geography !== target.geography || currentRef.current.studySignature !== target.studySignature
        || currentRef.current.studyRevision !== target.studyRevision || !currentRef.current.current || sourceAtStart !== sourceRef.current
        || marketComplexityEvidenceKey(target.studySignature, target.reliedUpon) !== marketComplexityEvidenceKey(currentRef.current.studySignature, currentRef.current.reliedUpon)) return;
      setSource(result);
      setReview({ complexity, notes, reviewedAt: result.reviewed_at ?? new Date().toISOString(), sourceComputedAt: screening.assessment.computed_at,
        evidenceKey: marketComplexityEvidenceKey(target.studySignature, target.reliedUpon) });
      setMessage('Complexity review saved for these market studies.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Complexity review could not be saved.'); }
    finally { setSaving(false); }
  }
  return <section aria-label="Market-study property context and complexity" className="rounded-xl border border-violet-200 bg-violet-50/30 p-3">
    <PropertyContextSection context={screening?.assessment ?? null} loading={loading} saving={saving} message={message}
      complexity={complexity} notes={notes} onComplexityChange={setComplexity} onNotesChange={setNotes}
      onAnalyze={() => setRefresh(value => value + 1)} onSave={() => void save()}
      analyzeDisabled={!current} saveDisabled={!screening || loading} peerSummary={screening ? `${screening.studies.filter(study => study.used).length} independent study areas` : undefined}
      emptyMessage={!current ? 'Run the selected market studies to determine subject complexity.'
        : loading ? 'Analyzing the subject against the completed market studies.'
        : !reliedUpon.length ? 'Choose at least one study for evidence weighting.' : 'No complexity assessment is available. Retry context.'}
      studyEvidence={screening ? <div className="mt-3 overflow-x-auto rounded-lg border border-violet-200 bg-white">
        <table className="w-full text-xs text-slate-900"><caption className="p-2 text-left font-semibold">Subject comparison by study area</caption>
          <thead><tr className="bg-violet-50 text-left"><th className="p-2">Study area</th><th className="p-2">Sales</th><th className="p-2">Median GLA</th><th className="p-2">Subject GLA difference</th><th className="p-2">Median age</th><th className="p-2">COD / CV</th><th className="p-2">Reliability</th></tr></thead>
          <tbody>{screening.studies.map(study => <tr key={study.key} className={`border-t border-slate-100 ${study.used ? '' : 'text-slate-500'}`}>
            <td className="p-2 font-medium">{study.label}{study.used ? '' : ' (not weighted)'}</td><td className="p-2">{number(study.sales)}</td>
            <td className="p-2">{number(study.medianLivingArea, ' SF')}</td><td className="p-2">{number(study.livingAreaDifferencePercent, '%')}</td>
            <td className="p-2">{number(study.medianAge, ' years')}</td><td className="p-2">{number(study.cod, '%')} / {number(study.cv, '%')}</td><td className="p-2">{number(study.reliability)}/100</td>
          </tr>)}</tbody></table>
      </div> : null} />
  </section>;
}
