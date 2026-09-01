import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useParams } from "react-router-dom";
import {
  forgetEditorCredential,
  requestEditorCredential,
} from "@/lib/editorCredential";
import {
  readAppraisalReportDraft,
  type AppraisalReportSalesDraft,
} from "@/lib/appraisalReportDraft";
import {
  getAssignmentFiles,
  reviewNeighborhoodBoundary as saveNeighborhoodBoundaryReview,
  getCustomAppraisalWorkfileReadiness,
  saveCustomAppraisalWorkfileSection,
  signCustomAppraisalWorkfile,
  updateAssignmentFile,
  updateMobileInspectionSketch,
  type AppraisalAssignmentFile,
  type AssignmentPhoto,
  type AssignmentDocumentType,
  type AssignmentDetailsPayload,
  type PropertyComplexityAssessment,
  type ReportManualSectionKey,
  makeUrl,
} from "@/lib/api";
import { loadCustomAppraisalWorkfile } from "@/lib/appraisalFileRequests";
import {
  readMarketConditionsDraft,
  type MarketConditionsDraft,
} from "@/lib/marketConditionsDraft";
import { useNeighborhoodProfile } from "@/hooks/useNeighborhoodProfile";
import { usePropertyContext } from "@/hooks/usePropertyContext";
import PropertyContextSection from "@/components/PropertyContextSection";
import { useRelatedParcels } from "@/hooks/useRelatedParcels";
import { useManualReportSections } from "@/hooks/useManualReportSections";
import { useCustomAppraisalDownloads } from "@/hooks/useCustomAppraisalDownloads";
import SubjectConditionConformitySection from "@/components/SubjectConditionConformitySection";
import SketchWorkspaceEmptyState from "@/components/SketchWorkspaceEmptyState";
import { usePropertyReportDetail } from "@/hooks/usePropertyReportDetail";
import {
  DEFAULT_NEIGHBORHOOD_BOUNDARY_NARRATIVE,
  marketTrendFromChange,
  neighborhoodBoundaryReadinessErrors,
} from "@/lib/neighborhoodCharacteristics";
import {
  growthFromMarket,
  marketTrendFromRecommendation,
  marketingTimeFromMedianDom,
  reconciledMedianDaysOnMarket,
  type NeighborhoodLocationType,
} from "@/lib/neighborhoodAutomation";
import DeferredReportSection from "@/components/DeferredReportSection";
import PreviousAppraisalFilesContent from "@/components/PreviousAppraisalFiles";
import ReportTypeChooser from "@/components/ReportTypeChooser";
import ReportSectionEditor from "@/components/ReportSectionEditor";
import type { PropertyActivityRow } from "@/components/ListingsContractsSalesContent";
import {
  CheckboxChoice,
  SummaryField,
  SummarySection,
} from "@/components/PropertyReportControls";
import { hasSnapshotValue, mergeNonBlankSnapshot } from "@/lib/reportSnapshotMerge";

const AssignmentDocumentCenter = memo(
  lazy(() => import("@/components/AssignmentDocumentCenter")),
);
const AssignmentPhotoCenter = memo(
  lazy(() => import("@/components/AssignmentPhotoCenter")),
);
const MobileSketchReview = lazy(() => import("@/components/MobileSketchReview"));
const NeighborhoodCharacteristicsContent = lazy(
  () => import("@/components/NeighborhoodCharacteristicsContent"),
);
const ListingsContractsSalesContent = lazy(
  () => import("@/components/ListingsContractsSalesContent"),
);
const PreviousAppraisalFiles = memo(PreviousAppraisalFilesContent);

function LazyReportContent({ label, className = "" }: { label: string; className?: string }) {
  return (
    <div className={`rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600 ${className}`}>
      Loading {label}...
    </div>
  );
}
import {
  displayValue,
  formatBaths,
  formatCensusTract,
  formatDate,
  formatMoney,
  formatNumber,
  formatOwnershipPercent,
  formatReportedBoolean,
  hasValue,
  listingTimelineRows,
  parseNumber,
  sellerComparisonSummary,
} from "@/lib/propertyReportPresentation";
import {
  ASSIGNMENT_TYPE_OPTIONS,
  HOA_FREQUENCY_OPTIONS,
  OCCUPANCY_OPTIONS,
  assignmentDraftFromDetail,
  assignmentTypesFromConfirmedDocument,
  subjectUnderContractFromConfirmedDocument,
  assignmentValidationErrors,
  cloneEditorValue,
} from "@/lib/propertyReportAssignment";
import { useAssignmentFiles } from "@/hooks/useAssignmentFiles";
import {
  useCensusProfile,
  type CensusProfilesLoaded,
} from "@/hooks/useCensusProfile";
import { useZoningEvidence } from "@/hooks/useZoningEvidence";

type DcadOwner = {
  owner_name?: string;
  mailing_address?: string;
  parties?: DcadOwnerParty[];
};

type DcadOwnerParty = {
  owner_name?: string;
  ownership_pct?: string | number;
};

type DcadValueSummary = {
  certified_year?: number | string;
  improvement_value?: string | number;
  land_value?: string | number;
  market_value?: string | number;
  capped_value?: string | number;
};

type DcadMainImprovement = {
  building_class?: string;
  year_built?: string | number;
  effective_year_built?: string | number;
  actual_age?: string | number;
  desirability?: string;
  living_area_sqft?: string | number;
  total_living_area?: string | number;
  total_area_sqft?: string | number;
  percent_complete?: string | number;
  stories?: number | string;
  construction_type?: string;
  foundation?: string;
  roof_type?: string;
  roof_material?: string;
  exterior_material?: string;
  basement?: boolean | string;
  heating?: string;
  air_conditioning?: string;
  bedroom_count?: string | number;
  bath_count?: string | number;
  baths_full?: string | number;
  baths_half?: string | number;
  kitchens?: string | number;
  wetbars?: string | number;
  fireplaces?: string | number;
  sprinkler?: boolean | string;
  spa?: boolean | string;
  pool?: boolean | string;
  sauna?: boolean | string;
  fence_type?: string;
  number_units?: string | number;
};

type DcadLandRow = {
  number?: string | number;
  state_code?: string;
  zoning?: string;
  frontage_ft?: string | number;
  depth_ft?: string | number;
  area_sqft?: string | number;
  pricing_method?: string;
  unit_price?: string | number;
  market_adjustment_pct?: string | number;
  adjusted_price?: string | number;
  ag_land?: string;
};

type DcadImprovementRow = {
  number?: string | number;
  improvement_type?: string;
  construction?: string;
  floor?: string;
  exterior_wall?: string;
  area_sqft?: string | number;
  value?: string | number;
  year_built?: string | number;
};

type DcadExemptionRow = {
  taxing_jurisdiction?: string;
  homestead_exemption?: string | number;
  disabled_vet?: string | number;
  taxable_value?: string | number;
};

type DcadExemptionsMap = {
  city?: DcadExemptionRow;
  school?: DcadExemptionRow;
  county?: DcadExemptionRow;
  college?: DcadExemptionRow;
  hospital?: DcadExemptionRow;
  special_district?: DcadExemptionRow;
};

type DcadSaleHistoryRow = PropertyActivityRow;

type DcadHousingProfile = {
  structural_style?: string;
  housing_type?: string;
  attachment_type?: string;
  architectural_style?: string;
  profile_source?: string;
};

type AssignmentDetails = AssignmentDetailsPayload;

type DcadDetail = {
  tax_year?: number;
  property_location?: {
    address?: string;
    neighborhood?: string;
    mapsco?: string;
    city?: string;
    state?: string;
    postal_code?: string;
    county?: string;
    subdivision?: string;
    census_tract?: string;
    census_tract_geoid?: string;
    census_tract_status?: string;
    census_vintage?: string;
  };
  owner?: DcadOwner;
  value_summary?: DcadValueSummary;
  main_improvement?: DcadMainImprovement;
  housing_profile?: DcadHousingProfile;
  additional_improvements?: DcadImprovementRow[];
  land_detail?: DcadLandRow[];
  exemptions?: DcadExemptionsMap;
  legal_description?: {
    lines?: string[];
    deed_transfer_date?: string;
  };
  sales_history?: DcadSaleHistoryRow[];
  property_activity_history?: DcadSaleHistoryRow[];
  census_geography?: {
    tract_geoid?: string;
    tract_code?: string;
    status?: string;
    vintage?: string;
    review_reason?: string;
  } | null;
  property_context?: PropertyComplexityAssessment | null;
  homestead_yes?: boolean;
  assignment_details?: AssignmentDetails;
  photos?: string[];
  report_manual_values?: Partial<Record<ReportManualSectionKey, unknown>>;
};

function AddressHero({
  detail,
  accountId,
  requestedAssignmentFileId,
  onReload,
}: {
  detail: DcadDetail | null;
  accountId?: string;
  requestedAssignmentFileId?: number | null;
  onReload: () => Promise<void>;
}) {
  const editorKeyForSave = useCallback((): string => {
    return requestEditorCredential("Enter the HomeNode editor key to save verified changes:");
  }, []);
  const {
    editingSection,
    savingSection,
    editSection,
    cancelEditingSection,
    saveEditedSection,
  } = useManualReportSections({
    accountId,
    getEditorKey: editorKeyForSave,
    onReload,
    onCredentialRejected: forgetEditorCredential,
  });
  const [photoIndex, setPhotoIndex] = useState(0);
  const [assignmentDraft, setAssignmentDraft] = useState<AssignmentDetails>(() =>
    assignmentDraftFromDetail(),
  );
  const [assignmentDirty, setAssignmentDirty] = useState(false);
  const [assignmentSaveMessage, setAssignmentSaveMessage] = useState("");
  const [savingAssignmentFile, setSavingAssignmentFile] = useState(false);
  const [assignmentChooserOpen, setAssignmentChooserOpen] = useState(false);
  const unemploymentLookupSucceeded = useRef(false);
  const unemploymentHydrationAccount = useRef("");
  const [neighborhoodSectionReady, setNeighborhoodSectionReady] = useState(false);
  const [marketConditionsDraft, setMarketConditionsDraft] = useState<MarketConditionsDraft | null>(
    () => readMarketConditionsDraft(accountId || ""),
  );
  const [salesComparisonDraft, setSalesComparisonDraft] = useState<AppraisalReportSalesDraft | null>(
    () => readAppraisalReportDraft(accountId || ""),
  );
  const marketWorkfileRevisionRef = useRef(0);
  const marketWorkfileSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const marketWorkfileSaveErrorRef = useRef<string | null>(null);
  const [workfileStatusMessage, setWorkfileStatusMessage] = useState("");
  const [sketchEvidenceRefreshing, setSketchEvidenceRefreshing] = useState(false);
  const sketchEvidenceRefreshInFlight = useRef(false);
  const {
    downloadInProgress,
    downloadCustomAppraisalFile,
    downloadCustomAppraisalPdf,
  } = useCustomAppraisalDownloads({
    accountId,
    getEditorKey: editorKeyForSave,
    setStatusMessage: setWorkfileStatusMessage,
  });
  const hydrateAssignmentDraft = useCallback((value: AssignmentDetails) => {
    const next = assignmentDraftFromDetail(value);
    setAssignmentDraft((current) => {
      if (!unemploymentLookupSucceeded.current) return next;
      const zipComparison = hasValue(current.neighborhood_unemployment_pct) ? {
        neighborhood_unemployment_pct: current.neighborhood_unemployment_pct,
        neighborhood_unemployment_zip: current.neighborhood_unemployment_zip,
        neighborhood_unemployment_source: current.neighborhood_unemployment_source,
        neighborhood_unemployment_dataset_year:
          current.neighborhood_unemployment_dataset_year,
        neighborhood_unemployment_variable: current.neighborhood_unemployment_variable,
      } : {};
      const cityComparison = hasValue(current.neighborhood_city_unemployment_pct) ? {
        neighborhood_city_unemployment_pct: current.neighborhood_city_unemployment_pct,
        neighborhood_city_unemployment_name: current.neighborhood_city_unemployment_name,
        neighborhood_city_unemployment_source:
          current.neighborhood_city_unemployment_source,
        neighborhood_city_unemployment_dataset_year:
          current.neighborhood_city_unemployment_dataset_year,
        neighborhood_city_unemployment_variable:
          current.neighborhood_city_unemployment_variable,
      } : {};
      return { ...next, ...zipComparison, ...cityComparison };
    });
  }, []);
  const {
    propertyContext,
    propertyContextLoading,
    propertyContextSaving,
    propertyContextMessage,
    propertyComplexityDraft,
    setPropertyComplexityDraft,
    propertyComplexityNotes,
    setPropertyComplexityNotes,
    loadAssessment: loadPropertyContextAssessment,
    analyzeCurrentPropertyContext: runPropertyContextAnalysis,
    saveCurrentPropertyComplexity: savePropertyComplexityReview,
  } = usePropertyContext({
    accountId,
    initialAssessment: detail?.property_context || null,
  });
  const handleSelectedAssignmentFile = useCallback(async (
    selectedFile: AppraisalAssignmentFile,
    isCancelled: () => boolean,
  ) => {
    if (!accountId) return;
    marketWorkfileSaveErrorRef.current = null;
    hydrateAssignmentDraft(selectedFile.assignment_details);
    try {
      const workfileResult = await loadCustomAppraisalWorkfile(accountId, selectedFile.id);
      if (isCancelled()) return;
      const marketSection = workfileResult.workfile.sections.market_conditions;
      const salesSection = workfileResult.workfile.sections.sales_comparison;
      marketWorkfileRevisionRef.current = Number(marketSection?.revision || 0);
      setMarketConditionsDraft(
        (marketSection?.value as MarketConditionsDraft | undefined) ||
          readMarketConditionsDraft(accountId),
      );
      setSalesComparisonDraft(
        (salesSection?.value as AppraisalReportSalesDraft | undefined) ||
          readAppraisalReportDraft(accountId),
      );
      setWorkfileStatusMessage(
        workfileResult.workfile.status === "signed"
          ? `Signed and locked: ${workfileResult.workfile.canonical_file_name}`
          : `Database workfile: ${workfileResult.workfile.canonical_file_name}`,
      );
    } catch (workfileError) {
      if (!isCancelled()) {
        setWorkfileStatusMessage(
          workfileError instanceof Error
            ? `Workfile could not be loaded: ${workfileError.message}`
            : "Workfile could not be loaded.",
        );
      }
    }
    void loadPropertyContextAssessment(selectedFile.id, isCancelled);
  }, [accountId, hydrateAssignmentDraft, loadPropertyContextAssessment]);
  const {
    assignmentFiles,
    setAssignmentFiles,
    assignmentFilesLoading,
    assignmentFilesLoaded,
    assignmentFilesError,
    activeAssignmentFile,
    setActiveAssignmentFile,
  } = useAssignmentFiles({
    accountId,
    enabled: Boolean(detail),
    requestedAssignmentFileId,
    onSelectedFile: handleSelectedAssignmentFile,
  });
  const {
    zoningEvidence,
    zoningEvidenceOpen,
    setZoningEvidenceOpen,
    zoningEvidenceLoading,
    zoningEvidenceMessage,
    zoningDraft,
    setZoningDraft,
    loadZoningEvidence,
    saveZoningEvidence,
    prefillVerbatimZoningDescription,
  } = useZoningEvidence({
    accountId,
    assignmentFileId: activeAssignmentFile?.id || null,
    enabled: Boolean(detail) && assignmentFilesLoaded,
    getEditorKey: editorKeyForSave,
    onCredentialRejected: forgetEditorCredential,
  });
  const photos = useMemo(
    () => (detail?.photos || []).filter((photo) => Boolean(photo?.trim())),
    [detail?.photos],
  );
  const customMarketStudy = useMemo(
    () => marketConditionsDraft?.response.analyses.find(
      (analysis) => analysis.market.key === "custom" && Boolean(analysis.market.custom_geometry),
    ) || null,
    [marketConditionsDraft],
  );
  const {
    profileLoading: neighborhoodProfileLoading,
    profileMessage: neighborhoodProfileMessage,
    boundarySuggestions: neighborhoodBoundarySuggestions,
    setBoundarySuggestions: setNeighborhoodBoundarySuggestions,
    refreshProfile: refreshNeighborhoodProfile,
    resetProfileTracking,
  } = useNeighborhoodProfile({
    accountId,
    assignmentDraft,
    setAssignmentDraft,
    setAssignmentDirty,
    customMarketStudy,
    marketConditionsDraft,
    detailCity: detail?.property_location?.city,
    sectionReady: neighborhoodSectionReady,
    assignmentFilesLoading,
    assignmentFilesLoaded,
  });
  const detailLoaded = Boolean(detail);
  const exactAddress = detail?.property_location?.address?.trim() || "";
  const {
    relatedParcels,
    relatedParcelsLoading,
    relatedParcelsError,
    refreshRelatedParcels,
  } = useRelatedParcels({
    accountId,
    address: exactAddress,
    enabled: detailLoaded,
  });


  useEffect(() => {
    if (photoIndex >= photos.length) setPhotoIndex(0);
  }, [photoIndex, photos.length]);

  useEffect(() => {
    if (unemploymentHydrationAccount.current !== (accountId || "")) {
      unemploymentHydrationAccount.current = accountId || "";
      unemploymentLookupSucceeded.current = false;
    }
    hydrateAssignmentDraft(assignmentDraftFromDetail());
    setAssignmentDirty(false);
    setAssignmentSaveMessage("");
    resetProfileTracking();
    marketWorkfileRevisionRef.current = 0;
    marketWorkfileSaveErrorRef.current = null;
    setWorkfileStatusMessage("");
    setMarketConditionsDraft(readMarketConditionsDraft(accountId || ""));
    setSalesComparisonDraft(readAppraisalReportDraft(accountId || ""));
  }, [accountId, detailLoaded, hydrateAssignmentDraft, resetProfileTracking]);

  const address = displayValue(detail?.property_location?.address, "Property address unavailable");
  const streetAddress = address.split(",")[0].trim() || address;
  const city = displayValue(detail?.property_location?.city);
  const state = displayValue(detail?.property_location?.state, "TX");
  const postalCode = displayValue(detail?.property_location?.postal_code);
  const documentReviewStreetAddress = String(detail?.property_location?.address || "").trim();
  const documentReviewSubjectAddress = documentReviewStreetAddress
    ? [
        documentReviewStreetAddress,
        detail?.property_location?.city,
        detail?.property_location?.state || "TX",
        detail?.property_location?.postal_code,
      ]
        .map((value) => String(value || "").trim())
        .filter(Boolean)
        .join(", ")
    : "";
  const censusZip = String(detail?.property_location?.postal_code || "")
    .replace(/\D/g, "")
    .slice(0, 5);
  const handleCensusProfilesLoaded = useCallback(({
    zipProfile,
    cityProfile,
  }: CensusProfilesLoaded) => {
    unemploymentLookupSucceeded.current = true;
    setAssignmentDraft((current) => ({
      ...current,
      ...(zipProfile ? {
        neighborhood_unemployment_pct: zipProfile.unemployment_percent,
        neighborhood_unemployment_zip: zipProfile.postal_code,
        neighborhood_unemployment_source: zipProfile.source,
        neighborhood_unemployment_dataset_year: zipProfile.dataset_year,
        neighborhood_unemployment_variable: zipProfile.variable,
      } : {}),
      ...(cityProfile ? {
        neighborhood_city_unemployment_pct: cityProfile.unemployment_percent,
        neighborhood_city_unemployment_name:
          cityProfile.geography_name || `${cityProfile.city}, ${cityProfile.state}`,
        neighborhood_city_unemployment_source: cityProfile.source,
        neighborhood_city_unemployment_dataset_year: cityProfile.dataset_year,
        neighborhood_city_unemployment_variable: cityProfile.variable,
      } : {}),
    }));
    setAssignmentDirty(true);
  }, []);
  const {
    censusLookupLoading,
    censusLookupMessage,
    lookupCensusTractNow: runCensusTractLookup,
    unemploymentLookupLoading,
    unemploymentLookupMessage,
    lookupUnemploymentComparison,
  } = useCensusProfile({
    accountId,
    censusZip,
    city,
    state,
    autoEnabled: neighborhoodSectionReady &&
      !assignmentFilesLoading &&
      assignmentFilesLoaded,
    hasExistingZipProfile: hasValue(assignmentDraft.neighborhood_unemployment_pct),
    hasExistingCityProfile: hasValue(assignmentDraft.neighborhood_city_unemployment_pct),
    onProfilesLoaded: handleCensusProfilesLoaded,
    onTractReload: onReload,
    onCredentialRejected: forgetEditorCredential,
  });
  const neighborhood = displayValue(detail?.property_location?.neighborhood);
  const subdivision = displayValue(detail?.property_location?.subdivision);
  const county = displayValue(detail?.property_location?.county);
  const ownerParties = (detail?.owner?.parties || []).filter((party) =>
    hasValue(party.owner_name),
  );
  const ownerName = displayValue(
    ownerParties.length
      ? ownerParties.map((party) => party.owner_name).join(" / ")
      : detail?.owner?.owner_name,
  );
  const ownerMailing = displayValue(detail?.owner?.mailing_address);
  const legalLines = detail?.legal_description?.lines?.filter((line) => Boolean(line?.trim())) || [];
  const legalDescription = legalLines.length
    ? legalLines.join("\n")
    : "No legal description is available for this parcel.";
  const deedTransferDate = detail?.legal_description?.deed_transfer_date;
  const assignmentPropertyCharacteristics = activeAssignmentFile
    ?.custom_appraisal_sections?.["report.property_characteristics"]?.value;
  const assignmentMainImprovement = assignmentPropertyCharacteristics?.main_improvement;
  const assignmentHousingProfile = assignmentPropertyCharacteristics?.housing_profile;
  const assignmentInspectionDetails = assignmentPropertyCharacteristics?.inspection_details;
  const improvement: DcadMainImprovement | undefined = detail?.main_improvement || assignmentMainImprovement
    ? mergeNonBlankSnapshot(
        detail?.main_improvement || {},
        assignmentMainImprovement,
      )
    : undefined;
  const housing: DcadHousingProfile | undefined = detail?.housing_profile || assignmentHousingProfile
    ? mergeNonBlankSnapshot(
        detail?.housing_profile || {},
        assignmentHousingProfile,
      )
    : undefined;
  const inspectionDetails = assignmentInspectionDetails && typeof assignmentInspectionDetails === "object" && !Array.isArray(assignmentInspectionDetails)
    ? assignmentInspectionDetails as Record<string, unknown>
    : {};
  const landRows = detail?.land_detail || [];
  const assignmentAdditionalImprovements = assignmentPropertyCharacteristics?.additional_improvements;
  const additionalImprovements = hasSnapshotValue(assignmentAdditionalImprovements)
    ? assignmentAdditionalImprovements as DcadImprovementRow[]
    : detail?.additional_improvements || [];
  const mobileInspectionPhotos = activeAssignmentFile?.mobile_inspection_photos || [];
  const mobileInspectionSketch = activeAssignmentFile?.mobile_inspection_sketch || null;
  const activeAssignmentFileId = activeAssignmentFile?.id || null;
  const handleAssignmentPhotosChanged = useCallback((photos: AssignmentPhoto[]) => {
    if (!activeAssignmentFileId) return;
    const verifiedMobilePhotos = photos
      .filter((photo) => photo.origin_channel === 'mobile' && photo.status === 'verified' && photo.verified_at)
      .map((photo) => ({
        id: photo.id,
        client_photo_id: photo.client_photo_id,
        origin_channel: photo.origin_channel,
        category: photo.category,
        room_ref: photo.room_ref,
        room_label: photo.room_label,
        caption: photo.caption,
        position: photo.position,
        captured_at: photo.captured_at,
        status: 'verified' as const,
        revision: photo.revision,
        verified_at: photo.verified_at as string,
        retention_until: photo.retention_until || '',
        required_retention_years: photo.required_retention_years,
        view_url: photo.view_url,
        view_url_expires_in_seconds: photo.view_url_expires_in_seconds,
      }));
    const mergePhotos = (file: AppraisalAssignmentFile): AppraisalAssignmentFile => ({
      ...file,
      mobile_inspection_photos: verifiedMobilePhotos,
    });
    setActiveAssignmentFile((current) => (
      current?.id === activeAssignmentFileId ? mergePhotos(current) : current
    ));
    setAssignmentFiles((current) => current.map((file) => (
      file.id === activeAssignmentFileId ? mergePhotos(file) : file
    )));
  }, [activeAssignmentFileId, setActiveAssignmentFile, setAssignmentFiles]);
  const refreshMobileSketchEvidence = useCallback(async () => {
    if (!accountId || !activeAssignmentFileId || sketchEvidenceRefreshInFlight.current) return;
    sketchEvidenceRefreshInFlight.current = true;
    setSketchEvidenceRefreshing(true);
    try {
      const response = await getAssignmentFiles(accountId);
      const refreshed = response.files.find((file) => file.id === activeAssignmentFileId);
      if (!refreshed) return;
      const mergeEvidence = (current: AppraisalAssignmentFile): AppraisalAssignmentFile => ({
        ...current,
        mobile_inspection_sketch: refreshed.mobile_inspection_sketch,
        mobile_inspection_photos: refreshed.mobile_inspection_photos,
      });
      setActiveAssignmentFile((current) => (
        current?.id === refreshed.id ? mergeEvidence(current) : current
      ));
      setAssignmentFiles((current) => current.map((file) => (
        file.id === refreshed.id ? mergeEvidence(file) : file
      )));
    } catch {
      // A background sync failure must never disturb the active report draft.
    } finally {
      sketchEvidenceRefreshInFlight.current = false;
      setSketchEvidenceRefreshing(false);
    }
  }, [accountId, activeAssignmentFileId, setActiveAssignmentFile, setAssignmentFiles]);

  const salesHistory = detail?.sales_history || [];
  const propertyActivityHistory = detail?.property_activity_history || salesHistory;
  const values = detail?.value_summary;
  const subjectGla = parseNumber(
    improvement?.living_area_sqft ??
    improvement?.total_living_area ??
    improvement?.total_area_sqft,
  );
  const reportedSubjectAge = parseNumber(improvement?.actual_age);
  const subjectYearBuilt = parseNumber(
    improvement?.effective_year_built ?? improvement?.year_built,
  );
  const subjectAge = reportedSubjectAge ?? (
    subjectYearBuilt !== null
      ? Math.max(0, new Date().getFullYear() - subjectYearBuilt)
      : null
  );
  const salesComparisonValue = parseNumber(
    salesComparisonDraft?.opinionAfterCostToCure ?? salesComparisonDraft?.opinionOfValue,
  );
  const salesComparisonValueSource = salesComparisonDraft?.opinionAfterCostToCure !== null &&
    salesComparisonDraft?.opinionAfterCostToCure !== undefined
    ? "Sales Comparison Approach after cost to cure"
    : salesComparisonDraft?.opinionOfValue !== null && salesComparisonDraft?.opinionOfValue !== undefined
      ? "Sales Comparison Approach"
      : "";

  const editableSectionValue = (sectionKey: ReportManualSectionKey): Record<string, unknown> => {
    switch (sectionKey) {
      case "report.subject_identification":
        return {
          property_location: {
            address: detail?.property_location?.address || "",
            neighborhood: detail?.property_location?.neighborhood || "",
            city: detail?.property_location?.city || "",
            state: detail?.property_location?.state || "TX",
            postal_code: detail?.property_location?.postal_code || "",
            county: detail?.property_location?.county || "",
            subdivision: detail?.property_location?.subdivision || "",
            census_tract: detail?.property_location?.census_tract || "",
          },
          owner: {
            owner_name: detail?.owner?.owner_name || "",
            mailing_address: detail?.owner?.mailing_address || "",
            parties: cloneEditorValue(detail?.owner?.parties || []),
          },
          legal_description: {
            lines: detail?.legal_description?.lines || [],
            deed_transfer_date: detail?.legal_description?.deed_transfer_date || "",
          },
        };
      case "report.exemptions":
        {
          const emptyExemption = () => ({
            taxing_jurisdiction: "",
            homestead_exemption: "",
            disabled_vet: "",
            taxable_value: "",
          });
        return {
          homestead_yes: Boolean(detail?.homestead_yes),
          exemptions: {
            city: cloneEditorValue(detail?.exemptions?.city || emptyExemption()),
            school: cloneEditorValue(detail?.exemptions?.school || emptyExemption()),
            county: cloneEditorValue(detail?.exemptions?.county || emptyExemption()),
            college: cloneEditorValue(detail?.exemptions?.college || emptyExemption()),
            hospital: cloneEditorValue(detail?.exemptions?.hospital || emptyExemption()),
            special_district: cloneEditorValue(
              detail?.exemptions?.special_district || emptyExemption(),
            ),
          },
        };
        }
      case "report.sales_history":
        return {
          property_activity_history: cloneEditorValue(
            detail?.property_activity_history || detail?.sales_history || [],
          ),
        };
      case "report.property_characteristics":
        return {
          main_improvement: {
            living_area_sqft: improvement?.living_area_sqft || "",
            total_area_sqft: improvement?.total_area_sqft || "",
            bedroom_count: improvement?.bedroom_count || "",
            bath_count: improvement?.bath_count || "",
            baths_full: improvement?.baths_full || "",
            baths_half: improvement?.baths_half || "",
            stories: improvement?.stories || "",
            year_built: improvement?.year_built || "",
            effective_year_built: improvement?.effective_year_built || "",
            actual_age: improvement?.actual_age || "",
            building_class: improvement?.building_class || "",
            desirability: improvement?.desirability || "",
            construction_type: improvement?.construction_type || "",
            foundation: improvement?.foundation || "",
            exterior_material: improvement?.exterior_material || "",
            roof_type: improvement?.roof_type || "",
            roof_material: improvement?.roof_material || "",
            heating: improvement?.heating || "",
            air_conditioning: improvement?.air_conditioning || "",
            fireplaces: improvement?.fireplaces || "",
            kitchens: improvement?.kitchens || "",
            wetbars: improvement?.wetbars || "",
            pool: improvement?.pool ?? "",
            sprinkler: improvement?.sprinkler ?? "",
            fence_type: improvement?.fence_type || "",
          },
          housing_profile: {
            structural_style: housing?.structural_style || "",
            housing_type: housing?.housing_type || "",
            attachment_type: housing?.attachment_type || "unknown",
            architectural_style: housing?.architectural_style || "",
          },
          inspection_details: cloneEditorValue(inspectionDetails),
          additional_improvements: cloneEditorValue(additionalImprovements),
        };
      case "report.land_details":
        return { land_detail: cloneEditorValue(detail?.land_detail || []) };
      case "report.appraisal_values":
        return {
          value_summary: {
            certified_year: detail?.value_summary?.certified_year || "",
            market_value: detail?.value_summary?.market_value || "",
            capped_value: detail?.value_summary?.capped_value || "",
            improvement_value: detail?.value_summary?.improvement_value || "",
            land_value: detail?.value_summary?.land_value || "",
          },
        };
      case "report.assignment_details":
        return {
          pud: Boolean(detail?.assignment_details?.pud),
          hoa_dues_amount: detail?.assignment_details?.hoa_dues_amount || "",
          hoa_frequency: detail?.assignment_details?.hoa_frequency || "",
          hoa_explanation: detail?.assignment_details?.hoa_explanation || "",
          occupancy: detail?.assignment_details?.occupancy || "",
          occupancy_explanation: detail?.assignment_details?.occupancy_explanation || "",
          assignment_types: cloneEditorValue(detail?.assignment_details?.assignment_types || []),
          assignment_explanation: detail?.assignment_details?.assignment_explanation || "",
          lender_client_name: detail?.assignment_details?.lender_client_name || "",
          lender_client_address: detail?.assignment_details?.lender_client_address || "",
          subject_under_contract: Boolean(detail?.assignment_details?.subject_under_contract),
          contract_arms_length: typeof detail?.assignment_details?.contract_arms_length === "boolean"
            ? detail.assignment_details.contract_arms_length
            : true,
          contract_seller_names: detail?.assignment_details?.contract_seller_names || "",
          contract_price: detail?.assignment_details?.contract_price || "",
          contract_date: detail?.assignment_details?.contract_date || "",
          loan_amount: detail?.assignment_details?.loan_amount || "",
          down_payment: detail?.assignment_details?.down_payment || "",
          earnest_money: detail?.assignment_details?.earnest_money || "",
          seller_concessions: detail?.assignment_details?.seller_concessions || "",
          seller_matches_public_records:
            typeof detail?.assignment_details?.seller_matches_public_records === "boolean"
              ? detail.assignment_details.seller_matches_public_records
              : null,
          seller_mismatch_explanation:
            detail?.assignment_details?.seller_mismatch_explanation || "",
        };
    }
  };


  const lookUpCensusTractNow = async () => {
    if (!accountId || censusLookupLoading) return;
    const editorKey = editorKeyForSave();
    if (!editorKey) return;
    await runCensusTractLookup(editorKey);
  };

  const updateAssignment = <K extends keyof AssignmentDetails,>(
    key: K,
    value: AssignmentDetails[K],
  ) => {
    setAssignmentDraft((current) => ({ ...current, [key]: value }));
    setAssignmentDirty(true);
    setAssignmentSaveMessage("");
  };

  const updateMarketConditions = (draft: MarketConditionsDraft | null) => {
    setMarketConditionsDraft(draft);
    if (!draft) return;
    if (accountId && activeAssignmentFile) {
      const editorKey = editorKeyForSave();
      if (editorKey) {
        marketWorkfileSaveErrorRef.current = null;
        setWorkfileStatusMessage(`Saving market study to ${activeAssignmentFile.file_number}...`);
        marketWorkfileSaveQueueRef.current = marketWorkfileSaveQueueRef.current
          .catch(() => undefined)
          .then(async () => {
            const response = await saveCustomAppraisalWorkfileSection(
              accountId,
              activeAssignmentFile.id,
              "market_conditions",
              {
                value: draft,
                expected_revision: marketWorkfileRevisionRef.current,
                save_reason: marketWorkfileRevisionRef.current === 0
                  ? "legacy_import"
                  : "manual_save",
                reviewer: "HomeNode market conditions",
              },
              editorKey,
            );
            marketWorkfileRevisionRef.current = response.section.revision;
            marketWorkfileSaveErrorRef.current = null;
            setWorkfileStatusMessage(
              `Market study saved to ${activeAssignmentFile.workfile?.canonical_file_name || activeAssignmentFile.file_number}.`,
            );
          })
          .catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            const saveError =
              /custom_appraisal_workfile_signed/i.test(message)
                ? "This appraisal is signed and locked. Start another file to change its market study."
                : `Market study save needs attention: ${message}`;
            marketWorkfileSaveErrorRef.current = saveError;
            setWorkfileStatusMessage(saveError);
          });
      }
    }
    const medianDom = reconciledMedianDaysOnMarket(draft.response);
    const marketChange = draft.response.recommendation.recommended_change_percent;
    const marketTrend = marketTrendFromRecommendation(draft.response.recommendation.conclusion);
    const marketingTime = marketingTimeFromMedianDom(medianDom);
    setAssignmentDraft((current) => {
      const growth = growthFromMarket(
        marketChange,
        medianDom,
        (current.neighborhood_location_type || "") as NeighborhoodLocationType,
      );
      return {
        ...current,
        ...(marketTrend ? { neighborhood_market_trend: marketTrend } : {}),
        ...(marketingTime ? { neighborhood_marketing_time: marketingTime } : {}),
        ...(growth ? { neighborhood_growth: growth } : {}),
        neighborhood_market_change_pct: marketChange ?? "",
        neighborhood_median_dom: medianDom ?? "",
      };
    });
    setAssignmentDirty(true);
    setAssignmentSaveMessage("");
  };

  const updateSubjectConformity = (value: boolean | null) => {
    setAssignmentDraft((current) => ({
      ...current,
      subject_conforms_to_neighborhood: value,
      ...(value === false
        ? {}
        : {
            subject_nonconformity_type: "",
            subject_nonconformity_explanation: "",
          }),
    }));
    setAssignmentDirty(true);
    setAssignmentSaveMessage("");
  };

  const updateAssignmentTypes = (nextTypes: string[]) => {
    setAssignmentDraft((current) => ({
      ...current,
      assignment_types: nextTypes,
      subject_under_contract: nextTypes.includes("purchase_transaction")
        ? current.subject_under_contract
        : false,
    }));
    setAssignmentDirty(true);
    setAssignmentSaveMessage("");
  };

  const applyConfirmedDocumentCandidate = useCallback((
    fieldKey: string,
    value: string,
    documentType: AssignmentDocumentType,
  ) => {
    if (fieldKey === "assignment_type") {
      const supportedTypes = new Set([
        "purchase_transaction",
        "refinance",
        "heloc",
        "rtl",
        "rehab",
        "bridge_loan",
        "new_construction",
        "dscr",
      ]);
      if (!supportedTypes.has(value)) {
        setAssignmentSaveMessage("The confirmed assignment type remains attached as page-cited evidence for manual review.");
        return;
      }
      setAssignmentDraft((current) => {
        return {
          ...current,
          assignment_types: assignmentTypesFromConfirmedDocument(
            current.assignment_types,
            value,
            documentType,
          ),
          subject_under_contract: subjectUnderContractFromConfirmedDocument(
            current.subject_under_contract,
            value,
            documentType,
          ),
        };
      });
      setAssignmentDirty(true);
      setAssignmentSaveMessage(
        "Confirmed document evidence prefills the assignment type. Save Assignment Details to retain it.",
      );
      return;
    }
    const assignmentFieldByCandidate: Record<string, keyof AssignmentDetails> = {
      lender_client_name: "lender_client_name",
      lender_client_address: "lender_client_address",
      contract_price: "contract_price",
      contract_date: "contract_date",
      loan_amount: "loan_amount",
      down_payment: "down_payment",
      earnest_money: "earnest_money",
      seller_concessions: "seller_concessions",
      seller_name: "contract_seller_names",
    };
    const assignmentField = assignmentFieldByCandidate[fieldKey];
    if (!assignmentField) {
      setAssignmentSaveMessage("The confirmed document field remains attached as page-cited evidence.");
      return;
    }
    setAssignmentDraft((current) => {
      const next: AssignmentDetails = { ...current, [assignmentField]: value };
      if (documentType === "purchase_contract") {
        const types = new Set(current.assignment_types || []);
        types.add("purchase_transaction");
        next.assignment_types = Array.from(types);
        next.subject_under_contract = true;
      }
      return next;
    });
    setAssignmentDirty(true);
    setAssignmentSaveMessage(
      "Confirmed document evidence prefills this assignment. Save Assignment Details to retain it.",
    );
  }, []);

  const importCustomMarketArea = useCallback(() => {
    const geometry = customMarketStudy?.market.custom_geometry;
    if (!geometry) {
      setAssignmentSaveMessage("Run and save an Appraiser-Defined Area in the Market Conditions Analysis below first.");
      return;
    }
    const summary = customMarketStudy.summary;
    setNeighborhoodBoundarySuggestions(null);
    setAssignmentDraft((current) => ({
      ...current,
      neighborhood_boundary_geometry: cloneEditorValue(geometry),
      neighborhood_boundary_label:
        customMarketStudy.market.label || "Appraiser-defined market area",
      neighborhood_boundary_source: "sales_comparison_market_conditions",
      neighborhood_boundary_saved_at: marketConditionsDraft?.savedAt || new Date().toISOString(),
      neighborhood_boundary_streets: "",
      neighborhood_boundary_north: "",
      neighborhood_boundary_east: "",
      neighborhood_boundary_south: "",
      neighborhood_boundary_west: "",
      neighborhood_boundary_exclusions: DEFAULT_NEIGHBORHOOD_BOUNDARY_NARRATIVE,
      neighborhood_boundary_streets_source: "",
      neighborhood_boundary_streets_retrieved_at: "",
      neighborhood_boundary_confirmed: false,
      neighborhood_boundary_confirmed_at: "",
      neighborhood_house_price_low: summary.minimum_sale_price ?? "",
      neighborhood_house_price_high: summary.maximum_sale_price ?? "",
      neighborhood_house_price_predominant: summary.median_sale_price ?? "",
      neighborhood_ppsf_low: summary.minimum_price_per_square_foot ?? "",
      neighborhood_ppsf_high: summary.maximum_price_per_square_foot ?? "",
      neighborhood_ppsf_predominant: summary.median_price_per_square_foot ?? "",
      neighborhood_age_low: summary.minimum_age ?? "",
      neighborhood_age_high: summary.maximum_age ?? "",
      neighborhood_age_predominant: summary.median_age ?? "",
      neighborhood_gla_low: summary.minimum_living_area ?? "",
      neighborhood_gla_high: summary.maximum_living_area ?? "",
      neighborhood_gla_predominant: summary.median_living_area ?? "",
      neighborhood_market_trend:
        marketTrendFromChange(customMarketStudy.statistics.annualized_change_percent) ||
        current.neighborhood_market_trend || "",
    }));
    setAssignmentDirty(true);
    setAssignmentSaveMessage("Appraiser-defined area imported. Review and confirm it for this file.");
  }, [customMarketStudy, marketConditionsDraft?.savedAt, setNeighborhoodBoundarySuggestions]);

  const confirmNeighborhoodBoundary = (checked: boolean) => {
    setAssignmentDraft((current) => ({
      ...current,
      neighborhood_boundary_confirmed: checked,
      neighborhood_boundary_confirmed_at: checked ? new Date().toISOString() : "",
    }));
    setAssignmentDirty(true);
    setAssignmentSaveMessage("");
    const assessmentId = Number(assignmentDraft.neighborhood_boundary_engine_assessment_id);
    const boundaryAssignmentFileId = Number(
      assignmentDraft.neighborhood_boundary_engine_assignment_file_id,
    );
    if (accountId && Number.isSafeInteger(assessmentId) && assessmentId > 0) {
      void saveNeighborhoodBoundaryReview(accountId, assessmentId, {
        assignmentFileId: Number.isSafeInteger(boundaryAssignmentFileId) &&
          boundaryAssignmentFileId > 0
          ? boundaryAssignmentFileId
          : null,
        confirmed: checked,
      }).catch((error) => {
        setAssignmentSaveMessage(
          error instanceof Error
            ? `Boundary confirmation needs to be retried: ${error.message}`
            : "Boundary confirmation needs to be retried.",
        );
      });
    }
  };

  useEffect(() => {
    const geometry = customMarketStudy?.market.custom_geometry;
    if (!geometry || assignmentFilesLoading || !assignmentFilesLoaded) return;
    const boundarySource = String(
      assignmentDraft.neighborhood_boundary_source || "",
    ).toLowerCase();
    if (
      /^neighborhood_boundary_engine_v\d+$/i.test(boundarySource) ||
      boundarySource.includes("appraiser") ||
      boundarySource.includes("sales_comparison_market_conditions") ||
      boundarySource.includes("cleared") ||
      assignmentDraft.neighborhood_boundary_geometry
    ) return;
    if (JSON.stringify(assignmentDraft.neighborhood_boundary_geometry) === JSON.stringify(geometry)) return;
    importCustomMarketArea();
  }, [
    assignmentDraft.neighborhood_boundary_geometry,
    assignmentDraft.neighborhood_boundary_source,
    assignmentFilesLoading,
    assignmentFilesLoaded,
    customMarketStudy,
    importCustomMarketArea,
  ]);

  const saveAssignmentDetails = async ({
    requireCompletion = true,
  }: { requireCompletion?: boolean } = {}): Promise<boolean> => {
    if (requireCompletion) {
      const validationErrors = assignmentValidationErrors(assignmentDraft);
      if (validationErrors.length) {
        setAssignmentSaveMessage(`Resolve before saving: ${validationErrors.join(" ")}`);
        return false;
      }
    }
    if (!accountId || !activeAssignmentFile) {
      setAssignmentSaveMessage("Enter a file number and choose Save New File first.");
      return false;
    }
    const editorKey = editorKeyForSave();
    if (!editorKey) return false;
    setSavingAssignmentFile(true);
    try {
      const response = await updateAssignmentFile(
        accountId,
        activeAssignmentFile.id,
        {
          assignment_details: cloneEditorValue(assignmentDraft),
          expected_revision: activeAssignmentFile.revision,
        },
        editorKey,
      );
      const updatedFile = {
        ...response.assignment_file,
        custom_appraisal_sections: activeAssignmentFile.custom_appraisal_sections,
        mobile_inspection_sketch: activeAssignmentFile.mobile_inspection_sketch,
        mobile_inspection_photos: activeAssignmentFile.mobile_inspection_photos,
      };
      setActiveAssignmentFile(updatedFile);
      setAssignmentFiles((current) => current.map((file) =>
        file.id === updatedFile.id ? updatedFile : file
      ));
      setAssignmentDirty(false);
      const savedTime = new Date(response.assignment_file.updated_at || Date.now())
        .toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      setAssignmentSaveMessage(`Changes saved to file ${response.assignment_file.file_number} at ${savedTime}.`);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "The assignment file could not be saved.";
      if (/401|invalid_editor_key/i.test(message)) {
        forgetEditorCredential();
      }
      setAssignmentSaveMessage(
        message === "assignment_file_revision_conflict"
          ? "This file changed elsewhere. Reload the report before saving again."
          : message,
      );
      return false;
    } finally {
      setSavingAssignmentFile(false);
    }
  };

  const saveAssignmentFromSection = async (): Promise<boolean> => {
    const validationErrors = assignmentValidationErrors(assignmentDraft);
    if (validationErrors.length) {
      setAssignmentSaveMessage(`Resolve before saving: ${validationErrors.join(" ")}`);
      return false;
    }
    if (!activeAssignmentFile) {
      setAssignmentSaveMessage("Choose or start an assignment file before saving.");
      setAssignmentChooserOpen(true);
      return false;
    }
    return saveAssignmentDetails();
  };

  const saveCustomAppraisalNow = async () => {
    if (savingAssignmentFile) return;
    if (!activeAssignmentFile) {
      setAssignmentSaveMessage("Choose or start an assignment file before saving.");
      setAssignmentChooserOpen(true);
      return;
    }
    if (activeAssignmentFile.workfile?.status === "signed") {
      setAssignmentSaveMessage("This signed appraisal is locked. Start another file to make changes.");
      return;
    }
    setAssignmentSaveMessage("Saving all current changes…");
    await marketWorkfileSaveQueueRef.current;
    const marketSaveError = marketWorkfileSaveErrorRef.current;
    if (assignmentDirty) {
      // A top-level Save protects a valid draft even when the appraiser has
      // not completed every field required for final section review.
      const assignmentSaved = await saveAssignmentDetails({ requireCompletion: false });
      if (assignmentSaved && marketSaveError) {
        setAssignmentSaveMessage(`Shared report changes were saved, but ${marketSaveError}`);
      }
      return;
    }
    if (marketSaveError) {
      setAssignmentSaveMessage(marketSaveError);
      return;
    }
    const confirmedAt = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    setAssignmentSaveMessage(`All current changes are saved at ${confirmedAt}.`);
  };

  const analyzeCurrentPropertyContext = () => runPropertyContextAnalysis({
    assignmentFileId: activeAssignmentFile?.id || null,
    customGeometry: assignmentDraft.neighborhood_boundary_geometry ||
      customMarketStudy?.market.custom_geometry || null,
    geography: assignmentDraft.neighborhood_location_type || null,
  });

  const saveCurrentPropertyComplexity = () => savePropertyComplexityReview({
    assignmentFileId: activeAssignmentFile?.id || null,
  });

  const recordLenderRevisionRequest = async () => {
    if (!accountId || !activeAssignmentFile) return;
    const note = window.prompt(
      "Record a lender/client-requested appraisal revision. Add an optional note, or choose Cancel.",
      "",
    );
    if (note === null) return;
    const editorKey = editorKeyForSave();
    if (!editorKey) return;
    const nextRevisionCount = Math.max(
      0,
      Number(assignmentDraft.lender_revision_count) || 0,
    ) + 1;
    const updatedDetails: AssignmentDetails = {
      ...cloneEditorValue(assignmentDraft),
      lender_revision_count: nextRevisionCount,
      lender_revision_last_requested_at: new Date().toISOString(),
      lender_revision_note: note.trim(),
    };
    setSavingAssignmentFile(true);
    try {
      const response = await updateAssignmentFile(
        accountId,
        activeAssignmentFile.id,
        {
          assignment_details: updatedDetails,
          expected_revision: activeAssignmentFile.revision,
        },
        editorKey,
      );
      const updatedFile = {
        ...response.assignment_file,
        custom_appraisal_sections: activeAssignmentFile.custom_appraisal_sections,
        mobile_inspection_sketch: activeAssignmentFile.mobile_inspection_sketch,
        mobile_inspection_photos: activeAssignmentFile.mobile_inspection_photos,
      };
      setAssignmentDraft(assignmentDraftFromDetail(updatedFile.assignment_details));
      setActiveAssignmentFile(updatedFile);
      setAssignmentFiles((current) => current.map((file) =>
        file.id === updatedFile.id ? updatedFile : file
      ));
      setAssignmentDirty(false);
      setAssignmentSaveMessage(
        `Recorded lender/client revision request ${nextRevisionCount} for file ${response.assignment_file.file_number}.`,
      );
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : "The lender/client revision request could not be recorded.";
      if (/401|invalid_editor_key/i.test(message)) {
        forgetEditorCredential();
      }
      setAssignmentSaveMessage(
        message === "assignment_file_revision_conflict"
          ? "This file changed elsewhere. Reload the report before recording the revision request."
          : message,
      );
    } finally {
      setSavingAssignmentFile(false);
    }
  };

  const finalizeCustomAppraisalFile = async () => {
    if (!accountId || !activeAssignmentFile) return;
    const localBlockers = [
      ...assignmentValidationErrors(assignmentDraft),
      ...neighborhoodBoundaryReadinessErrors(assignmentDraft),
      ...(salesComparisonDraft?.comparables?.length
        ? []
        : ["Complete and save the Sales Comparison Approach before finalizing."]),
      ...((Number(salesComparisonDraft?.opinionOfValue) || 0) > 0
        ? []
        : ["Reconcile a positive Sales Comparison Approach value before finalizing."]),
      ...(marketConditionsDraft?.response?.analyses?.length
        ? []
        : ["Complete and save at least one Market Conditions study before finalizing."]),
      ...(assignmentDirty ? ["Save the current Property Report changes before finalizing."] : []),
    ];
    if (localBlockers.length) {
      setAssignmentSaveMessage(`Cannot finalize yet: ${localBlockers.join(" ")}`);
      return;
    }
    const editorKey = editorKeyForSave();
    if (!editorKey) return;
    setSavingAssignmentFile(true);
    try {
      await marketWorkfileSaveQueueRef.current;
      setWorkfileStatusMessage("Running final E&O and source-data readiness checks...");
      const preflight = await getCustomAppraisalWorkfileReadiness(
        accountId,
        activeAssignmentFile.id,
        editorKey,
      );
      if (!preflight.readiness.ready) {
        setAssignmentSaveMessage(
          `Cannot finalize yet: ${preflight.readiness.blocker_messages.join(" ")}`,
        );
        setWorkfileStatusMessage("Final E&O review found required corrections.");
        return;
      }
      const warningCodes = preflight.readiness.warning_codes;
      if (preflight.readiness.warnings.length) {
        const warningAccepted = window.confirm(
          `E&O review found ${preflight.readiness.warnings.length} item${preflight.readiness.warnings.length === 1 ? "" : "s"} requiring appraiser acknowledgment:\n\n${preflight.readiness.warning_messages.join("\n\n")}\n\nContinue only if you reviewed and accept these items for this appraisal file.`,
        );
        if (!warningAccepted) {
          setWorkfileStatusMessage("Finalization paused for source-data review.");
          return;
        }
      }
      const confirmed = window.confirm(
        `Finalize and lock ${activeAssignmentFile.file_number}? This creates the immutable signed snapshot. Future changes must be made in a new appraisal file.`,
      );
      if (!confirmed) return;
      const signedBy = window.prompt(
        "Enter the appraiser name that is signing/finalizing this file:",
        activeAssignmentFile.reviewer || "",
      )?.trim();
      if (!signedBy) return;
      const response = await signCustomAppraisalWorkfile(
        accountId,
        activeAssignmentFile.id,
        {
          signed_by: signedBy,
          acknowledged_warning_codes: warningCodes,
        },
        editorKey,
      );
      const workfile = response.workfile;
      const updatedFile: AppraisalAssignmentFile = {
        ...activeAssignmentFile,
        workfile: {
          key: workfile.workfile_key,
          canonical_file_name: workfile.canonical_file_name,
          status: workfile.status,
          signed_at: workfile.signed_at,
          signed_by: workfile.signed_by,
          updated_at: workfile.updated_at,
        },
      };
      setActiveAssignmentFile(updatedFile);
      setAssignmentFiles((current) => current.map((file) =>
        file.id === updatedFile.id ? updatedFile : file
      ));
      setWorkfileStatusMessage(
        `Signed and locked: ${workfile.canonical_file_name} · SHA-256 ${workfile.checksum_sha256 || "recorded"}`,
      );
      setAssignmentSaveMessage(
        `Finalized ${activeAssignmentFile.file_number}. The signed snapshot is immutable.`,
      );
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : "The appraisal file could not be finalized.";
      setAssignmentSaveMessage(
        message === "custom_appraisal_eo_warnings_unacknowledged"
          ? "Finalization stopped because the source-data warnings changed after preflight. Run Finalize & Lock again to review the current warnings."
          : message === "custom_appraisal_eo_incomplete"
            ? "Finalization stopped because a required E&O item changed after preflight. Run Finalize & Lock again to see the current blockers."
            : message,
      );
    } finally {
      setSavingAssignmentFile(false);
    }
  };

  const sectionEditProps = (key: ReportManualSectionKey) => ({
    onEdit: () => editSection(key),
    manuallyVerified: Boolean(detail?.report_manual_values?.[key]),
  });

  const exemptionOrder: Array<[keyof DcadExemptionsMap, string]> = [
    ["city", "City"],
    ["school", "School"],
    ["county", "County"],
    ["college", "College"],
    ["hospital", "Hospital"],
    ["special_district", "Special District"],
  ];
  const exemptionRows = exemptionOrder
    .map(([key, fallbackLabel]) => ({
      key,
      fallbackLabel,
      row: detail?.exemptions?.[key],
    }))
    .filter(({ row }) =>
      Boolean(row && Object.values(row).some((value) => hasValue(value))),
    );
  const exemptJurisdictionCount = exemptionRows.filter(
    ({ row }) => (parseNumber(row?.homestead_exemption) || 0) > 0,
  ).length;
  const homestead = detail?.homestead_yes || exemptJurisdictionCount > 0;
  const assignmentTypes = assignmentDraft.assignment_types || [];
  const assignmentTypeLabels = assignmentTypes.map((value) =>
    ASSIGNMENT_TYPE_OPTIONS.find(([option]) => option === value)?.[1] ||
      value.replaceAll("_", " "),
  );
  const purchaseTransactionSelected = assignmentTypes.includes("purchase_transaction");
  const assignmentErrors = assignmentValidationErrors(assignmentDraft);
  const listingRows = listingTimelineRows(propertyActivityHistory);
  const salesHistoryRows = propertyActivityHistory.filter((event) => {
    const recordType = String(event.record_type || "");
    return ["closed_sale", "cad_transfer"].includes(recordType) ||
      (!recordType && (hasValue(event.sale_price) || hasValue(event.closing_date) || hasValue(event.activity_date)));
  });
  const contractSellerComparison = sellerComparisonSummary(
    assignmentDraft.contract_seller_names,
    ownerName,
  );
  const assignmentSaveDisabled = Boolean(
    assignmentFilesLoading || savingAssignmentFile || !assignmentDirty ||
      activeAssignmentFile?.workfile?.status === "signed",
  );
  const priorAssignmentFiles = activeAssignmentFile
    ? assignmentFiles.filter((file) => file.id !== activeAssignmentFile.id)
    : assignmentFiles;
  const hasPriorAssignmentFiles = priorAssignmentFiles.length > 0;
  const neighborhoodBoundaryErrors = neighborhoodBoundaryReadinessErrors(assignmentDraft);
  const appraisalReportAssignmentFile = activeAssignmentFile;
  const relatedParcelsToShow = (relatedParcels?.parcels || []).filter(
    (parcel) => parcel.is_subject || parcel.materially_different,
  );
  const showRelatedParcelCheck = Boolean(
    relatedParcels?.material_difference_found,
  );

  const primaryZoning =
    zoningEvidence?.verification?.zoning_code ||
    zoningEvidence?.automatic_result?.zoning_code ||
    zoningEvidence?.suggested_result?.zoning_code ||
    landRows.map((row) => row.zoning).find((value) => hasValue(value)) ||
    "Not reported";
  const primaryZoningDescription =
    zoningEvidence?.verification?.zoning_description ||
    zoningEvidence?.automatic_result?.zoning_description ||
    zoningEvidence?.suggested_result?.zoning_description ||
    null;
  const primaryZoningDisplay = primaryZoningDescription &&
      String(primaryZoningDescription).trim().toLowerCase() !== String(primaryZoning).trim().toLowerCase()
    ? `${primaryZoning} — ${primaryZoningDescription}`
    : primaryZoning;
  const selectedZoningDocument = zoningEvidence?.documents.find(
    (document) => String(document.id) === zoningDraft.sourceDocumentId,
  ) || zoningEvidence?.documents[0] || null;

  const protestUrl = accountId
    ? `/PropertyTaxProtest?propertyId=${encodeURIComponent(accountId)}${
        hasValue(detail?.owner?.owner_name)
          ? `&ownerName=${encodeURIComponent(String(detail?.owner?.owner_name))}`
          : ""
        }`
    : "/PropertyTaxProtest";

  const canSlide = photos.length > 1;
  const showPreviousPhoto = () =>
    setPhotoIndex((current) => (current - 1 + photos.length) % photos.length);
  const showNextPhoto = () =>
    setPhotoIndex((current) => (current + 1) % photos.length);

  return (
    <div
      className="hn-custom-report card overflow-hidden rounded-2xl border"
      style={{ backgroundColor: "#ffffff" }}
    >
      <section className="hn-custom-report-toolbar border-b px-4 py-3 sm:px-6">
        <div className="flex min-h-[52px] flex-col gap-2 sm:flex-row sm:items-end sm:justify-end">
          {activeAssignmentFile ? (
            <span className="hn-custom-file-status mb-1 rounded-full px-2 py-0.5 text-xs font-semibold">
              {activeAssignmentFile.workfile?.status === "signed" ? "Signed file" : "Active file"}{" "}
              {activeAssignmentFile.file_number}
            </span>
          ) : null}
          <button
            aria-label="Save current Custom Appraisal changes now"
            type="button"
            className="hn-action-primary btn btn-sm normal-case rounded-lg shadow-sm"
            onClick={() => void saveCustomAppraisalNow()}
            disabled={assignmentFilesLoading || savingAssignmentFile || activeAssignmentFile?.workfile?.status === "signed"}
          >
            {savingAssignmentFile ? "Saving…" : assignmentDirty ? "Save changes" : "Save"}
          </button>
          <button
            type="button"
            className="hn-action-gold btn btn-outline btn-sm normal-case rounded-lg shadow-sm"
            onClick={() => setAssignmentChooserOpen(true)}
            disabled={assignmentFilesLoading || savingAssignmentFile}
          >
            {activeAssignmentFile ? "Choose or Start Another File" : "Choose or Start Assignment"}
          </button>
        </div>
        <p
          className="mt-2 min-h-4 break-words text-right text-[11px] font-medium leading-4 text-violet-100"
          aria-live="polite"
        >
          {assignmentSaveMessage || workfileStatusMessage || "\u00a0"}
        </p>

        <details className={`mt-3 rounded-xl border px-3 py-2 ${
          hasPriorAssignmentFiles
            ? "border-red-300 bg-red-50"
            : "border-slate-200 bg-white"
        }`}>
          <summary className={`cursor-pointer text-xs font-semibold ${
            hasPriorAssignmentFiles ? "text-red-800" : "text-slate-700"
          }`}>
            Assignment Log ({assignmentFiles.length})
            {hasPriorAssignmentFiles ? " - prior appraisal service found" : ""}
          </summary>
          <div className={`mt-2 max-h-52 space-y-2 overflow-y-auto border-t pt-2 ${
            hasPriorAssignmentFiles ? "border-red-200" : "border-slate-100"
          }`}>
            {assignmentFilesLoading ? (
              <p className="text-xs text-slate-500">Loading prior assignment files...</p>
            ) : assignmentFilesError ? (
              <p className="text-xs text-rose-700">{assignmentFilesError}</p>
            ) : assignmentFiles.length ? (
              assignmentFiles.map((file) => {
                const lenderRevisionCount = Math.max(
                  0,
                  Number(file.assignment_details.lender_revision_count) || 0,
                );
                const isActiveFile = file.id === activeAssignmentFile?.id;
                return (
                  <div
                    key={file.id}
                    className={`flex flex-col gap-2 rounded-lg border px-3 py-2 sm:flex-row sm:items-center sm:justify-between ${
                      isActiveFile
                        ? "hn-custom-selection"
                        : "border-slate-200 bg-white"
                    }`}
                  >
                    <div className="min-w-0 text-xs text-slate-600">
                      <span className="font-semibold text-slate-900">{file.file_number}</span>
                      {isActiveFile ? (
                        <span className="hn-custom-verified ml-2 rounded-full px-2 py-0.5 font-semibold">
                          Current
                        </span>
                      ) : null}
                      {file.workfile?.status === "signed" ? (
                        <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 font-semibold text-amber-900">
                          Signed &amp; locked
                        </span>
                      ) : null}
                      <span className="mx-2 text-slate-300">|</span>
                      Created {formatDate(file.created_at)}
                      <span className="mx-2 text-slate-300">|</span>
                      {lenderRevisionCount} lender/client-requested {lenderRevisionCount === 1 ? "revision" : "revisions"}
                      {file.assignment_details.lender_revision_last_requested_at ? (
                        <span className="block pt-1 text-[11px] text-slate-500">
                          Last requested {formatDate(file.assignment_details.lender_revision_last_requested_at)}
                          {file.assignment_details.lender_revision_note
                            ? ` - ${file.assignment_details.lender_revision_note}`
                            : ""}
                        </span>
                      ) : null}
                      {file.workfile?.canonical_file_name ? (
                        <span className="block break-all pt-1 font-mono text-[10px] text-slate-500">
                          {file.workfile.canonical_file_name}
                        </span>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <a
                        className="hn-action-primary btn btn-sm normal-case"
                        href={`/AppraisalReport?propertyId=${encodeURIComponent(accountId || "")}&assignmentFileId=${encodeURIComponent(String(file.id))}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        View File
                      </a>
                      <button
                        type="button"
                        className="hn-action-primary btn btn-sm normal-case"
                        onClick={() => void downloadCustomAppraisalFile(file)}
                        disabled={Boolean(downloadInProgress)}
                      >
                        {downloadInProgress === `workfile:${file.id}`
                          ? "Preparing File..."
                          : file.workfile?.status === "signed" ? "Download Signed File" : "Download Draft"}
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm normal-case border-slate-900 bg-slate-900 text-white hover:bg-slate-800"
                        onClick={() => void downloadCustomAppraisalPdf(file)}
                        disabled={Boolean(downloadInProgress)}
                      >
                        {downloadInProgress === `pdf:${file.id}`
                          ? "Building PDF..."
                          : file.workfile?.status === "signed" ? "Download Signed PDF" : "Download Draft PDF"}
                      </button>
                      {isActiveFile && file.workfile?.status !== "signed" ? (
                        <button
                          type="button"
                          className="hn-action-primary btn btn-sm normal-case"
                          onClick={() => void recordLenderRevisionRequest()}
                          disabled={savingAssignmentFile}
                        >
                          Record Revision Request
                        </button>
                      ) : null}
                      {isActiveFile && file.workfile?.status !== "signed" ? (
                        <button
                          type="button"
                          className="btn btn-sm normal-case border-amber-600 bg-amber-600 text-white hover:bg-amber-700"
                          onClick={() => void finalizeCustomAppraisalFile()}
                          disabled={savingAssignmentFile}
                        >
                          Finalize &amp; Lock
                        </button>
                      ) : null}
                    </div>
                  </div>
                );
              })
            ) : (
              <p className="text-xs text-slate-500">
                No appraisal files have been saved for this property yet.
              </p>
            )}
          </div>
        </details>
      </section>

      {accountId ? (
        <PreviousAppraisalFiles accountId={accountId} getEditorKey={editorKeyForSave} customTheme />
      ) : null}

      <figure className="relative h-64 bg-slate-100 sm:h-72">
        {photos.length ? (
          <img
            src={photos[photoIndex]}
            alt={`${address} property`}
            className="h-full w-full select-none object-cover"
            draggable={false}
          />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center bg-gradient-to-br from-slate-100 to-slate-200 text-slate-500">
            <svg
              className="mb-3 h-14 w-14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              <path d="M3 11.5 12 4l9 7.5" />
              <path d="M5 10.5V20h14v-9.5" />
              <path d="M9 20v-6h6v6" />
            </svg>
            <span className="text-sm font-medium">Property photo unavailable</span>
          </div>
        )}

        {canSlide ? (
          <>
            <button
              type="button"
              onClick={showPreviousPhoto}
              aria-label="Previous image"
              className="absolute left-3 top-1/2 z-20 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full border border-white/70 bg-white/90 text-slate-800 shadow-lg hover:bg-white"
            >
              <span aria-hidden="true">‹</span>
            </button>
            <button
              type="button"
              onClick={showNextPhoto}
              aria-label="Next image"
              className="absolute right-3 top-1/2 z-20 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full border border-white/70 bg-white/90 text-slate-800 shadow-lg hover:bg-white"
            >
              <span aria-hidden="true">›</span>
            </button>
            <div className="absolute bottom-3 left-1/2 z-20 flex -translate-x-1/2 gap-1.5 rounded-full bg-black/40 px-3 py-2">
              {photos.map((_, index) => (
                <button
                  key={index}
                  type="button"
                  onClick={() => setPhotoIndex(index)}
                  aria-label={`Go to image ${index + 1}`}
                  className={`h-2.5 w-2.5 rounded-full border border-white ${
                    index === photoIndex ? "bg-white" : "bg-white/40"
                  }`}
                />
              ))}
            </div>
          </>
        ) : null}
      </figure>

      <div className="card-body bg-white p-4 sm:p-6" style={{ backgroundColor: "#ffffff" }}>
        <header className="grid gap-5 border-b border-slate-200 pb-5 lg:grid-cols-3 lg:items-start">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-slate-950">{streetAddress}</h1>
            <p className="mt-1 text-sm font-medium text-slate-700">
              {city}, {state} {postalCode} <span className="text-slate-400">&middot;</span> {county}
            </p>
            <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-sm text-slate-600">
              <span>
                Neighborhood Code: <strong className="text-slate-800">{neighborhood}</strong>
              </span>
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-slate-50/80 p-3 text-center">
            <div className="flex flex-col items-center justify-center gap-2">
              <h2 className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-700">Prepared For</h2>
            </div>
            <input
              type="text"
              maxLength={500}
              className="input input-bordered input-sm mt-2 w-full bg-white text-center placeholder:text-center"
              value={assignmentDraft.lender_client_name || ""}
              onChange={(event) => updateAssignment("lender_client_name", event.target.value)}
              placeholder="Lender / client name"
              aria-label="Prepared for lender or client"
            />
            <textarea
              maxLength={2000}
              className="textarea textarea-bordered textarea-sm mt-2 min-h-14 w-full bg-white text-center placeholder:text-center"
              value={assignmentDraft.lender_client_address || ""}
              onChange={(event) => updateAssignment("lender_client_address", event.target.value)}
              placeholder="Lender / client address"
              aria-label="Lender or client address"
            />
            <button
              type="button"
              onClick={() => void saveAssignmentFromSection()}
              className="hn-action-primary btn btn-primary btn-xs mx-auto mt-2 normal-case rounded-lg"
              disabled={assignmentSaveDisabled}
            >
              {savingAssignmentFile ? "Saving..." : "Save Prepared For"}
            </button>
            {assignmentSaveMessage ? (
              <p className="mt-2 text-xs leading-5 text-slate-600">{assignmentSaveMessage}</p>
            ) : null}
          </div>

          <div className="rounded-xl border border-slate-200 bg-slate-50/80 p-3 text-right">
            <h2 className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-700">Assignment Type</h2>
            {assignmentTypeLabels.length ? (
              <div className="mt-2 flex flex-wrap justify-end gap-1.5">
                {assignmentTypeLabels.map((label) => (
                  <span key={label} className="hn-custom-verified rounded-full px-2 py-1 text-xs font-semibold">
                    {label}
                  </span>
                ))}
              </div>
            ) : (
              <p className="mt-2 text-sm text-slate-500">Not selected</p>
            )}
            {assignmentTypes.includes("other") && assignmentDraft.assignment_explanation ? (
              <p className="mt-2 text-xs leading-5 text-slate-600">{assignmentDraft.assignment_explanation}</p>
            ) : null}
            <p className="mt-2 text-[11px] leading-4 text-slate-500">
              Reflects the manual selection below and future engagement-letter imports.
            </p>
          </div>
        </header>

        {showRelatedParcelCheck ? (
        <section className="mt-5 rounded-2xl border border-amber-200 bg-amber-50/70 p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-sm font-semibold uppercase tracking-[0.12em] text-slate-800">
                  Same-Address CAD Parcel Check
                </h2>
                {relatedParcels?.review_required ? (
                  <span className="rounded-full bg-amber-200 px-2 py-0.5 text-xs font-semibold text-amber-900">
                    Review related parcels
                  </span>
                ) : null}
              </div>
              <p className="mt-1 max-w-3xl text-xs leading-5 text-slate-600">
                HomeNode checks the official DCAD parcel map in the background for other accounts at
                this exact situs address. Results remain separate and are never merged automatically.
              </p>
            </div>
            <button
              type="button"
              className="btn btn-sm normal-case border-amber-300 bg-white text-slate-800 hover:border-amber-400 hover:bg-amber-100"
              disabled={relatedParcelsLoading || !accountId}
              onClick={() => void refreshRelatedParcels()}
            >
              {relatedParcelsLoading ? "Checking DCAD..." : "Check Again"}
            </button>
          </div>

          {relatedParcelsError ? (
            <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
              The live DCAD parcel check could not be completed: {relatedParcelsError}
            </div>
          ) : null}

          {relatedParcels && relatedParcels.live_query_status !== "complete" ? (
            <div className="mt-3 rounded-xl border border-amber-300 bg-amber-100 p-3 text-sm text-amber-950">
              The official DCAD live check is {relatedParcels.live_query_status.replace(/_/g, " ")}.
              Local exact-address matches are shown below, but this item remains flagged for manual
              parcel review.
            </div>
          ) : null}

          {relatedParcels && !relatedParcelsLoading ? (
            relatedParcels.parcels.length ? (
              <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
                {relatedParcelsToShow.map((parcel) => (
                  <div
                    key={parcel.account_id}
                    className={`rounded-xl border bg-white p-3 ${
                      parcel.is_subject ? "border-slate-200" : "border-amber-300"
                    }`}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <div className="font-semibold text-slate-950">
                          {parcel.site_address || parcel.address || relatedParcels.query_address}
                        </div>
                        <div className="mt-0.5 font-mono text-xs text-slate-600">
                          {parcel.account_id}
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {parcel.is_subject ? (
                          <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs font-semibold text-slate-700">
                            Current subject
                          </span>
                        ) : (
                          <span className="rounded-full bg-amber-200 px-2 py-0.5 text-xs font-semibold text-amber-900">
                            Additional parcel
                          </span>
                        )}
                        {!parcel.in_database ? (
                          <span className="rounded-full bg-rose-100 px-2 py-0.5 text-xs font-semibold text-rose-800">
                            Not in database
                          </span>
                        ) : null}
                      </div>
                    </div>
                    {!parcel.is_subject && (parcel.difference_fields || []).length ? (
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        {(parcel.difference_fields || []).map((field) => (
                          <span
                            key={field}
                            className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-900"
                          >
                            Differs: {field}
                          </span>
                        ))}
                      </div>
                    ) : null}
                    <div className="mt-3 grid grid-cols-2 gap-3 text-xs text-slate-600 sm:grid-cols-4">
                      <div>
                        <span className="block text-slate-500">Living Area</span>
                        <strong className="text-slate-800">
                          {parcel.living_area_sqft
                            ? `${new Intl.NumberFormat("en-US").format(parcel.living_area_sqft)} sq. ft.`
                            : "Land / not reported"}
                        </strong>
                      </div>
                      <div>
                        <span className="block text-slate-500">Land Value</span>
                        <strong className="text-slate-800">{formatMoney(parcel.land_value)}</strong>
                      </div>
                      <div>
                        <span className="block text-slate-500">Improvement Value</span>
                        <strong className="text-slate-800">
                          {formatMoney(parcel.improvement_value)}
                        </strong>
                      </div>
                      <div>
                        <span className="block text-slate-500">Total Value</span>
                        <strong className="text-slate-800">{formatMoney(parcel.total_value)}</strong>
                      </div>
                    </div>
                    {parcel.legal_description ? (
                      <p className="mt-3 border-t border-slate-100 pt-2 text-xs text-slate-600">
                        {parcel.legal_description}
                      </p>
                    ) : null}
                    {!parcel.is_subject && parcel.in_database ? (
                      <a
                        href={`/report/${encodeURIComponent(parcel.account_id)}`}
                        className="mt-3 inline-flex text-xs font-semibold text-blue-700 hover:text-blue-900 hover:underline"
                      >
                        Open this parcel&apos;s report →
                      </a>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-3 text-sm text-slate-600">
                No same-address parcel was returned by the official DCAD parcel map. Keep this item
                under manual review if the situs address is missing or incomplete.
              </p>
            )
          ) : null}
        </section>
        ) : null}

        <div className="mt-5 flex flex-col gap-5">
          <SummarySection
            title="Subject Identification"
            subtitle="Parcel, ownership, and recorded legal information"
            {...sectionEditProps("report.subject_identification")}
            className="order-1"
          >
            <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-12">
              <SummaryField
                label="Parcel / Account Number"
                value={displayValue(accountId)}
                className="lg:col-span-3"
              />
              <SummaryField label="County" value={county} className="lg:col-span-2" />
              <SummaryField label="Subdivision" value={subdivision} className="lg:col-span-4" />
              <SummaryField
                label="Zoning Classification"
                value={primaryZoningDisplay}
                className="lg:col-span-3"
              />
              <SummaryField
                label="Latest Deed Transfer"
                value={formatDate(deedTransferDate)}
                className="lg:col-span-3"
              />
              <SummaryField
                label={ownerParties.length > 1 ? "Owner Names" : "Owner Name"}
                className="lg:col-span-7"
                value={
                  ownerParties.length ? (
                    <div className="space-y-1.5">
                      {ownerParties.map((party, index) => (
                        <div key={`${party.owner_name}-${index}`}>
                          {displayValue(party.owner_name)}
                        </div>
                      ))}
                    </div>
                  ) : ownerName
                }
              />
              <SummaryField
                label="Ownership Percentage"
                className="lg:col-span-2"
                value={
                  ownerParties.length ? (
                    <div className="space-y-1.5">
                      {ownerParties.map((party, index) => (
                        <div key={`${party.owner_name}-share-${index}`}>
                          {formatOwnershipPercent(party.ownership_pct)}
                        </div>
                      ))}
                    </div>
                  ) : "Share not reported"
                }
              />
              <SummaryField
                label="Owner Mailing Address"
                value={ownerMailing}
                className="sm:col-span-2 lg:col-span-4"
              />
              <SummaryField
                label="Legal Description"
                value={<span className="whitespace-pre-line">{legalDescription}</span>}
                className="sm:col-span-2 lg:col-span-5"
              />
              <SummaryField
                label="Census Tract"
                className="sm:col-span-2 lg:col-span-3"
                value={
                  <div>
                    <span>{formatCensusTract(detail?.property_location?.census_tract)}</span>
                    {detail?.property_location?.census_tract_geoid ? (
                      <span className="mt-0.5 block font-mono text-[11px] font-normal text-slate-500">
                        GEOID {detail.property_location.census_tract_geoid}
                      </span>
                    ) : null}
                    {detail?.property_location?.census_tract_status === "review_required" ? (
                      <span className="mt-1 block text-[11px] font-medium text-amber-700">
                        Coordinate/county match needs review
                      </span>
                    ) : null}
                    <button
                      type="button"
                      className="btn btn-ghost btn-xs -ml-2 mt-1 normal-case text-blue-700"
                      onClick={() => void lookUpCensusTractNow()}
                      disabled={censusLookupLoading || !accountId}
                    >
                      {censusLookupLoading
                        ? "Looking up..."
                        : detail?.property_location?.census_tract
                          ? "Refresh tract"
                          : "Look Up Now"}
                    </button>
                    {censusLookupMessage ? (
                      <span className={`mt-1 block text-[11px] font-medium ${
                        /added/i.test(censusLookupMessage) ? "text-emerald-700" : "text-amber-700"
                      }`}>
                        {censusLookupMessage}
                      </span>
                    ) : null}
                  </div>
                }
              />
            </div>

            <div className={`mt-5 rounded-xl border p-4 ${
              zoningEvidence?.review_required
                ? "border-amber-300 bg-amber-50/70"
                : "border-slate-200 bg-white/70"
            }`}>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-semibold text-slate-900">Zoning Evidence</h3>
                    {zoningEvidence?.verification ? (
                      <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-800">
                        Appraiser confirmed
                      </span>
                    ) : zoningEvidence?.review_required ? (
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800">
                        Review required
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    {zoningEvidence?.jurisdiction?.provider_label || "Loading the official municipal source..."}
                  </p>
                </div>
                <button
                  type="button"
                  className="hn-action-primary btn btn-primary btn-sm normal-case rounded-lg shadow-sm"
                  onClick={() => zoningEvidenceOpen
                    ? setZoningEvidenceOpen(false)
                    : void loadZoningEvidence({ open: true })}
                  disabled={zoningEvidenceLoading}
                >
                  {zoningEvidenceLoading
                    ? "Loading..."
                    : zoningEvidenceOpen ? "Close Evidence Viewer" : "Review Zoning Evidence"}
                </button>
              </div>
              {zoningEvidence?.review_reason ? (
                <p className="mt-2 text-xs leading-5 text-amber-800">{zoningEvidence.review_reason}</p>
              ) : null}
              {zoningEvidenceMessage ? (
                <p className="mt-2 text-xs font-medium text-slate-700">{zoningEvidenceMessage}</p>
              ) : null}

              {zoningEvidenceOpen && zoningEvidence?.jurisdiction ? (
                <div className="mt-4 grid gap-4 border-t border-slate-200 pt-4 xl:grid-cols-[minmax(0,1.7fr)_minmax(22rem,1fr)]">
                  <div className="min-w-0">
                    {selectedZoningDocument ? (
                      <>
                        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                          <select
                            className="select select-bordered select-sm min-w-64 bg-white"
                            value={String(selectedZoningDocument.id)}
                            onChange={(event) => setZoningDraft((current) => ({
                              ...current,
                              sourceDocumentId: event.target.value,
                              sourceType: "map_pdf",
                            }))}
                          >
                            {zoningEvidence.documents.map((document) => (
                              <option key={document.id} value={document.id}>{document.title}</option>
                            ))}
                          </select>
                          <a
                            href={selectedZoningDocument.official_url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-xs font-semibold text-blue-700 hover:underline"
                          >
                            Open official source
                          </a>
                        </div>
                        <iframe
                          title={selectedZoningDocument.title}
                          src={`/pdfjs-viewer.html?file=${encodeURIComponent(makeUrl(selectedZoningDocument.content_url))}`}
                          className="h-[32rem] w-full rounded-lg border border-slate-300 bg-slate-100"
                        />
                        <p className="mt-2 text-[11px] leading-4 text-slate-500">
                          Cached {formatDate(selectedZoningDocument.fetched_at)} · {selectedZoningDocument.page_count || "Unknown"} page(s) · Source version {selectedZoningDocument.checksum_sha256.slice(0, 12)}
                        </p>
                      </>
                    ) : (
                      <div className="flex h-64 flex-col items-center justify-center rounded-lg border border-dashed border-slate-300 bg-slate-50 p-5 text-center">
                        <p className="text-sm font-semibold text-slate-800">No cacheable PDF is published for this city.</p>
                        <p className="mt-2 max-w-xl text-xs leading-5 text-slate-600">
                          Use the official interactive source and the city contact shown here. The confirmed result can still be saved with full provenance.
                        </p>
                        {zoningEvidence.jurisdiction.reference_url ? (
                          <a
                            href={zoningEvidence.jurisdiction.reference_url}
                            target="_blank"
                            rel="noreferrer"
                            className="hn-action-primary btn btn-primary btn-sm mt-4 normal-case rounded-lg"
                          >
                            Open Official Zoning Resource
                          </a>
                        ) : null}
                      </div>
                    )}
                  </div>

                  <div className="space-y-4">
                    {zoningEvidence.jurisdiction.contact ? (
                      <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-xs text-slate-700">
                        <h4 className="font-semibold text-slate-900">City verification contact</h4>
                        <p className="mt-1 font-medium">{zoningEvidence.jurisdiction.contact.department}</p>
                        {zoningEvidence.jurisdiction.contact.contactName ? <p>{zoningEvidence.jurisdiction.contact.contactName}</p> : null}
                        {zoningEvidence.jurisdiction.contact.phone &&
                        !zoningEvidence.jurisdiction.contact.planningPhone &&
                        !zoningEvidence.jurisdiction.contact.buildingPhone ? (
                          <p className="mt-1"><a className="font-semibold text-blue-800 hover:underline" href={`tel:${zoningEvidence.jurisdiction.contact.phone}`}>{zoningEvidence.jurisdiction.contact.phone}</a></p>
                        ) : null}
                        {zoningEvidence.jurisdiction.contact.planningPhone ? (
                          <p className="mt-1"><span className="font-medium">Planning & Zoning:</span> {zoningEvidence.jurisdiction.contact.planningPhone}</p>
                        ) : null}
                        {zoningEvidence.jurisdiction.contact.buildingPhone ? (
                          <p><span className="font-medium">Building Inspections:</span> {zoningEvidence.jurisdiction.contact.buildingPhone}</p>
                        ) : null}
                        {zoningEvidence.jurisdiction.contact.email ? (
                          <p><a className="font-semibold text-blue-800 hover:underline" href={`mailto:${zoningEvidence.jurisdiction.contact.email}`}>{zoningEvidence.jurisdiction.contact.email}</a></p>
                        ) : null}
                        {zoningEvidence.jurisdiction.contact.address ? <p className="mt-1">{zoningEvidence.jurisdiction.contact.address}</p> : null}
                        <a href={zoningEvidence.jurisdiction.contact.sourceUrl} target="_blank" rel="noreferrer" className="mt-2 inline-block font-semibold text-blue-800 hover:underline">
                          Verify current contact on city site
                        </a>
                      </div>
                    ) : null}

                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
                      <label className="block">
                        <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">Confirmed Zoning Code</span>
                        <input className="input input-bordered input-sm mt-1 w-full bg-white" value={zoningDraft.zoningCode} onChange={(event) => setZoningDraft((current) => ({ ...current, zoningCode: event.target.value }))} />
                      </label>
                      <label className="block">
                        <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">Source Type</span>
                        <select className="select select-bordered select-sm mt-1 w-full bg-white" value={zoningDraft.sourceType} onChange={(event) => setZoningDraft((current) => ({ ...current, sourceType: event.target.value as typeof current.sourceType }))}>
                          {selectedZoningDocument ? <option value="map_pdf">Official map / PDF</option> : null}
                          <option value="interactive_map">Official interactive map</option>
                          <option value="city_confirmation">Confirmed with city</option>
                          <option value="official_gis">Official GIS result</option>
                          <option value="manual">Other manual verification</option>
                        </select>
                      </label>
                      <label className="block sm:col-span-2 xl:col-span-1 2xl:col-span-2">
                        <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">Verbatim Official Zoning Description</span>
                        <input className="input input-bordered input-sm mt-1 w-full bg-white" value={zoningDraft.zoningDescription} onChange={(event) => setZoningDraft((current) => ({ ...current, zoningDescription: event.target.value }))} />
                        {selectedZoningDocument ? (
                          <button
                            type="button"
                            className="btn btn-outline btn-xs mt-2 normal-case rounded-lg"
                            onClick={() => void prefillVerbatimZoningDescription()}
                            disabled={zoningEvidenceLoading || !zoningDraft.zoningCode.trim()}
                          >
                            Prefill Exact Wording from PDF
                          </button>
                        ) : null}
                      </label>
                      <label className="block">
                        <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">PDF Page</span>
                        <input type="number" min="1" className="input input-bordered input-sm mt-1 w-full bg-white" value={zoningDraft.pageNumber} onChange={(event) => setZoningDraft((current) => ({ ...current, pageNumber: event.target.value }))} />
                      </label>
                      <label className="block">
                        <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">Reviewer</span>
                        <input className="input input-bordered input-sm mt-1 w-full bg-white" placeholder="Appraiser name" value={zoningDraft.reviewer} onChange={(event) => setZoningDraft((current) => ({ ...current, reviewer: event.target.value }))} />
                      </label>
                      <label className="block sm:col-span-2 xl:col-span-1 2xl:col-span-2">
                        <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">Review Notes</span>
                        <textarea className="textarea textarea-bordered textarea-sm mt-1 min-h-20 w-full bg-white" value={zoningDraft.notes} onChange={(event) => setZoningDraft((current) => ({ ...current, notes: event.target.value }))} />
                      </label>
                    </div>
                    <p className="text-[11px] leading-4 text-slate-500">
                      Blurry or machine-read map labels are suggestions only. Saving requires an identified reviewer and never alters the official source document.
                    </p>
                    <button type="button" className="hn-action-primary btn btn-primary btn-sm w-full normal-case rounded-lg shadow-sm" onClick={() => void saveZoningEvidence()} disabled={zoningEvidenceLoading}>
                      {zoningEvidenceLoading ? "Saving..." : "Save Confirmed Zoning"}
                    </button>
                  </div>
                </div>
              ) : null}
            </div>

            <div className="mt-5 rounded-xl border border-slate-200 bg-white/70 p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-slate-900">Occupancy</h3>
                  <p className="mt-1 text-xs text-slate-500">Assignment-specific occupancy of the subject.</p>
                </div>
                <button
                  type="button"
                  onClick={() => void saveAssignmentFromSection()}
                  className="hn-action-primary btn btn-primary btn-sm normal-case rounded-lg shadow-sm"
                  disabled={assignmentSaveDisabled}
                >
                  {savingAssignmentFile ? "Saving..." : "Save Occupancy"}
                </button>
              </div>
              {assignmentSaveMessage ? (
                <p className="mt-2 text-xs leading-5 text-slate-600">{assignmentSaveMessage}</p>
              ) : null}
              <div className="mt-3 grid gap-2 sm:grid-cols-4">
                {OCCUPANCY_OPTIONS.map(([value, label]) => (
                  <CheckboxChoice
                    key={value}
                    checked={assignmentDraft.occupancy === value}
                    label={label}
                    onChange={(checked) => updateAssignment("occupancy", checked ? value : "")}
                  />
                ))}
              </div>
              {assignmentDraft.occupancy === "unknown" ? (
                <label className="mt-3 block">
                  <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                    Unknown Occupancy Explanation
                  </span>
                  <textarea
                    className="textarea textarea-bordered textarea-sm mt-1 min-h-16 w-full bg-white"
                    value={assignmentDraft.occupancy_explanation || ""}
                    onChange={(event) => updateAssignment("occupancy_explanation", event.target.value)}
                    placeholder="Explain why occupancy could not be confirmed"
                  />
                </label>
              ) : null}
            </div>

            <div className="mt-5 rounded-xl border border-slate-200 bg-white/70 p-4">
              <div className="mb-3">
                <h3 className="text-sm font-semibold text-slate-900">PUD and HOA</h3>
                <p className="mt-1 text-xs text-slate-500">
                  {activeAssignmentFile
                    ? `Saving to appraisal file ${activeAssignmentFile.file_number}.`
                    : "Enter a new file number above before saving changes."}
                </p>
              </div>
              <div className="max-w-xs">
                <CheckboxChoice
                  checked={Boolean(assignmentDraft.pud)}
                  label="PUD"
                  onChange={(checked) => updateAssignment("pud", checked)}
                />
              </div>
              {assignmentDraft.pud ? (
                <div className="mt-4 space-y-4">
                  <label className="block max-w-sm">
                    <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                      HOA Dues Amount
                    </span>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      className="input input-bordered mt-1 w-full bg-white"
                      value={assignmentDraft.hoa_dues_amount ?? ""}
                      onChange={(event) =>
                        updateAssignment("hoa_dues_amount", event.target.value)
                      }
                      placeholder="Dollar amount"
                    />
                  </label>
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                      HOA Dues Frequency
                    </div>
                    <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                      {HOA_FREQUENCY_OPTIONS.map(([value, label]) => (
                        <CheckboxChoice
                          key={value}
                          checked={assignmentDraft.hoa_frequency === value}
                          label={label}
                          onChange={(checked) =>
                            updateAssignment("hoa_frequency", checked ? value : "")
                          }
                        />
                      ))}
                    </div>
                  </div>
                  <label className="block">
                    <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                      HOA Explanation
                    </span>
                    <textarea
                      className="textarea textarea-bordered mt-1 min-h-20 w-full bg-white"
                      value={assignmentDraft.hoa_explanation || ""}
                      onChange={(event) =>
                        updateAssignment("hoa_explanation", event.target.value)
                      }
                      placeholder="Required when dues are unavailable or the frequency is Other"
                    />
                  </label>
                </div>
              ) : null}
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                <span className="text-xs text-slate-500">
                  {assignmentSaveMessage || (assignmentDirty ? "Unsaved assignment changes" : "No unsaved changes")}
                </span>
                <button
                  type="button"
                  onClick={() => void saveAssignmentFromSection()}
                  className="hn-action-primary btn btn-primary btn-sm normal-case rounded-lg shadow-sm"
                  disabled={assignmentSaveDisabled}
                >
                  {savingAssignmentFile ? "Saving..." : "Save PUD / HOA"}
                </button>
              </div>
            </div>
          </SummarySection>

          <SummarySection
            title="Assignment Details"
            subtitle={activeAssignmentFile
              ? `Saving to appraisal file ${activeAssignmentFile.file_number}`
              : "Choose a file number above to preserve these values as a new assignment"}
            manuallyVerified={Boolean(activeAssignmentFile || detail?.report_manual_values?.["report.assignment_details"])}
            compact
            className="order-5"
          >
            <div>
              <fieldset className="rounded-xl border border-slate-200 bg-white p-3">
                <legend className="px-1 text-sm font-semibold text-slate-900">Assignment Type</legend>
                <p className="mb-2 text-xs text-slate-600">Select every type that applies.</p>
                <div className="grid gap-1.5 sm:grid-cols-3 xl:grid-cols-5">
                  {ASSIGNMENT_TYPE_OPTIONS.map(([value, label]) => (
                    <CheckboxChoice
                      key={value}
                      checked={assignmentTypes.includes(value)}
                      label={label}
                      onChange={(checked) => updateAssignmentTypes(
                        checked
                          ? [...new Set([...assignmentTypes, value])]
                          : assignmentTypes.filter((item) => item !== value),
                      )}
                    />
                  ))}
                </div>
                {assignmentTypes.includes("other") ? (
                  <label className="mt-4 block">
                    <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                      Other Assignment Explanation
                    </span>
                    <textarea
                      className="textarea textarea-bordered mt-1 min-h-20 w-full bg-white"
                      value={assignmentDraft.assignment_explanation || ""}
                      onChange={(event) =>
                        updateAssignment("assignment_explanation", event.target.value)
                      }
                    />
                  </label>
                ) : null}
              </fieldset>
            </div>

            {assignmentErrors.length ? (
              <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
                <ul className="list-disc space-y-1 pl-5">
                  {assignmentErrors.map((error) => <li key={error}>{error}</li>)}
                </ul>
              </div>
            ) : null}
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              <span className="text-xs text-slate-500">
                {assignmentSaveMessage || (assignmentDirty ? "Unsaved assignment changes" : "No unsaved changes")}
              </span>
              <button
                type="button"
                onClick={() => void saveAssignmentFromSection()}
                className="hn-action-primary btn btn-primary btn-sm normal-case rounded-lg shadow-sm"
                disabled={assignmentSaveDisabled}
              >
                {savingAssignmentFile ? "Saving..." : "Save Assignment Details"}
              </button>
            </div>
          </SummarySection>

          <Suspense fallback={<LazyReportContent label="documents" className="order-6" />}>
            <AssignmentDocumentCenter
              accountId={accountId || ""}
              assignmentFileId={activeAssignmentFile?.id || null}
              subjectAddress={documentReviewSubjectAddress}
              getEditorKey={editorKeyForSave}
              onApplyConfirmedCandidate={applyConfirmedDocumentCandidate}
              className="order-6"
            />
          </Suspense>

          <Suspense fallback={<LazyReportContent label="photos" className="order-6" />}>
            <AssignmentPhotoCenter
              accountId={accountId || ""}
              assignmentFileId={activeAssignmentFile?.id || null}
              assignmentFileNumber={activeAssignmentFile?.file_number || null}
              getEditorKey={editorKeyForSave}
              onPhotosChanged={handleAssignmentPhotosChanged}
              sketchRevision={mobileInspectionSketch?.revision || null}
              onSketchChanged={refreshMobileSketchEvidence}
              readOnly={activeAssignmentFile?.workfile?.status === "signed"}
              className="order-6"
            />
          </Suspense>

          <div className="order-4 grid grid-cols-1 gap-5">
            <SummarySection
              title="Listings, Contracts, and Sales History"
              subtitle="MLS listing activity, contracts, closed sales, and CAD deed-transfer records"
              {...sectionEditProps("report.sales_history")}
            >
              <Suspense fallback={<LazyReportContent label="listings and sales history" />}>
                <ListingsContractsSalesContent
                listingRows={listingRows}
                salesHistoryRows={salesHistoryRows}
                assignmentDraft={assignmentDraft}
                purchaseTransactionSelected={purchaseTransactionSelected}
                assignmentErrors={assignmentErrors}
                assignmentDirty={assignmentDirty}
                assignmentSaveMessage={assignmentSaveMessage}
                assignmentSaveDisabled={assignmentSaveDisabled}
                savingAssignmentFile={savingAssignmentFile}
                contractSellerComparison={contractSellerComparison}
                onAssignmentChange={updateAssignment}
                onSave={() => void saveAssignmentFromSection()}
                />
              </Suspense>
            </SummarySection>
          </div>

          <SummarySection
            title="Property Characteristics"
            subtitle={assignmentPropertyCharacteristics
              ? `Appraisal-district, verified MLS, and accepted mobile observations for ${activeAssignmentFile?.file_number}`
              : "Auto-populated appraisal-district and verified MLS characteristics"}
            {...sectionEditProps("report.property_characteristics")}
            className="order-2"
          >
            <div className="grid grid-cols-2 gap-x-5 gap-y-4 md:grid-cols-3 lg:grid-cols-5">
              <SummaryField
                label="Living Area"
                value={formatNumber(
                  improvement?.living_area_sqft || improvement?.total_living_area,
                  " sq. ft.",
                )}
              />
              <SummaryField
                label="Total Area"
                value={formatNumber(improvement?.total_area_sqft, " sq. ft.")}
              />
              <SummaryField label="Bedrooms" value={displayValue(improvement?.bedroom_count)} />
              <SummaryField label="Bathrooms" value={formatBaths(improvement)} />
              <SummaryField label="Stories" value={displayValue(improvement?.stories)} />
              <SummaryField label="Year Built" value={displayValue(improvement?.year_built)} />
              <SummaryField
                label="Effective Year"
                value={displayValue(improvement?.effective_year_built)}
              />
              <SummaryField label="Actual Age" value={displayValue(improvement?.actual_age)} />
              <SummaryField
                label="Building Class"
                value={displayValue(improvement?.building_class)}
              />
              <SummaryField
                label="Desirability"
                value={displayValue(improvement?.desirability)}
              />
              <SummaryField
                label="Housing Type"
                value={displayValue(housing?.housing_type)}
              />
              <SummaryField
                label="Attachment"
                value={displayValue(housing?.attachment_type)}
              />
              <SummaryField
                label="Architectural Style"
                value={displayValue(housing?.architectural_style)}
              />
              <SummaryField
                label="Construction"
                value={displayValue(improvement?.construction_type)}
              />
              <SummaryField label="Foundation" value={displayValue(improvement?.foundation)} />
              <SummaryField
                label="Exterior"
                value={displayValue(improvement?.exterior_material)}
              />
              <SummaryField
                label="Roof"
                value={[
                  improvement?.roof_type,
                  improvement?.roof_material,
                ]
                  .filter(hasValue)
                  .join(" · ") || "Not reported"}
              />
              <SummaryField label="Heating" value={displayValue(improvement?.heating)} />
              <SummaryField label="Air Conditioning" value={displayValue(improvement?.air_conditioning)} />
              <SummaryField
                label="Fireplaces"
                value={displayValue(improvement?.fireplaces)}
              />
              <SummaryField label="Kitchens" value={displayValue(improvement?.kitchens)} />
              <SummaryField label="Wet Bars" value={displayValue(improvement?.wetbars)} />
              <SummaryField label="Pool" value={formatReportedBoolean(improvement?.pool)} />
              <SummaryField
                label="Sprinkler"
                value={formatReportedBoolean(improvement?.sprinkler)}
              />
              <SummaryField label="Fence" value={displayValue(improvement?.fence_type)} />
              {Object.keys(inspectionDetails).length ? <>
                <SummaryField label="Skirting" value={displayValue(inspectionDetails.skirting)} />
                <SummaryField label="Window Type" value={displayValue(inspectionDetails.window_type)} />
                <SummaryField label="Interior Floor" value={displayValue(inspectionDetails.interior_floor_type)} />
                <SummaryField label="Bath Floor" value={displayValue(inspectionDetails.bath_floor_type)} />
                <SummaryField label="Kitchen Countertops" value={displayValue(inspectionDetails.kitchen_countertop_type)} />
                <SummaryField label="Interior Walls" value={displayValue(inspectionDetails.interior_wall_type)} />
                <SummaryField label="Garage / Carport" value={displayValue(inspectionDetails.garage_carport)} />
                <SummaryField label="Pool / Amenities" value={displayValue(inspectionDetails.pool_amenities)} />
                <SummaryField label="Updates / Remodeling" value={displayValue(inspectionDetails.updates_remodeling)} />
                <SummaryField label="Additions" value={displayValue(inspectionDetails.additions)} />
                <SummaryField label="Defects / Deferred Maintenance" value={displayValue(inspectionDetails.defects_deferred_maintenance)} />
                <SummaryField label="Repair Cost to Cure" value={displayValue(inspectionDetails.repair_cost_to_cure)} />
                <SummaryField label="Additional Improvements" value={displayValue(inspectionDetails.additional_improvements_notes)} />
                <SummaryField label="Field Comments" value={displayValue(inspectionDetails.appraiser_comments)} />
              </> : null}
              {additionalImprovements.map((row, index) => (
                <SummaryField
                  key={`${row.number || index}-${row.improvement_type || "improvement"}`}
                  label={displayValue(row.improvement_type, `Improvement ${index + 1}`)}
                  value={(
                    <div>
                      <span>{formatNumber(row.area_sqft, " sq. ft.")}</span>
                      <span className="mt-0.5 block text-xs font-normal leading-5 text-slate-600">
                        {[row.construction, row.floor, row.exterior_wall]
                          .filter(hasValue)
                          .join(" · ") || "Construction details not reported"}
                        {hasValue(row.year_built)
                          ? ` · Built ${displayValue(row.year_built)}`
                          : ""}
                      </span>
                    </div>
                  )}
                />
              ))}
            </div>

            {assignmentPropertyCharacteristics || mobileInspectionPhotos.length ? (
              <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs leading-5 text-emerald-900">
                Accepted mobile observations are scoped to appraisal file {activeAssignmentFile?.file_number}.
                {mobileInspectionPhotos.length
                  ? ` ${mobileInspectionPhotos.length} verified field photo${mobileInspectionPhotos.length === 1 ? " is" : "s are"} attached to this file and retained for five years.`
                  : " No verified mobile field photos are attached yet."}
              </div>
            ) : null}

            <PropertyContextSection
              context={propertyContext}
              loading={propertyContextLoading}
              saving={propertyContextSaving}
              message={propertyContextMessage}
              complexity={propertyComplexityDraft}
              notes={propertyComplexityNotes}
              onAnalyze={() => void analyzeCurrentPropertyContext()}
              onComplexityChange={setPropertyComplexityDraft}
              onNotesChange={setPropertyComplexityNotes}
              onSave={() => void saveCurrentPropertyComplexity()}
            />

            <SubjectConditionConformitySection
              assignment={assignmentDraft}
              dirty={assignmentDirty}
              saveMessage={assignmentSaveMessage}
              saving={savingAssignmentFile}
              saveDisabled={assignmentSaveDisabled}
              onChange={updateAssignment}
              onConformityChange={updateSubjectConformity}
              onSave={() => void saveAssignmentFromSection()}
            />

            {activeAssignmentFile && accountId ? (
              <div className="mt-5 border-t border-slate-200 pt-4">
                {mobileInspectionSketch ? (
                  <Suspense fallback={<LazyReportContent label="mobile sketch" />}>
                    <MobileSketchReview
                      sketch={mobileInspectionSketch}
                      title="Custom Appraisal measured sketch editor"
                      artifactUrls={{
                        svg: makeUrl(`/api/accounts/${encodeURIComponent(accountId)}/assignment-files/${activeAssignmentFile.id}/mobile-sketch/preview.svg`, { revision: mobileInspectionSketch.revision }),
                        pdf: makeUrl(`/api/accounts/${encodeURIComponent(accountId)}/assignment-files/${activeAssignmentFile.id}/mobile-sketch/report.pdf`, { revision: mobileInspectionSketch.revision }),
                      }}
                      saveDraft={async (draft, expectedRevision) => {
                        const editorKey = editorKeyForSave();
                        if (!editorKey) throw new Error("authentication_required");
                        const response = await updateMobileInspectionSketch(
                          accountId,
                          activeAssignmentFile.id,
                          {
                            sketch: draft,
                            expected_revision: expectedRevision,
                            reviewer: "HomeNode appraiser",
                            client_operation_id: globalThis.crypto.randomUUID(),
                          },
                          editorKey,
                        );
                        return response.sketch;
                      }}
                      onSaved={(savedSketch) => {
                        const updatedFile = {
                          ...activeAssignmentFile,
                          mobile_inspection_sketch: savedSketch,
                        };
                        setActiveAssignmentFile(updatedFile);
                        setAssignmentFiles((current) => current.map((file) =>
                          file.id === updatedFile.id ? updatedFile : file
                        ));
                      }}
                    />
                  </Suspense>
                ) : (
                  <SketchWorkspaceEmptyState
                    title="Custom Appraisal measured sketch"
                    subtitle={`No measured sketch is synchronized to ${activeAssignmentFile.file_number} yet. This area shares the lightweight live evidence check used by photos while the page is visible.`}
                    onRefresh={refreshMobileSketchEvidence}
                    refreshing={sketchEvidenceRefreshing}
                  />
                )}
              </div>
            ) : null}

            <div className="mt-5 border-t border-slate-200 pt-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-semibold text-slate-800">Land Details</h3>
                    {detail?.report_manual_values?.["report.land_details"] ? (
                      <span className="hn-custom-verified rounded-full px-2 py-0.5 text-[11px] font-semibold">
                        Manually verified
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    {landRows.length} land record{landRows.length === 1 ? "" : "s"} returned
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => editSection("report.land_details")}
                  className="hn-action-secondary btn btn-sm normal-case"
                >
                  Edit Land Details
                </button>
              </div>

              {landRows.length ? (
                <div className="mt-4 space-y-4">
                  {landRows.map((row, index) => {
                    const prefix = landRows.length > 1 ? `Land ${index + 1} ` : "";
                    return (
                      <div
                        key={row.number || index}
                        className="grid grid-cols-2 gap-x-5 gap-y-4 md:grid-cols-3 lg:grid-cols-5"
                      >
                        <SummaryField
                          label={`${prefix}Use / State Code`}
                          value={displayValue(row.state_code)}
                        />
                        <SummaryField
                          label={`${prefix}Area`}
                          value={formatNumber(row.area_sqft, " sq. ft.")}
                        />
                        <SummaryField
                          label={`${prefix}Frontage × Depth`}
                          value={
                            parseNumber(row.frontage_ft) !== null ||
                            parseNumber(row.depth_ft) !== null
                              ? `${formatNumber(row.frontage_ft, " ft.")} × ${formatNumber(
                                  row.depth_ft,
                                  " ft.",
                                )}`
                              : "Not reported"
                          }
                        />
                        <SummaryField
                          label={`${prefix}CAD Pricing`}
                          value={displayValue(row.pricing_method)}
                        />
                        <SummaryField
                          label={`${prefix}CAD Adjusted Price`}
                          value={formatMoney(row.adjusted_price)}
                        />
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="mt-4 text-sm text-slate-600">
                  No land detail records were returned for this parcel.
                </p>
              )}

              <div className="mt-5 border-t border-slate-200 pt-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-semibold text-slate-800">Highest and Best Use</h3>
                      {assignmentDraft.highest_best_use_source ? (
                        <span className="hn-custom-verified rounded-full px-2 py-0.5 text-[11px] font-semibold">
                          Automated screening
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-1 text-xs text-slate-500">
                      Provisional as-improved conclusion based on current use, zoning, and the defined-area site comparison.
                    </p>
                  </div>
                  <select
                    className="select select-bordered select-sm bg-white"
                    value={assignmentDraft.highest_best_use_conclusion || ""}
                    onChange={(event) => updateAssignment("highest_best_use_conclusion", event.target.value)}
                  >
                    <option value="">Not analyzed</option>
                    <option value="current_use">Current use</option>
                    <option value="investigation_required">Investigation required</option>
                  </select>
                </div>

                <div className="mt-3 grid gap-3 md:grid-cols-4">
                  <SummaryField
                    label="Zoning Compatibility"
                    value={
                      assignmentDraft.highest_best_use_zoning_compatible === true
                        ? "Appears compatible"
                        : assignmentDraft.highest_best_use_zoning_compatible === false
                          ? "Potential mismatch"
                          : "Requires verification"
                    }
                  />
                  <SummaryField
                    label="Subject Site"
                    value={formatNumber(
                      assignmentDraft.highest_best_use_subject_site_area_sqft,
                      " sq. ft.",
                    )}
                  />
                  <SummaryField
                    label="Predominant Same-Use Site"
                    value={formatNumber(
                      assignmentDraft.highest_best_use_comparison_median_site_area_sqft,
                      " sq. ft.",
                    )}
                  />
                  <SummaryField
                    label="Smallest Same-Use Comparison Site"
                    value={
                      parseNumber(assignmentDraft.highest_best_use_comparison_min_site_area_sqft) !== null
                        ? `${formatNumber(assignmentDraft.highest_best_use_comparison_min_site_area_sqft, " sq. ft.")} · ${formatNumber(assignmentDraft.highest_best_use_comparison_parcel_count)} parcels reviewed`
                        : "Not available"
                    }
                  />
                </div>

                {(assignmentDraft.highest_best_use_flags || []).length ? (
                  <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3">
                    <div className="text-xs font-semibold uppercase tracking-wide text-amber-950">
                      Investigation flags
                    </div>
                    <ul className="mt-1 list-disc space-y-1 pl-5 text-xs text-amber-950">
                      {(assignmentDraft.highest_best_use_flags || []).map((flag) => (
                        <li key={flag}>{flag}</li>
                      ))}
                    </ul>
                  </div>
                ) : assignmentDraft.highest_best_use_conclusion === "current_use" ? (
                  <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs font-medium text-emerald-900">
                    No automated zoning or site-size investigation flags were identified.
                  </div>
                ) : null}

                <label className="mt-3 block">
                  <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">Conclusion and Support</span>
                  <textarea
                    className="textarea textarea-bordered mt-1 min-h-20 w-full bg-white"
                    value={assignmentDraft.highest_best_use_summary || ""}
                    onChange={(event) => updateAssignment("highest_best_use_summary", event.target.value)}
                    placeholder="Run Present Land Use to populate a provisional conclusion, then edit as needed."
                  />
                </label>

                <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                  <span className="text-xs text-slate-500">
                    {assignmentDraft.highest_best_use_analyzed_at
                      ? `Screened ${formatDate(assignmentDraft.highest_best_use_analyzed_at)}. Final appraiser verification is required.`
                      : "Run Analyze Present Land Use to perform the automated screening."}
                  </span>
                  <button
                    type="button"
                    onClick={() => void saveAssignmentFromSection()}
                    className="hn-action-primary btn btn-primary btn-sm normal-case rounded-lg shadow-sm"
                    disabled={assignmentSaveDisabled}
                  >
                    {savingAssignmentFile ? "Saving..." : "Save Highest and Best Use"}
                  </button>
                </div>
              </div>
            </div>
          </SummarySection>

          <DeferredReportSection
            label="Neighborhood Characteristics"
            className="order-3"
            minimumHeight={300}
            onReady={() => setNeighborhoodSectionReady(true)}
          >
            <SummarySection
              title="Neighborhood Characteristics"
              subtitle="Present land use, neighborhood factors, market ranges, and assignment boundary review"
              manuallyVerified={Boolean(activeAssignmentFile)}
            >
              <Suspense fallback={<LazyReportContent label="neighborhood characteristics" />}>
                <NeighborhoodCharacteristicsContent
              accountId={accountId}
              assignmentFileId={activeAssignmentFile?.id || null}
              assignmentDraft={assignmentDraft}
              postalCode={censusZip}
              unemploymentLoading={unemploymentLookupLoading}
              unemploymentMessage={unemploymentLookupMessage}
              profileLoading={neighborhoodProfileLoading}
              profileMessage={neighborhoodProfileMessage}
              boundarySuggestions={neighborhoodBoundarySuggestions}
              customAreaAvailable={Boolean(
                assignmentDraft.neighborhood_boundary_geometry ||
                customMarketStudy?.market.custom_geometry
              )}
              assignmentDirty={assignmentDirty}
              assignmentSaveMessage={assignmentSaveMessage}
              assignmentSaveDisabled={assignmentSaveDisabled}
              savingAssignmentFile={savingAssignmentFile}
              onAssignmentChange={updateAssignment}
              onRefreshUnemployment={() => void lookupUnemploymentComparison()}
              onRefreshBoundary={() => void refreshNeighborhoodProfile()}
              onBoundarySuggestionsChange={setNeighborhoodBoundarySuggestions}
              onConfirmBoundary={confirmNeighborhoodBoundary}
              marketConditionsDraft={marketConditionsDraft}
              highestBestUseContext={{
                zoning: String(primaryZoning || ""),
                currentUse: [
                  housing?.housing_type,
                  housing?.structural_style,
                  ...landRows.map((row) => row.state_code),
                ].filter(Boolean).join(" "),
              }}
              valuePositionContext={{
                concludedValue: salesComparisonValue,
                source: salesComparisonValueSource,
                subjectGla,
                subjectAge,
                subjectQuality: String(salesComparisonDraft?.subject?.quality || ""),
              }}
              onMarketConditionsChange={updateMarketConditions}
              onSave={() => void saveAssignmentFromSection()}
                />
              </Suspense>
            </SummarySection>
          </DeferredReportSection>

          <SummarySection
            title="CAD Values, Taxes, and Exemptions"
            subtitle={`Certified tax year ${displayValue(
              values?.certified_year || detail?.tax_year,
            )}`}
            actions={(
              <div className="flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  onClick={() => editSection("report.appraisal_values")}
                  className="hn-action-secondary btn btn-sm normal-case"
                >
                  Edit Values
                </button>
                <button
                  type="button"
                  onClick={() => editSection("report.exemptions")}
                  className="hn-action-secondary btn btn-sm normal-case"
                >
                  Edit Taxes &amp; Exemptions
                </button>
              </div>
            )}
            manuallyVerified={Boolean(
              detail?.report_manual_values?.["report.appraisal_values"] ||
              detail?.report_manual_values?.["report.exemptions"],
            )}
            collapsible
            defaultExpanded={false}
            className="order-6"
          >
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <SummaryField label="Market Value" value={formatMoney(values?.market_value)} />
              <SummaryField
                label="Assessed / Capped Value"
                value={formatMoney(values?.capped_value || values?.market_value)}
              />
              <SummaryField label="Improvement Value" value={formatMoney(values?.improvement_value)} />
              <SummaryField label="CAD Land Value" value={formatMoney(values?.land_value)} />
            </div>

            <div className="mt-5 border-t border-slate-200 pt-4">
              <div className="mb-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
                <SummaryField label="Homestead" value={homestead ? "Yes" : "No"} />
                <SummaryField
                  label="Taxing Units with Exemption"
                  value={new Intl.NumberFormat("en-US").format(exemptJurisdictionCount)}
                />
              </div>

              {exemptionRows.length ? (
                <div>
                  <div
                    className="grid gap-x-6 border-b border-slate-300 pb-2 text-xs font-semibold uppercase tracking-wide text-slate-600"
                    style={{ gridTemplateColumns: "minmax(180px,1.4fr) minmax(160px,1fr) minmax(160px,1fr)" }}
                  >
                    <div>Taxing Unit</div>
                    <div className="text-right">Homestead Exemption</div>
                    <div className="text-right">Taxable Value</div>
                  </div>
                  {exemptionRows.map(({ key, fallbackLabel, row }) => (
                    <div
                      key={key}
                      className="grid gap-x-6 border-b border-slate-200 py-2.5 text-sm last:border-b-0"
                      style={{ gridTemplateColumns: "minmax(180px,1.4fr) minmax(160px,1fr) minmax(160px,1fr)" }}
                    >
                      <div>{displayValue(row?.taxing_jurisdiction, fallbackLabel)}</div>
                      <div className="text-right">{formatMoney(row?.homestead_exemption)}</div>
                      <div className="text-right">{formatMoney(row?.taxable_value)}</div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-slate-600">
                  No current exemption or taxable-value records were returned for this parcel.
                </p>
              )}
            </div>
          </SummarySection>
        </div>

        <div className="mt-6 grid grid-cols-1 gap-2 border-t border-slate-200 pt-5 sm:grid-cols-2 xl:grid-cols-6">
          <a
            href={
              accountId
                ? `/ComparableSalesAnalysis?propertyId=${encodeURIComponent(accountId)}${
                    activeAssignmentFile
                      ? `&assignmentFileId=${encodeURIComponent(String(activeAssignmentFile.id))}`
                      : ""
                  }`
                : "#"
            }
            aria-label="Sales Comparison Approach"
            aria-disabled={!accountId}
            className={`hn-custom-approach-link btn normal-case rounded-md px-4 py-2 ${
              accountId
                ? "border-emerald-600 bg-emerald-600 text-white hover:border-emerald-700 hover:bg-emerald-700"
                : "pointer-events-none border-slate-200 bg-slate-200 text-slate-500"
            }`}
          >
            Sales Comparison Approach
          </a>
          <a
            href={
              accountId
                ? `/CostApproach?propertyId=${encodeURIComponent(accountId)}${
                    activeAssignmentFile
                      ? `&assignmentFileId=${encodeURIComponent(String(activeAssignmentFile.id))}`
                      : ""
                  }`
                : "#"
            }
            aria-label="Cost Approach"
            aria-disabled={!accountId}
            className={`hn-custom-approach-link btn normal-case rounded-md px-4 py-2 ${
              accountId
                ? "border-slate-900 bg-slate-900 text-white hover:border-slate-950 hover:bg-slate-950"
                : "pointer-events-none border-slate-200 bg-slate-200 text-slate-500"
            }`}
          >
            Cost Approach
          </a>
          <a
            href={
              accountId
                ? `/IncomeApproach?propertyId=${encodeURIComponent(accountId)}${
                    activeAssignmentFile
                      ? `&assignmentFileId=${encodeURIComponent(String(activeAssignmentFile.id))}`
                      : ""
                  }`
                : "#"
            }
            aria-label="Income Approach"
            aria-disabled={!accountId}
            className={`hn-custom-approach-link btn normal-case rounded-md px-4 py-2 ${
              accountId
                ? "border-slate-900 bg-slate-900 text-white hover:border-slate-950 hover:bg-slate-950"
                : "pointer-events-none border-slate-200 bg-slate-200 text-slate-500"
            }`}
          >
            Income Approach
          </a>
          <a
            href={
              accountId
                ? `/FinalReconciliation?propertyId=${encodeURIComponent(accountId)}${
                    activeAssignmentFile
                      ? `&assignmentFileId=${encodeURIComponent(String(activeAssignmentFile.id))}`
                      : ""
                  }`
                : "#"
            }
            aria-label="Final Reconciliation"
            aria-disabled={!accountId}
            className={`hn-custom-approach-link btn normal-case rounded-md px-4 py-2 ${
              accountId
                ? "border-violet-700 bg-violet-700 text-white hover:border-violet-800 hover:bg-violet-800"
                : "pointer-events-none border-slate-200 bg-slate-200 text-slate-500"
            }`}
          >
            Final Reconciliation
          </a>
          <a
            href={protestUrl}
            aria-label="Property Tax Protest"
            className="hn-custom-approach-link btn normal-case rounded-md px-4 py-2"
          >
            Property Tax Protest
          </a>
          <a
            href={
              accountId
                ? `/AppraisalReport?propertyId=${encodeURIComponent(accountId)}${
                    appraisalReportAssignmentFile
                      ? `&assignmentFileId=${encodeURIComponent(String(appraisalReportAssignmentFile.id))}`
                      : ""
                  }`
                : "#"
            }
            aria-label="Full Appraisal PDF"
            aria-disabled={!accountId}
            title={neighborhoodBoundaryErrors.length
              ? `PDF printing will be blocked until: ${neighborhoodBoundaryErrors.join(" ")}`
              : "Open the full appraisal report"}
            className={`btn normal-case rounded-md px-4 py-2 ${
              accountId
                ? neighborhoodBoundaryErrors.length
                  ? "border-amber-500 bg-amber-100 text-amber-950 hover:bg-amber-200"
                  : "border-slate-900 bg-slate-900 text-white hover:border-slate-950 hover:bg-slate-950"
                : "pointer-events-none border-slate-200 bg-slate-200 text-slate-500"
            }`}
          >
            {neighborhoodBoundaryErrors.length ? "PDF Setup Required" : "Full Appraisal PDF"}
          </a>
        </div>
      </div>
      {editingSection ? (
        <ReportSectionEditor
          section={editingSection}
          initialValue={editableSectionValue(editingSection.key)}
          saving={savingSection}
          onCancel={cancelEditingSection}
          onSave={saveEditedSection}
        />
      ) : null}
      {assignmentChooserOpen ? (
        <ReportTypeChooser
          subject={{
            accountId: accountId || "",
            address: exactAddress || `Account ${accountId || ""}`,
            ownerName: detail?.owner?.owner_name || null,
          }}
          onClose={() => setAssignmentChooserOpen(false)}
        />
      ) : null}
    </div>
  );
}

export default function PropertyReport() {
  const location = useLocation();
  const { accountId: routeAccountId } = useParams<{ accountId?: string }>();
  const reportOpenedAt = useRef(performance.now());
  const subjectVisibleReported = useRef(false);

  const presetAccount = useMemo(() => {
    if (routeAccountId) return routeAccountId;
    const params = new URLSearchParams(location.search);
    return params.get("account_id") || params.get("account") || "";
  }, [location.search, routeAccountId]);
  const requestedAssignmentFileId = useMemo(() => {
    const params = new URLSearchParams(location.search);
    const parsed = Number(params.get("assignmentFileId"));
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }, [location.search]);

  const account = presetAccount;
  const { detail, reloadDetail } = usePropertyReportDetail<DcadDetail>({
    accountId: account,
    onError: (error) => {
      console.error(error);
      window.alert(error instanceof Error ? error.message : "Import failed");
    },
  });

  useEffect(() => {
    subjectVisibleReported.current = false;
    reportOpenedAt.current = performance.now();
  }, [account]);

  useEffect(() => {
    if (!detail || subjectVisibleReported.current) return;
    const frame = window.requestAnimationFrame(() => {
      subjectVisibleReported.current = true;
      const durationMs = Math.round((performance.now() - reportOpenedAt.current) * 10) / 10;
      performance.clearMeasures("homenode-property-report-subject-visible");
      performance.measure("homenode-property-report-subject-visible", {
        start: reportOpenedAt.current,
        end: performance.now(),
      });
      console.info("[performance] property report subject visible", { duration_ms: durationMs });
      window.dispatchEvent(new CustomEvent("homenode:report-subject-visible", {
        detail: { duration_ms: durationMs },
      }));
    });
    return () => window.cancelAnimationFrame(frame);
  }, [detail]);

  return (
    <div className="hn-app-shell">
      <div className="hn-app-header navbar shadow-sm">
        <div className="mx-auto w-full max-w-[1600px] px-4">
          <div className="flex w-full items-center justify-between">
            <div>
              <span className="hn-eyebrow block text-[10px]">HomeNode</span>
              <span className="block text-xl font-semibold">Custom Appraisal Workspace</span>
            </div>
            <a href="/" className="hn-action-secondary btn btn-ghost btn-sm normal-case">
              ← Close Report
            </a>
          </div>
        </div>
      </div>

      <main
        className="mx-auto w-full max-w-[1600px] space-y-4 px-4 py-4"
        data-report-subject-loaded={detail ? "true" : "false"}
      >
        <AddressHero
          detail={detail}
          accountId={account}
          requestedAssignmentFileId={requestedAssignmentFileId}
          onReload={reloadDetail}
        />
      </main>
    </div>
  );
}


