import { isProxy } from 'node:util/types';
import { canonicalAssessmentJson as json } from './contract.js';
import { prepareNeighborhoodCohortBlobReference } from './cohortEvidenceBlobRepository.js';
import { prepareCohortSelectedMetricRowV2 } from './cohortSelectedMetricRowV2.js';
import { resolveNeighborhoodOriginalAccountEligibilityV2 } from './neighborhoodOriginalAccountEligibilityV2.js';

export const SELECTED_STATISTICS_CONTRIBUTION_V2_POLICY='current_reported_complete_matching_recorded_housing_one_selected_account_v2';
export const SELECTED_STATISTICS_CONTRIBUTION_V2_MAX_BYTES=4096;
export const SELECTED_STATISTICS_REPORTED_VALUE_STATES=Object.freeze(['observed','missing','invalid','conflicting','unsupported']);
const METRICS=['reported_year_built','reported_residential_area','reported_site_area','reported_market_value'];
const OBSERVATION_KEYS=['state','exact_value','unit','source_part_count','observed_part_count','missing_part_count',
  'invalid_part_count','unsupported_part_count','conflict_values'];
const ROW_METADATA=['command_id','union_reference','eligibility_reference','evidence_reference','selected_entry',
  'effective_date','observation_period','subject_housing','housing_comparison'];
const fail=()=>{throw new TypeError('cohort_selected_statistics_contribution_v2_original_mismatch');};
function data(v,keys){
  if(!v||isProxy(v)||Object.getPrototypeOf(v)!==Object.prototype)fail();
  const ds=Object.getOwnPropertyDescriptors(v);
  if(Reflect.ownKeys(ds).length!==keys.length||!keys.every(k=>ds[k]?.enumerable&&Object.hasOwn(ds[k],'value')))fail();
  return Object.fromEntries(keys.map(k=>[k,ds[k].value]));
}
function ref(v,max){
  const r=data(v,['content_sha256','canonical_utf8_bytes']);let p;
  try{p=prepareNeighborhoodCohortBlobReference(r.content_sha256,r.canonical_utf8_bytes);}catch{fail();}
  if(Number(p.canonical_utf8_bytes)>max)fail();return p;
}
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};

/** Bounded contribution DATA, NEVER an original-source capability or statistics.
 * Called INSIDE the actual current-authorized owner, after its fresh complete
 * original/ENTIRE-cache replay and field-by-field native seventh-row comparison.
 * A caller's source-shaped input, row, hash, reference or helper result grants
 * no authority. All current and ending fences remain the owner's obligation.
 *
 * Each metric has exactly ONE original reported value state per selected
 * account. An observed value with missing/invalid/unsupported parts is still
 * incomplete and contributes no number. Housing exclusions are orthogonal;
 * neither source-part totals nor overlapping reasons are member denominators.
 * Only matching housing and complete equal supported reported parts contribute
 * one exact number. Currency/economic units/GLA/historical housing stay unproved.
 * There is no population ledger, aggregation, rank query or durable progress.
 */
export function prepareCohortSelectedStatisticsContributionV2(...args){
  if(args.length!==3)fail();
  const original=data(args[0],['subject','housing','original_counts','observations']),
    binding=data(args[2],['metric_metadata','metrics_reference','metric_row_reference']);
  let row,decision;
  try{row=prepareCohortSelectedMetricRowV2(args[1],binding.metric_metadata);
    decision=resolveNeighborhoodOriginalAccountEligibilityV2(original);}catch{fail();}
  if(json(row.subject_housing)!==json(original.subject)||row.housing_comparison!==decision.housing.state)fail();
  const originals=data(original.observations,METRICS),metrics={};
  for(const key of METRICS){
    const observation=data(originals[key],OBSERVATION_KEYS),cell=decision.metrics[key],
      fresh=Object.fromEntries(['recorded_comparison_eligible','complete_observed_parts','exact_value','unit'].map(k=>[k,cell[k]]));
    if(!SELECTED_STATISTICS_REPORTED_VALUE_STATES.includes(observation.state)||json(row.metrics[key])!==json(fresh))fail();
    if(cell.recorded_comparison_eligible?cell.reasons.length!==0:cell.reasons.length===0)fail();
    metrics[key]={reported_value_state:observation.state,complete_observed_parts:cell.complete_observed_parts,
      recorded_comparison_eligible:cell.recorded_comparison_eligible,
      contribution_exact_value:cell.recorded_comparison_eligible?cell.exact_value:null,
      contribution_unit:cell.recorded_comparison_eligible?cell.unit:null,
      exclusion_reasons:[...cell.reasons],source_part_count:cell.source_part_count,part_counts:{...cell.part_counts}};
  }
  const result={format:'cohort_selected_statistics_contribution_v2',policy:SELECTED_STATISTICS_CONTRIBUTION_V2_POLICY,
    ...Object.fromEntries(ROW_METADATA.map(k=>[k,row[k]])),metrics_reference:ref(binding.metrics_reference,16000),
    metric_row_reference:ref(binding.metric_row_reference,4096),metrics,
    count_basis:'one_native_selected_account_per_metric_not_parts_or_overlapping_reasons',
    statistics:'not_established',publication:'not_established'};
  if(Buffer.byteLength(json(result))>SELECTED_STATISTICS_CONTRIBUTION_V2_MAX_BYTES)fail();return freeze(result);
}
