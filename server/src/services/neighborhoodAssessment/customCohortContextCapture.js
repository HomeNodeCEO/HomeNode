import { performance } from 'node:perf_hooks';
import { setImmediate as yieldToRequests } from 'node:timers/promises';
import { CUSTOM_COHORT_OPERATION_LIMITS } from './customCohortOperationLimits.js';
import { checkCustomCohortMarketMembership } from './customCohortMarketMembership.js';
import { createCustomCapturePhaseTiming, createCustomReportPhaseTiming, createCustomPreviewPhaseTiming,
  createCustomCatalogPhaseTiming, createCustomPreparedCatalogPhaseTiming,
  createCustomPreparedCatalogProjectionTiming } from './customCapturePhaseTiming.js';
import { prepareCustomCohortOpeningGroups, prepareCustomCohortOpeningMode, customCohortOpeningGroupIds, customCohortOpeningSelection,
  CUSTOM_COHORT_OPENING_RESPONSE_BYTES, CUSTOM_COHORT_OPENING_PREVIEW_BYTES } from './customCohortOpeningPreview.js';
import { randomUUID } from 'node:crypto';
import { types as utilTypes } from 'node:util';
import { decideAssignmentAccess } from '../../security/assignmentAccess.js';
import { hasApplicationPermission } from '../../security/applicationAccess.js';
import { customNeighborhoodPrivateSalesPurpose } from '../../security/customNeighborhoodPrivateSalesPolicy.js';
import { captureAssignmentSalesCsv, recheckAssignmentSalesCsvCapture } from '../assignmentSalesCsv/capture.js';
import { buildCustomCohortPrivateSalesObservations, presentCustomCohortPrivateSalesObservations } from './customCohortPrivateSales.js';
import { authorizePublicCadastralCatalogRead } from '../../security/publicCadastralCatalog.js';
import { assessmentDate, assessmentEvidenceDigest, canonicalAssessmentJson } from './contract.js';
import { createNeighborhoodCohortBlobRepository, prepareNeighborhoodCohortBlob,
  NEIGHBORHOOD_COHORT_BLOB_READ_BATCH_LIMITS } from './cohortEvidenceBlobRepository.js';
import { createCustomCohortSubjectRepository } from './customCohortSubjectRepository.js';
import { createCustomCohortContextRepository } from './customCohortContextRepository.js';
import { createCustomCohortCaptureJobRepository, prepareCustomCohortCaptureJobClaim, FROZEN_ORIGINALS_V2_EXECUTION } from './customCohortCaptureJobRepository.js';
import { createCustomCohortInitialV2JobRepository } from './customCohortInitialV2JobRepository.js';
import { loadCurrentCustomCohortJobActor } from './customCohortJobActor.js';
import { createNeighborhoodFrozenJobStock } from './neighborhoodFrozenJobStock.js';
import { createNeighborhoodFrozenJobStockOriginals } from './neighborhoodFrozenJobStockOriginals.js';
import { createNeighborhoodFrozenJobSourceIdentity } from './neighborhoodFrozenJobSourceIdentity.js';
import { createNeighborhoodSharedJobCadImprovementPages,prepareNeighborhoodSharedJobCadPage,
  createNeighborhoodSharedJobCadAccountPages,prepareNeighborhoodSharedJobCadAccountPage }
  from './neighborhoodSharedJobCadImprovementPages.js';
import { prepareNeighborhoodOriginalCadAccountPackagePageV2,NEIGHBORHOOD_ORIGINAL_CAD_ACCOUNT_PACKAGE_V2_SQL,
  NEIGHBORHOOD_ORIGINAL_CAD_ACCOUNT_PACKAGE_V2_LIMITS,reconcileNeighborhoodOriginalCadAccountPackageV2 } from './neighborhoodOriginalCadAccountPackagesV2.js';
import { resolveNeighborhoodOriginalCadAmenityEvidenceV2 } from './neighborhoodOriginalCadAmenityEvidenceV2.js';
import { prepareNeighborhoodCoveredCadCacheHeaderV2 } from './neighborhoodCoveredCadCacheHeaderV2.js';
import { createNeighborhoodScopedCadOriginalAccountV2 } from './neighborhoodScopedCadOriginalAccountV2.js';
import { describeNeighborhoodCadImprovementPurpose } from '../../security/customNeighborhoodCadImprovementSourcePolicy.js';
import { createNeighborhoodFrozenJobTypedOriginals } from './neighborhoodFrozenJobTypedOriginals.js';
import { getNeighborhoodFrozenTypedOriginalV1Profile,getNeighborhoodFrozenTypedOriginalV2Profile } from './neighborhoodFrozenTypedOriginalV1.js';
import { createNeighborhoodSharedTypedOriginalPageV2,NEIGHBORHOOD_SHARED_TYPED_CAD_SQL,prepareNeighborhoodSharedTypedCadSource }
  from './neighborhoodSharedTypedGeneration.js';
import { getNeighborhoodFrozenTypedCadImprovementV1Profile } from './neighborhoodFrozenTypedCadImprovementV1.js';
import { createCustomCohortCadCacheV2HeadRepository,createCustomCohortCadCacheV2AutomaticHeadRepository } from './customCohortCadCacheV2HeadRepository.js';
import { createCustomCohortCadCacheV2ContinuationRepository } from './customCohortCadCacheV2ContinuationRepository.js';
import { prepareCohortCadCacheCoverageReceiptV2,initialCohortCadCacheCoverageV2State } from './cohortCadCacheCoverageReceiptV2.js';
import { createNeighborhoodFrozenJobStockMetricPages, createNeighborhoodSharedJobStockMetricPages,
  createNeighborhoodSharedJobStockMetricPagesV2, prepareNeighborhoodFrozenStockMetricPage }
  from './neighborhoodFrozenJobStockMetricPages.js';
import { createNeighborhoodFrozenJobSourcePages,createNeighborhoodPreparedJobSourcePages } from './neighborhoodFrozenSourceClosurePages.js';
import { createNeighborhoodFrozenJobSourceSeeds } from './neighborhoodFrozenJobSourceSeeds.js';
import { createNeighborhoodSharedJobTransactionPagesV2,prepareNeighborhoodSharedTransactionPageV2 }
  from './neighborhoodSharedJobTransactionPagesV2.js';
import { projectNeighborhoodTransactionTemporalV1, prepareNeighborhoodTransactionRetainedPeriodV1,
  getNeighborhoodTransactionTemporalV1Profile, NEIGHBORHOOD_TRANSACTION_TEMPORAL_V1_LIMITS }
  from './neighborhoodTransactionTemporalV1.js';
import { createNeighborhoodSharedTransactionPackagesV1, prepareNeighborhoodTransactionPackagePageV1 }
  from './neighborhoodSharedTransactionPackagesV1.js';
import { createNeighborhoodSharedStockOriginalCellsV2, createNeighborhoodCoveredStockOriginalCellsV2, createNeighborhoodCoveredCadStockOriginalCellsV2, prepareNeighborhoodStockOriginalCellPageV2,
  prepareNeighborhoodStockAccountPackagePageV2, NEIGHBORHOOD_STOCK_ORIGINAL_CELLS_V2_LIMITS }
  from './neighborhoodSharedStockOriginalCellsV2.js';
import { createCohortOriginalSourceChainV1Store, COHORT_ORIGINAL_SOURCE_CHAIN_V1_KINDS }
  from './cohortOriginalSourceChainV1.js';
import { verifyCohortOriginalSourceGraphStep } from './cohortOriginalSourceGraphV1.js';
import { createCohortOriginalSourceReferencesV2Store } from './cohortOriginalSourceReferencesV2.js';
import { verifyCohortOriginalSourceGraphV2Step } from './cohortOriginalSourceGraphV2.js';
import { createCustomCohortGraphV2AnchorRepository } from './customCohortGraphV2AnchorRepository.js';
import { createCustomCohortSourcePrefixV2Repository } from './customCohortSourcePrefixV2Repository.js';
import { createCustomCohortSourcePrefixV2ContinuationRepository } from './customCohortSourcePrefixV2ContinuationRepository.js';
import { createCustomCohortGeographicV2AnchorRepository } from './customCohortGeographicV2AnchorRepository.js';
import { prepareCohortGeographicOriginalReceiptV2 } from './cohortGeographicOriginalReceiptV2.js';
import { createCustomCohortIdentityV2AnchorRepository } from './customCohortIdentityV2AnchorRepository.js';
import { prepareCohortSourceIdentityReceiptV2 } from './cohortSourceIdentityReceiptV2.js';
import { prepareCohortStockTraversalReceiptV2 } from './cohortStockTraversalReceiptV2.js';
import { prepareCohortStockTraversalBatchReceiptV3 } from './cohortStockTraversalBatchReceiptV3.js';
import { createCustomCohortStockTraversalV2AnchorRepository } from './customCohortStockTraversalV2AnchorRepository.js';
import { createCustomCohortNeutralCacheV2HeadRepository,createCustomCohortNeutralCacheV2AutomaticHeadRepository,
  createCustomCohortNeutralCacheV2CadParentHeadRepository } from './customCohortNeutralCacheV2HeadRepository.js';
import { createCustomCohortNeutralCacheV2ContinuationRepository } from './customCohortNeutralCacheV2ContinuationRepository.js';
import { prepareCohortRecordedGroupPartitionReceiptV2 } from './cohortRecordedGroupPartitionReceiptV2.js';
import { createCustomCohortRecordedPartitionV2Repository } from './customCohortRecordedPartitionV2Repository.js';
import { createCustomCohortRecordedCatalogV2Repository } from './customCohortRecordedCatalogV2Repository.js';
import { prepareCohortRecordedCatalogReceiptV2 } from './cohortRecordedCatalogReceiptV2.js';
import { createCustomCohortSelectedUnionV2Repository } from './customCohortSelectedUnionV2Repository.js';
import { prepareCohortSelectedUnionReceiptV2 } from './cohortSelectedUnionReceiptV2.js';
import { createCustomCohortSelectedEligibilityV2Repository } from './customCohortSelectedEligibilityV2Repository.js';
import { prepareCohortSelectedEligibilityReceiptV2, SELECTED_RECORDED_ELIGIBILITY_METRICS } from './cohortSelectedEligibilityReceiptV2.js';
import { createCustomCohortSelectedEvidenceV2Repository } from './customCohortSelectedEvidenceV2Repository.js';
import { prepareCohortSelectedEvidenceReceiptV2 } from './cohortSelectedEvidenceReceiptV2.js';
import { createCustomCohortSelectedMetricsV2Repository } from './customCohortSelectedMetricsV2Repository.js';
import { prepareCohortSelectedMetricsReceiptV2 } from './cohortSelectedMetricsReceiptV2.js';
import { prepareCohortSelectedMetricRowV2, SELECTED_REPORTED_METRIC_ROW_V2_BASIS } from './cohortSelectedMetricRowV2.js';
import { prepareCohortSelectedStatisticsContributionV2 } from './cohortSelectedStatisticsContributionV2.js';
import { SELECTED_STATISTICS_CONTRIBUTION_V2_POLICY } from './cohortSelectedStatisticsContributionV2.js';
import { createCustomCohortSelectedStatisticsV2Repository } from './customCohortSelectedStatisticsV2Repository.js';
import { createCustomCohortSelectedNumericV2Repository } from './customCohortSelectedNumericV2Repository.js';
import { createCustomCohortSelectedNumericRankCandidatesV2Repository } from './customCohortSelectedNumericRankCandidatesV2Repository.js';
import { prepareCohortSelectedNumericReceiptV2 } from './cohortSelectedNumericReceiptV2.js';
import { createCustomCohortSelectedSemanticV2Repository } from './customCohortSelectedSemanticV2Repository.js';
import { createCustomCohortSelectedTransactionIndexFirstCandidateV2Repository } from './customCohortSelectedTransactionIndexFirstCandidateV2Repository.js';
import { prepareCohortSelectedTransactionIndexFirstCandidateV2 } from './cohortSelectedTransactionIndexFirstCandidateV2.js';
import { createCustomCohortSelectedTransactionIndexV2Repository } from './customCohortSelectedTransactionIndexV2Repository.js';
import { prepareCohortSelectedTransactionIndexReceiptV2, buildCohortSelectedTransactionIndexReceiptV2 }
  from './cohortSelectedTransactionIndexReceiptV2.js';
import { prepareCohortSelectedSemanticReceiptV2, prepareCohortSelectedSemanticSummaryV2,
  initializeCohortSelectedSemanticSummaryV2, advanceCohortSelectedSemanticSummaryV2,
  finalizeCohortSelectedSemanticSummaryV2 } from './cohortSelectedSemanticReceiptV2.js';
import { emptyCohortSelectedStatisticsCountsV2, advanceCohortSelectedStatisticsCountsV2,
  prepareCohortSelectedStatisticsReceiptV2 } from './cohortSelectedStatisticsReceiptV2.js';
import { encodeCohortDiagnosticCompressedJsonV1 } from './cohortDiagnosticCompressedJsonV1.js';
import { createCustomCohortV2ContinuationRepository } from './customCohortV2ContinuationRepository.js';
import { createCustomCohortV2SelectionWaitRepository } from './customCohortV2SelectionWaitRepository.js';
import { createCustomCohortV2SelectionIntentRepository, prepareCustomCohortV2SelectionIntent } from './customCohortV2SelectionIntentRepository.js';
import { createCustomCohortOriginalAccountOwnerBudget,createCustomCohortNeutralCacheOwnerBudget,
  CUSTOM_COHORT_ORIGINAL_ACCOUNT_OWNER_LIMITS } from './customCohortOriginalAccountOwnerBudget.js';
import { getNeighborhoodOriginalRecordedGroupV2Profile } from './neighborhoodOriginalRecordedGroupV2.js';
import { createCustomCohortRecordedGroupSelectionOwner,
  reopenCustomCohortRecordedGroupSelectionOriginal } from './customCohortRecordedGroupSelectionOwner.js';
import { createCustomCohortPreparedCatalogOwner } from './customCohortPreparedCatalogOwner.js';
import { createCustomCohortPreparedSelectionRegistry } from './customCohortPreparedCatalogRegistry.js';
import { createCustomCohortGroupSelectionRepository } from './customCohortGroupSelectionRepository.js';
import { prepareCustomCohortGroupWorkspaceSave,
  prepareCustomCohortGroupCaptureCompletion, readCustomCohortFrozenSelectionWorkspaceTarget } from './customCohortGroupWorkspaceSave.js';
import { createCustomCohortCacheStockV2BridgeRepository } from './customCohortCacheStockV2BridgeRepository.js';
import { resumeCustomCohortSubjectCheckpoint } from './customCohortCaptureSubjectCheckpoint.js';
import { resolveCustomCohortRetainedSubjectHousing } from './customCohortRetainedSubjectHousing.js';
import { resolveNeighborhoodOriginalAccountEligibilityV2 } from './neighborhoodOriginalAccountEligibilityV2.js';
import { resumeCustomCohortPreparationCheckpoint } from './customCohortCapturePreparationCheckpoint.js';
import { prepareCustomCohortContextReference, prepareCustomCohortContextHeader } from './customCohortContextContract.js';
import { captureNeighborhoodSpatialMembershipCompact } from './cachedSpatialMembership.js';
import { readCustomCohortPreparedSecondaryFacts } from './customCohortPreparedSecondaryMap.js';
import { resolveNeighborhoodCachedTransactionClosure } from './cachedTransactionClosureReader.js';
import { createNeighborhoodCadEvidenceReadAccess, describeNeighborhoodCachedMarketDataPurpose,
  describeNeighborhoodSaleWitnessMarketDataPurpose, createNeighborhoodCombinedEvidenceReadAccess,
  describeNeighborhoodCombinedEvidenceMarketDataPurpose } from './cachedReadAccess.js';
import { createNeighborhoodDenseCadEvidenceSourceReader, createNeighborhoodDenseCombinedEvidenceSourceReader,
  consumeNeighborhoodCachedAcquisition } from './cachedSourceReader.js';
import { NEIGHBORHOOD_SELECTOR_INPUT_PROFILE_V1, prepareNeighborhoodSelectorInput,
  prepareNeighborhoodDiscoveryChoice, NEIGHBORHOOD_SELECTOR_INPUT_PROFILE_CITY,
  NEIGHBORHOOD_CITY_PARCEL_PREDICATE } from './selectorInputProfile.js';
import { loadInstalledCustomCityDiscovery } from './customCityDiscovery.js';
import { prepareCustomCohortCaptureInputsBatched, persistCustomCohortCaptureInputs,
  loadCustomCohortCaptureInputs } from './customCohortCaptureInputs.js';
import { buildCustomCohortObservationPreview, buildCustomCohortIndexedObservationPreviewBatched,
  reselectCustomCohortIndexedObservationPreview,
  CUSTOM_COHORT_OBSERVATION_PREVIEW_LIMITS } from './customCohortObservationPreview.js';
import { createCustomCohortPreparedPreviewRepository, selectCustomCohortPreparedParcelMap,
  selectCustomCohortPreparedParcelViewportMap,
  selectCustomCohortPreparedTileViewportMap,
  customCohortPreparedParcelMapJsonBytes } from './customCohortPreparedPreviewRepository.js';
import { createCustomCohortPreparedCatalogRepository, rebindCustomCohortPreparedCatalog } from './customCohortPreparedCatalogRepository.js';
import { buildCustomCohortParcelMapBatched } from './customCohortParcelMap.js';
import { buildCustomCohortMapManifest } from './customCohortMapManifest.js';
import { createCustomCohortPreparedMapOpeningRepository } from './customCohortPreparedMapOpeningRepository.js';
import { presentCustomCohortGroupMapOpening } from './customCohortGroupMapOpening.js';
import { prepareCustomCohortViewport, projectCustomCohortViewportMap,
  presentCustomCohortSelectionViewportMap } from './customCohortViewportMap.js';
import { presentCustomCohortPreview, inspectCustomCohortPreviewMembers, customCohortPreviewBinding } from './customCohortPreviewPresentation.js';
import { buildCustomCohortPocketCatalog, presentCustomCohortPocketCatalog, CUSTOM_COHORT_POCKET_CATALOG_LIMITS,
  CUSTOM_COHORT_DENSE_CATALOG_VERSION, customCohortCatalogGroupLimit,
  customCohortPocketCatalogBatches } from './customCohortPocketCatalog.js';
import { buildCustomCohortPocketRecommendationPresentationBatched,
  CUSTOM_COHORT_DENSE_RECOMMENDATION_PRESENTATION_BYTES } from './customCohortPocketRecommendationPresentation.js';
import { buildCustomCohortMapScoresBatched } from './customCohortPocketRecommendation.js';
import { deriveCustomCohortRecordedProximity } from './customCohortRecordedProximity.js';
import { prepareCohortDecisionCommandV1 } from './cohortDecisionCommand.js';
import { createCustomCohortReviewRepository } from './customCohortReviewRepository.js';
import { buildCustomCohortSupportedInputs } from './customCohortSupportedInputs.js';
import { customCohortCurrentStockSupport } from './customCohortTemporalSupport.js';
import { buildCustomCohortReportPreparation } from './customCohortReportPreparation.js';
import { buildCustomCohortReportedAssessmentBatched, buildCustomCohortReportedAssessmentWitnessV2Batched } from './customCohortReportedAssessment.js';
import { getCustomCohortReportedSaleWitnessV2Profile } from './customCohortReportedSaleWitnessV2.js';
import { getCustomCohortRecordedHousingInterpretation } from './customCohortRecordedHousingProfiles.js';
import { createNeighborhoodAssessmentRepositoryInTransaction, neighborhoodCallerCleanupFailure } from './assessmentRepository.js';
import { getNeighborhoodAttachment, persistNeighborhoodAttachment } from './applicationRepository.js';
import { buildCustomNeighborhoodReportCandidate, prepareCustomNeighborhoodReportApply,
  prepareCustomNeighborhoodReportReplacement, CUSTOM_REPORTED_OBSERVATION_MAPPER_VERSION } from './customReportMapping.js';
import { buildNeighborhoodApplicationReceipt } from './applicationGroup.js';
import { getCustomNeighborhoodAcceptance } from './customAcceptanceRepository.js';
import { saveCustomNeighborhoodAcceptanceInTransaction } from './customAcceptanceSave.js';
import { prepareCustomCohortReportGeography, completeCustomCohortReportGeography,
  CUSTOM_COHORT_REPORT_GEOGRAPHY_FIELDS, CUSTOM_COHORT_REPORT_GEOGRAPHY_LIMITS } from './customCohortReportGeography.js';
import { CUSTOM_NEIGHBORHOOD_ACCEPTED_SECTION } from './customAcceptanceSnapshot.js';
import { CUSTOM_NEIGHBORHOOD_WORKSPACE_SECTION, CUSTOM_NEIGHBORHOOD_DENSE_WORKSPACE_CHECKPOINT_LIMITS,
  readCustomNeighborhoodWorkspaceCheckpoint, customWorkspaceCatalogVersion } from './customWorkspaceCheckpoint.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const TARGET_FIELDS = ['organization_id', 'report_file_id', 'assignment_file_id', 'account_id'];
const DEPENDENCIES = ['snapshot_evidence', 'subject_dependencies', 'selection_input', 'study_input'];
const LIMITS = Object.freeze({ ...CUSTOM_COHORT_OPERATION_LIMITS, connect_ms: 3000, query_ms: 6000, cleanup_ms: 1000 });
const OWNER_INTERRUPTION_REASONS = new WeakMap();
const same = (a, b) => canonicalAssessmentJson(a) === canonicalAssessmentJson(b);
// The server-owned routing discriminator changes no discovery/source input.
const sameFrozenRequest = (actual, expected) => same(actual, expected)
  || same(actual, {...expected, execution_mode: FROZEN_ORIGINALS_V2_EXECUTION});
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
// Server-only discriminated stages. Flags and checkpoint admission travel
// together; callers cannot create combinations by shifting positional booleans.
const FROZEN_SOURCE_STAGES = freeze({
  prefix_v1: { allowedPhases: ['frozen_stock_v1', 'frozen_source_v1'] },
  prefix_refs_v2: { referencesV2: true, allowedPhases: ['frozen_stock_v1', 'frozen_source_refs_v2'] },
  issued_prefix_refs_v2: { referencesV2: true, issuingSourcePrefix: true, allowedPhases: ['frozen_stock_v1', 'frozen_source_refs_v2'] },
  continued_prefix_refs_v2: { referencesV2: true, issuingSourcePrefix: true, yieldingSourcePrefix: true, allowedPhases: ['frozen_stock_v1', 'frozen_source_refs_v2'] },
  verify_refs_v2: { referencesV2: true, verifying: true, allowedPhases: ['frozen_source_refs_v2', 'frozen_verify_refs_v2'] },
  geographic_refs_v2: { referencesV2: true, verifying: true, stockVerifying: true,
    allowedPhases: ['frozen_verify_refs_v2', 'frozen_geo_verify_refs_v2'] },
  identity_refs_v2: { referencesV2: true, verifying: true, stockVerifying: true, identityVerifying: true,
    allowedPhases: ['frozen_geo_verify_refs_v2', 'frozen_identity_refs_v2'] },
  neutral_cache_refs_v2: { referencesV2:true,verifying:true,stockVerifying:true,identityVerifying:true,cachingNeutralOriginals:true,
    allowedPhases:['frozen_identity_refs_v2'] },
  neutral_cache_continue_refs_v2: { referencesV2:true,verifying:true,stockVerifying:true,identityVerifying:true,
    cachingNeutralOriginals:true,yieldingNeutralProgress:true,allowedPhases:['frozen_identity_refs_v2'] },
  verify_continue_refs_v2: { referencesV2: true, verifying: true, yieldingEarlyProgress: true,
    allowedPhases: ['frozen_source_refs_v2', 'frozen_verify_refs_v2'] },
  geographic_continue_refs_v2: { referencesV2: true, verifying: true, stockVerifying: true, yieldingEarlyProgress: true,
    allowedPhases: ['frozen_verify_refs_v2', 'frozen_geo_verify_refs_v2'] },
  identity_continue_refs_v2: { referencesV2: true, verifying: true, stockVerifying: true, identityVerifying: true, yieldingEarlyProgress: true,
    allowedPhases: ['frozen_geo_verify_refs_v2', 'frozen_identity_refs_v2'] },
  verify_v1: { verifying: true, allowedPhases: ['frozen_source_v1', 'frozen_verify_v1'] },
  geographic_v1: { verifying: true, stockVerifying: true, allowedPhases: ['frozen_verify_v1', 'frozen_geo_verify_v1'] },
  identity_v1: { verifying: true, stockVerifying: true, identityVerifying: true,
    allowedPhases: ['frozen_geo_verify_v1', 'frozen_identity_v1'] },
  typed_v1: { verifying: true, stockVerifying: true, identityVerifying: true, typing: true,
    allowedPhases: ['frozen_identity_v1', 'frozen_typed_v1'] },
  stock_metrics_v1: { verifying: true, stockVerifying: true, identityVerifying: true, typing: true,
    readingStockMetrics: true, allowedPhases: ['frozen_typed_v1'] },
  shared_stock_metrics_v1: { verifying: true, stockVerifying: true, identityVerifying: true,
    readingSharedStockMetrics: true, allowedPhases: ['frozen_identity_v1', 'frozen_typed_v1'] },
  shared_stock_metrics_refs_v2: { referencesV2: true, verifying: true, stockVerifying: true, identityVerifying: true,
    readingSharedStockMetrics: true, neutralSharedMetrics: true, allowedPhases: ['frozen_identity_refs_v2'] },
  shared_CAD_pages_refs_v2: { referencesV2: true, verifying: true, stockVerifying: true, identityVerifying: true,
    readingCadPages: true, allowedPhases: ['frozen_identity_refs_v2'] },
  shared_CAD_accounts_refs_v2: { referencesV2: true, verifying: true, stockVerifying: true, identityVerifying: true,
    readingCadPages: true, projectingCadAccounts: true, allowedPhases: ['frozen_identity_refs_v2'] },
  original_CAD_account_packages_refs_v2: { referencesV2: true, verifying: true, stockVerifying: true, identityVerifying: true,
    readingCadPages: true, projectingCadAccounts: true, reconcilingCadAccounts: true, allowedPhases: ['frozen_identity_refs_v2'] },
  cache_CAD_original_account_refs_v2: { referencesV2: true, verifying: true, stockVerifying: true, identityVerifying: true,
    readingCadPages: true, projectingCadAccounts: true, reconcilingCadAccounts: true, cachingCadOriginals: true,
    allowedPhases: ['frozen_identity_refs_v2'] },
  cache_CAD_coverage_refs_v2: { referencesV2: true, verifying: true, stockVerifying: true, identityVerifying: true,
    readingCadPages: true, cachingCadCoverage: true, allowedPhases: ['frozen_identity_refs_v2'] },
  continue_CAD_coverage_refs_v2: { referencesV2: true, verifying: true, stockVerifying: true, identityVerifying: true,
    readingCadPages: true, cachingCadCoverage: true, yieldingCadProgress: true, allowedPhases: ['frozen_identity_refs_v2'] },
  covered_first_CAD_amenities_refs_v2: { referencesV2: true, verifying: true, stockVerifying: true, identityVerifying: true,
    readingCadPages: true, cachingCadCoverage: true, readingCoveredCadAmenities: true, allowedPhases: ['frozen_identity_refs_v2'] },
  original_CAD_amenity_evidence_refs_v2: { referencesV2: true, verifying: true, stockVerifying: true, identityVerifying: true,
    readingCadPages: true, projectingCadAccounts: true, reconcilingCadAccounts: true, resolvingCadAmenities: true, allowedPhases: ['frozen_identity_refs_v2'] },
  shared_transaction_pages_refs_v2: { referencesV2: true, verifying: true, stockVerifying: true, identityVerifying: true,
    readingTransactionPages: true, allowedPhases: ['frozen_identity_refs_v2'] },
  shared_transaction_temporal_refs_v2: { referencesV2: true, verifying: true, stockVerifying: true, identityVerifying: true,
    readingTransactionPages: true, projectingTransactionTemporal: true, allowedPhases: ['frozen_identity_refs_v2'] },
  shared_transaction_packages_refs_v2: { referencesV2: true, verifying: true, stockVerifying: true, identityVerifying: true,
    readingTransactionPackages: true, allowedPhases: ['frozen_identity_refs_v2'] },
  original_transaction_packages_refs_v2: { referencesV2: true, verifying: true, stockVerifying: true, identityVerifying: true,
    readingTransactionPackages: true, reconcilingTransactionPackages: true, allowedPhases: ['frozen_identity_refs_v2'] },
  shared_stock_original_cells_refs_v2: { referencesV2: true, verifying: true, stockVerifying: true, identityVerifying: true,
    readingStockOriginalCells: true, allowedPhases: ['frozen_identity_refs_v2'] },
  shared_stock_account_packages_refs_v2: { referencesV2: true, verifying: true, stockVerifying: true, identityVerifying: true,
    readingStockAccountPackages: true, allowedPhases: ['frozen_identity_refs_v2'] },
  covered_stock_account_packages_refs_v2: { referencesV2:true,verifying:true,stockVerifying:true,identityVerifying:true,
    readingStockAccountPackages:true,coveredNeutralOriginals:true,allowedPhases:['frozen_identity_refs_v2'] },
  covered_stock_whole_account_batch_refs_v2: { referencesV2:true,verifying:true,stockVerifying:true,identityVerifying:true,
    readingStockAccountPackages:true,readingStockWholeAccountBatch:true,coveredNeutralOriginals:true,
    allowedPhases:['frozen_identity_refs_v2','frozen_stock_traversal_refs_v2','frozen_recorded_partition_refs_v2','frozen_recorded_catalog_refs_v2'] },
  original_account_housing_refs_v2: { referencesV2: true, verifying: true, stockVerifying: true, identityVerifying: true,
    readingStockAccountPackages: true, resolvingStockAccountHousing: true, allowedPhases: ['frozen_identity_refs_v2'] },
  original_account_recorded_group_refs_v2: { referencesV2: true, verifying: true, stockVerifying: true, identityVerifying: true,
    readingStockAccountPackages: true, resolvingStockAccountRecordedGroup: true, allowedPhases: ['frozen_identity_refs_v2'] },
  original_stock_traversal_refs_v2: { referencesV2: true, verifying: true, stockVerifying: true, identityVerifying: true,
    traversingStock: true, allowedPhases: ['frozen_identity_refs_v2', 'frozen_stock_traversal_refs_v2'] },
  original_recorded_partition_refs_v2: { referencesV2: true, verifying: true, stockVerifying: true, identityVerifying: true,
    partitioningRecordedGroups: true, allowedPhases: ['frozen_stock_traversal_refs_v2', 'frozen_recorded_partition_refs_v2'] },
  original_recorded_partition_account_refs_v2: { referencesV2: true, verifying: true, stockVerifying: true, identityVerifying: true,
    readingStockAccountPackages: true, readingRecordedPartition: true, allowedPhases: ['frozen_recorded_partition_refs_v2'] },
  covered_recorded_partition_account_refs_v2: { referencesV2:true,verifying:true,stockVerifying:true,identityVerifying:true,
    readingStockAccountPackages:true,readingRecordedPartition:true,coveredNeutralOriginals:true,
    allowedPhases:['frozen_recorded_partition_refs_v2'] },
  original_stock_traversal_continue_refs_v2: { referencesV2: true, verifying: true, stockVerifying: true, identityVerifying: true,
    traversingStock: true, yieldingV2Progress: true, allowedPhases: ['frozen_identity_refs_v2', 'frozen_stock_traversal_refs_v2'] },
  covered_stock_traversal_continue_refs_v2: { referencesV2:true,verifying:true,stockVerifying:true,identityVerifying:true,
    traversingStock:true,yieldingV2Progress:true,coveredNeutralOriginals:true,cacheStockHandoff:true,
    allowedPhases:['frozen_identity_refs_v2','frozen_stock_traversal_refs_v2'] },
  covered_stock_batch_continue_refs_v3: { referencesV2:true,verifying:true,stockVerifying:true,identityVerifying:true,
    traversingStock:true,batchingStock:true,yieldingV2Progress:true,coveredNeutralOriginals:true,cacheStockHandoff:true,
    allowedPhases:['frozen_identity_refs_v2','frozen_stock_traversal_refs_v2'] },
  original_recorded_partition_continue_refs_v2: { referencesV2: true, verifying: true, stockVerifying: true, identityVerifying: true,
    partitioningRecordedGroups: true, yieldingV2Progress: true, allowedPhases: ['frozen_stock_traversal_refs_v2', 'frozen_recorded_partition_refs_v2'] },
  covered_recorded_partition_continue_refs_v2: { referencesV2:true,verifying:true,stockVerifying:true,identityVerifying:true,
    partitioningRecordedGroups:true,yieldingV2Progress:true,coveredNeutralOriginals:true,
    allowedPhases:['frozen_stock_traversal_refs_v2','frozen_recorded_partition_refs_v2'] },
  original_recorded_catalog_refs_v2: { referencesV2: true, verifying: true, stockVerifying: true, identityVerifying: true,
    catalogingRecordedGroups: true, allowedPhases: ['frozen_recorded_partition_refs_v2', 'frozen_recorded_catalog_refs_v2'] },
  original_recorded_catalog_continue_refs_v2: { referencesV2: true, verifying: true, stockVerifying: true, identityVerifying: true,
    catalogingRecordedGroups: true, yieldingV2Progress: true, allowedPhases: ['frozen_recorded_partition_refs_v2', 'frozen_recorded_catalog_refs_v2'] },
  covered_recorded_catalog_continue_refs_v2: { referencesV2:true,verifying:true,stockVerifying:true,identityVerifying:true,
    catalogingRecordedGroups:true,yieldingV2Progress:true,coveredNeutralOriginals:true,
    allowedPhases:['frozen_recorded_partition_refs_v2','frozen_recorded_catalog_refs_v2'] },
  original_recorded_catalog_account_refs_v2: { referencesV2: true, verifying: true, stockVerifying: true, identityVerifying: true,
    readingStockAccountPackages: true, readingRecordedPartition: true, readingRecordedCatalog: true,
    allowedPhases: ['frozen_recorded_catalog_refs_v2'] },
  covered_recorded_catalog_account_refs_v2: { referencesV2:true,verifying:true,stockVerifying:true,identityVerifying:true,
    readingStockAccountPackages:true,readingRecordedPartition:true,readingRecordedCatalog:true,coveredNeutralOriginals:true,
    allowedPhases:['frozen_recorded_catalog_refs_v2'] },
  original_selection_workspace_target_refs_v2: { referencesV2: true, verifying: true, stockVerifying: true, identityVerifying: true,
    readingStockAccountPackages: true, readingRecordedPartition: true, readingRecordedCatalog: true,
    readingSelectionWorkspaceTarget: true, allowedPhases: ['frozen_recorded_catalog_refs_v2'] },
  original_catalog_selection_wait_refs_v2: { referencesV2: true, verifying: true, stockVerifying: true, identityVerifying: true,
    catalogingRecordedGroups: true, awaitingSelection: true, allowedPhases: ['frozen_recorded_catalog_refs_v2'] },
  covered_catalog_selection_wait_refs_v2: { referencesV2:true,verifying:true,stockVerifying:true,identityVerifying:true,
    catalogingRecordedGroups:true,awaitingSelection:true,coveredNeutralOriginals:true,allowedPhases:['frozen_recorded_catalog_refs_v2'] },
  original_catalog_selection_intent_refs_v2: { referencesV2: true, verifying: true, stockVerifying: true, identityVerifying: true,
    catalogingRecordedGroups: true, selectingCatalogIntent: true, allowedPhases: ['frozen_recorded_catalog_refs_v2'] },
  covered_catalog_selection_intent_refs_v2: { referencesV2:true,verifying:true,stockVerifying:true,identityVerifying:true,
    catalogingRecordedGroups:true,selectingCatalogIntent:true,coveredNeutralOriginals:true,allowedPhases:['frozen_recorded_catalog_refs_v2'] },
  original_retained_selection_intent_refs_v2: { referencesV2: true, verifying: true, stockVerifying: true, identityVerifying: true,
    catalogingRecordedGroups: true, readingRetainedSelectionIntent: true, allowedPhases: ['frozen_recorded_catalog_refs_v2'] },
  covered_retained_selection_intent_refs_v2: { referencesV2:true,verifying:true,stockVerifying:true,identityVerifying:true,
    catalogingRecordedGroups:true,readingRetainedSelectionIntent:true,coveredNeutralOriginals:true,allowedPhases:['frozen_recorded_catalog_refs_v2'] },
  original_selected_union_replay_refs_v2: { referencesV2: true, verifying: true, stockVerifying: true, identityVerifying: true,
    catalogingRecordedGroups: true, readingRecordedCatalog: true, replayingSelectedUnion: true,
    allowedPhases: ['frozen_recorded_catalog_refs_v2','frozen_selected_union_refs_v2'] },
  covered_selected_union_replay_refs_v2: { referencesV2:true,verifying:true,stockVerifying:true,identityVerifying:true,
    catalogingRecordedGroups:true,readingRecordedCatalog:true,replayingSelectedUnion:true,coveredNeutralOriginals:true,
    allowedPhases:['frozen_recorded_catalog_refs_v2','frozen_selected_union_refs_v2'] },
  original_selected_union_subject_housing_refs_v2: { referencesV2: true, verifying: true, stockVerifying: true, identityVerifying: true,
    catalogingRecordedGroups: true, readingRecordedCatalog: true, replayingSelectedUnion: true, readingSelectedUnionSubjectHousing: true,
    allowedPhases: ['frozen_selected_union_refs_v2'] },
  covered_selected_union_subject_housing_refs_v2: { referencesV2:true,verifying:true,stockVerifying:true,identityVerifying:true,
    catalogingRecordedGroups:true,readingRecordedCatalog:true,replayingSelectedUnion:true,readingSelectedUnionSubjectHousing:true,
    coveredNeutralOriginals:true,allowedPhases:['frozen_selected_union_refs_v2'] },
  original_selected_union_first_eligibility_refs_v2: { referencesV2: true, verifying: true, stockVerifying: true, identityVerifying: true,
    catalogingRecordedGroups: true, readingRecordedCatalog: true, replayingSelectedUnion: true,
    readingSelectedUnionSubjectHousing: true, readingSelectedUnionFirstEligibility: true,
    allowedPhases: ['frozen_selected_union_refs_v2'] },
  covered_selected_union_first_eligibility_refs_v2: { referencesV2:true,verifying:true,stockVerifying:true,identityVerifying:true,
    catalogingRecordedGroups:true,readingRecordedCatalog:true,replayingSelectedUnion:true,readingSelectedUnionSubjectHousing:true,
    readingSelectedUnionFirstEligibility:true,coveredNeutralOriginals:true,allowedPhases:['frozen_selected_union_refs_v2'] },
  original_selected_union_first_amenities_refs_v2: { referencesV2: true, verifying: true, stockVerifying: true, identityVerifying: true,
    catalogingRecordedGroups: true, readingRecordedCatalog: true, replayingSelectedUnion: true,
    readingSelectedUnionSubjectHousing: true, readingSelectedUnionFirstEligibility: true, readingSelectedUnionFirstAmenities: true,
    allowedPhases: ['frozen_selected_union_refs_v2'] },
  covered_selected_union_first_amenities_refs_v2: { referencesV2:true,verifying:true,stockVerifying:true,identityVerifying:true,
    catalogingRecordedGroups:true,readingRecordedCatalog:true,replayingSelectedUnion:true,
    readingSelectedUnionSubjectHousing:true,readingSelectedUnionFirstEligibility:true,readingSelectedUnionFirstAmenities:true,
    coveredNeutralOriginals:true,allowedPhases:['frozen_selected_union_refs_v2'] },
  original_selected_union_first_transactions_refs_v2: { referencesV2: true, verifying: true, stockVerifying: true, identityVerifying: true,
    catalogingRecordedGroups: true, readingRecordedCatalog: true, replayingSelectedUnion: true,
    readingSelectedUnionSubjectHousing: true, readingSelectedUnionFirstEligibility: true, readingSelectedUnionFirstTransactions: true,
    allowedPhases: ['frozen_selected_union_refs_v2'] },
  covered_selected_union_first_transactions_refs_v2: { referencesV2:true,verifying:true,stockVerifying:true,identityVerifying:true,
    catalogingRecordedGroups:true,readingRecordedCatalog:true,replayingSelectedUnion:true,
    readingSelectedUnionSubjectHousing:true,readingSelectedUnionFirstEligibility:true,readingSelectedUnionFirstTransactions:true,
    coveredNeutralOriginals:true,allowedPhases:['frozen_selected_union_refs_v2'] },
  original_selected_union_first_combined_refs_v2: { referencesV2: true, verifying: true, stockVerifying: true, identityVerifying: true,
    catalogingRecordedGroups: true, readingRecordedCatalog: true, replayingSelectedUnion: true,
    readingSelectedUnionSubjectHousing: true, readingSelectedUnionFirstEligibility: true,
    readingSelectedUnionFirstAmenities: true, readingSelectedUnionFirstTransactions: true,
    allowedPhases: ['frozen_selected_union_refs_v2'] },
  original_selected_eligibility_progress_refs_v2: { referencesV2: true, verifying: true, stockVerifying: true, identityVerifying: true,
    catalogingRecordedGroups: true, readingRecordedCatalog: true, replayingSelectedUnion: true,
    readingSelectedUnionSubjectHousing: true, readingSelectedUnionFirstEligibility: true, progressingSelectedEligibility: true,
    allowedPhases: ['frozen_selected_union_refs_v2','frozen_selected_eligibility_refs_v2'] },
  covered_selected_eligibility_progress_refs_v2: { referencesV2:true,verifying:true,stockVerifying:true,identityVerifying:true,
    catalogingRecordedGroups:true,readingRecordedCatalog:true,replayingSelectedUnion:true,readingSelectedUnionSubjectHousing:true,
    readingSelectedUnionFirstEligibility:true,progressingSelectedEligibility:true,coveredNeutralOriginals:true,
    allowedPhases:['frozen_selected_union_refs_v2','frozen_selected_eligibility_refs_v2'] },
  original_selected_evidence_progress_refs_v2: { referencesV2: true, verifying: true, stockVerifying: true, identityVerifying: true,
    catalogingRecordedGroups: true, readingRecordedCatalog: true, replayingSelectedUnion: true,
    readingSelectedUnionSubjectHousing: true, readingSelectedUnionFirstEligibility: true,
    readingSelectedUnionFirstAmenities: true, readingSelectedUnionFirstTransactions: true, progressingSelectedEvidence: true,
    allowedPhases: ['frozen_selected_eligibility_refs_v2','frozen_selected_evidence_refs_v2'] },
  covered_selected_evidence_progress_refs_v2: { referencesV2:true,verifying:true,stockVerifying:true,identityVerifying:true,
    catalogingRecordedGroups:true,readingRecordedCatalog:true,replayingSelectedUnion:true,
    readingSelectedUnionSubjectHousing:true,readingSelectedUnionFirstEligibility:true,
    readingSelectedUnionFirstAmenities:true,readingSelectedUnionFirstTransactions:true,progressingSelectedEvidence:true,
    coveredNeutralOriginals:true,allowedPhases:['frozen_selected_eligibility_refs_v2','frozen_selected_evidence_refs_v2'] },
  original_selected_first_metric_refs_v2: { referencesV2: true, verifying: true, stockVerifying: true, identityVerifying: true,
    catalogingRecordedGroups: true, readingRecordedCatalog: true, replayingSelectedUnion: true,
    readingSelectedUnionSubjectHousing: true, readingSelectedUnionFirstEligibility: true,
    readingSelectedUnionFirstAmenities: true, readingSelectedUnionFirstTransactions: true, readingSelectedMetricSource: true,
    allowedPhases: ['frozen_selected_evidence_refs_v2'] },
  original_selected_metrics_progress_refs_v2: { referencesV2: true, verifying: true, stockVerifying: true, identityVerifying: true,
    catalogingRecordedGroups: true, readingRecordedCatalog: true, replayingSelectedUnion: true,
    readingSelectedUnionSubjectHousing: true, readingSelectedUnionFirstEligibility: true,
    readingSelectedUnionFirstAmenities: true, readingSelectedUnionFirstTransactions: true, readingSelectedMetricSource: true,
    progressingSelectedMetrics: true, allowedPhases: ['frozen_selected_evidence_refs_v2','frozen_selected_metrics_refs_v2'] },
  covered_selected_metrics_progress_refs_v2: { referencesV2:true,verifying:true,stockVerifying:true,identityVerifying:true,
    catalogingRecordedGroups:true,readingRecordedCatalog:true,replayingSelectedUnion:true,
    readingSelectedUnionSubjectHousing:true,readingSelectedUnionFirstEligibility:true,
    readingSelectedUnionFirstAmenities:true,readingSelectedUnionFirstTransactions:true,readingSelectedMetricSource:true,
    progressingSelectedMetrics:true,coveredNeutralOriginals:true,
    allowedPhases:['frozen_selected_evidence_refs_v2','frozen_selected_metrics_refs_v2'] },
  original_selected_first_statistics_refs_v2: { referencesV2: true, verifying: true, stockVerifying: true, identityVerifying: true,
    catalogingRecordedGroups: true, readingRecordedCatalog: true, replayingSelectedUnion: true,
    readingSelectedUnionSubjectHousing: true, readingSelectedUnionFirstEligibility: true,
    readingSelectedUnionFirstAmenities: true, readingSelectedUnionFirstTransactions: true, readingSelectedMetricSource: true,
    readingSelectedStatisticsSource: true, allowedPhases: ['frozen_selected_metrics_refs_v2'] },
  original_selected_statistics_progress_refs_v2: { referencesV2: true, verifying: true, stockVerifying: true, identityVerifying: true,
    catalogingRecordedGroups: true, readingRecordedCatalog: true, replayingSelectedUnion: true,
    readingSelectedUnionSubjectHousing: true, readingSelectedUnionFirstEligibility: true,
    readingSelectedUnionFirstAmenities: true, readingSelectedUnionFirstTransactions: true, readingSelectedMetricSource: true,
    readingSelectedStatisticsSource: true, progressingSelectedStatistics: true,
    allowedPhases: ['frozen_selected_metrics_refs_v2','frozen_selected_statistics_refs_v2'] },
  covered_selected_statistics_progress_refs_v2: { referencesV2:true,verifying:true,stockVerifying:true,identityVerifying:true,
    catalogingRecordedGroups:true,readingRecordedCatalog:true,replayingSelectedUnion:true,
    readingSelectedUnionSubjectHousing:true,readingSelectedUnionFirstEligibility:true,
    readingSelectedUnionFirstAmenities:true,readingSelectedUnionFirstTransactions:true,readingSelectedMetricSource:true,
    readingSelectedStatisticsSource:true,progressingSelectedStatistics:true,coveredNeutralOriginals:true,
    allowedPhases:['frozen_selected_metrics_refs_v2','frozen_selected_statistics_refs_v2'] },
  original_selected_first_frequency_refs_v2: { referencesV2: true, verifying: true, stockVerifying: true, identityVerifying: true,
    catalogingRecordedGroups: true, readingRecordedCatalog: true, replayingSelectedUnion: true,
    readingSelectedUnionSubjectHousing: true, readingSelectedUnionFirstEligibility: true,
    readingSelectedUnionFirstAmenities: true, readingSelectedUnionFirstTransactions: true, readingSelectedMetricSource: true,
    readingSelectedStatisticsSource: true, readingSelectedFrequencySource: true, allowedPhases: ['frozen_selected_statistics_refs_v2'] },
  original_selected_numeric_progress_refs_v2: { referencesV2: true, verifying: true, stockVerifying: true, identityVerifying: true,
    catalogingRecordedGroups: true, readingRecordedCatalog: true, replayingSelectedUnion: true,
    readingSelectedUnionSubjectHousing: true, readingSelectedUnionFirstEligibility: true,
    readingSelectedUnionFirstAmenities: true, readingSelectedUnionFirstTransactions: true, readingSelectedMetricSource: true,
    readingSelectedStatisticsSource: true, readingSelectedFrequencySource: true, readingSelectedNumericSource: true,
    progressingSelectedNumeric: true, allowedPhases: ['frozen_selected_statistics_refs_v2','frozen_selected_numeric_refs_v2'] },
  covered_selected_numeric_progress_refs_v2: { referencesV2:true,verifying:true,stockVerifying:true,identityVerifying:true,
    catalogingRecordedGroups:true,readingRecordedCatalog:true,replayingSelectedUnion:true,
    readingSelectedUnionSubjectHousing:true,readingSelectedUnionFirstEligibility:true,
    readingSelectedUnionFirstAmenities:true,readingSelectedUnionFirstTransactions:true,readingSelectedMetricSource:true,
    readingSelectedStatisticsSource:true,readingSelectedFrequencySource:true,readingSelectedNumericSource:true,
    progressingSelectedNumeric:true,coveredNeutralOriginals:true,
    allowedPhases:['frozen_selected_statistics_refs_v2','frozen_selected_numeric_refs_v2'] },
  original_selected_transaction_source_refs_v2: { referencesV2: true, verifying: true, stockVerifying: true, identityVerifying: true,
    catalogingRecordedGroups: true, readingRecordedCatalog: true, replayingSelectedUnion: true,
    readingSelectedUnionSubjectHousing: true, readingSelectedUnionFirstEligibility: true,
    readingSelectedUnionFirstAmenities: true, readingSelectedUnionFirstTransactions: true, readingSelectedMetricSource: true,
    readingSelectedStatisticsSource: true, readingSelectedFrequencySource: true, readingSelectedNumericSource: true,
    progressingSelectedSemantic: true, readingSelectedTransactionSource: true, allowedPhases: ['frozen_selected_semantic_refs_v2'] },
  original_selected_transaction_first_candidate_refs_v2: { referencesV2: true, verifying: true, stockVerifying: true, identityVerifying: true,
    catalogingRecordedGroups: true, readingRecordedCatalog: true, replayingSelectedUnion: true,
    readingSelectedUnionSubjectHousing: true, readingSelectedUnionFirstEligibility: true,
    readingSelectedUnionFirstAmenities: true, readingSelectedUnionFirstTransactions: true, readingSelectedMetricSource: true,
    readingSelectedStatisticsSource: true, readingSelectedFrequencySource: true, readingSelectedNumericSource: true,
    progressingSelectedSemantic: true, readingSelectedTransactionSource: true, preparingSelectedTransactionFirstCandidate: true,
    allowedPhases: ['frozen_selected_semantic_refs_v2'] },
  original_selected_transaction_index_source_refs_v2: { referencesV2: true, verifying: true, stockVerifying: true, identityVerifying: true,
    catalogingRecordedGroups: true, readingRecordedCatalog: true, replayingSelectedUnion: true,
    readingSelectedUnionSubjectHousing: true, readingSelectedUnionFirstEligibility: true,
    readingSelectedUnionFirstAmenities: true, readingSelectedUnionFirstTransactions: true, readingSelectedMetricSource: true,
    readingSelectedStatisticsSource: true, readingSelectedFrequencySource: true, readingSelectedNumericSource: true,
    progressingSelectedSemantic: true, readingSelectedTransactionSource: true, readingSelectedTransactionIndex: true,
    allowedPhases: ['frozen_selected_semantic_refs_v2','frozen_selected_transaction_index_refs_v2'] },
  original_selected_transaction_index_progress_refs_v2: { referencesV2: true, verifying: true, stockVerifying: true, identityVerifying: true,
    catalogingRecordedGroups: true, readingRecordedCatalog: true, replayingSelectedUnion: true,
    readingSelectedUnionSubjectHousing: true, readingSelectedUnionFirstEligibility: true,
    readingSelectedUnionFirstAmenities: true, readingSelectedUnionFirstTransactions: true, readingSelectedMetricSource: true,
    readingSelectedStatisticsSource: true, readingSelectedFrequencySource: true, readingSelectedNumericSource: true,
    progressingSelectedSemantic: true, readingSelectedTransactionSource: true, readingSelectedTransactionIndex: true,
    progressingSelectedTransactionIndex: true,
    allowedPhases: ['frozen_selected_semantic_refs_v2','frozen_selected_transaction_index_refs_v2'] },
  original_selected_semantic_progress_refs_v2: { referencesV2: true, verifying: true, stockVerifying: true, identityVerifying: true,
    catalogingRecordedGroups: true, readingRecordedCatalog: true, replayingSelectedUnion: true,
    readingSelectedUnionSubjectHousing: true, readingSelectedUnionFirstEligibility: true,
    readingSelectedUnionFirstAmenities: true, readingSelectedUnionFirstTransactions: true, readingSelectedMetricSource: true,
    readingSelectedStatisticsSource: true, readingSelectedFrequencySource: true, readingSelectedNumericSource: true,
    progressingSelectedSemantic: true, allowedPhases: ['frozen_selected_numeric_refs_v2','frozen_selected_semantic_refs_v2'] },
  covered_selected_semantic_progress_refs_v2: { referencesV2:true,verifying:true,stockVerifying:true,identityVerifying:true,
    catalogingRecordedGroups:true,readingRecordedCatalog:true,replayingSelectedUnion:true,
    readingSelectedUnionSubjectHousing:true,readingSelectedUnionFirstEligibility:true,
    readingSelectedUnionFirstAmenities:true,readingSelectedUnionFirstTransactions:true,readingSelectedMetricSource:true,
    readingSelectedStatisticsSource:true,readingSelectedFrequencySource:true,readingSelectedNumericSource:true,
    progressingSelectedSemantic:true,coveredNeutralOriginals:true,
    allowedPhases:['frozen_selected_numeric_refs_v2','frozen_selected_semantic_refs_v2'] },
  covered_selected_transaction_index_progress_refs_v2: { referencesV2:true,verifying:true,stockVerifying:true,identityVerifying:true,
    catalogingRecordedGroups:true,readingRecordedCatalog:true,replayingSelectedUnion:true,
    readingSelectedUnionSubjectHousing:true,readingSelectedUnionFirstEligibility:true,
    readingSelectedUnionFirstAmenities:true,readingSelectedUnionFirstTransactions:true,readingSelectedMetricSource:true,
    readingSelectedStatisticsSource:true,readingSelectedFrequencySource:true,readingSelectedNumericSource:true,
    progressingSelectedSemantic:true,readingSelectedTransactionSource:true,readingSelectedTransactionIndex:true,
    progressingSelectedTransactionIndex:true,coveredNeutralOriginals:true,
    allowedPhases:['frozen_selected_semantic_refs_v2','frozen_selected_transaction_index_refs_v2'] },
  original_selected_first_indexed_refs_v2: { referencesV2: true, verifying: true, stockVerifying: true, identityVerifying: true,
    catalogingRecordedGroups: true, readingRecordedCatalog: true, replayingSelectedUnion: true,
    readingSelectedUnionSubjectHousing: true, readingSelectedUnionFirstEligibility: true,
    readingSelectedUnionFirstAmenities: true, readingSelectedUnionFirstTransactions: true, readingSelectedMetricSource: true,
    readingSelectedStatisticsSource: true, readingSelectedFrequencySource: true, readingSelectedNumericSource: true,
    allowedPhases: ['frozen_selected_statistics_refs_v2'] },
  original_selected_first_rank_candidates_refs_v2: { referencesV2: true, verifying: true, stockVerifying: true, identityVerifying: true,
    catalogingRecordedGroups: true, readingRecordedCatalog: true, replayingSelectedUnion: true,
    readingSelectedUnionSubjectHousing: true, readingSelectedUnionFirstEligibility: true,
    readingSelectedUnionFirstAmenities: true, readingSelectedUnionFirstTransactions: true, readingSelectedMetricSource: true,
    readingSelectedStatisticsSource: true, readingSelectedFrequencySource: true, readingSelectedNumericSource: true,
    readingSelectedRankCandidates: true, allowedPhases: ['frozen_selected_numeric_refs_v2'] },
});
function fail(reason, detail, captureCounts) {
  const error = Object.assign(new Error(`custom_cohort_capture_${reason}`), {
    code: 'CUSTOM_COHORT_CAPTURE_FAILED', reason, ...(detail ? { detail } : {}),
    ...(captureCounts ? { capture_counts: captureCounts } : {}),
  });
  if (reason === 'deadline_exceeded' || reason === 'cancelled') OWNER_INTERRUPTION_REASONS.set(error, reason);
  throw error;
}
function exactKeys(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) fail('invalid_input');
}
function identityOf(input) {
  const { accountId, assignmentFileId } = input;
  if (typeof accountId !== 'string' || !accountId || accountId.length > 64 || accountId.trim() !== accountId
    || /[\u0000-\u001f\u007f]/.test(accountId)) fail('invalid_account');
  if (typeof assignmentFileId !== 'string' || !/^[1-9]\d{0,18}$/.test(assignmentFileId)
    || BigInt(assignmentFileId) > 9223372036854775807n) fail('invalid_assignment');
  if (typeof input.auth?.userId !== 'string' || !input.auth.userId.trim()) fail('authentication_required');
  // Admit/copy only the existing authorization policy's fields before awaiting.
  const auth = JSON.parse(canonicalAssessmentJson({ userId: input.auth.userId,
    organizations: input.auth.organizations ?? [] }));
  return freeze({ auth, accountId, assignmentFileId });
}
function inputOf(input) {
  // This is an internal service. The HTTP owner must supply its authenticated
  // principal separately from body fields; no body-auth or source-roster API.
  const hasPrivate = Object.hasOwn(input, 'privateSalesImport');
  const hasDiscovery = Object.hasOwn(input, 'discovery');
  exactKeys(input, ['auth', 'accountId', 'assignmentFileId', 'operationId', 'observationPeriod',
    ...(hasPrivate ? ['privateSalesImport'] : []), ...(hasDiscovery ? ['discovery'] : [])]);
  const identity = identityOf(input), { operationId } = input;
  if (typeof operationId !== 'string' || !UUID.test(operationId)) fail('invalid_operation');
  exactKeys(input.observationPeriod, ['start_date', 'end_date']);
  const period = Object.fromEntries(Object.entries(input.observationPeriod).map(([key, value]) => [key, assessmentDate(value)]));
  if (period.start_date > period.end_date) fail('invalid_period');
  let privateSalesImport;
  let discovery;
  if (hasDiscovery) {
    try { discovery = prepareNeighborhoodDiscoveryChoice(input.discovery); }
    catch { fail('invalid_discovery'); }
  }
  if (hasPrivate) {
    try {
      const purpose = customNeighborhoodPrivateSalesPurpose(input.privateSalesImport);
      privateSalesImport = { batch_id: purpose.batch_id, expected_review_revision: purpose.expected_review_revision };
    } catch { fail('invalid_private_sales_import'); }
  }
  return freeze({ ...identity, operationId, observationPeriod: period,
    ...(hasPrivate ? { privateSalesImport } : {}), ...(hasDiscovery ? { discovery } : {}) });
}
function captureJobInputOf(input) {
  exactKeys(input, ['auth', 'accountId', 'assignmentFileId', 'operationId']);
  const identity = identityOf(input);
  if (typeof input.operationId !== 'string' || !UUID.test(input.operationId)) fail('invalid_operation');
  return freeze({ ...identity, operationId: input.operationId });
}
function previewInputOf(input) {
  exactKeys(input, ['auth', 'accountId', 'assignmentFileId', 'contextRef', 'selection']);
  const identity = identityOf(input);
  const contextRef = prepareCustomCohortContextReference(canonicalAssessmentJson(input.contextRef));
  // Detach the bounded selection before any await; changing a caller's object
  // while evidence loads must not change which map/statistics pair is returned.
  const selection = JSON.parse(canonicalAssessmentJson(input.selection));
  exactKeys(selection, ['revision', 'pockets']);
  if (!Number.isSafeInteger(selection.revision) || selection.revision < 1
    || !Array.isArray(selection.pockets) || selection.pockets.length > CUSTOM_COHORT_OBSERVATION_PREVIEW_LIMITS.pockets) fail('invalid_selection');
  return freeze({ ...identity, contextRef, selection });
}
function reviewInputOf(input) {
  exactKeys(input, ['auth', 'accountId', 'assignmentFileId', 'commandJson']);
  const identity = identityOf(input);
  const admitted = prepareCohortDecisionCommandV1(input.commandJson);
  if (admitted.status !== 'syntax_valid' || admitted.command.target_ref.workflow_type !== 'custom_appraisal'
    || admitted.command.target_ref.workflow_target_id !== identity.assignmentFileId) fail('invalid_review_command');
  return freeze({ ...identity, commandJson: input.commandJson, command: admitted.command });
}
function reviewedInputsInputOf(input) {
  exactKeys(input, ['auth', 'accountId', 'assignmentFileId', 'contextRef',
    'expectedWorkspaceRevision', 'expectedReviewGeneration']);
  const identity = identityOf(input);
  const contextRef = prepareCustomCohortContextReference(canonicalAssessmentJson(input.contextRef));
  const { expectedWorkspaceRevision, expectedReviewGeneration } = input;
  if (!Number.isInteger(expectedWorkspaceRevision) || expectedWorkspaceRevision < 1
    || expectedWorkspaceRevision > 2_147_483_647
    || typeof expectedReviewGeneration !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(expectedReviewGeneration)
    || BigInt(expectedReviewGeneration) > 9223372036854775807n) fail('invalid_reviewed_input_revision');
  return freeze({ ...identity, contextRef, expectedWorkspaceRevision, expectedReviewGeneration });
}
function reportedInputOf(value, applying = false) {
  if (utilTypes.isProxy(value)) fail('invalid_reported_input');
  const replacing = value && Object.hasOwn(value, 'replacement');
  exactKeys(value, ['auth', 'accountId', 'assignmentFileId', 'contextRef', 'expectedWorkspaceRevision',
    'expectedEditorRevision', 'operationId', ...(applying ? ['proposalOperationId', 'attachmentId',
      'attachmentRevision', 'bindingDigest', 'adopt'] : []), ...(replacing ? ['replacement'] : [])]);
  const identity = identityOf(value);
  const input = { ...identity, contextRef: prepareCustomCohortContextReference(canonicalAssessmentJson(value.contextRef)),
    expectedWorkspaceRevision: value.expectedWorkspaceRevision, expectedEditorRevision: value.expectedEditorRevision,
    operationId: value.operationId };
  if (!Number.isInteger(input.expectedWorkspaceRevision) || input.expectedWorkspaceRevision < 1
    || input.expectedWorkspaceRevision > 2147483647 || !Number.isInteger(input.expectedEditorRevision)
    || input.expectedEditorRevision < 0 || input.expectedEditorRevision >= 2147483647
    || typeof input.operationId !== 'string' || !UUID.test(input.operationId)
    || !UUID.test(identity.auth.userId) || BigInt(identity.assignmentFileId) > BigInt(Number.MAX_SAFE_INTEGER)) fail('invalid_reported_input');
  if (applying) {
    if (value.adopt !== true || typeof value.proposalOperationId !== 'string' || !UUID.test(value.proposalOperationId)
      || typeof value.attachmentId !== 'string' || !UUID.test(value.attachmentId)
      || !Number.isInteger(value.attachmentRevision) || value.attachmentRevision < 1 || value.attachmentRevision > 2147483647
      || typeof value.bindingDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.bindingDigest)) fail('invalid_reported_input');
    Object.assign(input, { proposalOperationId: value.proposalOperationId, attachmentId: value.attachmentId,
      attachmentRevision: value.attachmentRevision, bindingDigest: value.bindingDigest, adopt: true });
  }
  if (replacing) {
    try {
      const dataObject = (raw, keys) => {
        if (!raw || utilTypes.isProxy(raw) || Object.getPrototypeOf(raw) !== Object.prototype) fail('invalid_reported_input');
        const descriptors = Object.getOwnPropertyDescriptors(raw);
        if (Reflect.ownKeys(descriptors).length !== keys.length
          || !keys.every(key => Object.hasOwn(descriptors, key) && Object.hasOwn(descriptors[key], 'value')
            && descriptors[key].enumerable)) fail('invalid_reported_input');
        return Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
      };
      const supplied = Object.getOwnPropertyDescriptor(value, 'replacement');
      if (!supplied || !Object.hasOwn(supplied, 'value')) fail('invalid_reported_input');
      const replacement = dataObject(supplied.value, applying ? ['kind', 'predecessor'] : ['kind']);
      if (replacement.kind !== 'accepted_custom_reported_group') fail('invalid_reported_input');
      if (applying) {
        replacement.predecessor = dataObject(replacement.predecessor,
          ['acceptance_id', 'operation_id', 'accepted_editor_revision', 'section_value_sha256']);
        const p = replacement.predecessor;
        if (typeof p.acceptance_id !== 'string' || !UUID.test(p.acceptance_id)
          || typeof p.operation_id !== 'string' || !UUID.test(p.operation_id)
          || !Number.isInteger(p.accepted_editor_revision) || p.accepted_editor_revision < 1 || p.accepted_editor_revision >= 2147483647
          || typeof p.section_value_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(p.section_value_sha256)) fail('invalid_reported_input');
      }
      input.replacement = replacement;
    } catch { fail('invalid_reported_input'); }
  }
  return freeze(input);
}
function one(result) {
  if (result?.rowCount !== 1 || !Array.isArray(result.rows) || result.rows.length !== 1) fail('target_unavailable');
  return result.rows[0];
}
async function databaseTime(client) {
  const value = one(await client.query(`/* custom-cohort-capture:time */
    SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS value`)).value;
  if (!TIMESTAMP.test(value ?? '')) fail('database_time_unavailable');
  return value;
}

async function savedWorkspace(client, input) {
  // Existing saves/signing lock this parent before changing any section. Do not
  // call getCustomAppraisalWorkfile: that can create rows and use another pool
  // connection. Missing/invalid saved intent must never become broad defaults.
  const file = await client.query(`/* custom-cohort-capture:workspace-parent */
    SELECT assignment_file_id::text FROM app.custom_appraisal_workfiles
    WHERE assignment_file_id=$1::bigint FOR SHARE NOWAIT`, [input.assignmentFileId]);
  if (file?.rowCount !== 1 || file.rows?.length !== 1
    || file.rows[0].assignment_file_id !== input.assignmentFileId) fail('workspace_unavailable');
  const result = await client.query(`/* custom-cohort-capture:workspace */
    SELECT revision, CASE WHEN octet_length(section_value::text) <= $3::integer
      THEN section_value ELSE NULL END AS value
    FROM app.custom_appraisal_workfile_sections
    WHERE assignment_file_id=$1::bigint AND section_key=$2 FOR SHARE NOWAIT`,
  [input.assignmentFileId, CUSTOM_NEIGHBORHOOD_WORKSPACE_SECTION,
    // JSONB's spaces are not the checkpoint's canonical representation. Bound
    // transport generously, then apply each saved version's exact canonical limit.
    CUSTOM_NEIGHBORHOOD_DENSE_WORKSPACE_CHECKPOINT_LIMITS.canonical_utf8_bytes * 2]);
  if (result?.rowCount !== 1 || result.rows?.length !== 1) fail('workspace_unavailable');
  const restored = readCustomNeighborhoodWorkspaceCheckpoint(result.rows[0]);
  if (restored.status !== 'restored' || restored.checkpoint.active === null) fail('workspace_unavailable');
  if (restored.section_revision !== input.expectedWorkspaceRevision
    || !same(restored.checkpoint.active.context_ref, input.contextRef)) fail('workspace_changed');
  if (restored.checkpoint.pending_capture !== null) fail('workspace_capture_pending');
  return restored;
}

async function reportEditorState(client, input) {
  // The already-held workfile parent lock protects the absent-row case. Read
  // the actual reserved section, NOT the workspace/checkpoint revision. Only a
  // bounded hash crosses this boundary; existing accepted contents stay private.
  const result = await client.query(`/* custom-cohort-capture:report-editor */
    SELECT revision, CASE WHEN octet_length(section_value::text) <= 4000000
      THEN encode(sha256(convert_to(section_value::text,'UTF8')),'hex') ELSE NULL END AS value_sha256
    FROM app.custom_appraisal_workfile_sections
    WHERE assignment_file_id=$1::bigint AND section_key=$2 FOR SHARE NOWAIT`,
  [input.assignmentFileId, CUSTOM_NEIGHBORHOOD_ACCEPTED_SECTION]);
  if (result?.rowCount === 0 && result.rows?.length === 0) return { editor_revision: 0, value_sha256: null };
  if (result?.rowCount !== 1 || result.rows?.length !== 1) fail('report_editor_unavailable');
  const row = result.rows[0];
  if (!Number.isInteger(row.revision) || row.revision < 1 || row.revision > 2_147_483_647
    || typeof row.value_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.value_sha256)) fail('report_editor_unavailable');
  return { editor_revision: row.revision, value_sha256: row.value_sha256 };
}

async function reportGeographyState(client, input) {
  // resolveTarget already holds this exact assignment row. Select only saved
  // narrative-boundary fields, preserving missing keys versus explicit JSON null.
  // Neither the account-level fallback nor unrelated client/contract data enters
  // this capture. Meter the projection in PostgreSQL before sending any text.
  const row = one(await client.query(`/* custom-cohort-capture:report-geography */
    WITH projected AS MATERIALIZED (
      SELECT id::text AS assignment_file_id,account_id,revision AS assignment_revision,
        CASE WHEN assignment_details IS NULL THEN 'sql_null' ELSE jsonb_typeof(assignment_details) END AS details_type,
        CASE WHEN jsonb_typeof(assignment_details)='object' THEN (
          SELECT COALESCE(jsonb_object_agg(key,value),'{}'::jsonb)
          FROM jsonb_each(CASE WHEN jsonb_typeof(assignment_details)='object' THEN assignment_details ELSE '{}'::jsonb END)
          WHERE key=ANY($3::text[])) ELSE NULL END AS fields
      FROM app.assignment_files WHERE id=$1::bigint AND account_id=$2
    ) SELECT assignment_file_id,account_id,assignment_revision,details_type,
      octet_length(fields::text) AS projected_utf8_bytes,
      CASE WHEN octet_length(fields::text)<=$4::integer
        THEN encode(sha256(convert_to(fields::text,'UTF8')),'hex') ELSE NULL END AS projected_sha256,
      CASE WHEN octet_length(fields::text)<=$4::integer THEN fields::text ELSE NULL END AS projected_json
    FROM projected`, [input.assignmentFileId, input.accountId, CUSTOM_COHORT_REPORT_GEOGRAPHY_FIELDS,
    CUSTOM_COHORT_REPORT_GEOGRAPHY_LIMITS.projected_utf8_bytes]));
  if (row.assignment_file_id !== input.assignmentFileId || row.account_id !== input.accountId) fail('report_geography_unavailable');
  return { assignment_revision: row.assignment_revision, projection: { details_type: row.details_type,
    projected_utf8_bytes: row.projected_utf8_bytes, projected_sha256: row.projected_sha256, projected_json: row.projected_json } };
}
async function reportGeometryTopology(client, geometry, point) {
  // Only the pure module's bounded structural Polygon admission reaches PostGIS.
  // Validate exactly those saved coordinates; never ST_MakeValid, snap or repair.
  // The point is represented from the SAME retained subject snapshot used for
  // discovery, not a mutable account location, browser input or geocoder result.
  // Keep border coverage distinct from strict interior containment. Do not run
  // spatial predicates on invalid geometry (including self-intersections).
  return one(await client.query(`/* custom-cohort-capture:report-geography-topology */
    WITH supplied AS MATERIALIZED (SELECT ST_SetSRID(ST_GeomFromGeoJSON($1::jsonb),4326) AS geom),
    checked AS MATERIALIZED (SELECT geom,ST_IsValid(geom) AS is_valid,
      ST_IsValidReason(geom) AS validation_reason,ST_GeometryType(geom) AS geometry_type,
      ST_IsEmpty(geom) AS is_empty,ST_NumGeometries(geom) AS component_count FROM supplied)
    SELECT is_valid,validation_reason,geometry_type,is_empty,component_count,
      postgis_lib_version() AS postgis_version,
      CASE WHEN is_valid AND NOT is_empty AND geometry_type='ST_Polygon' AND component_count=1
        AND $2::double precision IS NOT NULL AND $3::double precision IS NOT NULL
        THEN ST_Covers(geom,ST_SetSRID(ST_MakePoint($2::double precision,$3::double precision),4326))
        ELSE NULL END AS covers_recorded_subject_point,
      CASE WHEN is_valid AND NOT is_empty AND geometry_type='ST_Polygon' AND component_count=1
        AND $2::double precision IS NOT NULL AND $3::double precision IS NOT NULL
        THEN ST_Contains(geom,ST_SetSRID(ST_MakePoint($2::double precision,$3::double precision),4326))
        ELSE NULL END AS contains_recorded_subject_point FROM checked`,
    [canonicalAssessmentJson(geometry), point?.coordinates[0] ?? null, point?.coordinates[1] ?? null]));
}

function operationBudget(options = {}, durationMs = LIMITS.duration_ms) {
  if (!options || Object.getPrototypeOf(options) !== Object.prototype
    || Object.keys(options).some(key => !['signal', 'deadline'].includes(key))
    || (options.signal !== undefined && !(options.signal instanceof AbortSignal))
    || (options.deadline !== undefined && !Number.isFinite(options.deadline))) fail('invalid_options');
  const finalDeadline = Math.min(performance.now() + durationMs, options.deadline ?? Infinity);
  const deadline = finalDeadline - LIMITS.cleanup_ms;
  const check = () => {
    if (options.signal?.aborted) fail('cancelled');
    if (performance.now() >= deadline) fail('deadline_exceeded');
  };
  const remaining = maximum => { check(); return Math.max(1, Math.min(maximum, Math.ceil(deadline - performance.now()))); };
  return { check, remaining, deadline, signal: options.signal };
}

async function connect(pool, budget) {
  const timeout = budget.remaining(LIMITS.connect_ms);
  return new Promise((resolve, reject) => {
    let finished = false;
    const cleanup = () => { clearTimeout(timer); budget.signal?.removeEventListener('abort', aborted); };
    const rejectOnce = reason => {
      if (finished) return;
      finished = true; cleanup();
      try { fail(reason); } catch (error) { reject(error); }
    };
    const aborted = () => rejectOnce('cancelled');
    const timer = setTimeout(() => rejectOnce('connection_timeout'), timeout);
    budget.signal?.addEventListener('abort', aborted, { once: true });
    // A late connection is released exactly once rather than abandoned in the
    // pool. A failed connect never enters transaction cleanup with no client.
    Promise.resolve().then(() => pool.connect()).then(client => {
      if (finished) {
        try { client.release(new Error('custom_cohort_late_connection')); } catch { /* Already failed; do not create an unhandled late rejection. */ }
        return;
      }
      finished = true; cleanup(); resolve(client);
    }, error => { if (!finished) { finished = true; cleanup(); reject(error); } });
    if (budget.signal?.aborted) aborted();
  });
}

async function transaction(pool, mode, budget, execute) {
  budget.check();
  const raw = await connect(pool, budget);
  let open = false, closed = false, discard = null, connectionError = null, commitAttempted = false, outcomeUnknown = false;
  // A checked-out pg client can emit a socket/idle-timeout error while pure
  // work runs between queries. Own that event until release; never allow an
  // unhandled EventEmitter error to terminate the web process.
  const connectionFailed = error => { connectionError ||= error; discard ||= error; };
  raw.on?.('error', connectionFailed);
  const client = Object.freeze({
    query: async (sql, values) => {
      if (closed) fail('closed_operation');
      // A failed statement still permits the owner's savepoint cleanup; a
      // socket error does not. Both cause this connection to be discarded.
      if (connectionError) throw connectionError;
      budget.check();
      const config = typeof sql === 'string' ? { text: sql, values } : { ...sql };
      config.query_timeout = Math.min(config.query_timeout ?? LIMITS.query_ms, budget.remaining(LIMITS.query_ms));
      try { const result = await raw.query(config); if (connectionError) throw connectionError; budget.check(); return result; }
      catch (error) {
        discard = error;
        // A driver timeout can win the race with the aggregate clock. Classify
        // from our own deadline/signal, never from private driver error text.
        budget.check();
        throw error;
      }
    },
    release() { fail('transaction_owner_required'); },
  });
  try {
    open = true; // BEGIN timeout leaves uncertain state too.
    await client.query(`BEGIN ISOLATION LEVEL ${mode}`);
    await client.query("SET LOCAL statement_timeout='5000ms'; SET LOCAL lock_timeout='1000ms'; SET LOCAL idle_in_transaction_session_timeout='10000ms'; SET LOCAL timezone='UTC'; SET LOCAL jit=off");
    const result = await execute(client);
    if (discard) throw discard;
    budget.check(); commitAttempted = true;
    await client.query('COMMIT'); open = false;
    return result;
  } catch (error) {
    if (commitAttempted) {
      // A rejected COMMIT does not prove rollback. The operation UUID permits
      // a later authorized lookup of the immutable context; never blind retry.
      discard ||= error;
      throw Object.assign(error, { outcome_unknown: true });
    }
    const cleanupFailure = neighborhoodCallerCleanupFailure(error);
    outcomeUnknown = Boolean(error?.outcome_unknown || cleanupFailure?.primary?.outcome_unknown
      || cleanupFailure?.cleanup?.outcome_unknown);
    if (open && !discard) {
      try { await raw.query({ text: 'ROLLBACK', query_timeout: LIMITS.cleanup_ms }); }
      catch (rollbackError) { discard = rollbackError; }
    }
    // Only after the existing outer cleanup/discard decision, preserve a typed
    // owner interruption hidden by our repository's failed savepoint cleanup.
    // Keep the aggregate and both children; never inspect arbitrary wrappers.
    if (outcomeUnknown) Object.assign(error, { outcome_unknown: true });
    else if (cleanupFailure) {
      const primary = cleanupFailure.primary, reason = OWNER_INTERRUPTION_REASONS.get(primary);
      if (reason && primary.code === 'CUSTOM_COHORT_CAPTURE_FAILED' && primary.reason === reason) {
        Object.assign(error, { code: primary.code, reason });
      }
    }
    throw error;
  } finally {
    closed = true;
    try { raw.release(discard || undefined); }
    catch (releaseError) {
      if (commitAttempted || outcomeUnknown) throw Object.assign(releaseError, { outcome_unknown: true });
      throw releaseError;
    }
    finally { raw.off?.('error', connectionFailed); }
  }
}

async function resolveTarget(client, input, locked, permission = 'write', lockReport = false) {
  const assignment = one(await client.query(`/* custom-cohort-capture:assignment */
    SELECT id::text AS assignment_file_id,account_id,organization_id,
      assigned_appraiser_user_id,supervisory_appraiser_user_id
    FROM app.assignment_files WHERE id=$1::bigint AND account_id=$2
    ${locked ? 'FOR UPDATE NOWAIT' : ''}`, [input.assignmentFileId, input.accountId]));
  if (assignment.assignment_file_id !== input.assignmentFileId || assignment.account_id !== input.accountId
    || !hasApplicationPermission(input.auth, 'custom_appraisal', permission, assignment.organization_id)
    || !decideAssignmentAccess(input.auth, assignment, permission)) fail('assignment_access_denied');
  const report = one(await client.query(`/* custom-cohort-capture:report */
    SELECT id AS report_file_id,appraisal_case_id,subject_snapshot_id
    FROM app.report_files WHERE custom_assignment_file_id=$1::bigint AND account_id=$2 AND organization_id=$3
      AND workflow_type='custom_appraisal' AND uad_workfile_id IS NULL AND tax_protest_file_id IS NULL${lockReport ? ' FOR SHARE NOWAIT' : ''}`,
  [input.assignmentFileId, input.accountId, assignment.organization_id]));
  return freeze({ ...Object.fromEntries(TARGET_FIELDS.filter(key => key !== 'report_file_id').map(key => [key, assignment[key]])), ...report });
}
async function privateCaptureWorkfile(client, input, { permission = 'write', writeLock = true } = {}) {
  // The upload/review and signing owners lock the workfile before assignment
  // rows. Follow that same order for this additive private-capture write path.
  await resolveTarget(client, input, false, permission);
  return one(await client.query(`/* custom-cohort-capture:private-workfile */
    SELECT status,signed_at,EXISTS (SELECT 1 FROM app.custom_appraisal_signed_snapshots s
      WHERE s.assignment_file_id=w.assignment_file_id) AS has_signed_snapshot
    FROM app.custom_appraisal_workfiles w WHERE assignment_file_id=$1::bigint FOR ${writeLock ? 'UPDATE' : 'SHARE'} NOWAIT`, [input.assignmentFileId]));
}
function privateDraft(workfile) {
  if (workfile.status !== 'draft' || workfile.signed_at !== null || workfile.has_signed_snapshot !== false) fail('private_source_read_only');
}
function assertTarget(current, original) {
  if ([...TARGET_FIELDS, 'appraisal_case_id', 'subject_snapshot_id'].some(key => current[key] !== original[key])) fail('target_changed');
}
function contextOf(subject) {
  const t = subject.target;
  return freeze({ target: { report_file_id: t.report_file_id, workflow_type: 'custom_appraisal', workflow_target_id: t.assignment_file_id },
    scope: { organization_id: t.organization_id, appraisal_case_id: t.appraisal_case_id,
      subject_snapshot_id: t.subject_snapshot_id, account_id: t.account_id }, effective_date: subject.effective_date });
}
function policyDecision(value) {
  if (!value || value.allowed !== true || typeof value.decision_id !== 'string' || !value.decision_id
    || typeof value.policy_revision !== 'string' || !value.policy_revision) fail('market_data_access_denied');
  return freeze({ allowed: true, decision_id: value.decision_id, policy_revision: value.policy_revision });
}
async function boundedPolicy(policy, client, auth, context, purpose, budget, exposure = 'none') {
  budget.check();
  let timer, aborted;
  const expired = new Promise((_, reject) => {
    const rejectWith = reason => { try { fail(reason); } catch (error) { reject(error); } };
    timer = setTimeout(() => rejectWith('policy_timeout'), budget.remaining(LIMITS.duration_ms));
    aborted = () => rejectWith('cancelled');
    budget.signal?.addEventListener('abort', aborted, { once: true });
  });
  try {
    // The trusted policy receives only the transaction's bounded client. Late
    // work cannot issue another query after its owner closes that client. Join
    // rejections through Promise.race; never leave an unhandled late rejection.
    const result = await Promise.race([Promise.resolve().then(() =>
      policy(client, auth, context, purpose, { retention: true, exposure })), expired]);
    budget.check(); return policyDecision(result);
  } finally { clearTimeout(timer); budget.signal?.removeEventListener('abort', aborted); }
}
function captured(value, stage) {
  if (value?.status !== 'captured' || value.query_complete !== true) fail(`${stage}_incomplete`,
    value?.reason ?? value?.incomplete_reasons ?? 'unavailable', value?.counts);
  return value;
}

async function authorizedRetainedInputs(client, { scopeJson, reference, input, authorizeMarketData, authorizePrivateSales, budget, study = null,
  exposure = 'none', additionalExposures = [], loadInputs = true, privateSummary = false, beforeLoad = null,
  stagedHeader = null, expectedIntent = null }) {
  // Only the private worker checkpoint path supplies a parsed original staged
  // header. It conveys no registered-context or source authority. Both paths
  // must authorize today's original source purpose before opening row pages.
  const previous = stagedHeader ?? await createCustomCohortContextRepository(client, scopeJson).get(canonicalAssessmentJson(reference));
  if (!previous) fail('context_unavailable');
  if (!same(previous.context_ref, reference)) fail('operation_conflict');
  const refs = Object.fromEntries(DEPENDENCIES.map(key => [key, previous.body[key]]));
  const context = { target: {
    report_file_id: previous.body.target.report_file_id, workflow_type: 'custom_appraisal',
    workflow_target_id: previous.body.target.workflow_target_id,
  }, scope: Object.fromEntries(['organization_id', 'appraisal_case_id', 'subject_snapshot_id', 'account_id']
    .map(key => [key, previous.body.target[key]])), effective_date: previous.body.effective_date };
  const blobs = createNeighborhoodCohortBlobRepository(client, context.scope.organization_id);
  const readMetadata = async ref => {
    const text = await blobs.get(ref?.content_sha256, ref?.canonical_utf8_bytes);
    if (text === null) fail('retained_inputs_unavailable');
    return JSON.parse(text);
  };
  // Only the bounded request directory is opened before current licensing.
  // Never read full source rows simply because this operation was allowed before.
  const directory = await readMetadata(refs.selection_input);
  if (expectedIntent && (!same(directory.acquisition_intent, expectedIntent)
    || !same(directory.subject_inputs, (await readMetadata(expectedIntent)).subject_inputs))) fail('checkpoint_conflict');
  const requestMetadata = await readMetadata(directory.request?.metadata);
  const compact = await readMetadata(directory.compact_metadata);
  if (!same(requestMetadata.target, context.target) || !same(requestMetadata.scope, context.scope)
    || (study && !same(requestMetadata.observation_period, study.observation_period))
    || requestMetadata.effective_date !== context.effective_date || requestMetadata.knowledge_cutoff !== null) fail('operation_conflict');
  // Choose the source projection from its original immutable query metadata,
  // never today's producer default. v3 cannot reopen under a narrower v2 grant;
  // CAD-only v4 keeps the original market-data purpose without MLS witnesses.
  if (compact.reader_version !== 'local-capture-v3' || ![1, 2, 3, 4, 5].includes(compact.mapping_version)
    || !same(compact.scope, requestMetadata.scope) || compact.effective_date !== requestMetadata.effective_date
    || !same(compact.authorization?.target, requestMetadata.target)
    || !same(compact.authorization?.market_decision, requestMetadata.market_decision)) fail('operation_conflict');
  // Metadata-only callers must also verify the persisted interpretation choice.
  // These bounded originals contain no source rows. A claimed compiled profile
  // is insufficient: the actual retained definition must exist and match.
  const studyOriginal = await readMetadata(refs.study_input);
  const marked = [2, 4].includes(studyOriginal.study_input_version);
  const housingMarked = [3, 4].includes(studyOriginal.study_input_version);
  const privateCapture = directory.selection_input_version === 2;
  if (![1, 2].includes(directory.selection_input_version)
    || Object.hasOwn(directory, 'private_sales') !== privateCapture
    || ![1, 2, 3, 4].includes(studyOriginal.study_input_version)
    || Object.hasOwn(studyOriginal, 'reported_sale_interpretation') !== marked
    || Object.hasOwn(studyOriginal, 'recorded_housing_interpretation') !== housingMarked) fail('operation_conflict');
  exactKeys(studyOriginal, ['study_input_version', 'usage', 'target', 'effective_date', 'settings', 'source_semantics', 'eligibility',
    ...(marked ? ['reported_sale_interpretation'] : []), ...(housingMarked ? ['recorded_housing_interpretation'] : [])]);
  if (studyOriginal.usage !== 'retained_custom_study_settings' || studyOriginal.eligibility !== 'not_established'
    || studyOriginal.effective_date !== context.effective_date
    || !same(studyOriginal.target, { ...context.scope, report_file_id: context.target.report_file_id,
      workflow_type: 'custom_appraisal', assignment_file_id: context.target.workflow_target_id,
      snapshot_version: previous.body.target.snapshot_version })
    || !same(studyOriginal.settings?.observation_period, requestMetadata.observation_period)
    || !same(studyOriginal.source_semantics, compact.semantics)) fail('operation_conflict');
  const intentOriginal = await readMetadata(directory.acquisition_intent);
  exactKeys(intentOriginal, ['intent_version', 'operation_id', 'actor_user_id', 'subject_inputs', 'target', 'effective_date', 'study', 'created_at',
    ...(privateCapture ? ['private_sales_import'] : []), ...(marked ? ['reported_sale_interpretation'] : []),
    ...(housingMarked ? ['recorded_housing_interpretation'] : [])]);
  if (intentOriginal.intent_version !== (privateCapture ? 2 : 1) + (marked ? 2 : 0) + (housingMarked ? 4 : 0)
    || intentOriginal.operation_id !== reference.context_id
    || !same(intentOriginal.subject_inputs, directory.subject_inputs)
    || !same(intentOriginal.target, studyOriginal.target) || intentOriginal.effective_date !== context.effective_date
    || !same(intentOriginal.study, studyOriginal.settings)) fail('operation_conflict');
  let reportedInterpretation = null;
  if (marked) {
    const installed = getCustomCohortReportedSaleWitnessV2Profile();
    const original = studyOriginal.reported_sale_interpretation;
    exactKeys(original, ['profile_ref', 'definition_blob']);
    if (compact.mapping_version !== 5 || !same(original.profile_ref, installed.profile_ref)
      || !same(intentOriginal.reported_sale_interpretation, installed.profile_ref)
      || !same(original.definition_blob, installed.definition_blob.ref)) fail('operation_conflict');
    const definition = await blobs.get(original.definition_blob.content_sha256, original.definition_blob.canonical_utf8_bytes);
    if (definition !== installed.definition_blob.canonical_json) fail('operation_conflict');
    reportedInterpretation = installed.profile_ref;
  }
  if (housingMarked) {
    if (![4, 5].includes(compact.mapping_version)) fail('operation_conflict');
    const installed = getCustomCohortRecordedHousingInterpretation(compact.mapping_version, 2);
    const original = studyOriginal.recorded_housing_interpretation;
    exactKeys(original, ['profile_ref', 'definition_blob']);
    if (!same(original.profile_ref, installed.profile_ref)
      || !same(intentOriginal.recorded_housing_interpretation, installed.profile_ref)
      || !same(original.definition_blob, installed.definition_blob.ref)) fail('operation_conflict');
    const definition = await blobs.get(original.definition_blob.content_sha256, original.definition_blob.canonical_utf8_bytes);
    if (definition !== installed.definition_blob.canonical_json) fail('operation_conflict');
  }
  const purpose = compact.mapping_version === 5 ? describeNeighborhoodCombinedEvidenceMarketDataPurpose(requestMetadata)
    : compact.mapping_version === 3 ? describeNeighborhoodSaleWitnessMarketDataPurpose(requestMetadata)
    : describeNeighborhoodCachedMarketDataPurpose(requestMetadata);
  const decision = await boundedPolicy(authorizeMarketData, client, input.auth, context, purpose, budget, exposure);
  if (!same({ decision_id: decision.decision_id, policy_revision: decision.policy_revision }, requestMetadata.market_decision)) fail('market_policy_changed');
  for (const additional of additionalExposures) {
    const permitted = await boundedPolicy(authorizeMarketData, client, input.auth, context, purpose, budget, additional);
    if (!same(permitted, decision)) fail('market_policy_changed');
  }
  let privateAuthorization = null;
  if (directory.selection_input_version === 2) {
    // Authorize the distinct private-data purpose before opening any row page.
    const metadata = await readMetadata(directory.private_sales?.metadata);
    const original = await readMetadata(directory.private_sales?.authorization);
    const privatePurpose = customNeighborhoodPrivateSalesPurpose({ batch_id: metadata.batch?.batch_id,
      expected_review_revision: metadata.review?.revision });
    const privateDecision = await boundedPolicy(authorizePrivateSales, client, input.auth, context, privatePurpose, budget, exposure);
    if (!same(original, { decision_id: privateDecision.decision_id, policy_revision: privateDecision.policy_revision })) fail('market_policy_changed');
    for (const additional of new Set([...additionalExposures, ...(privateSummary ? ['report_observation_summary'] : [])])) {
      const permitted = await boundedPolicy(authorizePrivateSales, client, input.auth, context, privatePurpose, budget, additional);
      if (!same(permitted, privateDecision)) fail('market_policy_changed');
    }
    privateAuthorization = { purpose: privatePurpose, decision: privateDecision };
  }
  // Review persistence will reopen the original graph in this same transaction.
  // Keep its preceding rights check, without allocating/validating it twice.
  const metadata = { context, purpose, decision, privateAuthorization, header: previous, reportedInterpretation };
  const beforeLoadResult = beforeLoad === null ? null : await beforeLoad(metadata);
  const retained = loadInputs ? await loadCustomCohortCaptureInputs(client, scopeJson, refs) : null;
  // A checkpoint is editor intent, not authority to relabel a retained study.
  // Check the discovery binding as well as its dates before report preparation.
  if (study && retained && !same(study.discovery ?? null, retained.study.discovery ?? null)) fail('operation_conflict');
  return { ...metadata, subjectReference: directory.subject_inputs, accountRosterRef: directory.request.account_ids,
    observationPeriod: requestMetadata.observation_period,
    discovery: studyOriginal.settings.discovery ?? null,
    retained, ...(beforeLoad === null ? {} : { beforeLoadResult }) };
}

/** Executable, Custom-only acquisition owner. No HTTP route, report
 * publication, Apply or signing occurs here. Internal recorded-group methods
 * retain context-bound selection intent and expose separately authorized
 * descriptive numeric summaries, not accepted report/workspace sections.
 * The internal
 * prepareReviewedInputs method computes exact retained/reviewed inputs only;
 * no route may expose its source-bearing result under a retention-only grant.
 * The review method retains exact authenticated reviewer commands only; stored
 * observations/assertions do not become certified facts or accepted statistics.
 * authorizeMarketData is a required SERVER policy and must explicitly cover
 * cached source rows, all-date one-hop identities and immutable retention. It
 * receives only this bounded client; it may not read a pool or a remote provider.
 * No default grant is inferred from assignment access, hashes or professional
 * licensing. Source completeness and historical support remain unknown.
 */
export function createCustomCohortContextCapture({ pool, authorizeMarketData,
  authorizePrivateSales = async () => ({ allowed: false }),
  authorizeReportedObservations = async () => ({ allowed: false }), authorizeCadImprovementData = null, sourceMode = 'cad4' } = {}) {
  if (!['cad4', 'combined-witness2-v1'].includes(sourceMode)) throw new TypeError('custom_cohort_capture_source_mode_invalid');
  if (typeof pool?.connect !== 'function' || typeof authorizeMarketData !== 'function'
    || typeof authorizeReportedObservations !== 'function'
    || authorizeCadImprovementData!==null&&typeof authorizeCadImprovementData!=='function') {
    throw new TypeError('custom_cohort_capture_dependencies_required');
  }
  // Trusted constructor setting applies only to NEW attempts. Replays always
  // resolve the original source purpose and interpretation from retained blobs.
  const reportedProfile = sourceMode === 'combined-witness2-v1' ? getCustomCohortReportedSaleWitnessV2Profile().profile_ref : null;
  // Only NEW acquisitions get this server-selected interpretation. Registered
  // retries/reopens are selected from their immutable original study above.
  const housingProfile = getCustomCohortRecordedHousingInterpretation(reportedProfile ? 5 : 4, 2).profile_ref;
  const createReadAccess = reportedProfile ? createNeighborhoodCombinedEvidenceReadAccess : createNeighborhoodCadEvidenceReadAccess;
  const createSourceReader = reportedProfile ? createNeighborhoodDenseCombinedEvidenceSourceReader : createNeighborhoodDenseCadEvidenceSourceReader;
  async function recheckPrivatePolicy(client, input, loaded, budget, exposures = ['none']) {
    if (!loaded.privateAuthorization) return;
    for (const exposure of exposures) {
      const decision = await boundedPolicy(authorizePrivateSales, client, input.auth, loaded.context,
        loaded.privateAuthorization.purpose, budget, exposure);
      if (!same(decision, loaded.privateAuthorization.decision)) fail('market_policy_changed');
    }
  }
  async function executePreparedOriginal(originalInput, options, writing, work, projection = 'intent') {
      // Closed owner methods alone choose this projection. Catalog display
      // permission is never an implicit grant for individual membership.
      const selecting = ['intent', 'workspace', 'complete'].includes(projection);
      if ((!['catalog', 'membership'].includes(projection) && !selecting)
        || (!writing && ['workspace', 'complete'].includes(projection))) fail('invalid_input');
      const additionalExposures = projection === 'membership' || selecting ? ['report_observation_members'] : [];
      const budget = operationBudget(options), permission = writing ? 'write' : 'read';
      return transaction(pool, 'READ COMMITTED', budget, async client => {
        const initial = await resolveTarget(client, originalInput, false, permission);
        const auth = await loadCurrentCustomCohortJobActor(client, originalInput.auth.userId, initial.organization_id);
        const input = { ...originalInput, auth };
        assertTarget(await resolveTarget(client, input, false, permission), initial);
        // Match existing upload/sign/subject lock order without a SHARE upgrade.
        // Read permission is NOT widened by taking the same NOWAIT parent lock.
        const workfile = await privateCaptureWorkfile(client, input, { permission, writeLock: true });
        if (writing) privateDraft(workfile);
        const target = await resolveTarget(client, input, true, permission);
        assertTarget(target, initial);
        const scopeJson = canonicalAssessmentJson(Object.fromEntries(TARGET_FIELDS.map(key => [key, target[key]])));
        const licensed = await authorizedRetainedInputs(client, { scopeJson, reference: input.contextRef, input,
          authorizeMarketData, authorizePrivateSales, budget, exposure: 'report_observation_catalog',
          additionalExposures, loadInputs: false });
        // Original metadata establishes whether this was a private-source study.
        // Never inspect a shared derivative or compile a fallback for that case.
        if (licensed.privateAuthorization) fail('prepared_catalog_private_source_unsupported');
        if ((await createCustomCohortSubjectRepository(client, scopeJson)
          .compareCurrent(licensed.subjectReference)).status !== 'matched') fail('subject_changed');
        if (selecting && writing && projection === 'intent') {
          const versions = await client.query(`/* custom-cohort-group-workspace:legacy-guard */
            SELECT section_value->>'workspace_version' AS workspace_version
            FROM app.custom_appraisal_workfile_sections
            WHERE assignment_file_id=$1::bigint AND section_key=$2 FOR SHARE NOWAIT`,
          [input.assignmentFileId, CUSTOM_NEIGHBORHOOD_WORKSPACE_SECTION]);
          if (versions?.rows?.some(row => row.workspace_version === '7')) fail('selection_workspace_workflow_required');
        }
        const selectionWorkspace = projection === 'workspace' ? await prepareCustomCohortGroupWorkspaceSave({
          client, input, observationPeriod: licensed.observationPeriod, discovery: licensed.discovery,
          checkBudget: budget.check,
        }) : projection === 'complete' ? await prepareCustomCohortGroupCaptureCompletion({
          client, input, scopeJson, observationPeriod: licensed.observationPeriod, discovery: licensed.discovery,
          privateSalesImport: null, checkBudget: budget.check,
        }) : null;
        const result = await work({ client, auth, scopeJson, budget, ...(selecting ? {
          blobs: createNeighborhoodCohortBlobRepository(client, target.organization_id), selectionWorkspace,
          retainedSelection: createCustomCohortPreparedSelectionRegistry(client, scopeJson,
            canonicalAssessmentJson(input.contextRef), { signal: budget.signal, checkBudget: budget.check }),
        } : {}) });
        // Reopen the SAME original context/dependencies and policy using fresh
        // database roles before delivery/COMMIT, including an ordinary cache miss.
        const finalAuth = await loadCurrentCustomCohortJobActor(client, input.auth.userId, target.organization_id);
        const finalInput = { ...input, auth: finalAuth };
        assertTarget(await resolveTarget(client, finalInput, true, permission), target);
        if (writing) privateDraft(await privateCaptureWorkfile(client, finalInput));
        const ending = await authorizedRetainedInputs(client, { scopeJson, reference: input.contextRef, input: finalInput,
          authorizeMarketData, authorizePrivateSales, budget, exposure: 'report_observation_catalog',
          additionalExposures, loadInputs: false });
        if (ending.privateAuthorization || !same(ending.header, licensed.header)
          || !same(ending.purpose, licensed.purpose) || !same(ending.decision, licensed.decision)
          || !same(ending.subjectReference, licensed.subjectReference)) fail('operation_conflict');
        if ((await createCustomCohortSubjectRepository(client, scopeJson)
          .compareCurrent(ending.subjectReference)).status !== 'matched') fail('subject_changed');
        budget.check(); return freeze(result);
      });
  }
  const preparedCatalog = createCustomCohortPreparedCatalogOwner({ identityOf, execute: executePreparedOriginal });
  // Explicit internal companions, not replacements for the installed routes or
  // legacy/private-source workflows. Neither display nor member counts are
  // cast into a map/statistical result; selected originals/head are still fully
  // verified by the unchanged selection repository in this same transaction.
  const retainedGroupSelection = createCustomCohortRecordedGroupSelectionOwner({ identityOf, execute: executePreparedOriginal });
  const recordedGroupSelection = createCustomCohortRecordedGroupSelectionOwner({ identityOf,
    executeWorkspaceTransition: async (originalInput, options, work) => {
      const budget = operationBudget(options);
      return transaction(pool, 'READ COMMITTED', budget, async client => {
        // The assignment locator supplies only the DB organization. Request-
        // time role claims cannot reject or authorize a pending-study write
        // before the current actor/organization membership has been reloaded.
        const locator=one(await client.query(`/* custom-cohort-capture:workspace-organization */
          SELECT organization_id FROM app.assignment_files WHERE id=$1::bigint AND account_id=$2`,
        [originalInput.assignmentFileId,originalInput.accountId]));
        const auth = await loadCurrentCustomCohortJobActor(client, originalInput.auth.userId, locator.organization_id);
        const input = { ...originalInput, auth };
        const initial = await resolveTarget(client, input, false, 'write');
        privateDraft(await privateCaptureWorkfile(client, input));
        const target = await resolveTarget(client, input, true, 'write');
        assertTarget(target, initial);
        const scopeJson = canonicalAssessmentJson(Object.fromEntries(TARGET_FIELDS.map(key => [key, target[key]])));
        // Pending intent reads no old catalog/source facts. Revocation of an
        // old source license must not prevent setting aside an unfinished study.
        const result = await work({ client, auth, scopeJson, budget });
        const finalAuth = await loadCurrentCustomCohortJobActor(client, input.auth.userId, target.organization_id);
        const finalInput = { ...input, auth: finalAuth };
        assertTarget(await resolveTarget(client, finalInput, true, 'write'), target);
        privateDraft(await privateCaptureWorkfile(client, finalInput));
        budget.check(); return freeze(result);
      });
    },
    execute: async (originalInput, options, writing, work, projection = 'intent') => {
      if (!['intent', 'workspace', 'complete', 'summary', 'viewport', 'members', 'opening', 'market'].includes(projection)
        || (writing && !['intent', 'workspace', 'complete'].includes(projection))
        || (!writing && ['workspace', 'complete'].includes(projection))) fail('invalid_input');
      // Geometry uses the existing viewport's summary exposure, in addition to
      // catalog rights needed to re-derive the exact server-owned selection.
      const additionalExposures = projection === 'members' ? ['report_observation_members']
        : ['summary', 'viewport', 'opening', 'market'].includes(projection) ? ['report_observation_summary'] : [];
      const budget = operationBudget(options), permission = writing ? 'write' : 'read';
      return transaction(pool, 'READ COMMITTED', budget, async client => {
        const initial = await resolveTarget(client, originalInput, false, permission);
        const auth = await loadCurrentCustomCohortJobActor(client, originalInput.auth.userId, initial.organization_id);
        const input = { ...originalInput, auth };
        assertTarget(await resolveTarget(client, input, false, permission), initial);
        // Match upload/signing lock order. A saved selection may never mutate a
        // signed workfile or its accepted report. Reads remain current-authorized.
        // Subject freshness later locks this parent FOR UPDATE as well. Take
        // that mode first so concurrent NOWAIT readers cannot both acquire
        // SHARE and then fail while upgrading; permission still stays read.
        const workfile = await privateCaptureWorkfile(client, input, { permission, writeLock: true });
        if (writing) privateDraft(workfile);
        const target = await resolveTarget(client, input, true, permission);
        assertTarget(target, initial);
        const scopeJson = canonicalAssessmentJson(Object.fromEntries(TARGET_FIELDS.map(key => [key, target[key]])));
        const licensed = await authorizedRetainedInputs(client, { scopeJson, reference: input.contextRef, input,
          authorizeMarketData, authorizePrivateSales, budget, exposure: 'report_observation_catalog',
          additionalExposures, loadInputs: false, privateSummary: ['members', 'market'].includes(projection) });
        if (writing && projection === 'intent') {
          const versions = await client.query(`/* custom-cohort-group-workspace:legacy-guard */
            SELECT section_value->>'workspace_version' AS workspace_version
            FROM app.custom_appraisal_workfile_sections
            WHERE assignment_file_id=$1::bigint AND section_key=$2 FOR SHARE NOWAIT`,
          [input.assignmentFileId, CUSTOM_NEIGHBORHOOD_WORKSPACE_SECTION]);
          if (versions?.rows?.some(row => row.workspace_version === '7')) fail('selection_workspace_workflow_required');
        }
        const selectionWorkspace = projection === 'workspace' ? await prepareCustomCohortGroupWorkspaceSave({
          client, input, observationPeriod: licensed.observationPeriod, discovery: licensed.discovery,
          checkBudget: budget.check,
        }) : projection === 'complete' ? await prepareCustomCohortGroupCaptureCompletion({
          client, input, scopeJson, observationPeriod: licensed.observationPeriod, discovery: licensed.discovery,
          privateSalesImport: licensed.privateAuthorization ? {
            batch_id: licensed.privateAuthorization.purpose.batch_id,
            expected_review_revision: licensed.privateAuthorization.purpose.expected_review_revision,
          } : null, checkBudget: budget.check,
        }) : null;
        let catalog, roster, indexedPreview, neutralCatalog = null, retained = null;
        if (!licensed.privateAuthorization) {
          const cached = await createCustomCohortPreparedCatalogRepository(client, scopeJson, input.contextRef).read();
          const prepared = cached ? await createCustomCohortPreparedPreviewRepository(client, scopeJson, input.contextRef)
            .read({ includeMap: false, useVerifiedPreviewCache: true }) : null;
          if (prepared) {
            if (!same(prepared.preview.observation_period, licensed.observationPeriod)
              || prepared.preview.effective_date !== licensed.context.effective_date) fail('operation_conflict');
            catalog = rebindCustomCohortPreparedCatalog(cached, 1).catalog;
            neutralCatalog = cached;
            roster = prepared.preview.all.account_ids;
            indexedPreview = prepared.preview;
          }
        }
        if (!catalog) {
          // Source rights were checked before these original row pages. Private
          // data still retains its own purpose/review; no shared-only cache may
          // stand in for a private-source capture.
          retained = await loadCustomCohortCaptureInputs(client, scopeJson,
            Object.fromEntries(DEPENDENCIES.map(key => [key, licensed.header.body[key]])));
          const preview = await buildCustomCohortIndexedObservationPreviewBatched({ context_ref: input.contextRef,
            retained_inputs: retained.retained_inputs, selection: { revision: 1, pockets: [] } }, { check: budget.check });
          const expected = { context_ref: input.contextRef, selection_revision: 1 };
          const batches = customCohortPocketCatalogBatches({ retained_inputs: retained.retained_inputs, preview, catalog_version: 3 });
          let step;
          do { budget.check(); step = batches.next(); if (!step.done) await yieldToRequests(); } while (!step.done);
          budget.check();
          catalog = presentCustomCohortPocketCatalog({ catalog: step.value, preview, expected });
          roster = retained.retained_inputs.spatial.account_ids;
          indexedPreview = preview;
        }
        const selectionObservation = (accounts, selectionRef) => {
          budget.check();
          const selection = { revision: selectionRef.selection_revision, pockets: accounts.length
            ? [{ id: 'discovery:selected', label: 'Selected observations', account_ids: accounts }] : [] };
          const preview = reselectCustomCohortIndexedObservationPreview(indexedPreview, selection);
          const expected = { context_ref: input.contextRef, selection_revision: selection.revision };
          const binding = customCohortPreviewBinding(preview, expected);
          if (binding.selection_sha256 !== selectionRef.selection_sha256) fail('operation_conflict');
          const privateCapture = retained?.retained_inputs.private_sales?.capture;
          const observations = privateCapture ? buildCustomCohortPrivateSalesObservations({ supplement: privateCapture,
            context_ref: input.contextRef, effective_date: licensed.context.effective_date,
            observation_period: licensed.observationPeriod,
            selection: { revision: selection.revision, account_ids: accounts } }) : null;
          const private_sales = observations ? presentCustomCohortPrivateSalesObservations({ observations, binding }) : null;
          budget.check(); return { preview, expected, private_sales };
        };
        const presentSelectionSummary = projection === 'summary' ? (accounts, selectionRef) => {
          const { preview, expected, private_sales } = selectionObservation(accounts, selectionRef);
          return { summary: presentCustomCohortPreview({ preview, expected, includeNarrative: true }), ...(private_sales ? { private_sales } : {}) };
        } : undefined;
        const presentSelectionMembers = projection === 'members' ? (accounts, selectionRef, population, page) => {
          const { preview, expected, private_sales } = selectionObservation(accounts, selectionRef);
          return { page: inspectCustomCohortPreviewMembers({ preview, expected, population, page }),
            ...(private_sales ? { private_sales } : {}) };
        } : undefined;
        const presentSelectionMapOpening = projection === 'opening' ? async selectionRef => {
          budget.check();
          let manifest = neutralCatalog ? await createCustomCohortPreparedMapOpeningRepository(client, scopeJson, input.contextRef)
            .read(neutralCatalog) : null;
          if (!manifest) {
            let map;
            if (!licensed.privateAuthorization) {
              const prepared = await createCustomCohortPreparedPreviewRepository(client, scopeJson, input.contextRef)
                .read({ includeMap: true, useVerifiedPreviewCache: true });
              if (prepared) map = prepared.parcel_map;
            }
            if (!map) {
              if (!retained) retained = await loadCustomCohortCaptureInputs(client, scopeJson,
                Object.fromEntries(DEPENDENCIES.map(key => [key, licensed.header.body[key]])));
              map = await buildCustomCohortParcelMapBatched({ retained_inputs: retained.retained_inputs,
                selected_account_ids: [] }, { check: budget.check });
            }
            manifest = buildCustomCohortMapManifest(catalog, map);
          }
          budget.check();
          return presentCustomCohortGroupMapOpening({ scopeJson, contextRef: input.contextRef, selectionRef, catalog, manifest });
        } : undefined;
        const presentSelectionViewport = projection === 'viewport' ? async (accounts, selectionRef, viewport) => {
          budget.check();
          let map;
          if (!licensed.privateAuthorization) {
            const repository = createCustomCohortPreparedPreviewRepository(client, scopeJson, input.contextRef);
            const tileMap = await repository.readViewportTiles(viewport, indexedPreview);
            if (tileMap) map = selectCustomCohortPreparedTileViewportMap(tileMap, accounts, roster);
            else {
              const prepared = await repository.read({ includeMap: true, useVerifiedPreviewCache: true });
              if (prepared) map = selectCustomCohortPreparedParcelViewportMap(prepared.parcel_map, accounts, viewport);
            }
          }
          if (!map) {
            if (!retained) retained = await loadCustomCohortCaptureInputs(client, scopeJson,
              Object.fromEntries(DEPENDENCIES.map(key => [key, licensed.header.body[key]])));
            map = await buildCustomCohortParcelMapBatched({ retained_inputs: retained.retained_inputs,
              selected_account_ids: accounts }, { check: budget.check });
          }
          budget.check();
          // No numeric recomputation and no viewport-filtered analytical union.
          // Membership comes from the complete verified original selection.
          return presentCustomCohortSelectionViewportMap({ status: 'preview',
            target: { account_id: input.accountId, assignment_file_id: input.assignmentFileId },
            context_ref: input.contextRef, selection_revision: selectionRef.selection_revision,
            summary: { binding: { selection_sha256: selectionRef.selection_sha256 } }, parcel_map: map }, viewport);
        } : undefined;
        const result = await work({ client, auth, scopeJson, catalogJson: JSON.stringify(catalog),
          rosterJson: JSON.stringify({ account_ids: roster }), budget,
          ...(selectionWorkspace ? { selectionWorkspace } : {}),
          ...(presentSelectionSummary ? { presentSelectionSummary } : {}),
          ...(presentSelectionViewport ? { presentSelectionViewport } : {}),
          ...(presentSelectionMembers ? { presentSelectionMembers } : {}),
          ...(presentSelectionMapOpening ? { presentSelectionMapOpening } : {}),
          blobs: createNeighborhoodCohortBlobRepository(client, target.organization_id) });
        // Refresh request-time role claims again before COMMIT/delivery; original
        // actor receipts, cached facts and integrity hashes establish no grant.
        const finalAuth = await loadCurrentCustomCohortJobActor(client, input.auth.userId, target.organization_id);
        const finalInput = { ...input, auth: finalAuth };
        assertTarget(await resolveTarget(client, finalInput, true, permission), target);
        if ((await createCustomCohortSubjectRepository(client, scopeJson)
          .compareCurrent(licensed.subjectReference)).status !== 'matched') fail('subject_changed');
        for (const exposure of ['report_observation_catalog', ...additionalExposures]) {
          const decision = await boundedPolicy(authorizeMarketData, client, finalAuth, licensed.context,
            licensed.purpose, budget, exposure);
          if (!same(decision, licensed.decision)) fail('market_policy_changed');
        }
        const privateCapture = retained?.retained_inputs.private_sales?.capture;
        if (privateCapture) await recheckAssignmentSalesCsvCapture(client.query.bind(client), privateCapture);
        await recheckPrivatePolicy(client, finalInput, licensed, budget,
          [...new Set(['report_observation_catalog', ...additionalExposures,
            ...(projection === 'members' ? ['report_observation_summary'] : [])])]);
        budget.check(); return freeze(result);
      });
    } });
  function reportPurpose(input, retained) {
    const privatePurpose = retained.privateAuthorization?.purpose;
    return { kind: 'custom_reported_observations_v2', context_ref: input.contextRef,
      shared_source_purpose: retained.purpose, private_sales_import: privatePurpose ? {
        batch_id: privatePurpose.batch_id, expected_review_revision: privatePurpose.expected_review_revision } : null };
  }
  async function reportPermission(client, input, retained, budget) {
    try {
      return await boundedPolicy(authorizeReportedObservations, client, input.auth, retained.context,
        reportPurpose(input, retained), budget, 'custom_report_observations');
    } catch (error) {
      if (error?.reason === 'market_data_access_denied') fail('report_observation_access_denied');
      throw error;
    }
  }
  async function workspaceSelection(client, input, { scopeJson, workspace, retained }, budget) {
    if (workspace.checkpoint.workspace_version !== 7) return null;
    // The catalog grant must already have succeeded before retained row pages
    // are loaded. Rebuild only the exact retained catalog/independent roster,
    // never today's source tables, a viewport or browser-supplied memberships.
    let catalog, roster;
    if (!retained.privateAuthorization) {
      const cached = await createCustomCohortPreparedCatalogRepository(client, scopeJson, input.contextRef).read();
      const prepared = cached ? await createCustomCohortPreparedPreviewRepository(client, scopeJson, input.contextRef)
        .read({ includeMap: false, useVerifiedPreviewCache: true }) : null;
      if (prepared) {
        if (!same(prepared.preview.observation_period, retained.observationPeriod)
          || prepared.preview.effective_date !== retained.context.effective_date) fail('operation_conflict');
        catalog = rebindCustomCohortPreparedCatalog(cached, 1).catalog;
        roster = prepared.preview.all.account_ids;
      }
    }
    if (!catalog) {
      const preview = await buildCustomCohortIndexedObservationPreviewBatched({ context_ref: input.contextRef,
        retained_inputs: retained.retained.retained_inputs, selection: { revision: 1, pockets: [] } }, { check: budget.check });
      const batches = customCohortPocketCatalogBatches({ retained_inputs: retained.retained.retained_inputs, preview, catalog_version: 3 });
      let step;
      do { budget.check(); step = batches.next(); if (!step.done) await yieldToRequests(); } while (!step.done);
      catalog = presentCustomCohortPocketCatalog({ catalog: step.value, preview,
        expected: { context_ref: input.contextRef, selection_revision: 1 } });
      roster = retained.retained.retained_inputs.spatial.account_ids;
    }
    const original = await reopenCustomCohortRecordedGroupSelectionOriginal({ client, scopeJson, budget,
      catalogJson: JSON.stringify(catalog), rosterJson: JSON.stringify({ account_ids: roster }),
      blobs: createNeighborhoodCohortBlobRepository(client, JSON.parse(scopeJson).organization_id) },
    { contextRef: input.contextRef, selectionRef: workspace.checkpoint.active.selection_ref });
    if (!original) fail('selection_changed');
    budget.check();
    return freeze({ reference: original.selection_ref, selection: { revision: original.selection_ref.selection_revision,
      included_recorded_group_ids: original.included_recorded_group_ids } });
  }
  async function recheckWorkspaceSelection(client, input, loaded, budget) {
    if (!loaded.workspaceSelection) return;
    budget.check();
    const current = await createCustomCohortGroupSelectionRepository(client, loaded.scopeJson,
      canonicalAssessmentJson(input.contextRef), { signal: budget.signal, checkBudget: budget.check }).peekCurrent();
    if (!same(current.selection_ref, loaded.workspaceSelection.reference)) fail('selection_changed');
    budget.check();
  }
  function reportRequest(input, target) {
    return { actor_user_id: input.auth.userId, target: Object.fromEntries(TARGET_FIELDS.map(key => [key, target[key]])),
      context_ref: input.contextRef, workspace_section_revision: input.expectedWorkspaceRevision,
      editor_revision: input.expectedEditorRevision, operation_id: input.proposalOperationId ?? input.operationId,
      ...(input.replacement ? { replacement: { kind: input.replacement.kind } } : {}) };
  }
  function reportFences(loaded) {
    return { workspace_sha256: assessmentEvidenceDigest(loaded.workspace), editor: loaded.reportEditor,
      boundary: { assignment_revision: loaded.savedBoundary.assignment_revision,
        ...Object.fromEntries(Object.entries(loaded.savedBoundary.projection).filter(([key]) => key !== 'projected_json')) },
      subject_reference: loaded.retained.retained.subject_reference,
      market_decision: loaded.retained.decision, private_decision: loaded.retained.privateAuthorization?.decision ?? null,
      report_decision: loaded.retained.beforeLoadResult,
      ...(loaded.workspaceSelection ? { selection_ref: loaded.workspaceSelection.reference } : {}),
      ...(loaded.replacement ? { replacement: loaded.replacement.fence } : {}) };
  }
  const attachmentTarget = (target, id, revision) => ({ organizationId: target.organization_id,
    reportFileId: target.report_file_id, workflowType: 'custom_appraisal', workflowTargetId: Number(target.assignment_file_id),
    attachmentId: id, attachmentRevision: revision });
  const publicReplacement = fence => ({ kind: 'accepted_custom_reported_group', predecessor: fence.predecessor });
  async function reportedPredecessor(client, input, target) {
    // The workfile/assignment/report locks are already held in that order. Read
    // only the current operation pointer, then verify its immutable acceptance,
    // attachment, complete section and exact history via the existing readers.
    const rows = await client.query(`/* custom-cohort-capture:reported-predecessor */
      SELECT revision,CASE WHEN octet_length(section_value::text)<=4000000
        THEN section_value->>'operation_id' ELSE NULL END AS operation_id
      FROM app.custom_appraisal_workfile_sections
      WHERE assignment_file_id=$1::bigint AND section_key=$2 FOR SHARE NOWAIT`,
    [input.assignmentFileId, CUSTOM_NEIGHBORHOOD_ACCEPTED_SECTION]);
    if (rows?.rowCount !== 1 || rows.rows?.length !== 1
      || rows.rows[0].revision !== input.expectedEditorRevision
      || typeof rows.rows[0].operation_id !== 'string' || !UUID.test(rows.rows[0].operation_id)) fail('report_replacement_conflict');
    let accepted, stored;
    try {
      accepted = await getCustomNeighborhoodAcceptance(client, { organizationId: target.organization_id,
        reportFileId: target.report_file_id, assignmentFileId: Number(input.assignmentFileId), operationId: rows.rows[0].operation_id });
      if (!accepted) fail('report_replacement_conflict');
      stored = await getNeighborhoodAttachment(client, attachmentTarget(target, accepted.attachmentId, accepted.attachmentRevision));
    } catch (error) {
      // Preserve query cancellation/busy and other database failures; only the
      // existing integrity reader's fixed mismatch errors become this conflict.
      if (typeof error.code === 'string' && error.code.startsWith('custom_neighborhood_acceptance_')) fail('report_replacement_conflict');
      throw error;
    }
    const scope = Object.fromEntries(['organization_id', 'appraisal_case_id', 'subject_snapshot_id', 'account_id'].map(key => [key, target[key]]));
    if (!stored || stored.assessment.contract_version !== 2 || stored.attachment.mapper_version !== CUSTOM_REPORTED_OBSERVATION_MAPPER_VERSION
      || !same(stored.assessment.scope, scope) || accepted.acceptedEditorRevision !== input.expectedEditorRevision) fail('report_replacement_conflict');
    const descriptor = { acceptance_id: accepted.id, operation_id: accepted.operationId,
      accepted_editor_revision: accepted.acceptedEditorRevision, section_value_sha256: accepted.snapshot.section_value_sha256 };
    const fence = { predecessor: descriptor, section_history_id: accepted.sectionHistoryId,
      attachment_id: accepted.attachmentId, attachment_revision: accepted.attachmentRevision,
      application_identity_sha256: stored.attachment.application_identity_sha256,
      receipt_digest_sha256: accepted.snapshot.receipt.receipt_digest_sha256 };
    const existingValues = Object.values(accepted.snapshot.section_value.mapped_values).map(item => ({ ...item,
      target_exists: true, populated: true, provenance_digest: accepted.snapshot.receipt.acceptance_manifest.provenance_digest }));
    return { fence, stored, receipt: accepted.snapshot.receipt, existingValues };
  }
  async function storedReportProposal(client, input, target) {
    const scope = Object.fromEntries(['organization_id', 'appraisal_case_id', 'subject_snapshot_id', 'account_id']
      .map(key => [key, target[key]]));
    const rows = await client.query(`/* custom-cohort-capture:reported-operation */
      SELECT j.status,j.result_revision,j.input_signature_sha256,j.request_digest_sha256,
        r.request_digest_sha256 AS operation_digest,h.id AS assessment_id,
        j.effective_date::text,j.data_cutoff::text,j.max_attempts,
        CASE WHEN octet_length(j.request_payload::text)<=65536 THEN j.request_payload ELSE NULL END AS payload
      FROM app.neighborhood_assessment_requests r
      JOIN app.neighborhood_assessments h ON h.id=r.assessment_id
      JOIN app.neighborhood_assessment_jobs j ON j.id=r.job_id AND j.assessment_id=h.id
      WHERE h.organization_id=$1 AND h.appraisal_case_id=$2 AND h.subject_snapshot_id=$3 AND h.account_id=$4
        AND r.operation_id=$5`, [...Object.values(scope), input.proposalOperationId ?? input.operationId]);
    if (rows?.rowCount === 0 && rows.rows?.length === 0) return null;
    const row = one(rows), payload = row.payload;
    if (!payload || payload.proposal_version !== (input.replacement ? 2 : 1) || !same(payload.request, reportRequest(input, target))
      || row.status !== 'succeeded' || !Number.isInteger(row.result_revision) || row.result_revision < 1
      || row.max_attempts !== 3 || row.operation_digest !== row.request_digest_sha256
      || assessmentEvidenceDigest({ scope, effective_date: row.effective_date, data_cutoff: row.data_cutoff,
        input_signature_sha256: row.input_signature_sha256, payload, max_attempts: 3 }) !== row.request_digest_sha256) fail('operation_conflict');
    const stored = await getNeighborhoodAttachment(client, attachmentTarget(target, payload.attachment?.id, payload.attachment?.revision));
    if (!stored || stored.assessment.contract_version !== 2 || stored.assessment.id !== row.assessment_id
      || stored.assessment.revision !== row.result_revision || stored.assessment.input_signature_sha256 !== row.input_signature_sha256
      || stored.attachment.editor_revision !== input.expectedEditorRevision) fail('operation_conflict');
    if (input.replacement && (!payload.fences?.replacement
      || (input.proposalOperationId && !same(input.replacement, publicReplacement(payload.fences.replacement))))) fail('report_replacement_conflict');
    return { payload, stored };
  }
  async function loadReported(client, input, budget, { allowSigned = false, geography = true } = {}) {
    const workfile = await privateCaptureWorkfile(client, input);
    if (!allowSigned) privateDraft(workfile);
    const target = await resolveTarget(client, input, true, 'write', true);
    const scopeJson = canonicalAssessmentJson(Object.fromEntries(TARGET_FIELDS.map(key => [key, target[key]])));
    const workspace = await savedWorkspace(client, input);
    const exactSelection = workspace.checkpoint.workspace_version === 7;
    const currentInput = exactSelection ? { ...input,
      auth: await loadCurrentCustomCohortJobActor(client, input.auth.userId, target.organization_id) } : input;
    if (exactSelection) assertTarget(await resolveTarget(client, currentInput, true, 'write', true), target);
    const retained = await authorizedRetainedInputs(client, { scopeJson, reference: input.contextRef, input: currentInput,
      authorizeMarketData, authorizePrivateSales, budget, study: workspace.checkpoint.active,
      additionalExposures: exactSelection ? ['report_observation_catalog'] : [],
      beforeLoad: metadata => reportPermission(client, currentInput, metadata, budget) });
    const selection = await workspaceSelection(client, currentInput, { scopeJson, workspace, retained }, budget);
    const reportEditor = await reportEditorState(client, input), savedBoundary = await reportGeographyState(client, input);
    let reportGeography = null, derivedAt = null;
    if (geography) {
      derivedAt = new Date(Date.parse(await databaseTime(client))).toISOString();
      const admission = prepareCustomCohortReportGeography({ target: JSON.parse(scopeJson), ...savedBoundary,
        captured_at: derivedAt, retained_subject: retained.retained.retained_inputs.subject });
      reportGeography = completeCustomCohortReportGeography(admission, admission.geometry_for_validation === null ? null
        : await reportGeometryTopology(client, admission.geometry_for_validation, admission.subject_point_for_validation));
    }
    return { workfile, target, scopeJson, workspace, retained, reportEditor, savedBoundary, reportGeography, derivedAt,
      ...(selection ? { workspaceSelection: selection } : {}) };
  }
  async function recheckReported(client, input, loaded, budget, { acceptedReplay = false, editorAfterSave = false } = {}) {
    if (loaded.workspaceSelection) input = { ...input,
      auth: await loadCurrentCustomCohortJobActor(client, input.auth.userId, loaded.target.organization_id) };
    assertTarget(await resolveTarget(client, input, true, 'write', true), loaded.target);
    if (!same(await savedWorkspace(client, input), loaded.workspace)) fail('workspace_changed');
    await recheckWorkspaceSelection(client, input, loaded, budget);
    if (!editorAfterSave && !same(await reportEditorState(client, input), loaded.reportEditor)) fail('report_editor_changed');
    if (!same(await reportGeographyState(client, input), loaded.savedBoundary)) fail('report_geography_changed');
    if (loaded.replacement && !acceptedReplay && !editorAfterSave
      && !same((await reportedPredecessor(client, input, loaded.target)).fence, loaded.replacement.fence)) fail('report_replacement_conflict');
    if (!acceptedReplay && (await createCustomCohortSubjectRepository(client, loaded.scopeJson)
      .compareCurrent(loaded.retained.retained.subject_reference)).status !== 'matched') fail('subject_changed');
    const privateCapture = loaded.retained.retained.retained_inputs.private_sales?.capture;
    if (privateCapture) await recheckAssignmentSalesCsvCapture(client.query.bind(client), privateCapture);
    const decision = await boundedPolicy(authorizeMarketData, client, input.auth, loaded.retained.context,
      loaded.retained.purpose, budget);
    if (!same(decision, loaded.retained.decision)) fail('market_policy_changed');
    if (loaded.workspaceSelection && !same(await boundedPolicy(authorizeMarketData, client, input.auth,
      loaded.retained.context, loaded.retained.purpose, budget, 'report_observation_catalog'), loaded.retained.decision)) fail('market_policy_changed');
    await recheckPrivatePolicy(client, input, loaded.retained, budget,
      loaded.workspaceSelection ? ['none', 'report_observation_catalog'] : ['none']);
    if (!same(await reportPermission(client, input, loaded.retained, budget), loaded.retained.beforeLoadResult)) fail('report_policy_changed');
  }
  function proposalResponse(input, loaded, candidate, assessment, issues = [], reused = false) {
    const response = { status: candidate?.status === 'ready' ? 'proposed' : 'incomplete',
      target: { account_id: input.accountId, assignment_file_id: input.assignmentFileId }, context_ref: input.contextRef,
      workspace_section_revision: input.expectedWorkspaceRevision, editor_revision: input.expectedEditorRevision,
      proposal_operation_id: input.operationId, reused,
      ...(input.replacement ? { replacement: publicReplacement(loaded.replacement.fence) } : {}),
      attachment_ref: candidate?.status === 'ready' ? { attachment_id: candidate.attachment.attachment_id,
        attachment_revision: candidate.attachment.attachment_revision, binding_digest: candidate.attachment.binding_digest_sha256 } : null,
      assessment: assessment ? { contract_version: 2, assessment_id: assessment.id, revision: assessment.revision,
        status: assessment.application_group.status, basis: 'reported_observations_not_verified_market_facts',
        statistics: assessment.statistics, populations: assessment.populations.map(pop => Object.fromEntries(
          ['id', 'kind', 'member_unit', 'member_count', 'unique_account_count', 'account_link_count'].map(key => [key, pop[key]]))),
        geography_status: assessment.geographic_neighborhood.status,
        boundary: { geometry: assessment.geographic_neighborhood.geometry,
          cardinal_summaries: assessment.geographic_neighborhood.cardinal_summaries } } : null,
      issues: issues.map(item => ({ code: typeof item.code === 'string' && item.code.length <= 200
        && /^[a-zA-Z0-9_:.-]+$/.test(item.code) ? item.code : 'report_preparation_incomplete' })) };
    // A summary never transports sources, member arrays or original CSV rows.
    if (Buffer.byteLength(JSON.stringify(response)) > 524288) fail('report_response_limit');
    return freeze(response);
  }
  async function readPreparedCatalog(value, options, { catalogVersion, include, opening, groups, recommendedAreaOpening, manifestOpening }) {
    if (catalogVersion !== 3 || !include) return null;
    const input = previewInputOf(value), budget = operationBudget(options);
    // Catalog bindings describe an empty selection; a chosen group changes
    // only the opening summary and map, never the captured catalog itself.
    if (input.selection.pockets.length) return null;
    const timed = createCustomPreparedCatalogPhaseTiming();
    const cached = await transaction(pool, 'READ COMMITTED', budget, async client => {
      const resolved = await timed('target', async () => {
        const target = await resolveTarget(client, input, false, 'read');
        const scopeJson = canonicalAssessmentJson(Object.fromEntries(TARGET_FIELDS.map(key => [key, target[key]])));
        const catalogRepository = createCustomCohortPreparedCatalogRepository(client, scopeJson, input.contextRef);
        return await catalogRepository.exists() ? { target, scopeJson, catalogRepository } : null;
      });
      if (!resolved) return null;
      const { target, scopeJson, catalogRepository } = resolved;
      const licensed = await timed('authorization', () => authorizedRetainedInputs(client, { scopeJson, reference: input.contextRef, input,
        authorizeMarketData, authorizePrivateSales, budget, exposure: 'report_observation_catalog',
        additionalExposures: ['report_observation_summary'], privateSummary: true, loadInputs: false }));
      if (licensed.privateAuthorization) return null;
      const payload = await timed('catalog_read', () => catalogRepository.read());
      const mapManifest = manifestOpening && payload ? await timed('map_opening_read', () =>
        createCustomCohortPreparedMapOpeningRepository(client, scopeJson, input.contextRef).read(payload)) : null;
      const prepared = await timed('preview_read', () => createCustomCohortPreparedPreviewRepository(client, scopeJson, input.contextRef)
        .read({ includeMap: opening && !mapManifest, useVerifiedPreviewCache: true }));
      return payload && prepared ? { target, scopeJson, licensed, payload, prepared, mapManifest } : null;
    });
    if (!cached) return null;
    const response = await timed('projection', () => {
      const projection = createCustomPreparedCatalogProjectionTiming();
      budget.check();
      if (!same(cached.prepared.preview.observation_period, cached.licensed.observationPeriod)
        || cached.prepared.preview.effective_date !== cached.licensed.context.effective_date) fail('operation_conflict');
      const stable = projection('binding', () => rebindCustomCohortPreparedCatalog(cached.payload, input.selection.revision));
      const catalog = stable.catalog, recommendation = stable.recommendation;
      projection('membership', () => {
        const accounts = [...catalog.pockets.flatMap(pocket => pocket.account_ids), ...catalog.unassigned.account_ids].sort();
        if (!same(accounts, [...cached.prepared.preview.all.account_ids].sort())) fail('operation_conflict');
      });
      const expected = { context_ref: input.contextRef, selection_revision: input.selection.revision };
      const response = { status: 'catalog', target: { account_id: input.accountId,
        assignment_file_id: input.assignmentFileId }, ...expected, subject_freshness: 'matched',
        ...stable, apply: { status: 'blocked', reasons: ['observation_preview_only'] } };
      let openingBytes = 0;
      if (opening) {
        const selected = projection('opening_selection', () => {
          const areaIds = recommendedAreaOpening && recommendation?.sales_aware_area?.status !== 'unavailable'
            && recommendation?.sales_aware_area?.selected_recorded_group_ids?.length
            ? recommendation.sales_aware_area.selected_recorded_group_ids : null;
          return customCohortOpeningSelection(catalog,
            groups ?? areaIds ?? customCohortOpeningGroupIds(catalog), expected.selection_revision);
        });
        const preview = projection('observation_reselect', () => reselectCustomCohortIndexedObservationPreview(cached.prepared.preview, selected));
        const map = manifestOpening ? { status: 'omitted', reason: 'viewport_required' }
          : projection('map_select', () => selectCustomCohortPreparedParcelMap(cached.prepared.parcel_map, preview.selected.account_ids));
        response.initial_preview = { status: 'preview', target: response.target, ...expected,
          subject_freshness: 'matched', summary: projection('summary_projection', () => presentCustomCohortPreview({ preview, expected, includeNarrative: true })), parcel_map: map,
          ...(manifestOpening ? { map_manifest: projection('map_manifest', () => cached.mapManifest
            ?? buildCustomCohortMapManifest(catalog, cached.prepared.parcel_map)) } : {}),
          apply: { status: 'blocked', reasons: ['observation_preview_only'] } };
      }
      projection('transport_guard', () => {
        if (opening) {
          // The verified map byte count includes the changed selection flags.
          // Preserve the same exact envelope limit without stringifying all
          // retained coordinates again before the final HTTP serialization.
          const mapBytes = customCohortPreparedParcelMapJsonBytes(response.initial_preview.parcel_map);
          openingBytes = Buffer.byteLength(JSON.stringify({ ...response.initial_preview, parcel_map: null })) - 4 + mapBytes;
          if (openingBytes > CUSTOM_COHORT_OPENING_PREVIEW_BYTES) fail('catalog_transport_limit');
        }
        const { initial_preview: _opening, ...catalogOnly } = response;
        const catalogBytes = Buffer.byteLength(JSON.stringify(catalogOnly));
        // A JSON object with one added key grows by exactly this delimiter plus
        // the already-measured opening. Do not serialize the full map a second
        // time solely for its guard; the HTTP layer serializes after recheck.
        const responseBytes = catalogBytes + (opening ? Buffer.byteLength(',"initial_preview":') + openingBytes : 0);
        if (catalogBytes > CUSTOM_COHORT_POCKET_CATALOG_LIMITS.transport_output_utf8_bytes
          || responseBytes > (opening
            ? CUSTOM_COHORT_OPENING_RESPONSE_BYTES : CUSTOM_COHORT_POCKET_CATALOG_LIMITS.transport_output_utf8_bytes)) {
          fail('catalog_transport_limit');
        }
      });
      return response;
    });
    return timed('recheck', () => transaction(pool, 'READ COMMITTED', budget, async client => {
      assertTarget(await resolveTarget(client, input, true, 'read'), cached.target);
      if ((await createCustomCohortSubjectRepository(client, cached.scopeJson)
        .compareCurrent(cached.licensed.subjectReference)).status !== 'matched') fail('subject_changed');
      for (const exposure of ['report_observation_catalog', 'report_observation_summary']) {
        const decision = await boundedPolicy(authorizeMarketData, client, input.auth,
          cached.licensed.context, cached.licensed.purpose, budget, exposure);
        if (!same(decision, cached.licensed.decision)) fail('market_policy_changed');
      }
      budget.check();
      return freeze(response);
    }));
  }
  async function runPreview(value, options, { includeMap = true, exposure = 'none', additionalExposures = [], outputLimit = null,
    recommendedAreaOpening = false, preparedFast = false, preparedCatalog = false, manifestOpening = false, mapViewport = null, project } = {}) {
    const input = previewInputOf(value), budget = operationBudget(options);
    if (preparedFast) {
      const cached = await transaction(pool, 'READ COMMITTED', budget, async client => {
        const target = await resolveTarget(client, input, false, 'read');
        const scopeJson = canonicalAssessmentJson(Object.fromEntries(TARGET_FIELDS.map(key => [key, target[key]])));
        const licensed = await authorizedRetainedInputs(client, { scopeJson, reference: input.contextRef, input,
          authorizeMarketData, authorizePrivateSales, budget, exposure, additionalExposures,
          privateSummary: true, loadInputs: false });
        // Private supplemental sales still follow their exact retained-source
        // path. Never silently omit them from the selected preview.
        if (licensed.privateAuthorization) return null;
        const repository = createCustomCohortPreparedPreviewRepository(client, scopeJson, input.contextRef);
        let prepared = await repository.read({ includeMap: includeMap && !mapViewport,
          useVerifiedPreviewCache: true });
        let tiled = false;
        if (prepared && includeMap && mapViewport) {
          const tileMap = await repository.readViewportTiles(mapViewport, prepared.preview);
          if (tileMap) { prepared = { ...prepared, parcel_map: tileMap }; tiled = true; }
          else prepared = await repository.read({ includeMap: true, useVerifiedPreviewCache: true });
        }
        return prepared ? { target, scopeJson, licensed, prepared, tiled } : null;
      });
      if (cached) {
        budget.check();
        if (!same(cached.prepared.preview.observation_period, cached.licensed.observationPeriod)
          || cached.prepared.preview.effective_date !== cached.licensed.context.effective_date) fail('operation_conflict');
        const preview = reselectCustomCohortIndexedObservationPreview(cached.prepared.preview, input.selection);
        const expected = { context_ref: input.contextRef, selection_revision: input.selection.revision };
        const selectedMap = includeMap
          ? cached.tiled
            ? selectCustomCohortPreparedTileViewportMap(cached.prepared.parcel_map,
              preview.selected.account_ids, cached.prepared.preview.all.account_ids)
            : mapViewport
            ? selectCustomCohortPreparedParcelViewportMap(cached.prepared.parcel_map,
              preview.selected.account_ids, mapViewport)
            : selectCustomCohortPreparedParcelMap(cached.prepared.parcel_map, preview.selected.account_ids)
          : { status: 'omitted', reason: 'geometry_not_requested' };
        const content = { summary: presentCustomCohortPreview({ preview, expected, includeNarrative: true }), parcel_map: selectedMap };
        return transaction(pool, 'READ COMMITTED', budget, async client => {
          assertTarget(await resolveTarget(client, input, true, 'read'), cached.target);
          if ((await createCustomCohortSubjectRepository(client, cached.scopeJson)
            .compareCurrent(cached.licensed.subjectReference)).status !== 'matched') fail('subject_changed');
          const decision = await boundedPolicy(authorizeMarketData, client, input.auth,
            cached.licensed.context, cached.licensed.purpose, budget, exposure);
          if (!same(decision, cached.licensed.decision)) fail('market_policy_changed');
          for (const additional of additionalExposures) {
            const permitted = await boundedPolicy(authorizeMarketData, client, input.auth,
              cached.licensed.context, cached.licensed.purpose, budget, additional);
            if (!same(permitted, cached.licensed.decision)) fail('market_policy_changed');
          }
          budget.check();
          return freeze({ status: 'preview', target: { account_id: input.accountId,
            assignment_file_id: input.assignmentFileId }, ...expected,
            subject_freshness: 'matched', ...content,
            apply: { status: 'blocked', reasons: ['observation_preview_only'] } });
        });
      }
    }
    let catalogPhaseTiming = null;
    const timed = ['report_observation_catalog', 'report_observation_summary'].includes(exposure)
      ? createCustomPreviewPhaseTiming() : (_phase, work) => work();
    const loaded = await timed('load', () => transaction(pool, 'READ COMMITTED', budget, async client => {
      const target = await resolveTarget(client, input, false, 'read');
      const scopeJson = canonicalAssessmentJson(Object.fromEntries(TARGET_FIELDS.map(key => [key, target[key]])));
      return { target, scopeJson, ...await authorizedRetainedInputs(client, {
        scopeJson, reference: input.contextRef, input, authorizeMarketData, authorizePrivateSales, budget, exposure, additionalExposures, privateSummary: true,
      }) };
    }));
    // Pure presentation happens outside the source-read connection and before
    // the final authorization check. Only an explicitly requested recommendation
    // may run bounded native computation over retained EWKB in a separate RO
    // transaction; it never rereads source tables. Ordinary selection previews
    // and member inspection do not invoke this derivation or resend geometry.
    budget.check();
    // Public summaries/pages/catalogs consume a genuinely indexed internal
    // view. Keep the raw internal preview API's v1 shape and ceiling unchanged.
    const buildPreview = project ? buildCustomCohortIndexedObservationPreviewBatched : buildCustomCohortObservationPreview;
    const preview = await timed('assembly', () => buildPreview({ context_ref: input.contextRef,
      retained_inputs: loaded.retained.retained_inputs, selection: input.selection }, { check: budget.check }));
    budget.check();
    const parcelMap = includeMap ? await timed('map', () => buildCustomCohortParcelMapBatched({ retained_inputs: loaded.retained.retained_inputs,
      selected_account_ids: [...new Set(input.selection.pockets.flatMap(pocket => pocket.account_ids))] }, { check: budget.check }))
      : { status: 'omitted', reason: 'geometry_not_requested' };
    const expected = { context_ref: input.contextRef, selection_revision: input.selection.revision };
    const deriveProximity = () => transaction(pool, 'REPEATABLE READ READ ONLY', budget,
      client => deriveCustomCohortRecordedProximity((sql, parameters) => client.query(sql, parameters),
        { context_ref: input.contextRef, retained_inputs: loaded.retained.retained_inputs },
        { deadline: budget.deadline, signal: budget.signal }));
    // A failed optional prepared lookup must not poison the existing
    // proximity transaction or the complete retained recommendation.
    const deriveSecondary = () => transaction(pool, 'REPEATABLE READ READ ONLY', budget,
      client => readCustomCohortPreparedSecondaryFacts(client.query.bind(client), loaded.retained.retained_inputs));
    const privateCapture = loaded.retained.retained_inputs.private_sales?.capture;
    let preparedOpening = null;
    const privateFor = (selection, view) => {
      const observations = privateCapture ? buildCustomCohortPrivateSalesObservations({ supplement: privateCapture,
      context_ref: input.contextRef, effective_date: loaded.context.effective_date,
      observation_period: loaded.retained.study.observation_period,
      selection: { revision: selection.revision, account_ids: [...new Set(selection.pockets.flatMap(pocket => pocket.account_ids))].sort() } }) : null;
      return observations ? presentCustomCohortPrivateSalesObservations({ observations,
        binding: customCohortPreviewBinding(view, expected) }) : null;
    };
    const envelope = content => ({ status: 'preview', target: { account_id: input.accountId, assignment_file_id: input.assignmentFileId },
      ...expected, subject_freshness: 'matched', ...content, apply: { status: 'blocked', reasons: ['observation_preview_only'] } });
    // The optional opening projection shares ONLY this request's fully checked
    // retained graph. Its map/private rows/statistics use one exact union. Both
    // exposure grants and fresh material/assignment checks still gate delivery.
    const presentOpening = async selection => {
      const checked = previewInputOf({ ...input, selection }).selection;
      if (checked.revision !== input.selection.revision) fail('invalid_selection');
      // The catalog already built this immutable, exact observation index.
      // Reuse its members for the opening union rather than walking/hashing
      // the complete retained graph a second time. Final policy checks remain
      // below, and geometry still comes from the original retained parcels.
      budget.check();
      const selected = reselectCustomCohortIndexedObservationPreview(preview, checked);
      budget.check();
      const map = await buildCustomCohortParcelMapBatched({ retained_inputs: loaded.retained.retained_inputs,
        selected_account_ids: [...new Set(checked.pockets.flatMap(p => p.account_ids))] }, { check: budget.check });
      if (map.status === 'available') preparedOpening = { preview: selected, map };
      const privateSales = privateFor(checked, selected);
      const result = envelope({ summary: presentCustomCohortPreview({ preview: selected, expected, includeNarrative: true }), parcel_map: map,
        ...(privateSales ? { private_sales: privateSales } : {}) });
      if (Buffer.byteLength(JSON.stringify(result)) > CUSTOM_COHORT_OPENING_PREVIEW_BYTES) fail('catalog_transport_limit');
      return result;
    };
    const content = project ? await timed('projection', () => project(preview, expected, parcelMap, loaded.retained.retained_inputs,
      deriveProximity, presentOpening, budget.check, deriveSecondary, timing => { catalogPhaseTiming = timing; }))
      : { preview, parcel_map: parcelMap };
    const privatePresentation = privateFor(input.selection, preview);
    budget.check();
    const response = await timed('authorization', () => transaction(pool, 'READ COMMITTED', budget, async client => {
      assertTarget(await resolveTarget(client, input, true, 'read'), loaded.target);
      if ((await createCustomCohortSubjectRepository(client, loaded.scopeJson)
        .compareCurrent(loaded.retained.subject_reference)).status !== 'matched') fail('subject_changed');
      const decision = await boundedPolicy(authorizeMarketData, client, input.auth, loaded.context, loaded.purpose, budget, exposure);
      if (!same(decision, loaded.decision)) fail('market_policy_changed');
      for (const additional of additionalExposures) {
        const permitted = await boundedPolicy(authorizeMarketData, client, input.auth, loaded.context, loaded.purpose, budget, additional);
        if (!same(permitted, loaded.decision)) fail('market_policy_changed');
      }
      await recheckPrivatePolicy(client, input, loaded, budget, [...new Set([exposure, ...additionalExposures, 'report_observation_summary'])]);
      let response = envelope({ ...content, ...(privatePresentation ? { private_sales: privatePresentation } : {}) });
      if ([2, 3].includes(content.recommendation?.presentation_version)) {
        // The prepared-CAD overlay is disposable display support. Never drop
        // the established recommendation or exact opening just to carry it.
        const { initial_preview: _openingForOverlay, ...catalogWithOverlay } = response;
        if (Object.hasOwn(response, 'prepared_secondary_map')
          && Buffer.byteLength(JSON.stringify(catalogWithOverlay)) > CUSTOM_COHORT_POCKET_CATALOG_LIMITS.transport_output_utf8_bytes) {
          const { prepared_secondary_map: _overlay, ...withoutOverlay } = response;
          response = withoutOverlay;
        }
        const { initial_preview: _opening, ...catalogWithPrivateSales } = response;
        if (Buffer.byteLength(JSON.stringify(catalogWithPrivateSales)) > CUSTOM_COHORT_POCKET_CATALOG_LIMITS.transport_output_utf8_bytes) {
          // Final envelope accounting includes private-source summaries and owner
          // metadata. Keep the exact catalog/opening; omit only the whole optional
          // recommendation, never a subset of its groups or a private observation.
          const { recommendation: _recommendation, prepared_secondary_map: _overlay, ...withoutRecommendation } = response;
          response = withoutRecommendation;
          if (recommendedAreaOpening && Object.hasOwn(response, 'initial_preview')) {
            // A dropped recommendation cannot leave behind its private subset
            // preview: the client would restore the complete-catalog fallback.
            response.initial_preview = await catalogPhaseTiming('fallback_opening', () => presentOpening(customCohortOpeningSelection(response.catalog,
              customCohortOpeningGroupIds(response.catalog), expected.selection_revision)));
          }
        }
      }
      if (Object.hasOwn(content, 'initial_preview')) {
        const { initial_preview: _opening, ...catalogOnly } = response;
        if (Buffer.byteLength(JSON.stringify(catalogOnly)) > CUSTOM_COHORT_POCKET_CATALOG_LIMITS.transport_output_utf8_bytes) fail('catalog_transport_limit');
      }
      if (manifestOpening && response.initial_preview?.parcel_map?.status === 'available') {
        // A first authorized replay must honor the same geometry-free opening
        // as its prepared-cache reopens. Keep the original map internally for
        // write-through and viewport tiles; only its wire projection changes.
        response = { ...response, initial_preview: { ...response.initial_preview,
          map_manifest: buildCustomCohortMapManifest(response.catalog, response.initial_preview.parcel_map),
          parcel_map: { status: 'omitted', reason: 'viewport_required' } } };
      }
      if (outputLimit !== null && Object.hasOwn(response, 'prepared_secondary_map')
        && Buffer.byteLength(JSON.stringify(response)) > outputLimit) {
        const { prepared_secondary_map: _overlay, ...withoutOverlay } = response;
        response = withoutOverlay;
      }
      if (outputLimit !== null && Buffer.byteLength(JSON.stringify(response)) > outputLimit) fail('catalog_transport_limit');
      return freeze(response);
    }));
    let preparedCandidate = preparedOpening ?? (preparedFast && includeMap
      && content.parcel_map?.status === 'available' ? { preview, map: content.parcel_map } : null);
    if (!preparedCandidate && preparedFast && !includeMap && !loaded.privateAuthorization
      && budget.deadline - performance.now() > 7000) {
      // A saved opening may have used nearly its entire budget and missed its
      // write-through. Subsequent clicks request statistics only because the
      // browser already holds geometry. Prepare that geometry once from the
      // same authorized original graph so later clicks can use the fast path.
      try {
        const map = await buildCustomCohortParcelMapBatched({ retained_inputs: loaded.retained.retained_inputs,
          selected_account_ids: preview.selected.account_ids }, { check: budget.check });
        if (map.status === 'available') preparedCandidate = { preview, map };
      } catch { /* The exact response remains valid; no partial cache is stored. */ }
    }
    if (preparedCandidate && !loaded.privateAuthorization && budget.deadline - performance.now() > 3000) {
      // Optional write-through after a fully authorized original replay. Failure
      // leaves the exact response intact; later requests still use originals.
      try {
        await transaction(pool, 'READ COMMITTED', budget, async client => {
          const repository = createCustomCohortPreparedPreviewRepository(client, loaded.scopeJson, input.contextRef);
          if (!await repository.exists()) await repository.put(preparedCandidate.preview, preparedCandidate.map);
        });
      } catch (error) {
        // The optional cache must never change an authorized response, but a
        // silent failure would make every later click repeat the expensive
        // original replay. Emit only a bounded reason, never evidence/identity.
        const reason = /^custom_cohort_prepared_preview_[a-z_]+$/.test(error?.message)
          ? error.message : typeof error?.code === 'string' && /^[A-Z0-9_]{1,20}$/.test(error.code)
            ? error.code : 'unavailable';
        console.warn('[neighborhood] prepared-preview-write', { outcome: 'skipped', reason });
      }
    }
    if (preparedCatalog && !loaded.privateAuthorization && input.selection.pockets.length === 0
      && response.catalog?.catalog_complete === true && budget.deadline - performance.now() > 3000) {
      // Store no initial selection, private observations or authority. A later
      // opening derives its own exact union from the numeric/map read model.
      const publicCatalog = { catalog: response.catalog,
        ...(response.discovery ? { discovery: response.discovery } : {}),
        ...(response.recommendation ? { recommendation: response.recommendation } : {}),
        ...(response.prepared_secondary_map ? { prepared_secondary_map: response.prepared_secondary_map } : {}) };
      try {
        await transaction(pool, 'READ COMMITTED', budget, async client => {
          const repository = createCustomCohortPreparedCatalogRepository(client, loaded.scopeJson, input.contextRef);
          if (!await repository.exists({ currentOnly: true })) await repository.put(publicCatalog);
        });
      } catch (error) {
        const reason = /^custom_cohort_prepared_catalog_[a-z_]+$/.test(error?.message)
          ? error.message : typeof error?.code === 'string' && /^[A-Z0-9_]{1,20}$/.test(error.code)
            ? error.code : 'unavailable';
        console.warn('[neighborhood] prepared-catalog-write', { outcome: 'skipped', reason });
      }
    }
    return response;
  }
  /** One named internal stage owns its flags and phase admission. Every source
   * read/write is fenced by current rights at both transaction ends. V2 prefix
   * DATA has no verifier/typed/metric flags or legacy receipt conversion. */
  async function frozenCaptureJobSourceStage(value, options = {}, stage = 'prefix_v1') {
    if(typeof stage!=='string'||!Object.hasOwn(FROZEN_SOURCE_STAGES,stage))
      fail('frozen_source_representation_unsupported');
    const {referencesV2=false,issuingSourcePrefix=false,yieldingSourcePrefix=false,verifying=false,stockVerifying=false,identityVerifying=false,yieldingEarlyProgress=false,
      typing=false,readingStockMetrics=false,readingSharedStockMetrics=false,neutralSharedMetrics=false,cachingNeutralOriginals=false,yieldingNeutralProgress=false,
      readingCadPages=false,projectingCadAccounts=false,reconcilingCadAccounts=false,cachingCadOriginals=false,cachingCadCoverage=false,yieldingCadProgress=false,readingCoveredCadAmenities=false,resolvingCadAmenities=false,readingTransactionPages=false,projectingTransactionTemporal=false,
      readingTransactionPackages=false,reconcilingTransactionPackages=false,readingStockOriginalCells=false,readingStockAccountPackages=false,readingStockWholeAccountBatch=false,coveredNeutralOriginals=false,cacheStockHandoff=false,
      resolvingStockAccountHousing=false,resolvingStockAccountRecordedGroup=false,traversingStock=false,batchingStock=false,partitioningRecordedGroups=false,
      readingRecordedPartition=false,readingRecordedCatalog=false,readingSelectionWorkspaceTarget=false,yieldingV2Progress=false,catalogingRecordedGroups=false,awaitingSelection=false,selectingCatalogIntent=false,readingRetainedSelectionIntent=false,replayingSelectedUnion=false,readingSelectedUnionSubjectHousing=false,readingSelectedUnionFirstEligibility=false,readingSelectedUnionFirstAmenities=false,readingSelectedUnionFirstTransactions=false,progressingSelectedEligibility=false,progressingSelectedEvidence=false,readingSelectedMetricSource=false,progressingSelectedMetrics=false,readingSelectedStatisticsSource=false,progressingSelectedStatistics=false,readingSelectedFrequencySource=false,readingSelectedNumericSource=false,progressingSelectedNumeric=false,readingSelectedRankCandidates=false,progressingSelectedSemantic=false,readingSelectedTransactionSource=false,preparingSelectedTransactionFirstCandidate=false,readingSelectedTransactionIndex=false,progressingSelectedTransactionIndex=false,allowedPhases}=FROZEN_SOURCE_STAGES[stage];
    const readingCadSource=readingCadPages||readingSelectedUnionFirstAmenities;
    if(referencesV2){
      if(!options||utilTypes.isProxy(options)||Object.getPrototypeOf(options)!==Object.prototype)fail('invalid_options');
      const descriptors=Object.getOwnPropertyDescriptors(options),keys=Reflect.ownKeys(descriptors);
      const admittedKeys=[...(selectingCatalogIntent?['selectionIntent']:['captureJobClaim']),'signal','deadline',...(readingSharedStockMetrics?['stockMetricPage']:[]),
        ...(readingCadPages&&!cachingCadCoverage?[reconcilingCadAccounts?'cadAccountPackagePage':projectingCadAccounts?'cadAccountPage':'cadImprovementPage']:[]),
        ...(readingTransactionPages?['transactionPage']:[]),...(readingTransactionPackages?['transactionPackagePage']:[]),
        ...(readingStockOriginalCells?['stockOriginalCellPage']:[]),...(readingStockAccountPackages?['stockAccountPackagePage']:[])];
      if(keys.some(key=>!admittedKeys.includes(key)
        ||!descriptors[key].enumerable||!Object.hasOwn(descriptors[key],'value')))fail('invalid_options');
      options=Object.fromEntries(keys.map(key=>[key,descriptors[key].value]));
    }
    if (!options || Object.getPrototypeOf(options)!==Object.prototype) fail('invalid_options');
    const {captureJobClaim:providedClaim,selectionIntent:providedIntent,stockMetricPage,cadImprovementPage,cadAccountPage,cadAccountPackagePage,transactionPage,transactionPackagePage,stockOriginalCellPage,stockAccountPackagePage,...budgetOptions}=options;
    if(!selectingCatalogIntent&&providedIntent!==undefined)fail('invalid_options');
    const selectionIntent=selectingCatalogIntent?prepareCustomCohortV2SelectionIntent(providedIntent):null;
    const metricPage=readingStockMetrics||readingSharedStockMetrics?prepareNeighborhoodFrozenStockMetricPage(stockMetricPage):null;
    const cadPage=readingCadPages&&!cachingCadCoverage?reconcilingCadAccounts?prepareNeighborhoodOriginalCadAccountPackagePageV2(cadAccountPackagePage)
      :projectingCadAccounts?prepareNeighborhoodSharedJobCadAccountPage(cadAccountPage)
      :prepareNeighborhoodSharedJobCadPage(cadImprovementPage):null;
    const transactionInput=readingTransactionPages?prepareNeighborhoodSharedTransactionPageV2(transactionPage):null;
    const packageInput=readingTransactionPackages?prepareNeighborhoodTransactionPackagePageV1(transactionPackagePage):null;
    const originalCellInput=readingStockOriginalCells?prepareNeighborhoodStockOriginalCellPageV2(stockOriginalCellPage):null;
    const stockAccountInput=readingStockAccountPackages?prepareNeighborhoodStockAccountPackagePageV2(stockAccountPackagePage):null;
    if(!readingStockMetrics&&!readingSharedStockMetrics&&stockMetricPage!==undefined) fail('invalid_options');
    if(!readingCadPages&&cadImprovementPage!==undefined)fail('invalid_options');
    if(!readingTransactionPages&&transactionPage!==undefined)fail('invalid_options');
    if(!readingTransactionPackages&&transactionPackagePage!==undefined)fail('invalid_options');
    if(!readingStockOriginalCells&&stockOriginalCellPage!==undefined)fail('invalid_options');
    if(!readingStockAccountPackages&&stockAccountPackagePage!==undefined)fail('invalid_options');
    const originalInput=inputOf(value);
    if((readingRetainedSelectionIntent||replayingSelectedUnion)&&utilTypes.isProxy(providedClaim))fail('invalid_options');
    let claim=selectingCatalogIntent?null:prepareCustomCohortCaptureJobClaim(providedClaim);
    if(claim&&claim.operation_id!==originalInput.operationId.toLowerCase()) fail('operation_conflict');
    if(!reportedProfile) fail('frozen_source_profile_unsupported');
    if(originalInput.privateSalesImport || originalInput.discovery?.profile_id!=='custom-suburban-radius-v2') fail('frozen_discovery_unsupported');
    if(readingCadSource&&typeof authorizeCadImprovementData!=='function')fail('CAD_source_policy_required');
    const boundedOriginalAccountOwner=cachingCadCoverage||cachingCadOriginals||cachingNeutralOriginals||coveredNeutralOriginals||traversingStock||partitioningRecordedGroups||readingRecordedPartition||catalogingRecordedGroups;
    const budget=operationBudget(budgetOptions,boundedOriginalAccountOwner
      ?CUSTOM_COHORT_ORIGINAL_ACCOUNT_OWNER_LIMITS.operation_ms:LIMITS.capture_duration_ms);
    return transaction(pool,'READ COMMITTED',budget,async transactionClient=>{
      const client=cachingCadCoverage||cachingCadOriginals||cachingNeutralOriginals?createCustomCohortNeutralCacheOwnerBudget(transactionClient,{checkBudget:budget.check})
        :boundedOriginalAccountOwner?createCustomCohortOriginalAccountOwnerBudget(transactionClient,{checkBudget:budget.check}):transactionClient;
      const locator=one(await client.query(`/* custom-cohort-capture:job-organization */
        SELECT organization_id FROM app.assignment_files WHERE id=$1::bigint AND account_id=$2`,
      [originalInput.assignmentFileId,originalInput.accountId]));
      let input=freeze({...originalInput,operationId:originalInput.operationId.toLowerCase(),
        auth:await loadCurrentCustomCohortJobActor(client,originalInput.auth.userId,locator.organization_id)});
      privateDraft(await privateCaptureWorkfile(client,input));
      const target=await resolveTarget(client,input,true),scope=Object.fromEntries(TARGET_FIELDS.map(key=>[key,target[key]]));
      const jobs=createCustomCohortCaptureJobRepository(client),jobOptions={scope,actorUserId:input.auth.userId};
      const requested={operation_id:input.operationId,observation_period:input.observationPeriod,discovery:input.discovery};
      let selectionWorkspaceTarget=null,issuedSelectionIntent=null;
      if(selectingCatalogIntent){
        authorizePublicCadastralCatalogRead(input.auth,input.accountId,{workflows:['custom_appraisal'],
          permissionChecker:(auth,workflow,permission)=>hasApplicationPermission(auth,workflow,permission,scope.organization_id)});
        // The authenticated principal is supplied by the HTTP owner, never body
        // auth. Both current DB authorization and the exact pending V7/prior
        // head precede a provisional immutable command/fresh lease. Every later
        // original and ending refusal rolls BOTH back in this same transaction.
        selectionWorkspaceTarget=await readCustomCohortFrozenSelectionWorkspaceTarget({
          client,input,scopeJson:canonicalAssessmentJson(scope),checkBudget:budget.check});
        issuedSelectionIntent=await createCustomCohortV2SelectionIntentRepository(client).resume(input.operationId,
          {...jobOptions,intent:selectionIntent,workspaceTarget:selectionWorkspaceTarget});
        claim=issuedSelectionIntent.claim;
      }
      if(!sameFrozenRequest(await jobs.readRequest(claim,jobOptions),requested)) fail('operation_conflict');
      // This is one manual cache operation, not durable automatic coverage.
      // An enrolled job must wait for a separately guarded CAD success bridge.
      const cadContinuation=yieldingCadProgress?createCustomCohortCadCacheV2ContinuationRepository(client):null;
      const assertManualCadCache=async()=>{if((cachingCadCoverage||cachingCadOriginals)&&!yieldingCadProgress){
        const manualResult=await client.query(`/* custom-cohort-CAD-cache-account-v2:manual */
          SELECT job.request_payload->>'execution_mode' IS NULL
            AND NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_v2_continuations c WHERE c.operation_id=job.operation_id) AS allowed
          FROM app.neighborhood_custom_cohort_capture_jobs job WHERE job.operation_id=$1::uuid
            AND job.claim_token=$2::uuid AND job.attempts=$3::integer AND job.status='running'
            AND job.lease_expires_at>clock_timestamp() AND job.cancellation_requested_at IS NULL`,
        [claim.operation_id,claim.claim_token,claim.attempts]);
        if(manualResult?.rowCount!==1||!Array.isArray(manualResult.rows)||manualResult.rows.length!==1)
          throw new TypeError('custom_cohort_capture_job_claim_lost');
        const manual=manualResult.rows[0];
        if(manual.allowed!==true)fail('CAD_automatic_handoff_unavailable');
      }};
      await assertManualCadCache();
      if(cadContinuation)await cadContinuation.assertClaim(claim,jobOptions);
      if(batchingStock||readingStockWholeAccountBatch||readingSelectionWorkspaceTarget||awaitingSelection||readingRetainedSelectionIntent||replayingSelectedUnion){
        if(readingRetainedSelectionIntent||replayingSelectedUnion)authorizePublicCadastralCatalogRead(input.auth,input.accountId,{workflows:['custom_appraisal'],
          permissionChecker:(auth,workflow,permission)=>hasApplicationPermission(auth,workflow,permission,scope.organization_id)});
        selectionWorkspaceTarget=await readCustomCohortFrozenSelectionWorkspaceTarget({
          client,input,scopeJson:canonicalAssessmentJson(scope),checkBudget:budget.check});
      }
      const checkpoint=await jobs[readingSelectedTransactionIndex?'readTransactionIndexCheckpoint':'readCheckpoint'](claim,jobOptions);
      if(!checkpoint || !allowedPhases.includes(checkpoint.phase)
        ||checkpoint.evidence_refs.length!==({frozen_stock_v1:2,frozen_source_v1:3,frozen_source_refs_v2:3,frozen_verify_refs_v2:4,frozen_geo_verify_refs_v2:5,frozen_identity_refs_v2:6,frozen_stock_traversal_refs_v2:7,frozen_recorded_partition_refs_v2:8,frozen_recorded_catalog_refs_v2:9,frozen_selected_union_refs_v2:10,frozen_selected_eligibility_refs_v2:11,frozen_selected_evidence_refs_v2:12,frozen_selected_metrics_refs_v2:13,frozen_selected_statistics_refs_v2:14,frozen_selected_numeric_refs_v2:15,frozen_selected_semantic_refs_v2:16,frozen_selected_transaction_index_refs_v2:17,frozen_verify_v1:4,frozen_geo_verify_v1:5,frozen_identity_v1:6,frozen_typed_v1:7}[checkpoint.phase]))
        fail('checkpoint_conflict');
      const subjects=createCustomCohortSubjectRepository(client,canonicalAssessmentJson(scope));
      const blobs=createNeighborhoodCohortBlobRepository(client,scope.organization_id);
      const study=freeze({profile_id:input.discovery.profile_id,discovery:input.discovery,
        observation_period:input.observationPeriod,knowledge_cutoff:null});
      const retained=await resumeCustomCohortSubjectCheckpoint({checkpoint:{phase:'subject',evidence_refs:[checkpoint.evidence_refs[0]]},
        blobs,subjects,input,study,reportedProfile,housingProfile});
      authorizePublicCadastralCatalogRead(input.auth,input.accountId,{workflows:['custom_appraisal'],
        permissionChecker:(auth,workflow,permission)=>hasApplicationPermission(auth,workflow,permission,scope.organization_id)});
      const stockOptions={claim,scope,actorUserId:input.auth.userId,geometryInput:retained.point.geometry_input,
        discovery:input.discovery,subjectIntent:retained.intent.reference,checkBudget:budget.check};
      const stockStore=createNeighborhoodFrozenJobStock(client,stockOptions),stock=await stockStore.read();
      const stockReference=checkpoint.evidence_refs[1];
      const stockBody={stock_stage_version:1,usage:'frozen_job_stock_only',subject_intent:retained.intent.reference,stock};
      if(await blobs.get(stockReference.content_sha256,stockReference.canonical_utf8_bytes)!==canonicalAssessmentJson(stockBody)) fail('checkpoint_conflict');
      // Explicit versioned selection preimage: actual owner-selected SQL
      // stock, scope, generation, original header/point definition and subject.
      // The old <=50k array/capability is never minted, spoofed or widened.
      const selection=freeze({selection_version:'frozen_job_stock_source_v1',scope,operation_id:input.operationId,
        subject_intent:retained.intent.reference,stock_reference:stockReference,generation_id:stock.generation_id,
        spatial_definition_sha256:stock.definition_sha256,source_original_sha256:stock.source_original_sha256,
        stock_population:stock.population});
      const context=contextOf(retained.subject),purpose=describeNeighborhoodCombinedEvidenceMarketDataPurpose({
        selection_sha256:assessmentEvidenceDigest(selection),effective_date:context.effective_date,
        observation_period:input.observationPeriod,knowledge_cutoff:null});
      // Same independently approved fixed mapping5/witness2, immutable
      // retention and all-date one-hop fields. Retained grant metadata is not
      // authority: current policy must allow before any licensed original.
      const decision=await boundedPolicy(authorizeMarketData,client,input.auth,context,purpose,budget);
      // Dormant early owners enroll only AFTER current actor/assignment/draft/
      // subject and source permission, before actual independently guarded DML.
      // Native deferred obligations reject an orphan progress COMMIT. The
      // ordinary explicit verification entry points retain their old contract.
      if(yieldingEarlyProgress)await createCustomCohortV2ContinuationRepository(client).beginEarlyIssued(claim,jobOptions);
      if(readingRetainedSelectionIntent)issuedSelectionIntent=await createCustomCohortV2SelectionIntentRepository(client)
        .readRetained(claim,{...jobOptions,workspaceTarget:selectionWorkspaceTarget});
      if(replayingSelectedUnion)issuedSelectionIntent=await createCustomCohortV2SelectionIntentRepository(client)
        [readingSelectedTransactionIndex?'readForTransactionIndex':readingSelectedTransactionSource?'readForTransactionSource':progressingSelectedSemantic?'readForSemanticStatistics':progressingSelectedNumeric||readingSelectedRankCandidates?'readForNumericPopulation':readingSelectedFrequencySource?'readForFrequencies':progressingSelectedStatistics?'readForStatisticsContributions':readingSelectedStatisticsSource?'readForStatistics':progressingSelectedMetrics?'readForMetrics':progressingSelectedEvidence||readingSelectedMetricSource?'readForEvidence':progressingSelectedEligibility?'readForEligibility':'readForReplay'](claim,{...jobOptions,workspaceTarget:selectionWorkspaceTarget});
      // Never let an early known-ID error become a revoked-license catalog
      // oracle. This fixed lookup is permitted only AFTER current source policy
      // at BOTH ends. Choices come from the immutable native command, not body
      // IDs; existence is structural intent admission, NOT group semantics.
      const checkSelectionIntentKnownGroups=async()=>{
        const row=one(await client.query(`/* custom-cohort-v2-selection-intent:known-groups */
          SELECT NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(command.included_group_ids) AS ids(id)
            WHERE NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_recorded_catalog_v2_groups g
              WHERE g.operation_id=job.operation_id AND g.organization_id=job.organization_id AND g.group_id=id)) AS known
          FROM app.neighborhood_custom_cohort_capture_jobs job
          JOIN app.neighborhood_custom_cohort_v2_selection_intents command USING(operation_id,organization_id)
          WHERE job.operation_id=$1::uuid AND job.claim_token=$2::uuid AND job.attempts=$3::integer
            AND job.organization_id=$4::uuid AND job.report_file_id=$5::uuid AND job.assignment_file_id=$6::bigint
            AND job.account_id=$7 AND job.actor_user_id=$8::uuid AND job.status='running'
            AND job.lease_expires_at>clock_timestamp() AND job.cancellation_requested_at IS NULL`,
        [claim.operation_id,claim.claim_token,claim.attempts,scope.organization_id,scope.report_file_id,scope.assignment_file_id,
          scope.account_id,input.auth.userId]));
        if(row.known!==true)fail('selection_group_unavailable');
      };
      if(selectingCatalogIntent||readingRetainedSelectionIntent||replayingSelectedUnion)await checkSelectionIntentKnownGroups();
      // The old seven-layer grant cannot authorize the companion projection.
      // This exact additional purpose is derived only from the actual reopened
      // stock/subject/selection, never a caller grant, date, field list or head.
      const cadPurpose=readingCadSource?describeNeighborhoodCadImprovementPurpose({
        selection_sha256:assessmentEvidenceDigest(selection),generation_id:stock.generation_id}):null;
      const cadDecision=readingCadSource?await boundedPolicy(authorizeCadImprovementData,client,input.auth,context,cadPurpose,budget):null;
      if(readingCadSource&&!/^custom-neighborhood-cad-improvement-source-rights-v1:sha256:[a-f0-9]{64}$/.test(cadDecision.policy_revision))
        fail('CAD_source_policy_required');
      // Tenth and inactive NEXT readers: load only their FIXED issued progress
      // receipts through the existing eight-record/2MB reader. These are NOT
      // population/source originals or authority. Each actual native head is
      // still checked BEFORE using its body below, and every original/ENTIRE
      // cache replay plus all ending head/rights checks remain independent.
      // Never wrap blobs.get or the original graph adapter in this small buffer.
      const issuedCheckpointReceipts=progressingSelectedSemantic?checkpoint.evidence_refs.slice(3):null,
        issuedCheckpointTexts=[];
      if(issuedCheckpointReceipts){
        if((readingSelectedTransactionIndex?![13,14].includes(issuedCheckpointReceipts.length):![12,13].includes(issuedCheckpointReceipts.length))
          ||issuedCheckpointReceipts.some(ref=>Number(ref.canonical_utf8_bytes)>16000))fail('checkpoint_conflict');
        for(let offset=0;offset<issuedCheckpointReceipts.length;offset+=NEIGHBORHOOD_COHORT_BLOB_READ_BATCH_LIMITS.records){
          const prepared=await blobs.getPreparedBatch(issuedCheckpointReceipts.slice(offset,
            offset+NEIGHBORHOOD_COHORT_BLOB_READ_BATCH_LIMITS.records));
          for(const body of prepared){if(body===null)fail('checkpoint_conflict');issuedCheckpointTexts.push(body.canonicalJson);}
        }
        Object.freeze(issuedCheckpointReceipts);Object.freeze(issuedCheckpointTexts);
      }
      const readIssuedCheckpointReceipt=async ref=>{
        if(issuedCheckpointReceipts===null)return blobs.get(ref.content_sha256,ref.canonical_utf8_bytes);
        const index=issuedCheckpointReceipts.findIndex(expected=>same(expected,ref));
        if(index<0)fail('checkpoint_conflict');return issuedCheckpointTexts[index];
      };
      const binding={...scope,operation_id:input.operationId,generation_id:stock.generation_id,
        spatial_definition_sha256:stock.definition_sha256,source_original_sha256:stock.source_original_sha256};
      if(yieldingSourcePrefix)await createCustomCohortSourcePrefixV2ContinuationRepository(client).beginIssued(claim,jobOptions);
      const sourcePrefixStore=issuingSourcePrefix?createCustomCohortSourcePrefixV2Repository({client,claim,scope,actorUserId:input.auth.userId}):null;
      let sourcePrefixHead=sourcePrefixStore?await sourcePrefixStore.read():null;
      if(issuingSourcePrefix&&(checkpoint.phase==='frozen_stock_v1'?sourcePrefixHead!==null
        :sourcePrefixHead===null||!same(sourcePrefixHead.source_reference,checkpoint.evidence_refs[2])))fail('checkpoint_conflict');
      const sourceVersion=referencesV2?2:1,sourceUsage=referencesV2?'frozen_source_reference_prefix_only':'frozen_source_prefix_only';
      const sourcePhase=referencesV2?'frozen_source_refs_v2':'frozen_source_v1';
      const chain=referencesV2?createCohortOriginalSourceReferencesV2Store(
        {put:text=>blobs.put(text),get:(hash,size)=>blobs.get(hash,size)},binding,{
          signal:budget.signal,checkBudget:budget.check,
          // Fixed old indexed closure against THIS live claim and pinned stock.
          // No caller callback, SQL plan, current/latest generation or fallback.
          // Prefix append/describe never invokes this adapter. The explicit
          // V2 graph owner starts at real heads and follows issued edges only.
          async readOriginal(request){
            if(request.plan!=='neighborhood_frozen_job_closure_v1')fail('checkpoint_conflict');
            const page=await createNeighborhoodFrozenJobSourcePages(client,{...stockOptions,signal:budget.signal})
              .page({kind:request.kind,cursor:request.after,rowLimit:request.row_limit});
            return JSON.stringify({binding,page});
          },
        }):createCohortOriginalSourceChainV1Store(blobs,binding,{signal:budget.signal,checkBudget:budget.check});
      let root,reference=checkpoint.evidence_refs[2]??null;
      if(reference) {
        const text=await blobs.get(reference.content_sha256,reference.canonical_utf8_bytes);
        if(text===null||Buffer.byteLength(text)>16_000) fail('checkpoint_conflict');
        let previous;try{previous=JSON.parse(text);}catch{fail('checkpoint_conflict');}
        exactKeys(previous,['source_stage_version','usage','selection','purpose','market_decision','root']);
        if(previous.source_stage_version!==sourceVersion||previous.usage!==sourceUsage
          ||!same(previous.selection,selection)||!same(previous.purpose,purpose)||!same(previous.market_decision,decision)) fail('market_policy_changed');
        root=previous.root;
      }else root=(await chain.create()).root;
      if(sourcePrefixHead&&!same(sourcePrefixHead.root_reference,root))fail('checkpoint_conflict');
      let prefix=await chain.describe(root);
      const kind=COHORT_ORIGINAL_SOURCE_CHAIN_V1_KINDS.find(key=>!prefix.layers[key].ended);
      let verification=null,verificationReference=checkpoint.evidence_refs[3]??null,
        stockVerification=null,stockVerificationReference=checkpoint.evidence_refs[4]??null,
        identityVerification=null,identityVerificationReference=checkpoint.evidence_refs[5]??null,
        typedOriginals=null,typedReference=checkpoint.evidence_refs[6]??null,stockMetricResult=null;
      if(!verifying&&kind) {
        // Current all-date one-hop source rights have already been checked.
        // Prepare only once per exact stock; later pages reopen the immutable
        // index without rediscovering all seeds. Ending owner checks roll back
        // first preparation with the source page/checkpoint on any refusal.
        await createNeighborhoodFrozenJobSourceSeeds(client,{...stockOptions,signal:budget.signal}).prepare();
        const page=await createNeighborhoodPreparedJobSourcePages(client,{...stockOptions,signal:budget.signal})
          .page({kind,cursor:prefix.layers[kind].cursor,rowLimit:250});
        root=(await chain.append({root,original_text:JSON.stringify({binding,page}),...(referencesV2?{row_limit:250}:{})})).root;
        prefix=await chain.describe(root);
        const body={source_stage_version:sourceVersion,usage:sourceUsage,selection,purpose,market_decision:decision,root};
        reference=await blobs.put(canonicalAssessmentJson(body));
        if(sourcePrefixStore)sourcePrefixHead=await sourcePrefixStore.advance(sourcePrefixHead,{source_reference:reference,root_reference:root});
        await jobs.saveCheckpoint(claim,jobOptions,{phase:sourcePhase,evidence_refs:[retained.intent.reference,stockReference,reference]});
      }
      let graphAnchorStore=null,graphAnchor=null;
      if(verifying&&referencesV2) {
        graphAnchorStore=createCustomCohortGraphV2AnchorRepository({client,claim,scope,actorUserId:input.auth.userId,
          source_reference:reference,root_reference:root});
        graphAnchor=await graphAnchorStore.read();
        // The independent issued head is authoritative, not a free progress
        // blob, a valid hash or a caller-supplied continuation. Refuse a swapped
        // checkpoint BEFORE the fixed original adapter can read licensed data.
        if(checkpoint.phase==='frozen_source_refs_v2'?graphAnchor!==null
          :graphAnchor===null||!same(graphAnchor.receipt_reference,verificationReference)) fail('checkpoint_conflict');
        let issued=null;
        if(graphAnchor){
          const text=await readIssuedCheckpointReceipt(graphAnchor.receipt_reference);
          if(text===null||Buffer.byteLength(text)>16_000)fail('checkpoint_conflict');
          try{issued=JSON.parse(text);}catch{fail('checkpoint_conflict');}
          if(issued.sequence!==graphAnchor.sequence)fail('checkpoint_conflict');
        }
        // Geographic verification may only reopen the ACTUAL completed issued
        // graph, not advance an unfinished graph or accept a forged done blob.
        if(stockVerifying&&issued?.after?.kind_index!==COHORT_ORIGINAL_SOURCE_CHAIN_V1_KINDS.length)
          fail('unfinished_graph_verification');
        verification=await verifyCohortOriginalSourceGraphV2Step({chain,binding,source_reference:reference,
          root,issued_receipt:issued,issued_reference:graphAnchor?.receipt_reference??null,checkBudget:budget.check});
        if(verification.advanced){
          verificationReference=await blobs.put(canonicalAssessmentJson(verification.receipt));
          graphAnchor=await graphAnchorStore.advance(graphAnchor,verificationReference);
          await jobs.saveCheckpoint(claim,jobOptions,{phase:'frozen_verify_refs_v2',
            evidence_refs:[retained.intent.reference,stockReference,reference,verificationReference]});
        }
      }
      if(verifying&&!referencesV2) {
        let progress=null;
        if(verificationReference) {
          const text=await blobs.get(verificationReference.content_sha256,verificationReference.canonical_utf8_bytes);
          if(text===null||Buffer.byteLength(text)>16_000) fail('checkpoint_conflict');
          let previous;try{previous=JSON.parse(text);}catch{fail('checkpoint_conflict');}
          exactKeys(previous,['verification_stage_version','usage','source_reference','selection','purpose','market_decision','progress']);
          if(previous.verification_stage_version!==1||previous.usage!=='frozen_original_graph_progress_only'
            ||!same(previous.source_reference,reference)||!same(previous.selection,selection)
            ||!same(previous.purpose,purpose)||!same(previous.market_decision,decision)) fail('market_policy_changed');
          progress=previous.progress;
        }
        // The geographic stage cannot advance/rewrite an unfinished source
        // graph. Its actual owner must already have committed all seven layers.
        if(stockVerifying&&progress?.kind_index!==COHORT_ORIGINAL_SOURCE_CHAIN_V1_KINDS.length) fail('unfinished_graph_verification');
        const pages=createNeighborhoodFrozenJobSourcePages(client,{...stockOptions,signal:budget.signal});
        verification=await verifyCohortOriginalSourceGraphStep({chain,readSourcePage:page=>pages.page(page),
          root,progress,checkBudget:budget.check});
        if(verification.advanced) {
          const body={verification_stage_version:1,usage:'frozen_original_graph_progress_only',
            source_reference:reference,selection,purpose,market_decision:decision,progress:verification.progress};
          verificationReference=await blobs.put(canonicalAssessmentJson(body));
          await jobs.saveCheckpoint(claim,jobOptions,{phase:'frozen_verify_v1',
            evidence_refs:[retained.intent.reference,stockReference,reference,verificationReference]});
        }
      }
      let geographicAnchorStore=null,geographicAnchor=null;
      if(stockVerifying&&referencesV2){
        const expected={binding,source_reference:reference,root,graph_verification_reference:verificationReference,stock_reference:stockReference};
        geographicAnchorStore=createCustomCohortGeographicV2AnchorRepository({client,claim,scope,actorUserId:input.auth.userId,
          source_reference:reference,root_reference:root,graph_reference:verificationReference,stock_reference:stockReference});
        geographicAnchor=await geographicAnchorStore.read();
        if(checkpoint.phase==='frozen_verify_refs_v2'?geographicAnchor!==null
          :geographicAnchor===null||!same(geographicAnchor.receipt_reference,stockVerificationReference))fail('checkpoint_conflict');
        let issued=null;
        if(geographicAnchor){
          const text=await readIssuedCheckpointReceipt(geographicAnchor.receipt_reference);
          if(text===null||Buffer.byteLength(text)>16000)fail('checkpoint_conflict');
          try{issued=JSON.parse(text);}catch{fail('checkpoint_conflict');}
          issued=prepareCohortGeographicOriginalReceiptV2(issued,expected);
          if(issued.sequence!==geographicAnchor.sequence)fail('checkpoint_conflict');
        }
        if(identityVerifying&&issued?.after.done!==true)fail('unfinished_geographic_verification');
        // The original stock FK/key/account/EWKB SQL and its independent final
        // per-account totals are unchanged. Only the provenance of continuation
        // is new: derive it exclusively from the independent issued geo head.
        stockVerification=await createNeighborhoodFrozenJobStockOriginals(client,stockOptions).step(issued?.after??null);
        if(stockVerification.advanced){
          const after=stockVerification.progress,before=issued?.after??{...after,after_object_id:null,
            verified_parcels:0,verified_unassociated:0,done:false};
          const receipt=prepareCohortGeographicOriginalReceiptV2({format:'cohort_geographic_original_receipt_v2',...expected,
            sequence:(geographicAnchor?.sequence??0)+1,previous:geographicAnchor?.receipt_reference??null,before,after},expected);
          stockVerificationReference=await blobs.put(canonicalAssessmentJson(receipt));
          geographicAnchor=await geographicAnchorStore.advance(geographicAnchor,stockVerificationReference);
          await jobs.saveCheckpoint(claim,jobOptions,{phase:'frozen_geo_verify_refs_v2',
            evidence_refs:[retained.intent.reference,stockReference,reference,verificationReference,stockVerificationReference]});
        }
      }
      if(stockVerifying&&!referencesV2) {
        let progress=null;
        if(stockVerificationReference) {
          const text=await blobs.get(stockVerificationReference.content_sha256,stockVerificationReference.canonical_utf8_bytes);
          if(text===null||Buffer.byteLength(text)>16_000) fail('checkpoint_conflict');
          let previous;try{previous=JSON.parse(text);}catch{fail('checkpoint_conflict');}
          exactKeys(previous,['stock_verification_stage_version','usage','source_reference','graph_verification_reference',
            'selection','purpose','market_decision','progress']);
          if(previous.stock_verification_stage_version!==1||previous.usage!=='frozen_geographic_original_progress_only'
            ||!same(previous.source_reference,reference)||!same(previous.graph_verification_reference,verificationReference)
            ||!same(previous.selection,selection)||!same(previous.purpose,purpose)||!same(previous.market_decision,decision)) fail('market_policy_changed');
          progress=previous.progress;
        }
        // A later stage may verify a finished prerequisite, never advance it
        // and overwrite an identity checkpoint with a geographic continuation.
        if(identityVerifying&&progress?.done!==true) fail('unfinished_geographic_verification');
        stockVerification=await createNeighborhoodFrozenJobStockOriginals(client,stockOptions).step(progress);
        if(stockVerification.advanced) {
          const body={stock_verification_stage_version:1,usage:'frozen_geographic_original_progress_only',source_reference:reference,
            graph_verification_reference:verificationReference,selection,purpose,market_decision:decision,progress:stockVerification.progress};
          stockVerificationReference=await blobs.put(canonicalAssessmentJson(body));
          await jobs.saveCheckpoint(claim,jobOptions,{phase:'frozen_geo_verify_v1',
            evidence_refs:[retained.intent.reference,stockReference,reference,verificationReference,stockVerificationReference]});
        }
      }
      let identityAnchorStore=null,identityAnchor=null;
      if(identityVerifying&&referencesV2){
        const graph={root,layer_counts:Object.fromEntries(COHORT_ORIGINAL_SOURCE_CHAIN_V1_KINDS.map(key=>[key,prefix.layers[key].row_count]))};
        const expected={binding,source_reference:reference,root,graph_verification_reference:verificationReference,
          stock_verification_reference:stockVerificationReference,stock_reference:stockReference,
          layer_counts:graph.layer_counts,stock_account_count:stock.population.account_count};
        identityAnchorStore=createCustomCohortIdentityV2AnchorRepository({client,claim,scope,actorUserId:input.auth.userId,
          source_reference:reference,root_reference:root,graph_reference:verificationReference,
          geographic_reference:stockVerificationReference,stock_reference:stockReference});
        identityAnchor=await identityAnchorStore.read();
        if(checkpoint.phase==='frozen_geo_verify_refs_v2'?identityAnchor!==null
          :identityAnchor===null||!same(identityAnchor.receipt_reference,identityVerificationReference))fail('checkpoint_conflict');
        let issued=null;
        if(identityAnchor){
          const text=await readIssuedCheckpointReceipt(identityAnchor.receipt_reference);
          if(text===null||Buffer.byteLength(text)>16000)fail('checkpoint_conflict');
          try{issued=JSON.parse(text);}catch{fail('checkpoint_conflict');}
          issued=prepareCohortSourceIdentityReceiptV2(issued,expected);
          if(issued.sequence!==identityAnchor.sequence)fail('checkpoint_conflict');
        }
        if((cachingNeutralOriginals||readingSharedStockMetrics||readingCadPages||readingTransactionPages||readingTransactionPackages||readingStockOriginalCells||readingStockAccountPackages||traversingStock||partitioningRecordedGroups||catalogingRecordedGroups)
          &&issued?.after.kind_index!==COHORT_ORIGINAL_SOURCE_CHAIN_V1_KINDS.length)
          fail('unfinished_identity_verification');
        // Keep the original exact all-date one-hop identity SQL unchanged.
        // Its real stock/graph digest, native identities and coverage are not
        // established by DATA validation, a hash or a free DONE checkpoint.
        identityVerification=await createNeighborhoodFrozenJobSourceIdentity(client,stockOptions,graph).step(issued?.after??null);
        if(identityVerification.advanced){
          const after=identityVerification.progress,before=issued?.after??{...after,kind_index:0,after:'',layer_rows:0,
            unknown_parcel_origins:0,missing_account_count:null};
          const receipt=prepareCohortSourceIdentityReceiptV2({format:'cohort_source_identity_receipt_v2',...expected,
            sequence:(identityAnchor?.sequence??0)+1,previous:identityAnchor?.receipt_reference??null,before,after},expected);
          identityVerificationReference=await blobs.put(canonicalAssessmentJson(receipt));
          identityAnchor=await identityAnchorStore.advance(identityAnchor,identityVerificationReference);
          await jobs.saveCheckpoint(claim,jobOptions,{phase:'frozen_identity_refs_v2',
            evidence_refs:[retained.intent.reference,stockReference,reference,verificationReference,stockVerificationReference,identityVerificationReference]});
        }
      }
      if(identityVerifying&&!referencesV2) {
        let progress=null;
        if(identityVerificationReference) {
          const text=await blobs.get(identityVerificationReference.content_sha256,identityVerificationReference.canonical_utf8_bytes);
          if(text===null||Buffer.byteLength(text)>16_000) fail('checkpoint_conflict');
          let previous;try{previous=JSON.parse(text);}catch{fail('checkpoint_conflict');}
          exactKeys(previous,['identity_stage_version','usage','source_reference','graph_verification_reference','stock_verification_reference',
            'selection','purpose','market_decision','progress']);
          if(previous.identity_stage_version!==1||previous.usage!=='frozen_source_identity_progress_only'
            ||!same(previous.source_reference,reference)||!same(previous.graph_verification_reference,verificationReference)
            ||!same(previous.stock_verification_reference,stockVerificationReference)||!same(previous.selection,selection)
            ||!same(previous.purpose,purpose)||!same(previous.market_decision,decision)) fail('market_policy_changed');
          progress=previous.progress;
        }
        if((typing||readingSharedStockMetrics)&&progress?.kind_index!==COHORT_ORIGINAL_SOURCE_CHAIN_V1_KINDS.length) fail('unfinished_identity_verification');
        const graph={root,layer_counts:Object.fromEntries(COHORT_ORIGINAL_SOURCE_CHAIN_V1_KINDS.map(key=>[key,prefix.layers[key].row_count]))};
        identityVerification=await createNeighborhoodFrozenJobSourceIdentity(client,stockOptions,graph).step(progress);
        if(identityVerification.advanced) {
          const body={identity_stage_version:1,usage:'frozen_source_identity_progress_only',source_reference:reference,
            graph_verification_reference:verificationReference,stock_verification_reference:stockVerificationReference,
            selection,purpose,market_decision:decision,progress:identityVerification.progress};
          identityVerificationReference=await blobs.put(canonicalAssessmentJson(body));
          await jobs.saveCheckpoint(claim,jobOptions,{phase:'frozen_identity_v1',
            evidence_refs:[retained.intent.reference,stockReference,reference,verificationReference,stockVerificationReference,identityVerificationReference]});
        }
      }
      let neutralCacheStore=null,neutralCacheHead=null,neutralCachePlan=null,neutralCacheResult=null;
      if(cachingNeutralOriginals){
        const expected={binding,source_reference:reference,root,graph_reference:verificationReference,
          geographic_reference:stockVerificationReference,identity_reference:identityVerificationReference,stock_reference:stockReference,
          profile_reference:getNeighborhoodFrozenTypedOriginalV2Profile().definition_blob.ref};
        const createNeutralHead=yieldingNeutralProgress?createCustomCohortNeutralCacheV2AutomaticHeadRepository:createCustomCohortNeutralCacheV2HeadRepository;
        neutralCacheStore=createNeutralHead({client,claim,scope,actorUserId:input.auth.userId,
          source_reference:reference,root_reference:root,graph_reference:verificationReference,
          geographic_reference:stockVerificationReference,identity_reference:identityVerificationReference,stock_reference:stockReference});
        neutralCacheHead=await neutralCacheStore.read();
        let issued=null;
        if(neutralCacheHead){
          const text=await blobs.get(neutralCacheHead.receipt_reference.content_sha256,neutralCacheHead.receipt_reference.canonical_utf8_bytes);
          if(text===null||Buffer.byteLength(text)>16000)fail('checkpoint_conflict');
          try{issued=JSON.parse(text);}catch{fail('checkpoint_conflict');}
          exactKeys(issued,['format',...Object.keys(expected),'sequence','previous','before','after']);
          if(issued.format!=='cohort_neutral_cache_receipt_v2'||issued.sequence!==neutralCacheHead.sequence
            ||assessmentEvidenceDigest(issued)!==neutralCacheHead.receipt_reference.content_sha256
            ||!Object.keys(expected).every(k=>same(issued[k],expected[k])))fail('checkpoint_conflict');
        }
        const before=issued?.after??{kind_index:0,position:null,page_count:0,row_count:0,original_utf8_bytes:0,typed_utf8_bytes:'0'};
        exactKeys(before,['kind_index','position','page_count','row_count','original_utf8_bytes','typed_utf8_bytes']);
        if(!Number.isInteger(before.kind_index)||before.kind_index<0||before.kind_index>7
          ||before.page_count!==(neutralCacheHead?.sequence??0))fail('checkpoint_conflict');
        if(before.kind_index<7){
          // The only original adapter is the fixed closure SQL above. Reopen
          // the exact issued root edge; never invoke the global cache builder.
          const kind=COHORT_ORIGINAL_SOURCE_CHAIN_V1_KINDS[before.kind_index],
            original=await chain.read({root,kind,position:before.position});
          const body=JSON.parse(original.original_text);
          const reconciled=await createNeighborhoodSharedTypedOriginalPageV2(client,{generationId:stock.generation_id,
            signal:budget.signal,checkBudget:budget.check}).reconcile({kind,rows:body.page.rows});
          neutralCachePlan={format:'cohort_neutral_cache_receipt_v2',...expected,sequence:before.page_count+1,
            previous:neutralCacheHead?.receipt_reference??null,before,after:{
              kind_index:before.kind_index+Number(original.next_position===null),position:original.next_position,
              page_count:before.page_count+1,row_count:before.row_count+body.page.rows.length,
              original_utf8_bytes:before.original_utf8_bytes+Buffer.byteLength(original.original_text),
              typed_utf8_bytes:String(BigInt(before.typed_utf8_bytes)+BigInt(reconciled.typed_utf8_bytes))}};
          if(Buffer.byteLength(canonicalAssessmentJson(neutralCachePlan))>16000)fail('byte_limit');
          neutralCacheResult={advanced:true,progress:neutralCachePlan.after,reconciled_rows:reconciled.reconciled_rows,
            inserted_rows:reconciled.inserted_rows};
        }else neutralCacheResult={advanced:false,progress:before,reconciled_rows:0,inserted_rows:0};
      }
      if(typing) {
        const profile=getNeighborhoodFrozenTypedOriginalV1Profile();let progress=null;
        if(typedReference) {
          const text=await blobs.get(typedReference.content_sha256,typedReference.canonical_utf8_bytes);
          if(text===null||Buffer.byteLength(text)>16_000) fail('checkpoint_conflict');
          let previous;try{previous=JSON.parse(text);}catch{fail('checkpoint_conflict');}
          exactKeys(previous,['typed_stage_version','usage','source_reference','graph_verification_reference','stock_verification_reference',
            'identity_verification_reference','profile_reference','selection','purpose','market_decision','progress']);
          if(previous.typed_stage_version!==1||previous.usage!=='frozen_typed_original_progress_only'
            ||!same(previous.source_reference,reference)||!same(previous.graph_verification_reference,verificationReference)
            ||!same(previous.stock_verification_reference,stockVerificationReference)||!same(previous.identity_verification_reference,identityVerificationReference)
            ||!same(previous.profile_reference,profile.definition_blob.ref)||!same(previous.selection,selection)
            ||!same(previous.purpose,purpose)||!same(previous.market_decision,decision)) fail('market_policy_changed');
          if(await blobs.get(previous.profile_reference.content_sha256,previous.profile_reference.canonical_utf8_bytes)!==profile.definition_blob.canonical_json)
            fail('checkpoint_conflict');
          progress=previous.progress;
        }
        const graph={root,layer_counts:Object.fromEntries(COHORT_ORIGINAL_SOURCE_CHAIN_V1_KINDS.map(key=>[key,prefix.layers[key].row_count]))};
        if(readingStockMetrics&&progress?.kind_index!==COHORT_ORIGINAL_SOURCE_CHAIN_V1_KINDS.length) fail('unfinished_typed_interpretation');
        typedOriginals=await createNeighborhoodFrozenJobTypedOriginals(client,stockOptions,graph,context.effective_date).step(progress);
        if(typedOriginals.advanced) {
          const profileReference=await blobs.put(profile.definition_blob.canonical_json);
          if(!same(profileReference,profile.definition_blob.ref)) fail('checkpoint_conflict');
          const body={typed_stage_version:1,usage:'frozen_typed_original_progress_only',source_reference:reference,
            graph_verification_reference:verificationReference,stock_verification_reference:stockVerificationReference,
            identity_verification_reference:identityVerificationReference,profile_reference:profileReference,
            selection,purpose,market_decision:decision,progress:typedOriginals.progress};
          typedReference=await blobs.put(canonicalAssessmentJson(body));
          await jobs.saveCheckpoint(claim,jobOptions,{phase:'frozen_typed_v1',
            evidence_refs:[retained.intent.reference,stockReference,reference,verificationReference,stockVerificationReference,identityVerificationReference,typedReference]});
        }
        if(readingStockMetrics) stockMetricResult=await createNeighborhoodFrozenJobStockMetricPages(client,stockOptions,graph,context.effective_date).page(metricPage);
      }
      if(readingSharedStockMetrics) {
        // A completed shared cache is DATA, not a source grant. All existing
        // original graph/geography/identity prerequisites and ending rights
        // checks remain mandatory. Never materialize on a cache miss or copy
        // typed payloads/profile blobs/checkpoints into this report's job.
        const graph={root,layer_counts:Object.fromEntries(COHORT_ORIGINAL_SOURCE_CHAIN_V1_KINDS.map(key=>[key,prefix.layers[key].row_count]))};
        const reader=neutralSharedMetrics?createNeighborhoodSharedJobStockMetricPagesV2:createNeighborhoodSharedJobStockMetricPages;
        stockMetricResult=await reader(client,stockOptions,graph,context.effective_date).page(metricPage);
      }
      let cadCoverageStore=null,cadCoverageHead=null,cadCoverageNeutralStore=null,cadCoverageNeutralHead=null,
        cadCoverageExpected=null,cadCoverageIssued=null,cadCoveragePlan=null,cadCoverageResult=null,cadCoveredHeader=null,cadCoveredAmenities=null;
      if(cachingCadCoverage){
        const neutralExpected={binding,source_reference:reference,root,graph_reference:verificationReference,
          geographic_reference:stockVerificationReference,identity_reference:identityVerificationReference,stock_reference:stockReference,
          profile_reference:getNeighborhoodFrozenTypedOriginalV2Profile().definition_blob.ref};
        const refs={source_reference:reference,root_reference:root,graph_reference:verificationReference,
          geographic_reference:stockVerificationReference,identity_reference:identityVerificationReference,stock_reference:stockReference};
        const createCadNeutral=yieldingCadProgress?createCustomCohortNeutralCacheV2CadParentHeadRepository:createCustomCohortNeutralCacheV2HeadRepository;
        cadCoverageNeutralStore=createCadNeutral({client,claim,scope,actorUserId:input.auth.userId,...refs});
        cadCoverageNeutralHead=await cadCoverageNeutralStore.read();if(!cadCoverageNeutralHead)fail('CAD_neutral_coverage_unavailable');
        const text=await blobs.get(cadCoverageNeutralHead.receipt_reference.content_sha256,cadCoverageNeutralHead.receipt_reference.canonical_utf8_bytes);
        if(text===null||Buffer.byteLength(text)>16000)fail('checkpoint_conflict');
        let neutral;try{neutral=JSON.parse(text);}catch{fail('checkpoint_conflict');}
        exactKeys(neutral,['format',...Object.keys(neutralExpected),'sequence','previous','before','after']);
        if(neutral.format!=='cohort_neutral_cache_receipt_v2'||neutral.sequence!==cadCoverageNeutralHead.sequence
          ||neutral.after?.kind_index!==7||!Object.keys(neutralExpected).every(k=>same(neutral[k],neutralExpected[k])))fail('CAD_neutral_coverage_unavailable');
        const cadSource=prepareNeighborhoodSharedTypedCadSource(await client.query(NEIGHBORHOOD_SHARED_TYPED_CAD_SQL.source,[stock.generation_id]),stock.generation_id);
        if(cadSource.source_snapshot!==stock.original.source_snapshot||cadSource.started_at!==stock.original.source_transaction_started_at)fail('CAD_source_changed');
        cadCoverageExpected={binding,...refs,neutral_reference:cadCoverageNeutralHead.receipt_reference,
          typed_profile_reference:getNeighborhoodFrozenTypedCadImprovementV1Profile().definition_blob.ref,
          cad_source_metadata:cadSource,cad_purpose:cadPurpose,cad_decision:cadDecision,stock_account_count:stock.population.account_count};
        const createCadHead=yieldingCadProgress?createCustomCohortCadCacheV2AutomaticHeadRepository:createCustomCohortCadCacheV2HeadRepository;
        cadCoverageStore=createCadHead({client,claim,scope,actorUserId:input.auth.userId,
          ...refs,neutral_reference:cadCoverageNeutralHead.receipt_reference});
        cadCoverageHead=await cadCoverageStore.read();
        if(cadCoverageHead){
          const text=await blobs.get(cadCoverageHead.receipt_reference.content_sha256,cadCoverageHead.receipt_reference.canonical_utf8_bytes);
          if(text===null||Buffer.byteLength(text)>16000)fail('checkpoint_conflict');
          let body;try{body=JSON.parse(text);}catch{fail('checkpoint_conflict');}
          cadCoverageIssued=prepareCohortCadCacheCoverageReceiptV2(body,cadCoverageExpected);
          if(cadCoverageIssued.sequence!==cadCoverageHead.sequence)fail('checkpoint_conflict');
        }
        if(readingCoveredCadAmenities){
          if(!cadCoverageIssued?.after.done)fail('CAD_complete_coverage_required');
          const header=one(await client.query(NEIGHBORHOOD_SHARED_TYPED_CAD_SQL.read,
            [stock.generation_id,cadCoverageExpected.typed_profile_reference.content_sha256]));
          cadCoveredHeader=prepareNeighborhoodCoveredCadCacheHeaderV2(header,cadCoverageExpected.cad_source_metadata);
          const bounds=NEIGHBORHOOD_ORIGINAL_CAD_ACCOUNT_PACKAGE_V2_LIMITS;
          const packet=reconcileNeighborhoodOriginalCadAccountPackageV2(one(await client.query({
            text:NEIGHBORHOOD_ORIGINAL_CAD_ACCOUNT_PACKAGE_V2_SQL,values:[stock.operation_id,stock.generation_id,
              cadCoverageExpected.typed_profile_reference.content_sha256,'',bounds.rows,bounds.packet_utf8_bytes,
              bounds.row_utf8_bytes,bounds.original_utf8_bytes,bounds.output_utf8_bytes],query_timeout:5000})),
          {cursor:''},context.effective_date,budget.check);
          if(packet.end_of_accounts||packet.rows.length!==1)fail('CAD_coverage_changed');
          const account=packet.rows[0];
          cadCoveredAmenities={account_id:account.account_id,geographic_parcel_count:account.geographic_parcel_count,
            original_counts:{primary:Number(account.primary_original_count),secondary:Number(account.secondary_original_count)},
            amenity_evidence:resolveNeighborhoodOriginalCadAmenityEvidenceV2(account,budget.check)};
        }else{
        const before=cadCoverageIssued?.after??initialCohortCadCacheCoverageV2State();
        cadCoverageResult=await createNeighborhoodScopedCadOriginalAccountV2(client,stockOptions).reconcile({cursor:before.after_account});
        if(before.done&&!cadCoverageResult.end_of_accounts)fail('CAD_coverage_changed');
        if(!before.done){
          const r=cadCoverageResult,entry=r.end_of_accounts?null:{account_id:r.account_id,geographic_parcel_count:r.geographic_parcel_count,
            primary_count:r.original_counts.primary,secondary_count:r.original_counts.secondary};
          cadCoveragePlan=prepareCohortCadCacheCoverageReceiptV2({format:'cohort_CAD_cache_coverage_receipt_v2',...cadCoverageExpected,
            sequence:(cadCoverageHead?.sequence??0)+1,previous:cadCoverageHead?.receipt_reference??null,before,entry,
            after:{after_account:r.next_cursor,account_count:before.account_count+Number(entry!==null),
              original_count:before.original_count+r.reconciled_rows,typed_utf8_bytes:String(BigInt(before.typed_utf8_bytes)+BigInt(r.typed_utf8_bytes)),
              done:r.end_of_accounts}},cadCoverageExpected);
        }
        }
      }
      if(readingCadPages&&!cachingCadCoverage){
        const graph={root,layer_counts:Object.fromEntries(COHORT_ORIGINAL_SOURCE_CHAIN_V1_KINDS.map(key=>[key,prefix.layers[key].row_count]))};
        if(cachingCadOriginals){
          stockMetricResult=await createNeighborhoodScopedCadOriginalAccountV2(client,stockOptions).reconcile(cadPage);
        }else if(projectingCadAccounts){
          const accounts=createNeighborhoodSharedJobCadAccountPages(client,stockOptions,graph,context.effective_date);
          stockMetricResult=await (resolvingCadAmenities?accounts.originalAmenityEvidence(cadPage)
            :reconcilingCadAccounts?accounts.originalAccountPackage(cadPage):accounts.page(cadPage));
        }else stockMetricResult=await createNeighborhoodSharedJobCadImprovementPages(client,stockOptions,graph).page(cadPage);
      }
      if(readingTransactionPages){
        const graph={root,layer_counts:Object.fromEntries(COHORT_ORIGINAL_SOURCE_CHAIN_V1_KINDS.map(key=>[key,prefix.layers[key].row_count]))};
        if(projectingTransactionTemporal)prepareNeighborhoodTransactionRetainedPeriodV1(input.observationPeriod,context.effective_date);
        stockMetricResult=await createNeighborhoodSharedJobTransactionPagesV2(client,stockOptions,graph).page(transactionInput);
        if(projectingTransactionTemporal){
          const rows=stockMetricResult.rows.map(row=>{budget.check();
            return projectNeighborhoodTransactionTemporalV1(row,context.effective_date,input.observationPeriod);});
          if(Buffer.byteLength(JSON.stringify(rows))>NEIGHBORHOOD_TRANSACTION_TEMPORAL_V1_LIMITS.page_utf8_bytes)fail('byte_limit');
          stockMetricResult={...stockMetricResult,status:'retained_transaction_temporal_page',rows,
            temporal_profile:getNeighborhoodTransactionTemporalV1Profile(),
            temporal_basis:'retained_effective_year_and_closing_period_applied_before_resolution'};
        }
      }
      if(readingTransactionPackages){
        const graph={root,layer_counts:Object.fromEntries(COHORT_ORIGINAL_SOURCE_CHAIN_V1_KINDS.map(key=>[key,prefix.layers[key].row_count]))};
        const packages=createNeighborhoodSharedTransactionPackagesV1(client,stockOptions,graph,context.effective_date,input.observationPeriod);
        stockMetricResult=await (reconcilingTransactionPackages?packages.originalPage(packageInput):packages.page(packageInput));
      }
      if((readingStockOriginalCells||readingStockAccountPackages)&&!readingRecordedPartition){
        const graph={root,layer_counts:Object.fromEntries(COHORT_ORIGINAL_SOURCE_CHAIN_V1_KINDS.map(key=>[key,prefix.layers[key].row_count]))};
        const createOriginals=coveredNeutralOriginals?createNeighborhoodCoveredStockOriginalCellsV2:createNeighborhoodSharedStockOriginalCellsV2;
        const originals=createOriginals(client,stockOptions,graph,context.effective_date);
        stockMetricResult=await (readingStockOriginalCells?originals.page(originalCellInput)
          :readingStockWholeAccountBatch?originals.wholeAccountBatch(stockAccountInput)
          :resolvingStockAccountRecordedGroup?originals.recordedGroupAccountPackage(stockAccountInput)
          :resolvingStockAccountHousing?originals.housingAccountPackage(stockAccountInput):originals.accountPackage(stockAccountInput));
        // resumeCustomCohortSubjectCheckpoint already matched the original
        // immutable intent's housing marker, never a caller/current default
        // upgrade. Bind the bounded result to that EXACT retained choice too.
        if(resolvingStockAccountHousing&&stockMetricResult.recorded_housing!==null
          &&!same(stockMetricResult.recorded_housing.retained_housing_interpretation,housingProfile))fail('checkpoint_conflict');
        if(readingStockWholeAccountBatch&&stockMetricResult.accounts.some(account=>
          !same(account.recorded_housing.retained_housing_interpretation,housingProfile)))fail('checkpoint_conflict');
      }
      let traversalAnchorStore=null,traversalAnchor=null,traversalResult=null;
      if(traversingStock){
        if(cacheStockHandoff&&checkpoint.phase==='frozen_identity_refs_v2')
          await createCustomCohortCacheStockV2BridgeRepository(client).assertClaim(claim,jobOptions);
        const expected={binding,source_reference:reference,root,graph_verification_reference:verificationReference,
          stock_verification_reference:stockVerificationReference,identity_verification_reference:identityVerificationReference,
          stock_reference:stockReference,effective_date:context.effective_date,stock_account_count:stock.population.account_count};
        traversalAnchorStore=createCustomCohortStockTraversalV2AnchorRepository({client,claim,scope,actorUserId:input.auth.userId,
          source_reference:reference,root_reference:root,graph_reference:verificationReference,
          geographic_reference:stockVerificationReference,identity_reference:identityVerificationReference,stock_reference:stockReference});
        traversalAnchor=await traversalAnchorStore.read();
        if(checkpoint.phase==='frozen_identity_refs_v2'?traversalAnchor!==null
          :traversalAnchor===null||!same(traversalAnchor.receipt_reference,checkpoint.evidence_refs[6]))fail('checkpoint_conflict');
        const prepareTraversal=batchingStock?prepareCohortStockTraversalBatchReceiptV3:prepareCohortStockTraversalReceiptV2;
        let issued=null;
        if(traversalAnchor){
          const text=await blobs.get(traversalAnchor.receipt_reference.content_sha256,traversalAnchor.receipt_reference.canonical_utf8_bytes);
          if(text===null||Buffer.byteLength(text)>16000)fail('checkpoint_conflict');
          try{issued=JSON.parse(text);}catch{fail('checkpoint_conflict');}
          issued=prepareTraversal(issued,expected);
          if(issued.sequence!==traversalAnchor.sequence)fail('checkpoint_conflict');
        }
        // ONLY the independent issued head chooses this next account. There is
        // no caller cursor, count, cell/profile callback, dense roster or DONE.
        // One same-budget original reader replays the WHOLE account, including
        // outside parts, against the ENTIRE neutral cache before progress DML.
        const before=issued?.after??{after_account:'',account_count:0,done:false},
          graph={root,layer_counts:Object.fromEntries(COHORT_ORIGINAL_SOURCE_CHAIN_V1_KINDS.map(key=>[key,prefix.layers[key].row_count]))};
        const createOriginals=coveredNeutralOriginals?createNeighborhoodCoveredStockOriginalCellsV2:createNeighborhoodSharedStockOriginalCellsV2;
        const packet=await createOriginals(client,stockOptions,graph,context.effective_date)
          [batchingStock?'wholeAccountBatch':'housingAccountPackage']({cursor:before.after_account});
        if(batchingStock){
          if(packet.accounts.some(account=>!same(account.recorded_housing.retained_housing_interpretation,housingProfile)))fail('checkpoint_conflict');
        }else if(packet.recorded_housing!==null&&!same(packet.recorded_housing.retained_housing_interpretation,housingProfile))fail('checkpoint_conflict');
        if(before.done&&!packet.end_of_accounts)fail('checkpoint_conflict');
        let receipt=issued,advanced=false;
        if(!before.done){
          const after={after_account:packet.next_cursor,account_count:before.account_count+(batchingStock?packet.account_count:packet.account_id===null?0:1),done:packet.end_of_accounts};
          receipt=prepareTraversal({format:batchingStock?'cohort_stock_traversal_batch_receipt_v3':'cohort_stock_traversal_receipt_v2',...expected,
            ...(batchingStock?{accounts:packet.accounts.map(account=>({account_id:account.account_id,
              geographic_parcel_count:account.geographic_parcel_count,original_counts:account.original_counts})),original_count:packet.original_count}:{}),
            sequence:(traversalAnchor?.sequence??0)+1,previous:traversalAnchor?.receipt_reference??null,before,after},expected);
          const receiptReference=await blobs.put(canonicalAssessmentJson(receipt));
          traversalAnchor=await traversalAnchorStore.advance(traversalAnchor,receiptReference);
          await jobs.saveCheckpoint(claim,jobOptions,{phase:'frozen_stock_traversal_refs_v2',evidence_refs:[retained.intent.reference,
            stockReference,reference,verificationReference,stockVerificationReference,identityVerificationReference,receiptReference]});
          advanced=true;
        }
        traversalResult={status:batchingStock?'original_stock_batch_traversal_progress_retained':'original_stock_traversal_progress_retained',
          ...(batchingStock?{batch_accounts:packet.account_count,batch_originals:packet.original_count,
            receipt_format:'cohort_stock_traversal_batch_receipt_v3',one_receipt_per_whole_batch:true}:{}),operation_id:input.operationId,advanced,
          traversal_reference:traversalAnchor.receipt_reference,progress:receipt.after,stock_reference:stockReference,
          source_reference:reference,verification_reference:verificationReference,stock_verification_reference:stockVerificationReference,
          identity_verification_reference:identityVerificationReference,generation_id:stock.generation_id,
          retained_effective_date:context.effective_date,retained_observation_period:input.observationPeriod,
          original_reconciliation:'every_traversed_whole_account_original_and_entire_neutral_cache_replayed',
          current_authorized_owner:'V2_issued_graph_geography_identity_and_current_original_source_rights',
          selected_union:'not_established',statistics:'not_established',source_acquisition:'not_established',report_update:'none'};
      }
      let partitionStore=null,partitionAnchor=null,partitionResult=null,partitionReadCursor=null,partitionReadEntry=null,
        catalogStore=null,catalogAnchor=null,catalogCounts=null,catalogResult=null,catalogReadGroup=null,catalogReadGroupKey=null,
        unionStore=null,unionAnchor=null,unionCounts=null,unionExpected=null,unionIssued=null,unionPlan=null,subjectHousingResult=null,unionSubjectHousing=null,
        unionAccountEligibility=null,unionExpectedSelected=false,firstSelectedEntry=null,
        eligibilityStore=null,eligibilityAnchor=null,eligibilityIssued=null,eligibilityPlan=null,
        evidenceStore=null,evidenceAnchor=null,evidenceIssued=null,evidencePlan=null,
        metricsStore=null,metricsAnchor=null,metricsIssued=null,metricsExpected=null,metricsBefore=null,metricsCounts=null,metricsRowCandidate=null,
        statisticsStore=null,statisticsAnchor=null,statisticsExpected=null,statisticsBefore=null,statisticsCounts=null,statisticsCandidate=null,
        numericStore=null,numericAnchor=null,numericExpected=null,numericBefore=null,provisionalRankCandidates=null,
        semanticStore=null,semanticAnchor=null,semanticExpected=null,semanticBefore=null,semanticIssued=null,semanticSummary=null,
        selectedTransactionSource=null,selectedTransactionNativeKeys=null,selectedTransactionCandidateStore=null,selectedTransactionCandidatePlan=null,
        selectedTransactionIndexStore=null,selectedTransactionIndexPacket=null,selectedTransactionIndexExpected=null;
      if(partitioningRecordedGroups||readingRecordedPartition||catalogingRecordedGroups){
        const baseExpected={binding,source_reference:reference,root,graph_verification_reference:verificationReference,
          stock_verification_reference:stockVerificationReference,identity_verification_reference:identityVerificationReference,
          stock_reference:stockReference,effective_date:context.effective_date,stock_account_count:stock.population.account_count};
        traversalAnchorStore=createCustomCohortStockTraversalV2AnchorRepository({client,claim,scope,actorUserId:input.auth.userId,
          source_reference:reference,root_reference:root,graph_reference:verificationReference,
          geographic_reference:stockVerificationReference,identity_reference:identityVerificationReference,stock_reference:stockReference});
        traversalAnchor=await traversalAnchorStore.read();
        if(traversalAnchor===null||!same(traversalAnchor.receipt_reference,checkpoint.evidence_refs[6]))fail('checkpoint_conflict');
        const traversalText=await readIssuedCheckpointReceipt(traversalAnchor.receipt_reference);
        if(traversalText===null||Buffer.byteLength(traversalText)>16000)fail('checkpoint_conflict');
        let completed;try{completed=JSON.parse(traversalText);}catch{fail('checkpoint_conflict');}
        completed=prepareCohortStockTraversalReceiptV2(completed,baseExpected);
        if(completed.sequence!==traversalAnchor.sequence||!completed.after.done)fail('unfinished_stock_traversal');
        const profile=getNeighborhoodOriginalRecordedGroupV2Profile(),expected={...baseExpected,
          traversal_reference:traversalAnchor.receipt_reference,profile_reference:profile.definition_blob.ref};
        partitionStore=createCustomCohortRecordedPartitionV2Repository({client,claim,scope,actorUserId:input.auth.userId,
          source_reference:reference,root_reference:root,graph_reference:verificationReference,geographic_reference:stockVerificationReference,
          identity_reference:identityVerificationReference,stock_reference:stockReference,
          traversal_reference:expected.traversal_reference,profile_reference:expected.profile_reference});
        partitionAnchor=await partitionStore.read();
        if(checkpoint.phase==='frozen_stock_traversal_refs_v2'?partitionAnchor!==null
          :partitionAnchor===null||!same(partitionAnchor.receipt_reference,checkpoint.evidence_refs[7]))fail('checkpoint_conflict');
        let issued=null;
        if(partitionAnchor){const text=await readIssuedCheckpointReceipt(partitionAnchor.receipt_reference);
          if(text===null||Buffer.byteLength(text)>16000)fail('checkpoint_conflict');
          try{issued=JSON.parse(text);}catch{fail('checkpoint_conflict');}
          issued=prepareCohortRecordedGroupPartitionReceiptV2(issued,expected);
          if(issued.sequence!==partitionAnchor.sequence)fail('checkpoint_conflict');}
        if((readingRecordedPartition||catalogingRecordedGroups)&&issued?.after.done!==true)fail('unfinished_recorded_partition');
        let catalogIssued=null,catalogExpected=null;
        if(catalogingRecordedGroups||readingRecordedCatalog){
          catalogExpected={...expected,partition_reference:partitionAnchor.receipt_reference};
          catalogStore=createCustomCohortRecordedCatalogV2Repository({client,claim,scope,actorUserId:input.auth.userId,
            source_reference:reference,root_reference:root,graph_reference:verificationReference,geographic_reference:stockVerificationReference,
            identity_reference:identityVerificationReference,stock_reference:stockReference,traversal_reference:expected.traversal_reference,
            profile_reference:expected.profile_reference,partition_reference:partitionAnchor.receipt_reference});
          catalogAnchor=await catalogStore.read();
          if(checkpoint.phase==='frozen_recorded_partition_refs_v2'?catalogAnchor!==null
            :catalogAnchor===null||!same(catalogAnchor.receipt_reference,checkpoint.evidence_refs[8]))fail('checkpoint_conflict');
          if(catalogAnchor){const text=await readIssuedCheckpointReceipt(catalogAnchor.receipt_reference);
            if(text===null||Buffer.byteLength(text)>16000)fail('checkpoint_conflict');
            try{catalogIssued=JSON.parse(text);}catch{fail('checkpoint_conflict');}
            catalogIssued=prepareCohortRecordedCatalogReceiptV2(catalogIssued,catalogExpected);
            if(catalogIssued.sequence!==catalogAnchor.sequence)fail('checkpoint_conflict');}
          if((readingRecordedCatalog||awaitingSelection||selectingCatalogIntent||readingRetainedSelectionIntent)&&catalogIssued?.after.done!==true)fail('unfinished_recorded_catalog');
          catalogCounts=await catalogStore.counts();
          if(!same(catalogCounts,catalogIssued?.after_counts??{assigned_accounts:0,unassigned_accounts:0,assigned_groups:0}))fail('catalog_original_mismatch');
        }
        if(replayingSelectedUnion){
          if(!same(issuedSelectionIntent.catalog_reference,catalogAnchor.receipt_reference))fail('selection_intent_changed');
          unionExpected={...catalogExpected,catalog_reference:catalogAnchor.receipt_reference,command_id:issuedSelectionIntent.command_id};
          unionStore=createCustomCohortSelectedUnionV2Repository({client,claim,scope,actorUserId:input.auth.userId,
            command_id:issuedSelectionIntent.command_id});
          unionAnchor=await unionStore.read();
          if(checkpoint.phase==='frozen_recorded_catalog_refs_v2'?unionAnchor!==null
            :unionAnchor===null||!same(unionAnchor.receipt_reference,checkpoint.evidence_refs[9]))fail('checkpoint_conflict');
          if(unionAnchor){const text=await readIssuedCheckpointReceipt(unionAnchor.receipt_reference);
            if(text===null||Buffer.byteLength(text)>16000)fail('checkpoint_conflict');
            try{unionIssued=JSON.parse(text);}catch{fail('checkpoint_conflict');}
            unionIssued=prepareCohortSelectedUnionReceiptV2(unionIssued,unionExpected);
            if(unionIssued.sequence!==unionAnchor.sequence)fail('checkpoint_conflict');
            if(readingSelectedUnionSubjectHousing?!unionIssued.after.done:unionIssued.after.done)
              fail(readingSelectedUnionSubjectHousing?'unfinished_selected_union':'selected_union_replay_finished');}
          if(readingSelectedUnionSubjectHousing&&!unionIssued)fail('unfinished_selected_union');
          unionCounts=await unionStore.counts();
          if(!same(unionCounts,{...(unionIssued?.after_counts??{assigned_accounts:0,unassigned_accounts:0,assigned_groups:0}),
            selected_count:unionIssued?.after_selected_count??0}))fail('selected_union_original_mismatch');
        }
        if(readingSelectedUnionFirstEligibility){
          // Read-only fixed ordinal1 admission BEFORE the later durable fifth
          // pass. The native union picks membership; neither caller DATA nor
          // first C-sorted stock may pick a comparison account. Subject and
          // selected account share ONE whole-original/ENTIRE-cache packet.
          let eligibilityBefore={selected_ordinal:0,done:false},eligibilityCounts=Object.fromEntries(SELECTED_RECORDED_ELIGIBILITY_METRICS.map(k=>[k,0]));
          const eligibilityExpected={union_reference:unionAnchor.receipt_reference,command_id:issuedSelectionIntent.command_id,
            selected_stock_count:unionCounts.selected_count};
          if(progressingSelectedEligibility||progressingSelectedEvidence||readingSelectedMetricSource){
            eligibilityStore=createCustomCohortSelectedEligibilityV2Repository({client,claim,scope,actorUserId:input.auth.userId,
              command_id:issuedSelectionIntent.command_id,union_reference:unionAnchor.receipt_reference});
            eligibilityAnchor=await eligibilityStore.read();
            if(checkpoint.phase==='frozen_selected_union_refs_v2'?eligibilityAnchor!==null:
              eligibilityAnchor===null||!same(eligibilityAnchor.receipt_reference,checkpoint.evidence_refs[10]))fail('checkpoint_conflict');
            if(eligibilityAnchor){
              const text=await readIssuedCheckpointReceipt(eligibilityAnchor.receipt_reference);
              if(text===null||Buffer.byteLength(text)>16000)fail('checkpoint_conflict');
              try{eligibilityIssued=JSON.parse(text);}catch{fail('checkpoint_conflict');}
              eligibilityIssued=prepareCohortSelectedEligibilityReceiptV2(eligibilityIssued,eligibilityExpected);
              if(eligibilityIssued.sequence!==eligibilityAnchor.sequence)fail('checkpoint_conflict');
              if(progressingSelectedEvidence||readingSelectedMetricSource?!eligibilityIssued.after.done:eligibilityIssued.after.done)
                fail(progressingSelectedEvidence||readingSelectedMetricSource?'unfinished_selected_eligibility':'selected_eligibility_finished');
              if(!progressingSelectedEvidence&&!readingSelectedMetricSource){eligibilityBefore=eligibilityIssued.after;eligibilityCounts=eligibilityIssued.after_counts;}
            }
            if((progressingSelectedEvidence||readingSelectedMetricSource)&&!eligibilityIssued)fail('unfinished_selected_eligibility');
          }
          const evidenceExpected=progressingSelectedEvidence||readingSelectedMetricSource?{...eligibilityExpected,eligibility_reference:eligibilityAnchor.receipt_reference}:null;
          if(progressingSelectedEvidence||readingSelectedMetricSource){
            evidenceStore=createCustomCohortSelectedEvidenceV2Repository({client,claim,scope,actorUserId:input.auth.userId,
              command_id:issuedSelectionIntent.command_id,union_reference:unionAnchor.receipt_reference,
              eligibility_reference:eligibilityAnchor.receipt_reference});
            evidenceAnchor=await evidenceStore.read();
            if(checkpoint.phase==='frozen_selected_eligibility_refs_v2'?evidenceAnchor!==null:
              evidenceAnchor===null||!same(evidenceAnchor.receipt_reference,checkpoint.evidence_refs[11]))fail('checkpoint_conflict');
            if(evidenceAnchor){
              const text=await readIssuedCheckpointReceipt(evidenceAnchor.receipt_reference);
              if(text===null||Buffer.byteLength(text)>16000)fail('checkpoint_conflict');
              try{evidenceIssued=JSON.parse(text);}catch{fail('checkpoint_conflict');}
              evidenceIssued=prepareCohortSelectedEvidenceReceiptV2(evidenceIssued,evidenceExpected);
              if(evidenceIssued.sequence!==evidenceAnchor.sequence)fail('checkpoint_conflict');
              if(readingSelectedMetricSource?!evidenceIssued.after.done:evidenceIssued.after.done)
                fail(readingSelectedMetricSource?'unfinished_selected_evidence':'selected_evidence_finished');
              if(!readingSelectedMetricSource)eligibilityBefore=evidenceIssued.after;
            }
            if(readingSelectedMetricSource&&!evidenceIssued)fail('unfinished_selected_evidence');
          }
          if(progressingSelectedMetrics||readingSelectedStatisticsSource){
            metricsExpected={...evidenceExpected,evidence_reference:evidenceAnchor.receipt_reference};
            metricsBefore={selected_ordinal:0,done:false};metricsCounts=Object.fromEntries(SELECTED_RECORDED_ELIGIBILITY_METRICS.map(k=>[k,0]));
            metricsStore=createCustomCohortSelectedMetricsV2Repository({client,claim,scope,actorUserId:input.auth.userId,
              command_id:issuedSelectionIntent.command_id,union_reference:unionAnchor.receipt_reference,
              eligibility_reference:eligibilityAnchor.receipt_reference,evidence_reference:evidenceAnchor.receipt_reference});
            metricsAnchor=await metricsStore.read();
            if(checkpoint.phase==='frozen_selected_evidence_refs_v2'?metricsAnchor!==null:
              metricsAnchor===null||!same(metricsAnchor.receipt_reference,checkpoint.evidence_refs[12]))fail('checkpoint_conflict');
            if(metricsAnchor){
              const text=await readIssuedCheckpointReceipt(metricsAnchor.receipt_reference);
              if(text===null||Buffer.byteLength(text)>16000)fail('checkpoint_conflict');
              try{metricsIssued=JSON.parse(text);}catch{fail('checkpoint_conflict');}
              metricsIssued=prepareCohortSelectedMetricsReceiptV2(metricsIssued,metricsExpected);
              if(metricsIssued.sequence!==metricsAnchor.sequence)fail('checkpoint_conflict');
              if(readingSelectedStatisticsSource){if(!metricsIssued.after.done)fail('unfinished_selected_metrics');}
              else if(metricsIssued.after.done)fail('selected_metrics_finished');
              metricsBefore=metricsIssued.after;metricsCounts=metricsIssued.after_counts;
            }
            if(readingSelectedStatisticsSource&&!metricsIssued)fail('unfinished_selected_metrics');
            if(!readingSelectedStatisticsSource)eligibilityBefore=metricsBefore;
          }
          if(progressingSelectedStatistics||readingSelectedFrequencySource){
            statisticsExpected={...metricsExpected,metrics_reference:metricsAnchor.receipt_reference};
            statisticsBefore={selected_ordinal:0,done:false};statisticsCounts=emptyCohortSelectedStatisticsCountsV2();
            statisticsStore=createCustomCohortSelectedStatisticsV2Repository({client,claim,scope,actorUserId:input.auth.userId,
              command_id:issuedSelectionIntent.command_id,union_reference:unionAnchor.receipt_reference,
              eligibility_reference:eligibilityAnchor.receipt_reference,evidence_reference:evidenceAnchor.receipt_reference,
              metrics_reference:metricsAnchor.receipt_reference});
            statisticsAnchor=await statisticsStore.read();
            if(checkpoint.phase==='frozen_selected_metrics_refs_v2'?statisticsAnchor!==null:
              statisticsAnchor===null||!same(statisticsAnchor.receipt_reference,checkpoint.evidence_refs[13]))fail('checkpoint_conflict');
            if(statisticsAnchor){
              const text=await readIssuedCheckpointReceipt(statisticsAnchor.receipt_reference);
              if(text===null||Buffer.byteLength(text)>16000)fail('checkpoint_conflict');
              let issued;try{issued=JSON.parse(text);}catch{fail('checkpoint_conflict');}
              issued=prepareCohortSelectedStatisticsReceiptV2(issued,statisticsExpected);
              if(issued.sequence!==statisticsAnchor.sequence||(readingSelectedFrequencySource?!issued.after.done:issued.after.done))
                fail(readingSelectedFrequencySource?'unfinished_selected_statistics':'selected_statistics_finished_or_corrupt');
              statisticsBefore=issued.after;statisticsCounts=issued.after_counts;
            }
            if(readingSelectedFrequencySource){if(!statisticsAnchor)fail('unfinished_selected_statistics');}
            else eligibilityBefore=statisticsBefore;
          }
          if(progressingSelectedNumeric||readingSelectedRankCandidates||progressingSelectedSemantic){
            numericExpected={...statisticsExpected,statistics_reference:statisticsAnchor.receipt_reference};
            numericBefore={selected_ordinal:0,done:false};
            numericStore=createCustomCohortSelectedNumericV2Repository({client,claim,scope,actorUserId:input.auth.userId,
              command_id:issuedSelectionIntent.command_id,union_reference:unionAnchor.receipt_reference,
              eligibility_reference:eligibilityAnchor.receipt_reference,evidence_reference:evidenceAnchor.receipt_reference,
              metrics_reference:metricsAnchor.receipt_reference,statistics_reference:statisticsAnchor.receipt_reference});
            numericAnchor=await numericStore.read();
            if(checkpoint.phase==='frozen_selected_statistics_refs_v2'?numericAnchor!==null:
              numericAnchor===null||!same(numericAnchor.receipt_reference,checkpoint.evidence_refs[14]))fail('checkpoint_conflict');
            if(numericAnchor){
              const text=await readIssuedCheckpointReceipt(numericAnchor.receipt_reference);
              if(text===null||Buffer.byteLength(text)>4096)fail('checkpoint_conflict');
              let issued;try{issued=JSON.parse(text);}catch{fail('checkpoint_conflict');}
              issued=prepareCohortSelectedNumericReceiptV2(issued,numericExpected);
              if(issued.sequence!==numericAnchor.sequence||(readingSelectedRankCandidates||progressingSelectedSemantic?!issued.after.done:issued.after.done))fail('selected_numeric_finished_or_corrupt');
              numericBefore=issued.after;
            }
            if(readingSelectedRankCandidates||progressingSelectedSemantic){if(!numericAnchor)fail('unfinished_selected_numeric');}
            else eligibilityBefore=numericBefore;
          }
          if(progressingSelectedSemantic){
            semanticExpected={...numericExpected,numeric_reference:numericAnchor.receipt_reference};
            semanticBefore={selected_ordinal:0,done:false};
            semanticStore=createCustomCohortSelectedSemanticV2Repository({client,claim,scope,actorUserId:input.auth.userId,
              command_id:issuedSelectionIntent.command_id,...Object.fromEntries(
                ['union_reference','eligibility_reference','evidence_reference','metrics_reference','statistics_reference','numeric_reference']
                  .map(k=>[k,semanticExpected[k]]))});
            semanticAnchor=await semanticStore.read();
            if(checkpoint.phase==='frozen_selected_numeric_refs_v2'?semanticAnchor!==null:
              semanticAnchor===null||!same(semanticAnchor.receipt_reference,checkpoint.evidence_refs[15]))fail('checkpoint_conflict');
            if(semanticAnchor){
              const text=await readIssuedCheckpointReceipt(semanticAnchor.receipt_reference);
              if(text===null||Buffer.byteLength(text)>4096)fail('checkpoint_conflict');
              let issued;try{issued=JSON.parse(text);}catch{fail('checkpoint_conflict');}
              semanticIssued=prepareCohortSelectedSemanticReceiptV2(issued,semanticExpected);
              if(semanticIssued.sequence!==semanticAnchor.sequence||(readingSelectedTransactionSource?!semanticIssued.after.done:semanticIssued.after.done))fail('selected_semantic_finished_or_corrupt');
              semanticBefore=semanticIssued.after;
              const summaryText=await blobs.get(semanticIssued.after_summary_reference.content_sha256,semanticIssued.after_summary_reference.canonical_utf8_bytes);
              if(summaryText===null||Buffer.byteLength(summaryText)>16000)fail('checkpoint_conflict');
              let summary;try{summary=JSON.parse(summaryText);}catch{fail('checkpoint_conflict');}
              semanticSummary=prepareCohortSelectedSemanticSummaryV2(summary,semanticBefore.selected_ordinal,unionCounts.selected_count);
            }
            if(readingSelectedTransactionSource){
              if(semanticAnchor===null||semanticSummary===null)fail('unfinished_selected_semantic');
              // Independently reconcile the DONE parent's complete counters.
              // This does NOT turn its statistics into transaction authority.
              finalizeCohortSelectedSemanticSummaryV2(semanticSummary,unionCounts.selected_count,statisticsCounts);
            }
            eligibilityBefore=readingSelectedTransactionSource?{selected_ordinal:0,done:false}:semanticBefore;
          }
          if(readingSelectedTransactionIndex){
            selectedTransactionIndexExpected={...semanticExpected,semantic_reference:semanticAnchor.receipt_reference,
              generation_id:stock.generation_id,selected_stock_count:unionCounts.selected_count};
            const parentKeys=['union_reference','eligibility_reference','evidence_reference','metrics_reference','statistics_reference','numeric_reference','semantic_reference'];
            selectedTransactionIndexStore=createCustomCohortSelectedTransactionIndexV2Repository({client,claim,scope,
              actorUserId:input.auth.userId,command_id:issuedSelectionIntent.command_id,
              ...Object.fromEntries(parentKeys.map(k=>[k,selectedTransactionIndexExpected[k]]))});
            selectedTransactionIndexPacket=await selectedTransactionIndexStore.readNext();
            const nativePlan=selectedTransactionIndexPacket.plan;
            if(nativePlan.generation_id!==stock.generation_id||nativePlan.selected_stock_count!==unionCounts.selected_count)
              fail('selected_transaction_index_original_mismatch');
            if(checkpoint.phase==='frozen_selected_semantic_refs_v2'){
              if(selectedTransactionIndexPacket.previous!==null||nativePlan.before.selected_ordinal!==0)
                fail('checkpoint_conflict');
            }else{
              if(!same(selectedTransactionIndexPacket.previous,checkpoint.evidence_refs[16]))fail('checkpoint_conflict');
              const text=await readIssuedCheckpointReceipt(selectedTransactionIndexPacket.previous);
              if(text===null||Buffer.byteLength(text)>4096)fail('checkpoint_conflict');
              let retained;try{retained=JSON.parse(text);}catch{fail('checkpoint_conflict');}
              const expected={command_id:issuedSelectionIntent.command_id,...Object.fromEntries(parentKeys.map(k=>[k,selectedTransactionIndexExpected[k]])),
                generation_id:stock.generation_id,selected_stock_count:unionCounts.selected_count};
              retained=prepareCohortSelectedTransactionIndexReceiptV2(retained,expected);
              if(retained.after.done||retained.sequence!==nativePlan.before.selected_ordinal||!same(retained.after,nativePlan.before))
                fail('checkpoint_conflict');
            }
            eligibilityBefore={selected_ordinal:nativePlan.before.selected_ordinal,done:false};
            firstSelectedEntry=selectedTransactionIndexPacket.selected_entry;
          }
          else if(readingSelectedTransactionSource)firstSelectedEntry=await semanticStore.readFirstCompletedSelectedEntry();
          else if(progressingSelectedSemantic)firstSelectedEntry=await semanticStore.readNextSelectedEntry();
          else if(readingSelectedRankCandidates)firstSelectedEntry=await numericStore.readFirstCompletedSelectedEntry();
          else firstSelectedEntry=await (progressingSelectedNumeric?numericStore.readNextSelectedEntry():readingSelectedFrequencySource?(readingSelectedNumericSource?statisticsStore.readFirstIndexedFrequencyEntry():statisticsStore.readFirstFrequencyEntry()):readingSelectedStatisticsSource?(progressingSelectedStatistics?statisticsStore.readNextSelectedEntry():metricsStore.readFirstStatisticsEntry()):progressingSelectedMetrics?metricsStore.readNextSelectedEntry():readingSelectedMetricSource?evidenceStore.readFirstMetricEntry():progressingSelectedEvidence?evidenceStore.readNextSelectedEntry():
            progressingSelectedEligibility?eligibilityStore.readNextSelectedEntry():unionStore.readFirstSelectedEntry());
          if((firstSelectedEntry===null)!==(eligibilityBefore.selected_ordinal===unionCounts.selected_count)
            ||firstSelectedEntry!==null&&firstSelectedEntry.ordinal!==eligibilityBefore.selected_ordinal+1)fail('selected_union_original_mismatch');
          if(readingSelectedTransactionSource){
            if(readingSelectedTransactionIndex){
              const p=selectedTransactionIndexPacket.plan;
              selectedTransactionNativeKeys={generation_id:p.generation_id,account_id:p.selected_entry?.account_id??null,
                ordinal:p.selected_entry?.ordinal??null,anchor_count:p.anchor_count,
                native_packages:p.native_packages.map(({kind,native_key})=>({kind,native_key}))};
            }else selectedTransactionNativeKeys=await semanticStore.readFirstCompletedTransactionNativeKeys();
            if(selectedTransactionNativeKeys.generation_id!==stock.generation_id
              ||selectedTransactionNativeKeys.account_id!==(firstSelectedEntry?.account_id??null)
              ||selectedTransactionNativeKeys.ordinal!==(firstSelectedEntry?.ordinal??null))fail('selected_transaction_native_keys_mismatch');
          }
          if(preparingSelectedTransactionFirstCandidate){
            selectedTransactionCandidateStore=createCustomCohortSelectedTransactionIndexFirstCandidateV2Repository({client,claim,
              scope,actorUserId:input.auth.userId,command_id:issuedSelectionIntent.command_id,
              ...Object.fromEntries(['union_reference','eligibility_reference','evidence_reference','metrics_reference','statistics_reference','numeric_reference']
                .map(k=>[k,semanticExpected[k]])),semantic_reference:semanticAnchor.receipt_reference});
            selectedTransactionCandidatePlan=await selectedTransactionCandidateStore.readFirstCandidate();
            const expectedEntry=firstSelectedEntry===null?null:{account_id:firstSelectedEntry.account_id,ordinal:firstSelectedEntry.ordinal,
              partition_ordinal:firstSelectedEntry.partition_ordinal,entry_reference:firstSelectedEntry.entry_reference,
              metric_row_reference:firstSelectedEntry.row_reference,contribution_row_reference:firstSelectedEntry.contribution_row_reference};
            if(selectedTransactionCandidatePlan.generation_id!==stock.generation_id
              ||selectedTransactionCandidatePlan.selected_stock_count!==unionCounts.selected_count
              ||!same(selectedTransactionCandidatePlan.selected_entry,expectedEntry)
              ||selectedTransactionCandidatePlan.anchor_count!==selectedTransactionNativeKeys.anchor_count
              ||!same(selectedTransactionCandidatePlan.native_packages,selectedTransactionNativeKeys.native_packages))
              fail('selected_transaction_index_candidate_mismatch');
          }
          const preferred=resolveCustomCohortRetainedSubjectHousing(retained.subject.material,retained.subject.target,{check:budget.check}),
            graph={root,layer_counts:Object.fromEntries(COHORT_ORIGINAL_SOURCE_CHAIN_V1_KINDS.map(key=>[key,prefix.layers[key].row_count]))},
            paired=await (coveredNeutralOriginals&&readingSelectedUnionFirstAmenities?createNeighborhoodCoveredCadStockOriginalCellsV2
              :coveredNeutralOriginals?createNeighborhoodCoveredStockOriginalCellsV2:createNeighborhoodSharedStockOriginalCellsV2)(client,stockOptions,graph,context.effective_date,
                ...(coveredNeutralOriginals&&readingSelectedUnionFirstAmenities?[{purpose:cadPurpose,decision:cadDecision}]:[]))
              [readingSelectedTransactionIndex?'subjectAndNextSelectedTransactionIndexAccountPackage':readingSelectedTransactionSource?'subjectAndFirstCompletedSemanticAccountPackage':progressingSelectedSemantic?'subjectAndNextSelectedSemanticAccountPackage':readingSelectedRankCandidates?'subjectAndFirstCompletedNumericAccountPackage':progressingSelectedNumeric?'subjectAndNextSelectedNumericAccountPackage':readingSelectedFrequencySource?'subjectAndFirstSelectedFrequencyAccountPackage':progressingSelectedStatistics?'subjectAndNextSelectedStatisticsAccountPackage':readingSelectedStatisticsSource?'subjectAndFirstSelectedStatisticsAccountPackage':progressingSelectedMetrics?'subjectAndNextSelectedMetricAccountPackage':readingSelectedMetricSource?'subjectAndFirstSelectedMetricAccountPackage':progressingSelectedEvidence?'subjectAndNextSelectedCombinedAccountPackage':
                readingSelectedUnionFirstTransactions&&readingSelectedUnionFirstAmenities?'subjectAndFirstSelectedCombinedAccountPackage':
                readingSelectedUnionFirstTransactions?'subjectAndFirstSelectedTransactionAccountPackage':
                readingSelectedUnionFirstAmenities?'subjectAndFirstSelectedAmenityAccountPackage':
                progressingSelectedEligibility?'subjectAndNextEligibilityRecordedGroupHousingAccountPackage':
                'subjectAndFirstSelectedRecordedGroupHousingAccountPackage'](...[{includeSubject:preferred===null},
                  ...(readingSelectedUnionFirstTransactions?[input.observationPeriod]:[])]),
            packet=paired.next,subjectPacket=paired.subject_equals_next?packet:paired.subject;
          if((packet?.account_id??null)!==(firstSelectedEntry?.account_id??null))fail('selected_union_original_mismatch');
          if(preferred===null&&(subjectPacket?.account_id!==scope.account_id
            ||!same(subjectPacket.recorded_housing.retained_housing_interpretation,housingProfile)))fail('checkpoint_conflict');
          const subject=preferred??{state:subjectPacket.recorded_housing.state,category:subjectPacket.recorded_housing.category,origin:'current_subject_cad'};
          const subjectHousing={state:subject.state,category:subject.category};
          if(eligibilityIssued&&!same(eligibilityIssued.subject_housing,subjectHousing))fail('subject_changed');
          let decision=null;
          if(packet!==null){
            const housing=packet.recorded_housing,group=packet.recorded_group,candidate=group.state==='assigned'?group.candidate_groups[0]:null;
            if(!same(housing.retained_housing_interpretation,housingProfile))fail('checkpoint_conflict');
            if(group.state==='assigned'&&group.candidate_groups.length!==1)fail('catalog_original_mismatch');
            const text=await blobs.get(firstSelectedEntry.entry_reference.content_sha256,firstSelectedEntry.entry_reference.canonical_utf8_bytes);
            if(text===null||Buffer.byteLength(text)>1000000
              ||text!==canonicalAssessmentJson({format:'cohort_recorded_group_partition_entry_v2',account_id:packet.account_id,
                ordinal:firstSelectedEntry.partition_ordinal,recorded_group:group})
              ||firstSelectedEntry.state!==group.state||firstSelectedEntry.assigned_group_id!==group.assigned_group_id)
              fail('partition_original_mismatch');
            catalogReadGroupKey={group_id:group.assigned_group_id??'discovery:unassigned'};
            if(!issuedSelectionIntent.included_recorded_group_ids.includes(catalogReadGroupKey.group_id))fail('selected_union_original_mismatch');
            catalogReadGroup=await catalogStore.readGroup(catalogReadGroupKey);
            if(catalogReadGroup===null||catalogReadGroup.normalized_county!==(candidate?.normalized_county??null)
              ||catalogReadGroup.normalized_label!==(candidate?.normalized_label??null)
              ||catalogReadGroup.last_ordinal<firstSelectedEntry.partition_ordinal
              ||catalogReadGroup.last_ordinal>Number(stock.population.account_count)
              ||catalogReadGroup.member_count>Number(stock.population.account_count))fail('catalog_original_mismatch');
            decision=resolveNeighborhoodOriginalAccountEligibilityV2({subject:{state:subject.state,category:subject.category},
              housing:{state:housing.state,category:housing.category,county_state:housing.county_state,
                source_part_count:housing.source_part_count,part_states:housing.part_states},
              original_counts:packet.original_counts,observations:packet.observations});
          }
          if(progressingSelectedEligibility){
            const eligible=decision===null?null:Object.fromEntries(SELECTED_RECORDED_ELIGIBILITY_METRICS
              .map(k=>[k,decision.metrics[k].recorded_comparison_eligible]));
            eligibilityPlan=prepareCohortSelectedEligibilityReceiptV2({format:'cohort_selected_recorded_eligibility_receipt_v2',
              ...eligibilityExpected,subject_housing:subjectHousing,sequence:(eligibilityAnchor?.sequence??0)+1,
              previous:eligibilityAnchor?.receipt_reference??null,before:eligibilityBefore,
              after:{selected_ordinal:eligibilityBefore.selected_ordinal+Number(firstSelectedEntry!==null),done:firstSelectedEntry===null},
              selected_entry:firstSelectedEntry===null?null:{account_id:firstSelectedEntry.account_id,ordinal:firstSelectedEntry.ordinal,
                partition_ordinal:firstSelectedEntry.partition_ordinal,entry_reference:firstSelectedEntry.entry_reference},eligible,
              before_counts:eligibilityCounts,after_counts:Object.fromEntries(SELECTED_RECORDED_ELIGIBILITY_METRICS
                .map(k=>[k,eligibilityCounts[k]+Number(eligible?.[k]??false)]))},eligibilityExpected);
          }
          if(progressingSelectedEvidence){
            evidencePlan=prepareCohortSelectedEvidenceReceiptV2({format:'cohort_selected_evidence_receipt_v2',...evidenceExpected,
              sequence:(evidenceAnchor?.sequence??0)+1,previous:evidenceAnchor?.receipt_reference??null,before:eligibilityBefore,
              after:{selected_ordinal:eligibilityBefore.selected_ordinal+Number(firstSelectedEntry!==null),done:firstSelectedEntry===null},
              selected_entry:firstSelectedEntry===null?null:{account_id:firstSelectedEntry.account_id,ordinal:firstSelectedEntry.ordinal,
                partition_ordinal:firstSelectedEntry.partition_ordinal,entry_reference:firstSelectedEntry.entry_reference}},evidenceExpected);
          }
          if(readingSelectedMetricSource){
            // Numerical cells come only from THIS fresh original/ENTIRE-cache
            // replay, never from the metadata-only sixth acknowledgement.
            // The read-only stage stays fixed at ordinal1; the seventh stage
            // uses only the newly reopened native next ordinal, not a roster.
            const metricRowMetadata=firstSelectedEntry===null?null:{command_id:issuedSelectionIntent.command_id,
              union_reference:unionAnchor.receipt_reference,eligibility_reference:eligibilityAnchor.receipt_reference,
              evidence_reference:evidenceAnchor.receipt_reference,selected_entry:Object.fromEntries(
                ['account_id','ordinal','partition_ordinal','entry_reference'].map(k=>[k,firstSelectedEntry[k]])),
              effective_date:context.effective_date,observation_period:input.observationPeriod,subject_housing:subjectHousing,
              housing_comparison:decision.housing.state};
            // Closed row derived INSIDE this bounded original owner. It is not
            // a capability. The read-only stage never retains it; the seventh
            // stage writes only AFTER all unchanged ending fences below pass.
            const metricRowCandidate=metricRowMetadata===null?null:prepareCohortSelectedMetricRowV2({
              format:'cohort_selected_reported_metric_row_v2',...metricRowMetadata,
              metrics:Object.fromEntries(Object.entries(decision.metrics).map(([k,c])=>[k,Object.fromEntries(
                ['recorded_comparison_eligible','complete_observed_parts','exact_value','unit'].map(field=>[field,c[field]]))])),
              basis:SELECTED_REPORTED_METRIC_ROW_V2_BASIS},metricRowMetadata);
            if(progressingSelectedMetrics)metricsRowCandidate=metricRowCandidate;
            let statisticsContribution=null;
            if(readingSelectedStatisticsSource&&firstSelectedEntry!==null){
              const text=await blobs.get(firstSelectedEntry.row_reference.content_sha256,firstSelectedEntry.row_reference.canonical_utf8_bytes);
              if(text===null||Buffer.byteLength(text)>4096)fail('selected_metric_original_mismatch');
              let row;try{row=JSON.parse(text);}catch{fail('selected_metric_original_mismatch');}
              // A retained hash/reference or lossy null bucket is NOT a source
              // grant. Reconcile every closed metadata/cell to THIS fresh full
              // original replay, retaining its separate original reason states.
              try{row=prepareCohortSelectedMetricRowV2(row,metricRowMetadata);}catch{fail('selected_metric_original_mismatch');}
              if(!same(row,metricRowCandidate))fail('selected_metric_original_mismatch');
              // Preserve the original five-way value states, complete-part
              // and housing exclusions separately. Never classify a retained
              // null as missing or count source parts as selected accounts.
              statisticsContribution=prepareCohortSelectedStatisticsContributionV2({subject:subjectHousing,
                housing:{state:packet.recorded_housing.state,category:packet.recorded_housing.category,
                  county_state:packet.recorded_housing.county_state,source_part_count:packet.recorded_housing.source_part_count,
                  part_states:packet.recorded_housing.part_states},original_counts:packet.original_counts,
                observations:packet.observations},row,{metric_metadata:metricRowMetadata,
                metrics_reference:metricsAnchor.receipt_reference,metric_row_reference:firstSelectedEntry.row_reference});
              if(readingSelectedFrequencySource){
                const retainedText=await blobs.get(firstSelectedEntry.contribution_row_reference.content_sha256,
                  firstSelectedEntry.contribution_row_reference.canonical_utf8_bytes);
                if(retainedText===null||Buffer.byteLength(retainedText)>4096)fail('selected_contribution_original_mismatch');
                let retainedContribution;try{retainedContribution=JSON.parse(retainedText);}catch{fail('selected_contribution_original_mismatch');}
                // Compare EVERY original-derived metadata, state, part, reason,
                // exact value and unit field. Hashes, eligible totals and the
                // lossy seventh null bucket grant NO source authority.
                if(!same(retainedContribution,statisticsContribution))fail('selected_contribution_original_mismatch');
                if(readingSelectedNumericSource){
                  // The numeric index is not source authority. Compare EVERY
                  // indexed value/null to THIS fresh complete original replay,
                  // not to old counts, hashes, a caller callback or a roster.
                  for(const key of ['reported_year_built','reported_residential_area','reported_site_area'])
                    if(firstSelectedEntry[key]!==statisticsContribution.metrics[key].contribution_exact_value)
                      fail('selected_numeric_original_mismatch');
                }
              }
            }
            if(readingSelectedTransactionSource){
              if(paired.selected_transaction_membership===null||paired.selected_transaction_membership===undefined)fail('selected_transaction_membership_missing');
              selectedTransactionSource={membership:paired.selected_transaction_membership,
                native_packages:paired.selected_transactions===null?[]:paired.selected_transactions.packages.map(p=>({kind:p.kind,native_key:p.native_key})),
                transaction_original_count:paired.selected_transactions?.original_count??0,
                distinct_original_count:paired.distinct_original_count};
              // BOTH-direction exact native key-set equality against a separate
              // bounded ORIGINAL query. Counts/hashes are not substitutes for
              // membership. Only this account's <=250 keys are compared; no
              // full-population array or economics/deduplication is inferred.
              const ordered=keys=>keys.map(p=>`${p.kind}:${p.native_key}`).sort();
              if(!same(ordered(selectedTransactionNativeKeys.native_packages),ordered(selectedTransactionSource.native_packages))
                ||selectedTransactionNativeKeys.anchor_count!==selectedTransactionSource.membership.associations.filter(
                  row=>row.account_id===firstSelectedEntry?.account_id).length)fail('selected_transaction_native_keys_mismatch');
            }
            if(progressingSelectedStatistics||progressingSelectedSemantic)statisticsCandidate=statisticsContribution;
            subjectHousingResult={status:progressingSelectedMetrics?'current_authorized_next_selected_metric_originals_reopened':'current_authorized_first_selected_metric_originals_reopened',operation_id:input.operationId,
              ...(readingSelectedStatisticsSource?{status:'current_authorized_first_selected_statistics_originals_reconciled',
                metrics_reference:metricsAnchor.receipt_reference,retained_metric_row_reconciled:firstSelectedEntry!==null,
                statistics_contribution_candidate:statisticsContribution,statistics_contribution_retained:false}:{}),
              command_id:issuedSelectionIntent.command_id,union_reference:unionAnchor.receipt_reference,
              eligibility_reference:eligibilityAnchor.receipt_reference,evidence_reference:evidenceAnchor.receipt_reference,
              selected_entry:firstSelectedEntry,subject,subject_original_fallback:preferred===null,
              subject_equals_selected:paired.subject_equals_next,distinct_original_count:paired.distinct_original_count,
              reported_comparison:decision,metric_row_candidate:metricRowCandidate,metric_row_retained:false,
              retained_effective_date:context.effective_date,retained_observation_period:input.observationPeriod,
              original_reconciliation:'every_selected_stock_CAD_whole_all_date_transaction_and_required_subject_original_entire_cache_partition_catalog_reopened',
              coverage:readingSelectedStatisticsSource?'fixed_first_native_selected_ordinal_only_after_DONE_union_fifth_sixth_and_seventh':progressingSelectedMetrics?'native_next_selected_ordinal_after_DONE_union_fifth_and_sixth':'fixed_first_native_selected_ordinal_only_after_DONE_union_fifth_and_sixth',empty_selected_union:firstSelectedEntry===null,
              shared_budget:'one_single_use_child_one_aggregate_250_original_transport_output_SQL_deadline_budget',
              numerical_basis:'current_reported_comparison_not_verified_GLA_currency_historical_housing_or_economic_transaction',
              complete_selected_union_metric_population:false,statistics:'not_established',publication:'not_established',
              source_acquisition:'not_established',context_complete:false,pin_transfer:false,read_only:true,lease_extended:false,report_update:'none'};
            if(Buffer.byteLength(JSON.stringify(subjectHousingResult))>16000)fail('byte_limit');
            if(readingSelectedRankCandidates||progressingSelectedSemantic&&semanticAnchor===null){
              // Only after this call's complete first-account original and
              // EVERY seventh/eighth/index comparison. All ending authority
              // and native-member/head fences still run AFTER this query.
              // Ranks stay provisional; no whole-population source grant.
              provisionalRankCandidates=await createCustomCohortSelectedNumericRankCandidatesV2Repository({client,claim,scope,
                actorUserId:input.auth.userId,command_id:issuedSelectionIntent.command_id,
                union_reference:unionAnchor.receipt_reference,eligibility_reference:eligibilityAnchor.receipt_reference,
                evidence_reference:evidenceAnchor.receipt_reference,metrics_reference:metricsAnchor.receipt_reference,
                statistics_reference:statisticsAnchor.receipt_reference,numeric_reference:numericAnchor.receipt_reference}).read();
              if(progressingSelectedSemantic)semanticSummary=initializeCohortSelectedSemanticSummaryV2(provisionalRankCandidates.metrics,unionCounts.selected_count);
            }
          }else if(!progressingSelectedEvidence){
          // Presentation only, AFTER every original/ENTIRE cache and separate
          // source fence has passed. Repeating installed definition text in
          // the result exceeded the existing16KB owner cap even for one native
          // account. Keep exact metadata/profile references and ALL observations
          // without widening any budget or using references as replay authority.
          let selectedCadResult=null;
          if(readingSelectedUnionFirstAmenities){
            const cad=paired.selected_CAD,{source_definition_json,...metadata}=cad.source_metadata,
              compactProfile=p=>({profile_ref:p.profile_ref,definition_blob:p.definition_blob.ref});
            selectedCadResult={...cad,source_metadata:{...metadata,source_definition_reference:prepareNeighborhoodCohortBlob(source_definition_json)},
              typed_profile:compactProfile(cad.typed_profile),amenity_evidence:cad.amenity_evidence===null?null:
                {...cad.amenity_evidence,profile:compactProfile(cad.amenity_evidence.profile)}};
          }
          // Retain every native association/observation/marker, but omit only
          // repeated row-level dates/constant limitations already stated once
          // on the whole package. The unchanged16KB owner cap still refuses
          // larger envelopes, never truncates or relabels a partial package.
          const cellFields=['state','exact_value','unit','reason'],markerFields=['state','json_type','value_text','utf8_bytes','value_sha256'],
            dateFields=['state','exact_value','reason'],tuples=(values,fields)=>Object.fromEntries(Object.entries(values).map(([k,v])=>[k,fields.map(f=>v[f])])),
            selectedTransactions=readingSelectedUnionFirstTransactions?{...paired.selected_transactions,
            diagnostic_encoding:{format:'fixed_field_tuples_v1',cell_fields:cellFields,marker_fields:markerFields,date_fields:dateFields},
            packages:paired.selected_transactions.packages.map(p=>({kind:p.kind,native_key:p.native_key,counts:p.counts,
              associations:p.associations,rows:p.rows.map(({stock_member,projection:r})=>({stock_member,kind:r.kind,
                row_key:r.row_key,account_id:r.account_id,source_record_id:r.source_record_id,original:r.original,
                markers:tuples(r.markers,markerFields),normalized:{...r.normalized,observations:tuples(r.normalized.observations,cellFields),
                  dates:tuples(r.normalized.dates,dateFields)},same_payload_reported_sale:r.same_payload_reported_sale===null?null:
                  {...r.same_payload_reported_sale,observations:tuples(r.same_payload_reported_sale.observations,cellFields)}}))}))}:null;
          subjectHousingResult={status:readingSelectedUnionFirstTransactions&&readingSelectedUnionFirstAmenities
            ?'current_authorized_first_selected_combined_originals_reopened'
            :readingSelectedUnionFirstTransactions?'current_authorized_first_selected_original_transactions_reopened'
            :readingSelectedUnionFirstAmenities?'current_authorized_first_selected_original_amenities_reopened'
            :'current_authorized_first_selected_original_recorded_eligibility_reopened',operation_id:input.operationId,
            command_id:issuedSelectionIntent.command_id,union_reference:unionAnchor.receipt_reference,catalog_reference:catalogAnchor.receipt_reference,
            partition_reference:partitionAnchor.receipt_reference,subject_reference:retained.subjectReference,
            subject_intent_reference:retained.intent.reference,stock_reference:stockReference,source_reference:reference,graph_reference:root,
            verification_reference:verificationReference,stock_verification_reference:stockVerificationReference,
            identity_verification_reference:identityVerificationReference,retained_effective_date:context.effective_date,
            subject,subject_original_fallback:preferred===null,subject_equals_selected:paired.subject_equals_next,
            distinct_original_count:paired.distinct_original_count,
            ...(readingSelectedUnionFirstAmenities?{CAD_source_authorization:{purpose:cadPurpose,decision:cadDecision},
              selected_CAD:selectedCadResult,complete_selected_union_amenities:false,
              amenity_scope:'current_retained_local_reported_pool_and_unresolved_secondary_inventory_not_verified_dictionary_or_historical'}:{}),
            ...(readingSelectedUnionFirstTransactions?{selected_transactions:selectedTransactions,
              transaction_scope:'all_date_native_associations_not_economic_equivalence_allocation_or_verified_completion',
              retained_observation_period:input.observationPeriod,complete_selected_union_transactions:false}:{}),
            selected_entry:firstSelectedEntry,decision,empty_selected_union:firstSelectedEntry===null,
            coverage:'fixed_first_native_selected_ordinal_only_not_complete_eligibility',
            original_reconciliation:'every_selected_and_required_subject_original_all_outside_parts_entire_neutral_cache_full_partition_and_catalog_literals',
            shared_budget:'one_single_use_child_one_aggregate_original_transport_output_SQL_deadline_budget',
            authority:'not_established',read_only:true,lease_extended:false,issued_eligibility_progress:false,
            complete_selected_union_eligibility:false,statistics:'not_established',publication:'not_established',
            context_complete:false,pin_transfer:false,source_acquisition:'not_established',report_update:'none'};
          if(readingSelectedUnionFirstTransactions&&readingSelectedUnionFirstAmenities){
            // Lossless JSON presentation after complete original/cache replay.
            // Entire closed V2 JSON is compressed only for transport. Shapes,
            // strings and every observation expand exactly, never omitted or
            // replaced by hashes. Separate source methods stay unchanged; the
            // dormant combined consumer explicitly declares this format.
            subjectHousingResult={...subjectHousingResult,combined_diagnostic_encoding:'cohort_diagnostic_compressed_json_v1',
              selected_CAD:encodeCohortDiagnosticCompressedJsonV1(selectedCadResult),
              selected_transactions:encodeCohortDiagnosticCompressedJsonV1(selectedTransactions)};
          }
          if(Buffer.byteLength(JSON.stringify(subjectHousingResult))>16000)fail('byte_limit');
          }else{
            // No diagnostic/payload/typed/decision copies. ALL reconciliation
            // above is mandatory; references/counts cannot replace originals.
            subjectHousingResult={operation_id:input.operationId,command_id:issuedSelectionIntent.command_id,
              union_reference:unionAnchor.receipt_reference,eligibility_reference:eligibilityAnchor.receipt_reference,
              selected_entry:firstSelectedEntry,distinct_original_count:paired.distinct_original_count,
              subject_original_fallback:preferred===null,subject_equals_selected:paired.subject_equals_next,
              original_reconciliation:'every_selected_stock_CAD_whole_all_date_transaction_and_required_subject_original_entire_cache_partition_catalog_reopened',
              shared_budget:'one_single_use_child_one_aggregate_250_original_transport_output_SQL_deadline_budget',
              later_semantic_consumer:'must_independently_reopen_originals_not_rely_on_this_acknowledgement',
              economic_transaction_equivalence:'not_established',verified_amenity_dictionary:'not_established',
              complete_selected_union_eligibility:false,statistics:'not_established',publication:'not_established',
              context_complete:false,pin_transfer:false,source_acquisition:'not_established',report_update:'none'};
          }
        }else if(readingSelectedUnionSubjectHousing){
          // Retained subject material already passed exact native intent and
          // current comparison above. Only genuinely absent preferred inputs
          // permit original CAD fallback; no current defaults or workspace
          // housing, stock member, selected group or caller result can replace it.
          const preferred=resolveCustomCohortRetainedSubjectHousing(retained.subject.material,retained.subject.target,{check:budget.check});
          let packet=null;
          if(preferred===null){
            const graph={root,layer_counts:Object.fromEntries(COHORT_ORIGINAL_SOURCE_CHAIN_V1_KINDS.map(key=>[key,prefix.layers[key].row_count]))};
            packet=await (coveredNeutralOriginals?createNeighborhoodCoveredStockOriginalCellsV2:createNeighborhoodSharedStockOriginalCellsV2)(client,stockOptions,graph,context.effective_date)
              .subjectHousingAccountPackage();
            if(packet.account_id!==scope.account_id||packet.recorded_housing===null
              ||!same(packet.recorded_housing.retained_housing_interpretation,housingProfile))fail('checkpoint_conflict');
          }
          subjectHousingResult={status:'current_authorized_selected_union_subject_housing_reopened',operation_id:input.operationId,
            command_id:issuedSelectionIntent.command_id,union_reference:unionAnchor.receipt_reference,
            subject_reference:retained.subjectReference,subject_intent_reference:retained.intent.reference,
            stock_reference:stockReference,source_reference:reference,graph_reference:root,
            verification_reference:verificationReference,stock_verification_reference:stockVerificationReference,
            identity_verification_reference:identityVerificationReference,catalog_reference:catalogAnchor.receipt_reference,
            subject_account_id:scope.account_id,retained_effective_date:context.effective_date,housing_profile:housingProfile,
            authority:'not_established',basis:'retained_current_housing_observations_not_verified_or_historical_housing',
            subject:preferred??{state:packet.recorded_housing.state,category:packet.recorded_housing.category,origin:'current_subject_cad'},
            fallback:packet===null?{status:'not_used_preferred_retained_subject_observation'}:
              {status:'whole_original_subject_account_reconciled',original_counts:packet.original_counts,
                geographic_parcel_count:packet.geographic_parcel_count,recorded_housing:packet.recorded_housing},
            precedence:'saved_then_retained_public_then_actual_subject_CAD_only_absent_falls_back_no_cross_source_merge',
            current_authorized_owner:'V2_issued_graph_geography_identity_traversal_partition_catalog_completed_union_and_current_rights',
            read_only:true,lease_extended:false,issued_eligibility_progress:false,complete_selected_union_eligibility:false,
            statistics:'not_established',publication:'not_established',context_complete:false,pin_transfer:false,
            source_acquisition:'not_established',report_update:'none'};
        }else{
        // No caller cursor, free group body or traversal-only authority. Replay
        // EVERY original of ONE exact next account against its ENTIRE cache.
        const before=replayingSelectedUnion?unionIssued?.after??{after_account:'',account_count:0,done:false}
          :readingRecordedPartition?{after_account:stockAccountInput.cursor}
          :catalogingRecordedGroups?catalogIssued?.after??{after_account:'',account_count:0,done:false}
          :issued?.after??{after_account:'',account_count:0,done:false},
          graph={root,layer_counts:Object.fromEntries(COHORT_ORIGINAL_SOURCE_CHAIN_V1_KINDS.map(key=>[key,prefix.layers[key].row_count]))};
        const createOriginals=coveredNeutralOriginals?createNeighborhoodCoveredStockOriginalCellsV2:createNeighborhoodSharedStockOriginalCellsV2;
        const accountOriginals=createOriginals(client,stockOptions,graph,context.effective_date);
        // Future selection eligibility must not reopen the same account for
        // housing under a second child budget. The pending-target reader gets
        // every retained-date cell, full recorded label and housing state from
        // this ONE original/ENTIRE-neutral-cache reconciliation. No membership
        // or human intent is inferred from these account facts.
        let packet;
        if(replayingSelectedUnion){
          const preferred=resolveCustomCohortRetainedSubjectHousing(retained.subject.material,retained.subject.target,{check:budget.check}),
            paired=await accountOriginals.subjectAndRecordedGroupHousingAccountPackage({cursor:before.after_account},{includeSubject:preferred===null}),
            subjectPacket=paired.subject_equals_next?paired.next:paired.subject;
          if(preferred===null&&(subjectPacket?.account_id!==scope.account_id
            ||!same(subjectPacket.recorded_housing.retained_housing_interpretation,housingProfile)))fail('checkpoint_conflict');
          unionSubjectHousing={subject:preferred??{state:subjectPacket.recorded_housing.state,
            category:subjectPacket.recorded_housing.category,origin:'current_subject_cad'},
          subject_original_fallback:preferred===null,subject_equals_next:paired.subject_equals_next,
          distinct_original_count:paired.distinct_original_count,
          shared_budget:'one_single_use_child_one_aggregate_original_transport_output_SQL_deadline_budget',
          eligibility:'not_established'};
          packet={...(paired.next??{account_id:null,recorded_housing:null,recorded_group:null}),
            next_cursor:paired.next_cursor,end_of_accounts:paired.end_of_accounts};
        }else packet=await accountOriginals[readingSelectionWorkspaceTarget
          ?'recordedGroupAndHousingAccountPackage':'recordedGroupAccountPackage']({cursor:before.after_account});
        if(replayingSelectedUnion&&packet.recorded_housing!==null
          &&!same(packet.recorded_housing.retained_housing_interpretation,housingProfile))fail('checkpoint_conflict');
        if(before.done&&!packet.end_of_accounts)fail('checkpoint_conflict');
        let receipt=issued,advanced=false;
        if(!readingRecordedPartition&&!catalogingRecordedGroups&&!before.done){
          const ordinal=before.account_count+1,after={after_account:packet.next_cursor,
            account_count:before.account_count+(packet.account_id===null?0:1),done:packet.end_of_accounts};
          if(!same(await blobs.put(profile.definition_blob.canonical_json),profile.definition_blob.ref))fail('checkpoint_conflict');
          let entry=null;
          if(packet.account_id!==null){
            const body={format:'cohort_recorded_group_partition_entry_v2',account_id:packet.account_id,ordinal,recorded_group:packet.recorded_group},
              text=canonicalAssessmentJson(body);
            if(Buffer.byteLength(text)>1000000)fail('byte_limit');
            entry={account_id:packet.account_id,ordinal,entry_reference:await blobs.put(text),
              state:packet.recorded_group.state,assigned_group_id:packet.recorded_group.assigned_group_id};
          }
          receipt=prepareCohortRecordedGroupPartitionReceiptV2({format:'cohort_recorded_group_partition_receipt_v2',...expected,
            sequence:(partitionAnchor?.sequence??0)+1,previous:partitionAnchor?.receipt_reference??null,before,after,
            entry_reference:entry?.entry_reference??null},expected);
          const receiptReference=await blobs.put(canonicalAssessmentJson(receipt));
          partitionAnchor=await partitionStore.advance(partitionAnchor,receiptReference,entry);
          await jobs.saveCheckpoint(claim,jobOptions,{phase:'frozen_recorded_partition_refs_v2',evidence_refs:[retained.intent.reference,
            stockReference,reference,verificationReference,stockVerificationReference,identityVerificationReference,
            traversalAnchor.receipt_reference,receiptReference]});
          advanced=true;
        }
        partitionResult={status:'original_recorded_partition_progress_retained',operation_id:input.operationId,advanced,
          partition_reference:partitionAnchor.receipt_reference,progress:receipt.after,stock_reference:stockReference,
          traversal_reference:traversalAnchor.receipt_reference,profile_reference:profile.definition_blob.ref,
          retained_effective_date:context.effective_date,retained_observation_period:input.observationPeriod,
          original_reconciliation:'every_partitioned_whole_account_original_and_entire_neutral_cache_replayed',
          membership_basis:'current_recorded_labels_including_outside_parts_and_unassigned_denominator',
          later_semantic_consumer:'must_reopen_every_original_and_compare_entire_partition_entry',
          selected_union:'not_established',statistics:'not_established',source_acquisition:'not_established',report_update:'none'};
        if(readingRecordedPartition||catalogingRecordedGroups){
          partitionReadCursor=before.after_account;partitionReadEntry=await partitionStore.readNextEntry(partitionReadCursor);
          if(packet.account_id!==partitionReadEntry?.account_id&&!(packet.account_id===null&&partitionReadEntry===null))fail('partition_original_mismatch');
          if(partitionReadEntry){
            const text=await blobs.get(partitionReadEntry.entry_reference.content_sha256,partitionReadEntry.entry_reference.canonical_utf8_bytes);
            if(text===null||Buffer.byteLength(text)>1000000
              ||text!==canonicalAssessmentJson({format:'cohort_recorded_group_partition_entry_v2',account_id:packet.account_id,
                ordinal:partitionReadEntry.ordinal,recorded_group:packet.recorded_group})
              ||partitionReadEntry.state!==packet.recorded_group.state||partitionReadEntry.assigned_group_id!==packet.recorded_group.assigned_group_id)
              fail('partition_original_mismatch');
          }
          partitionResult={...packet,status:'original_reconciled_recorded_partition_account',coverage:'one_original_reconciled_partition_account_only',
            partition_reference:partitionAnchor.receipt_reference,partition_ordinal:partitionReadEntry?.ordinal??null,
            traversal_reference:traversalAnchor.receipt_reference,source_reference:reference,verification_reference:verificationReference,
            stock_verification_reference:stockVerificationReference,identity_verification_reference:identityVerificationReference,
            retained_effective_date:context.effective_date,retained_observation_period:input.observationPeriod,
            current_authorized_owner:'V2_issued_graph_geography_identity_traversal_partition_and_current_original_source_rights',
            partition_reconciliation:'entire_derived_entry_compared_to_every_current_authorized_original_and_entire_neutral_cache',
            selected_union:'not_established',statistics:'not_established',report_update:'none'};
          if(readingRecordedCatalog){
            if(partitionReadEntry){
              const group=packet.recorded_group,candidate=group.state==='assigned'?group.candidate_groups[0]:null;
              if(group.state==='assigned'&&group.candidate_groups.length!==1)fail('catalog_original_mismatch');
              catalogReadGroupKey={group_id:group.assigned_group_id??'discovery:unassigned'};
              catalogReadGroup=await catalogStore.readGroup(catalogReadGroupKey);
              if(catalogReadGroup===null||catalogReadGroup.normalized_county!==(candidate?.normalized_county??null)
                ||catalogReadGroup.normalized_label!==(candidate?.normalized_label??null)
                ||catalogReadGroup.last_ordinal<partitionReadEntry.ordinal
                ||catalogReadGroup.last_ordinal>Number(stock.population.account_count)
                ||catalogReadGroup.member_count>Number(stock.population.account_count))fail('catalog_original_mismatch');
            }
            partitionResult={...partitionResult,
              status:'original_reconciled_recorded_catalog_account',coverage:'one_original_reconciled_catalog_account_only',
              catalog_reference:catalogAnchor.receipt_reference,
              current_authorized_owner:'V2_issued_graph_geography_identity_traversal_partition_catalog_and_current_original_source_rights',
              catalog_reconciliation:'issued_complete_head_and_native_counts_fenced_both_ends_not_complete_original_catalog_replay',
              catalog_group_identity_reconciliation:'one_original_derived_exact_group_and_normalized_literals_fenced_both_ends_not_group_count_authority',
              complete_catalog_original_replay:false,catalog_membership_counts:'not_delivered_as_semantic_authority',
              selection_intent:'not_established',publication:'not_established'};
            if(readingSelectionWorkspaceTarget)partitionResult={...partitionResult,
              status:'original_reconciled_selection_workspace_target_account',selection_workspace_target:selectionWorkspaceTarget,
              selection_target_reconciliation:'current_exact_pending_job_study_and_prior_V7_head_fenced_both_ends',
              account_fact_reconciliation:'retained_date_metrics_recorded_group_and_housing_from_one_whole_original_packet',
              prior_active_choice:'not_carried_into_new_study',genuine_new_group_choice:'not_established'};
            if(Buffer.byteLength(JSON.stringify(partitionResult))>NEIGHBORHOOD_STOCK_ORIGINAL_CELLS_V2_LIMITS.output_utf8_bytes)fail('byte_limit');
            budget.check();
          }
        }
        if(replayingSelectedUnion){
          if(partitionReadEntry&&partitionReadEntry.ordinal!==before.account_count+1)fail('partition_original_mismatch');
          if(partitionReadEntry){
            // Transient ONE-account decision only, never a persisted semantic
            // capability or a complete eligibility receipt. The facts above
            // came from EVERY original/all outside parts and ENTIRE cache in
            // the same subject/next aggregate budget. Unknown/incomplete parts
            // remain explicit; selected stock is not automatically eligible.
            const housing=packet.recorded_housing,subject=unionSubjectHousing.subject;
            unionAccountEligibility={account_id:packet.account_id,partition_ordinal:partitionReadEntry.ordinal,
              decision:resolveNeighborhoodOriginalAccountEligibilityV2({
                subject:{state:subject.state,category:subject.category},
                housing:{state:housing.state,category:housing.category,county_state:housing.county_state,
                  source_part_count:housing.source_part_count,part_states:housing.part_states},
                original_counts:packet.original_counts,observations:packet.observations})};
            unionExpectedSelected=issuedSelectionIntent.included_recorded_group_ids.includes(packet.recorded_group.assigned_group_id??'discovery:unassigned');
            if(Buffer.byteLength(JSON.stringify(unionAccountEligibility))>8192)fail('byte_limit');
          }
          // ONE already-original-reconciled account only. Writes are postponed
          // until ALL current ending fences below, including exact intent and
          // server head/count checks; no second reader or budget is opened.
          unionPlan={before,after:{after_account:packet.next_cursor,
            account_count:before.account_count+(packet.account_id===null?0:1),done:packet.end_of_accounts},
          entry:partitionReadEntry?{account_id:packet.account_id,partition_ordinal:partitionReadEntry.ordinal,
            entry_reference:partitionReadEntry.entry_reference,group_id:packet.recorded_group.assigned_group_id??'discovery:unassigned'}:null};
        }
        if(catalogingRecordedGroups&&!replayingSelectedUnion){
          let catalogReceipt=catalogIssued,advanced=false;
          if(!before.done){
            const beforeCounts=catalogCounts;
            if(partitionReadEntry){
              if(partitionReadEntry.ordinal!==before.account_count+1)fail('partition_original_mismatch');
              const group=packet.recorded_group,candidate=group.state==='assigned'?group.candidate_groups[0]:null;
              if(group.state==='assigned'&&group.candidate_groups.length!==1)fail('partition_original_mismatch');
              catalogCounts=await catalogStore.contribute(catalogAnchor,{account_id:packet.account_id,ordinal:partitionReadEntry.ordinal,
                group_id:group.assigned_group_id??'discovery:unassigned',normalized_county:candidate?.normalized_county??null,
                normalized_label:candidate?.normalized_label??null});
            }
            const after={after_account:packet.next_cursor,account_count:before.account_count+(packet.account_id===null?0:1),done:packet.end_of_accounts};
            catalogReceipt=prepareCohortRecordedCatalogReceiptV2({format:'cohort_recorded_catalog_receipt_v2',...catalogExpected,
              sequence:(catalogAnchor?.sequence??0)+1,previous:catalogAnchor?.receipt_reference??null,before,after,
              entry_reference:partitionReadEntry?.entry_reference??null,before_counts:beforeCounts,after_counts:catalogCounts},catalogExpected);
            const catalogReference=await blobs.put(canonicalAssessmentJson(catalogReceipt));
            catalogAnchor=await catalogStore.advance(catalogAnchor,catalogReference);
            await jobs.saveCheckpoint(claim,jobOptions,{phase:'frozen_recorded_catalog_refs_v2',evidence_refs:[...checkpoint.evidence_refs.slice(0,8),catalogReference]});
            advanced=true;
          }
          catalogResult={status:'original_recorded_catalog_progress_retained',operation_id:input.operationId,advanced,
            catalog_reference:catalogAnchor.receipt_reference,partition_reference:partitionAnchor.receipt_reference,
            progress:catalogReceipt.after,counts:catalogCounts,retained_effective_date:context.effective_date,
            original_reconciliation:'every_catalog_account_original_entire_neutral_cache_and_entire_partition_entry_replayed',
            group_limit:2048,overflow:'whole_step_refusal_not_truncation',unassigned_candidates:'not_promoted_to_membership',
            raw_variants:'retained_in_complete_original_and_partition_lineage_not_duplicated',
            later_semantic_consumer:'must_reopen_originals_and_reconcile_complete_catalog_lineage',
            selected_union:'not_established',statistics:'not_established',publication:'not_established',report_update:'none'};
        }
        }
      }
      input=freeze({...input,auth:await loadCurrentCustomCohortJobActor(client,input.auth.userId,scope.organization_id)});
      assertTarget(await resolveTarget(client,input,true),target);
      privateDraft(await privateCaptureWorkfile(client,input));
      if((await subjects.compareCurrent(retained.subjectReference)).status!=='matched') fail('subject_changed');
      authorizePublicCadastralCatalogRead(input.auth,input.accountId,{workflows:['custom_appraisal'],
        permissionChecker:(auth,workflow,permission)=>hasApplicationPermission(auth,workflow,permission,scope.organization_id)});
      if(!same(await boundedPolicy(authorizeMarketData,client,input.auth,context,purpose,budget),decision)) fail('market_policy_changed');
      if(selectingCatalogIntent||readingRetainedSelectionIntent||replayingSelectedUnion)await checkSelectionIntentKnownGroups();
      if(readingCadSource&&!same(await boundedPolicy(authorizeCadImprovementData,client,input.auth,context,cadPurpose,budget),cadDecision))
        fail('CAD_source_policy_changed');
      await assertManualCadCache();
      if(cadContinuation)await cadContinuation.assertClaim(claim,jobOptions);
      if(!sameFrozenRequest(await jobs.readRequest(claim,jobOptions),requested)||!same(await stockStore.read(),stock)) fail('checkpoint_conflict');
      if(!same((await chain.describe(root)).layers,prefix.layers)) fail('checkpoint_conflict');
      if(sourcePrefixStore&&!same(await sourcePrefixStore.read(),sourcePrefixHead))fail('checkpoint_conflict');
      if(graphAnchorStore&&!same(await graphAnchorStore.read(),graphAnchor))fail('checkpoint_conflict');
      if(geographicAnchorStore&&!same(await geographicAnchorStore.read(),geographicAnchor))fail('checkpoint_conflict');
      if(identityAnchorStore&&!same(await identityAnchorStore.read(),identityAnchor))fail('checkpoint_conflict');
      if(neutralCacheStore&&!same(await neutralCacheStore.read(),neutralCacheHead))fail('checkpoint_conflict');
      if(cadCoverageStore){
        if(!same(await cadCoverageStore.read(),cadCoverageHead)||!same(await cadCoverageNeutralStore.read(),cadCoverageNeutralHead))fail('CAD_coverage_changed');
        if(!same(prepareNeighborhoodSharedTypedCadSource(await client.query(NEIGHBORHOOD_SHARED_TYPED_CAD_SQL.source,
          [stock.generation_id]),stock.generation_id),cadCoverageExpected.cad_source_metadata))fail('CAD_source_changed');
        if(readingCoveredCadAmenities&&!same(prepareNeighborhoodCoveredCadCacheHeaderV2(one(await client.query(
          NEIGHBORHOOD_SHARED_TYPED_CAD_SQL.read,[stock.generation_id,cadCoverageExpected.typed_profile_reference.content_sha256])),
        cadCoverageExpected.cad_source_metadata),cadCoveredHeader))fail('CAD_source_changed');
      }
      if(traversalAnchorStore&&!same(await traversalAnchorStore.read(),traversalAnchor))fail('checkpoint_conflict');
      if(partitionStore&&!same(await partitionStore.read(),partitionAnchor))fail('checkpoint_conflict');
      if(!readingSelectedUnionSubjectHousing&&(readingRecordedPartition||catalogingRecordedGroups)&&!same(await partitionStore.readNextEntry(partitionReadCursor),partitionReadEntry))fail('partition_original_mismatch');
      if(catalogStore&&(!same(await catalogStore.read(),catalogAnchor)||!same(await catalogStore.counts(),catalogCounts)))fail('catalog_original_mismatch');
      if(catalogReadGroupKey&&!same(await catalogStore.readGroup(catalogReadGroupKey),catalogReadGroup))fail('catalog_original_mismatch');
      if((batchingStock||readingStockWholeAccountBatch||readingSelectionWorkspaceTarget||awaitingSelection||selectingCatalogIntent||readingRetainedSelectionIntent||replayingSelectedUnion)&&!same(await readCustomCohortFrozenSelectionWorkspaceTarget({
        client,input,scopeJson:canonicalAssessmentJson(scope),checkBudget:budget.check}),selectionWorkspaceTarget))fail('workspace_target_changed');
      budget.check();
      if(cachingCadCoverage){
        if(readingCoveredCadAmenities){
          const result={status:'covered_first_original_CAD_amenity_evidence_v2',operation_id:input.operationId,
            ...cadCoveredAmenities,cache_coverage_reference:cadCoverageHead.receipt_reference,neutral_reference:cadCoverageNeutralHead.receipt_reference,
            effective_date:context.effective_date,coverage:'one_complete_first_stock_account_only',
            original_reconciliation:'every_original_and_entire_cache_before_projection',
            CAD_source_authorization:{purpose:cadPurpose,decision:cadDecision},
            global_generation_complete:'not_established',automatic_handoff:false,selected_union:'not_established',
            context_complete:false,pin_transfer:false,source_acquisition:'not_established',report_update:'none'};
          if(Buffer.byteLength(JSON.stringify(result))>16_000)fail('byte_limit');budget.check();return freeze(result);
        }
        if(cadCoveragePlan){const ref=await blobs.put(canonicalAssessmentJson(cadCoveragePlan));cadCoverageHead=await cadCoverageStore.advance(cadCoverageHead,ref);}
        if(yieldingCadProgress&&!cadCoveragePlan)fail('CAD_coverage_changed');
        const continuation=yieldingCadProgress?await cadContinuation.yieldIssued(claim,jobOptions):null;
        const result={status:'current_authorized_CAD_cache_coverage_progress_v2',operation_id:input.operationId,
          advanced:cadCoveragePlan!==null,cache_coverage_reference:cadCoverageHead.receipt_reference,
          neutral_reference:cadCoverageNeutralHead.receipt_reference,progress:(cadCoveragePlan??cadCoverageIssued).after,
          reconciled_rows:cadCoverageResult.reconciled_rows,inserted_rows:cadCoverageResult.inserted_rows,
          CAD_source_authorization:{purpose:cadPurpose,decision:cadDecision},
          ...(yieldingCadProgress?{automatic_CAD_cache_success:true,continuation}:{}),
          global_progress_advanced:false,automatic_handoff:false,context_complete:false,pin_transfer:false,source_acquisition:'not_established',
          publication:'not_established',report_update:'none'};
        if(Buffer.byteLength(JSON.stringify(result))>16000)fail('byte_limit');budget.check();return freeze(result);
      }
      if(cachingNeutralOriginals){
        // Every actual actor/assignment/draft/subject/source/claim/stock/root
        // and independent-parent ending fence above precedes head retention.
        // Any refusal rolls cache inserts, totals and this head back together.
        if(neutralCachePlan){
          const retainedReceipt=await blobs.put(canonicalAssessmentJson(neutralCachePlan));
          neutralCacheHead=await neutralCacheStore.advance(neutralCacheHead,retainedReceipt);
        }
        if(yieldingNeutralProgress&&!neutralCachePlan)fail('checkpoint_conflict');
        const continuation=yieldingNeutralProgress?await createCustomCohortNeutralCacheV2ContinuationRepository(client).yieldIssued(claim,jobOptions):null;
        budget.check();return freeze({status:'current_authorized_neutral_original_cache_progress_v2',operation_id:input.operationId,
          ...neutralCacheResult,cache_coverage_reference:neutralCacheHead.receipt_reference,
          all_issued_source_pages_reconciled:neutralCacheResult.progress.kind_index===7,
          automatic_cache_success:yieldingNeutralProgress,...(continuation?{continuation}:{}),
          global_generation_complete:'not_established',automatic_success_handoff:false,context_complete:false,pin_transfer:false,
          source_acquisition:'not_established',publication:'not_established',report_update:'none'});
      }
      if(replayingSelectedUnion){
        const ending=await createCustomCohortV2SelectionIntentRepository(client)[readingSelectedTransactionIndex?'readForTransactionIndex':readingSelectedTransactionSource?'readForTransactionSource':progressingSelectedSemantic?'readForSemanticStatistics':progressingSelectedNumeric||readingSelectedRankCandidates?'readForNumericPopulation':readingSelectedFrequencySource?'readForFrequencies':progressingSelectedStatistics?'readForStatisticsContributions':readingSelectedStatisticsSource?'readForStatistics':progressingSelectedMetrics?'readForMetrics':progressingSelectedEvidence||readingSelectedMetricSource?'readForEvidence':progressingSelectedEligibility?'readForEligibility':'readForReplay'](claim,
          {...jobOptions,workspaceTarget:selectionWorkspaceTarget});
        if(!same(ending,issuedSelectionIntent)||!same(await unionStore.read(),unionAnchor)
          ||!same(await unionStore.counts(),unionCounts))fail('selected_union_original_mismatch');
        if(progressingSelectedNumeric&&!same(await numericStore.readNextSelectedEntry(),firstSelectedEntry))fail('selected_union_original_mismatch');
        if(readingSelectedRankCandidates&&!same(await numericStore.readFirstCompletedSelectedEntry(),firstSelectedEntry))fail('selected_union_original_mismatch');
        if(readingSelectedTransactionSource&&!readingSelectedTransactionIndex){if(!same(await semanticStore.readFirstCompletedSelectedEntry(),firstSelectedEntry))fail('selected_union_original_mismatch');}
        else if(progressingSelectedSemantic&&!readingSelectedTransactionIndex&&!same(await semanticStore.readNextSelectedEntry(),firstSelectedEntry))fail('selected_union_original_mismatch');
        if(!progressingSelectedNumeric&&!readingSelectedRankCandidates&&!progressingSelectedSemantic){
        if(readingSelectedUnionFirstEligibility&&!same(await (readingSelectedFrequencySource?(readingSelectedNumericSource?statisticsStore.readFirstIndexedFrequencyEntry():statisticsStore.readFirstFrequencyEntry()):progressingSelectedStatistics?statisticsStore.readNextSelectedEntry():readingSelectedStatisticsSource?metricsStore.readFirstStatisticsEntry():progressingSelectedMetrics?metricsStore.readNextSelectedEntry():readingSelectedMetricSource?evidenceStore.readFirstMetricEntry():progressingSelectedEvidence?evidenceStore.readNextSelectedEntry():progressingSelectedEligibility
          ?eligibilityStore.readNextSelectedEntry():unionStore.readFirstSelectedEntry()),firstSelectedEntry))
          fail('selected_union_original_mismatch');
        }
        if((progressingSelectedEligibility||progressingSelectedEvidence||readingSelectedMetricSource)&&!same(await eligibilityStore.read(),eligibilityAnchor))fail('checkpoint_conflict');
        if((progressingSelectedEvidence||readingSelectedMetricSource)&&!same(await evidenceStore.read(),evidenceAnchor))fail('checkpoint_conflict');
        if(progressingSelectedMetrics&&!same(await metricsStore.read(),metricsAnchor))fail('checkpoint_conflict');
        if(readingSelectedStatisticsSource&&!same(await metricsStore.read(),metricsAnchor))fail('checkpoint_conflict');
        if((progressingSelectedStatistics||readingSelectedFrequencySource)&&!same(await statisticsStore.read(),statisticsAnchor))fail('checkpoint_conflict');
        if(progressingSelectedNumeric&&!same(await numericStore.read(),numericAnchor))fail('checkpoint_conflict');
        if(readingSelectedRankCandidates&&!same(await numericStore.read(),numericAnchor))fail('checkpoint_conflict');
        if(progressingSelectedSemantic&&(!same(await numericStore.read(),numericAnchor)||!same(await semanticStore.read(),semanticAnchor)))fail('checkpoint_conflict');
        if(readingSelectedTransactionSource&&!readingSelectedTransactionIndex&&!same(await semanticStore.readFirstCompletedTransactionNativeKeys(),selectedTransactionNativeKeys))
          fail('selected_transaction_native_keys_mismatch');
        if(readingSelectedTransactionIndex){
          // Repeat the actual native checkpoint and ENTIRE bounded NEXT plan,
          // including every retained member field and typed first-seen binding,
          // only AFTER all current+ending rights, workspace and immutable heads.
          if(!same(await jobs.readTransactionIndexCheckpoint(claim,jobOptions),checkpoint)
            ||!same(await selectedTransactionIndexStore.readNext(),selectedTransactionIndexPacket))
            fail('selected_transaction_index_original_mismatch');
        }
        if(preparingSelectedTransactionFirstCandidate&&!same(await selectedTransactionCandidateStore.readFirstCandidate(),selectedTransactionCandidatePlan))
          fail('selected_transaction_index_candidate_mismatch');
        budget.check();
        if(progressingSelectedTransactionIndex){
          // This sole write branch is AFTER the complete original graph, ALL
          // retained fields, exact per-account associations and EVERY ending
          // authority/head/checkpoint/ENTIRE NEXT packet fence above. Shared
          // keys never skip replay. The installed native refusals still keep
          // this UNREGISTERED owner inactive until coherent native acceptance.
          if(selectedTransactionSource===null)fail('selected_transaction_membership_missing');
          const plan=buildCohortSelectedTransactionIndexReceiptV2({command_id:issuedSelectionIntent.command_id,
            ...Object.fromEntries(['union_reference','eligibility_reference','evidence_reference','metrics_reference','statistics_reference','numeric_reference','semantic_reference']
              .map(k=>[k,selectedTransactionIndexExpected[k]])),plan:selectedTransactionIndexPacket.plan,previous:selectedTransactionIndexPacket.previous});
          const receiptReference=await blobs.put(canonicalAssessmentJson(plan));
          const head=await selectedTransactionIndexStore.advance(receiptReference);
          await jobs.saveTransactionIndexCheckpoint(claim,jobOptions,{phase:'frozen_selected_transaction_index_refs_v2',
            evidence_refs:[...checkpoint.evidence_refs.slice(0,16),receiptReference]});
          const continuation=await createCustomCohortV2ContinuationRepository(client).yieldTransactionIndexIssued(claim,jobOptions);
          const result={status:'original_selected_transaction_index_progress_retained',operation_id:input.operationId,
            command_id:issuedSelectionIntent.command_id,transaction_index_reference:head.receipt_reference,
            semantic_reference:semanticAnchor.receipt_reference,progress:plan.after,selected_entry:plan.selected_entry,
            source_package_count:plan.source_package_count,legacy_package_count:plan.legacy_package_count,
            new_source_record_keys:plan.new_source_record_keys,new_legacy_sale_keys:plan.new_legacy_sale_keys,
            complete_original_reconciled_selected_index:plan.after.done,
            global_economic_transaction_deduplication:false,economic_transactions:'not_established',at_sale_facts:'not_established',
            calendar_quarters:'not_established',source_acquisition:'not_established',publication:'not_established',
            production_speed:'not_established',context_complete:false,pin_transfer:false,report_update:'none',continuation};
          if(coveredNeutralOriginals){result.covered_neutral_originals=true;result.covered_CAD_originals=true;result.read_only=false;}
          if(Buffer.byteLength(JSON.stringify(result))>16000)fail('byte_limit');budget.check();return freeze(result);
        }
        if(readingSelectedTransactionSource){
          // Read-only AFTER complete issued graph, whole FIRST selected packet,
          // ENTIRE caches, EVERY seventh/eighth/index/ninth/tenth member and ALL
          // current+ending authority. No source/index/receipt writes or yield.
          if(selectedTransactionSource===null)fail('selected_transaction_membership_missing');
          const result={status:'current_authorized_first_selected_transaction_source_originals_reconciled',
            operation_id:input.operationId,command_id:issuedSelectionIntent.command_id,
            union_reference:unionAnchor.receipt_reference,semantic_reference:semanticAnchor.receipt_reference,
            selected_entry:firstSelectedEntry===null?null:Object.fromEntries(
              ['account_id','ordinal','partition_ordinal','entry_reference'].map(k=>[k,firstSelectedEntry[k]])),
            ...selectedTransactionSource,native_key_set_reconciled:true,empty_selected_union:unionCounts.selected_count===0,
            original_reconciliation:'complete_issued_graph_whole_first_selected_stock_CAD_all_date_transaction_required_subject_ENTIRE_caches_and_every_seventh_eighth_index_ninth_tenth_member',
            coverage:'fixed_first_selected_account_only_after_actual_tenth_fresh_EMPTY',
            global_selected_native_deduplication:false,economic_transactions:'not_established',calendar_quarters:'not_established',
            source_acquisition:'not_established',publication:'not_established',production_speed:'not_established',
            context_complete:false,pin_transfer:false,report_update:'none',read_only:true,lease_extended:false,
            ...(readingSelectedTransactionIndex?{
              status:'current_authorized_native_next_selected_transaction_index_originals_reconciled',
              original_reconciliation:'complete_issued_graph_whole_native_NEXT_selected_stock_CAD_all_date_transaction_required_subject_ENTIRE_caches_and_every_seventh_eighth_index_ninth_tenth_member',
              coverage:'native_next_selected_account_only_after_actual_tenth_fresh_EMPTY',
              native_index_candidate:buildCohortSelectedTransactionIndexReceiptV2({command_id:issuedSelectionIntent.command_id,
                ...Object.fromEntries(['union_reference','eligibility_reference','evidence_reference','metrics_reference','statistics_reference','numeric_reference','semantic_reference']
                  .map(k=>[k,selectedTransactionIndexExpected[k]])),plan:selectedTransactionIndexPacket.plan,previous:selectedTransactionIndexPacket.previous}),
              native_index_candidate_retained:false,transaction_index_issued:false}:{}),
            ...(preparingSelectedTransactionFirstCandidate?{
              status:'current_authorized_first_selected_transaction_index_candidate_originals_reconciled',
              native_index_candidate:prepareCohortSelectedTransactionIndexFirstCandidateV2({command_id:issuedSelectionIntent.command_id,
                ...Object.fromEntries(['union_reference','eligibility_reference','evidence_reference','metrics_reference','statistics_reference','numeric_reference']
                  .map(k=>[k,semanticExpected[k]])),semantic_reference:semanticAnchor.receipt_reference,plan:selectedTransactionCandidatePlan}),
              native_index_candidate_retained:false}: {})};
          if(Buffer.byteLength(JSON.stringify(result))>16000)fail('byte_limit');budget.check();return freeze(result);
        }
        if(progressingSelectedSemantic){
          // Complete graph, every selected whole original/ENTIRE cache, EVERY
          // seventh/eighth/index/ninth field and ALL current+ending authority
          // passed above. No caller ordinal/population/callback/count authority.
          // Ranks initialize once; each fresh account contributes exact sums,
          // deviations and independent state/part/reason/eligible counters.
          if(semanticSummary===null)fail('semantic_summary_missing');
          const afterSummary=advanceCohortSelectedSemanticSummaryV2(semanticSummary,semanticBefore.selected_ordinal,
            unionCounts.selected_count,statisticsCandidate?.metrics??null);
          const exactStatistics=firstSelectedEntry===null
            ?finalizeCohortSelectedSemanticSummaryV2(afterSummary,unionCounts.selected_count,statisticsCounts):null;
          const summaryReference=await blobs.put(canonicalAssessmentJson(afterSummary));
          const plan=prepareCohortSelectedSemanticReceiptV2({format:'cohort_selected_semantic_receipt_v2',...semanticExpected,
            sequence:(semanticAnchor?.sequence??0)+1,previous:semanticAnchor?.receipt_reference??null,before:semanticBefore,
            after:{selected_ordinal:semanticBefore.selected_ordinal+Number(firstSelectedEntry!==null),done:firstSelectedEntry===null},
            selected_entry:firstSelectedEntry===null?null:Object.fromEntries(
              ['account_id','ordinal','partition_ordinal','entry_reference'].map(k=>[k,firstSelectedEntry[k]])),
            contribution_row_reference:firstSelectedEntry?.contribution_row_reference??null,
            before_summary_reference:semanticIssued?.after_summary_reference??null,after_summary_reference:summaryReference},semanticExpected);
          const receiptReference=await blobs.put(canonicalAssessmentJson(plan));
          semanticAnchor=await semanticStore.advance(semanticAnchor,receiptReference);
          await jobs.saveCheckpoint(claim,jobOptions,{phase:'frozen_selected_semantic_refs_v2',
            evidence_refs:[...checkpoint.evidence_refs.slice(0,15),receiptReference]});
          const continuation=await createCustomCohortV2ContinuationRepository(client).yieldIssued(claim,jobOptions);
          const result={status:'original_selected_semantic_progress_retained',operation_id:input.operationId,
            ...(coveredNeutralOriginals?{covered_neutral_originals:true,covered_CAD_originals:true,read_only:false}:{}),
            semantic_reference:receiptReference,summary_reference:summaryReference,numeric_reference:numericAnchor.receipt_reference,
            progress:plan.after,selected_entry:plan.selected_entry,exact_statistics:exactStatistics,
            complete_original_reconciled_selected_union:plan.after.done,calendar_quarters:'not_established',
            economic_transactions:'not_established',publication:'not_established',source_acquisition:'not_established',
            production_speed:'not_established',context_complete:false,pin_transfer:false,report_update:'none',continuation};
          if(Buffer.byteLength(JSON.stringify(result))>16000)fail('byte_limit');
          budget.check();return freeze(result);
        }
        if(readingSelectedRankCandidates){
          // Read-only seam INSIDE the actual bounded original owner, AFTER
          // complete graph/whole first-account originals/ENTIRE caches, every
          // seventh/eighth/index/ninth member and ALL current+ending fences.
          // Only ordinal1 (or the explicit EMPTY) was freshly reconciled here;
          // native ranks MUST NOT become complete-population source authority.
          if(provisionalRankCandidates===null)fail('rank_candidates_missing');
          const {statistics_contribution_candidate,metric_row_candidate,reported_comparison,selected_entry,...presentation}=subjectHousingResult;
          const result={...presentation,status:'current_authorized_first_selected_rank_candidate_source_reconciled',
            numeric_reference:numericAnchor.receipt_reference,rank_candidates:provisionalRankCandidates,
            selected_entry:firstSelectedEntry===null?null:Object.fromEntries(
              ['account_id','ordinal','partition_ordinal','entry_reference'].map(key=>[key,firstSelectedEntry[key]])),
            coverage:'fixed_first_native_selected_ordinal_only_after_ninth_fresh_EMPTY',
            retained_numeric_index_reconciled:firstSelectedEntry!==null,retained_ninth_member_reconciled:firstSelectedEntry!==null,
            complete_original_reconciled_rank_population:false,complete_indexed_metric_population:false,
            frequency_ledger:false,exact_distributions:false,statistics:'not_established',publication:'not_established',
            later_semantic_consumer:'must_reopen_every_selected_complete_original_and_ENTIRE_cache_reconcile_all_states_and_current_ending_authority_again',
            read_only:true,lease_extended:false};
          if(Buffer.byteLength(JSON.stringify(result))>16000)fail('byte_limit');
          budget.check();return freeze(result);
        }
        if(progressingSelectedNumeric){
          // COMPLETE originals/ENTIRE caches, every seventh/eighth/index field,
          // all issued parents/member and current+ending rights passed above.
          // Retain reference-only progress AFTER those fences in this SAME TX.
          // A later semantic consumer MUST reopen originals AGAIN; this DONE
          // is not a perpetual grant, a distribution, statistic or publication.
          const plan=prepareCohortSelectedNumericReceiptV2({format:'cohort_selected_numeric_receipt_v2',...numericExpected,
            sequence:(numericAnchor?.sequence??0)+1,previous:numericAnchor?.receipt_reference??null,before:numericBefore,
            after:{selected_ordinal:numericBefore.selected_ordinal+Number(firstSelectedEntry!==null),done:firstSelectedEntry===null},
            selected_entry:firstSelectedEntry===null?null:Object.fromEntries(
              ['account_id','ordinal','partition_ordinal','entry_reference'].map(key=>[key,firstSelectedEntry[key]])),
            contribution_row_reference:firstSelectedEntry?.contribution_row_reference??null},numericExpected);
          const receiptReference=await blobs.put(canonicalAssessmentJson(plan));
          numericAnchor=await numericStore.advance(numericAnchor,receiptReference);
          await jobs.saveCheckpoint(claim,jobOptions,{phase:'frozen_selected_numeric_refs_v2',
            evidence_refs:[...checkpoint.evidence_refs.slice(0,14),receiptReference]});
          const continuation=await createCustomCohortV2ContinuationRepository(client).yieldIssued(claim,jobOptions);
          const {statistics_contribution_candidate,metric_row_candidate,reported_comparison,selected_entry,...presentation}=subjectHousingResult;
          const result={...presentation,status:'original_selected_numeric_progress_retained',numeric_reference:receiptReference,
            ...(coveredNeutralOriginals?{covered_neutral_originals:true,covered_CAD_originals:true}:{}),
            contribution_row_reference:firstSelectedEntry?.contribution_row_reference??null,progress:plan.after,
            coverage:'one_native_selected_ordinal_or_fresh_terminal_empty_probe',empty_selected_union:unionCounts.selected_count===0,
            complete_original_reconciled_index_pass:plan.after.done,
            selected_entry:plan.selected_entry,read_only:false,complete_indexed_metric_population:plan.after.done,
            frequency_ledger:false,exact_distributions:false,statistics:'not_established',publication:'not_established',
            later_semantic_consumer:'must_reopen_complete_originals_entire_caches_and_current_authority_again',continuation};
          if(Buffer.byteLength(JSON.stringify(result))>16000)fail('byte_limit');
          budget.check();return freeze(result);
        }
        if(readingSelectedFrequencySource){
          const {statistics_contribution_candidate,metric_row_candidate,reported_comparison,...presentation}=subjectHousingResult;
          const result={...presentation,status:'current_authorized_first_selected_frequency_originals_reconciled',
            contribution_reference:statisticsAnchor.receipt_reference,
            contribution_row_reference:firstSelectedEntry?.contribution_row_reference??null,
            retained_contribution_reconciled:firstSelectedEntry!==null,
            coverage:'fixed_first_native_selected_ordinal_only_after_DONE_union_fifth_sixth_seventh_and_eighth',
            frequency_ledger:false,exact_distributions:false,complete_selected_union_metric_population:false,
            statistics:'not_established',publication:'not_established',read_only:true,lease_extended:false};
          if(readingSelectedNumericSource){
            result.status='current_authorized_first_selected_numeric_originals_reconciled';
            result.selected_entry=firstSelectedEntry===null?null:Object.fromEntries(
              ['account_id','ordinal','partition_ordinal','entry_reference','state','assigned_group_id','row_reference','contribution_row_reference']
                .map(key=>[key,firstSelectedEntry[key]]));
            result.retained_numeric_index_reconciled=firstSelectedEntry!==null;
            result.complete_indexed_metric_population=false;
          }
          if(Buffer.byteLength(JSON.stringify(result))>16000)fail('byte_limit');
          budget.check();return freeze(result);
        }
        if(progressingSelectedStatistics){
          // Only after complete original/ENTIRE-cache replay, every seventh
          // row field and ALL current+ending authorization fences above.
          // This ledger retains one contribution/account and closed counters,
          // NOT frequencies, medians, COD, quarters or publication.
          // The additive native numeric-index hook is a structural child of
          // this SAME original-reconciled transaction, after ALL ending fences.
          // It does not mint enduring source/selection/statistics authority;
          // every later semantic pass MUST reopen complete originals again.
          const afterCounts=advanceCohortSelectedStatisticsCountsV2(statisticsCounts,statisticsBefore.selected_ordinal,statisticsCandidate?.metrics??null);
          if(firstSelectedEntry===null&&SELECTED_RECORDED_ELIGIBILITY_METRICS.some(k=>
            afterCounts[k].eligible_count!==metricsIssued.after_counts[k]||afterCounts[k].eligible_count!==eligibilityIssued.after_counts[k]))
            fail('selected_statistics_eligibility_mismatch');
          const rowReference=statisticsCandidate===null?null:await blobs.put(canonicalAssessmentJson(statisticsCandidate));
          const plan=prepareCohortSelectedStatisticsReceiptV2({format:'cohort_selected_statistics_receipt_v2',
            policy:SELECTED_STATISTICS_CONTRIBUTION_V2_POLICY,...statisticsExpected,
            sequence:(statisticsAnchor?.sequence??0)+1,previous:statisticsAnchor?.receipt_reference??null,before:statisticsBefore,
            after:{selected_ordinal:statisticsBefore.selected_ordinal+Number(firstSelectedEntry!==null),done:firstSelectedEntry===null},
            selected_entry:statisticsCandidate?.selected_entry??null,row_reference:rowReference,before_counts:statisticsCounts,after_counts:afterCounts},statisticsExpected);
          const receiptReference=await blobs.put(canonicalAssessmentJson(plan));
          statisticsAnchor=await statisticsStore.advance(statisticsAnchor,receiptReference,rowReference);
          await jobs.saveCheckpoint(claim,jobOptions,{phase:'frozen_selected_statistics_refs_v2',
            evidence_refs:[...checkpoint.evidence_refs.slice(0,13),receiptReference]});
          const continuation=await createCustomCohortV2ContinuationRepository(client).yieldIssued(claim,jobOptions);
          const {statistics_contribution_candidate,metric_row_candidate,reported_comparison,...presentation}=subjectHousingResult;
          const result={...presentation,status:'original_selected_statistics_contribution_progress_retained',
            ...(coveredNeutralOriginals?{covered_neutral_originals:true,covered_CAD_originals:true}:{}),
            statistics_contribution_reference:receiptReference,statistics_contribution_row_reference:rowReference,
            statistics_contribution_retained:rowReference!==null,progress:plan.after,contribution_counts:afterCounts,read_only:false,
            coverage:'one_native_selected_ordinal_or_fresh_terminal_empty_probe',empty_selected_union:unionCounts.selected_count===0,
            complete_original_reconciled_contribution_pass:plan.after.done,complete_selected_union_metric_population:true,
            frequency_ledger:false,exact_distributions:false,statistics:'not_established',publication:'not_established',continuation};
          if(Buffer.byteLength(JSON.stringify(result))>16000)fail('byte_limit');
          budget.check();return freeze(result);
        }
        if(progressingSelectedMetrics){
          // ALL originals, ENTIRE caches, issued native parents/member, current
          // and ending rights passed above. No caller row/source callback.
          const afterCounts=Object.fromEntries(SELECTED_RECORDED_ELIGIBILITY_METRICS.map(k=>[k,
            metricsCounts[k]+Number(metricsRowCandidate?.metrics[k].recorded_comparison_eligible??false)]));
          if(firstSelectedEntry===null&&!same(afterCounts,eligibilityIssued.after_counts))fail('selected_metric_eligibility_mismatch');
          const rowReference=metricsRowCandidate===null?null:await blobs.put(canonicalAssessmentJson(metricsRowCandidate));
          const plan=prepareCohortSelectedMetricsReceiptV2({format:'cohort_selected_metrics_receipt_v2',...metricsExpected,
            sequence:(metricsAnchor?.sequence??0)+1,previous:metricsAnchor?.receipt_reference??null,before:metricsBefore,
            after:{selected_ordinal:metricsBefore.selected_ordinal+Number(firstSelectedEntry!==null),done:firstSelectedEntry===null},
            selected_entry:metricsRowCandidate?.selected_entry??null,row_reference:rowReference,
            before_counts:metricsCounts,after_counts:afterCounts},metricsExpected);
          const receiptReference=await blobs.put(canonicalAssessmentJson(plan));
          metricsAnchor=await metricsStore.advance(metricsAnchor,receiptReference,rowReference);
          await jobs.saveCheckpoint(claim,jobOptions,{phase:'frozen_selected_metrics_refs_v2',
            evidence_refs:[...checkpoint.evidence_refs.slice(0,12),receiptReference]});
          const continuation=await createCustomCohortV2ContinuationRepository(client).yieldIssued(claim,jobOptions);
          const result={...subjectHousingResult,status:'original_selected_reported_metric_progress_retained',
            ...(coveredNeutralOriginals?{covered_neutral_originals:true,covered_CAD_originals:true}:{}),
            metrics_reference:receiptReference,metric_row_reference:rowReference,metric_row_retained:rowReference!==null,
            progress:plan.after,recorded_comparison_counts:afterCounts,read_only:false,
            coverage:'one_native_selected_ordinal_or_fresh_terminal_empty_probe',
            empty_selected_union:unionCounts.selected_count===0,complete_selected_union_metric_population:plan.after.done,
            original_reconciled_reported_metric_rows_complete:plan.after.done,statistics:'not_established',publication:'not_established',continuation};
          if(Buffer.byteLength(JSON.stringify(result))>16000)fail('byte_limit');
          budget.check();return freeze(result);
        }
        if(progressingSelectedEvidence){
          // Every original, full issued lineage and ending authorization has
          // passed. Receipt/head/exact12 roots/single-use yield share one TX.
          const receiptReference=await blobs.put(canonicalAssessmentJson(evidencePlan));
          evidenceAnchor=await evidenceStore.advance(evidenceAnchor,receiptReference);
          await jobs.saveCheckpoint(claim,jobOptions,{phase:'frozen_selected_evidence_refs_v2',
            evidence_refs:[...checkpoint.evidence_refs.slice(0,11),receiptReference]});
          const continuation=await createCustomCohortV2ContinuationRepository(client).yieldIssued(claim,jobOptions);
          const result={...subjectHousingResult,status:'original_selected_evidence_traversal_progress_retained',
              ...(coveredNeutralOriginals?{covered_neutral_originals:true,covered_CAD_originals:true,read_only:false}:{}),
            evidence_reference:receiptReference,progress:evidencePlan.after,
            coverage:'one_native_selected_ordinal_or_fresh_terminal_empty_probe',
            empty_selected_union:unionCounts.selected_count===0,
            complete_selected_original_evidence_traversal:evidencePlan.after.done,continuation};
          if(Buffer.byteLength(JSON.stringify(result))>16000)fail('byte_limit');
          budget.check();return freeze(result);
        }
        if(progressingSelectedEligibility){
          // Only AFTER every original and ending fence. No values/decisions or
          // payloads retained; head, exact11 checkpoint and fresh single-use
          // continuation either all COMMIT together or all roll back.
          const receiptReference=await blobs.put(canonicalAssessmentJson(eligibilityPlan));
          eligibilityAnchor=await eligibilityStore.advance(eligibilityAnchor,receiptReference);
          await jobs.saveCheckpoint(claim,jobOptions,{phase:'frozen_selected_eligibility_refs_v2',
            evidence_refs:[...checkpoint.evidence_refs.slice(0,10),receiptReference]});
          const continuation=await createCustomCohortV2ContinuationRepository(client).yieldIssued(claim,jobOptions);
          budget.check();return freeze({...subjectHousingResult,status:'original_selected_recorded_eligibility_progress_retained',
            ...(coveredNeutralOriginals?{covered_neutral_originals:true}:{}),
            eligibility_reference:receiptReference,progress:eligibilityPlan.after,recorded_comparison_counts:eligibilityPlan.after_counts,
            coverage:'one_native_selected_ordinal_or_fresh_terminal_empty_probe',read_only:false,issued_eligibility_progress:true,
            empty_selected_union:unionCounts.selected_count===0,
            complete_selected_recorded_comparison_pass:eligibilityPlan.after.done,
            complete_selected_union_eligibility:false,continuation});
        }
        if(readingSelectedUnionSubjectHousing&&coveredNeutralOriginals){
          const coveredResult={...subjectHousingResult,covered_neutral_originals:true,
            ...(readingSelectedUnionFirstAmenities?{covered_CAD_originals:true}:{})};
          if(Buffer.byteLength(JSON.stringify(coveredResult))>16000)fail('byte_limit');
          return freeze(coveredResult);
        }
        if(readingSelectedUnionSubjectHousing)return freeze(subjectHousingResult);
        const beforeCounts=unionCounts,{selected_count:beforeSelected,...beforeGroupCounts}=beforeCounts;
        if(unionPlan.entry)unionCounts=await unionStore.contribute(unionAnchor,unionPlan.entry);
        const {selected_count:afterSelected,...afterGroupCounts}=unionCounts;
        if(afterSelected-beforeSelected!==Number(unionExpectedSelected))fail('selected_union_original_mismatch');
        const receipt=prepareCohortSelectedUnionReceiptV2({format:'cohort_selected_union_receipt_v2',...unionExpected,
          sequence:(unionAnchor?.sequence??0)+1,previous:unionAnchor?.receipt_reference??null,
          before:unionPlan.before,after:unionPlan.after,entry_reference:unionPlan.entry?.entry_reference??null,
          before_counts:beforeGroupCounts,after_counts:afterGroupCounts,
          before_selected_count:beforeSelected,after_selected_count:afterSelected},unionExpected);
        const receiptReference=await blobs.put(canonicalAssessmentJson(receipt));
        unionAnchor=await unionStore.advance(unionAnchor,receiptReference);
        await jobs.saveCheckpoint(claim,jobOptions,{phase:'frozen_selected_union_refs_v2',
          evidence_refs:[...checkpoint.evidence_refs.slice(0,9),receiptReference]});
        const continuation=await createCustomCohortV2ContinuationRepository(client).yieldIssued(claim,jobOptions);
        budget.check();return freeze({status:'original_selected_stock_union_replay_progress_retained',operation_id:input.operationId,
          ...(coveredNeutralOriginals?{covered_neutral_originals:true}:{}),
          command_id:issuedSelectionIntent.command_id,union_reference:receiptReference,catalog_reference:catalogAnchor.receipt_reference,
          progress:receipt.after,selected_stock_accounts:afterSelected,
          complete_catalog_original_replay:receipt.after.done,complete_distinct_selected_stock_union:receipt.after.done,
          original_reconciliation:'independent_complete_original_all_outside_parts_full_labels_retained_date_states_entire_cache_and_partition_replay',
          membership:'immutable_explicit_group_IDs_only_unassigned_candidates_not_promoted',
          housing_and_metric_eligibility:'separate_not_established_unknown_conflicting_lineage_preserved',
          current_subject_housing:unionSubjectHousing,
          current_account_recorded_eligibility:unionAccountEligibility===null?null:
            {...unionAccountEligibility,selected_stock_member:afterSelected>beforeSelected,
              selected_ordinal:afterSelected>beforeSelected?afterSelected:null},
          statistics:'not_established',publication:'not_established',context_complete:false,pin_transfer:false,
          source_acquisition:'not_established',report_update:'none',continuation});
      }
      if(readingRetainedSelectionIntent){
        const ending=await createCustomCohortV2SelectionIntentRepository(client).readRetained(claim,
          {...jobOptions,workspaceTarget:selectionWorkspaceTarget});
        if(!same(ending,issuedSelectionIntent)||!same(ending.catalog_reference,catalogAnchor.receipt_reference))fail('selection_intent_changed');
        budget.check();return freeze({...issuedSelectionIntent,status:'retained_new_study_selection_intent_reopened',operation_id:input.operationId,
          selection_workspace_target:selectionWorkspaceTarget,genuine_new_group_choice:'unchanged_immutable_authenticated_command_only',
          original_reconciliation:'fresh_terminal_original_cache_and_partition_empty_probe_after_issued_catalog_DONE',
          read_only:true,lease_extended:false,complete_catalog_semantic_replay:'not_established',selected_union:'not_established',
          statistics:'not_established',context_complete:false,pin_transfer:false,publication:'not_established',
          source_acquisition:'not_established',report_update:'none'});
      }
      if(selectingCatalogIntent){
        const ending=await createCustomCohortV2SelectionIntentRepository(client).resume(input.operationId,
          {...jobOptions,intent:selectionIntent,workspaceTarget:selectionWorkspaceTarget});
        if(!same(ending.claim,issuedSelectionIntent.claim)||!same(ending.included_recorded_group_ids,issuedSelectionIntent.included_recorded_group_ids)
          ||!same(ending.catalog_reference,catalogAnchor.receipt_reference))fail('selection_intent_changed');
        budget.check();return freeze({...issuedSelectionIntent,status:'new_study_selection_intent_retained',operation_id:input.operationId,
          selection_workspace_target:selectionWorkspaceTarget,genuine_new_group_choice:'explicit_authenticated_new_study_command_only',
          original_reconciliation:'fresh_terminal_original_cache_and_partition_empty_probe_after_issued_catalog_DONE',
          complete_catalog_semantic_replay:'not_established',selected_union:'not_established',statistics:'not_established',
          context_complete:false,pin_transfer:false,publication:'not_established',source_acquisition:'not_established',report_update:'none'});
      }
      if(awaitingSelection){
        // The server chose the issued DONE cursor; a fresh whole original/cache
        // and partition empty probe plus ALL current ending fences ran above.
        // Release ONLY the lease. No groups, publication or old choice carried.
        const waiting=await createCustomCohortV2SelectionWaitRepository(client).awaitSelection(claim,jobOptions);
        budget.check();return freeze({...waiting,operation_id:input.operationId,selection_workspace_target:selectionWorkspaceTarget,
          ...(coveredNeutralOriginals?{covered_neutral_originals:true}:{}),
          original_reconciliation:'fresh_terminal_original_cache_and_partition_empty_probe_after_issued_catalog_DONE',
          complete_catalog_semantic_replay:'not_established',selected_union:'not_established',statistics:'not_established',
          publication:'not_established',source_acquisition:'not_established',report_update:'none'});
      }
      if(yieldingV2Progress){
        // Only after EVERY original/current-authority ending fence, in this
        // same TX. The native continuation guard derives the actual issued
        // head/root, refuses duplicate progress and preserves all attempts.
        const continuation=await createCustomCohortV2ContinuationRepository(client).yieldIssued(claim,jobOptions);
        const initialCacheStock=cacheStockHandoff&&checkpoint.phase==='frozen_identity_refs_v2';
        if(initialCacheStock)await createCustomCohortCacheStockV2BridgeRepository(client).complete(claim,jobOptions);
        budget.check();return freeze({...(catalogingRecordedGroups?catalogResult:partitioningRecordedGroups?partitionResult:traversalResult),continuation,
          ...(coveredNeutralOriginals&&(partitioningRecordedGroups||catalogingRecordedGroups)
            ?{covered_neutral_originals:true,context_complete:false,pin_transfer:false}:{}),
          ...(cacheStockHandoff?{automatic_cache_stock_handoff:initialCacheStock,context_complete:false,pin_transfer:false}:{})});
      }
      // Every unchanged original/current-authority ending fence above must
      // pass first. A DONE replay makes no new head and cannot yield it twice.
      const earlyAdvanced=identityVerifying?identityVerification?.advanced
        :stockVerifying?stockVerification?.advanced:verification?.advanced;
      const earlyContinuation=yieldingEarlyProgress?{context_complete:false,pin_transfer:false,...(earlyAdvanced
        ?{continuation:await createCustomCohortV2ContinuationRepository(client).yieldIssued(claim,jobOptions)}:{})}:{};
      const prefixContinuation=yieldingSourcePrefix&&kind!==undefined
        ?{continuation:await createCustomCohortSourcePrefixV2ContinuationRepository(client).yieldIssued(claim,jobOptions)}:{};
      budget.check();
      if(catalogingRecordedGroups)return freeze(catalogResult);
      if(partitioningRecordedGroups||readingRecordedPartition)return freeze(partitionResult);
      if(traversingStock)return freeze(traversalResult);
      if(readingStockMetrics||readingSharedStockMetrics||readingCadPages||readingTransactionPages||readingTransactionPackages||readingStockOriginalCells||readingStockAccountPackages) return freeze({...stockMetricResult,
        ...(readingStockMetrics?{typed_original_reference:typedReference}:{}),
        ...(readingCadPages?{CAD_source_authorization:{purpose:cadPurpose,decision:cadDecision},stock_reference:stockReference,
          current_authorized_owner:'V2_issued_graph_geography_identity_and_separate_CAD_rights'}:{}),
        ...(readingTransactionPages||readingTransactionPackages||readingStockOriginalCells||readingStockAccountPackages?{stock_reference:stockReference,retained_effective_date:context.effective_date,
          retained_observation_period:input.observationPeriod,
          current_authorized_owner:'V2_issued_graph_geography_identity_and_current_original_source_rights'}:{}),
        source_reference:reference,verification_reference:verificationReference,stock_verification_reference:stockVerificationReference,
        identity_verification_reference:identityVerificationReference});
      if(typing) return freeze({status:'typed_original_progress_retained',operation_id:input.operationId,
        source_reference:reference,verification_reference:verificationReference,stock_verification_reference:stockVerificationReference,
        identity_verification_reference:identityVerificationReference,typed_original_reference:typedReference,generation_id:stock.generation_id,
        advanced:typedOriginals.advanced,typed_layer_count:typedOriginals.progress.kind_index,all_layers_typed:typedOriginals.all_layers_typed,
        typed_profile_ref:typedOriginals.profile_ref,individual_original_interpretation:typedOriginals.all_layers_typed?'complete':'in_progress',
        property_transaction_observations:'not_established',source_freshness:'not_established',source_acquisition:'not_established',report_update:'none'});
      if(identityVerifying) return freeze({...earlyContinuation,status:'source_identity_progress_retained',operation_id:input.operationId,
        source_reference:reference,verification_reference:verificationReference,stock_verification_reference:stockVerificationReference,
        identity_verification_reference:identityVerificationReference,generation_id:stock.generation_id,
        advanced:identityVerification.advanced,verified_layer_count:identityVerification.progress.kind_index,
        all_layers_verified:identityVerification.all_layers_verified,original_graph_verification:'representation_verified',
        geographic_stock_verification:'originals_verified',
        source_identity_closure:identityVerification.all_layers_verified?'identities_and_one_hop_verified':'in_progress',
        unknown_parcel_origins:identityVerification.progress.unknown_parcel_origins,
        origin_count_scope:'source_graph_account_parcel_parts_not_geographic_stock',
        missing_account_count:identityVerification.progress.missing_account_count,
        typed_numerical_observations:'not_established',source_freshness:'not_established',source_acquisition:'not_established',report_update:'none'});
      if(stockVerifying) return freeze({...earlyContinuation,status:'geographic_original_progress_retained',operation_id:input.operationId,
        source_reference:reference,verification_reference:verificationReference,stock_verification_reference:stockVerificationReference,
        generation_id:stock.generation_id,advanced:stockVerification.advanced,
        verified_parcels:stockVerification.progress.verified_parcels,verified_unassociated:stockVerification.progress.verified_unassociated,
        all_parcels_verified:stockVerification.all_parcels_verified,original_graph_verification:'representation_verified',
        geographic_stock_verification:stockVerification.all_parcels_verified?'originals_verified':'in_progress',
        typed_identity_closure:'not_established',source_acquisition:'not_established',report_update:'none'});
      if(verifying) return freeze({...earlyContinuation,status:'original_graph_progress_retained',operation_id:input.operationId,
        source_reference:reference,verification_reference:verificationReference,generation_id:stock.generation_id,
        advanced:verification.advanced,verified_layer_count:verification.verified_layer_count,
        all_layers_verified:verification.all_layers_verified,
        original_graph_verification:verification.all_layers_verified?'representation_verified':'in_progress',
        geographic_stock_verification:'not_established',typed_identity_closure:'not_established',
        source_acquisition:'not_established',report_update:'none'});
      return freeze({status:referencesV2?'source_reference_prefix_retained':'source_prefix_retained',operation_id:input.operationId,source_reference:reference,
        ...prefixContinuation,
        ...(issuingSourcePrefix?{native_prefix_sequence:sourcePrefixHead.sequence,context_complete:false,pin_transfer:false}:{}),
        generation_id:stock.generation_id,advanced:kind!==undefined,layers:prefix.layers,
        all_layers_ended:COHORT_ORIGINAL_SOURCE_CHAIN_V1_KINDS.every(key=>prefix.layers[key].ended),
        original_graph_verification:'not_established',source_acquisition:'not_established',report_update:'none'});
    });
  }
  return Object.freeze({
    ...recordedGroupSelection,
    ...preparedCatalog,
    selectPreparedRecordedGroups: retainedGroupSelection.selectRecordedGroups,
    selectAndSavePreparedRecordedGroups: retainedGroupSelection.selectAndSaveRecordedGroups,
    completePreparedRecordedGroupCapture: retainedGroupSelection.completeRecordedGroupCapture,
    readPreparedRecordedGroupSelection: retainedGroupSelection.readRecordedGroupSelection,
    // These are intentionally not exposed by the HTTP router until a worker
    // can process queued jobs. Queue admission is not a source grant; every
    // operation rechecks current assignment access and the worker must recheck
    // current actor/source rights before each resumable stage and registration.
    async queueCaptureJob(value, options = {}) {
      const input = inputOf(value), budget = operationBudget(options);
      return transaction(pool, 'READ COMMITTED', budget, async client => {
        const target = await resolveTarget(client, input, true, 'write');
        return createCustomCohortCaptureJobRepository(client).enqueue({
          scope: Object.fromEntries(TARGET_FIELDS.map(key => [key, target[key]])),
          actorUserId: input.auth.userId,
          request: { operation_id: input.operationId, observation_period: input.observationPeriod,
            ...(input.discovery ? { discovery: input.discovery } : {}),
            ...(input.privateSalesImport ? { private_sales_import: input.privateSalesImport } : {}) },
        });
      });
    },
    /** Dormant explicit native queue. Enrollment and request commit together;
     * no HTTP/default scheduler, source grant, pin or partial report follows. */
    async queueFrozenOriginalCaptureJobV2(value, options = {}) {
      const originalInput=inputOf(value),budget=operationBudget(options);
      if(originalInput.privateSalesImport || originalInput.discovery?.profile_id!=='custom-suburban-radius-v2')
        fail('frozen_discovery_unsupported');
      return transaction(pool,'READ COMMITTED',budget,async client=>{
        const locator=one(await client.query(`/* custom-cohort-capture:initial-job-organization */
          SELECT organization_id FROM app.assignment_files WHERE id=$1::bigint AND account_id=$2`,
        [originalInput.assignmentFileId,originalInput.accountId]));
        let input=freeze({...originalInput,auth:await loadCurrentCustomCohortJobActor(client,originalInput.auth.userId,locator.organization_id)});
        privateDraft(await privateCaptureWorkfile(client,input));
        const target=await resolveTarget(client,input,true,'write'),scope=Object.fromEntries(TARGET_FIELDS.map(key=>[key,target[key]]));
        const result=await createCustomCohortCaptureJobRepository(client).enqueue({scope,actorUserId:input.auth.userId,
          request:{operation_id:input.operationId,observation_period:input.observationPeriod,discovery:input.discovery,
            execution_mode:FROZEN_ORIGINALS_V2_EXECUTION}});
        await createCustomCohortInitialV2JobRepository(client).enroll({operationId:input.operationId,scope,actorUserId:input.auth.userId});
        input=freeze({...input,auth:await loadCurrentCustomCohortJobActor(client,input.auth.userId,scope.organization_id)});
        assertTarget(await resolveTarget(client,input,true,'write'),target);
        privateDraft(await privateCaptureWorkfile(client,input));budget.check();
        return result;
      });
    },
    async captureJobStatus(value, options = {}) {
      const input = captureJobInputOf(value), budget = operationBudget(options);
      return transaction(pool, 'READ COMMITTED', budget, async client => {
        const target = await resolveTarget(client, input, false, 'read');
        return createCustomCohortCaptureJobRepository(client).status(
          Object.fromEntries(TARGET_FIELDS.map(key => [key, target[key]])), input.operationId);
      });
    },
    async cancelCaptureJob(value, options = {}) {
      const input = captureJobInputOf(value), budget = operationBudget(options);
      return transaction(pool, 'READ COMMITTED', budget, async client => {
        const target = await resolveTarget(client, input, true, 'write');
        return createCustomCohortCaptureJobRepository(client).cancel(
          Object.fromEntries(TARGET_FIELDS.map(key => [key, target[key]])), input.operationId);
      });
    },
    /** New internal worker stage, not an HTTP/default acquisition path. Retain
     * the original subject and exact SQL stock once; NEVER read licensed sales
     * here or publish a partial context/report. Source acquisition has its own
     * subsequent current-purpose checks and explicit versioned owner. */
    async prepareFrozenCaptureJobStock(value, options = {}) {
      if (!options || Object.getPrototypeOf(options)!==Object.prototype) fail('invalid_options');
      const {captureJobClaim:providedClaim,...budgetOptions}=options;
      const originalInput=inputOf(value);
      const claim=prepareCustomCohortCaptureJobClaim(providedClaim);
      if (claim.operation_id!==originalInput.operationId.toLowerCase()) fail('operation_conflict');
      if (originalInput.privateSalesImport || originalInput.discovery?.profile_id!=='custom-suburban-radius-v2') fail('frozen_discovery_unsupported');
      const budget=operationBudget(budgetOptions,LIMITS.capture_duration_ms);
      return transaction(pool,'READ COMMITTED',budget,async client=>{
        // Resolve only the organization locator before fresh DB identity. Old
        // browser/worker role claims are not used for even initial admission.
        const locator=one(await client.query(`/* custom-cohort-capture:job-organization */
          SELECT organization_id FROM app.assignment_files WHERE id=$1::bigint AND account_id=$2`,
        [originalInput.assignmentFileId,originalInput.accountId]));
        let input=freeze({...originalInput,operationId:claim.operation_id,
          auth:await loadCurrentCustomCohortJobActor(client,originalInput.auth.userId,locator.organization_id)});
        privateDraft(await privateCaptureWorkfile(client,input));
        const target=await resolveTarget(client,input,true);
        const scope=Object.fromEntries(TARGET_FIELDS.map(key=>[key,target[key]]));
        const jobOptions={scope,actorUserId:input.auth.userId},jobs=createCustomCohortCaptureJobRepository(client);
        const requested={operation_id:input.operationId,observation_period:input.observationPeriod,discovery:input.discovery};
        if(!sameFrozenRequest(await jobs.readRequest(claim,jobOptions),requested)) fail('operation_conflict');
        const checkpoint=await jobs.readCheckpoint(claim,jobOptions);
        if(checkpoint && !['subject','frozen_stock_v1'].includes(checkpoint.phase)) fail('checkpoint_conflict');
        if(checkpoint?.phase==='frozen_stock_v1' && checkpoint.evidence_refs.length!==2) fail('checkpoint_conflict');
        const subjects=createCustomCohortSubjectRepository(client,canonicalAssessmentJson(scope));
        const blobs=createNeighborhoodCohortBlobRepository(client,scope.organization_id);
        const study=freeze({profile_id:input.discovery.profile_id,discovery:input.discovery,
          observation_period:input.observationPeriod,knowledge_cutoff:null});
        let retained;
        if(checkpoint) {
          retained=await resumeCustomCohortSubjectCheckpoint({checkpoint:{phase:'subject',evidence_refs:[checkpoint.evidence_refs[0]]},
            blobs,subjects,input,study,reportedProfile,housingProfile});
        } else {
          const subjectReference=await subjects.capture(),subject=await subjects.load(subjectReference);
          if(study.observation_period.end_date>subject.effective_date) fail('period_after_effective_date');
          const point=await subjects.loadRecordedPoint(subjectReference);
          if(point.status!=='represented') fail('recorded_point_required');
          const body=freeze({intent_version:1+(reportedProfile?2:0)+4,operation_id:input.operationId,
            actor_user_id:input.auth.userId,subject_inputs:subjectReference,target:subject.target,
            effective_date:subject.effective_date,study,created_at:await databaseTime(client),
            ...(reportedProfile?{reported_sale_interpretation:reportedProfile}:{}),recorded_housing_interpretation:housingProfile});
          retained={subjectReference,subject,point,intent:{body,reference:await blobs.put(canonicalAssessmentJson(body))}};
        }
        authorizePublicCadastralCatalogRead(input.auth,input.accountId,{workflows:['custom_appraisal'],
          permissionChecker:(auth,workflow,permission)=>hasApplicationPermission(auth,workflow,permission,scope.organization_id)});
        const pin=checkpoint?.phase==='frozen_stock_v1' ? await jobs.readPreparedGeneration(claim,jobOptions)
          : await jobs.pinPreparedGeneration(claim,jobOptions);
        if(!pin) fail('prepared_generation_unavailable');
        const stockStore=createNeighborhoodFrozenJobStock(client,{claim,scope,actorUserId:input.auth.userId,
          geometryInput:retained.point.geometry_input,discovery:input.discovery,subjectIntent:retained.intent.reference,checkBudget:budget.check});
        const stock=checkpoint?.phase==='frozen_stock_v1' ? await stockStore.read() : await stockStore.prepare();
        const body={stock_stage_version:1,usage:'frozen_job_stock_only',subject_intent:retained.intent.reference,stock};
        let reference;
        if(checkpoint?.phase==='frozen_stock_v1') {
          reference=checkpoint.evidence_refs[1];
          if(await blobs.get(reference.content_sha256,reference.canonical_utf8_bytes)!==canonicalAssessmentJson(body)) fail('checkpoint_conflict');
        }else{
          reference=await blobs.put(canonicalAssessmentJson(body));
          await jobs.saveCheckpoint(claim,jobOptions,{phase:'frozen_stock_v1',evidence_refs:[retained.intent.reference,reference]});
        }
        // Recheck current roles, exact assignment and original subject under
        // READ COMMITTED before commit. Pin/data/checkpoint alone grant none.
        input=freeze({...input,auth:await loadCurrentCustomCohortJobActor(client,input.auth.userId,scope.organization_id)});
        assertTarget(await resolveTarget(client,input,true),target);
        privateDraft(await privateCaptureWorkfile(client,input));
        if((await subjects.compareCurrent(retained.subjectReference)).status!=='matched') fail('subject_changed');
        authorizePublicCadastralCatalogRead(input.auth,input.accountId,{workflows:['custom_appraisal'],
          permissionChecker:(auth,workflow,permission)=>hasApplicationPermission(auth,workflow,permission,scope.organization_id)});
        if(!sameFrozenRequest(await jobs.readRequest(claim,jobOptions),requested) || !same(await stockStore.read(),stock)) fail('checkpoint_conflict');
        budget.check();
        return freeze({status:'stock_prepared',operation_id:input.operationId,reused:checkpoint?.phase==='frozen_stock_v1',
          stock_reference:reference,generation_id:stock.generation_id,population:stock.population,
          source_acquisition:'not_established',report_update:'none'});
      });
    },
    /** Internal source-prefix DATA stage; never dispatched by the legacy worker. */
    prepareFrozenCaptureJobSourcePage: (value, options = {}) => frozenCaptureJobSourceStage(value, options, 'prefix_v1'),
    /** Explicit V2 prefix DATA owner. Retain exact fixed-plan metadata only,
     * not per-report originals. Both-end current rights and the live generation/
     * stock pin are identical to V1; no V1 checkpoint conversion, new source
     * grant, verification receipt, HTTP/worker activation or Apply is implied. */
    prepareFrozenCaptureJobSourceReferencesV2Page: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'prefix_refs_v2'),
    /** Dormant independent native source-prefix issuance; starts only at the
     * actual two-reference stock checkpoint, never adopts a free prefix. */
    issueFrozenCaptureJobSourceReferencesV2Page: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'issued_prefix_refs_v2'),
    /** Dormant actual prefix owner with same-TX native success/release. */
    continueFrozenCaptureJobSourcePrefixReferencesV2Page: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'continued_prefix_refs_v2'),
    /** Explicit V2 original-query/root-edge verifier. Continuation is derived
     * only from a separately fenced owner-issued receipt anchor, never arbitrary
     * checkpoint progress. No legacy cast, source grant, worker dispatch or Apply. */
    verifyFrozenCaptureJobSourceReferencesV2Page: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'verify_refs_v2'),
    /** Dormant same-TX issued success handoffs through the SAME original owners.
     * The unregistered early-continuation candidate must be composed first.
     * No caller source, phase, progress cursor, DONE or failure reset admitted. */
    continueFrozenCaptureJobSourceReferencesV2Page: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'verify_continue_refs_v2'),
    continueFrozenCaptureJobStockOriginalReferencesV2: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'geographic_continue_refs_v2'),
    continueFrozenCaptureJobSourceIdentityReferencesV2: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'identity_continue_refs_v2'),
    /** Explicit V2 geographic original owner. Requires the completed issued
     * graph and advances only its own independent geographic issuance head;
     * never casts V1 progress, grants source rights, releases a pin or Applies. */
    verifyFrozenCaptureJobStockOriginalReferencesV2: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'geographic_refs_v2'),
    /** Explicit V2 identity owner. Requires independently issued DONE graph and
     * geography; continuation comes only from its own issued identity head.
     * No typed observations, source acquisition, publication, Apply or pin release. */
    verifyFrozenCaptureJobSourceIdentityReferencesV2: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'identity_refs_v2'),
    reconcileFrozenCaptureJobNeutralOriginalsReferencesV2: (value,options={})=>
      frozenCaptureJobSourceStage(value,options,'neutral_cache_refs_v2'),
    continueFrozenCaptureJobNeutralOriginalsReferencesV2: (value,options={})=>
      frozenCaptureJobSourceStage(value,options,'neutral_cache_continue_refs_v2'),
    /** Independent current-authorized root-edge/original-representation validation.
     * Not typed identity closure, complete geographic stock, source acquisition,
     * report publication or Apply. Progress is loaded only from this job's fence. */
    verifyFrozenCaptureJobSourcePage: (value, options = {}) => frozenCaptureJobSourceStage(value, options, 'verify_v1'),
    /** Independently reopen every geographic parcel original, including NULL
     * account geometry, after the actual owner verified the whole source graph.
     * Typed source identities/numerical coverage remain a subsequent stage. */
    verifyFrozenCaptureJobStockOriginals: (value, options = {}) => frozenCaptureJobSourceStage(value, options, 'geographic_v1'),
    /** Current-authorized exact identity/one-hop validation, not numerical facts,
     * historical/freshness coverage or a legacy acquisition capability. */
    verifyFrozenCaptureJobSourceIdentityClosure: (value, options = {}) => frozenCaptureJobSourceStage(value, options, 'identity_v1'),
    prepareFrozenCaptureJobTypedOriginals: (value, options = {}) => frozenCaptureJobSourceStage(value, options, 'typed_v1'),
    // Internal numerical pages only. No API/browser exposure, checkpoint write,
    // acquisition receipt or accepted report is established by reading a page.
    readFrozenCaptureJobStockMetrics: (value, options = {}) => frozenCaptureJobSourceStage(value, options, 'stock_metrics_v1'),
    // Exact prepared-cache reuse is separate from the per-job V1 typed path.
    // Still internal/unmounted: no new job phase, builder, schedule or Apply.
    readSharedFrozenCaptureJobStockMetrics: (value, options = {}) => frozenCaptureJobSourceStage(value, options, 'shared_stock_metrics_v1'),
    readSharedFrozenCaptureJobStockMetricsReferencesV2: (value, options = {}) => frozenCaptureJobSourceStage(value, options, 'shared_stock_metrics_refs_v2'),
    // Explicit internal-only reader. Default composition has no additional CAD
    // policy. Actual issued DONE V2 heads and both current decisions are required;
    // no seven-layer cast, cache preparation, checkpoint or source grant write.
    readSharedFrozenCaptureJobCadImprovementsReferencesV2: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'shared_CAD_pages_refs_v2'),
    readSharedFrozenCaptureJobCadAccountsReferencesV2: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'shared_CAD_accounts_refs_v2'),
    readOriginalFrozenCaptureJobCadAccountPackagesReferencesV2: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'original_CAD_account_packages_refs_v2'),
    /** Explicit manual cache operation; caller cursor is only a page locator.
     * Both current CAD decisions and every issued parent/original are reopened.
     * No native coverage head, checkpoint, lease handoff or consumer activation. */
    cacheOriginalFrozenCaptureJobCadAccountReferencesV2: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'cache_CAD_original_account_refs_v2'),
    /** Native head chooses each whole account; no caller page or continuation.
     * Explicit manual operation until the separate automatic success bridge. */
    continueOriginalFrozenCaptureJobCadCacheCoverageReferencesV2: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'cache_CAD_coverage_refs_v2'),
    /** Dormant actual whole-original CAD owner with native same-TX success,
     * saved lease deadline and fresh single-consume continuation. */
    continueFrozenCaptureJobCadOriginalsReferencesV2: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'continue_CAD_coverage_refs_v2'),
    /** Fixed first stock account, only after independently issued CAD+E DONE.
     * Replays originals/entire cache; no cursor, writes or selected completeness. */
    readCoveredOriginalFrozenCaptureJobFirstCadAmenityEvidenceReferencesV2: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'covered_first_CAD_amenities_refs_v2'),
    /** Resolve retained local amenity evidence only after full original replay;
     * no provider dictionary, verified presence, aggregate or live activation. */
    readOriginalFrozenCaptureJobCadAmenityEvidenceReferencesV2: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'original_CAD_amenity_evidence_refs_v2'),
    readSharedFrozenCaptureJobTransactionsReferencesV2: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'shared_transaction_pages_refs_v2'),
    readSharedFrozenCaptureJobTransactionTemporalReferencesV2: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'shared_transaction_temporal_refs_v2'),
    /** Read one whole bounded native association package with owner-retained dates
     * and actual issued/current-rights fences. Native completeness is not provider
     * parcel completeness, economic equivalence, eligibility or publication. */
    readSharedFrozenCaptureJobTransactionPackagesReferencesV2: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'shared_transaction_packages_refs_v2'),
    /** Replay every complete package original under the same issued/current
     * fences before retained temporal/native projection; no new authority. */
    readOriginalFrozenCaptureJobTransactionPackagesReferencesV2: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'original_transaction_packages_refs_v2'),
    /** Recompile each bounded stock original against its entire neutral cache
     * under independently issued V2 prerequisites and both-end current rights.
     * No selection, statistic, new phase, payload copy or report is issued. */
    readSharedFrozenCaptureJobStockOriginalCellsReferencesV2: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'shared_stock_original_cells_refs_v2'),
    /** Reconcile the complete bounded original packet for one SERVER-chosen
     * stock account before exact five-state resolution; never a selected union. */
    readSharedFrozenCaptureJobStockAccountPackagesReferencesV2: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'shared_stock_account_packages_refs_v2'),
    /** Read every original under actual native job coverage while the global
     * cache remains building. No miss preparation or global completion claim. */
    readCoveredFrozenCaptureJobStockAccountPackagesReferencesV2: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'covered_stock_account_packages_refs_v2'),
    /** Fixed native stock prefix under one shared original budget and all
     * current/ending source and job fences. Read-only; no batch progress head,
     * continuation, registry, publication or pin handoff is issued here. */
    readCoveredFrozenCaptureJobWholeAccountBatchReferencesV2(...args){
      if(args.length!==2)fail('invalid_options');
      return frozenCaptureJobSourceStage(args[0],args[1],'covered_stock_whole_account_batch_refs_v2');
    },
    /** Resolve the retained housing choice only AFTER all account originals
     * are reconciled under issued V2/current rights. Internal, not a selector,
     * report fact, source grant, new phase or large-area acceptance. */
    readOriginalFrozenCaptureJobAccountHousingReferencesV2: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'original_account_housing_refs_v2'),
    /** Resolve exact original county/subdivision labels, including512-byte
     * text unavailable in128-byte neutral markers, AFTER every whole-account
     * original/cache replay and both-end issued V2/current-rights fences.
     * No complete catalog, selected union, new phase or authority is issued. */
    readOriginalFrozenCaptureJobAccountRecordedGroupReferencesV2: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'original_account_recorded_group_refs_v2'),
    /** Commit one server-owned original traversal step with independent issued
     * CAS head and retention-root checkpoint. No caller continuation, selected
     * union/statistic, public route, scheduler activation or report update. */
    advanceOriginalFrozenCaptureJobStockTraversalReferencesV2: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'original_stock_traversal_refs_v2'),
    /** One original-backed recorded-group ordinal, not a selected member list. */
    advanceOriginalFrozenCaptureJobRecordedPartitionReferencesV2: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'original_recorded_partition_refs_v2'),
    /** One original-reconciled catalog count contribution. Not selection,
     * publication, a complete browser roster or an activated worker stage. */
    advanceOriginalFrozenCaptureJobRecordedCatalogReferencesV2: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'original_recorded_catalog_refs_v2'),
    /** Same bounded original/current-authority owner, then atomically release
     * one new issued progress reference for a fresh-token success continuation.
     * No retry-history reset, worker activation, completion or pin transfer. */
    continueOriginalFrozenCaptureJobStockTraversalReferencesV2: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'original_stock_traversal_continue_refs_v2'),
    /** Completed native cache coverage, a fresh first-stock claim and all
     * whole-original/current-ending fences precede the native main handoff. */
    continueCoveredOriginalFrozenCaptureJobStockTraversalReferencesV2: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'covered_stock_traversal_continue_refs_v2'),
    /** Closed batch owner. A NEW native grammar must be installed and proved
     * before use; historical V2 jobs/readers stay exact and cannot switch format.
     * Every account shares original/current/ending fences and one atomic native
     * receipt/head/checkpoint/release. No default registration or activation. */
    continueCoveredOriginalFrozenCaptureJobStockBatchReferencesV3(...args){
      if(args.length!==2)fail('invalid_options');
      return frozenCaptureJobSourceStage(args[0],args[1],'covered_stock_batch_continue_refs_v3');
    },
    continueOriginalFrozenCaptureJobRecordedPartitionReferencesV2: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'original_recorded_partition_continue_refs_v2'),
    /** Independent native job-cache coverage admits whole-original replay;
     * global cache status, source grants and every ending fence stay intact. */
    continueCoveredOriginalFrozenCaptureJobRecordedPartitionReferencesV2: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'covered_recorded_partition_continue_refs_v2'),
    continueOriginalFrozenCaptureJobRecordedCatalogReferencesV2: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'original_recorded_catalog_continue_refs_v2'),
    /** Every whole original and entire partition entry must reconcile again
     * under actual native cache coverage before one catalog contribution. */
    continueCoveredOriginalFrozenCaptureJobRecordedCatalogReferencesV2: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'covered_recorded_catalog_continue_refs_v2'),
    /** Reconcile one indexed derived partition entry against EVERY original,
     * not a selected-union capability or a hash/count-only group reader. */
    readOriginalFrozenCaptureJobRecordedPartitionAccountReferencesV2: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'original_recorded_partition_account_refs_v2'),
    /** Reconcile the complete partition entry against whole originals using
     * actual native job-cache coverage; no global completion is fabricated. */
    readCoveredOriginalFrozenCaptureJobRecordedPartitionAccountReferencesV2: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'covered_recorded_partition_account_refs_v2'),
    /** Reopen ONE whole original/ENTIRE cache/ENTIRE partition entry only after
     * independently issued catalog DONE. Same aggregate/current-ending fences;
     * no source authority from catalog counts, selection, new head or release. */
    readOriginalFrozenCaptureJobRecordedCatalogAccountReferencesV2: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'original_recorded_catalog_account_refs_v2'),
    /** Completed native catalog plus current whole originals/entire cache and
     * partition entry; does not infer human selection or complete semantics. */
    readCoveredOriginalFrozenCaptureJobRecordedCatalogAccountReferencesV2: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'covered_recorded_catalog_account_refs_v2'),
    // Current editor target only. A worker claim is NOT a genuine new human
    // group command; no selection is inferred from the prior active head.
    readOriginalFrozenCaptureJobSelectionWorkspaceTargetReferencesV2: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'original_selection_workspace_target_refs_v2'),
    // Dormant lease-neutral boundary, not an HTTP/worker activation or a human
    // command. Only a later authenticated NEW-study command may enable resume.
    awaitOriginalFrozenCaptureJobSelectionReferencesV2: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'original_catalog_selection_wait_refs_v2'),
    /** Fresh terminal original/cache/partition probe plus the exact current
     * pending workspace and prior active head. Releases only the live lease. */
    awaitCoveredOriginalFrozenCaptureJobSelectionReferencesV2: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'covered_catalog_selection_wait_refs_v2'),
    // Inactive internal owner: explicit IDs are intent ONLY. No HTTP exposure,
    // browser claim, prior-choice carryover, membership, statistics or Apply.
    resumeOriginalFrozenCaptureJobSelectionIntentReferencesV2: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'original_catalog_selection_intent_refs_v2'),
    /** Explicit authenticated NEW-study command only; job-cache coverage never
     * selects groups or carries a prior appraiser choice into this study. */
    resumeCoveredOriginalFrozenCaptureJobSelectionIntentReferencesV2: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'covered_catalog_selection_intent_refs_v2'),
    // Read-only current-worker reopen, not a second human command or lease.
    // Current actor/source/subject/target and entire original graph are checked
    // again. Retained IDs do NOT establish complete catalog or selected union.
    readOriginalFrozenCaptureJobRetainedSelectionIntentReferencesV2: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'original_retained_selection_intent_refs_v2'),
    /** Reopen the same immutable command with every current/ending source and
     * pending-workspace fence; no new selection, lease or publication. */
    readCoveredOriginalFrozenCaptureJobRetainedSelectionIntentReferencesV2: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'covered_retained_selection_intent_refs_v2'),
    // Internal fourth pass only. No free IDs/cursor/roster/adapter/DONE/reset.
    // No HTTP/default worker dispatch, eligibility, publication or pin transfer.
    continueOriginalFrozenCaptureJobSelectedStockUnionReferencesV2: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'original_selected_union_replay_refs_v2'),
    continueCoveredOriginalFrozenCaptureJobSelectedStockUnionReferencesV2: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'covered_selected_union_replay_refs_v2'),
    readOriginalFrozenCaptureJobSelectedUnionSubjectHousingReferencesV2: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'original_selected_union_subject_housing_refs_v2'),
    readCoveredOriginalFrozenCaptureJobSelectedUnionSubjectHousingReferencesV2: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'covered_selected_union_subject_housing_refs_v2'),
    // Inactive read-only ordinal1 original admission, NOT the fifth issued pass.
    // No caller account/ordinal/cursor/decision, lease, new head or continuation.
    readOriginalFrozenCaptureJobFirstSelectedEligibilityReferencesV2: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'original_selected_union_first_eligibility_refs_v2'),
    readCoveredOriginalFrozenCaptureJobFirstSelectedEligibilityReferencesV2: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'covered_selected_union_first_eligibility_refs_v2'),
    // Separate current CAD purpose at BOTH ends; no extra child/row budget.
    readOriginalFrozenCaptureJobFirstSelectedAmenitiesReferencesV2: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'original_selected_union_first_amenities_refs_v2'),
    readCoveredOriginalFrozenCaptureJobFirstSelectedAmenitiesReferencesV2: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'covered_selected_union_first_amenities_refs_v2'),
    readOriginalFrozenCaptureJobFirstSelectedTransactionsReferencesV2: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'original_selected_union_first_transactions_refs_v2'),
    /** Fixed first native selected account only. Job-cache coverage is never
     * economic equivalence, complete union transactions or publication. */
    readCoveredOriginalFrozenCaptureJobFirstSelectedTransactionsReferencesV2: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'covered_selected_union_first_transactions_refs_v2'),
    readOriginalFrozenCaptureJobFirstSelectedCombinedEvidenceReferencesV2: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'original_selected_union_first_combined_refs_v2'),
    progressOriginalFrozenCaptureJobSelectedRecordedEligibilityReferencesV2: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'original_selected_eligibility_progress_refs_v2'),
    progressCoveredOriginalFrozenCaptureJobSelectedRecordedEligibilityReferencesV2: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'covered_selected_eligibility_progress_refs_v2'),
    // Dormant sixth pass. No HTTP/worker route or activation. Every native
    // selected ordinal reopens all originals; only references are retained.
    progressOriginalFrozenCaptureJobSelectedEvidenceReferencesV2: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'original_selected_evidence_progress_refs_v2'),
    progressCoveredOriginalFrozenCaptureJobSelectedEvidenceReferencesV2: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'covered_selected_evidence_progress_refs_v2'),
    // Dormant, read-only first metric-source candidate. No HTTP/worker route,
    // retained metric rows, population statistics or publication authority.
    readOriginalFrozenCaptureJobFirstSelectedMetricReferencesV2: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'original_selected_first_metric_refs_v2'),
    // Dormant seventh pass; no HTTP/worker activation. Original-reconciled
    // rows/head/exact13 roots/continuation are retained in ONE caller TX.
    progressOriginalFrozenCaptureJobSelectedMetricReferencesV2: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'original_selected_metrics_progress_refs_v2'),
    progressCoveredOriginalFrozenCaptureJobSelectedMetricReferencesV2: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'covered_selected_metrics_progress_refs_v2'),
    // Inactive, read-only statistics-source boundary; fixed first only. Fresh
    // originals and field reconciliation, NOT complete statistics/publication.
    readOriginalFrozenCaptureJobFirstSelectedStatisticsReferencesV2: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'original_selected_first_statistics_refs_v2'),
    progressOriginalFrozenCaptureJobSelectedStatisticsReferencesV2: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'original_selected_statistics_progress_refs_v2'),
    progressCoveredOriginalFrozenCaptureJobSelectedStatisticsReferencesV2: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'covered_selected_statistics_progress_refs_v2'),
    // Inactive read-only fixed-first source reconciliation after DONE eighth.
    // NOT a frequency index, complete semantic pass, statistic or publication.
    readOriginalFrozenCaptureJobFirstSelectedFrequencyReferencesV2: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'original_selected_first_frequency_refs_v2'),
    // Separate inactive indexed-source entry; same strict14/fresh originals.
    // Numerical values remain internal, not full-population/rank authority.
    readOriginalFrozenCaptureJobFirstSelectedNumericReferencesV2: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'original_selected_first_indexed_refs_v2'),
    readOriginalFrozenCaptureJobFirstSelectedRankCandidatesReferencesV2: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'original_selected_first_rank_candidates_refs_v2'),
    // Inactive tenth complete-original semantic owner; no activation/publication.
    progressOriginalFrozenCaptureJobSelectedSemanticReferencesV2: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'original_selected_semantic_progress_refs_v2'),
    progressCoveredOriginalFrozenCaptureJobSelectedSemanticReferencesV2: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'covered_selected_semantic_progress_refs_v2'),
    // Read-only actual original-owner seam AFTER tenth DONE. Fixed first only;
    // separate native selected flags, not global/economic transaction authority.
    readOriginalFrozenCaptureJobFirstSelectedTransactionSourceReferencesV2: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'original_selected_transaction_source_refs_v2'),
    // Separate inactive FIRST candidate, still exact16 and read-only. No ledger
    // advance or phase17; all existing complete-original/ending fences apply.
    prepareOriginalFrozenCaptureJobFirstSelectedTransactionIndexCandidateReferencesV2: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'original_selected_transaction_first_candidate_refs_v2'),
    // Inactive READ-ONLY native NEXT seam. Exact16/17 native admission and the
    // complete original/retained-member/current+ending owner are connected, but
    // no blob, child, head, checkpoint, yield or worker activation is issued.
    async readOriginalFrozenCaptureJobNextSelectedTransactionIndexReferencesV2(...args){
      if(args.length!==2)fail('invalid_options');
      return frozenCaptureJobSourceStage(args[0],args[1], 'original_selected_transaction_index_source_refs_v2');
    },
    // Inactive atomic native NEXT owner, no route/worker/default dispatch.
    // Installed guards refuse issuance until the unregistered coherent native
    // guard/continuation migration and full native proofs are complete.
    async progressOriginalFrozenCaptureJobSelectedTransactionIndexReferencesV2(...args){
      if(args.length!==2)fail('invalid_options');
      return frozenCaptureJobSourceStage(args[0],args[1], 'original_selected_transaction_index_progress_refs_v2');
    },
    async progressCoveredOriginalFrozenCaptureJobSelectedTransactionIndexReferencesV2(...args){
      if(args.length!==2)fail('invalid_options');
      return frozenCaptureJobSourceStage(args[0],args[1], 'covered_selected_transaction_index_progress_refs_v2');
    },
    // Inactive ninth population owner; no route/worker/default activation.
    progressOriginalFrozenCaptureJobSelectedNumericReferencesV2: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'original_selected_numeric_progress_refs_v2'),
    progressCoveredOriginalFrozenCaptureJobSelectedNumericReferencesV2: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'covered_selected_numeric_progress_refs_v2'),
    async capture(value, options = {}) {
    if (!options || Object.getPrototypeOf(options) !== Object.prototype)
      fail('invalid_options');
    const { captureJobClaim: providedClaim, ...budgetOptions } = options;
    let input = inputOf(value);
    const captureJobClaim = providedClaim ? prepareCustomCohortCaptureJobClaim(providedClaim) : null;
    if (captureJobClaim && captureJobClaim.operation_id !== input.operationId.toLowerCase()) fail('operation_conflict');
    if (captureJobClaim) input = freeze({ ...input, operationId: captureJobClaim.operation_id });
    const budget = operationBudget(budgetOptions, LIMITS.capture_duration_ms);
    async function refreshJobActor(client, organizationId) {
      if (!captureJobClaim) return;
      // A worker can run long enough for its initial roles to be revoked. The
      // assignment and source checks in each transaction must use today's
      // database identity, including the final registration and replay paths.
      budget.check();
      const auth = await loadCurrentCustomCohortJobActor(client, input.auth.userId, organizationId);
      budget.check();
      input = freeze({ ...input, auth });
    }
    budget.check();
    const phase = createCustomCapturePhaseTiming();
    const study = freeze({ profile_id: input.discovery?.profile_id ?? NEIGHBORHOOD_SELECTOR_INPUT_PROFILE_V1,
      ...(input.discovery ? { discovery: input.discovery } : {}),
      observation_period: input.observationPeriod, knowledge_cutoff: null });
    const phaseOne = await phase('subject', () => transaction(pool, 'READ COMMITTED', budget, async client => {
      const privateWorkfile = input.privateSalesImport ? await privateCaptureWorkfile(client, input) : null;
      const target = await resolveTarget(client, input, true);
      await refreshJobActor(client, target.organization_id);
      if (captureJobClaim) assertTarget(await resolveTarget(client, input, true), target);
      const scope = Object.fromEntries(TARGET_FIELDS.map(key => [key, target[key]]));
      const scopeJson = canonicalAssessmentJson(scope);
      const repository = createCustomCohortSubjectRepository(client, scopeJson);
      const jobs = captureJobClaim ? createCustomCohortCaptureJobRepository(client) : null;
      const jobScope = { scope, actorUserId: input.auth.userId };
      const checkpoint = jobs ? await jobs.readCheckpoint(captureJobClaim, jobScope) : null;
      const existing = await client.query(`/* custom-cohort-capture:existing-context */
        SELECT context_sha256 FROM app.neighborhood_custom_cohort_contexts
        WHERE organization_id=$1 AND context_id=$2`, [scope.organization_id, input.operationId]);
      if (existing.rowCount) {
        if (existing.rowCount !== 1 || existing.rows.length !== 1) fail('operation_conflict');
        const reference = { context_id: input.operationId, context_revision: '1', context_sha256: existing.rows[0].context_sha256 };
        const { retained } = await authorizedRetainedInputs(client, {
          scopeJson, reference, input, authorizeMarketData, authorizePrivateSales, budget, study,
        });
        if (retained.acquisition_intent.body.actor_user_id !== input.auth.userId || !same(retained.study, study)) fail('operation_conflict');
        if (!same(retained.acquisition_intent.body.private_sales_import ?? null, input.privateSalesImport ?? null)) fail('operation_conflict');
        if ((await repository.compareCurrent(retained.subject_reference)).status !== 'matched') fail('subject_changed');
        // A worker retry can observe a context committed before its response
        // was lost. Close that exact fenced claim only after replay has again
        // checked the current assignment and source rights.
        if (captureJobClaim) await createCustomCohortCaptureJobRepository(client)
          .complete(captureJobClaim, reference.context_sha256);
        // Replay confirms durable registration only, not a new source read or
        // eligible cohort. No raw market evidence is returned here.
        return { replay: freeze({ status: 'registered', reused: true, context_ref: reference,
          discovery: { ...(retained.summary.discovery ?? { radius_metres: retained.summary.radius_metres }), parcel_count: retained.summary.parcel_count,
            account_count: retained.summary.account_count }, source_query_complete: true, provider_coverage: 'not_established',
          unsupported_capabilities: retained.retained_inputs.acquisition.capture_result.unsupported_capabilities,
          ...(input.privateSalesImport ? { private_sales_import: input.privateSalesImport } : {}) }) };
      }
      if (privateWorkfile) privateDraft(privateWorkfile);
      if (checkpoint) {
        const resume = checkpoint.phase === 'preparation'
          ? resumeCustomCohortPreparationCheckpoint : resumeCustomCohortSubjectCheckpoint;
        const resumed = await resume({ checkpoint,
          blobs: createNeighborhoodCohortBlobRepository(client, scope.organization_id),
          subjects: repository, input, study, reportedProfile, housingProfile });
        if (resumed.stagedHeader) {
          authorizePublicCadastralCatalogRead(input.auth, input.accountId, { workflows: ['custom_appraisal'],
            permissionChecker: (auth, workflow, permission) => hasApplicationPermission(auth, workflow, permission, scope.organization_id) });
          const stagedCapture = await authorizedRetainedInputs(client, { scopeJson,
            reference: resumed.stagedHeader.context_ref, input, authorizeMarketData, authorizePrivateSales,
            budget, study, stagedHeader: resumed.stagedHeader, expectedIntent: resumed.intent.reference });
          if (!same(stagedCapture.retained.subject_reference, resumed.subjectReference)
            || !same(stagedCapture.retained.acquisition_intent, resumed.intent)) fail('checkpoint_conflict');
          budget.check();
          return { scope, scopeJson, ...resumed, stagedCapture, checkpoint };
        }
        budget.check();
        return { scope, scopeJson, ...resumed };
      }
      const subjectReference = await repository.capture();
      const subject = await repository.load(subjectReference);
      if (study.observation_period.end_date > subject.effective_date) fail('period_after_effective_date');
      const point = await repository.loadRecordedPoint(subjectReference);
      if (point.status !== 'represented') fail('recorded_point_required', point.reason);
      const body = freeze({ intent_version: (input.privateSalesImport ? 2 : 1) + (reportedProfile ? 2 : 0) + 4, operation_id: input.operationId, actor_user_id: input.auth.userId,
        subject_inputs: subjectReference, target: subject.target, effective_date: subject.effective_date,
        study, created_at: await databaseTime(client),
        ...(reportedProfile ? { reported_sale_interpretation: reportedProfile } : {}),
        recorded_housing_interpretation: housingProfile,
        ...(input.privateSalesImport ? { private_sales_import: input.privateSalesImport } : {}) });
      const reference = await createNeighborhoodCohortBlobRepository(client, scope.organization_id).put(canonicalAssessmentJson(body));
      if (jobs) await jobs.saveCheckpoint(captureJobClaim, jobScope,
        { phase: 'subject', evidence_refs: [reference] });
      return { scope, scopeJson, subject, subjectReference, point, intent: { reference, body } };
    }));
    if (phaseOne.replay) return phaseOne.replay;
    const { scope, scopeJson, subject, subjectReference, point, intent } = phaseOne;
    // A saved operation replays its retained original before consulting today's
    // registry. A NEW city study accepts only an installed, dated local asset.
    const city = !phaseOne.stagedCapture && input.discovery?.profile_id === NEIGHBORHOOD_SELECTOR_INPUT_PROFILE_CITY
      ? await loadInstalledCustomCityDiscovery(input.discovery) : null;
    budget.check();
    const context = contextOf(subject);
    let purpose = phaseOne.stagedCapture?.purpose, decision = phaseOne.stagedCapture?.decision;
    const originals = phaseOne.stagedCapture?.retained.retained_inputs;
    // Completed acquisition/preparation retries use the exact complete original
    // snapshot. A later database sweep must not get mixed into that operation.
    const read = originals ? { spatial: originals.spatial, selector: originals.selector,
      result: originals.acquisition.capture_result, privateSales: originals.private_sales ?? null }
      : await transaction(pool, 'REPEATABLE READ READ ONLY', budget, async client => {
      await refreshJobActor(client, scope.organization_id);
      assertTarget(await resolveTarget(client, input, false), subject.target);
      authorizePublicCadastralCatalogRead(input.auth, input.accountId, { workflows: ['custom_appraisal'],
        permissionChecker: (auth, workflow, permission) => hasApplicationPermission(auth, workflow, permission, scope.organization_id) });
      const startedAt = await databaseTime(client);
      let privateSales = null;
      if (input.privateSalesImport) {
        const privatePurpose = customNeighborhoodPrivateSalesPurpose(input.privateSalesImport);
        const permission = await boundedPolicy(authorizePrivateSales, client, input.auth, context, privatePurpose, budget);
        const capture = await captureAssignmentSalesCsv(client.query.bind(client), { target: scope,
          batchId: input.privateSalesImport.batch_id, expectedReviewRevision: input.privateSalesImport.expected_review_revision });
        privateSales = { capture, authorization: { decision_id: permission.decision_id, policy_revision: permission.policy_revision } };
      }
      const spatial = await phase('spatial', async () => captured(await captureNeighborhoodSpatialMembershipCompact(client, point.geometry_input, {}, input.discovery, city ?? undefined), 'spatial'));
      // Existing cached-source access requires the subject in the source roster.
      // Never add an outside-city subject to claim complete polygon membership.
      if (city && !spatial.account_ids.includes(scope.account_id)) fail('city_subject_outside_scope');
      const selector = prepareNeighborhoodSelectorInput({ profile_id: study.profile_id, ...context,
        selection: { id: input.operationId, revision: 1, source_sha256: spatial.membership_sha256 },
        geometry_input: point.geometry_input,
        discovery: city ? { city: city.choice.city, parcel_predicate: NEIGHBORHOOD_CITY_PARCEL_PREDICATE }
          : { radius_metres: spatial.radius_metres, distance_semantics: 'postgis_geography_spheroid_v1', parcel_predicate: 'all_intersecting_parcels' },
        roster: { complete: true, account_count: spatial.account_ids.length, account_ids: spatial.account_ids } });
      if (selector.status !== 'prepared') fail('selector_incomplete', selector.reason);
      // The chosen issuer/reader pair must agree; denied expanded rights never
      // fall back to the old projection. Registered contexts replay above.
      const access = createReadAccess({
        resolveAuthorizedAssignment: async () => { assertTarget(await resolveTarget(client, input, false), subject.target); return context; },
        resolveTrustedSelection: async () => ({ ...selector.selection, account_ids: selector.account_roster.account_ids }),
        authorizeMarketData: async (auth, current, requestedPurpose) => {
          purpose = requestedPurpose;
          decision = await boundedPolicy(authorizeMarketData, client, auth, current, requestedPurpose, budget);
          budget.check(); return decision;
        },
        resolveTransactionClosure: async () => {
          const closure = captured(await resolveNeighborhoodCachedTransactionClosure(client, {
            selected_account_ids: spatial.account_ids, source_revision: `cached-identity-v1:${input.operationId}`,
          }, { deadline: budget.deadline, signal: budget.signal }), 'transaction_identity');
          if (!same(closure.snapshot, spatial.snapshot)) fail('snapshot_changed');
          return closure.transaction_closure;
        },
      });
      return phase('source', async () => {
        const grants = await phase('source_authorization', () => access.prepare(input.auth, { target: context.target,
          selection_reference: { id: input.operationId, revision: 1 }, observation_period: input.observationPeriod, knowledge_cutoff: null }));
        const reader = createSourceReader(pool, { access });
        const result = await phase('source_read', async () => captured(await reader.captureInSnapshot(client, { ...grants.request, auth: input.auth,
          selection_grant: grants.selection_grant, market_grant: grants.market_grant },
        { deadline: budget.deadline, signal: budget.signal }), 'source'));
        if (!same(result.snapshot, spatial.snapshot)) fail('snapshot_changed');
        return { spatial, selector, reader, result, privateSales, startedAt, completedAt: await databaseTime(client) };
      });
    });
    // Pure original-evidence preparation owns no connection or database locks.
    // The source read has committed; registration below still takes fresh locks
    // and rechecks the subject, assignment, rights and private CSV review before
    // any prepared evidence/context is persisted. Never hold an idle write
    // transaction while encoding a dense area's evidence graph.
    budget.check();
    const prepared = originals ? null : await phase('preparation', () => {
      const acquisition = consumeNeighborhoodCachedAcquisition(read.reader, read.result);
      return prepareCustomCohortCaptureInputsBatched({ acquisition, spatial: read.spatial, subject,
        subject_reference: subjectReference, selector: read.selector, study, acquisition_intent: intent,
        started_at: read.startedAt, completed_at: read.completedAt,
        ...(reportedProfile ? { reported_sale_interpretation: reportedProfile } : {}),
        recorded_housing_interpretation: housingProfile,
        ...(read.privateSales ? { private_sales: read.privateSales } : {}) }, { check: budget.check });
    });
    const recheckCapture = async client => {
      await refreshJobActor(client, scope.organization_id);
      if (read.privateSales) privateDraft(await privateCaptureWorkfile(client, input));
      assertTarget(await resolveTarget(client, input, true), subject.target);
      const subjects = createCustomCohortSubjectRepository(client, scopeJson);
      if ((await subjects.compareCurrent(subjectReference)).status !== 'matched') fail('subject_changed');
      const freshDecision = await boundedPolicy(authorizeMarketData, client, input.auth, context, purpose, budget);
      if (!same(freshDecision, decision)) fail('market_policy_changed');
      if (read.privateSales) {
        const permission = await boundedPolicy(authorizePrivateSales, client, input.auth, context,
          customNeighborhoodPrivateSalesPurpose(input.privateSalesImport), budget);
        if (!same(read.privateSales.authorization, { decision_id: permission.decision_id, policy_revision: permission.policy_revision })) fail('market_policy_changed');
        await recheckAssignmentSalesCsvCapture(client.query.bind(client), read.privateSales.capture);
      }
      budget.check();
    };
    const headerFor = refs => ({ context_version: 1, context_id: input.operationId, context_revision: '1',
      target: { ...context.target, ...context.scope, snapshot_version: subject.target.snapshot_version },
      effective_date: subject.effective_date, ...refs });
    let stagedHeader = phaseOne.stagedHeader, preparedCheckpoint = phaseOne.checkpoint;
    if (captureJobClaim && !stagedHeader) {
      // Stage only a WHOLE validated acquisition. Immutable originals, their
      // header and the fenced checkpoint commit together; no context/report is
      // published here. Partial source pages cannot become a completed study.
      await transaction(pool, 'READ COMMITTED', budget, async client => {
        await recheckCapture(client);
        const refs = await phase('retention', () => persistCustomCohortCaptureInputs(client, scopeJson, prepared));
        const canonicalHeader = canonicalAssessmentJson(headerFor(refs));
        const representedHeader = prepareCustomCohortContextHeader(canonicalHeader);
        const headerRef = await createNeighborhoodCohortBlobRepository(client, scope.organization_id).put(canonicalHeader);
        preparedCheckpoint = { phase: 'preparation', evidence_refs: [intent.reference, headerRef] };
        await createCustomCohortCaptureJobRepository(client).saveCheckpoint(captureJobClaim,
          { scope, actorUserId: input.auth.userId }, preparedCheckpoint);
        stagedHeader = representedHeader;
      });
    }
    return transaction(pool, 'READ COMMITTED', budget, async client => {
      await recheckCapture(client);
      let header;
      if (captureJobClaim) {
        const current = await createCustomCohortCaptureJobRepository(client).readCheckpoint(captureJobClaim,
          { scope, actorUserId: input.auth.userId });
        if (!same(current, preparedCheckpoint)) fail('checkpoint_conflict');
        header = stagedHeader.body;
      } else {
        const refs = await phase('retention', () => persistCustomCohortCaptureInputs(client, scopeJson, prepared));
        header = headerFor(refs);
      }
      budget.check();
      const stored = await phase('registration', () => createCustomCohortContextRepository(client, scopeJson).put(canonicalAssessmentJson(header)));
      // The job and context become visible together. A lost/cancelled claim
      // aborts this transaction rather than publishing an orphaned context.
      if (captureJobClaim) await createCustomCohortCaptureJobRepository(client)
        .complete(captureJobClaim, stored.context_ref.context_sha256);
      return freeze({ status: 'registered', reused: stored.status === 'reused', context_ref: stored.context_ref,
        discovery: { ...(phaseOne.stagedCapture?.retained.summary.discovery ?? (city ? city.choice : { radius_metres: read.spatial.radius_metres })),
          parcel_count: read.spatial.parcels.length, account_count: read.spatial.account_ids.length },
        source_query_complete: true, provider_coverage: 'not_established',
        unsupported_capabilities: read.result.unsupported_capabilities,
        ...(input.privateSalesImport ? { private_sales_import: input.privateSalesImport } : {}) });
    });
  }, async review(value, options = {}) {
    const input = reviewInputOf(value), budget = operationBudget(options);
    return transaction(pool, 'READ COMMITTED', budget, async client => {
      const target = await resolveTarget(client, input, true, 'write');
      if (input.command.target_ref.report_file_id !== target.report_file_id) fail('operation_conflict');
      const scopeJson = canonicalAssessmentJson(Object.fromEntries(TARGET_FIELDS.map(key => [key, target[key]])));
      const licensed = await authorizedRetainedInputs(client, { scopeJson, reference: input.command.expected_context,
        input, authorizeMarketData, authorizePrivateSales, budget, loadInputs: false });
      budget.check();
      const saved = await createCustomCohortReviewRepository(client, scopeJson)
        .append(input.commandJson, input.auth.userId);
      budget.check();
      assertTarget(await resolveTarget(client, input, true, 'write'), target);
      const finalDecision = await boundedPolicy(authorizeMarketData, client, input.auth,
        licensed.context, licensed.purpose, budget);
      if (!same(finalDecision, licensed.decision)) fail('market_policy_changed');
      await recheckPrivatePolicy(client, input, licensed, budget);
      // Opaque operation metadata only: no retained MLS field, claim, reviewer
      // label or raw evidence is exposed by a retention-only rights decision.
      // transaction() delivers this value only after COMMIT; an uncertain COMMIT
      // throws with outcome_unknown, allowing a later exact authorized retry.
      return freeze({ status: 'review_recorded', reused: saved.status === 'reused',
        context_ref: input.command.expected_context, decision_ref: saved.decision_ref,
        generation: saved.generation, authority: 'not_established' });
    });
  }, async prepareReportedObservations(value, options = {}) {
    const input = reportedInputOf(value), budget = operationBudget(options), phase = createCustomReportPhaseTiming();
    const loaded = await phase('load', () => transaction(pool, 'READ COMMITTED', budget, async client => {
      const data = await loadReported(client, input, budget);
      if (data.reportEditor.editor_revision !== input.expectedEditorRevision) fail('report_editor_changed');
      if (input.replacement) data.replacement = await reportedPredecessor(client, input, data.target);
      const previous = await storedReportProposal(client, input, data.target);
      if (previous && !same(previous.payload.fences, reportFences(data))) fail('report_proposal_changed');
      await recheckReported(client, input, data, budget);
      return { ...data, previous };
    }));
    if (loaded.previous) return proposalResponse(input, loaded, { status: 'ready',
      attachment: loaded.previous.stored.attachment }, loaded.previous.stored.assessment, [], true);
    const active = loaded.workspace.checkpoint.active;
    const target = { scope: loaded.retained.context.scope, report_file_id: loaded.target.report_file_id,
      custom_assignment_file_id: Number(input.assignmentFileId), editor_revision: input.expectedEditorRevision,
      effective_date: loaded.retained.context.effective_date, data_cutoff: loaded.retained.context.effective_date };
    const identity = { assessment_id: randomUUID(), assessment_revision: 1, attachment_id: randomUUID(), attachment_revision: 1 };
    budget.check();
    const buildReported = loaded.retained.reportedInterpretation
      ? buildCustomCohortReportedAssessmentWitnessV2Batched : buildCustomCohortReportedAssessmentBatched;
    const prepared = await phase('assembly', () => buildReported({ context_ref: input.contextRef,
      retained_inputs: loaded.retained.retained.retained_inputs, selection: loaded.workspaceSelection?.selection ?? active.selection, target,
      catalog_version: customWorkspaceCatalogVersion(loaded.workspace.checkpoint),
      preparation_identity: identity, report_geography: loaded.reportGeography, derived_at: loaded.derivedAt,
      proposal_binding: { operation_id: input.operationId, actor_user_id: input.auth.userId,
        expected_editor_revision: input.expectedEditorRevision } }, { check: budget.check }));
    // Rehearse the exact public shape before any publication writes. The final
    // published identity is checked again after its actual revision is assigned.
    if (prepared.status === 'ready') proposalResponse(input, loaded, prepared.candidate, prepared.assessment);
    budget.check();
    return phase('publication', () => transaction(pool, 'READ COMMITTED', budget, async client => {
      privateDraft(await privateCaptureWorkfile(client, input));
      await recheckReported(client, input, loaded, budget);
      // Another exact retry may have committed while this request assembled.
      const previous = await storedReportProposal(client, input, loaded.target);
      if (previous) {
        if (!same(previous.payload.fences, reportFences(loaded))) fail('report_proposal_changed');
        return proposalResponse(input, loaded, { status: 'ready', attachment: previous.stored.attachment }, previous.stored.assessment, [], true);
      }
      if (prepared.status !== 'ready') return proposalResponse(input, loaded, null, null, prepared.issues);
      const repository = createNeighborhoodAssessmentRepositoryInTransaction(client);
      const payload = { proposal_version: input.replacement ? 2 : 1, request: reportRequest(input, loaded.target), fences: reportFences(loaded),
        attachment: { id: identity.attachment_id, revision: identity.attachment_revision } };
      if (Buffer.byteLength(canonicalAssessmentJson(payload)) > 32000) fail('report_response_limit');
      const queued = await repository.enqueue(target.scope, { operation_id: input.operationId,
        effective_date: target.effective_date, data_cutoff: target.data_cutoff,
        input_signature_sha256: prepared.assessment.input_signature_sha256, payload });
      const claim = await repository.claimExact(target.scope,
        { job_id: queued.job.id, expected_request_generation: queued.request_generation });
      const published = await phase('repository', () => repository.publishBatched(claim, prepared.assessment, prepared.publication_bundle.members,
        prepared.publication_bundle.sources.map(source => ({ id: source.snapshot.id, payload: source.payload })), { check: budget.check }));
      if (!published.promoted) fail('report_proposal_changed');
      const candidate = buildCustomNeighborhoodReportCandidate({ assessment: published.assessment,
        target: { ...target, attachment_id: identity.attachment_id, attachment_revision: identity.attachment_revision,
          workflow_type: 'custom_appraisal', uad_workfile_id: null, specification_release: null } });
      if (candidate.status !== 'ready') fail('report_publication_incomplete');
      await persistNeighborhoodAttachment(client, { assessment: published.assessment,
        attachment: candidate.attachment, mappedSuggestions: candidate.suggestions });
      await recheckReported(client, input, loaded, budget);
      return proposalResponse(input, loaded, candidate, published.assessment);
    }));
  }, async applyReportedObservations(value, options = {}) {
    const input = reportedInputOf(value, true), budget = operationBudget(options);
    return transaction(pool, 'READ COMMITTED', budget, async client => {
      const loaded = await loadReported(client, input, budget, { allowSigned: true, geography: false });
      const proposal = await storedReportProposal(client, input, loaded.target);
      if (!proposal || proposal.stored.attachment.attachment_id !== input.attachmentId
        || proposal.stored.attachment.attachment_revision !== input.attachmentRevision
        || proposal.stored.attachment.binding_digest_sha256 !== input.bindingDigest) fail('operation_conflict');
      const acceptanceTarget = { organizationId: loaded.target.organization_id, reportFileId: loaded.target.report_file_id,
        assignmentFileId: Number(input.assignmentFileId), operationId: input.operationId };
      const accepted = await getCustomNeighborhoodAcceptance(client, acceptanceTarget);
      if (accepted) {
        if (accepted.actorUserId !== input.auth.userId || accepted.attachmentId !== input.attachmentId
          || accepted.attachmentRevision !== input.attachmentRevision
          || accepted.acceptedEditorRevision !== loaded.reportEditor.editor_revision) fail('operation_conflict');
        // The accepted operation itself advanced only the reserved editor. All
        // other proposal bindings, current rights and exact target still apply.
      } else {
        privateDraft(loaded.workfile);
        if (loaded.reportEditor.editor_revision !== input.expectedEditorRevision) fail('report_editor_changed');
        if (input.replacement) {
          loaded.replacement = await reportedPredecessor(client, input, loaded.target);
          if (!same(input.replacement, publicReplacement(loaded.replacement.fence))) fail('report_replacement_conflict');
        } else {
          // Default first adoption retains its exact occupied/history refusal.
          // Explicit replacement never reaches these empty-slot assumptions.
          if (loaded.reportEditor.editor_revision !== 0) fail('report_group_conflict');
          const history = one(await client.query(`/* custom-cohort-capture:reported-never-accepted */
            SELECT EXISTS(SELECT 1 FROM app.custom_neighborhood_acceptances
              WHERE assignment_file_id=$1::bigint) AS has_acceptance`, [input.assignmentFileId]));
          if (history.has_acceptance !== false) fail('report_group_conflict');
        }
      }
      const fences = reportFences(loaded);
      if (accepted) {
        fences.editor = proposal.payload.fences.editor;
        // Replay belongs to the successor: its predecessor is now historical.
        // The immutable proposal and exact echoed descriptor bind the old group;
        // do not require it to be current again or overwrite the current successor.
        if (input.replacement) fences.replacement = proposal.payload.fences.replacement;
      }
      if (!same(fences, proposal.payload.fences)) fail('report_proposal_changed');
      await recheckReported(client, input, loaded, budget, { acceptedReplay: Boolean(accepted) });
      let result = accepted;
      if (!accepted) {
        const stored = proposal.stored, attachment = stored.attachment;
        const planInput = { assessment: stored.assessment, target: attachment,
          current_application_identity_sha256: attachment.application_identity_sha256,
          current_editor_revision: loaded.reportEditor.editor_revision,
          request: { selected_ids: stored.mappedSuggestions.map(item => item.id), binding_digest_sha256: input.bindingDigest } };
        const plan = input.replacement ? prepareCustomNeighborhoodReportReplacement({ ...planInput,
          existing_values: loaded.replacement.existingValues,
          predecessor: { assessment: loaded.replacement.stored.assessment, attachment: loaded.replacement.stored.attachment,
            receipt: loaded.replacement.receipt } })
          : prepareCustomNeighborhoodReportApply({ ...planInput,
            existing_values: stored.mappedSuggestions.map(item => ({ target_key: item.target_key, target_exists: true, populated: false })) });
        if (plan.status !== 'ready') fail(input.replacement ? 'report_replacement_conflict' : 'report_group_conflict');
        result = await saveCustomNeighborhoodAcceptanceInTransaction(client, { ...acceptanceTarget,
          actorUserId: input.auth.userId, attachmentId: input.attachmentId, attachmentRevision: input.attachmentRevision,
          receipt: buildNeighborhoodApplicationReceipt(plan, input.expectedEditorRevision + 1) });
      }
      await recheckReported(client, input, loaded, budget, { acceptedReplay: Boolean(accepted), editorAfterSave: !accepted });
      return freeze({ status: 'accepted', target: { account_id: input.accountId, assignment_file_id: input.assignmentFileId },
        context_ref: input.contextRef, operation_id: input.operationId, proposal_operation_id: input.proposalOperationId,
        accepted_editor_revision: result.acceptedEditorRevision, reused: Boolean(accepted),
        ...(input.replacement ? { replacement: publicReplacement(proposal.payload.fences.replacement) } : {}) });
    });
  }, async prepareReviewedInputs(value, options = {}) {
    const input = reviewedInputsInputOf(value), budget = operationBudget(options);
    const loaded = await transaction(pool, 'READ COMMITTED', budget, async client => {
      const target = await resolveTarget(client, input, true, 'read');
      const scopeJson = canonicalAssessmentJson(Object.fromEntries(TARGET_FIELDS.map(key => [key, target[key]])));
      const workspace = await savedWorkspace(client, input);
      const exactSelection = workspace.checkpoint.workspace_version === 7;
      const currentInput = exactSelection ? { ...input,
        auth: await loadCurrentCustomCohortJobActor(client, input.auth.userId, target.organization_id) } : input;
      if (exactSelection) assertTarget(await resolveTarget(client, currentInput, true, 'read'), target);
      const retained = await authorizedRetainedInputs(client, { scopeJson, reference: input.contextRef,
        input: currentInput, authorizeMarketData, authorizePrivateSales, budget, study: workspace.checkpoint.active,
        additionalExposures: exactSelection ? ['report_observation_catalog'] : [] });
      const selection = await workspaceSelection(client, currentInput, { scopeJson, workspace, retained }, budget);
      if ((await createCustomCohortSubjectRepository(client, scopeJson)
        .compareCurrent(retained.retained.subject_reference)).status !== 'matched') fail('subject_changed');
      const review = await createCustomCohortReviewRepository(client, scopeJson)
        .getCurrent(canonicalAssessmentJson(input.contextRef), input.expectedReviewGeneration);
      // The existing read-only preparation supports full bigint assignment IDs.
      // The report attachment contract intentionally uses safe integers; do not
      // coerce a larger ID or take away its existing evidence inspection path.
      const reportEditor = BigInt(input.assignmentFileId) <= BigInt(Number.MAX_SAFE_INTEGER)
        ? await reportEditorState(client, input) : null;
      const now = await databaseTime(client);
      // Normalize the actual owner clock to the source envelope's millisecond
      // precision and retain the original reading separately. Never round up
      // to invent a later instant; finer future evidence stays unavailable.
      const millis = Date.parse(now);
      if (!Number.isFinite(millis)) fail('database_time_unavailable');
      const derivedAt = new Date(millis).toISOString();
      let savedBoundary = null, reportGeography = null;
      if (reportEditor !== null) {
        savedBoundary = await reportGeographyState(client, input);
        const admitted = prepareCustomCohortReportGeography({
          target: { organization_id: target.organization_id, report_file_id: target.report_file_id,
            assignment_file_id: input.assignmentFileId, account_id: input.accountId },
          ...savedBoundary, captured_at: derivedAt, retained_subject: retained.retained.retained_inputs.subject });
        const topology = admitted.geometry_for_validation === null ? null
          : await reportGeometryTopology(client, admitted.geometry_for_validation, admitted.subject_point_for_validation);
        reportGeography = completeCustomCohortReportGeography(admitted, topology);
      }
      return { target, scopeJson, workspace, review, retained, reportEditor, savedBoundary, reportGeography, now, derivedAt,
        ...(selection ? { workspaceSelection: selection } : {}) };
    });
    budget.check();
    const active = loaded.workspace.checkpoint.active;
    const temporalSupport = customCohortCurrentStockSupport({
      effective_date: loaded.retained.retained.retained_inputs.subject.effective_date,
      retained_capture_at: loaded.retained.retained.retained_inputs.acquisition.capture_result.captured_at,
    });
    const historicalBlocked = temporalSupport.status === 'historical_stock_evidence_required';
    // Reviewer declarations cannot turn a later current-CAD mirror into dated
    // historical stock. Keep retained inspection intact, but do not compute or
    // prepare a report candidate from it. All final access/freshness fences below
    // still run on this unavailable path, including saved geography and reviews.
    const supported = historicalBlocked ? null : buildCustomCohortSupportedInputs({
      preparation_input: { context_header_json: loaded.retained.header.header_blob.canonical_json,
        expected: { context_ref: input.contextRef, target: JSON.parse(loaded.scopeJson),
          observation_period: active.observation_period },
        retained_inputs: loaded.retained.retained.retained_inputs, selection: loaded.workspaceSelection?.selection ?? active.selection,
        catalog_version: customWorkspaceCatalogVersion(loaded.workspace.checkpoint) },
      review_state: loaded.review, derived_at: loaded.derivedAt,
    });
    const reportPreparation = historicalBlocked
      ? freeze({ report_preparation_version: 1, status: 'incomplete', authority: 'not_established',
        identity_status: 'unpublished_preparation', assessment: null, publication_bundle: null, candidate: null,
        report_geography: loaded.reportGeography, temporal_support: temporalSupport,
        issues: [{ code: 'historical_stock_evidence_required' }],
        apply: { status: 'blocked', reasons: ['historical_stock_evidence_required'] } })
      : loaded.reportEditor === null
      ? freeze({ report_preparation_version: 1, status: 'incomplete', authority: 'not_established',
        identity_status: 'unpublished_preparation', assessment: null, publication_bundle: null, candidate: null,
        issues: [{ code: 'unsupported_assignment_identity' }],
        apply: { status: 'blocked', reasons: ['unsupported_assignment_identity'] } })
      : buildCustomCohortReportPreparation({ supported_inputs: supported,
        target: { scope: { organization_id: loaded.target.organization_id, appraisal_case_id: loaded.target.appraisal_case_id,
          subject_snapshot_id: loaded.target.subject_snapshot_id, account_id: loaded.target.account_id },
          report_file_id: loaded.target.report_file_id, custom_assignment_file_id: Number(input.assignmentFileId),
          editor_revision: loaded.reportEditor.editor_revision, effective_date: loaded.retained.retained.retained_inputs.subject.effective_date,
          data_cutoff: loaded.retained.retained.retained_inputs.subject.effective_date },
        preparation_identity: { assessment_id: randomUUID(), assessment_revision: 1,
          attachment_id: randomUUID(), attachment_revision: 1 }, report_geography: loaded.reportGeography });
    budget.check();
    return transaction(pool, 'READ COMMITTED', budget, async client => {
      const currentInput = loaded.workspaceSelection ? { ...input,
        auth: await loadCurrentCustomCohortJobActor(client, input.auth.userId, loaded.target.organization_id) } : input;
      assertTarget(await resolveTarget(client, currentInput, true, 'read'), loaded.target);
      const workspace = await savedWorkspace(client, input);
      if (!same(workspace, loaded.workspace)) fail('workspace_changed');
      await recheckWorkspaceSelection(client, currentInput, loaded, budget);
      if (loaded.reportEditor !== null && !same(await reportEditorState(client, input), loaded.reportEditor)) fail('report_editor_changed');
      if (loaded.savedBoundary !== null && !same(await reportGeographyState(client, input), loaded.savedBoundary)) fail('report_geography_changed');
      if ((await createCustomCohortSubjectRepository(client, loaded.scopeJson)
        .compareCurrent(loaded.retained.retained.subject_reference)).status !== 'matched') fail('subject_changed');
      const review = await createCustomCohortReviewRepository(client, loaded.scopeJson)
        .getCurrent(canonicalAssessmentJson(input.contextRef), input.expectedReviewGeneration);
      if (review.state_sha256 !== loaded.review.state_sha256) fail('review_state_changed');
      const decision = await boundedPolicy(authorizeMarketData, client, currentInput.auth,
        loaded.retained.context, loaded.retained.purpose, budget);
      if (!same(decision, loaded.retained.decision)) fail('market_policy_changed');
      if (loaded.workspaceSelection && !same(await boundedPolicy(authorizeMarketData, client, currentInput.auth,
        loaded.retained.context, loaded.retained.purpose, budget, 'report_observation_catalog'), loaded.retained.decision)) fail('market_policy_changed');
      await recheckPrivatePolicy(client, currentInput, loaded.retained, budget,
        loaded.workspaceSelection ? ['none', 'report_observation_catalog'] : ['none']);
      // Internal source-bearing computation only, never a public presentation
      // response or a publish/Apply authorization. No accepted section changes.
      return Object.freeze({ status: 'prepared_reviewed_inputs', authority: 'not_established',
        workspace_section_revision: workspace.section_revision, owner_clock_at: loaded.now,
        subject_freshness: 'matched', supported_inputs: supported, report_preparation: reportPreparation,
        apply: Object.freeze({ status: 'blocked', reason: historicalBlocked
          ? 'historical_stock_evidence_required' : 'owner_adoption_and_publication_required' }) });
    });
  }, preview(value, options = {}) {
    return runPreview(value, options);
  }, async catalog(value, options = {}) {
    // Saved workspaces pin their catalog semantics. Only a fresh opening or an
    // explicit user upgrade requests latest; never reinterpret old unassigned.
    // Omitted wire versions stay v2 for already-open clients during rollout.
    const catalogVersion = value && Object.hasOwn(value, 'catalogVersion')
      ? value.catalogVersion : CUSTOM_COHORT_DENSE_CATALOG_VERSION;
    customCohortCatalogGroupLimit(catalogVersion);
    // Preserve the original method/response when omitted. The optional summary
    // uses the two EXISTING exposures; no source-policy key/grant is widened.
    const requested = value && Object.hasOwn(value, 'includeRecommendation');
    const include = requested ? value.includeRecommendation : false;
    if (typeof include !== 'boolean') fail('invalid_input');
    const explicitGroups = value && Object.hasOwn(value, 'initialPreviewGroups');
    const modeRequested = value && Object.hasOwn(value, 'initialPreviewMode');
    const manifestOpening = value && Object.hasOwn(value, 'initialMapMode');
    if (explicitGroups && modeRequested) fail('invalid_input');
    if (modeRequested) prepareCustomCohortOpeningMode(value.initialPreviewMode);
    const opening = explicitGroups || modeRequested;
    if (manifestOpening && (value.initialMapMode !== 'manifest' || !opening || catalogVersion !== 3 || !include)) fail('invalid_input');
    const groups = explicitGroups ? prepareCustomCohortOpeningGroups(value.initialPreviewGroups, catalogVersion) : null;
    const input = Object.fromEntries(Object.entries(value).filter(([key]) => !['catalogVersion', 'includeRecommendation', 'initialPreviewGroups', 'initialPreviewMode', 'initialMapMode'].includes(key)));
    const cached = await readPreparedCatalog(input, options, { catalogVersion, include, opening, groups,
      recommendedAreaOpening: modeRequested && value.initialPreviewMode === 'recommended_area', manifestOpening });
    if (cached) return cached;
    return runPreview(input, options, { includeMap: false, exposure: 'report_observation_catalog',
      additionalExposures: include || opening ? ['report_observation_summary'] : [],
      preparedCatalog: include && catalogVersion === 3,
      manifestOpening,
      outputLimit: opening ? CUSTOM_COHORT_OPENING_RESPONSE_BYTES : include ? CUSTOM_COHORT_POCKET_CATALOG_LIMITS.transport_output_utf8_bytes : null,
      recommendedAreaOpening: modeRequested && value.initialPreviewMode === 'recommended_area',
      project: async (preview, expected, _parcelMap, retained_inputs, deriveProximity, presentOpening, checkBudget, deriveSecondary, setCatalogPhaseTiming) => {
        const timed = createCustomCatalogPhaseTiming();
        setCatalogPhaseTiming(timed);
        const catalog = await timed('catalog', () => presentCustomCohortPocketCatalog({
          catalog: buildCustomCohortPocketCatalog({ retained_inputs, preview, catalog_version: catalogVersion }), preview, expected,
        }));
        const city = retained_inputs.study.profile_id === NEIGHBORHOOD_SELECTOR_INPUT_PROFILE_CITY;
        const response = { status: 'catalog', catalog, ...(city ? { discovery: retained_inputs.study.discovery } : {}) };
        if (!include && modeRequested && value.initialPreviewMode === 'recommended_area') fail('invalid_input');
        if (!include && opening) response.initial_preview = await timed('opening', () => presentOpening(customCohortOpeningSelection(catalog,
          groups ?? customCohortOpeningGroupIds(catalog), expected.selection_revision)));
        if (!include) return response;
        // Ranking/report safeguards stay separate from display-only colors.
        // Current retained CAD can inform manual map review without pretending
        // it establishes a retrospective housing population. Reuse the same
        // preview/kernel and prepared catalog, never a fresh source capture.
        const current = customCohortCurrentStockSupport({ effective_date: retained_inputs.subject.effective_date,
          retained_capture_at: retained_inputs.acquisition.capture_result.captured_at });
        if (!catalog.catalog_complete || current.status === 'historical_stock_evidence_required') {
          if (catalog.catalog_complete) response.prepared_secondary_map = await timed('retained_map_scores', () =>
            buildCustomCohortMapScoresBatched({ context_ref: expected.context_ref, retained_inputs,
              catalog_version: catalogVersion, observation_preview: catalogVersion >= 2 ? preview : undefined,
              selection: { revision: expected.selection_revision, included_recorded_group_ids: [] } }, { checkBudget }));
          if (opening) response.initial_preview = await timed('opening', () => presentOpening(customCohortOpeningSelection(catalog,
            groups ?? customCohortOpeningGroupIds(catalog), expected.selection_revision)));
          return response;
        }
        // A municipal polygon has no radius-calibrated proximity scale. Keep
        // that factor unknown instead of borrowing an arbitrary ten-mile radius.
        const recorded_proximity = city ? undefined : await timed('proximity', deriveProximity);
        // No map can consume this overlay when the retained parcel geometry is
        // unavailable. This also avoids an unnecessary index checkout.
        const prepared_secondary_facts = !city && recorded_proximity?.reason === 'retained_map_unavailable'
          ? null : await timed('prepared_secondary', deriveSecondary).catch(() => null);
        checkBudget();
        const maximumBytes = Math.max(0, Math.min(CUSTOM_COHORT_DENSE_RECOMMENDATION_PRESENTATION_BYTES,
          CUSTOM_COHORT_POCKET_CATALOG_LIMITS.transport_output_utf8_bytes
            - Buffer.byteLength(JSON.stringify({ ...response, initial_preview: undefined })) - 10_000));
        const recommendation = await timed('recommendation', () => buildCustomCohortPocketRecommendationPresentationBatched({ catalog, expected,
          retained_inputs, recorded_proximity, observation_preview: preview, maximumBytes,
          prepared_secondary_facts }, { checkBudget }));
        const { prepared_secondary_map, ...stableRecommendation } = recommendation ?? {};
        // The opening preview and the saved revision must use one identical
        // selection. On missing/unsupported recommendation, retain the prior
        // complete-catalog opening instead of presenting an invented subset.
        const areaIds = modeRequested && value.initialPreviewMode === 'recommended_area'
          && recommendation?.sales_aware_area?.status !== 'unavailable'
          && recommendation?.sales_aware_area?.selected_recorded_group_ids?.length
          ? recommendation.sales_aware_area.selected_recorded_group_ids : null;
        if (opening) response.initial_preview = await timed('opening', () => presentOpening(customCohortOpeningSelection(catalog,
          groups ?? areaIds ?? customCohortOpeningGroupIds(catalog), expected.selection_revision)));
        return { ...response, ...(recommendation ? { recommendation: stableRecommendation } : {}),
          ...(prepared_secondary_map ? { prepared_secondary_map } : {}) };
      },
    });
  }, async authorizeMarketSelection(value, options = {}) {
    const input = previewInputOf(value), budget = operationBudget(options);
    return transaction(pool, 'READ COMMITTED', budget, async client => {
      const target = await resolveTarget(client, input, false, 'read');
      const scopeJson = canonicalAssessmentJson(Object.fromEntries(TARGET_FIELDS.map(key => [key, target[key]])));
      const licensed = await authorizedRetainedInputs(client, { scopeJson, reference: input.contextRef, input,
        authorizeMarketData, authorizePrivateSales, budget, exposure: 'report_observation_summary',
        privateSummary: true, loadInputs: false });
      const membership = await checkCustomCohortMarketMembership({
        store: createNeighborhoodCohortBlobRepository(client, target.organization_id),
        rosterRef: licensed.accountRosterRef, selection: input.selection, contextRef: input.contextRef, checkBudget: budget.check,
      });
      assertTarget(await resolveTarget(client, input, true, 'read'), target);
      if ((await createCustomCohortSubjectRepository(client, scopeJson)
        .compareCurrent(licensed.subjectReference)).status !== 'matched') fail('subject_changed');
      const decision = await boundedPolicy(authorizeMarketData, client, input.auth,
        licensed.context, licensed.purpose, budget, 'report_observation_summary');
      if (!same(decision, licensed.decision)) fail('market_policy_changed');
      await recheckPrivatePolicy(client, input, licensed, budget, ['report_observation_summary']);
      budget.check();
      // This is internal authorization, not report Apply or a rewritten capture.
      return freeze({ target: { account_id: input.accountId, assignment_file_id: input.assignmentFileId }, ...membership });
    });
  }, present(value, presentation = { includeMap: true }, options = {}) {
    exactKeys(presentation, ['includeMap']);
    if (typeof presentation.includeMap !== 'boolean') fail('invalid_input');
    return runPreview(value, options, { includeMap: presentation.includeMap, exposure: 'report_observation_summary', preparedFast: true,
      project: (preview, expected, parcelMap) => ({ summary: presentCustomCohortPreview({ preview, expected, includeNarrative: true }), parcel_map: parcelMap }) });
  }, async viewport(value, viewport, options = {}) {
    const checked = prepareCustomCohortViewport(viewport);
    const preview = await runPreview(value, options, { includeMap: true, exposure: 'report_observation_summary', preparedFast: true,
      mapViewport: checked,
      project: (observation, expected, parcelMap) => ({ summary: presentCustomCohortPreview({ preview: observation, expected }), parcel_map: parcelMap }) });
    return projectCustomCohortViewportMap(preview, checked);
  }, inspect(value, inspection, options = {}) {
    exactKeys(inspection, ['population', 'page']);
    const owned = freeze(JSON.parse(canonicalAssessmentJson(inspection)));
    return runPreview(value, options, { includeMap: false, exposure: 'report_observation_members',
      project: (preview, expected) => ({ status: 'members', page: inspectCustomCohortPreviewMembers({ preview, expected, ...owned }) }) });
  } });
}
