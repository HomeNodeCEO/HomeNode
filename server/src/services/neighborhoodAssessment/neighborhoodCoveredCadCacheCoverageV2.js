import { assessmentEvidenceDigest, canonicalAssessmentJson as json } from './contract.js';
import { prepareNeighborhoodCohortBlobReference } from './cohortEvidenceBlobRepository.js';
import { prepareCohortCadCacheCoverageReceiptV2 } from './cohortCadCacheCoverageReceiptV2.js';
import { getNeighborhoodFrozenTypedCadImprovementV1Profile } from './neighborhoodFrozenTypedCadImprovementV1.js';

// Fixed native metadata only. Neither a DONE receipt nor this read authorizes
// source use: the actual owner checks current CAD/market rights at both ends
// and the SAME bounded reader replays every original against its ENTIRE cache.
export const NEIGHBORHOOD_NATIVE_CAD_CACHE_COVERAGE_V2_SQL = `/* neighborhood-native-CAD-cache-v2:covered-selection */
SELECT txid_current()::text AS transaction_id,h.sequence,h.receipt_reference,b.canonical_utf8 AS receipt_text
FROM app.neighborhood_custom_cohort_capture_jobs job
JOIN app.neighborhood_custom_cohort_cache_stock_v2_bridges bridge ON bridge.operation_id=job.operation_id AND bridge.organization_id=job.organization_id
  AND bridge.report_file_id=job.report_file_id AND bridge.assignment_file_id=job.assignment_file_id AND bridge.account_id=job.account_id
  AND bridge.actor_user_id=job.actor_user_id AND bridge.request_sha256=job.request_sha256
JOIN app.neighborhood_custom_cohort_cad_success_v2_jobs d ON d.operation_id=job.operation_id AND d.organization_id=job.organization_id
  AND d.report_file_id=job.report_file_id AND d.assignment_file_id=job.assignment_file_id AND d.account_id=job.account_id
  AND d.actor_user_id=job.actor_user_id AND d.request_sha256=job.request_sha256
JOIN app.neighborhood_custom_cohort_neutral_cache_v2_heads neutral ON neutral.operation_id=d.operation_id AND neutral.organization_id=d.organization_id
  AND neutral.sequence=d.cache_sequence AND neutral.receipt_reference=d.cache_reference
  AND neutral.sequence=bridge.cache_sequence AND neutral.receipt_reference=bridge.cache_reference
JOIN app.neighborhood_custom_cohort_cad_cache_v2_heads h ON h.operation_id=d.operation_id AND h.organization_id=d.organization_id
  AND h.sequence=d.sequence AND h.receipt_reference=d.receipt_reference AND h.receipt_reference=bridge.cad_reference
  AND h.neutral_reference=neutral.receipt_reference AND h.source_reference=neutral.source_reference AND h.root_reference=neutral.root_reference
  AND h.graph_reference=neutral.graph_reference AND h.geographic_reference=neutral.geographic_reference
  AND h.identity_reference=neutral.identity_reference AND h.stock_reference=neutral.stock_reference
JOIN app.neighborhood_custom_cohort_job_stocks stock ON stock.operation_id=job.operation_id AND stock.organization_id=job.organization_id
JOIN app.neighborhood_cohort_evidence_blobs b ON b.organization_id=h.organization_id AND b.content_sha256=h.receipt_reference->>'content_sha256'
  AND b.canonical_utf8_bytes::text=h.receipt_reference->>'canonical_utf8_bytes' AND b.canonical_utf8_bytes<=16000
WHERE job.operation_id=$1::uuid AND job.claim_token=$2::uuid AND job.attempts=$3::integer
  AND job.organization_id=$4::uuid AND job.report_file_id=$5::uuid AND job.assignment_file_id=$6::bigint
  AND job.account_id=$7 AND job.actor_user_id=$8::uuid AND job.status='running'
  AND job.lease_expires_at>clock_timestamp() AND job.cancellation_requested_at IS NULL AND job.context_sha256 IS NULL
  AND job.request_payload->>'execution_mode'='frozen-originals-v2' AND stock.generation_id=$9::uuid AND stock.status='complete'
  AND job.checkpoint->'evidence_refs'->1=h.stock_reference AND job.checkpoint->'evidence_refs'->2=h.source_reference
  AND job.checkpoint->'evidence_refs'->3=h.graph_reference AND job.checkpoint->'evidence_refs'->4=h.geographic_reference
  AND job.checkpoint->'evidence_refs'->5=h.identity_reference AND h.root_reference=$10::jsonb
  AND b.canonical_utf8::jsonb->>'format'='cohort_CAD_cache_coverage_receipt_v2'
  AND b.canonical_utf8::jsonb->'after'->>'done'='true' AND b.canonical_utf8::jsonb->'typed_profile_reference'=$11::jsonb
FOR SHARE OF job,bridge,d,h NOWAIT`;

const profile = getNeighborhoodFrozenTypedCadImprovementV1Profile().definition_blob.ref;
const fail = () => { throw new TypeError('neighborhood_covered_CAD_cache_v2_coverage_unavailable'); };

/** Read one independent native CAD+neutral DONE binding adopted by this job's
 * stock bridge. Receipt validation is metadata, never original reconciliation.
 * client is the SAME single-use reader executor, with no new/reset budget. */
export async function readNeighborhoodCoveredCadCacheCoverageV2(client, { claim, scope, actorUserId, stock,
  neutralCoverage, source, purpose, decision }) {
  const result = await client.query(NEIGHBORHOOD_NATIVE_CAD_CACHE_COVERAGE_V2_SQL, [claim.operation_id, claim.claim_token, claim.attempts,
    scope.organization_id, scope.report_file_id, scope.assignment_file_id, scope.account_id, actorUserId,
    stock.generation_id, json(JSON.parse(neutralCoverage.receipt_text).root), json(profile)]);
  if (result?.rowCount !== 1 || result.rows?.length !== 1) fail();
  const row = result.rows[0];
  if (Object.keys(row).sort().join(',') !== 'receipt_reference,receipt_text,sequence,transaction_id'
    || typeof row.transaction_id !== 'string' || !/^[1-9][0-9]{0,19}$/.test(row.transaction_id)
    || !Number.isInteger(row.sequence) || row.sequence < 1 || row.sequence > 2_000_001
    || typeof row.receipt_text !== 'string' || Buffer.byteLength(row.receipt_text) > 16_000) fail();
  const ref = prepareNeighborhoodCohortBlobReference(row.receipt_reference?.content_sha256, row.receipt_reference?.canonical_utf8_bytes);
  let body, neutral;
  try { body = JSON.parse(row.receipt_text); neutral = JSON.parse(neutralCoverage.receipt_text); } catch { fail(); }
  if (Buffer.byteLength(row.receipt_text) !== Number(ref.canonical_utf8_bytes) || assessmentEvidenceDigest(body) !== ref.content_sha256) fail();
  const receipt = prepareCohortCadCacheCoverageReceiptV2(body, { binding: neutral.binding,
    source_reference: neutral.source_reference, root_reference: neutral.root, graph_reference: neutral.graph_reference,
    geographic_reference: neutral.geographic_reference, identity_reference: neutral.identity_reference, stock_reference: neutral.stock_reference,
    neutral_reference: neutralCoverage.receipt_reference, typed_profile_reference: profile, cad_source_metadata: source,
    cad_purpose: purpose, cad_decision: decision, stock_account_count: stock.population.account_count });
  if (receipt.sequence !== row.sequence || !receipt.after.done) fail();
  return Object.freeze({ ...row, receipt_reference: ref });
}
