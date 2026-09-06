import { createHash } from "node:crypto";
import { canonicalAssessmentJson } from "../../src/services/neighborhoodAssessment/contract.js";

// Synthetic retained-byte fixtures only. None of these identities, permission
// labels or closure counts represents a real acquisition, license or approval.
export const COHORT_LOCAL_QUERY_FIXTURE_ACCOUNTS = Object.freeze(["000123", "R-001", "r-001"]);
export const COHORT_LOCAL_QUERY_FIXTURE_CAPTURE_TIME = "2026-09-06T08:00:00.123456Z";
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const copy = value => structuredClone(value);

export function cohortFixtureSha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// Intentionally does not certify canonical text: negative tests need correctly
// hashed but noncanonical, oversized or malformed retained text as well.
export function makeCohortBlobFromText(canonical_json) {
  return {
    ref: { content_sha256: cohortFixtureSha256(canonical_json),
      canonical_utf8_bytes: String(Buffer.byteLength(canonical_json, "utf8")) },
    canonical_json,
  };
}

export function makeCohortCanonicalBlob(value) {
  return makeCohortBlobFromText(canonicalAssessmentJson(value));
}

export function makeCohortLocalQueryMetadata({ workflowType = "custom_appraisal", subjectId = "000123" } = {}) {
  return {
    reader_version: "local-capture-v3",
    mapping_version: 1,
    scope: {
      organization_id: "10000000-0000-4000-8000-000000000001",
      appraisal_case_id: "20000000-0000-4000-8000-000000000002",
      subject_snapshot_id: "30000000-0000-4000-8000-000000000003",
      account_id: subjectId,
    },
    effective_date: "2024-06-30",
    observation_period: { start_date: "2023-07-01", end_date: "2024-06-30" },
    knowledge_cutoff: null,
    capture_observed_at: COHORT_LOCAL_QUERY_FIXTURE_CAPTURE_TIME,
    authorization: {
      target: {
        report_file_id: "40000000-0000-4000-8000-000000000004",
        workflow_type: workflowType,
        workflow_target_id: workflowType === "uad_3_6" ? "50000000-0000-4000-8000-000000000005" : "42",
      },
      selection: { id: "selection:synthetic-fixed", revision: 1,
        definition_sha256: "a".repeat(64), source_sha256: "b".repeat(64) },
      selection_sha256: "0".repeat(64),
      transaction_closure: {
        version: 1, source_revision: "synthetic-closure-v1", closure_sha256: "c".repeat(64),
        transaction_count: 1, link_count: 1, legacy_sale_count: 0,
        account_count: 1, source_record_count: 1,
      },
      market_decision: { decision_id: "licensed-test-only", policy_revision: "synthetic-no-authority-v1" },
    },
    semantics: "current_mutable_query_capture_not_historical_replay",
    selection_method: "exact_selected_accounts_all_source_links_no_event_filter",
    provider_coverage: "unknown",
    limits: { records: 100_000, bytes: 30_000_000, row_bytes: 64_000, page_size: 250,
      selected_accounts: 50_000, duration_ms: 30_000, statement_ms: 5_000, connect_ms: 3_000 },
    capabilities: Object.fromEntries([
      ["parcels", "gis.dcad_parcels"], ["accounts", "core.accounts"],
      ["source_records", "core.sales_source_records"], ["sales", "core.sales"],
      ["sale_links", "core.sale_parcels"], ["sync_state", "gis.source_sync_state"],
      ["sync_runs", "gis.source_sync_runs"],
    ].map(([key, relation]) => [key, { relation, state: "available", missing_columns: [] }])),
  };
}

export function cohortFixtureAuthorizationHash(metadata, accountIds) {
  return cohortFixtureSha256(canonicalAssessmentJson({ scope: metadata.scope,
    effective_date: metadata.effective_date, selection: metadata.authorization.selection,
    account_ids: accountIds }));
}

export function cohortFixtureQueryHash(metadata, accountIds) {
  const hash = createHash("sha256").update(canonicalAssessmentJson(metadata));
  for (const accountId of accountIds) hash.update(canonicalAssessmentJson(accountId)).update("\n");
  return hash.digest("hex");
}

export function createCohortLocalQueryEvidenceFixture({
  accountIds = COHORT_LOCAL_QUERY_FIXTURE_ACCOUNTS,
  metadata = makeCohortLocalQueryMetadata({ subjectId: accountIds[0] || "000123" }),
  pageSize = 1_000, authorizationHash, mutatePage, mutateDirectory, mutatePreimage,
} = {}) {
  const accounts = copy(accountIds);
  const compact = copy(metadata);
  // An explicit synthetic override lets a negative test reach the production
  // authorization-preimage limit without this fixture hitting that limit first.
  compact.authorization.selection_sha256 = authorizationHash === undefined
    ? cohortFixtureAuthorizationHash(compact, accounts) : authorizationHash;
  const pages = [];
  for (let start = 0; start < accounts.length; start += pageSize) {
    const page = { directory_version: 1, kind: "authorized_accounts",
      page_index: String(pages.length), entries: accounts.slice(start, start + pageSize).map(account_id => ({ account_id })) };
    if (mutatePage) mutatePage(page, pages.length);
    pages.push(page);
  }
  const pageBlobs = pages.map(makeCohortCanonicalBlob);
  const directory = { directory_version: 1, kind: "authorized_accounts", entry_count: String(accounts.length),
    pages: pageBlobs.map((blob, index) => ({ page_index: String(index),
      entry_count: String(pages[index].entries.length), page: copy(blob.ref) })) };
  if (mutateDirectory) mutateDirectory(directory, pageBlobs);
  const directoryBlob = makeCohortCanonicalBlob(directory);
  const metadataBlob = makeCohortCanonicalBlob(compact);
  const preimage = { query_preimage_version: 1, compact_metadata: copy(metadataBlob.ref),
    ordered_account_roster: { manifest: copy(directoryBlob.ref), entry_count: String(accounts.length) } };
  if (mutatePreimage) mutatePreimage(preimage, { metadataBlob, directoryBlob, pageBlobs });
  const preimageBlob = makeCohortCanonicalBlob(preimage);
  const bundle = {
    version: 1, producer_profile: "local-capture-v3", query_preimage: copy(preimageBlob.ref),
    captured_query_selection_sha256: cohortFixtureQueryHash(compact, accounts),
    blobs: [preimageBlob, metadataBlob, directoryBlob, ...pageBlobs]
      .sort((a, b) => compare(a.ref.content_sha256, b.ref.content_sha256)),
  };
  return { accountIds: accounts, metadata: compact, pages, directory, preimage,
    refs: { preimage: copy(preimageBlob.ref), metadata: copy(metadataBlob.ref), directory: copy(directoryBlob.ref),
      pages: pageBlobs.map(blob => copy(blob.ref)) }, bundle, inputJson: JSON.stringify(bundle) };
}
