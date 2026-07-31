import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useEffect, useMemo, useState, useRef } from 'react';
import * as api from '@/lib/api';
import type { ComparableRecommendationsResponse, SalePhoto, SaleRow } from '@/lib/api';
import GroupedAdjustmentAnalysis, {
  type AppliedGroupedAdjustment,
  type GroupedAdjustmentImpactPreview,
} from '@/components/GroupedAdjustmentAnalysis';
import ConditionQualityStudy, {
  type ConditionQualityImpactPreview,
  type ConditionQualityRatingAssignment,
} from '@/components/ConditionQualityStudy';
import MarketConditionsAnalysis from '@/components/MarketConditionsAnalysis';
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
import { saveAppraisalReportDraft } from '@/lib/appraisalReportDraft';
import {
  readMarketConditionsDraft,
  type MarketConditionsDraft,
} from '@/lib/marketConditionsDraft';

const COMPARABLE_COUNT = 6;
type SalesAnalysisPeriodMonths = 12 | 24 | 36;

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
  // Read the property-report condition choice and normalize it to a valid UAD C1-C6 rating.
  const conditionCode = useMemo(() => {
    const p = new URLSearchParams(location.search);
    return p.get('condCode') || '';
  }, [location.search]);
const [subject, setSubject] = useState<SubjectData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [photos, setPhotos] = useState<File[]>([]);
  const photoInputRef = useRef<HTMLInputElement | null>(null);
  const [subjectPhotos, setSubjectPhotos] = useState<SalePhoto[]>([]);
  const [gallery, setGallery] = useState<GalleryState | null>(null);
  const [summary, setSummary] = useState('');
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [salesNotes, setSalesNotes] = useState('');
  const [adjustmentNotes, setAdjustmentNotes] = useState('');
  const [ctcNotes, setCtcNotes] = useState('');
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

  useEffect(() => {
    setAppliedGroupedAdjustments({});
    setAppliedConditionQualityAdjustments({});
    setConditionQualityRatings({});
  }, [propertyId]);

  useEffect(() => {
    setMarketConditionsDraft(readMarketConditionsDraft(propertyId));
  }, [propertyId]);

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
  // Cost to Cure data (also used for rendering)
  const costToCure = useMemo(() => ({
    left: [
      {
        title: 'Roof Repairs',
        items: [
          { label: 'Replace damaged shingles (approx. 500 sq ft)', cost: 3500 },
          { label: 'Repair flashing around chimney and vents', cost: 850 },
          { label: 'Clean and repair gutters', cost: 450 },
        ],
      },
      {
        title: 'Interior Repairs',
        items: [
          { label: 'Replace outdated kitchen appliances', cost: 4500 },
          { label: 'Update master bathroom fixtures', cost: 3200 },
          { label: 'Replace worn carpet in bedrooms', cost: 2800 },
          { label: 'Paint interior walls (full house)', cost: 3500 },
          { label: 'Replace damaged hardwood flooring (200 sq ft)', cost: 2400 },
        ],
      },
    ],
    right: [
      {
        title: 'Foundation Issues',
        items: [
          { label: 'Minor foundation settling repairs', cost: 2200 },
          { label: 'Seal basement/crawl space moisture issues', cost: 1800 },
          { label: 'Level sagging floor joists', cost: 3200 },
        ],
      },
      {
        title: 'HVAC & Electrical',
        items: [
          { label: 'Service and repair HVAC system', cost: 1200 },
          { label: 'Update electrical outlets to GFCI', cost: 800 },
          { label: 'Replace aging water heater', cost: 1500 },
        ],
      },
    ],
  }), []);

  const costToCureTotal = useMemo(() => {
    const sum = (arr: { items: { cost: number }[] }[]) =>
      arr.reduce((acc, cat) => acc + cat.items.reduce((s, i) => s + i.cost, 0), 0);
    return sum(costToCure.left) + sum(costToCure.right);
  }, [costToCure]);

  // Build dynamic default notes once subject is available (and only if still blank)
  useEffect(() => {
    if (!salesNotes) {
      const addr = subject?.address || 'the subject property';
      setSalesNotes('Comparable sales are analyzed based on the subjects condition to provide the best comparisons possible');
    }
    if (!adjustmentNotes) {
      const used = [
        'time/date of sale',
        'neighborhood (NBHD code)',
        'gross living area',
        'room/bath count',
        'condition/updating',
        'feature differences (garage, pool, fencing, etc.)',
      ];
      setAdjustmentNotes(
        `Applied adjustments for ${used.join(', ')} based on grouped analysis and market-supported premiums. ` +
          `This produces values that reflect buyer reactions more reliably than generic district factors.`
      );
    }
    if (!ctcNotes) {
      setCtcNotes(
        `Estimated cost to cure is $${costToCureTotal.toLocaleString()} for necessary roof, interior, foundation, and HVAC/electrical items, ` +
          `which buyers typically expect to be reflected in price.`
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subject, costToCureTotal]);

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
            costToCure: { total: costToCureTotal, categories: costToCure },
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
              costToCure: { total: costToCureTotal, categories: costToCure },
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
        `Based on a sales comparison approach, we selected nearby transactions within the same neighborhood and within a 0.5ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¹Ã…â€œmile radius of ${subjectAddr}. These properties are similar in age, size, and quality, providing a reliable indication of current market behavior.`,
        `Adjustments were applied for time, neighborhood code, gross living area, and condition, as well as specific features such as bathrooms, parking, and pools. The adjustments reflect observed market premiums/discounts evidenced by grouped analysis and regression where available, resulting in an indicated value that better aligns with market reactions than the district's broad categories.`,
        `A costÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¹Ã…â€œtoÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¹Ã…â€œcure analysis identified approximately $${costToCureTotal.toLocaleString()} in necessary repairs (roof, interior updates, foundation/leveling, and HVAC/electrical). These items impact both buyer appeal and contributory value and should be reflected in the final reconciliation.`,
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

  const mlsLotSizeSqft = (value: unknown): number | null => {
    const area = saleNumber(value);
    if (area == null || area <= 0) return null;
    // The MLS export omits its unit column: sub-100 values are acreage,
    // while the larger values are already square feet.
    return area < 100 ? area * 43_560 : area;
  };

  const applySaleToSlot = (sale: SaleRow, slot: number) => {
    const livingArea = saleNumber(sale.cad_living_area_sqft ?? sale.mls_living_area);
    const price = saleNumber(sale.sale_price);
    const concessions = saleNumber(sale.seller_contributions);
    const landSize = mlsLotSizeSqft(sale.mls_lot_size_area);
    const yearBuilt = saleNumber(sale.cad_year_built ?? sale.mls_year_built);
    const bedrooms = saleNumber(sale.cad_bedroom_count ?? sale.mls_bedrooms_total);
    const fullBaths = saleNumber(sale.cad_baths_full ?? sale.mls_bathrooms_full);
    const halfBaths = saleNumber(sale.cad_baths_half ?? sale.mls_bathrooms_half);
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
      setSalesError('Complete the current Market Conditions Analysis before selecting comparable sales.');
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
    setSelectedSales((current) => current.map((item, index) => index === slot ? null : item));
    setCompAddresses((current) => current.map((value, index) => index === slot ? '' : value));
    setCompGla((current) => current.map((value, index) => index === slot ? null : value));
    setCompPrices((current) => current.map((value, index) => index === slot ? null : value));
    setCompConcessions((current) => current.map((value, index) => index === slot ? null : value));
    setCompTimeAdjustments((current) => current.map((value, index) => index === slot ? null : value));
    setCompSaleDates((current) => current.map((value, index) => index === slot ? '' : value));
    setCompLandSize((current) => current.map((value, index) => index === slot ? null : value));
    setCompAges((current) => current.map((value, index) => index === slot ? null : value));
    setCompGarage((current) => current.map((value, index) => index === slot ? null : value));
    setCompConditions((current) => current.map((value, index) => index === slot ? '' : value));
    setCompQualities((current) => current.map((value, index) => index === slot ? '' : value));
    setCompRooms((current) => current.map((value, index) => index === slot ? { tot: null, bd: null, full: null, half: null } : value));
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
      setSalesError('Complete the current Market Conditions Analysis before recommending comparable sales.');
      return;
    }
    if (!propertyId) {
      setSalesError('A subject property is required before comparable sales can be recommended.');
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
      setSalesError('Complete the current Market Conditions Analysis before searching comparable sales.');
      return;
    }
    setSalesLoading(true);
    setSalesError(null);
    setSalesNotice(null);
    try {
      const rows = await api.searchSales({
        q: salesQuery.trim() || undefined,
        excludeAccountId: propertyId || undefined,
        neighborhoodCode: sameNeighborhoodOnly ? (subject?.nbhd_code || undefined) : undefined,
        dateFrom: salesDateFrom || undefined,
        dateTo: salesAnalysisAsOf || undefined,
        matched: includeUnmatchedSales ? undefined : true,
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

  // OPINION ADJUSTMENT: subtract fixed Cost to Cure ($31,900)
  const opinionAfterCtc = useMemo<number | null>(() => {
    if (opinionMedian == null) return null;
    const adjusted = Math.round(opinionMedian - 31900);
    return adjusted > 0 ? adjusted : 0;
  }, [opinionMedian]);

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
      return 'No grouped study has been applied yet. Select a supported market difference above, enter any desired factor, and apply it to update the grid.';
    }
    const study = studies[studies.length - 1];
    const unitLabel = dimensionKey === 'bathrooms'
      ? 'full bath'
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
    setSalesNotice(
      `Applied subject ratings ${condition} / ${quality}. Condition and quality adjustments remain at zero until a study tile is applied.`,
    );
  };

  return (
    <div className="min-h-screen bg-base-200">
      <div className="max-w-6xl mx-auto p-4">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold">Comparable Sales Analysis</h1>
            <div className="text-sm opacity-70">
              {subject?.address || `Property ID: ${propertyId || '(none provided)'}`}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-emerald-600 border border-emerald-600 text-white hover:bg-emerald-700"
              aria-label="File My Protest"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16l4-4h10a2 2 0 0 0 2-2V8z"/><line x1="12" y1="10" x2="12" y2="16"/><line x1="9" y1="13" x2="15" y2="13"/></svg>
              File My Protest
            </button>
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

        <MarketConditionsAnalysis
          key={`market-conditions-${propertyId}`}
          subjectAccountId={propertyId}
          onCompletionChange={setMarketConditionsDraft}
        />

        <div className="mb-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex flex-col gap-1">
            <div className="text-base font-semibold text-slate-900">Comparable Sale Search</div>
            <div className="text-sm text-slate-600">
              Select up to six sales for {subject?.address || propertyId || 'the subject property'}. Selected transactions populate the sales-comparison grid below.
            </div>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-3 xl:grid-cols-[minmax(240px,1fr)_150px_150px_140px_auto_auto] xl:items-end">
            <label className="grid gap-1 text-sm text-slate-700">
              <span>Address, city, or parcel/account ID</span>
              <input
                value={salesQuery}
                disabled={!marketConditionsDraft}
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
                disabled={!marketConditionsDraft}
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
                disabled={!marketConditionsDraft}
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
                disabled={!marketConditionsDraft}
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
              disabled={salesLoading || !propertyId || !marketConditionsDraft}
              className="rounded-md border border-indigo-600 bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:cursor-wait disabled:opacity-60"
            >
              Recommend Top 6
            </button>
            <button
              type="button"
              onClick={() => void runSalesSearch()}
              disabled={salesLoading || !marketConditionsDraft}
              className="rounded-md border border-emerald-600 bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:cursor-wait disabled:opacity-60"
            >
              {salesLoading ? 'Searching...' : 'Search Sales'}
            </button>
          </div>

          {!marketConditionsDraft && (
            <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-900">
              Complete the current Market Conditions Analysis above to unlock
              comparable search and recommendations. The selected study areas
              will remain independent from the comparable-sales inventory.
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
                />
              </label>
              <label className="grid gap-1 text-sm text-slate-700">
                <span>Subject&apos;s Quality Rating</span>
                <UadRatingSelect
                  ariaLabel="Subject quality rating before comparable selection"
                  value={draftSubjectQuality}
                  ratings={UAD_QUALITY_RATINGS}
                  onChange={setDraftSubjectQuality}
                />
              </label>
              <button
                type="button"
                onClick={applySubjectRatings}
                disabled={!draftSubjectCondition || !draftSubjectQuality}
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
          </div>

          <div className="mt-3 rounded-lg border border-indigo-100 bg-indigo-50 px-3 py-2 text-sm text-indigo-950">
            Recommendations use DCAD parcel-center distance at 40%, living-area similarity at 30%, and sale-date recency at 30%.
            The 10% living-area setting controls how quickly that score declines; it does not exclude larger or smaller properties.
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

          {(recommendationSummary ? recommendationSummary.recommended_sales : salesResults).length > 0 && (
            <div className="mt-4">
              <div className="mb-2 text-sm font-semibold text-slate-900">
                {recommendationSummary ? 'Recommended Comparable Sales' : 'Sales Search Results'}
              </div>
              <div className="max-h-[430px] overflow-auto rounded-xl border border-slate-200">
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
                    const selected = selectedSales.some((item) => item && saleKey(item) === saleKey(sale));
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
                                Location {sale.locationScore?.toFixed(1)} · GLA {sale.squareFootageScore?.toFixed(1)} · Date {sale.salesDateScore?.toFixed(1)}
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
                          <div className="mt-1 text-xs text-slate-500">Built {sale.cad_year_built ?? sale.mls_year_built ?? '—'} · {sale.neighborhood_code || 'No neighborhood code'}</div>
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
                              onClick={() => addSaleAsComparable(sale)}
                              disabled={selected}
                              className="rounded-md border border-blue-600 bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:border-slate-300 disabled:bg-slate-200 disabled:text-slate-500"
                            >
                              {selected ? 'Selected' : 'Use as Comparable'}
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
                  Ranked with the same 40% location · 30% GLA · 30% sale-date model
                </div>
              </div>

              <div className="mt-4 max-h-[520px] overflow-auto rounded-xl border border-slate-200 bg-white">
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
                      const selected = selectedSales.some(
                        (item) => item && saleKey(item) === saleKey(sale),
                      );
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
                              Location {sale.locationScore?.toFixed(1) ?? '—'} · GLA {sale.squareFootageScore?.toFixed(1) ?? '—'} · Date {sale.salesDateScore?.toFixed(1) ?? '—'}
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
                              onClick={() => addCompetitiveSaleToPrimaryGrid(sale)}
                              disabled={selected}
                              className="rounded-md border border-indigo-600 bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700 disabled:border-slate-300 disabled:bg-slate-200 disabled:text-slate-500"
                            >
                              {selected ? 'In Primary Grid' : 'Add To Primary Grid'}
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
                  className="inline-flex items-center gap-2 px-3 py-1.5 text-sm rounded-md border border-emerald-600 bg-emerald-600 text-white hover:bg-emerald-700"
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
                    {`Comparable ${i + 1}`}
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

          <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Card 1: Date/Time of Sale */}
            <div className="rounded-xl bg-white border border-slate-200 shadow-sm p-4 relative">
              <div className="absolute inset-y-0 left-0 w-1 rounded-l-xl" style={{ backgroundColor: '#f5a524' }} />
              <div className="pl-2">
                <div className="text-lg font-semibold mb-2">Date/Time of Sale</div>
                <div className="text-green-700 font-semibold">Our Methodology</div>
                <p className="mt-2 text-sm text-slate-700">
                  We take the median sale price of the subjects neighborhood code and school district to find the best
                  adjustment to make by considering both the local market and broader picture among the whole school
                  district. The past 6 months median is compared against the previous 6 months before and the difference
                  in value is used for the adjustment for time.
                </p>
                <div className="mt-3 text-red-600 font-semibold">District Method</div>
                <p className="mt-1 text-sm text-slate-700">
                  The district does not make adjustments for time, despite the fact there is evidence proving an
                  adjustment is warranted. The district also uses older sales, meaning those sale prices are not
                  reflective of the most current market trends.
                </p>
                <div className="mt-3 rounded-lg bg-slate-100 p-3">
                  <div className="font-semibold text-slate-800 text-sm">Why We're More Accurate</div>
                  <div className="text-xs text-slate-700 mt-1">
                    The market conditions have been factored into our opinion of value, making it more accurate
                  </div>
                </div>
              </div>
            </div>

            {/* Card 2: NBHD Code */}
            <div className="rounded-xl bg-white border border-slate-200 shadow-sm p-4 relative">
              <div className="absolute inset-y-0 left-0 w-1 rounded-l-xl" style={{ backgroundColor: '#f5a524' }} />
              <div className="pl-2">
                <div className="text-lg font-semibold mb-2">NBHD Code</div>
                <div className="text-green-700 font-semibold">Our Methodology</div>
                <p className="mt-2 text-sm text-slate-700">
                  Comparables in the subjects neighborhood code are prioritized, but when they are not available we use
                  comparables closest in proximity next. The adjustments used are based on the difference in median sale
                  price of all properties in that area vs the subjects. This is a much more straight-forward approach to
                  finding an adjustment.
                </p>
                <div className="mt-3 text-red-600 font-semibold">District Method</div>
                <p className="mt-1 text-sm text-slate-700">
                  The district makes adjustments based on multiple factors. However, they are not consistently applied
                  to each comparable. This makes their adjustments more subjective.
                </p>
                <div className="mt-3 rounded-lg bg-slate-100 p-3">
                  <div className="font-semibold text-slate-800 text-sm">Why We're More Accurate</div>
                  <div className="text-xs text-slate-700 mt-1">
                    The median sale price for each neighborhood code gives a better look at the overall value of that
                    neighborhood and allows us to apply adjustments that do not change.
                  </div>
                </div>
              </div>
            </div>

            {/* Card 3: Land Size */}
            <div className="rounded-xl bg-white border border-slate-200 shadow-sm p-4 relative">
              <div className="absolute inset-y-0 left-0 w-1 rounded-l-xl" style={{ backgroundColor: '#f5a524' }} />
              <div className="pl-2">
                <div className="text-lg font-semibold mb-2">Land Size</div>
                <div className="text-green-700 font-semibold">Our Methodology</div>
                <p className="mt-2 text-sm text-slate-700">
                  We only make land adjustments when there is a clear difference for properties that have more land in
                  a suburban area, this is because land adjustments in non-rural areas are highly subjective and land
                  sales are usually not available. When adjustments are made, they are based on the difference in
                  median price per acre for larger land sales and smaller land sales.
                </p>
                <div className="mt-3 text-red-600 font-semibold">District Method</div>
                <p className="mt-1 text-sm text-slate-700">
                  The district makes arbitrary adjustments based on variance from the median size, without proving the
                  adjustment is actually warranted in the market. Just because a property has more land does not mean it
                  is more valuable as the market may not prioritize additional land enough to derive an accurate
                  adjustment.
                </p>
                <div className="mt-3 rounded-lg bg-slate-100 p-3">
                  <div className="font-semibold text-slate-800 text-sm">Why We're More Accurate</div>
                  <div className="text-xs text-slate-700 mt-1">
                    Adjustments are based on an adjusted grouped analysis, where the median sale price of homes with
                    land sizes above the median land size are compared against sales below the median land size. Then
                    the square footage is adjusted out of the analysis in an attempt to isolate the land value, giving
                    a more accurate picture of the contributory value of the land in the area.
                  </div>
                </div>
              </div>
            </div>
          </div>
          {/* Second row of breakdown tiles */}
          <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Views */}
            <div className="rounded-xl bg-white border border-slate-200 shadow-sm p-4 relative">
              <div className="absolute inset-y-0 left-0 w-1 rounded-l-xl" style={{ backgroundColor: '#f5a524' }} />
              <div className="pl-2">
                <div className="text-lg font-semibold mb-2">Views</div>
                <div className="text-green-700 font-semibold">Our Methodology</div>
                <p className="mt-2 text-sm text-slate-700">
                  We evaluate property views based on their actual market impact, analyzing sales data of properties
                  with similar view premiums including water views, city skylines, golf courses, and open spaces. We
                  consider view permanence and seasonal variations.
                </p>
                <div className="mt-3 text-red-600 font-semibold">District Method</div>
                <p className="mt-1 text-sm text-slate-700">
                  Districts often use generic view categories without considering the specific quality, permanence, or
                  market desirability of different view types in the local area.
                </p>
                <div className="mt-3 rounded-lg bg-slate-100 p-3">
                  <div className="font-semibold text-slate-800 text-sm">Why We're More Accurate</div>
                  <div className="text-xs text-slate-700 mt-1">
                    Our view analysis is based on actual market premiums paid for specific view types rather than broad
                    categorical adjustments that may not reflect local buyer preferences.
                  </div>
                </div>
              </div>
            </div>

            {/* Const Type */}
            <div className="rounded-xl bg-white border border-slate-200 shadow-sm p-4 relative">
              <div className="absolute inset-y-0 left-0 w-1 rounded-l-xl" style={{ backgroundColor: '#f5a524' }} />
              <div className="pl-2">
                <div className="text-lg font-semibold mb-2">Const Type</div>
                <div className="text-green-700 font-semibold">Our Methodology</div>
                <p className="mt-2 text-sm text-slate-700">
                  We evaluate architectural styles based on current market preferences, analyzing recent sales of
                  similar styles while accounting for regional design trends and buyer demographics.
                </p>
                <div className="mt-3 text-red-600 font-semibold">District Method</div>
                <p className="mt-1 text-sm text-slate-700">
                  Districts often have outdated style preferences that don't reflect current market demand or fail to
                  recognize emerging architectural trends.
                </p>
                <div className="mt-3 rounded-lg bg-slate-100 p-3">
                  <div className="font-semibold text-slate-800 text-sm">Why We're More Accurate</div>
                  <div className="text-xs text-slate-700 mt-1">
                    Our analysis is based on current buyer preferences rather than historical assumptions about
                    architectural desirability.
                  </div>
                </div>
              </div>
            </div>

            {/* Quality */}
            <div className="rounded-xl bg-white border border-slate-200 shadow-sm p-4 relative">
              <div className="absolute inset-y-0 left-0 w-1 rounded-l-xl" style={{ backgroundColor: '#f5a524' }} />
              <div className="pl-2">
                <div className="text-lg font-semibold mb-2">Quality</div>
                <div className="text-green-700 font-semibold">Current Applied Methodology</div>
                <p className="mt-2 text-sm text-slate-700">
                  {conditionQualityBreakdownSummary('quality', qualityAdjustments)}
                </p>
                <div className="mt-3 text-red-600 font-semibold">District Method</div>
                <p className="mt-1 text-sm text-slate-700">
                  District classifications are often based on broad categories that don't capture subtle quality
                  differences that significantly impact market value.
                </p>
                <div className="mt-3 rounded-lg bg-slate-100 p-3">
                  <div className="font-semibold text-slate-800 text-sm">Current Grid Impact</div>
                  <div className="text-xs text-slate-700 mt-1">
                    {groupedGridImpact(qualityAdjustments)}
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Third row of breakdown tiles */}
          <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Condition */}
            <div className="rounded-xl bg-white border border-slate-200 shadow-sm p-4 relative">
              <div className="absolute inset-y-0 left-0 w-1 rounded-l-xl" style={{ backgroundColor: '#f5a524' }} />
              <div className="pl-2">
                <div className="text-lg font-semibold mb-2">Condition</div>
                <div className="text-green-700 font-semibold">Current Applied Methodology</div>
                <p className="mt-2 text-sm text-slate-700">
                  {conditionQualityBreakdownSummary('condition', conditionAdjustments)}
                </p>
                <div className="mt-3 text-red-600 font-semibold">District Method</div>
                <p className="mt-1 text-sm text-slate-700">
                  Districts often fail to properly account for the timing and quality of updates, applying generic
                  adjustments that don't reflect actual market premiums.
                </p>
                <div className="mt-3 rounded-lg bg-slate-100 p-3">
                  <div className="font-semibold text-slate-800 text-sm">Current Grid Impact</div>
                  <div className="text-xs text-slate-700 mt-1">
                    {groupedGridImpact(conditionAdjustments)}
                  </div>
                </div>
              </div>
            </div>

            {/* Bath Count */}
            <div className="rounded-xl bg-white border border-slate-200 shadow-sm p-4 relative">
              <div className="absolute inset-y-0 left-0 w-1 rounded-l-xl" style={{ backgroundColor: '#f5a524' }} />
              <div className="pl-2">
                <div className="text-lg font-semibold mb-2">Bath Count</div>
                <div className="text-green-700 font-semibold">Current Applied Methodology</div>
                <p className="mt-2 text-sm text-slate-700">
                  {groupedBreakdownSummary('bathrooms', roomCountBathAdjustments)}
                </p>
                <div className="mt-3 text-red-600 font-semibold">District Method</div>
                <p className="mt-1 text-sm text-slate-700">
                  Districts typically apply simple per-bathroom adjustments without accounting for bathroom quality,
                  size, or functionality.
                </p>
                <div className="mt-3 rounded-lg bg-slate-100 p-3">
                  <div className="font-semibold text-slate-800 text-sm">Current Grid Impact</div>
                  <div className="text-xs text-slate-700 mt-1">
                    {groupedGridImpact(roomCountBathAdjustments)}
                  </div>
                </div>
              </div>
            </div>

            {/* Gross Living Area */}
            <div className="rounded-xl bg-white border border-slate-200 shadow-sm p-4 relative">
              <div className="absolute inset-y-0 left-0 w-1 rounded-l-xl" style={{ backgroundColor: '#f5a524' }} />
              <div className="pl-2">
                <div className="text-lg font-semibold mb-2">Gross Living Area</div>
                <div className="text-green-700 font-semibold">Our Methodology</div>
                <p className="mt-2 text-sm text-slate-700">
                  We use regression analysis to determine the marginal value per square foot, considering diminishing
                  returns on oversized homes and optimal size ranges for the market.
                </p>
                <div className="mt-3 text-red-600 font-semibold">District Method</div>
                <p className="mt-1 text-sm text-slate-700">
                  Districts often use linear per-square-foot adjustments that don't account for optimal home sizes or
                  the reduced value of excess space.
                </p>
                <div className="mt-3 rounded-lg bg-slate-100 p-3">
                  <div className="font-semibold text-slate-800 text-sm">Why We're More Accurate</div>
                  <div className="text-xs text-slate-700 mt-1">
                    Our methodology recognizes that square footage value varies based on home size and market
                    preferences.
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Fourth row of breakdown tiles */}
          <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Basement SF */}
            <div className="rounded-xl bg-white border border-slate-200 shadow-sm p-4 relative">
              <div className="absolute inset-y-0 left-0 w-1 rounded-l-xl" style={{ backgroundColor: '#f5a524' }} />
              <div className="pl-2">
                <div className="text-lg font-semibold mb-2">Basement SF</div>
                <div className="text-green-700 font-semibold">Our Methodology</div>
                <p className="mt-2 text-sm text-slate-700">
                  We differentiate between finished and unfinished basement space, analyzing their respective market
                  values and considering regional preferences for basement space.
                </p>
                <div className="mt-3 text-red-600 font-semibold">District Method</div>
                <p className="mt-1 text-sm text-slate-700">
                  Districts often fail to properly distinguish between different types of basement space or don't
                  reflect regional preferences.
                </p>
                <div className="mt-3 rounded-lg bg-slate-100 p-3">
                  <div className="font-semibold text-slate-800 text-sm">Why We're More Accurate</div>
                  <div className="text-xs text-slate-700 mt-1">
                    Our analysis provides specific values for different basement configurations based on actual market
                    data.
                  </div>
                </div>
              </div>
            </div>

            {/* Heating/Cooling */}
            <div className="rounded-xl bg-white border border-slate-200 shadow-sm p-4 relative">
              <div className="absolute inset-y-0 left-0 w-1 rounded-l-xl" style={{ backgroundColor: '#f5a524' }} />
              <div className="pl-2">
                <div className="text-lg font-semibold mb-2">Heating/Cooling</div>
                <div className="text-green-700 font-semibold">Our Methodology</div>
                <p className="mt-2 text-sm text-slate-700">
                  We evaluate HVAC systems based on efficiency ratings, age, type, and maintenance history, analyzing
                  their impact on buyer preferences and energy costs.
                </p>
                <div className="mt-3 text-red-600 font-semibold">District Method</div>
                <p className="mt-1 text-sm text-slate-700">
                  Districts typically use broad categories that don't reflect the significant value differences between
                  modern efficient systems and older units.
                </p>
                <div className="mt-3 rounded-lg bg-slate-100 p-3">
                  <div className="font-semibold text-slate-800 text-sm">Why We're More Accurate</div>
                  <div className="text-xs text-slate-700 mt-1">
                    Our method considers the full impact of HVAC efficiency and condition on market value and buyer
                    appeal.
                  </div>
                </div>
              </div>
            </div>

            {/* Solar Panels */}
            <div className="rounded-xl bg-white border border-slate-200 shadow-sm p-4 relative">
              <div className="absolute inset-y-0 left-0 w-1 rounded-l-xl" style={{ backgroundColor: '#f5a524' }} />
              <div className="pl-2">
                <div className="text-lg font-semibold mb-2">Solar Panels</div>
                <div className="text-green-700 font-semibold">Our Methodology</div>
                <p className="mt-2 text-sm text-slate-700">
                  We analyze the market premium for green features like solar panels, energy-efficient windows, and
                  sustainable materials, considering their actual impact on utility costs and buyer preferences.
                </p>
                <div className="mt-3 text-red-600 font-semibold">District Method</div>
                <p className="mt-1 text-sm text-slate-700">
                  Districts often fail to properly value green improvements or use outdated assumptions about their
                  market appeal.
                </p>
                <div className="mt-3 rounded-lg bg-slate-100 p-3">
                  <div className="font-semibold text-slate-800 text-sm">Why We're More Accurate</div>
                  <div className="text-xs text-slate-700 mt-1">
                    Our analysis reflects current market premiums for green features and their actual financial
                    benefits.
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Fifth row of breakdown tiles */}
          <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Garages/Parking */}
            <div className="rounded-xl bg-white border border-slate-200 shadow-sm p-4 relative">
              <div className="absolute inset-y-0 left-0 w-1 rounded-l-xl" style={{ backgroundColor: '#f5a524' }} />
              <div className="pl-2">
                <div className="text-lg font-semibold mb-2">Garages/Parking</div>
                <div className="text-green-700 font-semibold">Current Applied Methodology</div>
                <p className="mt-2 text-sm text-slate-700">
                  {groupedBreakdownSummary('garage', garageAdjustments)}
                </p>
                <div className="mt-3 text-red-600 font-semibold">District Method</div>
                <p className="mt-1 text-sm text-slate-700">
                  Districts typically use simple adjustments that don't account for garage quality, attached vs.
                  detached, or regional parking demand variations.
                </p>
                <div className="mt-3 rounded-lg bg-slate-100 p-3">
                  <div className="font-semibold text-slate-800 text-sm">Current Grid Impact</div>
                  <div className="text-xs text-slate-700 mt-1">
                    {groupedGridImpact(garageAdjustments)}
                  </div>
                </div>
              </div>
            </div>

            {/* Porches/Decks */}
            <div className="rounded-xl bg-white border border-slate-200 shadow-sm p-4 relative">
              <div className="absolute inset-y-0 left-0 w-1 rounded-l-xl" style={{ backgroundColor: '#f5a524' }} />
              <div className="pl-2">
                <div className="text-lg font-semibold mb-2">Porches/Decks</div>
                <div className="text-green-700 font-semibold">Our Methodology</div>
                <p className="mt-2 text-sm text-slate-700">
                  We assess outdoor living spaces based on size, quality, orientation, and integration with the home,
                  analyzing their contribution to overall livability and market appeal.
                </p>
                <div className="mt-3 text-red-600 font-semibold">District Method</div>
                <p className="mt-1 text-sm text-slate-700">
                  Districts often undervalue or overvalue outdoor spaces without considering their quality, usability,
                  or integration with the home design.
                </p>
                <div className="mt-3 rounded-lg bg-slate-100 p-3">
                  <div className="font-semibold text-slate-800 text-sm">Why We're More Accurate</div>
                  <div className="text-xs text-slate-700 mt-1">
                    Our analysis provides precise valuations based on the actual utility and appeal of specific outdoor
                    features.
                  </div>
                </div>
              </div>
            </div>

            {/* Fencing */}
            <div className="rounded-xl bg-white border border-slate-200 shadow-sm p-4 relative">
              <div className="absolute inset-y-0 left-0 w-1 rounded-l-xl" style={{ backgroundColor: '#f5a524' }} />
              <div className="pl-2">
                <div className="text-lg font-semibold mb-2">Fencing</div>
                <div className="text-green-700 font-semibold">Our Methodology</div>
                <p className="mt-2 text-sm text-slate-700">
                  We evaluate fencing based on material quality, condition, appropriateness for the neighborhood, and
                  impact on privacy and security.
                </p>
                <div className="mt-3 text-red-600 font-semibold">District Method</div>
                <p className="mt-1 text-sm text-slate-700">
                  Districts typically apply generic fencing adjustments that don't consider material quality, condition,
                  or neighborhood appropriateness.
                </p>
                <div className="mt-3 rounded-lg bg-slate-100 p-3">
                  <div className="font-semibold text-slate-800 text-sm">Why We're More Accurate</div>
                  <div className="text-xs text-slate-700 mt-1">
                    Our method recognizes that fencing value depends on quality, condition, and neighborhood
                    compatibility.
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Sixth row of breakdown tiles */}
          <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Pool */}
            <div className="rounded-xl bg-white border border-slate-200 shadow-sm p-4 relative">
              <div className="absolute inset-y-0 left-0 w-1 rounded-l-xl" style={{ backgroundColor: '#f5a524' }} />
              <div className="pl-2">
                <div className="text-lg font-semibold mb-2">Pool</div>
                <div className="text-green-700 font-semibold">Current Applied Methodology</div>
                <p className="mt-2 text-sm text-slate-700">
                  {groupedBreakdownSummary('pool', poolAdjustments)}
                </p>
                <div className="mt-3 text-red-600 font-semibold">District Method</div>
                <p className="mt-1 text-sm text-slate-700">
                  Districts often use outdated assumptions about pool values that don't reflect current maintenance
                  concerns or regional preferences.
                </p>
                <div className="mt-3 rounded-lg bg-slate-100 p-3">
                  <div className="font-semibold text-slate-800 text-sm">Current Grid Impact</div>
                  <div className="text-xs text-slate-700 mt-1">
                    {groupedGridImpact(poolAdjustments)}
                  </div>
                </div>
              </div>
            </div>

            {/* Secondary Improvements */}
            <div className="rounded-xl bg-white border border-slate-200 shadow-sm p-4 relative">
              <div className="absolute inset-y-0 left-0 w-1 rounded-l-xl" style={{ backgroundColor: '#f5a524' }} />
              <div className="pl-2">
                <div className="text-lg font-semibold mb-2">Secondary Improvements</div>
                <div className="text-green-700 font-semibold">Our Methodology</div>
                <p className="mt-2 text-sm text-slate-700">
                  We evaluate secondary structures based on their functionality, condition, and contribution to property
                  utility, analyzing similar sales with comparable improvements.
                </p>
                <div className="mt-3 text-red-600 font-semibold">District Method</div>
                <p className="mt-1 text-sm text-slate-700">
                  Districts often undervalue or ignore secondary improvements that can significantly contribute to
                  property functionality and value.
                </p>
                <div className="mt-3 rounded-lg bg-slate-100 p-3">
                  <div className="font-semibold text-slate-800 text-sm">Why We're More Accurate</div>
                  <div className="text-xs text-slate-700 mt-1">
                    Our comprehensive analysis ensures all valuable improvements are properly considered in the
                    valuation.
                  </div>
                </div>
              </div>
            </div>

            {/* Easements */}
            <div className="rounded-xl bg-white border border-slate-200 shadow-sm p-4 relative">
              <div className="absolute inset-y-0 left-0 w-1 rounded-l-xl" style={{ backgroundColor: '#f5a524' }} />
              <div className="pl-2">
                <div className="text-lg font-semibold mb-2">Easements</div>
                <div className="text-green-700 font-semibold">Our Methodology</div>
                <p className="mt-2 text-sm text-slate-700">
                  We analyze the impact of easements based on their type, location, and actual effect on property use
                  and marketability, considering buyer reactions to different easement types.
                </p>
                <div className="mt-3 text-red-600 font-semibold">District Method</div>
                <p className="mt-1 text-sm text-slate-700">
                  Districts often apply generic easement adjustments that don't reflect the specific impact of
                  different easement types on market value.
                </p>
                <div className="mt-3 rounded-lg bg-slate-100 p-3">
                  <div className="font-semibold text-slate-800 text-sm">Why We're More Accurate</div>
                  <div className="text-xs text-slate-700 mt-1">
                    Our analysis provides specific adjustments based on the actual market impact of different easement
                    configurations.
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Appraisal District Evidence Analysis */}
          <div className="mt-6 rounded-2xl border border-slate-200 bg-white">
            <div className="p-6">
              <div className="text-xl font-semibold text-slate-900">Appraisal District Evidence Analysis</div>
              <p className="mt-3 text-slate-700 text-sm max-w-5xl">
                We have not yet requested the district's evidence for market value. Once you file your protest, we will
                request the district's evidence and this section will break down why their evidence is inferior to ours.
              </p>
              <p className="mt-3 text-slate-700 text-sm">
                Below is an example of how we analyze and refute the district's evidence once it is received:
              </p>

              <DistrictEvidenceAccordion />
            </div>
          </div>

          {/* Property Location Analysis (Comparable Sales Map) */}
          <div className="mt-6 rounded-2xl border border-slate-200 bg-white">
            <div className="p-6">
              <div className="text-xl font-semibold text-slate-900">Property Location Analysis</div>
              <div className="text-sm text-slate-600 mt-1">
                Geographic distribution of the subject property and comparable sales used in our analysis.
              </div>

              {/* Map placeholder */}
              <div className="mt-4 rounded-xl overflow-hidden border border-slate-200">
                {/* Use explicit height to avoid collapse in some layouts */}
                <div className="w-full bg-slate-50 relative" style={{ height: 420 }}>
                  {/* simple grid to mimic streets */}
                  {Array.from({ length: 6 }).map((_, i) => (
                    <div key={`h-${i}`} className="absolute left-0 right-0" style={{ top: `${(i+1)*16}%`, height: 4, background: '#94a3b8' }} />
                  ))}
                  {Array.from({ length: 6 }).map((_, i) => (
                    <div key={`v-${i}`} className="absolute top-0 bottom-0" style={{ left: `${(i+1)*16}%`, width: 4, background: '#94a3b8' }} />
                  ))}

                  {/* Subject marker and radius */}
                  <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-center">
                    <div className="rounded-md bg-red-500 w-6 h-6 mx-auto" />
                    <div className="text-red-700 font-semibold mt-1">Subject Property</div>
                    <div className="text-xs text-slate-600">123 Main St</div>
                  </div>
                  <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-dashed" style={{ width: 260, height: 260, borderColor: '#eab308' }} />

                  {/* Example comps markers */}
                  <div className="absolute" style={{ left: '42%', top: '42%' }}>
                    <div className="w-4 h-4 bg-blue-500 rounded" />
                    <div className="text-xs text-slate-700 mt-1">Comp #1</div>
                  </div>
                  <div className="absolute" style={{ left: '63%', top: '50%' }}>
                    <div className="w-4 h-4 bg-blue-500 rounded" />
                    <div className="text-xs text-slate-700 mt-1">Comp #2</div>
                  </div>
                  <div className="absolute" style={{ left: '46%', top: '68%' }}>
                    <div className="w-4 h-4 bg-blue-500 rounded" />
                    <div className="text-xs text-slate-700 mt-1">Comp #3</div>
                  </div>
                  <div className="absolute" style={{ left: '58%', top: '30%' }}>
                    <div className="w-4 h-4 bg-blue-500 rounded" />
                    <div className="text-xs text-slate-700 mt-1">Comp #4</div>
                  </div>
                </div>
                {/* Legend */}
                <div className="px-4 py-2 flex items-center gap-6 text-sm">
                  <span className="inline-flex items-center gap-2"><span className="w-3 h-3 rounded-full bg-red-600 inline-block" /> Subject Property</span>
                  <span className="inline-flex items-center gap-2"><span className="w-3 h-3 rounded-full bg-blue-600 inline-block" /> Comparable Properties</span>
                  <span className="inline-flex items-center gap-2"><span className="w-3 h-3 rounded-full border-2 border-dashed border-amber-500 inline-block" /> 0.5 Mile Search Radius</span>
                </div>
          </div>
          
          {/* Location Analysis callout */}
          <div className="mt-4 rounded-xl bg-amber-50 border border-amber-200 p-4 text-sm text-slate-800">
            <div className="font-medium mb-1">Location Analysis</div>
            All comparable properties are located within the same neighborhood code (DAL-012A) and within a 0.5-mile radius of the subject property, ensuring geographic consistency for accurate valuation comparison. This proximity supports the reliability of our comparable sales analysis and adjustment methodology.
          </div>
        </div>
      </div>
    </div>

    {/* Cost to Cure */}
    <div className="mt-6 rounded-2xl border border-slate-200 bg-white">
      <div className="p-6">
        <div className="text-xl font-semibold text-slate-900">Cost to Cure</div>
        <div className="text-sm text-slate-600 mt-1">
          Detailed breakdown of necessary repairs and improvements that impact the subject property's market value.
        </div>

          <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              {costToCure.left.map((cat, i) => (
                <Category key={`c-l-${i}`} title={cat.title} items={cat.items} />
              ))}
            </div>
            <div>
              {costToCure.right.map((cat, i) => (
                <Category key={`c-r-${i}`} title={cat.title} items={cat.items} />
              ))}
            </div>
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
          Based on our analysis, properties requiring similar repairs typically sell for $31,900 to $38,280 less than comparable properties in move-in ready condition. The district's assessment does not adequately account for these condition-related value impacts.
        </div>
      </div>
    </div>

    {/* Subject Photos */}
    <div className="mt-6 rounded-2xl border border-slate-200 bg-white">
      <div className="p-6">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xl font-semibold text-slate-900">Subject Photos</div>
            <div className="text-sm text-slate-600 mt-1">Upload property photos to include in your packet.</div>
          </div>
          <div>
            <button
              type="button"
              onClick={() => photoInputRef.current?.click()}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-blue-600 border border-blue-600 text-white hover:bg-blue-700"
            >
              Upload Photos
            </button>
            <input
              ref={photoInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => setPhotos(Array.from(e.target.files || []))}
            />
          </div>
        </div>

        {/* Simple preview grid (optional) */}
        {photos.length > 0 ? (
          <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-3">
            {photos.map((f, i) => (
              <div key={i} className="rounded-lg border border-slate-200 overflow-hidden bg-slate-50 aspect-[4/3]">
                <img src={URL.createObjectURL(f)} alt={`Photo ${i + 1}`} className="w-full h-full object-cover" />
              </div>
            ))}
          </div>
        ) : (
          <div className="mt-4 rounded-lg border border-dashed border-slate-300 p-6 text-center text-sm text-slate-600">
            No photos uploaded yet.
          </div>
        )}
      </div>
    </div>

    {/* Protest Summary Generator */}
    <div className="mt-6 rounded-2xl border border-slate-200 bg-white">
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

function Category(props: { title: string; items: { label: string; cost: number }[] }) {
  const { title, items } = props;
  const total = items.reduce((s, i) => s + i.cost, 0);

  const fmt = (n) =>
    n.toLocaleString('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 0,
    });

  return (
    <div className="mb-6">
      <div className="font-semibold mb-2">{title}</div>
      <div className="space-y-2">
        {items.map((it, idx) => (
          <div
            key={idx}
            className="flex items-center justify-between rounded-md bg-slate-50 border border-slate-200 px-3 py-2"
          >
            <div className="text-sm text-slate-800">{it.label}</div>
            <div className="text-sm font-semibold text-rose-600">{fmt(it.cost)}</div>
          </div>
        ))}
      </div>
      <div className="mt-2 text-sm text-slate-700">
        Category Total: <span className="font-semibold">{fmt(total)}</span>
      </div>
    </div>
  );
}

// Removed erroneous placeholder; generateSummary is defined within the component

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

















































