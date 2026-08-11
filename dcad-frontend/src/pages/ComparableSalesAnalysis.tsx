import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import type { ReactNode } from 'react';
import * as api from '@/lib/api';
import type {
  ComparableRecommendationsResponse,
  ComparableSearchProfileKey,
  SalePhoto,
  SaleRow,
} from '@/lib/api';
import GroupedAdjustmentAnalysis, {
  type AppliedGroupedAdjustment,
  type GroupedAdjustmentImpactPreview,
} from '@/components/GroupedAdjustmentAnalysis';
import type { AppraiserDefinedAdjustmentArea } from '@/components/PairedSalesAnalysis';
import ConditionQualityStudy, {
  type ConditionQualityImpactPreview,
  type ConditionQualityRatingAssignment,
} from '@/components/ConditionQualityStudy';
import ComparableSalesMap from '@/components/ComparableSalesMap';
import { fetchDetail } from '@/lib/dcad';
import { formatBathCount, parseWholeCount } from '@/lib/propertyCharacteristics';
import {
  bathroomEquivalentValue,
  calculateNumericGroupedAdjustment,
} from '@/lib/comparableAdjustments';
import {
  normalizeUadRating,
  UAD_CONDITION_RATINGS,
  UAD_QUALITY_RATINGS,
} from '@/lib/conditionQualityRatings';
import {
  calculateRatingAdjustment,
  conditionQualitySaleKey,
  type AppliedConditionQualityAdjustment,
} from '@/lib/conditionQualityStudy';
import {
  readAppraisalReportDraft,
  saveAppraisalReportDraft,
} from '@/lib/appraisalReportDraft';
import {
  readMarketConditionsDraft,
  type MarketConditionsDraft,
} from '@/lib/marketConditionsDraft';
import { resolveComparableCharacteristic } from '@/lib/propertySourceResolution';

const COMPARABLE_COUNT = 6;
const LISTING_COUNT = 6;
type SalesAnalysisPeriodMonths = 12 | 24 | 36;
type ComparableSearchProfileOption = {
  key: ComparableSearchProfileKey;
  label: string;
  geography: 'Urban' | 'Suburban' | 'Semi-Rural' | 'Rural';
  radiusMiles: number;
};
const COMPARABLE_SEARCH_PROFILE_OPTIONS: readonly ComparableSearchProfileOption[] = [
  { key: 'urban_simple', label: 'Urban - Simple', geography: 'Urban', radiusMiles: 1 },
  { key: 'urban_moderate', label: 'Urban - Moderate', geography: 'Urban', radiusMiles: 2 },
  { key: 'urban_complex', label: 'Urban - Complex', geography: 'Urban', radiusMiles: 3 },
  { key: 'suburban_simple', label: 'Suburban - Simple', geography: 'Suburban', radiusMiles: 2 },
  { key: 'suburban_moderate', label: 'Suburban - Moderate', geography: 'Suburban', radiusMiles: 5 },
  { key: 'suburban_complex', label: 'Suburban - Complex', geography: 'Suburban', radiusMiles: 10 },
  { key: 'semi_rural_simple', label: 'Semi-Rural - Simple', geography: 'Semi-Rural', radiusMiles: 5 },
  { key: 'semi_rural_moderate', label: 'Semi-Rural - Moderate', geography: 'Semi-Rural', radiusMiles: 10 },
  { key: 'semi_rural_complex', label: 'Semi-Rural - Complex', geography: 'Semi-Rural', radiusMiles: 20 },
  { key: 'rural_simple', label: 'Rural - Simple', geography: 'Rural', radiusMiles: 10 },
  { key: 'rural_moderate', label: 'Rural - Moderate', geography: 'Rural', radiusMiles: 25 },
  { key: 'rural_complex', label: 'Rural - Complex', geography: 'Rural', radiusMiles: 50 },
];
const COMPARABLE_SEARCH_GEOGRAPHIES = ['Urban', 'Suburban', 'Semi-Rural', 'Rural'] as const;
const DEFAULT_SALES_NOTES =
  "Comparable sales are analyzed based on the subject's condition to provide the best comparisons possible.";
const DEFAULT_ADJUSTMENT_NOTES =
  'Applied adjustments for time/date of sale, neighborhood, gross living area, room and bath count, condition, quality, and feature differences based on market-supported evidence.';

type CostToCureLine = {
  id: string;
  description: string;
  cost: string;
};

let costToCureLineSequence = 0;

function createCostToCureLine(
  description = '',
  cost: string | number = '',
): CostToCureLine {
  costToCureLineSequence += 1;
  return {
    id: `repair-${Date.now()}-${costToCureLineSequence}`,
    description,
    cost: cost === '' ? '' : String(cost),
  };
}

function swapArrayItems<T>(values: T[], from: number, to: number): T[] {
  const next = [...values];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

function compactComparableSlots<T>(
  values: T[],
  retainedSlots: number[],
  createEmptyValue: () => T,
): T[] {
  return [
    ...retainedSlots.map((slot) => values[slot]),
    ...Array.from(
      { length: Math.max(0, COMPARABLE_COUNT - retainedSlots.length) },
      createEmptyValue,
    ),
  ];
}

function localDateString(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function monthsBeforeDate(value: string, months: SalesAnalysisPeriodMonths): string {
  const date = new Date(`${value}T12:00:00`);
  if (Number.isNaN(date.getTime())) return '';
  const originalDay = date.getDate();
  date.setDate(1);
  date.setMonth(date.getMonth() - months);
  const finalDay = new Date(
    date.getFullYear(),
    date.getMonth() + 1,
    0,
  ).getDate();
  date.setDate(Math.min(originalDay, finalDay));
  return localDateString(date);
}

type SubjectData = {
  accountId: string;
  address?: string | null;
  total_living_area?: number | string | null;
  market_value?: number | string | null;
  nbhd_code?: string | null;
  land_size_sqft?: number | null;
  view?: string | null;
  construction_type?: string | null;
  building_class?: string | null;
  actual_age?: number | string | null;
  stories?: number | string | null;
  bedroom_count?: number | string | null;
  baths_full?: number | string | null;
  baths_half?: number | string | null;
  bath_count?: number | string | null;
  basement?: boolean | string | null;
  basement_raw?: string | null;
  heating?: string | null;
  air_conditioning?: string | null;
  basement_sqft?: number | null;
  solar_panels?: boolean | null;
  solar_area_sqft?: number | null;
  garage_area_sqft?: number | null;
  pool?: boolean | string | null;
  structural_style?: string | null;
  housing_type?: string | null;
  attachment_type?: 'detached' | 'attached' | 'mixed' | 'unknown' | null;
  architectural_style?: string | null;
};

type HousingEditForm = {
  housingType: string;
  attachmentType: 'detached' | 'attached' | 'mixed' | 'unknown';
  architecturalStyle: string;
  sourceUrl: string;
  notes: string;
};

const HOUSING_TYPE_OPTIONS = [
  'Single Family Detached',
  'Single Family Attached',
  'Condo/Townhome',
  'Duplex',
  'Multi-Family',
  'Garden/Zero Lot Line',
  'Farm/Ranch House',
  'Other',
];

function normalizeUadConditionRating(value: unknown): string {
  return normalizeUadRating(value, 'condition');
}

function UadRatingSelect({
  ariaLabel,
  value,
  ratings,
  onChange,
  disabled = false,
}: {
  ariaLabel: string;
  value: string;
  ratings: readonly string[];
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <select
      aria-label={ariaLabel}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      disabled={disabled}
      className="w-full min-w-[4.75rem] rounded-md border border-slate-300 bg-white px-2 py-1 text-sm text-slate-800 shadow-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
    >
      <option value="">Select</option>
      {ratings.map((rating) => (
        <option key={rating} value={rating}>
          {rating}
        </option>
      ))}
    </select>
  );
}

type GalleryState = {
  title: string;
  photos: SalePhoto[];
  index: number;
  loading: boolean;
  error: string | null;
};

function MlsPhoto({
  src,
  alt,
  photoCount = 0,
  onOpen,
  compact = false,
}: {
  src?: string | null;
  alt: string;
  photoCount?: number;
  onOpen?: () => void;
  compact?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);

  const size = compact ? 'h-16 w-24' : 'h-28 w-full min-w-0';
  if (!src || failed) {
    return (
      <div
        className={`${size} flex items-center justify-center rounded-lg border border-dashed border-slate-300 bg-slate-50 px-2 text-center text-[11px] font-medium text-slate-500`}
        aria-label={`${alt}: MLS photo unavailable`}
      >
        MLS photo unavailable
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={!onOpen}
      className={`${size} group relative overflow-hidden rounded-lg border border-slate-200 bg-slate-100 text-left shadow-sm disabled:cursor-default`}
      aria-label={`View ${photoCount || 1} MLS photo${photoCount === 1 ? '' : 's'} for ${alt}`}
    >
      <img
        src={src}
        alt={alt}
        loading="lazy"
        className="h-full w-full object-cover transition-transform duration-200 group-enabled:hover:scale-[1.03]"
        onError={() => setFailed(true)}
      />
      {onOpen && (
        <span className="absolute bottom-1.5 right-1.5 rounded-full bg-slate-950/80 px-2 py-0.5 text-[10px] font-semibold text-white">
          View {photoCount || 1}
        </span>
      )}
    </button>
  );
}

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(String(value).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function booleanValue(value: unknown): boolean | null {
  if (value === true || value === false) return value;
  const normalized = String(value ?? '').trim().toLowerCase();
  if (['true', 't', 'yes', 'y', '1'].includes(normalized)) return true;
  if (['false', 'f', 'no', 'n', '0', 'none'].includes(normalized)) return false;
  return null;
}

function garageSpacesFromArea(value: unknown): number | null {
  const area = finiteNumber(value);
  if (area === null || area <= 0) return null;
  return Math.max(1, Math.min(12, Math.round(area / 225)));
}

function calculatePoolGroupedAdjustment(
  adjustments: AppliedGroupedAdjustment[],
  subjectValue: boolean | null,
  comparableValue: boolean | null,
): number {
  if (subjectValue === null || comparableValue === null || subjectValue === comparableValue) return 0;
  const poolAdjustment = adjustments
    .filter((adjustment) => adjustment.dimensionKey === 'pool')
    .reduce((total, adjustment) => total + adjustment.amount, 0);
  return subjectValue ? poolAdjustment : -poolAdjustment;
}

function calculateLivingAreaGroupedAdjustment(
  adjustments: AppliedGroupedAdjustment[],
  subjectValue: number | null,
  comparableValue: number | null,
): number {
  if (subjectValue === null || comparableValue === null || subjectValue === comparableValue) return 0;
  const eligibleAdjustments = adjustments.filter(
    (adjustment) => adjustment.dimensionKey === 'living_area',
  );
  const selectedAdjustment = eligibleAdjustments[eligibleAdjustments.length - 1];
  if (!selectedAdjustment) return 0;
  const signedDifference = (subjectValue - comparableValue) * selectedAdjustment.amount;
  return Math.round(signedDifference / 100) * 100;
}

export default function ComparableSalesAnalysis() {
  const location = useLocation();
  const navigate = useNavigate();
  const propertyId = useMemo(() => {
    const p = new URLSearchParams(location.search);
    return p.get('propertyId') || '';
  }, [location.search]);
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }, [propertyId]);
  // Read the property-report condition choice and normalize it to a valid UAD C1-C6 rating.
  const conditionCode = useMemo(() => {
    const p = new URLSearchParams(location.search);
    return p.get('condCode') || '';
  }, [location.search]);
const [subject, setSubject] = useState<SubjectData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const salesSearchInputRef = useRef<HTMLInputElement | null>(null);
  const [subjectPhotos, setSubjectPhotos] = useState<SalePhoto[]>([]);
  const [gallery, setGallery] = useState<GalleryState | null>(null);
  const [summary, setSummary] = useState('');
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [salesNotes, setSalesNotes] = useState(DEFAULT_SALES_NOTES);
  const [adjustmentNotes, setAdjustmentNotes] = useState(DEFAULT_ADJUSTMENT_NOTES);
  const [ctcNotes, setCtcNotes] = useState('');
  const [costToCureItems, setCostToCureItems] = useState<CostToCureLine[]>(
    () => [createCostToCureLine()],
  );
  // Normalizes the subject's construction/stories into a label for the grid.
  // NOTE: Per request, if Const Type contains "ONE AND ONE HALF STORIES",
  //       we display it as "2 Story".
  const normalizeConstType = (stories: unknown, construction: unknown): string => {
    const toStr = (v: any) => (v === null || v === undefined ? '' : String(v)).trim();
    const sStr = toStr(stories).toLowerCase();
    const cStr = toStr(construction).toLowerCase();

    // Try stories first (number or text)
    if (sStr) {
      const n = Number(sStr.replace(/[^0-9.]/g, ''));
      if (Number.isFinite(n) && n > 0) {
        return n >= 2 ? '2 Story' : '1 Story';
      }
      if (sStr.includes('two') || sStr.includes('2')) return '2 Story';
      if (sStr.includes('one and one half')) return '2 Story';
      if (sStr.includes('one') || sStr.includes('1')) return '1 Story';
    }

    // Fall back to construction type text
    if (cStr) {
      if (cStr.includes('one and one half')) return '2 Story';
      if (cStr.includes('two') || cStr.includes('2')) return '2 Story';
      if (cStr.includes('one') || cStr.includes('1')) return '1 Story';
    }
    return '';
  };
  // Test/Run controls and sample comparables
  const [subjectCondition, setSubjectCondition] = useState(() =>
    normalizeUadConditionRating(conditionCode),
  );
  const [subjectQuality, setSubjectQuality] = useState('');
  const [draftSubjectCondition, setDraftSubjectCondition] = useState(() =>
    normalizeUadConditionRating(conditionCode),
  );
  const [draftSubjectQuality, setDraftSubjectQuality] = useState('');
  const [compConditions, setCompConditions] = useState<string[]>(
    () => Array(COMPARABLE_COUNT).fill(''),
  );
  const [compQualities, setCompQualities] = useState<string[]>(
    () => Array(COMPARABLE_COUNT).fill(''),
  );
  const [conditionQualityRatings, setConditionQualityRatings] = useState<
    Record<string, ConditionQualityRatingAssignment>
  >({});
  const [appliedConditionQualityAdjustments, setAppliedConditionQualityAdjustments] =
    useState<Partial<Record<'condition' | 'quality', AppliedConditionQualityAdjustment>>>({});
  const [compAddresses, setCompAddresses] = useState<string[]>(() => Array(COMPARABLE_COUNT).fill(''));
  const [compGla, setCompGla] = useState<Array<number | null>>(() => Array(COMPARABLE_COUNT).fill(null));
  const [compPrices, setCompPrices] = useState<Array<number | null>>(() => Array(COMPARABLE_COUNT).fill(null));
  const [compConcessions, setCompConcessions] = useState<Array<number | null>>(() => Array(COMPARABLE_COUNT).fill(null));
  // Date of Sale/Time adjustments per comparable (can be positive or negative)
  const [compTimeAdjustments, setCompTimeAdjustments] = useState<Array<number | null>>(() => Array(COMPARABLE_COUNT).fill(null));
  const [compSaleDates, setCompSaleDates] = useState<string[]>(() => Array(COMPARABLE_COUNT).fill(''));
  const [compLandSize, setCompLandSize] = useState<Array<number | null>>(() => Array(COMPARABLE_COUNT).fill(null));
  // Test-mode comparable ages for the "Age/Effective" row
  const [compAges, setCompAges] = useState<Array<number | null>>(() => Array(COMPARABLE_COUNT).fill(null));
  // Test-mode comparable garage areas
  const [compGarage, setCompGarage] = useState<Array<number | null>>(() => Array(COMPARABLE_COUNT).fill(null));
  const [compRooms, setCompRooms] = useState<Array<{ tot: number | null; bd: number | null; full: number | null; half: number | null }>>(
    () => Array.from({ length: COMPARABLE_COUNT }, () => ({ tot: null, bd: null, full: null, half: null })),
  );
  const [salesQuery, setSalesQuery] = useState('');
  const [salesAnalysisAsOf, setSalesAnalysisAsOf] = useState(() => localDateString());
  const [salesPeriodMonths, setSalesPeriodMonths] =
    useState<SalesAnalysisPeriodMonths>(12);
  const [comparableSearchProfile, setComparableSearchProfile] =
    useState<ComparableSearchProfileKey | ''>('');
  const selectedComparableSearchProfile = useMemo(
    () => COMPARABLE_SEARCH_PROFILE_OPTIONS.find(
      (profile) => profile.key === comparableSearchProfile,
    ) || null,
    [comparableSearchProfile],
  );
  const salesDateFrom = useMemo(
    () => monthsBeforeDate(salesAnalysisAsOf, salesPeriodMonths),
    [salesAnalysisAsOf, salesPeriodMonths],
  );
  const [includeUnmatchedSales, setIncludeUnmatchedSales] = useState(false);
  const [sameNeighborhoodOnly, setSameNeighborhoodOnly] = useState(false);
  const [outlierScoreThreshold, setOutlierScoreThreshold] = useState(60);
  const [salesResults, setSalesResults] = useState<SaleRow[]>([]);
  const [selectedSales, setSelectedSales] = useState<Array<SaleRow | null>>(
    () => Array(COMPARABLE_COUNT).fill(null),
  );
  const [recommendationDetailsExpanded, setRecommendationDetailsExpanded] =
    useState(false);
  const [listingQuery, setListingQuery] = useState('');
  const [listingResults, setListingResults] = useState<SaleRow[]>([]);
  const [selectedListings, setSelectedListings] = useState<Array<SaleRow | null>>(
    () => Array(LISTING_COUNT).fill(null),
  );
  const [listingLoading, setListingLoading] = useState(false);
  const [listingError, setListingError] = useState<string | null>(null);
  const [listingNotice, setListingNotice] = useState<string | null>(null);
  const [appliedGroupedAdjustments, setAppliedGroupedAdjustments] = useState<
    Record<string, AppliedGroupedAdjustment>
  >({});
  const [salesLoading, setSalesLoading] = useState(false);
  const [salesError, setSalesError] = useState<string | null>(null);
  const [salesNotice, setSalesNotice] = useState<string | null>(null);
  const [recommendationSummary, setRecommendationSummary] = useState<ComparableRecommendationsResponse | null>(null);
  const [competitiveReplacementSale, setCompetitiveReplacementSale] =
    useState<SaleRow | null>(null);
  const [marketConditionsDraft, setMarketConditionsDraft] =
    useState<MarketConditionsDraft | null>(() =>
      readMarketConditionsDraft(propertyId),
    );
  const [editingHousingSale, setEditingHousingSale] = useState<SaleRow | null>(null);
  const [housingEditForm, setHousingEditForm] = useState<HousingEditForm>({
    housingType: '',
    attachmentType: 'unknown',
    architecturalStyle: '',
    sourceUrl: '',
    notes: '',
  });
  const [housingEditorKey, setHousingEditorKey] = useState(() => {
    try {
      return window.sessionStorage.getItem('homenode-editor-key') || '';
    } catch {
      return '';
    }
  });
  const [housingEditSaving, setHousingEditSaving] = useState(false);
  const [housingEditError, setHousingEditError] = useState<string | null>(null);
  const [savedSubjectRating, setSavedSubjectRating] =
    useState<api.SubjectAppraisalRating | null>(null);
  const [savedConditionQualityRatings, setSavedConditionQualityRatings] = useState<
    Record<string, ConditionQualityRatingAssignment>
  >({});
  const [saleReviewMetadata, setSaleReviewMetadata] = useState<
    Record<string, api.AppraisalRatingReview>
  >({});
  const [ratingSaleSources, setRatingSaleSources] = useState<Record<string, SaleRow>>({});
  const [dirtyRatingKeys, setDirtyRatingKeys] = useState<Record<string, true>>({});
  const [subjectRatingDirty, setSubjectRatingDirty] = useState(false);
  const [ratingPersistenceLoading, setRatingPersistenceLoading] = useState(false);
  const [ratingPersistenceSaving, setRatingPersistenceSaving] = useState(false);
  const [ratingPersistenceError, setRatingPersistenceError] = useState<string | null>(null);
  const [ratingsSavedAt, setRatingsSavedAt] = useState<string | null>(null);

  useEffect(() => {
    setComparableSearchProfile('');
    setRecommendationDetailsExpanded(false);
    setRecommendationSummary(null);
    setSalesResults([]);
    setAppliedGroupedAdjustments({});
    setAppliedConditionQualityAdjustments({});
    setConditionQualityRatings({});
    setSavedConditionQualityRatings({});
    setSaleReviewMetadata({});
    setRatingSaleSources({});
    setDirtyRatingKeys({});
    setSavedSubjectRating(null);
    setSubjectRatingDirty(false);
    setRatingPersistenceError(null);
    setRatingsSavedAt(null);
    setListingQuery('');
    setListingResults([]);
    setSelectedListings(Array(LISTING_COUNT).fill(null));
    setListingError(null);
    setListingNotice(null);
  }, [propertyId]);

  useEffect(() => {
    setMarketConditionsDraft(readMarketConditionsDraft(propertyId));
  }, [propertyId]);

  const appraiserDefinedAdjustmentArea = useMemo<AppraiserDefinedAdjustmentArea | null>(() => {
    const customStudy = marketConditionsDraft?.response.analyses.find(
      (analysis) => analysis.market.key === 'custom',
    );
    const geometry = customStudy?.market.custom_geometry;
    if (!geometry) return null;
    return {
      geometry,
      label: customStudy.market.label || 'Appraiser-defined market area',
      asOfDate: marketConditionsDraft?.asOfDate,
    };
  }, [marketConditionsDraft]);

  useEffect(() => {
    const normalizedCondition = normalizeUadConditionRating(conditionCode);
    setSubjectCondition(normalizedCondition);
    setSubjectQuality('');
    setDraftSubjectCondition(normalizedCondition);
    setDraftSubjectQuality('');
    setCompConditions(Array(COMPARABLE_COUNT).fill(''));
    setCompQualities(Array(COMPARABLE_COUNT).fill(''));
  }, [conditionCode, propertyId]);

  useEffect(() => {
    let cancelled = false;
    if (!propertyId || !salesAnalysisAsOf) return () => { cancelled = true; };
    setRatingPersistenceLoading(true);
    void api.getSubjectAppraisalRating(propertyId, salesAnalysisAsOf)
      .then((rating) => {
        if (cancelled) return;
        setSavedSubjectRating(rating);
        setSubjectRatingDirty(false);
        if (rating) {
          const condition = rating.condition_rating || '';
          const quality = rating.quality_rating || '';
          setSubjectCondition(condition);
          setSubjectQuality(quality);
          setDraftSubjectCondition(condition);
          setDraftSubjectQuality(quality);
          setRatingsSavedAt(rating.updated_at || null);
        } else {
          const condition = normalizeUadConditionRating(conditionCode);
          setSubjectCondition(condition);
          setSubjectQuality('');
          setDraftSubjectCondition(condition);
          setDraftSubjectQuality('');
          setRatingsSavedAt(null);
        }
      })
      .catch((loadError) => {
        if (!cancelled) {
          setRatingPersistenceError(
            loadError instanceof Error ? loadError.message : 'Saved subject ratings could not be loaded.',
          );
        }
      })
      .finally(() => {
        if (!cancelled) setRatingPersistenceLoading(false);
      });
    return () => { cancelled = true; };
  }, [conditionCode, propertyId, salesAnalysisAsOf]);

  useEffect(() => {
    let cancelled = false;
    setSubjectPhotos([]);
    if (!propertyId) return () => { cancelled = true; };
    void api.getAccountPhotos(propertyId)
      .then((response) => {
        if (!cancelled) setSubjectPhotos(response.photos || []);
      })
      .catch(() => {
        if (!cancelled) setSubjectPhotos([]);
      });
    return () => { cancelled = true; };
  }, [propertyId]);

  useEffect(() => {
    if (!gallery) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setGallery(null);
      } else if (event.key === 'ArrowLeft' && gallery.photos.length > 1) {
        setGallery((current) => current ? {
          ...current,
          index: (current.index - 1 + current.photos.length) % current.photos.length,
        } : current);
      } else if (event.key === 'ArrowRight' && gallery.photos.length > 1) {
        setGallery((current) => current ? {
          ...current,
          index: (current.index + 1) % current.photos.length,
        } : current);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [gallery]);

  const registerSavedSaleRatings = async (sales: SaleRow[]) => {
    const reviewable = sales.filter((sale) => sale.source_record_id != null);
    if (!reviewable.length) return;
    const saleBySourceId = new Map(
      reviewable.map((sale) => [String(sale.source_record_id), sale]),
    );
    setRatingSaleSources((current) => {
      const next = { ...current };
      reviewable.forEach((sale) => {
        next[conditionQualitySaleKey(sale)] = sale;
      });
      return next;
    });
    try {
      const reviews = await api.getSaleAppraisalReviews([...saleBySourceId.keys()]);
      const assignments: Record<string, ConditionQualityRatingAssignment> = {};
      const metadata: Record<string, api.AppraisalRatingReview> = {};
      const reviewBySourceId = new Map<string, api.AppraisalRatingReview>();
      reviews.forEach((review) => {
        reviewBySourceId.set(String(review.source_record_id), review);
        const sale = saleBySourceId.get(String(review.source_record_id));
        if (!sale) return;
        const key = conditionQualitySaleKey(sale);
        assignments[key] = {
          condition: review.condition_rating || '',
          quality: review.quality_rating || '',
        };
        metadata[key] = review;
      });
      setSavedConditionQualityRatings((current) => ({ ...current, ...assignments }));
      setSaleReviewMetadata((current) => ({ ...current, ...metadata }));
      setConditionQualityRatings((current) => {
        const next = { ...current };
        Object.entries(assignments).forEach(([key, assignment]) => {
          if (!dirtyRatingKeys[key]) next[key] = assignment;
        });
        return next;
      });
      setCompConditions((current) => current.map((value, index) => {
        const sale = selectedSales[index];
        if (!sale?.source_record_id) return value;
        const review = reviewBySourceId.get(String(sale.source_record_id));
        return review && !dirtyRatingKeys[conditionQualitySaleKey(sale)]
          ? (review.condition_rating || '')
          : value;
      }));
      setCompQualities((current) => current.map((value, index) => {
        const sale = selectedSales[index];
        if (!sale?.source_record_id) return value;
        const review = reviewBySourceId.get(String(sale.source_record_id));
        return review && !dirtyRatingKeys[conditionQualitySaleKey(sale)]
          ? (review.quality_rating || '')
          : value;
      }));
    } catch (loadError) {
      setRatingPersistenceError(
        loadError instanceof Error ? loadError.message : 'Saved comparable ratings could not be loaded.',
      );
    }
  };

  const reviewableSales = useMemo(() => {
    const byKey = new Map<string, SaleRow>();
    [
      ...salesResults,
      ...(recommendationSummary?.sales || []),
      ...(recommendationSummary?.recommended_sales || []),
      ...(recommendationSummary?.competitive_sales || []),
      ...selectedSales.filter((sale): sale is SaleRow => Boolean(sale)),
      ...listingResults,
      ...selectedListings.filter((sale): sale is SaleRow => Boolean(sale)),
    ].forEach((sale) => byKey.set(conditionQualitySaleKey(sale), sale));
    return [...byKey.values()];
  }, [salesResults, recommendationSummary, selectedSales, listingResults, selectedListings]);

  const reviewableSourceIdKey = useMemo(
    () => reviewableSales
      .flatMap((sale) => sale.source_record_id == null ? [] : [String(sale.source_record_id)])
      .sort()
      .join(','),
    [reviewableSales],
  );

  useEffect(() => {
    if (!reviewableSourceIdKey) return;
    void registerSavedSaleRatings(reviewableSales);
    // The stable source-id key avoids reloading after unrelated score/display changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewableSourceIdKey]);

  const openSubjectGallery = () => {
    if (!subjectPhotos.length) return;
    setGallery({
      title: subject?.address || propertyId || 'Subject property',
      photos: subjectPhotos,
      index: 0,
      loading: false,
      error: null,
    });
  };

  const openSaleGallery = async (sale: SaleRow) => {
    if (!sale.source_record_id || !sale.primary_photo_url) return;
    const fallbackPhoto: SalePhoto = {
      id: `primary-${sale.source_record_id}`,
      source_record_id: sale.source_record_id,
      media_url: sale.primary_photo_url,
      order_number: 0,
      is_primary: true,
      caption: null,
      mime_type: null,
      permission: null,
      modification_timestamp: null,
    };
    const title = saleDisplayAddress(sale);
    setGallery({
      title,
      photos: [fallbackPhoto],
      index: 0,
      loading: true,
      error: null,
    });
    try {
      const response = await api.getSalePhotos(sale.source_record_id);
      setGallery((current) => current?.title === title ? {
        ...current,
        photos: response.photos?.length ? response.photos : [fallbackPhoto],
        index: 0,
        loading: false,
        error: response.photos?.length ? null : 'No additional MLS photos were returned.',
      } : current);
    } catch (photoError: any) {
      setGallery((current) => current?.title === title ? {
        ...current,
        loading: false,
        error: photoError?.message || 'The MLS gallery could not be loaded.',
      } : current);
    }
  };

  // Display helper: normalize pool value from DB (boolean or 'T'/'N') to 'Yes'/'No'
  const poolDisplay = (raw: any): string => {
    if (raw === true) return 'Yes';
    if (raw === false) return 'No';
    const s = String(raw ?? '').trim();
    if (!s) return 'N/A';
    const up = s.toUpperCase();
    if (up === 'T') return 'Yes';
    if (up === 'N') return 'No';
    if (up === 'N/A' || up === 'NA') return 'N/A';
    const low = up.toLowerCase();
    if (['yes','y','1','true'].includes(low)) return 'Yes';
    if (['no','n','none','0','false'].includes(low)) return 'No';
    return s;
  };
  const costToCureTotal = useMemo(() => {
    return costToCureItems.reduce(
      (total, item) => total + Math.max(0, finiteNumber(item.cost) ?? 0),
      0,
    );
  }, [costToCureItems]);

  const serializedCostToCureItems = useMemo(
    () => costToCureItems.flatMap((item) => {
      const description = item.description.trim();
      const cost = Math.max(0, finiteNumber(item.cost) ?? 0);
      if (!description && cost === 0) return [];
      return [{ description, cost }];
    }),
    [costToCureItems],
  );

  // Preserve edits made in the dedicated Property Tax Protest workspace.
  useEffect(() => {
    const draft = propertyId ? readAppraisalReportDraft(propertyId) : null;
    setSalesNotes(draft?.salesNotes || DEFAULT_SALES_NOTES);
    setAdjustmentNotes(draft?.adjustmentNotes || DEFAULT_ADJUSTMENT_NOTES);
    const savedRepairItems = draft?.costToCure?.items || [];
    setCostToCureItems(
      savedRepairItems.length
        ? savedRepairItems.map((item) =>
            createCostToCureLine(item.description, item.cost),
          )
        : [createCostToCureLine()],
    );
  }, [propertyId]);

  async function generateSummary() {
    try {
      setSummaryError(null);
      setSummaryLoading(false);
      const subjectAddr = subject?.address || 'the subject property';

      // Try backend endpoint first, falling back to local template
      try {
        let res = await fetch(api.makeUrl('/api/summary'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            subject: subjectAddr,
            salesNotes,
            adjustmentNotes,
            costToCure: { total: costToCureTotal, items: serializedCostToCureItems },
          }),
        });
        if (!res.ok) {
          const base = (import.meta as any)?.env?.VITE_API_URL || 'http://localhost:8080';
          res = await fetch(`${String(base).replace(/\/+$/, '')}/summary`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              subject: subjectAddr,
              salesNotes,
              adjustmentNotes,
              costToCure: { total: costToCureTotal, items: serializedCostToCureItems },
            }),
          });
        }
        if (res.ok) {
          const data = await res.json();
          const text = (data && (data.summary || data.content)) || '';
          if (text) { setSummary(String(text).trim()); return; }
        }
      } catch {}

      // Fallback: local template
      const local = [
        `Based on a sales comparison approach, we selected nearby transactions within the same neighborhood and within a 0.5-mile radius of ${subjectAddr}. These properties are similar in age, size, and quality, providing a reliable indication of current market behavior.`,
        `Adjustments were applied for time, neighborhood code, gross living area, and condition, as well as specific features such as bathrooms, parking, and pools. The adjustments reflect observed market premiums/discounts evidenced by grouped analysis and regression where available, resulting in an indicated value that better aligns with market reactions than the district's broad categories.`,
        `A cost-to-cure analysis identified approximately $${costToCureTotal.toLocaleString()} in user-entered repairs. These items impact both buyer appeal and contributory value and should be reflected in the final reconciliation.`,
      ].join(' ');
      setSummary(local);
    } catch (e: any) {
      setSummaryError(e?.message || 'Failed to generate summary');
    } finally {
      setSummaryLoading(false);
    }
  }

  function downloadSummaryPdf() {
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Protest Summary</title>
      <style>body{font-family:ui-sans-serif,system-ui,Segoe UI,Roboto,Helvetica,Arial;line-height:1.4;padding:24px} h1{font-size:20px;margin:0 0 8px} .meta{color:#475569;font-size:12px;margin-bottom:16px;}</style>
    </head><body>
      <h1>Protest Summary</h1>
      <div class="meta">Generated ${new Date().toLocaleString()}</div>
      <div>${(summary || '').replace(/\r?\n/g,'<br/>')}</div>
    </body></html>`;
    const w = window.open('', '_blank');
    if (!w) return;
    w.document.open();
    w.document.write(html);
    w.document.close();
    w.focus();
    setTimeout(() => { try { w.print(); } catch {} }, 300);
  }

  useEffect(() => {
    async function load() {
      if (!propertyId) return;
      setLoading(true);
      setError(null);
      try {
        // Prefer DB-backed endpoint
        if (typeof (api as any).getAccount === 'function') {
          const d = await (api as any).getAccount(propertyId);
          const imp = d?.primary_improvements || {};
          const housing = d?.housing_profile || {};
          setSubject({
            accountId: propertyId,
            address: d?.account?.address ?? null,
            total_living_area: (imp?.total_living_area ?? imp?.living_area_sqft) ?? null,
            market_value: d?.account?.latest_market_value ?? null,
            nbhd_code: d?.account?.neighborhood_code ?? null,
            construction_type: imp?.construction_type ?? null,
            building_class: (imp as any)?.building_class ?? null,
            actual_age: imp?.actual_age ?? null,
            stories: (imp as any)?.stories ?? null,
            land_size_sqft: null,
            bedroom_count: (imp as any)?.bedroom_count ?? null,
            bath_count: (imp as any)?.bath_count ?? null,
            baths_full: (imp as any)?.baths_full ?? null,
            baths_half: (imp as any)?.baths_half ?? null,
            basement: (imp as any)?.basement ?? null,
            basement_raw: (imp as any)?.basement_raw ?? null,
            heating: (imp as any)?.heating ?? null,
            air_conditioning: (imp as any)?.air_conditioning ?? null,
            deck: (imp as any)?.deck ?? null,
            fence_type: (imp as any)?.fence_type ?? null,
            pool: (imp as any)?.pool ?? null,
            structural_style: housing?.structural_style ?? null,
            housing_type: housing?.housing_type ?? null,
            attachment_type: housing?.attachment_type ?? null,
            architectural_style: housing?.architectural_style ?? null,
          });
          // Try to augment with scraper detail for missing fields (e.g., land size, building class)
          try {
            const s = await fetchDetail(propertyId);
            const detail = s?.detail || s;
            const mi = detail?.main_improvement || {};
            const landRows: Array<{ area_sqft?: string | number }>|undefined = detail?.land_detail;
            const landSize = Array.isArray(landRows)
              ? landRows.reduce((acc, r) => {
                  const v = r?.area_sqft as any;
                  const n = typeof v === 'number' ? v : Number(String(v || '').replace(/[^0-9.-]/g, ''));
                  return acc + (Number.isFinite(n) ? n : 0);
                }, 0)
              : 0;
            const mv = detail?.value_summary?.market_value ?? null;
            const nbhd =
              (detail as any)?.neighborhood_code ||
              (detail as any)?.neighborhood?.code ||
              (detail as any)?.property_location?.neighborhood ||
              null;
            // Basement SF from DB detail (secondary/additional improvements)
            const _simps: any[] = (detail as any)?.secondary_improvements || [];
            const _aimps: any[] = (detail as any)?.additional_improvements || [];
            const _allImps: any[] = Array.isArray(_simps) && _simps.length ? _simps : (Array.isArray(_aimps) ? _aimps : []);
            const _basements = _allImps.filter((r: any) => {
              const t = (r?.imp_type || r?.improvement_type || '').toString().toLowerCase();
              const d = (r?.imp_desc || r?.improvement_desc || r?.description || '').toString().toLowerCase();
              return t.includes('basement') || d.includes('basement') || t.includes('bsmt') || d.includes('bsmt');
            });
            const basementSqftFromDb = _basements.reduce((acc: number, r: any) => {
              const v = (r?.area_size ?? r?.area_sqft) as any;
              const n = typeof v === 'number' ? v : Number(String(v || '').replace(/[^0-9.-]/g, ''));
              return acc + (Number.isFinite(n) ? n : 0);
            }, 0);
            // Garage/Parking sqft from improvements (garage or carport)
            const _garages = _allImps.filter((r: any) => {
              const t = (r?.imp_type || r?.improvement_type || '').toString().toLowerCase();
              const d = (r?.imp_desc || r?.improvement_desc || r?.description || '').toString().toLowerCase();
              return t.includes('garage') || d.includes('garage') || t.includes('carport') || d.includes('carport');
            });
            const garageSqftFromDb = _garages.reduce((acc: number, r: any) => {
              const v = (r?.area_size ?? r?.area_sqft) as any;
              const n = typeof v === 'number' ? v : Number(String(v || '').replace(/[^0-9.-]/g, ''));
              return acc + (Number.isFinite(n) ? n : 0);
            }, 0);
            setSubject(prev => ({
              ...(prev || { accountId: propertyId }),
              land_size_sqft: (landSize || 0) > 0 ? landSize : (prev?.land_size_sqft ?? null),
              market_value: prev?.market_value ?? mv ?? null,
              nbhd_code: prev?.nbhd_code ?? nbhd ?? null,
              construction_type: prev?.construction_type ?? (mi?.construction_type ?? null),
              building_class: prev?.building_class ?? (mi?.building_class ?? null),
              actual_age: prev?.actual_age ?? (mi?.actual_age ?? null),
              stories: prev?.stories ?? ((mi as any)?.stories ?? (mi as any)?.stories_text ?? null),
              bedroom_count: prev?.bedroom_count ?? ((mi as any)?.bedroom_count ?? (detail as any)?.bedroom_count ?? null),
              baths_full: prev?.baths_full ?? ((mi as any)?.baths_full ?? null),
              baths_half: prev?.baths_half ?? ((mi as any)?.baths_half ?? null),
              bath_count: prev?.bath_count ?? ((mi as any)?.bath_count ?? null),
              basement: prev?.basement ?? ((mi as any)?.basement ?? (detail as any)?.basement ?? null),
              basement_raw: prev?.basement_raw ?? ((mi as any)?.basement_raw ?? null),
              heating: prev?.heating ?? ((mi as any)?.heating ?? (detail as any)?.heating ?? null),
              air_conditioning: prev?.air_conditioning ?? ((mi as any)?.air_conditioning ?? (detail as any)?.air_conditioning ?? null),
              basement_sqft: prev?.basement_sqft ?? ((basementSqftFromDb || 0) > 0 ? basementSqftFromDb : null),
              garage_area_sqft: prev?.garage_area_sqft ?? ((garageSqftFromDb || 0) > 0 ? garageSqftFromDb : null),
              solar_panels: prev?.solar_panels ?? (() => {
                const sec: any[] = (detail as any)?.secondary_improvements || [];
                const addl: any[] = (detail as any)?.additional_improvements || [];
                const arr = (Array.isArray(sec) && sec.length ? sec : []).concat(Array.isArray(addl) ? addl : []);
                return arr.some((r: any) => {
                  const t = (r?.imp_type || r?.improvement_type || '').toString().toLowerCase();
                  const d = (r?.imp_desc || r?.improvement_desc || r?.description || '').toString().toLowerCase();
                  return t.includes('solar') || d.includes('solar');
                }) || null;
              })(),
              solar_area_sqft: prev?.solar_area_sqft ?? (() => {
                const sec: any[] = (detail as any)?.secondary_improvements || [];
                const addl: any[] = (detail as any)?.additional_improvements || [];
                const arr = (Array.isArray(sec) && sec.length ? sec : []).concat(Array.isArray(addl) ? addl : []);
                const total = arr.reduce((acc: number, r: any) => {
                  const isSolar = (() => {
                    const t = (r?.imp_type || r?.improvement_type || '').toString().toLowerCase();
                    const d = (r?.imp_desc || r?.improvement_desc || r?.description || '').toString().toLowerCase();
                    return t.includes('solar') || d.includes('solar');
                  })();
                  if (!isSolar) return acc;
                  const v = (r?.area_size ?? r?.area_sqft) as any;
                  const n = typeof v === 'number' ? v : Number(String(v || '').replace(/[^0-9.-]/g, ''));
                  return acc + (Number.isFinite(n) ? n : 0);
                }, 0);
                return (total || 0) > 0 ? total : null;
              })(),
            }));
          } catch { /* optional augment failed; ignore */ }
          // Refresh legacy rows whose original scrape predates bedroom/full-half bath capture.
          // The scraper endpoint persists the recovered values, so later visits stay DB-backed.
          try {
            const env: any = (import.meta as any).env || {};
            const base = (
              env.VITE_SCRAPER_BASE ||
              env.VITE_SCRAPER_URL ||
              'https://dcad-scraper-with-api.onrender.com'
            ).toString().replace(/\/+$/, '');
            const needsBedroom = (imp as any)?.bedroom_count == null || (imp as any)?.bedroom_count === '';
            const needsBaths =
              ((imp as any)?.baths_full == null || (imp as any)?.baths_full === '') &&
              ((imp as any)?.baths_half == null || (imp as any)?.baths_half === '') &&
              ((imp as any)?.bath_count == null || (imp as any)?.bath_count === '');
            if (base && (needsBedroom || needsBaths)) {
              const res = await fetch(`${base}/detail/${encodeURIComponent(propertyId)}`);
              if (res.ok) {
                const payload: any = await res.json();
                const detail = payload?.detail || payload || {};
                const mi = (detail?.primary_improvements || detail?.main_improvement || {}) as any;
                // Compute basement sqft from scraper detail
                const simps: any[] = (detail as any)?.secondary_improvements || [];
                const aimps: any[] = (detail as any)?.additional_improvements || [];
                const allImps: any[] = Array.isArray(simps) && simps.length ? simps : (Array.isArray(aimps) ? aimps : []);
                const basements = allImps.filter((r: any) => {
                  const t = (r?.imp_type || r?.improvement_type || '').toString().toLowerCase();
                  const d = (r?.imp_desc || r?.improvement_desc || r?.description || '').toString().toLowerCase();
                  return t.includes('basement') || d.includes('basement') || t.includes('bsmt') || d.includes('bsmt');
                });
                const bsf = basements.reduce((acc: number, r: any) => {
                  const v = (r?.area_size ?? r?.area_sqft) as any;
                  const n = typeof v === 'number' ? v : Number(String(v || '').replace(/[^0-9.-]/g, ''));
                  return acc + (Number.isFinite(n) ? n : 0);
                }, 0);
                if (mi || (bsf || 0) > 0) {
                  setSubject(prev => ({
                    ...(prev || { accountId: propertyId }),
                    bedroom_count: prev?.bedroom_count ?? (mi as any)?.bedroom_count ?? (detail as any)?.bedroom_count ?? null,
                    baths_full: prev?.baths_full ?? (mi as any)?.baths_full ?? null,
                    baths_half: prev?.baths_half ?? (mi as any)?.baths_half ?? null,
                    bath_count: prev?.bath_count ?? (mi as any)?.bath_count ?? null,
                    basement: prev?.basement ?? (mi as any)?.basement ?? null,
                    basement_raw: prev?.basement_raw ?? (mi as any)?.basement_raw ?? null,
                    heating: prev?.heating ?? (mi as any)?.heating ?? null,
                    air_conditioning: prev?.air_conditioning ?? (mi as any)?.air_conditioning ?? null,
                    basement_sqft: prev?.basement_sqft ?? ((bsf || 0) > 0 ? bsf : null),
                    garage_area_sqft: prev?.garage_area_sqft ?? (() => {
                      const garages = allImps.filter((r: any) => {
                        const t = (r?.imp_type || r?.improvement_type || '').toString().toLowerCase();
                        const d = (r?.imp_desc || r?.improvement_desc || r?.description || '').toString().toLowerCase();
                        return t.includes('garage') || d.includes('garage') || t.includes('carport') || d.includes('carport');
                      });
                      const gsf = garages.reduce((acc: number, r: any) => {
                        const v = (r?.area_size ?? r?.area_sqft) as any;
                        const n = typeof v === 'number' ? v : Number(String(v || '').replace(/[^0-9.-]/g, ''));
                        return acc + (Number.isFinite(n) ? n : 0);
                      }, 0);
                      return (gsf || 0) > 0 ? gsf : null;
                    })(),
                    solar_panels: prev?.solar_panels ?? (() => {
                      const sec: any[] = (detail as any)?.secondary_improvements || [];
                      const addl: any[] = (detail as any)?.additional_improvements || [];
                      const arr = (Array.isArray(sec) && sec.length ? sec : []).concat(Array.isArray(addl) ? addl : []);
                      return arr.some((r: any) => {
                        const t = (r?.imp_type || r?.improvement_type || '').toString().toLowerCase();
                        const d = (r?.imp_desc || r?.improvement_desc || r?.description || '').toString().toLowerCase();
                        return t.includes('solar') || d.includes('solar');
                      }) || null;
                    })(),
                    solar_area_sqft: prev?.solar_area_sqft ?? (() => {
                      const sec: any[] = (detail as any)?.secondary_improvements || [];
                      const addl: any[] = (detail as any)?.additional_improvements || [];
                      const arr = (Array.isArray(sec) && sec.length ? sec : []).concat(Array.isArray(addl) ? addl : []);
                      const total = arr.reduce((acc: number, r: any) => {
                        const isSolar = (() => {
                          const t = (r?.imp_type || r?.improvement_type || '').toString().toLowerCase();
                          const d = (r?.imp_desc || r?.improvement_desc || r?.description || '').toString().toLowerCase();
                          return t.includes('solar') || d.includes('solar');
                        })();
                        if (!isSolar) return acc;
                        const v = (r?.area_size ?? r?.area_sqft) as any;
                        const n = typeof v === 'number' ? v : Number(String(v || '').replace(/[^0-9.-]/g, ''));
                        return acc + (Number.isFinite(n) ? n : 0);
                      }, 0);
                      return (total || 0) > 0 ? total : null;
                    })(),
                    // Derive pool from improvements if not present on primary_improvements
                    pool: (() => {
                      if (prev?.pool != null && String(prev.pool).trim() !== '') return prev.pool as any;
                      const sec: any[] = (detail as any)?.secondary_improvements || [];
                      const addl: any[] = (detail as any)?.additional_improvements || [];
                      const arr = (Array.isArray(sec) && sec.length ? sec : []).concat(Array.isArray(addl) ? addl : []);
                      const hasPool = arr.some((r: any) => {
                        const t = (r?.imp_type || r?.improvement_type || '').toString().toLowerCase();
                        const d = (r?.imp_desc || r?.improvement_desc || r?.description || '').toString().toLowerCase();
                        return t.includes('pool') || d.includes('pool');
                      });
                      if (hasPool) return 'T';
                      return 'N/A';
                    })(),
                  }));
                }
              }
            }
          } catch { /* ignore scraper enrichment failures */ }
          // Ensure loading state clears
          setLoading(false);
          return;
        }
      } catch (e: any) {
        // Fall through to scraper detail
      }
      try {
        const d = await fetchDetail(propertyId);
        const detail = d?.detail || d;
        const mi = detail?.main_improvement || {};
        const housing = detail?.housing_profile || {};
        // land size from land_detail
        const landRows: Array<{ area_sqft?: string | number }>|undefined = detail?.land_detail;
        const landSize = Array.isArray(landRows)
          ? landRows.reduce((acc, r) => {
              const v = r?.area_sqft as any;
              const n = typeof v === 'number' ? v : Number(String(v || '').replace(/[^0-9.-]/g, ''));
              return acc + (Number.isFinite(n) ? n : 0);
            }, 0)
          : 0;
        // Compute basement SF from detail (secondary/additional improvements)
        const _simps2: any[] = (detail as any)?.secondary_improvements || [];
        const _aimps2: any[] = (detail as any)?.additional_improvements || [];
        const _allImps2: any[] = Array.isArray(_simps2) && _simps2.length ? _simps2 : (Array.isArray(_aimps2) ? _aimps2 : []);
        const _basements2 = _allImps2.filter((r: any) => {
          const t = (r?.imp_type || r?.improvement_type || '').toString().toLowerCase();
          const d = (r?.imp_desc || r?.improvement_desc || r?.description || '').toString().toLowerCase();
          return t.includes('basement') || d.includes('basement') || t.includes('bsmt') || d.includes('bsmt');
        });
        const basementSqft = _basements2.reduce((acc: number, r: any) => {
          const v = (r?.area_size ?? r?.area_sqft) as any;
          const n = typeof v === 'number' ? v : Number(String(v || '').replace(/[^0-9.-]/g, ''));
          return acc + (Number.isFinite(n) ? n : 0);
        }, 0);
        // Garage/Parking sqft from detail
        const _garages2 = _allImps2.filter((r: any) => {
          const t = (r?.imp_type || r?.improvement_type || '').toString().toLowerCase();
          const d = (r?.imp_desc || r?.improvement_desc || r?.description || '').toString().toLowerCase();
          return t.includes('garage') || d.includes('garage') || t.includes('carport') || d.includes('carport');
        });
        const garageSqft = _garages2.reduce((acc: number, r: any) => {
          const v = (r?.area_size ?? r?.area_sqft) as any;
          const n = typeof v === 'number' ? v : Number(String(v || '').replace(/[^0-9.-]/g, ''));
          return acc + (Number.isFinite(n) ? n : 0);
        }, 0);

        setSubject({
          accountId: propertyId,
          address: detail?.property_location?.address ?? null,
          total_living_area: detail?.total_living_area ?? mi?.total_living_area ?? mi?.living_area_sqft ?? null,
          market_value: detail?.value_summary?.market_value ?? null,
          nbhd_code:
            (detail as any)?.neighborhood_code ||
            (detail as any)?.neighborhood?.code ||
            (detail as any)?.property_location?.neighborhood ||
            null,
          land_size_sqft: (landSize || 0) > 0 ? landSize : null,
          view: 'Neutral',
          construction_type: mi?.construction_type ?? null,
          building_class: mi?.building_class ?? null,
          actual_age: mi?.actual_age ?? null,
          bedroom_count: (mi as any)?.bedroom_count ?? (detail as any)?.bedroom_count ?? null,
          baths_full: (mi as any)?.baths_full ?? null,
          baths_half: (mi as any)?.baths_half ?? null,
          bath_count: (mi as any)?.bath_count ?? null,
          basement: (mi as any)?.basement ?? (detail as any)?.basement ?? null,
          basement_raw: (mi as any)?.basement_raw ?? null,
          heating: (mi as any)?.heating ?? (detail as any)?.heating ?? null,
          air_conditioning: (mi as any)?.air_conditioning ?? (detail as any)?.air_conditioning ?? null,
          basement_sqft: (basementSqft || 0) > 0 ? basementSqft : null,
          garage_area_sqft: (garageSqft || 0) > 0 ? garageSqft : null,
          structural_style: housing?.structural_style ?? null,
          housing_type: housing?.housing_type ?? null,
          attachment_type: housing?.attachment_type ?? null,
          architectural_style: housing?.architectural_style ?? null,
          solar_panels: (() => {
            const sec: any[] = (detail as any)?.secondary_improvements || [];
            const addl: any[] = (detail as any)?.additional_improvements || [];
            const arr = (Array.isArray(sec) && sec.length ? sec : []).concat(Array.isArray(addl) ? addl : []);
            return arr.some((r: any) => {
              const t = (r?.imp_type || r?.improvement_type || '').toString().toLowerCase();
              const d = (r?.imp_desc || r?.improvement_desc || r?.description || '').toString().toLowerCase();
              return t.includes('solar') || d.includes('solar');
            }) || null;
          })(),
          solar_area_sqft: (() => {
            const sec: any[] = (detail as any)?.secondary_improvements || [];
            const addl: any[] = (detail as any)?.additional_improvements || [];
            const arr = (Array.isArray(sec) && sec.length ? sec : []).concat(Array.isArray(addl) ? addl : []);
            const total = arr.reduce((acc: number, r: any) => {
              const isSolar = (() => {
                const t = (r?.imp_type || r?.improvement_type || '').toString().toLowerCase();
                const d = (r?.imp_desc || r?.improvement_desc || r?.description || '').toString().toLowerCase();
                return t.includes('solar') || d.includes('solar');
              })();
              if (!isSolar) return acc;
              const v = (r?.area_size ?? r?.area_sqft) as any;
              const n = typeof v === 'number' ? v : Number(String(v || '').replace(/[^0-9.-]/g, ''));
              return acc + (Number.isFinite(n) ? n : 0);
            }, 0);
            return (total || 0) > 0 ? total : null;
          })(),
        });
      } catch (e: any) {
        setError(e?.message || 'Failed to load property');
      }
      finally {
        setLoading(false);
      }
    }
    load();
  }, [propertyId]);

  const fmtSqft = (v: unknown) => {
    if (v === null || v === undefined || v === '') return '-';
    const n = typeof v === 'string' ? Number(String(v).replace(/[^0-9.-]/g, '')) : Number(v);
    if (!isFinite(n) || n <= 0) return '-';
    return `${n.toLocaleString('en-US')} sq. ft`;
  };

  const fmtSqftSafe = (v: unknown) => {
    if (v === null || v === undefined || v === '') return '-';
    const n = typeof v === 'string' ? Number(String(v).replace(/[^0-9.-]/g, '')) : Number(v);
    if (!isFinite(n) || n <= 0) return '-';
    return `${n.toLocaleString('en-US')} sq. ft`;
  };

  const fmtCurrency = (v: unknown) => {
    if (v === null || v === undefined || v === '') return '';
    const n = typeof v === 'string' ? Number(String(v).replace(/[^0-9.-]/g, '')) : Number(v);
    if (!isFinite(n)) return String(v);
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
  };

  const saleKey = (sale: SaleRow): string =>
    sale.source_record_id != null ? `source-${sale.source_record_id}` : `legacy-${sale.sale_id}`;

  const saleNumber = (value: unknown): number | null => {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(String(value).replace(/[^0-9.-]/g, ''));
    return Number.isFinite(parsed) ? parsed : null;
  };

  const saleDateDisplay = (value: string | null): string => {
    if (!value) return '';
    const parsed = new Date(`${value.slice(0, 10)}T00:00:00`);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString('en-US');
  };

  const saleIsOverOneYear = (sale: SaleRow): boolean => {
    if (sale.soldOverOneYear != null) return sale.soldOverOneYear;
    if (!sale.closing_date) return false;
    const saleDate = new Date(`${sale.closing_date.slice(0, 10)}T12:00:00Z`);
    if (Number.isNaN(saleDate.getTime())) return false;
    const cutoffValue = monthsBeforeDate(salesAnalysisAsOf, 12);
    const cutoff = new Date(`${cutoffValue}T12:00:00Z`);
    if (Number.isNaN(cutoff.getTime())) return false;
    return saleDate < cutoff;
  };

  const saleDisplayAddress = (sale: SaleRow): string => {
    if (sale.address?.trim()) return sale.address.trim();
    if (sale.primary_account_id) return `Account ${sale.primary_account_id} (address unavailable)`;
    return `Unmatched sale${sale.source_row_number ? ` ${sale.source_row_number}` : ''}`;
  };

  const housingTypeNeedsReview = (sale: SaleRow): boolean =>
    !(sale.structural_style || sale.housing_type || '').trim();

  const attachmentNeedsReview = (sale: SaleRow): boolean =>
    !housingTypeNeedsReview(sale) &&
    (!sale.attachment_type || sale.attachment_type === 'unknown');

  const housingTypeGridValue = (sale: SaleRow | null | undefined): string => {
    if (!sale) return 'Not available';
    if (housingTypeNeedsReview(sale)) return '⚠ Review';
    return sale.structural_style || sale.housing_type || 'Not available';
  };

  const statisticalOutlierLabel = (sale: SaleRow): string => {
    if (!sale.statistical_outlier) return '';
    const direction = sale.statistical_outlier_direction === 'low' ? 'low' : 'high';
    return `Statistical outlier · unusually ${direction} price/SF`;
  };

  const suggestedAttachmentType = (
    housingType: string,
    current: HousingEditForm['attachmentType'],
  ): HousingEditForm['attachmentType'] => {
    const normalized = housingType.trim().toLowerCase();
    if (/\bdetached\b/.test(normalized) || normalized === 'single family') return 'detached';
    if (
      /\battached\b/.test(normalized) ||
      normalized.includes('townhome') ||
      normalized.includes('townhouse') ||
      normalized.includes('condo') ||
      normalized.includes('duplex')
    ) {
      return 'attached';
    }
    if (normalized.includes('multi-family') || normalized.includes('multifamily')) return 'mixed';
    return current;
  };

  const openHousingEditor = (sale: SaleRow) => {
    if (!sale.primary_account_id) {
      setSalesError('This MLS row is not matched to a CAD account, so its property type cannot be saved yet.');
      return;
    }
    const housingType = (sale.structural_style || sale.housing_type || '').trim();
    setEditingHousingSale(sale);
    setHousingEditForm({
      housingType,
      attachmentType: sale.attachment_type || 'unknown',
      architecturalStyle: (sale.architectural_style || '').trim(),
      sourceUrl: '',
      notes: '',
    });
    setHousingEditError(null);
    setSalesNotice(null);
  };

  const saveHousingProfile = async () => {
    const sale = editingHousingSale;
    const accountId = sale?.primary_account_id;
    if (!sale || !accountId) return;
    if (!housingEditForm.housingType.trim()) {
      setHousingEditError('Housing type is required before the correction can be confirmed.');
      return;
    }
    if (!housingEditorKey.trim()) {
      setHousingEditError('Enter your personal editor key to save database changes.');
      return;
    }

    setHousingEditSaving(true);
    setHousingEditError(null);
    try {
      const result = await api.updateAccountHousingProfile(
        accountId,
        {
          housing_type: housingEditForm.housingType.trim(),
          attachment_type: housingEditForm.attachmentType,
          architectural_style: housingEditForm.architecturalStyle.trim() || null,
          source_url: housingEditForm.sourceUrl.trim() || null,
          source_record_reference: sale.source_record_id
            ? `HomeNode sale source record ${sale.source_record_id}`
            : null,
          notes: housingEditForm.notes.trim() || null,
        },
        housingEditorKey.trim(),
      );
      try {
        window.sessionStorage.setItem('homenode-editor-key', housingEditorKey.trim());
      } catch {
        // The edit still succeeds when session storage is unavailable.
      }

      const profile = result.housing_profile;
      const withProfile = (item: SaleRow): SaleRow =>
        item.primary_account_id === accountId
          ? {
              ...item,
              structural_style: profile.structural_style || profile.housing_type || null,
              housing_type: profile.housing_type || profile.structural_style || null,
              attachment_type: profile.attachment_type || 'unknown',
              architectural_style: profile.architectural_style || null,
            }
          : item;
      setSalesResults((current) => current.map(withProfile));
      setSelectedSales((current) => current.map((item) => item ? withProfile(item) : item));
      setRecommendationSummary((current) => current ? {
        ...current,
        recommended_sales: current.recommended_sales.map(withProfile),
        competitive_sales: current.competitive_sales?.map(withProfile) || [],
        sales: current.sales.map(withProfile),
      } : current);
      if (subject?.accountId === accountId) {
        setSubject((current) => current ? {
          ...current,
          structural_style: profile.structural_style || profile.housing_type || null,
          housing_type: profile.housing_type || profile.structural_style || null,
          attachment_type: profile.attachment_type || 'unknown',
          architectural_style: profile.architectural_style || null,
        } : current);
      }
      setSalesNotice(
        `Saved verified housing information for ${saleDisplayAddress(sale)}. The score and current ordering were not changed.`,
      );
      setEditingHousingSale(null);
    } catch (saveError: any) {
      const message = String(saveError?.message || '');
      if (message.includes('invalid_editor_key')) {
        setHousingEditError('The editor key was not accepted. Check it and try again.');
      } else if (message.includes('housing_profile_editor_not_configured')) {
        setHousingEditError('Manual database editing has not been enabled on the server yet.');
      } else {
        setHousingEditError(message || 'The housing profile could not be saved.');
      }
    } finally {
      setHousingEditSaving(false);
    }
  };

  const mlsLotSizeSqft = useCallback((value: unknown): number | null => {
    const area = saleNumber(value);
    if (area == null || area <= 0) return null;
    // The MLS export omits its unit column: sub-100 values are acreage,
    // while the larger values are already square feet.
    return area < 100 ? area * 43_560 : area;
  }, []);

  const applySaleToSlot = (sale: SaleRow, slot: number) => {
    const livingArea = saleNumber(resolveComparableCharacteristic({
      county: sale.county,
      trestle: sale.mls_living_area,
      cad: sale.cad_living_area_sqft,
    }));
    const price = saleNumber(sale.sale_price);
    const concessions = saleNumber(sale.seller_contributions);
    const landSize = saleNumber(sale.comparableSiteSize) ?? mlsLotSizeSqft(sale.mls_lot_size_area);
    const yearBuilt = saleNumber(sale.comparableYearBuilt) ?? saleNumber(
      resolveComparableCharacteristic({
        county: sale.county,
        trestle: sale.mls_year_built,
        cad: sale.cad_year_built,
      }),
    );
    const bedrooms = saleNumber(resolveComparableCharacteristic({
      county: sale.county,
      trestle: sale.mls_bedrooms_total,
      cad: sale.cad_bedroom_count,
    }));
    const fullBaths = saleNumber(resolveComparableCharacteristic({
      county: sale.county,
      trestle: sale.mls_bathrooms_full,
      cad: sale.cad_baths_full,
    }));
    const halfBaths = saleNumber(resolveComparableCharacteristic({
      county: sale.county,
      trestle: sale.mls_bathrooms_half,
      cad: sale.cad_baths_half,
    }));
    const totalRooms = bedrooms == null ? null : Math.round(bedrooms) + 3;
    const savedRatings = conditionQualityRatings[conditionQualitySaleKey(sale)];

    setSelectedSales((current) => current.map((item, index) => index === slot ? sale : item));
    setCompAddresses((current) => current.map((value, index) => index === slot ? saleDisplayAddress(sale) : value));
    setCompGla((current) => current.map((value, index) => index === slot ? livingArea : value));
    setCompPrices((current) => current.map((value, index) => index === slot ? price : value));
    setCompConcessions((current) => current.map((value, index) => index === slot ? concessions : value));
    setCompTimeAdjustments((current) => current.map((value, index) => index === slot ? null : value));
    setCompSaleDates((current) => current.map((value, index) => index === slot ? saleDateDisplay(sale.closing_date) : value));
    setCompLandSize((current) => current.map((value, index) => index === slot ? landSize : value));
    setCompAges((current) => current.map((value, index) => index === slot && yearBuilt != null ? Math.max(0, new Date().getFullYear() - yearBuilt) : (index === slot ? null : value)));
    setCompGarage((current) => current.map((value, index) => index === slot ? null : value));
    setCompConditions((current) => current.map((value, index) =>
      index === slot ? (savedRatings?.condition || '') : value));
    setCompQualities((current) => current.map((value, index) =>
      index === slot ? (savedRatings?.quality || '') : value));
    setCompRooms((current) => current.map((value, index) => index === slot ? {
      tot: totalRooms,
      bd: bedrooms == null ? null : Math.round(bedrooms),
      full: fullBaths == null ? null : Math.round(fullBaths),
      half: halfBaths == null ? null : Math.round(halfBaths),
    } : value));
    setSalesError(null);
  };

  const addSaleAsComparable = (sale: SaleRow) => {
    if (!marketConditionsDraft) {
      setSalesError('Complete the Market Conditions Analysis on the Property Report before selecting comparable sales.');
      return;
    }
    if (selectedSales.some((item) => item && saleKey(item) === saleKey(sale))) return;
    const openSlot = selectedSales.findIndex((item) => item === null);
    if (openSlot < 0) {
      setSalesError('Six comparables are already selected. Remove one before adding another sale.');
      return;
    }
    applySaleToSlot(sale, openSlot);
  };

  const addCompetitiveSaleToPrimaryGrid = (sale: SaleRow) => {
    if (selectedSales.some((item) => item && saleKey(item) === saleKey(sale))) {
      setSalesNotice(`${saleDisplayAddress(sale)} is already in the primary grid.`);
      return;
    }
    const openSlot = selectedSales.findIndex((item) => item === null);
    if (openSlot >= 0) {
      applySaleToSlot(sale, openSlot);
      setSalesNotice(`${saleDisplayAddress(sale)} was added to Comparable ${openSlot + 1}.`);
      return;
    }
    setCompetitiveReplacementSale(sale);
  };

  const replacePrimaryComparable = (slot: number) => {
    if (!competitiveReplacementSale) return;
    const address = saleDisplayAddress(competitiveReplacementSale);
    applySaleToSlot(competitiveReplacementSale, slot);
    setCompetitiveReplacementSale(null);
    setSalesNotice(`${address} replaced Comparable ${slot + 1} in the primary grid.`);
  };

  const removeComparable = (slot: number) => {
    const removedSale = selectedSales[slot];
    if (!removedSale) return;

    const retainedSlots = selectedSales.flatMap((sale, index) =>
      sale && index !== slot ? [index] : []);

    setSelectedSales((current) =>
      compactComparableSlots(current, retainedSlots, () => null));
    setCompAddresses((current) =>
      compactComparableSlots(current, retainedSlots, () => ''));
    setCompGla((current) =>
      compactComparableSlots(current, retainedSlots, () => null));
    setCompPrices((current) =>
      compactComparableSlots(current, retainedSlots, () => null));
    setCompConcessions((current) =>
      compactComparableSlots(current, retainedSlots, () => null));
    setCompTimeAdjustments((current) =>
      compactComparableSlots(current, retainedSlots, () => null));
    setCompSaleDates((current) =>
      compactComparableSlots(current, retainedSlots, () => ''));
    setCompLandSize((current) =>
      compactComparableSlots(current, retainedSlots, () => null));
    setCompAges((current) =>
      compactComparableSlots(current, retainedSlots, () => null));
    setCompGarage((current) =>
      compactComparableSlots(current, retainedSlots, () => null));
    setCompConditions((current) =>
      compactComparableSlots(current, retainedSlots, () => ''));
    setCompQualities((current) =>
      compactComparableSlots(current, retainedSlots, () => ''));
    setCompRooms((current) =>
      compactComparableSlots(current, retainedSlots, () => ({
        tot: null,
        bd: null,
        full: null,
        half: null,
      })));
    setSalesNotice(
      `${saleDisplayAddress(removedSale)} was removed. Remaining comparables shifted left.`,
    );
  };

  const moveComparable = (from: number, to: number) => {
    if (
      from < 0 ||
      from >= COMPARABLE_COUNT ||
      to < 0 ||
      to >= COMPARABLE_COUNT ||
      !selectedSales[from]
    ) return;
    const movedAddress = compAddresses[from] || `Comparable ${from + 1}`;
    setSelectedSales((current) => swapArrayItems(current, from, to));
    setCompAddresses((current) => swapArrayItems(current, from, to));
    setCompGla((current) => swapArrayItems(current, from, to));
    setCompPrices((current) => swapArrayItems(current, from, to));
    setCompConcessions((current) => swapArrayItems(current, from, to));
    setCompTimeAdjustments((current) => swapArrayItems(current, from, to));
    setCompSaleDates((current) => swapArrayItems(current, from, to));
    setCompLandSize((current) => swapArrayItems(current, from, to));
    setCompAges((current) => swapArrayItems(current, from, to));
    setCompGarage((current) => swapArrayItems(current, from, to));
    setCompConditions((current) => swapArrayItems(current, from, to));
    setCompQualities((current) => swapArrayItems(current, from, to));
    setCompRooms((current) => swapArrayItems(current, from, to));
    setSalesNotice(`${movedAddress} moved to Comparable ${to + 1}.`);
  };

  const focusComparableSearch = () => {
    salesSearchInputRef.current?.focus();
    salesSearchInputRef.current?.scrollIntoView({
      behavior: 'smooth',
      block: 'center',
    });
    setSalesNotice('Search or choose an available sale, then select “Use as Comparable” to add it to the next open grid position.');
  };

  const clearComparables = () => {
    Array.from({ length: COMPARABLE_COUNT }, (_, index) => index).forEach(removeComparable);
    setSalesError(null);
  };

  const resetSalesForAnalysisPeriodChange = () => {
    setRecommendationSummary(null);
    setSalesResults([]);
    setSalesNotice(null);
    setCompetitiveReplacementSale(null);
    clearComparables();
  };

  const runRecommendedSales = async () => {
    if (!marketConditionsDraft) {
      setSalesError('Complete the Market Conditions Analysis on the Property Report before recommending comparable sales.');
      return;
    }
    if (!propertyId) {
      setSalesError('A subject property is required before comparable sales can be recommended.');
      return;
    }
    if (!comparableSearchProfile) {
      setSalesError('Select the comparable-search complexity before recommending sales.');
      return;
    }
    setSalesLoading(true);
    setSalesError(null);
    setSalesNotice(null);
    try {
      const response = await api.getComparableRecommendations({
        subjectAccountId: propertyId,
        analysisAsOf: salesAnalysisAsOf,
        periodMonths: salesPeriodMonths,
        limit: 50,
        outlierScoreThreshold,
        searchProfile: comparableSearchProfile,
      });
      setRecommendationSummary(response);
      setSalesResults(response.sales);
      clearComparables();
      const recommendedSales = response.recommended_sales?.length
        ? response.recommended_sales
        : response.sales.slice(0, COMPARABLE_COUNT);
      recommendedSales.slice(0, COMPARABLE_COUNT).forEach((sale, slot) => {
        applySaleToSlot(sale, slot);
      });
      if (!recommendedSales.length) {
        setSalesError('No sales had both parcel coordinates and living-area data for scoring.');
      }
    } catch (recommendationError: any) {
      setRecommendationSummary(null);
      setSalesResults([]);
      const message = String(recommendationError?.message || '');
      if (message.includes('subject_location_unavailable')) {
        setSalesError('The subject parcel could not be located in the DCAD GIS service.');
      } else if (message.includes('subject_living_area_unavailable')) {
        setSalesError('The subject is missing living-area data required for comparable scoring.');
      } else {
        setSalesError(message || 'Comparable recommendation scoring failed.');
      }
    } finally {
      setSalesLoading(false);
    }
  };

  const runSalesSearch = async () => {
    if (!marketConditionsDraft) {
      setSalesError('Complete the Market Conditions Analysis on the Property Report before searching comparable sales.');
      return;
    }
    if (!comparableSearchProfile) {
      setSalesError('Select the comparable-search complexity before searching sales.');
      return;
    }
    setSalesLoading(true);
    setSalesError(null);
    setSalesNotice(null);
    try {
      const rows = await api.searchSales({
        q: salesQuery.trim() || undefined,
        subjectAccountId: propertyId || undefined,
        excludeAccountId: propertyId || undefined,
        neighborhoodCode: sameNeighborhoodOnly ? (subject?.nbhd_code || undefined) : undefined,
        dateFrom: salesDateFrom || undefined,
        dateTo: salesAnalysisAsOf || undefined,
        matched: includeUnmatchedSales ? undefined : true,
        searchProfile: comparableSearchProfile,
        limit: 50,
      });
      setRecommendationSummary(null);
      setCompetitiveReplacementSale(null);
      setSalesResults(rows);
      const refreshedByKey = new Map(rows.map((sale) => [saleKey(sale), sale]));
      selectedSales.forEach((selected, slot) => {
        if (!selected) return;
        const refreshed = refreshedByKey.get(saleKey(selected));
        if (refreshed) applySaleToSlot(refreshed, slot);
      });
      if (!rows.length) setSalesError('No sales matched these filters.');
    } catch (searchError: any) {
      setSalesResults([]);
      setSalesError(searchError?.message || 'Sales search failed');
    } finally {
      setSalesLoading(false);
    }
  };

  const appliedGroupedAdjustmentEntries = useMemo(
    () => Object.values(appliedGroupedAdjustments),
    [appliedGroupedAdjustments],
  );
  const subjectBathroomGroup = useMemo(
    () => bathroomEquivalentValue(
      null,
      subject?.baths_full,
      subject?.baths_half,
      subject?.bath_count,
    ),
    [subject?.baths_full, subject?.baths_half, subject?.bath_count],
  );
  const subjectGarageGroup = useMemo(
    () => garageSpacesFromArea(subject?.garage_area_sqft),
    [subject?.garage_area_sqft],
  );
  const subjectPoolGroup = useMemo(
    () => booleanValue(subject?.pool),
    [subject?.pool],
  );
  const subjectLivingArea = useMemo(
    () => finiteNumber(subject?.total_living_area),
    [subject?.total_living_area],
  );
  const comparableBathroomGroups = useMemo(
    () => Array.from({ length: COMPARABLE_COUNT }, (_, index) => {
      const sale = selectedSales[index];
      if (sale) {
        return bathroomEquivalentValue(
          sale.mls_bathrooms_total_integer,
          sale.mls_bathrooms_full ?? sale.cad_baths_full,
          sale.mls_bathrooms_half ?? sale.cad_baths_half,
          sale.cad_bath_count,
        );
      }
      return bathroomEquivalentValue(
        null,
        compRooms[index]?.full,
        compRooms[index]?.half,
      );
    }),
    [selectedSales, compRooms],
  );
  const comparableGarageGroups = useMemo(
    () => Array.from({ length: COMPARABLE_COUNT }, (_, index) => {
      const sale = selectedSales[index];
      const explicitSpaces = finiteNumber(sale?.mls_garage_spaces);
      if (explicitSpaces !== null && explicitSpaces >= 0) return Math.round(explicitSpaces);
      if (sale?.mls_garage_yn === false) return 0;
      return garageSpacesFromArea(compGarage[index]);
    }),
    [selectedSales, compGarage],
  );
  const comparablePoolGroups = useMemo(
    () => Array.from({ length: COMPARABLE_COUNT }, (_, index) => {
      const sale = selectedSales[index];
      return booleanValue(sale?.mls_pool_yn ?? sale?.cad_pool);
    }),
    [selectedSales],
  );

  // SALES/EQUITY: Room Count adjustments logic (Beds + Baths).
  // One selected grouped study supplies the universal per-bath rate.
  const roomCountBedAdjustments = useMemo<number[]>(() => Array(COMPARABLE_COUNT).fill(0), []);
  const roomCountBathAdjustments = useMemo<number[]>(
    () => comparableBathroomGroups.map((comparableValue) =>
      calculateNumericGroupedAdjustment(
        appliedGroupedAdjustmentEntries,
        'bathrooms',
        subjectBathroomGroup,
        comparableValue,
      )),
    [appliedGroupedAdjustmentEntries, subjectBathroomGroup, comparableBathroomGroups],
  );
  const roomCountTotalAdjustments = useMemo<number[]>(
    () => roomCountBedAdjustments.map((b, i) => b + (roomCountBathAdjustments[i] ?? 0)),
    [roomCountBedAdjustments, roomCountBathAdjustments]
  );
  const garageAdjustments = useMemo<number[]>(
    () => comparableGarageGroups.map((comparableValue) =>
      calculateNumericGroupedAdjustment(
        appliedGroupedAdjustmentEntries,
        'garage',
        subjectGarageGroup,
        comparableValue,
      )),
    [appliedGroupedAdjustmentEntries, subjectGarageGroup, comparableGarageGroups],
  );
  const poolAdjustments = useMemo<number[]>(
    () => comparablePoolGroups.map((comparableValue) =>
      calculatePoolGroupedAdjustment(
        appliedGroupedAdjustmentEntries,
        subjectPoolGroup,
        comparableValue,
      )),
    [appliedGroupedAdjustmentEntries, subjectPoolGroup, comparablePoolGroups],
  );
  // Gross living-area adjustments use the selected market-derived rate per square foot.
  const glaAdjustments = useMemo<number[]>(
    () => compGla.map((comparableValue) =>
      calculateLivingAreaGroupedAdjustment(
        appliedGroupedAdjustmentEntries,
        subjectLivingArea,
        finiteNumber(comparableValue),
      )),
    [appliedGroupedAdjustmentEntries, subjectLivingArea, compGla],
  );

  // SALES/EQUITY: Net Adjustments — sum all signed adjustments per comparable
  // Condition and quality remain separate from concessions and every other
  // objective adjustment already present in the grid.
  // Condition and quality stay at zero until the user explicitly applies a
  // separately calculated market study. Grid dropdowns remain editable.
  const conditionAdjustments = useMemo(
    () => Array.from({ length: COMPARABLE_COUNT }, (_, index) => {
      const applied = appliedConditionQualityAdjustments.condition;
      if (!selectedSales[index] || !applied) return 0;
      return calculateRatingAdjustment(
        applied.amount,
        subjectCondition,
        compConditions[index] || '',
        'condition',
      );
    }),
    [
      selectedSales,
      appliedConditionQualityAdjustments.condition,
      subjectCondition,
      compConditions,
    ],
  );

  const qualityAdjustments = useMemo(
    () => Array.from({ length: COMPARABLE_COUNT }, (_, index) => {
      const applied = appliedConditionQualityAdjustments.quality;
      if (!selectedSales[index] || !applied) return 0;
      return calculateRatingAdjustment(
        applied.amount,
        subjectQuality,
        compQualities[index] || '',
        'quality',
      );
    }),
    [
      selectedSales,
      appliedConditionQualityAdjustments.quality,
      subjectQuality,
      compQualities,
    ],
  );

  // The listing grid consumes the same market-supported adjustment schedule as
  // the closed-sale grid. Listing characteristics stay independent, while the
  // applied bath, GLA, garage, pool, condition, and quality rates are shared.
  const listingLivingAreas = useMemo(
    () => selectedListings.map((listing) => listing
      ? saleNumber(resolveComparableCharacteristic({
          county: listing.county,
          trestle: listing.mls_living_area,
          cad: listing.cad_living_area_sqft,
        }))
      : null),
    [selectedListings],
  );
  const listingPrices = useMemo(
    () => selectedListings.map((listing) => saleNumber(listing?.sale_price)),
    [selectedListings],
  );
  const listingConcessions = useMemo(
    () => selectedListings.map((listing) => saleNumber(listing?.seller_contributions)),
    [selectedListings],
  );
  const listingLandSizes = useMemo(
    () => selectedListings.map((listing) => listing
      ? saleNumber(listing.comparableSiteSize) ?? mlsLotSizeSqft(listing.mls_lot_size_area)
      : null),
    [selectedListings, mlsLotSizeSqft],
  );
  const listingYearsBuilt = useMemo(
    () => selectedListings.map((listing) => listing
      ? saleNumber(listing.comparableYearBuilt) ?? saleNumber(
          resolveComparableCharacteristic({
            county: listing.county,
            trestle: listing.mls_year_built,
            cad: listing.cad_year_built,
          }),
        )
      : null),
    [selectedListings],
  );
  const listingBathroomGroups = useMemo(
    () => selectedListings.map((listing) => listing
      ? bathroomEquivalentValue(
          listing.mls_bathrooms_total_integer,
          listing.mls_bathrooms_full ?? listing.cad_baths_full,
          listing.mls_bathrooms_half ?? listing.cad_baths_half,
          listing.cad_bath_count,
        )
      : null),
    [selectedListings],
  );
  const listingBedroomCounts = useMemo(
    () => selectedListings.map((listing) => listing
      ? saleNumber(resolveComparableCharacteristic({
          county: listing.county,
          trestle: listing.mls_bedrooms_total,
          cad: listing.cad_bedroom_count,
        }))
      : null),
    [selectedListings],
  );
  const listingGarageGroups = useMemo(
    () => selectedListings.map((listing) => {
      const explicitSpaces = finiteNumber(listing?.mls_garage_spaces);
      if (explicitSpaces !== null && explicitSpaces >= 0) return Math.round(explicitSpaces);
      if (listing?.mls_garage_yn === false) return 0;
      return null;
    }),
    [selectedListings],
  );
  const listingPoolGroups = useMemo(
    () => selectedListings.map((listing) =>
      listing ? booleanValue(listing.mls_pool_yn ?? listing.cad_pool) : null),
    [selectedListings],
  );
  const listingRoomAdjustments = useMemo(
    () => listingBathroomGroups.map((comparableValue) =>
      calculateNumericGroupedAdjustment(
        appliedGroupedAdjustmentEntries,
        'bathrooms',
        subjectBathroomGroup,
        comparableValue,
      )),
    [appliedGroupedAdjustmentEntries, subjectBathroomGroup, listingBathroomGroups],
  );
  const listingGlaAdjustments = useMemo(
    () => listingLivingAreas.map((comparableValue) =>
      calculateLivingAreaGroupedAdjustment(
        appliedGroupedAdjustmentEntries,
        subjectLivingArea,
        comparableValue,
      )),
    [appliedGroupedAdjustmentEntries, subjectLivingArea, listingLivingAreas],
  );
  const listingGarageAdjustments = useMemo(
    () => listingGarageGroups.map((comparableValue) =>
      calculateNumericGroupedAdjustment(
        appliedGroupedAdjustmentEntries,
        'garage',
        subjectGarageGroup,
        comparableValue,
      )),
    [appliedGroupedAdjustmentEntries, subjectGarageGroup, listingGarageGroups],
  );
  const listingPoolAdjustments = useMemo(
    () => listingPoolGroups.map((comparableValue) =>
      calculatePoolGroupedAdjustment(
        appliedGroupedAdjustmentEntries,
        subjectPoolGroup,
        comparableValue,
      )),
    [appliedGroupedAdjustmentEntries, subjectPoolGroup, listingPoolGroups],
  );
  const listingConditionAdjustments = useMemo(
    () => selectedListings.map((listing) => {
      const applied = appliedConditionQualityAdjustments.condition;
      if (!listing || !applied) return 0;
      const rating = conditionQualityRatings[conditionQualitySaleKey(listing)]?.condition || '';
      return calculateRatingAdjustment(
        applied.amount,
        subjectCondition,
        rating,
        'condition',
      );
    }),
    [selectedListings, appliedConditionQualityAdjustments.condition, conditionQualityRatings, subjectCondition],
  );
  const listingQualityAdjustments = useMemo(
    () => selectedListings.map((listing) => {
      const applied = appliedConditionQualityAdjustments.quality;
      if (!listing || !applied) return 0;
      const rating = conditionQualityRatings[conditionQualitySaleKey(listing)]?.quality || '';
      return calculateRatingAdjustment(
        applied.amount,
        subjectQuality,
        rating,
        'quality',
      );
    }),
    [selectedListings, appliedConditionQualityAdjustments.quality, conditionQualityRatings, subjectQuality],
  );
  const listingNetAdjustments = useMemo(
    () => selectedListings.map((listing, index) => {
      if (!listing) return 0;
      const concession = listingConcessions[index] || 0;
      return (concession > 0 ? -concession : 0) +
        (listingRoomAdjustments[index] || 0) +
        (listingGlaAdjustments[index] || 0) +
        (listingGarageAdjustments[index] || 0) +
        (listingPoolAdjustments[index] || 0) +
        (listingConditionAdjustments[index] || 0) +
        (listingQualityAdjustments[index] || 0);
    }),
    [
      selectedListings,
      listingConcessions,
      listingRoomAdjustments,
      listingGlaAdjustments,
      listingGarageAdjustments,
      listingPoolAdjustments,
      listingConditionAdjustments,
      listingQualityAdjustments,
    ],
  );
  const listingGrossAdjustments = useMemo(
    () => selectedListings.map((listing, index) => {
      if (!listing) return 0;
      return Math.abs(listingConcessions[index] || 0) +
        Math.abs(listingRoomAdjustments[index] || 0) +
        Math.abs(listingGlaAdjustments[index] || 0) +
        Math.abs(listingGarageAdjustments[index] || 0) +
        Math.abs(listingPoolAdjustments[index] || 0) +
        Math.abs(listingConditionAdjustments[index] || 0) +
        Math.abs(listingQualityAdjustments[index] || 0);
    }),
    [
      selectedListings,
      listingConcessions,
      listingRoomAdjustments,
      listingGlaAdjustments,
      listingGarageAdjustments,
      listingPoolAdjustments,
      listingConditionAdjustments,
      listingQualityAdjustments,
    ],
  );
  const adjustedListingPrices = useMemo(
    () => listingPrices.map((price, index) => (price || 0) + (listingNetAdjustments[index] || 0)),
    [listingPrices, listingNetAdjustments],
  );

  const netAdjustments = useMemo<number[]>(() => {
    const arr: number[] = [];
    for (let i = 0; i < COMPARABLE_COUNT; i++) {
      const toNum = (v: any): number => {
        if (v === null || v === undefined || v === '') return 0;
        const n = typeof v === 'string' ? Number(String(v).replace(/[^0-9.-]/g, '')) : Number(v);
        return Number.isFinite(n) ? n : 0;
      };
      const concession = toNum((compConcessions || [])[i]);
      const timeAdj = toNum((compTimeAdjustments || [])[i]);
      const roomAdj = toNum((roomCountTotalAdjustments || [])[i]);
      const glaAdj = toNum((glaAdjustments || [])[i]);
      const garageAdj = toNum((garageAdjustments || [])[i]);
      const poolAdj = toNum((poolAdjustments || [])[i]);
      const conditionAdj = toNum((conditionAdjustments || [])[i]);
      const qualityAdj = toNum((qualityAdjustments || [])[i]);
      // Land Size and Age/Effective currently $0
      const landAdj = 0;
      const ageAdj = 0;
      const total = (concession > 0 ? -concession : 0) + timeAdj + roomAdj + glaAdj + garageAdj + poolAdj + conditionAdj + qualityAdj + landAdj + ageAdj;
      arr.push(total);
    }
    return arr;
  }, [compConcessions, compTimeAdjustments, roomCountTotalAdjustments, glaAdjustments, garageAdjustments, poolAdjustments, conditionAdjustments, qualityAdjustments]);

  // SALES/EQUITY: Gross Adjustments — sum of absolute values of all adjustments per comparable
  const grossAdjustments = useMemo<number[]>(() => {
    const arr: number[] = [];
    for (let i = 0; i < COMPARABLE_COUNT; i++) {
      const toNum = (v: any): number => {
        if (v === null || v === undefined || v === '') return 0;
        const n = typeof v === 'string' ? Number(String(v).replace(/[^0-9.-]/g, '')) : Number(v);
        return Number.isFinite(n) ? n : 0;
      };
      const concession = Math.abs(toNum((compConcessions || [])[i]));
      const timeAdj = Math.abs(toNum((compTimeAdjustments || [])[i]));
      const roomAdj = Math.abs(toNum((roomCountTotalAdjustments || [])[i]));
      const glaAdj = Math.abs(toNum((glaAdjustments || [])[i]));
      const garageAdj = Math.abs(toNum((garageAdjustments || [])[i]));
      const poolAdj = Math.abs(toNum((poolAdjustments || [])[i]));
      const conditionAdj = Math.abs(toNum((conditionAdjustments || [])[i]));
      const qualityAdj = Math.abs(toNum((qualityAdjustments || [])[i]));
      const landAdj = 0;
      const ageAdj = 0;
      const total = concession + timeAdj + roomAdj + glaAdj + garageAdj + poolAdj + conditionAdj + qualityAdj + landAdj + ageAdj;
      arr.push(total);
    }
    return arr;
  }, [compConcessions, compTimeAdjustments, roomCountTotalAdjustments, glaAdjustments, garageAdjustments, poolAdjustments, conditionAdjustments, qualityAdjustments]);

  // SALES: Indicated Values — sale price plus net adjustments per comparable
  const indicatedValues = useMemo<number[]>(() => {
    const arr: number[] = [];
    for (let i = 0; i < COMPARABLE_COUNT; i++) {
      const toNum = (v: any): number => {
        if (v === null || v === undefined || v === '') return 0;
        const n = typeof v === 'string' ? Number(String(v).replace(/[^0-9.-]/g, '')) : Number(v);
        return Number.isFinite(n) ? n : 0;
      };
      const price = toNum((compPrices || [])[i]);
      const net = toNum((netAdjustments || [])[i]);
      arr.push(price + net);
    }
    return arr;
  }, [compPrices, netAdjustments]);

  // SALES: Opinion of Market Value - median of indicated values (non-zero)
  const opinionMedian = useMemo<number | null>(() => {
    const vals = (indicatedValues || [])
      .map((v) => (typeof v === 'string' ? Number(String(v).replace(/[^0-9.-]/g, '')) : Number(v)))
      .filter((n) => Number.isFinite(n) && n > 0)
      .sort((a, b) => a - b);
    if (!vals.length) return null;
    const mid = Math.floor(vals.length / 2);
    const median = vals.length % 2 === 0 ? (vals[mid - 1] + vals[mid]) / 2 : vals[mid];
    return Math.round(median);
  }, [indicatedValues]);

  // OPINION ADJUSTMENT: subtract the current user-entered Cost to Cure.
  const opinionAfterCtc = useMemo<number | null>(() => {
    if (opinionMedian == null) return null;
    const adjusted = Math.round(opinionMedian - costToCureTotal);
    return adjusted > 0 ? adjusted : 0;
  }, [costToCureTotal, opinionMedian]);

  // Keep the current sales-comparison workfile available to the printable
  // appraisal report. This remains browser-local until a server-side report
  // workfile is introduced.
  useEffect(() => {
    if (!propertyId || !subject || !selectedSales.some(Boolean)) return;
    saveAppraisalReportDraft({
      version: 1,
      accountId: propertyId,
      savedAt: new Date().toISOString(),
      source: 'sales-comparison-workspace',
      subject: {
        accountId: propertyId,
        address: subject.address,
        neighborhoodCode: subject.nbhd_code,
        marketValue: subject.market_value,
        livingArea: subject.total_living_area,
        bedrooms: subject.bedroom_count,
        bathsFull: subject.baths_full,
        bathsHalf: subject.baths_half,
        bathCount: subject.bath_count,
        condition: subjectCondition,
        quality: subjectQuality,
      },
      comparables: selectedSales.flatMap((sale, index) => {
        if (!sale) return [];
        return [{
          sale,
          condition: compConditions[index] || '',
          quality: compQualities[index] || '',
          netAdjustment: netAdjustments[index] || 0,
          grossAdjustment: grossAdjustments[index] || 0,
          indicatedValue: indicatedValues[index] || finiteNumber(sale.sale_price) || 0,
          adjustments: {
            concessions: finiteNumber(compConcessions[index]) || 0,
            time: finiteNumber(compTimeAdjustments[index]) || 0,
            roomCount: roomCountTotalAdjustments[index] || 0,
            livingArea: glaAdjustments[index] || 0,
            garage: garageAdjustments[index] || 0,
            pool: poolAdjustments[index] || 0,
            condition: conditionAdjustments[index] || 0,
            quality: qualityAdjustments[index] || 0,
          },
        }];
      }),
      opinionOfValue: opinionMedian,
      opinionAfterCostToCure: opinionAfterCtc,
      costToCure: {
        items: serializedCostToCureItems,
        total: costToCureTotal,
      },
      salesNotes,
      adjustmentNotes,
    });
  }, [
    propertyId,
    subject,
    selectedSales,
    subjectCondition,
    subjectQuality,
    compConditions,
    compQualities,
    netAdjustments,
    grossAdjustments,
    indicatedValues,
    compConcessions,
    compTimeAdjustments,
    roomCountTotalAdjustments,
    glaAdjustments,
    garageAdjustments,
    poolAdjustments,
    conditionAdjustments,
    qualityAdjustments,
    serializedCostToCureItems,
    costToCureTotal,
    opinionMedian,
    opinionAfterCtc,
    salesNotes,
    adjustmentNotes,
  ]);

  // Derived room counts for subject column
  const subjectBedrooms = useMemo(() => {
    return parseWholeCount(subject?.bedroom_count);
  }, [subject?.bedroom_count]);
  const subjectBathsDisplay = useMemo(() => {
    return formatBathCount(subject?.baths_full, subject?.baths_half, subject?.bath_count);
  }, [subject?.baths_full, subject?.baths_half, subject?.bath_count]);
  const subjectTotalRooms = useMemo(() => {
    if (subjectBedrooms === undefined) return undefined;
    return (subjectBedrooms as number) + 3;
  }, [subjectBedrooms]);

  const groupedStudiesFor = (dimensionKey: AppliedGroupedAdjustment['dimensionKey']) =>
    appliedGroupedAdjustmentEntries.filter((adjustment) => adjustment.dimensionKey === dimensionKey);

  const signedAdjustment = (value: number) => {
    const formatted = fmtCurrency(Math.abs(value));
    return value > 0 ? `+${formatted}` : value < 0 ? `−${formatted}` : formatted;
  };

  const groupedBreakdownSummary = (
    dimensionKey: AppliedGroupedAdjustment['dimensionKey'],
    gridAdjustments: number[],
  ) => {
    const studies = groupedStudiesFor(dimensionKey);
    if (!studies.length) {
      return 'No market adjustment has been applied yet. Run a supported methodology above, enter any desired factor, and apply its result to update the grid.';
    }
    const study = studies[studies.length - 1];
    const isPairedStudy = study.id.startsWith('paired:');
    const unitLabel = dimensionKey === 'bathrooms'
      ? 'full-bath equivalent'
      : dimensionKey === 'garage'
        ? 'garage space'
        : dimensionKey === 'living_area'
          ? 'square foot'
          : 'pool difference';
    const hasLivingAreaFormula =
      dimensionKey === 'living_area' &&
      study.sourcePriceDifference != null &&
      study.sourceLivingAreaDifference != null &&
      Number.isFinite(study.sourcePriceDifference) &&
      Number.isFinite(study.sourceLivingAreaDifference) &&
      study.sourceLivingAreaDifference > 0;
    const appliedText = hasLivingAreaFormula
      ? `${study.marketLabel} — ${study.transitionLabel} ${study.optionLabel}: ` +
        `${signedAdjustment(study.sourcePriceDifference!)} ÷ ` +
        `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(study.sourceLivingAreaDifference!)} SF = ` +
        `${signedAdjustment(study.baseAmount)} per SF; ${study.factorPercent}% factoring = ` +
        `${signedAdjustment(study.amount)} per SF`
      : isPairedStudy
        ? `${study.marketLabel} — ${study.transitionLabel} ${study.optionLabel}: ` +
          `${signedAdjustment(study.baseAmount)} × ${study.factorPercent}% factoring = ` +
          `${signedAdjustment(study.amount)} per ${unitLabel}`
        : `${study.marketLabel} — ${study.transitionLabel} study selected: ` +
          `${signedAdjustment(study.baseAmount)} × ${study.factorPercent}% = ` +
          `${signedAdjustment(study.amount)} per ${unitLabel}`;
    const selectedCount = selectedSales.filter(Boolean).length;
    const affectedCount = gridAdjustments.filter((amount, index) => selectedSales[index] && amount !== 0).length;
    return `${appliedText}. This universal rate currently adjusts ${affectedCount} of ${selectedCount} selected comparable${selectedCount === 1 ? '' : 's'}.`;
  };

  const previewGroupedAdjustment = (
    draftAdjustment: AppliedGroupedAdjustment,
  ): GroupedAdjustmentImpactPreview => {
    const candidateAdjustments = [draftAdjustment];
    let adjustments: number[];

    if (draftAdjustment.dimensionKey === 'bathrooms') {
      adjustments = comparableBathroomGroups.map((comparableValue) =>
        calculateNumericGroupedAdjustment(
          candidateAdjustments,
          'bathrooms',
          subjectBathroomGroup,
          comparableValue,
        ));
    } else if (draftAdjustment.dimensionKey === 'garage') {
      adjustments = comparableGarageGroups.map((comparableValue) =>
        calculateNumericGroupedAdjustment(
          candidateAdjustments,
          'garage',
          subjectGarageGroup,
          comparableValue,
        ));
    } else if (draftAdjustment.dimensionKey === 'living_area') {
      adjustments = compGla.map((comparableValue) =>
        calculateLivingAreaGroupedAdjustment(
          candidateAdjustments,
          subjectLivingArea,
          finiteNumber(comparableValue),
        ));
    } else {
      adjustments = comparablePoolGroups.map((comparableValue) =>
        calculatePoolGroupedAdjustment(
          candidateAdjustments,
          subjectPoolGroup,
          comparableValue,
        ));
    }

    const selectedCount = selectedSales.filter(Boolean).length;
    const affectedCount = adjustments.filter(
      (amount, index) => selectedSales[index] && amount !== 0,
    ).length;
    return { adjustments, selectedCount, affectedCount };
  };

  const groupedGridImpact = (gridAdjustments: number[]) => {
    const impacts = gridAdjustments
      .map((amount, index) => selectedSales[index] ? `Comp ${index + 1}: ${signedAdjustment(amount)}` : null)
      .filter(Boolean);
    return impacts.length ? impacts.join(' · ') : 'Add comparables to see the grid impact.';
  };

  const updateConditionQualityRating = (
    sale: SaleRow,
    dimension: 'condition' | 'quality',
    value: string,
  ) => {
    const key = conditionQualitySaleKey(sale);
    setRatingSaleSources((current) => ({ ...current, [key]: sale }));
    setDirtyRatingKeys((current) => ({ ...current, [key]: true }));
    setRatingPersistenceError(null);
    setConditionQualityRatings((current) => ({
      ...current,
      [key]: {
        condition: current[key]?.condition || '',
        quality: current[key]?.quality || '',
        [dimension]: value,
      },
    }));

    selectedSales.forEach((selectedSale, index) => {
      if (!selectedSale || conditionQualitySaleKey(selectedSale) !== key) return;
      if (dimension === 'condition') {
        setCompConditions((current) =>
          current.map((item, itemIndex) => itemIndex === index ? value : item));
      } else {
        setCompQualities((current) =>
          current.map((item, itemIndex) => itemIndex === index ? value : item));
      }
    });
  };

  const previewConditionQualityAdjustment = (
    draftAdjustment: AppliedConditionQualityAdjustment,
  ): ConditionQualityImpactPreview => {
    const adjustments = Array.from({ length: COMPARABLE_COUNT }, (_, index) => {
      if (!selectedSales[index]) return 0;
      return calculateRatingAdjustment(
        draftAdjustment.amount,
        draftAdjustment.dimension === 'condition'
          ? subjectCondition
          : subjectQuality,
        draftAdjustment.dimension === 'condition'
          ? (compConditions[index] || '')
          : (compQualities[index] || ''),
        draftAdjustment.dimension,
      );
    });
    const selectedCount = selectedSales.filter(Boolean).length;
    const affectedCount = adjustments.filter(
      (amount, index) => selectedSales[index] && amount !== 0,
    ).length;
    return { adjustments, selectedCount, affectedCount };
  };

  const conditionQualityBreakdownSummary = (
    dimension: 'condition' | 'quality',
    gridAdjustments: number[],
  ) => {
    const applied = appliedConditionQualityAdjustments[dimension];
    if (!applied) {
      return `No ${dimension} study adjustment has been applied. Run the Condition and Quality Study, rate the selected market sales, and apply a supported tile to update the grid.`;
    }
    const selectedCount = selectedSales.filter(Boolean).length;
    const affectedCount = gridAdjustments.filter(
      (amount, index) => selectedSales[index] && amount !== 0,
    ).length;
    return `${applied.marketLabel} — ${applied.transitionLabel} ${applied.optionLabel}: ` +
      `${signedAdjustment(applied.rawDifference)} ÷ ${applied.gradeDifference} grade` +
      `${applied.gradeDifference === 1 ? '' : 's'} = ${signedAdjustment(applied.baseAmount)} per grade; ` +
      `${applied.factorPercent}% factoring = ${signedAdjustment(applied.amount)} per full grade. ` +
      `Half-grade ranges receive half the rate. This currently adjusts ${affectedCount} of ${selectedCount} selected comparable${selectedCount === 1 ? '' : 's'}.`;
  };

  const subjectRatingsApplied = Boolean(
    subjectCondition &&
    subjectQuality &&
    subjectCondition === draftSubjectCondition &&
    subjectQuality === draftSubjectQuality,
  );

  const applySubjectRatings = () => {
    const condition = normalizeUadRating(draftSubjectCondition, 'condition');
    const quality = normalizeUadRating(draftSubjectQuality, 'quality');
    if (!condition || !quality) return;
    setSubjectCondition(condition);
    setSubjectQuality(quality);
    setSubjectRatingDirty(true);
    setRatingPersistenceError(null);
    setSalesNotice(
      `Applied subject ratings ${condition} / ${quality}. Condition and quality adjustments remain at zero until a study tile is applied.`,
    );
  };

  const hasUnsavedRatingChanges = subjectRatingDirty || Object.keys(dirtyRatingKeys).length > 0;

  const revertRatingChanges = () => {
    const savedCondition = savedSubjectRating?.condition_rating || normalizeUadConditionRating(conditionCode);
    const savedQuality = savedSubjectRating?.quality_rating || '';
    setSubjectCondition(savedCondition);
    setSubjectQuality(savedQuality);
    setDraftSubjectCondition(savedCondition);
    setDraftSubjectQuality(savedQuality);
    setConditionQualityRatings((current) => {
      const next = { ...current };
      Object.keys(dirtyRatingKeys).forEach((key) => {
        next[key] = savedConditionQualityRatings[key] || { condition: '', quality: '' };
      });
      return next;
    });
    setCompConditions((current) => current.map((value, index) => {
      const sale = selectedSales[index];
      if (!sale) return value;
      const key = conditionQualitySaleKey(sale);
      return dirtyRatingKeys[key]
        ? (savedConditionQualityRatings[key]?.condition || '')
        : value;
    }));
    setCompQualities((current) => current.map((value, index) => {
      const sale = selectedSales[index];
      if (!sale) return value;
      const key = conditionQualitySaleKey(sale);
      return dirtyRatingKeys[key]
        ? (savedConditionQualityRatings[key]?.quality || '')
        : value;
    }));
    setDirtyRatingKeys({});
    setSubjectRatingDirty(false);
    setRatingPersistenceError(null);
    setSalesNotice('Unsaved condition and quality changes were reverted.');
  };

  const saveRatingChanges = async () => {
    const editorKey = housingEditorKey.trim();
    if (!editorKey) {
      setRatingPersistenceError('Enter your personal editor key before saving ratings.');
      return;
    }
    if (!hasUnsavedRatingChanges) {
      setSalesNotice('Condition and quality ratings are already saved.');
      return;
    }
    setRatingPersistenceSaving(true);
    setRatingPersistenceError(null);
    try {
      let savedSubject = savedSubjectRating;
      if (subjectRatingDirty) {
        savedSubject = await api.updateSubjectAppraisalRating(
          propertyId,
          salesAnalysisAsOf,
          {
            condition_rating: subjectCondition || null,
            quality_rating: subjectQuality || null,
            expected_revision: savedSubjectRating?.revision || 0,
            clear: !subjectCondition && !subjectQuality,
          },
          editorKey,
        );
        setSavedSubjectRating(savedSubject);
        setSubjectRatingDirty(false);
      }

      const savedReviews: Array<{ key: string; review: api.AppraisalRatingReview }> = [];
      for (const key of Object.keys(dirtyRatingKeys)) {
        const sale = ratingSaleSources[key];
        const assignment = conditionQualityRatings[key];
        if (!sale?.source_record_id) {
          throw new Error(
            `Cannot save ${sale ? saleDisplayAddress(sale) : key} because it has no immutable MLS source record.`,
          );
        }
        const review = await api.updateSaleAppraisalReview(
          sale.source_record_id,
          {
            condition_rating: assignment.condition || null,
            quality_rating: assignment.quality || null,
            expected_revision: saleReviewMetadata[key]?.revision || 0,
            clear: !assignment.condition && !assignment.quality,
          },
          editorKey,
        );
        savedReviews.push({ key, review });
        setSavedConditionQualityRatings((current) => ({
          ...current,
          [key]: {
            condition: review.condition_rating || '',
            quality: review.quality_rating || '',
          },
        }));
        setSaleReviewMetadata((current) => ({ ...current, [key]: review }));
        setDirtyRatingKeys((current) => {
          const next = { ...current };
          delete next[key];
          return next;
        });
      }

      if (savedReviews.length) {
        setSavedConditionQualityRatings((current) => {
          const next = { ...current };
          savedReviews.forEach(({ key, review }) => {
            next[key] = {
              condition: review.condition_rating || '',
              quality: review.quality_rating || '',
            };
          });
          return next;
        });
        setSaleReviewMetadata((current) => {
          const next = { ...current };
          savedReviews.forEach(({ key, review }) => { next[key] = review; });
          return next;
        });
      }
      try {
        window.sessionStorage.setItem('homenode-editor-key', editorKey);
      } catch {
        // Saving does not depend on browser storage availability.
      }
      const savedAt = savedReviews[savedReviews.length - 1]?.review.updated_at || savedSubject?.updated_at || new Date().toISOString();
      setRatingsSavedAt(savedAt);
      setDirtyRatingKeys({});
      setSubjectRatingDirty(false);
      setSalesNotice(
        `Saved ${subjectRatingDirty ? 'the subject rating' : ''}${subjectRatingDirty && savedReviews.length ? ' and ' : ''}` +
        `${savedReviews.length ? `${savedReviews.length} comparable rating${savedReviews.length === 1 ? '' : 's'}` : ''} to the database.`,
      );
    } catch (saveError) {
      const message = saveError instanceof Error ? saveError.message : 'Condition and quality ratings could not be saved.';
      if (message.includes('rating_revision_conflict')) {
        setRatingPersistenceError('These ratings changed in another session. Reload them before saving again.');
      } else if (message.includes('invalid_editor_key')) {
        setRatingPersistenceError('The editor key was not accepted. Check it and try again.');
      } else if (message.includes('editor_not_configured')) {
        setRatingPersistenceError('Manual database editing has not been enabled on the server yet.');
      } else {
        setRatingPersistenceError(message);
      }
    } finally {
      setRatingPersistenceSaving(false);
    }
  };

  const runListingSearch = async () => {
    if (!propertyId) {
      setListingError('A subject property is required before comparable listings can be loaded.');
      return;
    }
    setListingLoading(true);
    setListingError(null);
    setListingNotice(null);
    try {
      const rows = await api.searchSales({
        q: listingQuery.trim() || undefined,
        subjectAccountId: propertyId,
        excludeAccountId: propertyId,
        recordType: 'listing',
        limit: 100,
      });
      setListingResults(rows);
      if (!rows.length) {
        setListingError('No listing records matched this search.');
      }
    } catch (searchError: any) {
      setListingResults([]);
      setListingError(searchError?.message || 'Comparable listing search failed.');
    } finally {
      setListingLoading(false);
    }
  };

  const addListingToGrid = (listing: SaleRow) => {
    if (selectedListings.some((item) => item && saleKey(item) === saleKey(listing))) {
      setListingNotice(`${saleDisplayAddress(listing)} is already in the listing grid.`);
      return;
    }
    const openSlot = selectedListings.findIndex((item) => item === null);
    if (openSlot < 0) {
      setListingError('Six comparable listings are already selected. Remove one before adding another.');
      return;
    }
    setSelectedListings((current) => current.map((item, index) => index === openSlot ? listing : item));
    setListingError(null);
    setListingNotice(`${saleDisplayAddress(listing)} was added as Listing ${openSlot + 1}.`);
  };

  const removeListingFromGrid = (slot: number) => {
    setSelectedListings((current) => current.map((item, index) => index === slot ? null : item));
    setListingError(null);
  };

  const moveListing = (from: number, to: number) => {
    if (
      from < 0 ||
      from >= LISTING_COUNT ||
      to < 0 ||
      to >= LISTING_COUNT ||
      !selectedListings[from]
    ) return;
    setSelectedListings((current) => swapArrayItems(current, from, to));
  };

  const clearListings = () => {
    setSelectedListings(Array(LISTING_COUNT).fill(null));
    setListingError(null);
    setListingNotice(null);
  };

  const renderListingAdjustmentGrid = () => {
    const currentYear = new Date(`${salesAnalysisAsOf}T12:00:00`).getFullYear();
    const subjectHousing = subject?.structural_style || subject?.housing_type || 'Not available';
    const adjustmentRows = [
      {
        label: 'Concessions',
        subject: fmtCurrency(0),
        description: (_listing: SaleRow, slot: number) => fmtCurrency(listingConcessions[slot] ?? 0),
        adjustment: (_listing: SaleRow, slot: number) => -(Math.abs(listingConcessions[slot] || 0)),
      },
      {
        label: 'NBHD Code',
        subject: subject?.nbhd_code || '',
        description: (listing: SaleRow) => listing.neighborhood_code || '',
      },
      {
        label: 'Date of Sale/Time',
        subject: '—',
        description: (listing: SaleRow) => `${saleDateDisplay(listing.listing_contract_date)} · ${listing.days_on_market ?? '—'} DOM`,
        adjustment: () => 0,
      },
      {
        label: 'Land Size',
        subject: fmtSqftSafe(subject?.land_size_sqft),
        description: (_listing: SaleRow, slot: number) => fmtSqftSafe(listingLandSizes[slot]),
        adjustment: () => 0,
      },
      { label: 'View', subject: subject?.view || 'Neutral', description: () => 'Neutral' },
      { label: 'Housing Type', subject: subjectHousing, description: (listing: SaleRow) => housingTypeGridValue(listing) },
      { label: 'Architectural Style', subject: subject?.architectural_style || 'Not available', description: (listing: SaleRow) => listing.architectural_style || 'Not available' },
      { label: 'Const Type', subject: normalizeConstType(subject?.stories, subject?.construction_type), description: (listing: SaleRow) => normalizeConstType(listing.cad_stories, listing.structural_style) },
      {
        label: 'Age/Effective',
        subject: subject?.actual_age ?? '',
        description: (_listing: SaleRow, slot: number) => listingYearsBuilt[slot] == null ? '' : Math.max(0, currentYear - Number(listingYearsBuilt[slot])),
        adjustment: () => 0,
      },
      {
        label: 'Condition',
        subject: subjectCondition,
        description: (listing: SaleRow, slot: number) => (
          <UadRatingSelect
            ariaLabel={`Listing ${slot + 1} condition`}
            value={conditionQualityRatings[conditionQualitySaleKey(listing)]?.condition || ''}
            ratings={UAD_CONDITION_RATINGS}
            onChange={(value) => updateConditionQualityRating(listing, 'condition', value)}
          />
        ),
        adjustment: (_listing: SaleRow, slot: number) => listingConditionAdjustments[slot] || 0,
      },
      {
        label: 'Quality',
        subject: subjectQuality,
        description: (listing: SaleRow, slot: number) => (
          <UadRatingSelect
            ariaLabel={`Listing ${slot + 1} quality`}
            value={conditionQualityRatings[conditionQualitySaleKey(listing)]?.quality || ''}
            ratings={UAD_QUALITY_RATINGS}
            onChange={(value) => updateConditionQualityRating(listing, 'quality', value)}
          />
        ),
        adjustment: (_listing: SaleRow, slot: number) => listingQualityAdjustments[slot] || 0,
      },
    ];
    const featureRows = [
      { label: 'Basement SF', subject: fmtSqftSafe(subject?.basement_sqft), description: () => 'N/A' },
      { label: 'Functional Utility', subject: 'Adequate', description: () => 'Adequate' },
      { label: 'Heating/Cooling', subject: [subject?.heating, subject?.air_conditioning].filter(Boolean).join(' / '), description: () => 'Not available' },
      { label: 'Solar Panels', subject: 'None', description: () => 'None' },
      {
        label: 'Garage/Parking',
        subject: subjectGarageGroup == null ? 'Not available' : `${subjectGarageGroup} ${subjectGarageGroup === 1 ? 'space' : 'spaces'}`,
        description: (_listing: SaleRow, slot: number) => listingGarageGroups[slot] == null ? 'Not available' : `${listingGarageGroups[slot]} ${listingGarageGroups[slot] === 1 ? 'space' : 'spaces'}`,
        adjustment: (_listing: SaleRow, slot: number) => listingGarageAdjustments[slot] || 0,
      },
      { label: 'Porches/Decks', subject: 'N/A', description: () => 'N/A' },
      { label: 'Fencing', subject: 'N/A', description: () => 'N/A' },
      {
        label: 'Pool',
        subject: poolDisplay(subject?.pool),
        description: (listing: SaleRow) => poolDisplay(listing.mls_pool_yn ?? listing.cad_pool),
        adjustment: (_listing: SaleRow, slot: number) => listingPoolAdjustments[slot] || 0,
      },
      { label: 'Secondary Improvements', subject: 'N/A', description: () => 'N/A' },
    ];
    const pairedCells = (
      keyPrefix: string,
      description: (listing: SaleRow, slot: number) => ReactNode,
      adjustment?: (listing: SaleRow, slot: number) => number,
    ) => selectedListings.flatMap((listing, slot) => [
      <td key={`${keyPrefix}-description-${slot}`} className="border-b border-slate-200 px-4 py-2">
        {listing ? description(listing, slot) : ''}
      </td>,
      <td key={`${keyPrefix}-adjustment-${slot}`} className="border-b border-r border-slate-200 px-4 py-2" style={{ borderLeft: '2px solid #e2e8f0' }}>
        {listing && adjustment ? fmtCurrency(adjustment(listing, slot) || 0) : ''}
      </td>,
    ]);

    return (
      <div className="overflow-x-auto p-4">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm font-semibold text-slate-900">Selected Comparable Listings Grid</div>
          <div className="text-xs text-slate-500">Applied study rates are shared with the closed-sale grid.</div>
        </div>
        <div style={{ minWidth: '108rem' }}>
          <table className="tight-grid w-full table-fixed border-separate border-spacing-0 text-sm">
            <colgroup>
              <col style={{ width: '8rem' }} />
              <col style={{ width: '10rem' }} />
              {Array.from({ length: LISTING_COUNT }).flatMap((_, slot) => [
                <col key={`listing-description-width-${slot}`} style={{ width: '9rem' }} />,
                <col key={`listing-adjustment-width-${slot}`} style={{ width: '6rem' }} />,
              ])}
            </colgroup>
            <thead>
              <tr className="text-slate-700">
                <th className="border-b border-slate-300 bg-white px-4 py-2 text-left">Feature</th>
                <th className="border-b border-slate-300 px-4 py-2 text-left" style={{ backgroundColor: '#FEF3C7' }}>Subject</th>
                {selectedListings.map((listing, slot) => (
                  <th key={`listing-heading-${slot}`} colSpan={2} className="border-b border-r border-slate-300 bg-white px-4 py-2 text-left align-top">
                    <div className="flex flex-col gap-1.5">
                      <span>Listing {slot + 1}</span>
                      {listing ? (
                        <div className="flex flex-wrap gap-1">
                          <button type="button" aria-label={`Move Listing ${slot + 1} left`} disabled={slot === 0} onClick={() => moveListing(slot, slot - 1)} className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-xs disabled:opacity-30">←</button>
                          <button type="button" aria-label={`Move Listing ${slot + 1} right`} disabled={slot === LISTING_COUNT - 1} onClick={() => moveListing(slot, slot + 1)} className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-xs disabled:opacity-30">→</button>
                          <button type="button" onClick={() => removeListingFromGrid(slot)} className="rounded border border-red-200 bg-white px-1.5 py-0.5 text-xs font-medium text-red-700">Remove</button>
                        </div>
                      ) : <span className="text-xs font-normal text-slate-500">Not selected</span>}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="border-b border-slate-200 bg-white px-4 py-2">Photo</td>
                <td className="border-b border-slate-200 px-4 py-2" style={{ backgroundColor: '#FEF3C7' }}><MlsPhoto src={subjectPhotos[0]?.media_url} alt={subject?.address || propertyId || 'Subject property'} photoCount={subjectPhotos.length} onOpen={subjectPhotos.length ? openSubjectGallery : undefined} /></td>
                {pairedCells('listing-photo', (listing) => <MlsPhoto src={listing.primary_photo_url} alt={saleDisplayAddress(listing)} photoCount={Number(listing.photo_count || 0)} onOpen={listing.primary_photo_url ? () => void openSaleGallery(listing) : undefined} />)}
              </tr>
              {[
                { label: 'Address', subject: subject?.address || '', value: (listing: SaleRow) => saleDisplayAddress(listing) },
                { label: 'MLS Number', subject: 'Subject', value: (listing: SaleRow) => listing.listing_id || '—' },
                { label: 'Listing Status', subject: '—', value: (listing: SaleRow) => listing.mls_status || 'Status unavailable' },
                { label: 'Value vs Listing', subject: fmtCurrency(subject?.market_value ?? ''), value: (_listing: SaleRow, slot: number) => fmtCurrency(listingPrices[slot] ?? '') },
              ].map((row) => (
                <tr key={`listing-core-${row.label}`}>
                  <td className="border-b border-slate-200 bg-white px-4 py-2">{row.label}</td>
                  <td className="border-b border-slate-200 px-4 py-2" style={{ backgroundColor: '#FEF3C7' }}>{row.subject}</td>
                  {pairedCells(`listing-core-${row.label}`, row.value)}
                </tr>
              ))}
              <tr className="font-semibold">
                <td className="border-b border-slate-300 bg-slate-100 px-4 py-2">ADJUSTMENTS</td>
                <td className="border-b border-slate-300 px-4 py-2" style={{ backgroundColor: '#FEF3C7' }}>Description</td>
                {selectedListings.flatMap((_, slot) => [
                  <td key={`listing-adjustment-description-${slot}`} className="border-b border-slate-300 px-4 py-2">Description</td>,
                  <td key={`listing-adjustment-heading-${slot}`} className="border-b border-r border-slate-300 px-4 py-2" style={{ borderLeft: '2px solid #e2e8f0' }}>Adjustment</td>,
                ])}
              </tr>
              {adjustmentRows.map((row) => (
                <tr key={`listing-adjustment-${row.label}`}>
                  <td className="border-b border-slate-200 bg-white px-4 py-2">{row.label}</td>
                  <td className="border-b border-slate-200 px-4 py-2" style={{ backgroundColor: '#FEF3C7' }}>{row.subject}</td>
                  {pairedCells(`listing-adjustment-${row.label}`, row.description, row.adjustment)}
                </tr>
              ))}
              <tr>
                <td className="border-b border-slate-200 bg-white px-4 py-2">Above Grade</td>
                <td className="border-b border-slate-200 px-4 py-2" style={{ backgroundColor: '#FEF3C7' }}><div className="grid grid-cols-3 text-center"><span>Total</span><span className="border-l-2 border-slate-300">Beds</span><span className="border-l-2 border-slate-300">Baths</span></div></td>
                {pairedCells('listing-above-grade', () => <div className="grid grid-cols-3 text-center"><span>Tot</span><span className="border-l-2 border-slate-300">Bd</span><span className="border-l-2 border-slate-300">Bt</span></div>)}
              </tr>
              <tr>
                <td className="border-b border-slate-200 bg-white px-4 py-2">Room Count</td>
                <td className="border-b border-slate-200 px-4 py-2" style={{ backgroundColor: '#FEF3C7' }}><div className="grid grid-cols-3 text-center"><span>{subjectTotalRooms ?? ''}</span><span className="border-l-2 border-slate-300">{subjectBedrooms ?? ''}</span><span className="border-l-2 border-slate-300">{subjectBathsDisplay}</span></div></td>
                {pairedCells('listing-room-count', (listing, slot) => {
                  const bedrooms = listingBedroomCounts[slot];
                  const full = saleNumber(listing.mls_bathrooms_full ?? listing.cad_baths_full);
                  const half = saleNumber(listing.mls_bathrooms_half ?? listing.cad_baths_half) || 0;
                  const bathText = full == null ? (listingBathroomGroups[slot] ?? '') : `${Math.round(full)}.${Math.round(half)}`;
                  return <div className="grid grid-cols-3 text-center"><span>{bedrooms == null ? '' : Math.round(bedrooms) + 3}</span><span className="border-l-2 border-slate-300">{bedrooms == null ? '' : Math.round(bedrooms)}</span><span className="border-l-2 border-slate-300">{bathText}</span></div>;
                }, (_listing, slot) => listingRoomAdjustments[slot] || 0)}
              </tr>
              <tr>
                <td className="border-b border-slate-200 bg-white px-4 py-2">Gross Living Area</td>
                <td className="border-b border-slate-200 px-4 py-2" style={{ backgroundColor: '#FEF3C7' }}>{fmtSqftSafe(subject?.total_living_area)}</td>
                {pairedCells('listing-gla', (_listing, slot) => fmtSqftSafe(listingLivingAreas[slot]), (_listing, slot) => listingGlaAdjustments[slot] || 0)}
              </tr>
              {featureRows.map((row) => (
                <tr key={`listing-feature-${row.label}`}>
                  <td className="border-b border-slate-200 bg-white px-4 py-2">{row.label}</td>
                  <td className="border-b border-slate-200 px-4 py-2" style={{ backgroundColor: '#FEF3C7' }}>{row.subject}</td>
                  {pairedCells(`listing-feature-${row.label}`, row.description, row.adjustment)}
                </tr>
              ))}
              {[
                { label: 'Net Adjustments', values: listingNetAdjustments },
                { label: 'Gross Adjustments', values: listingGrossAdjustments },
              ].map((row) => (
                <tr key={`listing-total-${row.label}`} className="font-medium">
                  <td className="border-b border-slate-300 bg-white px-4 py-2">{row.label}</td>
                  <td className="border-b border-slate-300 px-4 py-2" style={{ backgroundColor: '#FEF3C7' }}>—</td>
                  {selectedListings.flatMap((listing, slot) => [<td key={`${row.label}-desc-${slot}`} className="border-b border-slate-300" />, <td key={`${row.label}-adj-${slot}`} className="border-b border-r border-slate-300 px-4 py-2" style={{ borderLeft: '2px solid #e2e8f0' }}>{listing ? fmtCurrency(row.values[slot] || 0) : ''}</td>])}
                </tr>
              ))}
              <tr className="font-semibold">
                <td className="border-y border-slate-300 bg-sky-200 px-4 py-2">ADJUSTED LIST PRICE</td>
                <td className="border-y border-slate-300 px-4 py-2" style={{ backgroundColor: '#FEF3C7' }}>—</td>
                {selectedListings.flatMap((listing, slot) => [<td key={`listing-indication-desc-${slot}`} className="border-y border-slate-300 bg-slate-100" />, <td key={`listing-indication-adj-${slot}`} className="border-y border-r border-slate-300 bg-slate-100 px-4 py-2" style={{ borderLeft: '2px solid #e2e8f0' }}>{listing ? fmtCurrency(adjustedListingPrices[slot] || 0) : ''}</td>])}
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  return (
    <div className="sales-comparison-compact min-h-screen bg-base-200">
      <div className="max-w-6xl mx-auto p-4">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold">Comparable Sales Analysis</h1>
            <div className="text-sm opacity-70">
              {subject?.address || `Property ID: ${propertyId || '(none provided)'}`}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Link
              to={`/PropertyTaxProtest?propertyId=${encodeURIComponent(propertyId)}`}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-emerald-600 border border-emerald-600 text-white hover:bg-emerald-700"
              aria-label="File My Protest"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16l4-4h10a2 2 0 0 0 2-2V8z"/><line x1="12" y1="10" x2="12" y2="16"/><line x1="9" y1="13" x2="15" y2="13"/></svg>
              File My Protest
            </Link>
            <Link
              to={`/AppraisalReport?propertyId=${encodeURIComponent(propertyId)}`}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-blue-600 border border-blue-600 text-white hover:bg-blue-700"
              aria-label="Generate Full Appraisal PDF"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16l4-4h10a2 2 0 0 0 2-2V8z"/><path d="M12 12h3"/><path d="M12 15h3"/><path d="M9 12h.01"/><path d="M9 15h.01"/></svg>
              Full Appraisal PDF
            </Link>
            <button
              type="button"
              onClick={() => {
                if (propertyId) navigate(`/report/${encodeURIComponent(propertyId)}`);
                else navigate(-1);
              }}
              className="btn normal-case px-4 py-2 rounded-md bg-slate-100 border border-slate-300 text-slate-700 hover:bg-slate-200"
            >
              Close Report
            </button>
          </div>
        </div>

        <div className={`mb-4 rounded-xl border px-4 py-3 text-sm ${
          marketConditionsDraft
            ? 'border-emerald-200 bg-emerald-50 text-emerald-950'
            : 'border-amber-200 bg-amber-50 text-amber-950'
        }`}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="font-semibold">
                {marketConditionsDraft
                  ? 'Market Conditions Analysis complete'
                  : 'Market Conditions Analysis required'}
              </div>
              <div className="mt-0.5 text-xs opacity-80">
                Market studies and the appraiser-defined neighborhood area are now completed in Neighborhood Characteristics on the Property Report page.
              </div>
            </div>
            <Link
              to={`/report/${encodeURIComponent(propertyId)}`}
              className="rounded-md border border-current bg-white px-3 py-2 text-xs font-semibold hover:bg-slate-50"
            >
              {marketConditionsDraft ? 'Review Market Analysis' : 'Complete Market Analysis'}
            </Link>
          </div>
        </div>

        <div className="mb-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex flex-col gap-1">
            <div className="text-base font-semibold text-slate-900">Comparable Sale Search</div>
            <div className="text-sm text-slate-600">
              Select up to six sales for {subject?.address || propertyId || 'the subject property'}. Selected transactions populate the sales-comparison grid below.
            </div>
          </div>

          <div className="mt-4 rounded-xl border border-indigo-200 bg-indigo-50 p-4">
            <div className="grid gap-3 lg:grid-cols-[minmax(260px,360px)_1fr] lg:items-end">
              <label className="grid gap-1 text-sm font-medium text-slate-800">
                <span>Comparable-search complexity (required first)</span>
                <select
                  aria-label="Comparable-search complexity"
                  value={comparableSearchProfile}
                  disabled={!marketConditionsDraft}
                  onChange={(event) => {
                    setComparableSearchProfile(
                      event.target.value as ComparableSearchProfileKey | '',
                    );
                    setSalesError(null);
                    resetSalesForAnalysisPeriodChange();
                  }}
                  className="rounded-md border border-indigo-300 bg-white px-3 py-2 text-slate-900 disabled:cursor-not-allowed disabled:bg-slate-100"
                >
                  <option value="">Select complexity</option>
                  {COMPARABLE_SEARCH_GEOGRAPHIES.map((geography) => (
                    <optgroup key={geography} label={geography}>
                      {COMPARABLE_SEARCH_PROFILE_OPTIONS
                        .filter((profile) => profile.geography === geography)
                        .map((profile) => (
                          <option key={profile.key} value={profile.key}>
                            {profile.label} ({profile.radiusMiles} mile{profile.radiusMiles === 1 ? '' : 's'})
                          </option>
                        ))}
                    </optgroup>
                  ))}
                </select>
              </label>
              <div className="text-sm text-slate-700">
                {selectedComparableSearchProfile
                  ? `${selectedComparableSearchProfile.label} limits comparable-sale candidates to ${selectedComparableSearchProfile.radiusMiles} mile${selectedComparableSearchProfile.radiusMiles === 1 ? '' : 's'} from the subject before ranking.`
                  : 'Choose the property environment and assignment complexity to unlock comparable search and ranking.'}
                {' '}This selection does not change the independent Market Conditions Analysis saved on the Property Report.
              </div>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-3 xl:grid-cols-[minmax(240px,1fr)_150px_150px_140px_auto_auto] xl:items-end">
            <label className="grid gap-1 text-sm text-slate-700">
              <span>Address, city, or parcel/account ID</span>
              <input
                ref={salesSearchInputRef}
                value={salesQuery}
                disabled={!marketConditionsDraft || !comparableSearchProfile}
                onChange={(event) => setSalesQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void runSalesSearch();
                }}
                placeholder="e.g. SNOWMASS, Garland, or a 17-character ID"
                className="rounded-md border border-slate-300 px-3 py-2"
              />
            </label>
            <label className="grid gap-1 text-sm text-slate-700">
              <span>Analysis as of</span>
              <input
                type="date"
                value={salesAnalysisAsOf}
                disabled={!marketConditionsDraft || !comparableSearchProfile}
                onChange={(event) => {
                  setSalesAnalysisAsOf(event.target.value);
                  resetSalesForAnalysisPeriodChange();
                }}
                className="rounded-md border border-slate-300 px-3 py-2"
              />
            </label>
            <label className="grid gap-1 text-sm text-slate-700">
              <span>Historical period</span>
              <select
                value={salesPeriodMonths}
                disabled={!marketConditionsDraft || !comparableSearchProfile}
                onChange={(event) => {
                  setSalesPeriodMonths(
                    Number(event.target.value) as SalesAnalysisPeriodMonths,
                  );
                  resetSalesForAnalysisPeriodChange();
                }}
                className="rounded-md border border-slate-300 px-3 py-2"
              >
                <option value={12}>12 months</option>
                <option value={24}>24 months</option>
                <option value={36}>36 months</option>
              </select>
            </label>
            <label className="grid gap-1 text-sm text-slate-700">
              <span>Outlier score floor</span>
              <input
                type="number"
                min={0}
                max={100}
                step={5}
                value={outlierScoreThreshold}
                disabled={!marketConditionsDraft || !comparableSearchProfile}
                onChange={(event) => {
                  const nextValue = Math.min(
                    100,
                    Math.max(0, Number(event.target.value) || 0),
                  );
                  setOutlierScoreThreshold(nextValue);
                  resetSalesForAnalysisPeriodChange();
                }}
                className="rounded-md border border-slate-300 px-3 py-2"
              />
            </label>
            <button
              type="button"
              onClick={() => void runRecommendedSales()}
              disabled={salesLoading || !propertyId || !marketConditionsDraft || !comparableSearchProfile}
              className="rounded-md border border-indigo-600 bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:cursor-wait disabled:opacity-60"
            >
              Recommend Top 6
            </button>
            <button
              type="button"
              onClick={() => void runSalesSearch()}
              disabled={salesLoading || !marketConditionsDraft || !comparableSearchProfile}
              className="rounded-md border border-emerald-600 bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:cursor-wait disabled:opacity-60"
            >
              {salesLoading ? 'Searching...' : 'Search Sales'}
            </button>
          </div>

          {!marketConditionsDraft && (
            <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-900">
              Complete the current Market Conditions Analysis on the Property Report to unlock
              comparable search and recommendations. The selected study areas
              will remain independent from the comparable-sales inventory.
            </div>
          )}
          {marketConditionsDraft && !comparableSearchProfile && (
            <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-900">
              Select the comparable-search complexity above before entering ratings,
              searching sales, or generating the recommended top six.
            </div>
          )}

          <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(180px,220px)_minmax(180px,220px)_auto_1fr] md:items-end">
              <label className="grid gap-1 text-sm text-slate-700">
                <span>Subject&apos;s Condition Rating</span>
                <UadRatingSelect
                  ariaLabel="Subject condition rating before comparable selection"
                  value={draftSubjectCondition}
                  ratings={UAD_CONDITION_RATINGS}
                  onChange={setDraftSubjectCondition}
                  disabled={!marketConditionsDraft || !comparableSearchProfile}
                />
              </label>
              <label className="grid gap-1 text-sm text-slate-700">
                <span>Subject&apos;s Quality Rating</span>
                <UadRatingSelect
                  ariaLabel="Subject quality rating before comparable selection"
                  value={draftSubjectQuality}
                  ratings={UAD_QUALITY_RATINGS}
                  onChange={setDraftSubjectQuality}
                  disabled={!marketConditionsDraft || !comparableSearchProfile}
                />
              </label>
              <button
                type="button"
                onClick={applySubjectRatings}
                disabled={!comparableSearchProfile || !draftSubjectCondition || !draftSubjectQuality}
                className="rounded-md border border-slate-800 bg-slate-800 px-4 py-2 text-sm font-medium text-white hover:bg-slate-900 disabled:cursor-not-allowed disabled:border-slate-300 disabled:bg-slate-300"
              >
                Apply Subject Ratings
              </button>
              <div className="text-sm text-slate-600">
                {subjectRatingsApplied
                  ? `Applied to the subject grid as ${subjectCondition} / ${subjectQuality}.`
                  : 'Select both ratings and apply them before adding or recommending comparables.'}
              </div>
            </div>

            {subjectRatingsApplied && (
              <div className="mt-3 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600">
                Comparable condition and quality ratings remain manual and editable.
                The grid will show $0 for both adjustments until a separate Condition and Quality Study tile is applied below.
              </div>
            )}

            <div className="mt-3 rounded-lg border border-slate-200 bg-white p-3">
              <div className="flex flex-wrap items-end gap-3">
                <label className="grid min-w-[220px] flex-1 gap-1 text-sm text-slate-700">
                  <span>Personal editor key</span>
                  <input
                    type="password"
                    value={housingEditorKey}
                    autoComplete="off"
                    onChange={(event) => setHousingEditorKey(event.target.value)}
                    placeholder="Required only when saving"
                    className="rounded-md border border-slate-300 px-3 py-2"
                  />
                </label>
                <button
                  type="button"
                  onClick={() => void saveRatingChanges()}
                  disabled={ratingPersistenceSaving || ratingPersistenceLoading || !hasUnsavedRatingChanges}
                  className="rounded-md border border-emerald-700 bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800 disabled:cursor-not-allowed disabled:border-slate-300 disabled:bg-slate-300"
                >
                  {ratingPersistenceSaving ? 'Saving...' : 'Save Rating Changes'}
                </button>
                <button
                  type="button"
                  onClick={revertRatingChanges}
                  disabled={ratingPersistenceSaving || !hasUnsavedRatingChanges}
                  className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Cancel / Revert
                </button>
                <div className={`rounded-full px-3 py-1 text-xs font-semibold ${
                  hasUnsavedRatingChanges
                    ? 'bg-amber-100 text-amber-900'
                    : 'bg-emerald-100 text-emerald-800'
                }`}>
                  {hasUnsavedRatingChanges
                    ? `${Object.keys(dirtyRatingKeys).length + (subjectRatingDirty ? 1 : 0)} unsaved change${Object.keys(dirtyRatingKeys).length + (subjectRatingDirty ? 1 : 0) === 1 ? '' : 's'}`
                    : ratingsSavedAt
                      ? `Saved ${new Date(ratingsSavedAt).toLocaleString()}`
                      : 'No unsaved changes'}
                </div>
              </div>
              <div className="mt-2 text-xs text-slate-500">
                Saving creates an audit revision. It never changes the original MLS row, and later imports cannot overwrite a verified rating.
              </div>
              {ratingPersistenceError && (
                <div className="mt-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
                  {ratingPersistenceError}
                </div>
              )}
            </div>
          </div>

          <div className="mt-3 overflow-hidden rounded-xl border border-slate-300 bg-white">
            <button
              type="button"
              aria-expanded={recommendationDetailsExpanded}
              aria-controls="comparable-recommendation-details"
              onClick={() => setRecommendationDetailsExpanded((current) => !current)}
              className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left hover:bg-slate-50"
            >
              <span>
                <span className="block font-semibold text-slate-950">
                  Recommendation scoring details and audit
                </span>
                <span className="mt-0.5 block text-xs text-slate-600">
                  Ranking weights, optional filters, selected-slot review, and outlier diagnostics.
                  {' '}{selectedSales.filter(Boolean).length} of {COMPARABLE_COUNT} comparable slots are populated.
                </span>
              </span>
              <span className="shrink-0 rounded-full border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700">
                {recommendationDetailsExpanded ? 'Collapse details' : 'Expand details'}
              </span>
            </button>

            {recommendationDetailsExpanded && (
              <div id="comparable-recommendation-details" className="border-t border-slate-200 p-4">
          <div className="rounded-lg border border-indigo-100 bg-indigo-50 px-3 py-2 text-sm text-indigo-950">
            Recommendations use parcel-center distance at 40%, living-area similarity at 37%, year-built similarity at 10%, site-size similarity at 5%, and sale-date recency at 8%.
            The 10% living-area and site-size settings control how quickly those scores decline; they do not exclude larger or smaller properties.
            A 10-year age difference or 10% site-size difference receives half of that factor&apos;s points. Missing year-built or site-size data receives no points for that factor and is flagged for review rather than excluded.
            The 12-month period is the default and excludes sales over one year old. Select 24 or 36 months to include older sales as recency-weighted fallback evidence.
            Neighborhood code is shown for review but is not yet scored.
          </div>

          <div className="mt-3 flex flex-wrap gap-4 text-sm text-slate-700">
            <label className="inline-flex items-center gap-2">
              <input
                type="checkbox"
                checked={includeUnmatchedSales}
                onChange={(event) => setIncludeUnmatchedSales(event.target.checked)}
              />
              Include unmatched MLS sales
            </label>
            <label className={`inline-flex items-center gap-2 ${subject?.nbhd_code ? '' : 'text-slate-400'}`}>
              <input
                type="checkbox"
                checked={sameNeighborhoodOnly}
                disabled={!subject?.nbhd_code}
                onChange={(event) => setSameNeighborhoodOnly(event.target.checked)}
              />
              Same CAD neighborhood only{subject?.nbhd_code ? ` (${subject.nbhd_code})` : ' (neighborhood unavailable)'}
            </label>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-4">
            {selectedSales.map((sale, index) => {
              const missingHousingType = sale ? housingTypeNeedsReview(sale) : false;
              const unknownAttachment = sale ? attachmentNeedsReview(sale) : false;
              return (
                <div
                key={index}
                className={`rounded-lg border p-3 text-sm ${
                  missingHousingType
                    ? 'border-amber-300 bg-amber-50'
                    : 'border-slate-200 bg-slate-50'
                }`}
                >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-semibold text-slate-900">Comparable {index + 1}</div>
                    <div className="mt-1 text-slate-700">{sale ? saleDisplayAddress(sale) : 'Not selected'}</div>
                    {sale && saleIsOverOneYear(sale) && (
                      <div className="mt-1 text-xs font-semibold text-amber-800">Sale over one year old</div>
                    )}
                    {sale?.statistical_outlier && (
                      <div className="mt-1 text-xs font-semibold text-red-800">
                        {statisticalOutlierLabel(sale)}
                      </div>
                    )}
                    {missingHousingType && (
                      <div className="mt-1 text-xs font-semibold text-amber-900">
                        Housing type unknown — verify before relying on this sale.
                      </div>
                    )}
                    {unknownAttachment && (
                      <div className="mt-1 text-xs font-medium text-amber-800">
                        Attached/detached status is not verified.
                      </div>
                    )}
                    {sale && <div className="mt-1 text-xs text-slate-500">{sale.primary_account_id ? 'Matched account' : 'Unmatched sale'} · {saleDateDisplay(sale.closing_date)}</div>}
                    {sale && subjectRatingsApplied && (
                      <div className="mt-1 text-xs font-medium text-indigo-700">
                        Manual ratings: {compConditions[index] || '—'} / {compQualities[index] || '—'}
                      </div>
                    )}
                  </div>
                  {sale && (
                    <button
                      type="button"
                      onClick={() => removeComparable(index)}
                      className="text-xs font-medium text-red-700 hover:underline"
                    >
                      Remove
                    </button>
                  )}
                </div>
                {sale && (
                  <div className="mt-3">
                    <MlsPhoto
                      src={sale.primary_photo_url}
                      alt={saleDisplayAddress(sale)}
                      photoCount={Number(sale.photo_count || 0)}
                      onOpen={sale.primary_photo_url ? () => void openSaleGallery(sale) : undefined}
                    />
                  </div>
                )}
                {sale?.primary_account_id && (
                  <button
                    type="button"
                    onClick={() => openHousingEditor(sale)}
                    className="mt-2 text-xs font-semibold text-indigo-700 hover:underline"
                  >
                    Review / edit housing type
                  </button>
                )}
              </div>
              );
            })}
          </div>

          {salesError && <div className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">{salesError}</div>}
          {salesNotice && <div className="mt-3 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-900">{salesNotice}</div>}

          {recommendationSummary && (
            <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-950">
              <span className="font-semibold">{recommendationSummary.coverage.eligible_count.toLocaleString()} scored sales</span>
              {' '}from {recommendationSummary.coverage.candidate_count.toLocaleString()} candidates.
              {' '}Search profile: {recommendationSummary.search_profile.label} within{' '}
              {recommendationSummary.search_profile.radius_miles} mile{recommendationSummary.search_profile.radius_miles === 1 ? '' : 's'}.
              {' '}Subject location confidence: {recommendationSummary.subject.location_confidence}.
              {recommendationSummary.coverage.missing_location_count > 0 && (
                <> {recommendationSummary.coverage.missing_location_count.toLocaleString()} lacked parcel coordinates.</>
              )}
              {recommendationSummary.coverage.unsupported_county_count > 0 && (
                <> {recommendationSummary.coverage.unsupported_county_count.toLocaleString()} Collin County sales await a separate county GIS source.</>
              )}
              {recommendationSummary.coverage.missing_square_footage_count > 0 && (
                <> {recommendationSummary.coverage.missing_square_footage_count.toLocaleString()} lacked living-area data.</>
              )}
              {recommendationSummary.coverage.missing_year_built_count > 0 && (
                <> {recommendationSummary.coverage.missing_year_built_count.toLocaleString()} lacked usable subject/comparable year-built data and received no age points.</>
              )}
              {recommendationSummary.coverage.missing_site_size_count > 0 && (
                <> {recommendationSummary.coverage.missing_site_size_count.toLocaleString()} lacked usable subject/comparable site-size data and received no site-size points.</>
              )}
              {recommendationSummary.recommendation_policy && (
                <>
                  {' '}The {recommendationSummary.recommendation_policy.periodMonths}-month analysis runs from{' '}
                  {saleDateDisplay(recommendationSummary.recommendation_policy.analysisStartDate)} through{' '}
                  {saleDateDisplay(recommendationSummary.recommendation_policy.analysisAsOf)}.
                  {recommendationSummary.recommendation_policy.expandedHistoricalPeriod
                    ? ` ${recommendationSummary.recommendation_policy.olderThanOneYearCount.toLocaleString()} sales over one year old are included as recency-weighted fallback evidence.`
                    : ' Sales over one year old are excluded.'}
                </>
              )}
            </div>
          )}

          {recommendationSummary?.statistical_analysis && (
            <div
              className={`mt-3 rounded-lg border px-4 py-3 text-sm ${
                recommendationSummary.statistical_analysis.sample_sufficient
                  ? 'border-indigo-200 bg-indigo-50 text-indigo-950'
                  : 'border-amber-200 bg-amber-50 text-amber-950'
              }`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="font-semibold">Comparable outlier audit</div>
                <span className="rounded-full bg-white/80 px-2 py-0.5 text-xs font-semibold uppercase tracking-wide">
                  {recommendationSummary.statistical_analysis.confidence} confidence
                </span>
              </div>
              <div className="mt-1">
                {recommendationSummary.statistical_analysis.qualified_sale_count.toLocaleString()} one-year sales scored at least{' '}
                {recommendationSummary.statistical_analysis.score_threshold};{' '}
                {recommendationSummary.statistical_analysis.measured_sale_count.toLocaleString()} had usable price-per-square-foot data ({Math.round(
                  recommendationSummary.statistical_analysis.coverage_ratio * 100,
                )}% coverage), representing {recommendationSummary.statistical_analysis.effective_sample_size.toLocaleString()} distinct properties across {recommendationSummary.statistical_analysis.distinct_sale_months} sale months.
              </div>
              {recommendationSummary.statistical_analysis.sample_sufficient ? (
                <div className="mt-1">
                  Median {fmtCurrency(recommendationSummary.statistical_analysis.median_price_per_square_foot)}/SF · mean{' '}
                  {fmtCurrency(recommendationSummary.statistical_analysis.mean_price_per_square_foot)}/SF · standard deviation{' '}
                  {fmtCurrency(recommendationSummary.statistical_analysis.standard_deviation_price_per_square_foot)}/SF.{' '}
                  {recommendationSummary.statistical_analysis.outlier_count} sale{recommendationSummary.statistical_analysis.outlier_count === 1 ? '' : 's'} were flagged only where at least two of the standard-deviation, median-deviation, and IQR tests agreed.
                </div>
              ) : (
                <div className="mt-1 font-medium">
                  No statistical outlier flags were applied because the qualified sample did not meet every sufficiency check.
                </div>
              )}
              {recommendationSummary.statistical_analysis.warnings.length > 0 && (
                <ul className="mt-2 list-disc space-y-1 pl-5 text-xs">
                  {recommendationSummary.statistical_analysis.warnings.map((warning) => (
                    <li key={warning.code}>{warning.message}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
              </div>
            )}
          </div>

          {(recommendationSummary ? recommendationSummary.recommended_sales : salesResults).length > 0 && (
            <div className="mt-4">
              <div className="mb-2 text-sm font-semibold text-slate-900">
                {recommendationSummary ? 'Recommended Comparable Sales' : 'Sales Search Results'}
              </div>
              <div className="max-h-[340px] overflow-auto rounded-xl border border-slate-200">
              <table className="w-full min-w-[1080px] text-left text-sm">
                <thead className="sticky top-0 bg-slate-100 text-slate-700">
                  <tr>
                    <th className="px-3 py-2">Property</th>
                    <th className="px-3 py-2">Comparable Score</th>
                    <th className="px-3 py-2">Sale</th>
                    <th className="px-3 py-2">Characteristics</th>
                    <th className="px-3 py-2">Review</th>
                    <th className="px-3 py-2 text-right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {(recommendationSummary ? recommendationSummary.recommended_sales : salesResults).map((sale) => {
                    const selectedSlot = selectedSales.findIndex((item) => item && saleKey(item) === saleKey(sale));
                    const selected = selectedSlot >= 0;
                    const livingArea = sale.cad_living_area_sqft ?? sale.mls_living_area;
                    const bedrooms = sale.cad_bedroom_count ?? sale.mls_bedrooms_total;
                    const baths = sale.cad_bath_count ?? sale.mls_bathrooms_total_integer;
                    const garageSpaces = finiteNumber(sale.mls_garage_spaces);
                    const garageLabel = garageSpaces !== null
                      ? `${Math.max(0, Math.round(garageSpaces))} garage ${Math.round(garageSpaces) === 1 ? 'space' : 'spaces'}`
                      : sale.mls_garage_yn === false
                        ? '0 garage spaces'
                        : 'Garage spaces unavailable';
                    const hasPool = booleanValue(sale.mls_pool_yn ?? sale.cad_pool);
                    const olderThanOneYear = saleIsOverOneYear(sale);
                    const missingHousingType = housingTypeNeedsReview(sale);
                    const unknownAttachment = attachmentNeedsReview(sale);
                    return (
                      <tr
                        key={saleKey(sale)}
                        className={`border-t align-top ${
                          missingHousingType
                            ? 'border-amber-200 bg-amber-50/40'
                            : 'border-slate-200'
                        }`}
                      >
                        <td className="px-3 py-3">
                          <div className="flex min-w-[260px] items-start gap-3">
                            <MlsPhoto
                              src={sale.primary_photo_url}
                              alt={saleDisplayAddress(sale)}
                              photoCount={Number(sale.photo_count || 0)}
                              onOpen={sale.primary_photo_url ? () => void openSaleGallery(sale) : undefined}
                              compact
                            />
                            <div className="min-w-0">
                              <div className="font-medium text-slate-900">{sale.address || 'Address unavailable'}</div>
                              <div className="mt-1 text-xs text-slate-500">{sale.primary_account_id || `Unmatched source row ${sale.source_row_number || ''}`}</div>
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-3">
                          {sale.comparableScore != null ? (
                            <div>
                              <div className="inline-flex items-center gap-2">
                                <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-sm font-semibold text-indigo-900">
                                  #{sale.score_rank} · {sale.comparableScore.toFixed(1)}
                                </span>
                                {sale.recommendationRank != null && (
                                  <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-900">
                                    Recommended #{sale.recommendationRank}
                                  </span>
                                )}
                                {sale.score_requires_review && (
                                  <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900">Review</span>
                                )}
                              </div>
                              <div className="mt-1 text-xs text-slate-600">
                                {sale.distanceMiles?.toFixed(2)} mi · {sale.squareFootageDifferencePercent?.toFixed(1)}% size difference
                              </div>
                              <div className="mt-1 text-xs text-slate-500">
                                Location {sale.locationScore?.toFixed(1)} · GLA {sale.squareFootageScore?.toFixed(1)} · Age {sale.ageDataAvailable ? sale.ageScore?.toFixed(1) : 'Review'} · Site {sale.siteDataAvailable ? sale.siteSizeScore?.toFixed(1) : 'Review'} · Date {sale.salesDateScore?.toFixed(1)}
                              </div>
                              {sale.recommendationExclusionReason === 'outside_analysis_period' && (
                                <div className="mt-1 text-xs font-medium text-amber-800">
                                  Outside the selected historical period.
                                </div>
                              )}
                            </div>
                          ) : (
                            <span className="text-xs text-slate-500">Manual result</span>
                          )}
                        </td>
                        <td className="px-3 py-3">
                          <div className="font-semibold text-slate-900">{fmtCurrency(sale.sale_price) || 'Price unavailable'}</div>
                          <div className="mt-1 text-xs text-slate-500">
                            {saleDateDisplay(sale.closing_date)} · DOM {sale.days_on_market ?? '—'} · MLS {sale.listing_id || '—'}
                          </div>
                        </td>
                        <td className="px-3 py-3 text-slate-700">
                          <div>{fmtSqftSafe(livingArea)} · {bedrooms ?? '—'} bd · {baths ?? '—'} ba</div>
                          <div className="mt-1 text-xs text-slate-500">
                            {garageLabel} · Pool {hasPool === null ? 'unavailable' : hasPool ? 'Yes' : 'No'}
                          </div>
                          <div className="mt-1 text-xs text-slate-500">Built {sale.comparableYearBuilt ?? sale.cad_year_built ?? sale.mls_year_built ?? '—'} · {sale.neighborhood_code || 'No neighborhood code'}</div>
                          <div className="mt-1 text-xs text-slate-500">
                            {missingHousingType ? (
                              <span className="font-semibold text-amber-900">Housing type unknown — review needed</span>
                            ) : (
                              sale.structural_style || sale.housing_type
                            )}
                            {' · '}
                            {sale.architectural_style || 'Architectural style unavailable'}
                          </div>
                        </td>
                        <td className="px-3 py-3">
                          <div className="flex flex-wrap gap-1">
                            {sale.multi_parcel_status !== 'single' && (
                              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900">
                                {sale.multi_parcel_status} multi-parcel
                              </span>
                            )}
                            {sale.has_unresolved_parcel && (
                              <span className="rounded-full bg-orange-100 px-2 py-0.5 text-xs font-medium text-orange-900">Unresolved parcel</span>
                            )}
                            {sale.requires_additional_review && (
                              <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-900">Review required</span>
                            )}
                            {missingHousingType && (
                              <span className="rounded-full bg-amber-200 px-2 py-0.5 text-xs font-semibold text-amber-950">
                                Housing type needs review
                              </span>
                            )}
                            {unknownAttachment && (
                              <span className="rounded-full bg-orange-100 px-2 py-0.5 text-xs font-medium text-orange-900">
                                Attached/detached unverified
                              </span>
                            )}
                            {olderThanOneYear && (
                              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900">Sale over 1 year old</span>
                            )}
                            {sale.statistical_outlier && (
                              <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-900">
                                {statisticalOutlierLabel(sale)}
                              </span>
                            )}
                            {!sale.requires_additional_review &&
                              !missingHousingType &&
                              !unknownAttachment &&
                              !sale.statistical_outlier &&
                              sale.multi_parcel_status === 'single' && (
                              <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-900">Standard</span>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-3 text-right">
                          <div className="flex flex-col items-end gap-2">
                            <button
                              type="button"
                              onClick={() => selected ? removeComparable(selectedSlot) : addSaleAsComparable(sale)}
                              className={`rounded-md border px-3 py-1.5 text-xs font-medium ${
                                selected
                                  ? 'border-red-300 bg-white text-red-700 hover:bg-red-50'
                                  : 'border-blue-600 bg-blue-600 text-white hover:bg-blue-700'
                              }`}
                            >
                              {selected ? 'Remove from Grid' : 'Use as Comparable'}
                            </button>
                            <button
                              type="button"
                              onClick={() => openHousingEditor(sale)}
                              disabled={!sale.primary_account_id}
                              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:border-indigo-400 hover:text-indigo-800 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              Review / edit type
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              </div>
            </div>
          )}

          {recommendationSummary?.competitive_sales?.length > 0 && (
            <section className="mt-6 rounded-2xl border border-slate-300 bg-slate-50 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="text-base font-semibold text-slate-950">
                    Additional Competitive Sales Grid
                  </h3>
                  <p className="mt-1 text-sm text-slate-600">
                    The next {recommendationSummary.competitive_sales.length} lower-ranked sales from the past year are retained as challengers to the primary six.
                  </p>
                </div>
                <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600">
                  Ranked with the same 40% location · 37% GLA · 10% age · 5% site-size · 8% sale-date model
                </div>
              </div>

              <div className="mt-4 max-h-[400px] overflow-auto rounded-xl border border-slate-200 bg-white">
                <table className="w-full min-w-[1100px] text-left text-sm">
                  <thead className="sticky top-0 z-10 bg-slate-100 text-slate-700">
                    <tr>
                      <th className="px-3 py-2">Rank / Score</th>
                      <th className="px-3 py-2">Competitive Sale</th>
                      <th className="px-3 py-2">Sale Information</th>
                      <th className="px-3 py-2">Similarity</th>
                      <th className="px-3 py-2">Statistical Review</th>
                      <th className="px-3 py-2 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recommendationSummary.competitive_sales.map((sale) => {
                      const selectedSlot = selectedSales.findIndex(
                        (item) => item && saleKey(item) === saleKey(sale),
                      );
                      const selected = selectedSlot >= 0;
                      const livingArea = sale.cad_living_area_sqft ?? sale.mls_living_area;
                      const bedrooms = sale.cad_bedroom_count ?? sale.mls_bedrooms_total;
                      const baths = sale.cad_bath_count ?? sale.mls_bathrooms_total_integer;
                      return (
                        <tr
                          key={`competitive-${saleKey(sale)}`}
                          className={`border-t align-top ${
                            sale.statistical_outlier
                              ? 'border-red-200 bg-red-50/60'
                              : 'border-slate-200'
                          }`}
                        >
                          <td className="px-3 py-3">
                            <div className="font-semibold text-indigo-950">
                              #{sale.score_rank ?? '—'} · {sale.comparableScore?.toFixed(1) ?? '—'}
                            </div>
                            <div className="mt-1 text-xs text-slate-500">
                              Location {sale.locationScore?.toFixed(1) ?? '—'} · GLA {sale.squareFootageScore?.toFixed(1) ?? '—'} · Age {sale.ageDataAvailable ? sale.ageScore?.toFixed(1) ?? '—' : 'Review'} · Site {sale.siteDataAvailable ? sale.siteSizeScore?.toFixed(1) ?? '—' : 'Review'} · Date {sale.salesDateScore?.toFixed(1) ?? '—'}
                            </div>
                          </td>
                          <td className="px-3 py-3">
                            <div className="flex min-w-[250px] items-start gap-3">
                              <MlsPhoto
                                src={sale.primary_photo_url}
                                alt={saleDisplayAddress(sale)}
                                photoCount={Number(sale.photo_count || 0)}
                                onOpen={sale.primary_photo_url ? () => void openSaleGallery(sale) : undefined}
                                compact
                              />
                              <div>
                                <div className="font-medium text-slate-950">{saleDisplayAddress(sale)}</div>
                                <div className="mt-1 text-xs text-slate-500">
                                  {sale.primary_account_id || 'Unmatched account'} · MLS {sale.listing_id || '—'}
                                </div>
                              </div>
                            </div>
                          </td>
                          <td className="px-3 py-3">
                            <div className="font-semibold text-slate-950">{fmtCurrency(sale.sale_price) || 'Price unavailable'}</div>
                            <div className="mt-1 text-xs text-slate-500">
                              {saleDateDisplay(sale.closing_date)} · DOM {sale.days_on_market ?? '—'}
                            </div>
                            <div className="mt-1 text-xs text-slate-500">
                              {sale.price_per_square_foot != null ? `${fmtCurrency(sale.price_per_square_foot)}/SF` : 'Price/SF unavailable'}
                            </div>
                          </td>
                          <td className="px-3 py-3 text-slate-700">
                            <div>{fmtSqftSafe(livingArea)} · {bedrooms ?? '—'} bd · {baths ?? '—'} ba</div>
                            <div className="mt-1 text-xs text-slate-500">
                              {sale.distanceMiles?.toFixed(2) ?? '—'} mi · {sale.squareFootageDifferencePercent?.toFixed(1) ?? '—'}% GLA difference
                            </div>
                            <div className="mt-1 text-xs text-slate-500">
                              {sale.structural_style || sale.housing_type || 'Housing type unknown'}
                            </div>
                          </td>
                          <td className="px-3 py-3">
                            {sale.statistical_outlier ? (
                              <div className="rounded-lg border border-red-200 bg-red-100 px-2.5 py-2 text-xs text-red-950">
                                <div className="font-semibold">{statisticalOutlierLabel(sale)}</div>
                                <div className="mt-1">
                                  Standard-deviation score {sale.price_per_square_foot_zscore?.toFixed(2) ?? '—'} · robust score {sale.price_per_square_foot_robust_zscore?.toFixed(2) ?? '—'}
                                </div>
                              </div>
                            ) : sale.outlier_analysis_eligible ? (
                              <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-900">
                                Within tested distribution
                              </span>
                            ) : (
                              <span className="text-xs text-slate-500">Below statistical score floor</span>
                            )}
                          </td>
                          <td className="px-3 py-3 text-right">
                            <button
                              type="button"
                              onClick={() => selected ? removeComparable(selectedSlot) : addCompetitiveSaleToPrimaryGrid(sale)}
                              className={`rounded-md border px-3 py-1.5 text-xs font-semibold ${
                                selected
                                  ? 'border-red-300 bg-white text-red-700 hover:bg-red-50'
                                  : 'border-indigo-600 bg-indigo-600 text-white hover:bg-indigo-700'
                              }`}
                            >
                              {selected ? 'Remove from Grid' : 'Add To Primary Grid'}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {competitiveReplacementSale && (
            <div
              role="dialog"
              aria-modal="true"
              aria-label="Choose a primary comparable to replace"
              className="mt-4 rounded-2xl border-2 border-indigo-300 bg-indigo-50 p-4 shadow-lg"
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="font-semibold text-indigo-950">The primary grid already contains six sales.</div>
                  <div className="mt-1 text-sm text-indigo-900">
                    Choose which comparable to replace with {saleDisplayAddress(competitiveReplacementSale)}.
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setCompetitiveReplacementSale(null)}
                  className="text-sm font-semibold text-indigo-800 hover:underline"
                >
                  Cancel
                </button>
              </div>
              <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
                {selectedSales.map((sale, slot) => (
                  <button
                    key={`replace-primary-${slot}`}
                    type="button"
                    onClick={() => replacePrimaryComparable(slot)}
                    className="rounded-lg border border-indigo-200 bg-white px-3 py-2 text-left text-sm text-slate-800 hover:border-indigo-500 hover:bg-indigo-100"
                  >
                    <span className="font-semibold">Replace Comparable {slot + 1}</span>
                    <span className="mt-0.5 block text-xs text-slate-600">
                      {sale ? saleDisplayAddress(sale) : 'Open slot'}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {gallery && (
          <div
            className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/85 p-4"
            role="dialog"
            aria-modal="true"
            aria-label={`MLS photos for ${gallery.title}`}
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setGallery(null);
            }}
          >
            <div className="flex max-h-[94vh] w-full max-w-6xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
              <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4">
                <div>
                  <h2 className="text-lg font-semibold text-slate-950">{gallery.title}</h2>
                  <p className="mt-0.5 text-sm text-slate-600">
                    MLS photo {Math.min(gallery.index + 1, gallery.photos.length)} of {gallery.photos.length}
                    {gallery.loading ? ' · Loading full gallery…' : ''}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setGallery(null)}
                  className="rounded-full border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                  aria-label="Close MLS photo gallery"
                >
                  Close
                </button>
              </div>

              <div className="relative flex min-h-0 flex-1 items-center justify-center bg-slate-950 p-4">
                {gallery.photos[gallery.index] ? (
                  <img
                    src={gallery.photos[gallery.index].media_url}
                    alt={gallery.photos[gallery.index].caption || `${gallery.title} MLS photo ${gallery.index + 1}`}
                    className="max-h-[68vh] max-w-full object-contain"
                  />
                ) : (
                  <div className="py-24 text-sm text-slate-300">No MLS photo is available.</div>
                )}
                {gallery.photos.length > 1 && (
                  <>
                    <button
                      type="button"
                      onClick={() => setGallery((current) => current ? {
                        ...current,
                        index: (current.index - 1 + current.photos.length) % current.photos.length,
                      } : current)}
                      className="absolute left-5 rounded-full bg-white/90 px-4 py-3 text-xl font-bold text-slate-950 shadow-lg hover:bg-white"
                      aria-label="Previous MLS photo"
                    >
                      ‹
                    </button>
                    <button
                      type="button"
                      onClick={() => setGallery((current) => current ? {
                        ...current,
                        index: (current.index + 1) % current.photos.length,
                      } : current)}
                      className="absolute right-5 rounded-full bg-white/90 px-4 py-3 text-xl font-bold text-slate-950 shadow-lg hover:bg-white"
                      aria-label="Next MLS photo"
                    >
                      ›
                    </button>
                  </>
                )}
              </div>

              <div className="border-t border-slate-200 bg-white px-5 py-3">
                {gallery.error && (
                  <div className="mb-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">{gallery.error}</div>
                )}
                {gallery.photos[gallery.index]?.caption && (
                  <p className="mb-2 text-sm text-slate-700">{gallery.photos[gallery.index].caption}</p>
                )}
                {gallery.photos.length > 1 && (
                  <div className="flex gap-2 overflow-x-auto pb-1">
                    {gallery.photos.map((photo, index) => (
                      <button
                        key={`${photo.id}-${index}`}
                        type="button"
                        onClick={() => setGallery((current) => current ? { ...current, index } : current)}
                        className={`h-16 w-24 flex-none overflow-hidden rounded-md border-2 ${
                          index === gallery.index ? 'border-indigo-600' : 'border-transparent'
                        }`}
                        aria-label={`Show MLS photo ${index + 1}`}
                      >
                        <img
                          src={photo.media_url}
                          alt=""
                          loading="lazy"
                          className="h-full w-full object-cover"
                        />
                      </button>
                    ))}
                  </div>
                )}
                <p className="mt-2 text-xs text-slate-500">
                  Photos are shown in MLS order. Availability and reuse remain subject to the source record’s media permission.
                </p>
              </div>
            </div>
          </div>
        )}

        {editingHousingSale && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/55 p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="housing-editor-title"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget && !housingEditSaving) {
                setEditingHousingSale(null);
              }
            }}
          >
            <form
              className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl"
              onSubmit={(event) => {
                event.preventDefault();
                void saveHousingProfile();
              }}
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 id="housing-editor-title" className="text-lg font-semibold text-slate-950">
                    Review housing classification
                  </h2>
                  <p className="mt-1 text-sm text-slate-600">
                    {saleDisplayAddress(editingHousingSale)} · Account {editingHousingSale.primary_account_id}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setEditingHousingSale(null)}
                  disabled={housingEditSaving}
                  className="rounded-md px-2 py-1 text-sm text-slate-500 hover:bg-slate-100 hover:text-slate-900"
                  aria-label="Close housing editor"
                >
                  Close
                </button>
              </div>

              <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950">
                Saving creates a verified account-level correction. The original MLS row stays unchanged,
                and this sale keeps its current comparable score and position.
              </div>

              <div className="mt-5 grid gap-4 sm:grid-cols-2">
                <label className="grid gap-1 text-sm text-slate-700">
                  <span className="font-medium">Housing type *</span>
                  <input
                    list="housing-type-options"
                    value={housingEditForm.housingType}
                    onChange={(event) => {
                      const housingType = event.target.value;
                      setHousingEditForm((current) => ({
                        ...current,
                        housingType,
                        attachmentType: suggestedAttachmentType(housingType, current.attachmentType),
                      }));
                    }}
                    placeholder="e.g. Single Family Detached"
                    className="rounded-md border border-slate-300 px-3 py-2"
                    autoFocus
                  />
                  <datalist id="housing-type-options">
                    {HOUSING_TYPE_OPTIONS.map((option) => <option key={option} value={option} />)}
                  </datalist>
                </label>

                <label className="grid gap-1 text-sm text-slate-700">
                  <span className="font-medium">Attached/detached classification *</span>
                  <select
                    value={housingEditForm.attachmentType}
                    onChange={(event) => setHousingEditForm((current) => ({
                      ...current,
                      attachmentType: event.target.value as HousingEditForm['attachmentType'],
                    }))}
                    className="rounded-md border border-slate-300 px-3 py-2"
                  >
                    <option value="detached">Detached</option>
                    <option value="attached">Attached</option>
                    <option value="mixed">Mixed / multi-unit</option>
                    <option value="unknown">Still unknown</option>
                  </select>
                </label>

                <label className="grid gap-1 text-sm text-slate-700 sm:col-span-2">
                  <span className="font-medium">Architectural style</span>
                  <input
                    value={housingEditForm.architecturalStyle}
                    onChange={(event) => setHousingEditForm((current) => ({
                      ...current,
                      architecturalStyle: event.target.value,
                    }))}
                    placeholder="Optional — leave blank when the MLS does not provide it"
                    className="rounded-md border border-slate-300 px-3 py-2"
                  />
                </label>

                <label className="grid gap-1 text-sm text-slate-700 sm:col-span-2">
                  <span className="font-medium">Verification source URL</span>
                  <input
                    type="url"
                    value={housingEditForm.sourceUrl}
                    onChange={(event) => setHousingEditForm((current) => ({
                      ...current,
                      sourceUrl: event.target.value,
                    }))}
                    placeholder="Optional MLS, agent, or listing page URL"
                    className="rounded-md border border-slate-300 px-3 py-2"
                  />
                </label>

                <label className="grid gap-1 text-sm text-slate-700 sm:col-span-2">
                  <span className="font-medium">Review notes</span>
                  <textarea
                    value={housingEditForm.notes}
                    onChange={(event) => setHousingEditForm((current) => ({
                      ...current,
                      notes: event.target.value,
                    }))}
                    placeholder="Optional explanation of what you confirmed"
                    rows={3}
                    className="rounded-md border border-slate-300 px-3 py-2"
                  />
                </label>

                <label className="grid gap-1 text-sm text-slate-700 sm:col-span-2">
                  <span className="font-medium">Personal editor key *</span>
                  <input
                    type="password"
                    value={housingEditorKey}
                    onChange={(event) => setHousingEditorKey(event.target.value)}
                    autoComplete="off"
                    placeholder="Required to write to the database"
                    className="rounded-md border border-slate-300 px-3 py-2"
                  />
                  <span className="text-xs text-slate-500">
                    After a successful save, the key is kept only for this browser tab.
                  </span>
                </label>
              </div>

              {housingEditError && (
                <div className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">
                  {housingEditError}
                </div>
              )}

              <div className="mt-6 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setEditingHousingSale(null)}
                  disabled={housingEditSaving}
                  className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={housingEditSaving}
                  className="rounded-md border border-indigo-600 bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:cursor-wait disabled:opacity-60"
                >
                  {housingEditSaving ? 'Saving…' : 'Save verified correction'}
                </button>
              </div>
            </form>
          </div>
        )}

        <div className="card bg-white shadow-sm rounded-2xl">
          <div className="card-body p-0 overflow-x-auto">
            <div className="px-6 pt-4 pb-3 flex items-center justify-between gap-3">
              <div>
                <div className="text-base font-semibold">Sales Comparison Grid</div>
                <div className="text-sm opacity-70">Grid layout to match the reference.</div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={clearComparables}
                  className="inline-flex items-center gap-2 px-3 py-1.5 text-sm rounded-md border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                >
                  Clear Comparables
                </button>
                <button
                  type="button"
                  onClick={() => void runSalesSearch()}
                  disabled={salesLoading || !marketConditionsDraft || !comparableSearchProfile}
                  className="inline-flex items-center gap-2 px-3 py-1.5 text-sm rounded-md border border-emerald-600 bg-emerald-600 text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Refresh Sales
                </button>
              </div>
            </div>

            {error && <div className="px-6 pb-4 text-red-600 text-sm">{error}</div>}

            <div style={{ minWidth: '108rem' }}>
              <style>{`
                .tight-grid {
                  table-layout: fixed;
                  width: 100%;
                }
                .tight-grid th,
                .tight-grid td {
                  padding: 0.25rem 0.5rem !important;
                  overflow-wrap: anywhere;
                  vertical-align: middle;
                }
              `}</style>
              <table className="w-full table-fixed text-sm tight-grid" style={{ borderCollapse: 'separate', borderSpacing: 0 }}>
                <colgroup>
                  <col style={{ width: '8rem' }} />
                  <col style={{ width: '10rem' }} />
                  {Array.from({ length: COMPARABLE_COUNT }).flatMap((_, i) => [
                    <col key={`comp-description-width-${i}`} style={{ width: '9rem' }} />,
                    <col key={`comp-adjustment-width-${i}`} style={{ width: '6rem' }} />,
                  ])}
                </colgroup>
                <thead>
                  <tr className="text-slate-700">
                    <th className="text-left px-4 py-2 border-b border-slate-300 w-32 bg-white">Feature</th>
                    <th
                      className="text-left px-4 py-2 border-b border-slate-300"
                      style={{ backgroundColor: '#FEF3C7' }}
                    >
                      Subject
                    </th>
                {Array.from({ length: COMPARABLE_COUNT }).map((_, i) => (
                  <th
                    key={i}
                    colSpan={2}
                    className={`text-left px-4 py-2 border-b border-slate-300 bg-white ${i < COMPARABLE_COUNT - 1 ? 'border-r' : ''}`}
                    style={i < COMPARABLE_COUNT - 1 ? { borderRightColor: '#cad5e2' } : undefined}
                  >
                    <div className="flex flex-col gap-1.5">
                      <span>{`Comparable ${i + 1}`}</span>
                      {selectedSales[i] ? (
                        <div className="flex flex-wrap items-center gap-1">
                          <button
                            type="button"
                            aria-label={`Move Comparable ${i + 1} left`}
                            title="Move left"
                            disabled={i === 0}
                            onClick={() => moveComparable(i, i - 1)}
                            className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-xs text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-35"
                          >
                            ←
                          </button>
                          <button
                            type="button"
                            aria-label={`Move Comparable ${i + 1} right`}
                            title="Move right"
                            disabled={i === COMPARABLE_COUNT - 1}
                            onClick={() => moveComparable(i, i + 1)}
                            className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-xs text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-35"
                          >
                            →
                          </button>
                          <button
                            type="button"
                            aria-label={`Remove Comparable ${i + 1}`}
                            title="Remove comparable"
                            onClick={() => removeComparable(i)}
                            className="rounded border border-red-200 bg-white px-1.5 py-0.5 text-xs font-medium text-red-700 hover:bg-red-50"
                          >
                            Remove
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          aria-label={`Add Comparable ${i + 1}`}
                          onClick={focusComparableSearch}
                          className="w-fit rounded border border-indigo-200 bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700 hover:bg-indigo-100"
                        >
                          + Add comparable
                        </button>
                      )}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
                <tbody>
                  {/* Row: ordered MLS primary photos */}
                  <tr>
                    <td className="px-4 py-2 border-b border-slate-200 bg-white">Photo</td>
                    <td className="px-4 py-2 border-b border-slate-200" style={{ backgroundColor: '#FEF3C7' }}>
                      <MlsPhoto
                        src={subjectPhotos[0]?.media_url}
                        alt={subject?.address || propertyId || 'Subject property'}
                        photoCount={subjectPhotos.length}
                        onOpen={subjectPhotos.length ? openSubjectGallery : undefined}
                      />
                    </td>
                    {Array.from({ length: COMPARABLE_COUNT }).map((_, i) => {
                      const sale = selectedSales[i];
                      return [
                        <td key={`photo-desc-${i}`} className="px-4 py-2 border-b border-slate-200">
                          <MlsPhoto
                            src={sale?.primary_photo_url}
                            alt={sale ? saleDisplayAddress(sale) : `Comparable ${i + 1}`}
                            photoCount={Number(sale?.photo_count || 0)}
                            onOpen={sale?.primary_photo_url ? () => void openSaleGallery(sale) : undefined}
                          />
                        </td>,
                        <td
                          key={`photo-adj-${i}`}
                          className="px-4 py-2 border-b border-slate-200 border-r"
                          style={i < COMPARABLE_COUNT - 1 ? { borderRightColor: '#cad5e2' } : undefined}
                        ></td>,
                      ];
                    })}
                  </tr>

                  {/* Row: Address */}
                  <tr>
                    <td className="px-4 py-2 border-b border-slate-200 bg-white">Address</td>
                    <td className="px-4 py-2 border-b border-slate-200" style={{ backgroundColor: '#FEF3C7' }}>
                      {/* subject address (optional) */}
                      {subject?.address || ''}
                    </td>
                    {Array.from({ length: COMPARABLE_COUNT }).map((_, i) => [
                      <td key={`addr-desc-${i}`} className="px-4 py-2 border-b border-slate-200">{compAddresses[i] || ''}</td>,
                      <td
                        key={`addr-adj-${i}`}
                        className="px-4 py-2 border-b border-slate-200 border-r"
                        style={i < COMPARABLE_COUNT - 1 ? { borderRightColor: '#cad5e2' } : undefined}
                      ></td>,
                    ])}
                  </tr>

                  {/* Row: MLS number */}
                  <tr>
                    <td className="px-4 py-2 border-b border-slate-200 bg-white">MLS Number</td>
                    <td className="px-4 py-2 border-b border-slate-200 text-slate-500" style={{ backgroundColor: '#FEF3C7' }}>
                      Subject
                    </td>
                    {Array.from({ length: COMPARABLE_COUNT }).map((_, i) => [
                      <td key={`mls-desc-${i}`} className="px-4 py-2 border-b border-slate-200 font-medium text-slate-700">
                        {selectedSales[i]?.listing_id || '—'}
                      </td>,
                      <td
                        key={`mls-adj-${i}`}
                        className="px-4 py-2 border-b border-slate-200 border-r"
                        style={i < COMPARABLE_COUNT - 1 ? { borderRightColor: '#cad5e2' } : undefined}
                      ></td>,
                    ])}
                  </tr>

                  {/* Row: Value vs Sales */}
                  {/* SALES GRID: Indicated Value — placeholder; applied after adjustments to derive indicated value from each comparable */}
                  {/* EQUITY GRID: Indicated Value — placeholder; applied after adjustments to derive indicated value from each comparable */}
                  <tr>
                    <td className="px-4 py-2 border-b border-slate-200 bg-white">Value vs Sales</td>
                    <td className="px-4 py-2 border-b border-slate-200" style={{ backgroundColor: '#FEF3C7' }}>
                      {fmtCurrency(subject?.market_value ?? '')}
                    </td>
                    {Array.from({ length: COMPARABLE_COUNT }).map((_, i) => [
                      <td key={`v-desc-${i}`} className="px-4 py-2 border-b border-slate-200">{fmtCurrency(compPrices[i] ?? '')}</td>,
                      <td
                        key={`v-adj-${i}`}
                        className="px-4 py-2 border-b border-slate-200 border-r"
                        style={i < COMPARABLE_COUNT - 1 ? { borderRightColor: '#cad5e2' } : undefined}
                      ></td>,
                    ])}
                  </tr>

                  {/* Section header: ADJUSTMENTS with Description/Adjustment labels */}
                  <tr className="font-semibold">
                    <td className="px-4 py-2 border-b border-slate-300 bg-slate-100">ADJUSTMENTS</td>
                    <td className="px-4 py-2 border-b border-slate-300" style={{ backgroundColor: '#FEF3C7' }}>
                      Description
                    </td>
                    {Array.from({ length: COMPARABLE_COUNT }).map((_, i) => [
                      <td key={`adj-desc-${i}`} className="px-4 py-2 border-b border-slate-300">Description</td>,
                      <td
                        key={`adj-adj-${i}`}
                        className="px-4 py-2 border-b border-slate-300 border-r"
                        style={{ borderLeft: '2px solid #e2e8f0', ...(i < COMPARABLE_COUNT - 1 ? { borderRightColor: '#cad5e2' } : {}) }}
                      >
                        Adjustment
                      </td>,
                    ])}
                  </tr>

                  {[
                    'Concessions',
                    'NBHD Code',
                    'Date of Sale/Time',
                    'Land Size',
                    'View',
                    'Housing Type',
                    'Architectural Style',
                    'Const Type',
                    'Age/Effective',
                    'Condition',
                    'Quality',
                  ].map((label) => {
                    let subjectValue: any = '';
                    switch (label) {
                      case 'Concessions':
                        subjectValue = 0;
                        break;
                      case 'NBHD Code':
                        subjectValue = subject?.nbhd_code || '';
                        break;
                      case 'Date of Sale/Time':
                        subjectValue = '-';
                        break;
                      case 'Land Size':
                        subjectValue = fmtSqftSafe(subject?.land_size_sqft ?? null);
                        break;
                      case 'View':
                        subjectValue = subject?.view || 'Neutral';
                        break;
                      case 'Housing Type':
                        subjectValue = subject?.structural_style || subject?.housing_type || 'Not available';
                        break;
                      case 'Architectural Style':
                        subjectValue = subject?.architectural_style || 'Not available';
                        break;
                      case 'Const Type':
                        subjectValue = normalizeConstType(subject?.stories, subject?.construction_type);
                        break;
                      case 'Age/Effective':
                        subjectValue = subject?.actual_age ?? '';
                        break;
                      case 'Condition':
                        subjectValue = subjectCondition;
                        break;
                      case 'Quality':
                        subjectValue = subjectQuality;
                        break;
                      default:
                        subjectValue = '';
                    }
                    return (
                      <tr key={label}>
                        <td className="px-4 py-2 border-b border-slate-200 bg-white">{label}</td>
                        <td
                          className="px-4 py-2 border-b border-slate-200"
                          style={{ backgroundColor: '#FEF3C7' }}
                        >
                          {label === 'Condition' ? (
                            <UadRatingSelect
                              ariaLabel="Subject condition"
                              value={subjectCondition}
                              ratings={UAD_CONDITION_RATINGS}
                              onChange={(value) => {
                                setSubjectCondition(value);
                                setDraftSubjectCondition(value);
                                setSubjectRatingDirty(true);
                                setRatingPersistenceError(null);
                              }}
                            />
                          ) : label === 'Quality' ? (
                            <UadRatingSelect
                              ariaLabel="Subject quality"
                              value={subjectQuality}
                              ratings={UAD_QUALITY_RATINGS}
                              onChange={(value) => {
                                setSubjectQuality(value);
                                setDraftSubjectQuality(value);
                                setSubjectRatingDirty(true);
                                setRatingPersistenceError(null);
                              }}
                            />
                          ) : (
                            subjectValue
                          )}
                        </td>
                        {Array.from({ length: COMPARABLE_COUNT }).map((_, i) => [
                          <td
                            key={`${label}-desc-${i}`}
                            className="px-4 py-2 border-b border-slate-200"
                          >
                            {label === 'Concessions'
                              ? fmtCurrency((compConcessions || [])[i] ?? '')
                              : label === 'NBHD Code'
                                ? (subject?.nbhd_code || '')
                              : label === 'Date of Sale/Time'
                                ? (compSaleDates[i] || '')
                              : label === 'Land Size'
                                ? fmtSqftSafe((compLandSize || [])[i] ?? '')
                              : label === 'Housing Type'
                                ? housingTypeGridValue(selectedSales[i])
                              : label === 'Architectural Style'
                                ? (selectedSales[i]?.architectural_style || 'Not available')
                              : label === 'Const Type'
                                ? normalizeConstType(subject?.stories, subject?.construction_type)
                              : label === 'Age/Effective'
                                ? (compAges[i] ?? '')
                              : label === 'Condition'
                                ? (
                                  <UadRatingSelect
                                    ariaLabel={`Comparable ${i + 1} condition`}
                                    value={compConditions[i] || ''}
                                    ratings={UAD_CONDITION_RATINGS}
                                    disabled={!selectedSales[i]}
                                    onChange={(value) => {
                                      const sale = selectedSales[i];
                                      if (sale) {
                                        updateConditionQualityRating(sale, 'condition', value);
                                      }
                                    }}
                                  />
                                )
                              : label === 'Quality'
                                ? (
                                  <UadRatingSelect
                                    ariaLabel={`Comparable ${i + 1} quality`}
                                    value={compQualities[i] || ''}
                                    ratings={UAD_QUALITY_RATINGS}
                                    disabled={!selectedSales[i]}
                                    onChange={(value) => {
                                      const sale = selectedSales[i];
                                      if (sale) {
                                        updateConditionQualityRating(sale, 'quality', value);
                                      }
                                    }}
                                  />
                                )
                              : label === 'View'
                                ? ((subject?.view || 'Neutral') as any)
                                : ''}
                          </td>,
                          <td
                            key={`${label}-adj-${i}`}
                            className="px-4 py-2 border-b border-slate-200 border-r"
                            style={{ borderLeft: '2px solid #e2e8f0', ...(i < COMPARABLE_COUNT - 1 ? { borderRightColor: '#cad5e2' } : {}) }}
                          >
                            {label === 'Concessions'
                              ? (() => {
                                  const v = (compConcessions || [])[i] ?? 0;
                                  const n = typeof v === 'string' ? Number(String(v).replace(/[^0-9.-]/g, '')) : Number(v);
                                  return Number.isFinite(n) && n > 0 ? fmtCurrency(-n) : '';
                                })()
                              : label === 'Date of Sale/Time'
                                ? ''
                              : label === 'Land Size'
                                ? fmtCurrency(0)
                              : label === 'Condition'
                                ? fmtCurrency((conditionAdjustments || [])[i] ?? 0)
                              : label === 'Quality'
                                ? fmtCurrency((qualityAdjustments || [])[i] ?? 0)
                              // SALES: Age/Effective – adjustments fixed at $0 for all comparables
                              : label === 'Age/Effective'
                                ? fmtCurrency(0)
                              : ''}
                          </td>,
                        ])}
                      </tr>
                    );
                  })}

                  {/* Above Grade row headers within subject cell */}
                  <tr>
                    <td className="px-4 py-2 border-b border-slate-200 bg-white">Above Grade</td>
                    <td className="px-4 py-2 border-b border-slate-200" style={{ backgroundColor: '#FEF3C7' }}>
                      <div className="grid grid-cols-3 text-sm h-5">
                        <div className="text-center h-full flex items-center justify-center">Total</div>
                        <div className="text-center h-full flex items-center justify-center" style={{ borderLeft: '2px solid #cbd5e1' }}>Beds</div>
                        <div className="text-center h-full flex items-center justify-center" style={{ borderLeft: '2px solid #cbd5e1' }}>Baths</div>
                      </div>
                    </td>
                    {Array.from({ length: COMPARABLE_COUNT }).map((_, i) => [
                      <td
                        key={`ag-desc-${i}`}
                        className="px-4 py-2 border-b border-slate-200"
                      >
                        <div className="grid grid-cols-3 text-sm">
                          <div className="text-center">Tot</div>
                          <div className="text-center border-l-2 border-slate-300">Bd</div>
                          <div className="text-center border-l-2 border-slate-300">Bt</div>
                        </div>
                      </td>,
                      <td
                        key={`ag-adj-${i}`}
                        className="px-4 py-2 border-b border-slate-200 border-r"
                        style={{ borderLeft: '2px solid #e2e8f0', ...(i < COMPARABLE_COUNT - 1 ? { borderRightColor: '#cad5e2' } : {}) }}
                      ></td>,
                    ])}
                  </tr>

                  {/* Room Count values under Above Grade headings */}
                  <tr>
                    <td className="px-4 py-2 border-b border-slate-200 bg-white">Room Count</td>
                    <td className="px-4 py-2 border-b border-slate-200" style={{ backgroundColor: '#FEF3C7' }}>
                      <div className="grid grid-cols-3 text-sm h-5">
                        <div className="text-center h-full flex items-center justify-center">{subjectTotalRooms ?? ''}</div>
                        <div className="text-center h-full flex items-center justify-center" style={{ borderLeft: '2px solid #cbd5e1' }}>{subjectBedrooms ?? ''}</div>
                        <div className="text-center h-full flex items-center justify-center" style={{ borderLeft: '2px solid #cbd5e1' }}>{subjectBathsDisplay}</div>
                      </div>
                    </td>
                    {Array.from({ length: COMPARABLE_COUNT }).map((_, i) => [
                      <td
                        key={`rooms-desc-${i}`}
                        className="px-4 py-2 bg-white border-b border-slate-200"
                      >
                        <div className="grid grid-cols-3 text-sm h-5">
                          <div className="text-center h-full flex items-center justify-center">{compRooms[i]?.tot ?? ''}</div>
                          <div className="text-center h-full flex items-center justify-center" style={{ borderLeft: '2px solid #cbd5e1' }}>{compRooms[i]?.bd ?? ''}</div>
                          <div className="text-center h-full flex items-center justify-center" style={{ borderLeft: '2px solid #cbd5e1' }}>
                            {(() => {
                              const r = compRooms[i];
                              if (!r || r.full == null) return '';
                              const half = r.half == null ? 0 : r.half;
                              return `${r.full}.${half}`;
                            })()}
                          </div>
                        </div>
                      </td>,
                      <td
                        key={`rooms-adj-${i}`}
                        className="px-4 py-2 border-b border-slate-200 bg-white border-r"
                        style={{ borderLeft: '2px solid #e2e8f0', ...(i < COMPARABLE_COUNT - 1 ? { borderRightColor: '#cad5e2' } : {}) }}
                      >
                        {/* SALES: Room Count adjustments = BedAdj + BathAdj */}
                        {fmtCurrency((roomCountTotalAdjustments || [])[i] ?? 0)}
                      </td>,
                    ])}
                  </tr>

                  {/* SALES: Gross Living Area — desc uses compGla; adjustment uses glaAdjustments[i] */}
                  <tr>
                    <td className="px-4 py-2 border-b border-slate-200 bg-white">Gross Living Area</td>
                    <td className="px-4 py-2 border-b border-slate-200" style={{ backgroundColor: '#FEF3C7' }}>
                      {loading ? 'Loading...' : fmtSqftSafe(subject?.total_living_area)}
                    </td>
                    {Array.from({ length: COMPARABLE_COUNT }).map((_, i) => [
                      <td key={`gla-desc-${i}`} className="px-4 py-2 border-b border-slate-200">{fmtSqftSafe(compGla[i] ?? '')}</td>,
                      <td
                        key={`gla-adj-${i}`}
                        className="px-4 py-2 border-b border-slate-200 border-r"
                        style={{ borderLeft: '2px solid #e2e8f0', ...(i < COMPARABLE_COUNT - 1 ? { borderRightColor: '#cad5e2' } : {}) }}
                      >{fmtCurrency((glaAdjustments || [])[i] ?? 0)}</td>,
                    ])}
                  </tr>

                  {/* SALES GRID: Indicated Value placeholder — apply Net/Gross adjustments against comparables to derive indicated value */}
                  {/* SALES GRID: Additional features section — Basement SF, Functional Utility, Heating/Cooling, Solar Panels, Porches/Decks, Fencing, Pool, Secondary Improvements */}
                  {/* EQUITY GRID: Row logic mapping for adjustments (mirrors Sales grid labels) */}
                  {[
                    'Basement SF',
                    'Functional Utility',
                    'Heating/Cooling',
                    'Solar Panels',
                    'Garage/Parking',
                    'Porches/Decks',
                    'Fencing',
                    'Pool',
                    'Secondary Improvements',
                  ].map((label) => (
                    // SALES GRID FEATURE ROW: Functional Utility — placeholder; add logic if/when defined
                    <tr key={label}>
                      <td className="px-4 py-2 border-b border-slate-200 bg-white">{label}</td>
                      <td className="px-4 py-2 border-b border-slate-200" style={{ backgroundColor: '#FEF3C7' }}>
                        {label === 'Basement SF'
                          ? fmtSqftSafe(subject?.basement_sqft)
                          : label === 'Functional Utility'
                            ? 'Adequate'
                          : label === 'Heating/Cooling'
                            ? (() => {
                                const h = (subject?.heating || '').toString().trim();
                                const a = (subject?.air_conditioning || '').toString().trim();
                                if (!h && !a) return '';
                                const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
                                if (h && a && norm(h) === 'central full' && norm(a) === 'central full') return 'Central';
                                if (h && a) return `${h} / ${a}`;
                                return h || a;
                              })()
                          : label === 'Solar Panels'
                              ? 'None'
                              : label === 'Garage/Parking'
                                ? (subjectGarageGroup !== null
                                    ? `${subjectGarageGroup} ${subjectGarageGroup === 1 ? 'space' : 'spaces'}${subject?.garage_area_sqft ? ` · ${fmtSqftSafe(subject.garage_area_sqft)}` : ''}`
                                    : fmtSqftSafe(subject?.garage_area_sqft))
                                : label === 'Porches/Decks'
                                  ? 'N/A'
                              : label === 'Fencing'
                                    ? (() => {
                                        const s = (subject?.fence_type ?? '').toString().trim();
                                        return s || '-';
                                      })()
                                    : label === 'Pool'
                                      ? poolDisplay(subject?.pool)
                                    // Secondary Improvements: placeholder display
                                    : label === 'Secondary Improvements'
                                      ? 'N/A'
                                      : ''}
                      </td>
                      {Array.from({ length: COMPARABLE_COUNT }).map((_, i) => [
                        <td key={`${label}-desc-${i}`} className="px-4 py-2 border-b border-slate-200">
                          {/* Basement SF mirroring: comparables match the subject's basement_sqft (including '-') */}
                        {label === 'Basement SF'
                          ? fmtSqftSafe(subject?.basement_sqft)
                          : label === 'Functional Utility'
                            ? 'Adequate'
                          // Heating/Cooling mirroring: comparables show same derived display as subject
                          : label === 'Heating/Cooling'
                            ? (() => {
                                const h = (subject?.heating || '').toString().trim();
                                const a = (subject?.air_conditioning || '').toString().trim();
                                if (!h && !a) return '';
                                const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
                                if (h && a && norm(h) === 'central full' && norm(a) === 'central full') return 'Central';
                                if (h && a) return `${h} / ${a}`;
                                return h || a;
                              })()
                          // Solar Panels: fixed display of 'None' for all comparables
                          : label === 'Solar Panels'
                            ? 'None'
                          // Fencing mirroring: comparables show same fence type as subject
                          : label === 'Fencing'
                            ? (() => { const s = (subject?.fence_type ?? '').toString().trim(); return s || '-'; })()
                          // Porches/Decks: fixed display of 'N/A' for all comparables
                          : label === 'Porches/Decks'
                            ? 'N/A'
                          // Pool (comparables): use the comparable's MLS value, with CAD as fallback.
                          : label === 'Pool'
                            ? poolDisplay(selectedSales[i]?.mls_pool_yn ?? selectedSales[i]?.cad_pool)
                          // Garage/Parking: prefer the MLS space count used by grouped analysis.
                          : label === 'Garage/Parking'
                            ? (comparableGarageGroups[i] !== null
                                ? `${comparableGarageGroups[i]} ${comparableGarageGroups[i] === 1 ? 'space' : 'spaces'}`
                                : fmtSqftSafe((compGarage || [])[i] ?? ''))
                          // Secondary Improvements: placeholder display for comparables
                          : label === 'Secondary Improvements'
                            ? 'N/A'
                            : ''}
                        </td>,
                        <td
                          key={`${label}-adj-${i}`}
                          className="px-4 py-2 border-b border-slate-200 border-r"
                          style={{ borderLeft: '2px solid #e2e8f0', ...(i < COMPARABLE_COUNT - 1 ? { borderRightColor: '#cad5e2' } : {}) }}
                        >
                          {label === 'Garage/Parking'
                            ? fmtCurrency(garageAdjustments[i] ?? 0)
                            : label === 'Pool'
                              ? fmtCurrency(poolAdjustments[i] ?? 0)
                              : ''}
                        </td>,
                      ])}
                    </tr>
                  ))}

                  {/* Totals rows */}
                  {/* SALES GRID TOTALS: Net Adjustments — compute sum of signed adjustments per comparable */}
                  {/* EQUITY GRID TOTALS: Net Adjustments — compute sum of signed adjustments per comparable */}
                  <tr className="font-medium">
                    <td className="px-4 py-2 border-b border-slate-300 bg-white">Net Adjustments</td>
                    <td className="px-4 py-2 border-b border-slate-300" style={{ backgroundColor: '#FEF3C7' }}>-</td>
                    {Array.from({ length: COMPARABLE_COUNT }).map((_, i) => [
                      <td key={`net-desc-${i}`} className="px-4 py-2 border-b border-slate-300"></td>,
                      <td
                        key={`net-adj-${i}`}
                        className="px-4 py-2 border-b border-slate-300 border-r"
                        style={{ borderLeft: '2px solid #e2e8f0', ...(i < COMPARABLE_COUNT - 1 ? { borderRightColor: '#cad5e2' } : {}) }}
                      >{fmtCurrency((netAdjustments || [])[i] ?? 0)}</td>,
                    ])}
                  </tr>

                  {/* SALES GRID TOTALS: Gross Adjustments — compute sum of absolute adjustments per comparable */}
                  {/* EQUITY GRID TOTALS: Gross Adjustments — compute sum of absolute adjustments per comparable */}
                  <tr className="font-medium">
                    <td className="px-4 py-2 border-b border-slate-300 bg-white">Gross Adjustments</td>
                    <td className="px-4 py-2 border-b border-slate-300" style={{ backgroundColor: '#FEF3C7' }}>-</td>
                    {Array.from({ length: COMPARABLE_COUNT }).map((_, i) => [
                      <td key={`gross-desc-${i}`} className="px-4 py-2 border-b border-slate-300"></td>,
                      <td
                        key={`gross-adj-${i}`}
                        className="px-4 py-2 border-b border-slate-300 border-r"
                        style={{ borderLeft: '2px solid #e2e8f0', ...(i < COMPARABLE_COUNT - 1 ? { borderRightColor: '#cad5e2' } : {}) }}
                      >{fmtCurrency((grossAdjustments || [])[i] ?? 0)}</td>,
                    ])}
                  </tr>

                  <tr className="font-semibold">
                    <td className="px-4 py-2 bg-orange-200 border-t border-b border-slate-300">INDICATED VALUE</td>
                    <td className="px-4 py-2 bg-slate-100 border-t border-b border-slate-300" style={{ backgroundColor: '#FEF3C7' }}>-</td>
                    {Array.from({ length: COMPARABLE_COUNT }).map((_, i) => [
                      <td key={`iv-desc-${i}`} className="px-4 py-2 bg-slate-100 border-t border-b border-slate-300"></td>,
                      <td
                        key={`iv-adj-${i}`}
                        className="px-4 py-2 bg-slate-100 border-t border-b border-slate-300 border-r"
                        style={{ borderLeft: '2px solid #e2e8f0', ...(i < COMPARABLE_COUNT - 1 ? { borderRightColor: '#cad5e2' } : {}) }}
                      >{fmtCurrency((indicatedValues || [])[i] ?? 0)}</td>,
                    ])}
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <section className="mt-4 rounded-2xl border border-sky-200 bg-white shadow-sm">
          <div className="border-b border-sky-100 bg-sky-50/70 p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-base font-semibold text-slate-950">Comparable Listings</div>
                <p className="mt-1 max-w-3xl text-sm text-slate-600">
                  Select up to six current listings. This grid mirrors the sales-comparison layout and uses the same applied bath, GLA, garage, pool, condition, and quality rates while keeping its listing indication separate from the closed-sale reconciliation.
                </p>
              </div>
              <button
                type="button"
                onClick={clearListings}
                disabled={!selectedListings.some(Boolean)}
                className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Clear Listings
              </button>
            </div>

            <form
              className="mt-3 flex flex-col gap-2 sm:flex-row"
              onSubmit={(event) => {
                event.preventDefault();
                void runListingSearch();
              }}
            >
              <label className="flex-1 text-xs font-medium text-slate-600">
                Optional address or MLS number
                <input
                  value={listingQuery}
                  onChange={(event) => setListingQuery(event.target.value)}
                  placeholder="Leave blank to load the nearest available listings"
                  className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-100"
                />
              </label>
              <button
                type="submit"
                disabled={listingLoading}
                className="self-end rounded-md border border-sky-700 bg-sky-700 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-800 disabled:cursor-wait disabled:opacity-60"
              >
                {listingLoading ? 'Loading Listings…' : 'Find Comparable Listings'}
              </button>
            </form>

            {listingError && <div className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">{listingError}</div>}
            {listingNotice && <div className="mt-2 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-900">{listingNotice}</div>}
          </div>

          {renderListingAdjustmentGrid()}

          {listingResults.length > 0 && (
            <div className="border-t border-sky-100 p-4">
              <div className="mb-2 text-sm font-semibold text-slate-900">Available Listing Records</div>
              <div className="max-h-[340px] overflow-auto rounded-xl border border-slate-200">
                <table className="w-full min-w-[980px] text-left text-sm">
                  <thead className="sticky top-0 z-10 bg-slate-100 text-slate-700">
                    <tr>
                      <th className="px-3 py-2">Property</th>
                      <th className="px-3 py-2">Listing</th>
                      <th className="px-3 py-2">Characteristics</th>
                      <th className="px-3 py-2">Distance</th>
                      <th className="px-3 py-2 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {listingResults.map((listing) => {
                      const selectedSlot = selectedListings.findIndex((item) => item && saleKey(item) === saleKey(listing));
                      const selected = selectedSlot >= 0;
                      return (
                        <tr key={`listing-result-${saleKey(listing)}`} className="border-t border-slate-200 align-top">
                          <td className="px-3 py-3">
                            <div className="flex min-w-[260px] items-start gap-3">
                              <MlsPhoto
                                src={listing.primary_photo_url}
                                alt={saleDisplayAddress(listing)}
                                photoCount={Number(listing.photo_count || 0)}
                                onOpen={listing.primary_photo_url ? () => void openSaleGallery(listing) : undefined}
                                compact
                              />
                              <div>
                                <div className="font-medium text-slate-950">{saleDisplayAddress(listing)}</div>
                                <div className="mt-1 text-xs text-slate-500">{listing.primary_account_id || 'Unmatched account'} · MLS {listing.listing_id || '—'}</div>
                              </div>
                            </div>
                          </td>
                          <td className="px-3 py-3">
                            <div className="font-semibold text-slate-950">{fmtCurrency(listing.sale_price) || 'Price unavailable'}</div>
                            <div className="mt-1 text-xs text-slate-500">{listing.mls_status || 'Status unavailable'} · {saleDateDisplay(listing.listing_contract_date)} · DOM {listing.days_on_market ?? '—'}</div>
                          </td>
                          <td className="px-3 py-3 text-slate-700">
                            <div>{fmtSqftSafe(listing.cad_living_area_sqft ?? listing.mls_living_area)} · {listing.cad_bedroom_count ?? listing.mls_bedrooms_total ?? '—'} bd · {listing.cad_bath_count ?? listing.mls_bathrooms_total_integer ?? '—'} ba</div>
                            <div className="mt-1 text-xs text-slate-500">Built {listing.cad_year_built ?? listing.mls_year_built ?? '—'} · {listing.housing_type || listing.structural_style || 'Housing type unavailable'}</div>
                          </td>
                          <td className="px-3 py-3 text-slate-700">
                            {listing.distanceMiles == null ? (
                              <span className="text-xs text-amber-800">Location unavailable</span>
                            ) : (
                              <span className="font-medium">{Number(listing.distanceMiles).toFixed(2)} mi</span>
                            )}
                          </td>
                          <td className="px-3 py-3 text-right">
                            <button
                              type="button"
                              onClick={() => selected ? removeListingFromGrid(selectedSlot) : addListingToGrid(listing)}
                              className={`rounded-md border px-3 py-1.5 text-xs font-semibold ${
                                selected
                                  ? 'border-red-300 bg-white text-red-700 hover:bg-red-50'
                                  : 'border-sky-700 bg-sky-700 text-white hover:bg-sky-800'
                              }`}
                            >
                              {selected ? 'Remove from Listing Grid' : 'Add to Listing Grid'}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </section>

        {/* Opinion of Market Value */}
        <div className="mt-4 rounded-2xl border border-slate-200 bg-white">
          <div className="p-6 text-center">
            <div className="text-xl font-semibold text-slate-900">Opinion of Market Value</div>
            <div className="mt-2 text-5xl font-extrabold" style={{ color: '#9A4A00' }}>
              {opinionAfterCtc != null ? fmtCurrency(opinionAfterCtc) : 'N/A'}
            </div>
            <p className="mt-4 text-slate-700 max-w-4xl mx-auto">
              Based on the sales comparison analysis of comparable properties in the immediate neighborhood and
              accounting for necessary cost-to-cure repairs.
            </p>
            <p className="mt-6 text-xs italic text-slate-600 max-w-5xl mx-auto">
              DISCLAIMER: This is not an appraisal nor should it be relied on as an appraisal by a licensed
              professional. The use of this opinion of market value is limited strictly to protesting an appraisal by a
              Texas Appraisal District. Per USPAP, appraisers are required to act unbiased, impartial, and objective to
              uphold public trust in the appraisal profession. However, this report was generated with bias and
              therefore cannot be considered an appraisal per USPAP guidelines.
            </p>
          </div>
        </div>

        <ConditionQualityStudy
          key={`condition-quality-${propertyId}`}
          subjectAccountId={propertyId}
          subjectCondition={subjectCondition}
          subjectQuality={subjectQuality}
          ratingAssignments={conditionQualityRatings}
          appliedAdjustments={appliedConditionQualityAdjustments}
          onRatingChange={updateConditionQualityRating}
          onSalesLoaded={(sales) => void registerSavedSaleRatings(sales)}
          getImpactPreview={previewConditionQualityAdjustment}
          onOpenSale={(sale) => void openSaleGallery(sale)}
          onApplyAdjustment={(adjustment) =>
            setAppliedConditionQualityAdjustments((current) => ({
              ...current,
              [adjustment.dimension]: adjustment,
            }))
          }
          onRemoveAdjustment={(dimension) =>
            setAppliedConditionQualityAdjustments((current) => {
              const next = { ...current };
              delete next[dimension];
              return next;
            })
          }
        />

        <GroupedAdjustmentAnalysis
          key={propertyId}
          subjectAccountId={propertyId}
          appraiserDefinedArea={appraiserDefinedAdjustmentArea}
          appliedAdjustments={appliedGroupedAdjustments}
          getImpactPreview={previewGroupedAdjustment}
          onApplyAdjustment={(adjustment) =>
            setAppliedGroupedAdjustments((current) => {
              const next: Record<string, AppliedGroupedAdjustment> = Object.fromEntries(
                Object.entries(current).filter(
                  ([, applied]) => applied.dimensionKey !== adjustment.dimensionKey,
                ),
              );
              next[adjustment.id] = adjustment;
              return next;
            })
          }
          onRemoveAdjustment={(adjustmentId) =>
            setAppliedGroupedAdjustments((current) => {
              const next = { ...current };
              delete next[adjustmentId];
              return next;
            })
          }
        />

        {/* Adjustment Breakdown */}
        <div className="mt-6">
          <div className="text-xl font-semibold text-slate-900">Adjustment Breakdown</div>
          <div className="text-sm text-slate-600">
            Live methodology summary based on the studies and factors currently applied to the sales comparison grid.
          </div>

          <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
            {[
              {
                key: 'bathrooms' as const,
                label: 'Bath Count',
                adjustments: roomCountBathAdjustments,
              },
              {
                key: 'garage' as const,
                label: 'Garages/Parking',
                adjustments: garageAdjustments,
              },
              {
                key: 'pool' as const,
                label: 'Pool',
                adjustments: poolAdjustments,
              },
              {
                key: 'living_area' as const,
                label: 'Gross Living Area',
                adjustments: glaAdjustments,
              },
            ].map((summaryItem) => {
              const studies = groupedStudiesFor(summaryItem.key);
              return (
                <div
                  key={`live-summary-${summaryItem.key}`}
                  className={`rounded-xl border p-4 ${
                    studies.length
                      ? 'border-emerald-200 bg-emerald-50'
                      : 'border-slate-200 bg-slate-50'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-semibold text-slate-900">{summaryItem.label}</div>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                      studies.length
                        ? 'bg-emerald-100 text-emerald-800'
                        : 'bg-slate-200 text-slate-600'
                    }`}>
                      {studies.length ? `${studies.length} applied` : 'Not applied'}
                    </span>
                  </div>
                  <p className="mt-2 text-xs leading-5 text-slate-700">
                    {groupedBreakdownSummary(summaryItem.key, summaryItem.adjustments)}
                  </p>
                  <div className="mt-3 rounded-lg bg-white/80 px-3 py-2 text-xs font-medium text-slate-700">
                    {groupedGridImpact(summaryItem.adjustments)}
                  </div>
                </div>
              );
            })}
            {([
              {
                key: 'condition' as const,
                label: 'Condition',
                adjustments: conditionAdjustments,
              },
              {
                key: 'quality' as const,
                label: 'Quality',
                adjustments: qualityAdjustments,
              },
            ]).map((summaryItem) => {
              const applied = appliedConditionQualityAdjustments[summaryItem.key];
              return (
                <div
                  key={`live-summary-${summaryItem.key}`}
                  className={`rounded-xl border p-4 ${
                    applied
                      ? 'border-emerald-200 bg-emerald-50'
                      : 'border-slate-200 bg-slate-50'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-semibold text-slate-900">{summaryItem.label}</div>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                      applied
                        ? 'bg-emerald-100 text-emerald-800'
                        : 'bg-slate-200 text-slate-600'
                    }`}>
                      {applied ? 'Applied' : 'Not applied'}
                    </span>
                  </div>
                  <p className="mt-2 text-xs leading-5 text-slate-700">
                    {conditionQualityBreakdownSummary(
                      summaryItem.key,
                      summaryItem.adjustments,
                    )}
                  </p>
                  <div className="mt-3 rounded-lg bg-white/80 px-3 py-2 text-xs font-medium text-slate-700">
                    {groupedGridImpact(summaryItem.adjustments)}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Property Location Analysis (Comparable Sales Map) */}
          <div className="mt-6 rounded-2xl border border-slate-200 bg-white">
            <div className="p-6">
              <div className="text-xl font-semibold text-slate-900">Property Location Analysis</div>
              <div className="text-sm text-slate-600 mt-1">
                Geographic distribution of the subject property and comparable sales used in our analysis.
              </div>

              <ComparableSalesMap
                subjectAccountId={propertyId}
                subjectAddress={subject?.address}
                sales={selectedSales}
                onOpenSale={(sale) => void openSaleGallery(sale)}
              />
          
          {/* Location Analysis callout */}
          <div className="mt-4 rounded-xl bg-amber-50 border border-amber-200 p-4 text-sm text-slate-800">
            <div className="font-medium mb-1">Location Analysis</div>
            The map follows the current primary grid. Adding, removing, or reordering a comparable updates its numbered marker, MLS thumbnail, and subject distance automatically. Any sale without usable parcel coordinates remains in the grid and is flagged beneath the map instead of being silently omitted.
          </div>
        </div>
      </div>
    </div>

    {/* Cost to Cure */}
    <div className="mt-6 rounded-2xl border border-slate-200 bg-white">
      <div className="p-6">
        <div className="text-xl font-semibold text-slate-900">Cost to Cure</div>
        <div className="text-sm text-slate-600 mt-1">
          Add each necessary repair or improvement and its estimated cost. The total updates the reconciled value automatically.
        </div>

        <div className="mt-4 space-y-3">
          {costToCureItems.map((item, index) => (
            <div
              key={item.id}
              className="grid grid-cols-1 gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4 md:grid-cols-[minmax(0,1fr)_13rem_auto] md:items-end"
            >
              <label className="block">
                <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-600">
                  Repair item {index + 1}
                </span>
                <input
                  type="text"
                  value={item.description}
                  onChange={(event) =>
                    setCostToCureItems((current) =>
                      current.map((currentItem) =>
                        currentItem.id === item.id
                          ? { ...currentItem, description: event.target.value }
                          : currentItem,
                      ),
                    )
                  }
                  placeholder="Describe the repair or improvement"
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-200"
                  aria-label={`Repair item ${index + 1} description`}
                />
              </label>

              <label className="block">
                <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-600">
                  Estimated cost
                </span>
                <div className="flex rounded-lg border border-slate-300 bg-white shadow-sm focus-within:border-amber-500 focus-within:ring-2 focus-within:ring-amber-200">
                  <span className="flex items-center border-r border-slate-200 px-3 text-sm font-semibold text-slate-500">$</span>
                  <input
                    type="number"
                    min="0"
                    step="100"
                    inputMode="decimal"
                    value={item.cost}
                    onChange={(event) =>
                      setCostToCureItems((current) =>
                        current.map((currentItem) =>
                          currentItem.id === item.id
                            ? { ...currentItem, cost: event.target.value }
                            : currentItem,
                        ),
                      )
                    }
                    placeholder="0"
                    className="min-w-0 flex-1 rounded-r-lg border-0 bg-transparent px-3 py-2 text-sm text-slate-900 focus:outline-none"
                    aria-label={`Repair item ${index + 1} estimated cost`}
                  />
                </div>
              </label>

              <button
                type="button"
                onClick={() =>
                  setCostToCureItems((current) =>
                    current.filter((currentItem) => currentItem.id !== item.id),
                  )
                }
                className="rounded-lg border border-rose-200 bg-white px-3 py-2 text-sm font-semibold text-rose-700 hover:bg-rose-50"
                aria-label={`Remove repair item ${index + 1}`}
              >
                Remove
              </button>
            </div>
          ))}

          {!costToCureItems.length && (
            <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-center text-sm text-slate-600">
              No repair items have been added.
            </div>
          )}

          <button
            type="button"
            onClick={() =>
              setCostToCureItems((current) => [
                ...current,
                createCostToCureLine(),
              ])
            }
            className="inline-flex items-center rounded-lg border border-amber-300 bg-amber-50 px-4 py-2 text-sm font-semibold text-amber-900 hover:bg-amber-100"
          >
            + Add repair item
          </button>
        </div>

        {/* Total Cost callout */}
        <div className="mt-5 rounded-xl border border-amber-300 bg-amber-50 p-4 flex items-center justify-between">
          <div>
            <div className="font-semibold">Total Cost to Cure</div>
            <div className="text-sm text-slate-700">These necessary repairs should be factored into the property's adjusted market value.</div>
          </div>
          <div className="text-3xl font-extrabold" style={{ color: '#9A4A00' }}>${costToCureTotal.toLocaleString()}</div>
        </div>

        {/* Market Impact Analysis */}
        <div className="mt-4 rounded-xl bg-slate-50 border border-slate-200 p-4 text-sm text-slate-800">
          <div className="font-medium mb-1">Market Impact Analysis</div>
          {costToCureTotal > 0
            ? `${serializedCostToCureItems.length} repair item${serializedCostToCureItems.length === 1 ? '' : 's'} currently total ${fmtCurrency(costToCureTotal)}. This amount is deducted from the reconciled sales-comparison value when calculating the opinion after cost to cure.`
            : 'Add repair items and estimated costs above to calculate the cost-to-cure deduction.'}
        </div>
      </div>
    </div>

    {/* Protest Summary Generator */}
    <div className="hidden" aria-hidden="true">
      <div className="p-6">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xl font-semibold text-slate-900">Protest Summary Generator</div>
            <div className="text-sm text-slate-600 mt-1">Generate a short summary covering the sales comparison approach, adjustments, and cost-to-cure.</div>
          </div>
          <div className="text-xs text-slate-600">
            {import.meta.env.VITE_OPENAI_API_KEY ? 'AI enabled via VITE_OPENAI_API_KEY' : 'AI not configured (using local template)'}
          </div>
        </div>

        <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="flex flex-col">
            <label className="text-xs mb-1 text-slate-600">Sales Comparison Approach</label>
            <textarea
              value={salesNotes}
              onChange={(e) => setSalesNotes(e.target.value)}
              className="border rounded-md p-2 text-sm h-24"
            ></textarea>
          </div>
          <div className="flex flex-col">
            <label className="text-xs mb-1 text-slate-600">Adjustment Analysis</label>
            <textarea
              value={adjustmentNotes}
              onChange={(e) => setAdjustmentNotes(e.target.value)}
              className="border rounded-md p-2 text-sm h-24"
            ></textarea>
          </div>
          <div className="flex flex-col">
            <label className="text-xs mb-1 text-slate-600">Cost to Cure</label>
            <textarea
              value={ctcNotes}
              onChange={(e) => setCtcNotes(e.target.value)}
              className="border rounded-md p-2 text-sm h-24"
            ></textarea>
          </div>
        </div>

        <div className="mt-4 flex items-center gap-2">
          <button
            type="button"
            className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-emerald-600 border border-emerald-600 text-white hover:bg-emerald-700"
            onClick={generateSummary}
            disabled={summaryLoading}
          >
            {summaryLoading ? 'Generating…' : 'Generate Summary'}
          </button>
          {summary && (
            <>
              <button
                type="button"
                className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-slate-800 border border-slate-800 text-white hover:bg-slate-900"
                onClick={downloadSummaryPdf}
              >
                Download PDF
              </button>
              <button
                type="button"
                className="px-3 py-2 rounded-md border text-slate-700 hover:bg-slate-50"
                onClick={() => navigator.clipboard?.writeText(summary)}
              >
                Copy
              </button>
            </>
          )}
          {summaryError && <div className="text-sm text-red-600">{summaryError}</div>}
        </div>

        <div className="mt-3">
          <label className="text-xs mb-1 text-slate-600 block">Generated Summary</label>
          <textarea value={summary} readOnly className="w-full border rounded-md p-3 text-sm h-40" placeholder="Summary will appear here" />
        </div>
      </div>
    </div>
      </div>
    </div>
  );
}

function DistrictEvidenceAccordion() {
  const [open, setOpen] = useState<number | null>(null);
  const rows = [
    'District Comp 1: 789 Elm St - $510,000',
    'District Comp 2: 101 Oak Dr - $499,000',
    'District Comp 3: 212 Cedar Ave - $505,000',
    'District Comp 4: 313 Birch Rd - $515,000',
  ];

  return (
    <div className="mt-4 divide-y divide-slate-200 border border-slate-200 rounded-lg overflow-hidden">
      {rows.map((label, i) => {
        const isOpen = open === i;
        return (
          <div key={i} className="bg-white">
            <button
              type="button"
              className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-slate-50"
              onClick={() => setOpen(isOpen ? null : i)}
            >
              <span className="font-medium text-slate-800">{label}</span>
              <svg
                className={`w-4 h-4 text-slate-600 transition-transform ${isOpen ? 'rotate-180' : ''}`}
                viewBox="0 0 20 20"
                fill="currentColor"
              >
                <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 10.17l3.71-2.94a.75.75 0 11.92 1.18l-4.25 3.37a.75.75 0 01-.92 0L5.21 8.41a.75.75 0 01.02-1.2z" clipRule="evenodd" />
              </svg>
            </button>
            {isOpen && (
              <div className="px-4 pb-3 text-sm text-slate-600">
                Details coming soon.
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

















































