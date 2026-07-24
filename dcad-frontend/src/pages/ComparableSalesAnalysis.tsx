import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useEffect, useMemo, useState, useRef } from 'react';
import * as api from '@/lib/api';
import type { ComparableRecommendationsResponse, SalePhoto, SaleRow } from '@/lib/api';
import { fetchDetail } from '@/lib/dcad';
import { formatBathCount, parseWholeCount } from '@/lib/propertyCharacteristics';

const COMPARABLE_COUNT = 6;

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

  const size = compact ? 'h-16 w-24' : 'h-28 w-full min-w-[8rem]';
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

export default function ComparableSalesAnalysis() {
  const location = useLocation();
  const navigate = useNavigate();
  const propertyId = useMemo(() => {
    const p = new URLSearchParams(location.search);
    return p.get('propertyId') || '';
  }, [location.search]);
  // CONDITION_CODE_INTAKE: read condCode from query (set by PropertyReport Sample Evidence link) and used in Condition/Updating rows
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
  const [compAddresses, setCompAddresses] = useState<string[]>(() => Array(COMPARABLE_COUNT).fill(''));
  const [compGla, setCompGla] = useState<Array<number | null>>(() => Array(COMPARABLE_COUNT).fill(null));
  const [compPrices, setCompPrices] = useState<Array<number | null>>(() => Array(COMPARABLE_COUNT).fill(null));
  const [compConcessions, setCompConcessions] = useState<Array<number | null>>(() => Array(COMPARABLE_COUNT).fill(null));
  // Date of Sale/Time adjustments per comparable (can be positive or negative)
  const [compTimeAdjustments, setCompTimeAdjustments] = useState<Array<number | null>>(() => Array(COMPARABLE_COUNT).fill(null));
  const [compSaleDates, setCompSaleDates] = useState<string[]>(() => Array(COMPARABLE_COUNT).fill(''));
  const [compLandSize, setCompLandSize] = useState<Array<number | null>>(() => Array(COMPARABLE_COUNT).fill(null));
  const [compClasses, setCompClasses] = useState<Array<number | string | null>>(() => Array(COMPARABLE_COUNT).fill(null));
  // Test-mode comparable ages for the "Actual Age" row
  const [compAges, setCompAges] = useState<Array<number | null>>(() => Array(COMPARABLE_COUNT).fill(null));
  // Test-mode comparable garage areas
  const [compGarage, setCompGarage] = useState<Array<number | null>>(() => Array(COMPARABLE_COUNT).fill(null));
  const [compRooms, setCompRooms] = useState<Array<{ tot: number | null; bd: number | null; full: number | null; half: number | null }>>(
    () => Array.from({ length: COMPARABLE_COUNT }, () => ({ tot: null, bd: null, full: null, half: null })),
  );
  const [salesQuery, setSalesQuery] = useState('');
  const [salesDateFrom, setSalesDateFrom] = useState('');
  const [salesDateTo, setSalesDateTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [includeUnmatchedSales, setIncludeUnmatchedSales] = useState(false);
  const [sameNeighborhoodOnly, setSameNeighborhoodOnly] = useState(false);
  const [salesResults, setSalesResults] = useState<SaleRow[]>([]);
  const [selectedSales, setSelectedSales] = useState<Array<SaleRow | null>>(
    () => Array(COMPARABLE_COUNT).fill(null),
  );
  const [salesLoading, setSalesLoading] = useState(false);
  const [salesError, setSalesError] = useState<string | null>(null);
  const [salesNotice, setSalesNotice] = useState<string | null>(null);
  const [recommendationSummary, setRecommendationSummary] = useState<ComparableRecommendationsResponse | null>(null);
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

  const parseSqftNum = (v: unknown): number | null => {
    if (v === null || v === undefined || v === '') return null;
    const n = typeof v === 'string' ? Number(String(v).replace(/[^0-9.-]/g, '')) : Number(v);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
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
  const onClickTest = () => {
    setCompAddresses(['123 Main St', '456 Edge Dr', '789 Third St', '1012 Oak Rd', '1415 Pine St', '1617 Cedar Ln']);
    const subj = parseSqftNum(subject?.total_living_area);
    if (subj && subj > 0) {
      const v1 = Math.round(subj * 0.95);
      const v2 = Math.round(subj * 1.05);
      const v3 = Math.round(subj * 1.0);
      const v4 = Math.round(subj * 1.02);
      const v5 = Math.round(subj * 0.97);
      const v6 = Math.round(subj * 1.03);
      setCompGla([v1, v2, v3, v4, v5, v6]);
    } else {
      setCompGla(Array(COMPARABLE_COUNT).fill(null));
    }

    // Compute comparable sale prices from subject market value
    const parseMoneyNum = (v: unknown): number | null => {
      if (v === null || v === undefined || v === '') return null;
      const n = typeof v === 'string' ? Number(String(v).replace(/[^0-9.-]/g, '')) : Number(v);
      return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
    };
    const subjVal = parseMoneyNum(subject?.market_value);
    if (subjVal && subjVal > 0) {
      const p1 = Math.round(subjVal * 0.98); // comp 1: -2%
      const p2 = Math.round(subjVal * 1.02); // comp 2: +2%
      const p3 = Math.round(subjVal * 1.03); // comp 3: +3%
      const p4 = Math.round(subjVal * 0.99); // comp 4: -1%
      const p5 = Math.round(subjVal * 1.01); // comp 5: +1%
      const p6 = Math.round(subjVal * 0.97); // comp 6: -3%
      setCompPrices([p1, p2, p3, p4, p5, p6]);
    } else {
      setCompPrices(Array(COMPARABLE_COUNT).fill(null));
    }

    // Fixed concessions by comparable
    setCompConcessions([5000, 5000, 0, 3000, 0, 2500]);

    // Fixed Date of Sale/Time adjustments by comparable
    setCompTimeAdjustments([-2000, 4000, -2000, -3000, 0, 1000]);

    // Fixed sale dates by comparable
    setCompSaleDates(['11/05/2025', '07/16/2025', '11/25/2025', '09/10/2025', '01/14/2026', '03/20/2026']);

    // Land size from subject +/- 2%
    const subjLand = parseSqftNum(subject?.land_size_sqft);
    if (subjLand && subjLand > 0) {
      const l1 = Math.round(subjLand * 1.02); // +2%
      const l2 = Math.round(subjLand * 0.98); // -2%
      const l3 = Math.round(subjLand * 0.98); // -2%
      const l4 = Math.round(subjLand * 1.02); // +2%
      const l5 = Math.round(subjLand);
      const l6 = Math.round(subjLand * 1.01);
      setCompLandSize([l1, l2, l3, l4, l5, l6]);
    } else {
      setCompLandSize(Array(COMPARABLE_COUNT).fill(null));
    }

    // Garage/Parking sqft adjustments per comparable (rounded up)
    const subjGarage = parseSqftNum(subject?.garage_area_sqft);
    if (subjGarage && subjGarage > 0) {
      const g1 = Math.ceil(subjGarage * 1.02); // +2%
      const g2 = Math.ceil(subjGarage * 0.98); // -2%
      const g3 = Math.ceil(subjGarage * 1.0);  // same
      const g4 = Math.ceil(subjGarage * 1.02); // +2%
      const g5 = Math.ceil(subjGarage);
      const g6 = Math.ceil(subjGarage * 0.99);
      setCompGarage([g1, g2, g3, g4, g5, g6]);
    } else {
      setCompGarage(Array(COMPARABLE_COUNT).fill(null));
    }

    // Class adjustments relative to subject building class
    const parseIntLike = (v: unknown): number | null => {
      if (v === null || v === undefined) return null;
      const n = Number(String(v).replace(/[^0-9.-]/g, ''));
      return Number.isFinite(n) ? Math.round(n) : null;
    };
    const subjClassNum = parseIntLike(subject?.building_class);
    if (subjClassNum !== null) {
      const c1 = Math.max(0, subjClassNum - 1);
      const c2 = subjClassNum + 1;
      const c3 = subjClassNum;
      const c4 = Math.max(0, subjClassNum - 1);
      const c5 = subjClassNum;
      const c6 = subjClassNum + 1;
      setCompClasses([c1, c2, c3, c4, c5, c6]);
    } else {
      // If not numeric, mirror the subject's class label for all comps
      const s = (subject?.building_class ?? '') as any;
      setCompClasses(Array(COMPARABLE_COUNT).fill(s));
    }

    // Actual Age adjustments per comparable
    // NOTE: If subject's age is 0, comps 1 and 4 should not go negative; they remain equal to subject.
    const subjAge = parseIntLike(subject?.actual_age);
    if (subjAge !== null) {
      let a1 = subjAge - 2; // comp 1: -2 years
      const a2 = subjAge + 3; // comp 2: +3 years
      const a3 = subjAge;     // comp 3: same
      let a4 = subjAge - 4; // comp 4: -4 years
      const a5 = subjAge + 1;
      const a6 = subjAge;
      if (subjAge === 0) { a1 = 0; a4 = 0; }
      a1 = Math.max(0, a1);
      a4 = Math.max(0, a4);
      setCompAges([a1, a2, a3, a4, a5, a6]);
    } else {
      setCompAges(Array(COMPARABLE_COUNT).fill(null));
    }

    // Compute comparable 1 room counts based on subject
    const tot = subjectTotalRooms as number | undefined;
    const bd = subjectBedrooms as number | undefined;
    // Prefer explicit full/half; otherwise attempt to parse from bath_count like "2.1"
    const inferFullHalf = (): { full: number; half: number } | null => {
      if (subjectBathsFull !== undefined || subjectBathsHalf !== undefined) {
        return { full: subjectBathsFull ?? 0, half: subjectBathsHalf ?? 0 };
      }
      if (subjectBathCount !== undefined) {
        const s = String(subjectBathCount);
        if (/^\d+(?:\.\d+)?$/.test(s)) {
          const parts = s.split('.');
          const f = Number(parts[0] || '0');
          const h = Number(parts[1] || '0');
          if (Number.isFinite(f) && Number.isFinite(h)) return { full: f, half: h };
        }
      }
      return null;
    };
    const fh = inferFullHalf();
    const comp1 = {
      tot: typeof tot === 'number' ? tot + 1 : null,
      bd: typeof bd === 'number' ? bd + 1 : null,
      full: fh ? Math.max(0, fh.full - 1) : null,
      half: fh ? fh.half : null,
    };
    const comp2 = {
      tot: typeof tot === 'number' ? tot : null,
      bd: typeof bd === 'number' ? bd : null,
      full: fh ? fh.full + 1 : null,
      half: fh ? fh.half : null,
    };
    const comp3 = {
      tot: typeof tot === 'number' ? Math.max(0, tot - 1) : null,
      bd: typeof bd === 'number' ? Math.max(0, bd - 1) : null,
      full: fh ? fh.full : null,
      half: fh ? Math.max(0, fh.half - 1) : null,
    };
    const comp4 = {
      tot: typeof tot === 'number' ? tot : null,
      bd: typeof bd === 'number' ? bd : null,
      full: fh ? fh.full : null,
      half: fh ? fh.half : null,
    };
    const comp5 = { ...comp4 };
    const comp6 = { ...comp2 };
    setCompRooms([comp1, comp2, comp3, comp4, comp5, comp6]);
  };
  const onClickRun = () => {
    // Equity automation remains a separate workflow from transaction selection.
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

  const saleIsOverTwoYears = (sale: SaleRow): boolean => {
    if (sale.soldOverTwoYears != null) return sale.soldOverTwoYears;
    if (!sale.closing_date) return false;
    const saleDate = new Date(`${sale.closing_date.slice(0, 10)}T12:00:00Z`);
    if (Number.isNaN(saleDate.getTime())) return false;
    const now = new Date();
    const cutoff = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
    ));
    cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 2);
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
    if (housingTypeNeedsReview(sale)) return '⚠ Review — housing type unknown';
    return sale.structural_style || sale.housing_type || 'Not available';
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

    setSelectedSales((current) => current.map((item, index) => index === slot ? sale : item));
    setCompAddresses((current) => current.map((value, index) => index === slot ? saleDisplayAddress(sale) : value));
    setCompGla((current) => current.map((value, index) => index === slot ? livingArea : value));
    setCompPrices((current) => current.map((value, index) => index === slot ? price : value));
    setCompConcessions((current) => current.map((value, index) => index === slot ? concessions : value));
    setCompTimeAdjustments((current) => current.map((value, index) => index === slot ? null : value));
    setCompSaleDates((current) => current.map((value, index) => index === slot ? saleDateDisplay(sale.closing_date) : value));
    setCompLandSize((current) => current.map((value, index) => index === slot ? landSize : value));
    setCompClasses((current) => current.map((value, index) => index === slot ? (sale.cad_building_class || null) : value));
    setCompAges((current) => current.map((value, index) => index === slot && yearBuilt != null ? Math.max(0, new Date().getFullYear() - yearBuilt) : (index === slot ? null : value)));
    setCompGarage((current) => current.map((value, index) => index === slot ? null : value));
    setCompRooms((current) => current.map((value, index) => index === slot ? {
      tot: totalRooms,
      bd: bedrooms == null ? null : Math.round(bedrooms),
      full: fullBaths == null ? null : Math.round(fullBaths),
      half: halfBaths == null ? null : Math.round(halfBaths),
    } : value));
    setSalesError(null);
  };

  const addSaleAsComparable = (sale: SaleRow) => {
    if (selectedSales.some((item) => item && saleKey(item) === saleKey(sale))) return;
    const openSlot = selectedSales.findIndex((item) => item === null);
    if (openSlot < 0) {
      setSalesError('Six comparables are already selected. Remove one before adding another sale.');
      return;
    }
    applySaleToSlot(sale, openSlot);
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
    setCompClasses((current) => current.map((value, index) => index === slot ? null : value));
    setCompAges((current) => current.map((value, index) => index === slot ? null : value));
    setCompGarage((current) => current.map((value, index) => index === slot ? null : value));
    setCompRooms((current) => current.map((value, index) => index === slot ? { tot: null, bd: null, full: null, half: null } : value));
  };

  const clearComparables = () => {
    Array.from({ length: COMPARABLE_COUNT }, (_, index) => index).forEach(removeComparable);
    setSalesError(null);
  };

  const runRecommendedSales = async () => {
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
        dateFrom: salesDateFrom || undefined,
        dateTo: salesDateTo || undefined,
        limit: 50,
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
    setSalesLoading(true);
    setSalesError(null);
    setSalesNotice(null);
    try {
      const rows = await api.searchSales({
        q: salesQuery.trim() || undefined,
        excludeAccountId: propertyId || undefined,
        neighborhoodCode: sameNeighborhoodOnly ? (subject?.nbhd_code || undefined) : undefined,
        dateFrom: salesDateFrom || undefined,
        dateTo: salesDateTo || undefined,
        matched: includeUnmatchedSales ? undefined : true,
        limit: 50,
      });
      setRecommendationSummary(null);
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

  // SALES/EQUITY: Class row adjustments logic
  // Comp 1: +3% of sale price; Comp 2: -3% of sale price (superior class);
  // Comp 3: 0 (same class as subject); Comp 4: +3% of sale price
  const classAdjustments = useMemo(() => {
    const prices = compPrices || [];
    return Array.from({ length: COMPARABLE_COUNT }, (_, i) => {
      const v: any = prices[i];
      const n = typeof v === 'string' ? Number(String(v).replace(/[^0-9.-]/g, '')) : Number(v);
      if (!Number.isFinite(n) || n <= 0) return null;
      const pct = i === 1 ? -0.03 : (i === 2 ? 0 : 0.03);
      const adj = Math.round(n * pct);
      return adj;
    });
  }, [compPrices]);

  // SALES/EQUITY: Room Count adjustments logic (Beds + Baths)
  // - Bedroom count adjustment: set to $0 for all comparables (for now)
  // - Bathroom count adjustment: Comp1 +$3,000; Comp2 -$3,000; Comp3 +$1,500; Comp4 $0
  // The Room Count adjustment per comparable is the sum of BedAdj + BathAdj
  const roomCountBedAdjustments = useMemo<number[]>(() => Array(COMPARABLE_COUNT).fill(0), []);
  const roomCountBathAdjustments = useMemo<number[]>(() => [3000, -3000, 1500, 0, 0, 0], []);
  const roomCountTotalAdjustments = useMemo<number[]>(
    () => roomCountBedAdjustments.map((b, i) => b + (roomCountBathAdjustments[i] ?? 0)),
    [roomCountBedAdjustments, roomCountBathAdjustments]
  );
  // SALES/EQUITY: Gross Living Area (GLA) adjustments logic
  // Comp1: +$3,000; Comp2: -$3,000; Comp3: $0; Comp4: -$2,000
  const glaAdjustments = useMemo<number[]>(() => [3000, -3000, 0, -2000, 0, 0], []);

  // SALES/EQUITY: Net Adjustments — sum all signed adjustments per comparable
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
      const classAdj = toNum((classAdjustments || [])[i]);
      const roomAdj = toNum((roomCountTotalAdjustments || [])[i]);
      const glaAdj = toNum((glaAdjustments || [])[i]);
      // Land Size, Actual Age currently $0
      const landAdj = 0;
      const ageAdj = 0;
      const total = (concession > 0 ? -concession : 0) + timeAdj + classAdj + roomAdj + glaAdj + landAdj + ageAdj;
      arr.push(total);
    }
    return arr;
  }, [compConcessions, compTimeAdjustments, classAdjustments, roomCountTotalAdjustments, glaAdjustments]);

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
      const classAdj = Math.abs(toNum((classAdjustments || [])[i]));
      const roomAdj = Math.abs(toNum((roomCountTotalAdjustments || [])[i]));
      const glaAdj = Math.abs(toNum((glaAdjustments || [])[i]));
      const landAdj = 0;
      const ageAdj = 0;
      const total = concession + timeAdj + classAdj + roomAdj + glaAdj + landAdj + ageAdj;
      arr.push(total);
    }
    return arr;
  }, [compConcessions, compTimeAdjustments, classAdjustments, roomCountTotalAdjustments, glaAdjustments]);

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
  // Derived room counts for subject column
  const subjectBedrooms = useMemo(() => {
    return parseWholeCount(subject?.bedroom_count);
  }, [subject?.bedroom_count]);
  const subjectBathsFull = useMemo(() => {
    return parseWholeCount(subject?.baths_full);
  }, [subject?.baths_full]);
  const subjectBathsHalf = useMemo(() => {
    return parseWholeCount(subject?.baths_half);
  }, [subject?.baths_half]);
  const subjectBathCount = useMemo(() => {
    const v = subject?.bath_count as any;
    if (v === null || v === undefined || v === '') return undefined;
    const n = typeof v === 'string' ? Number(String(v).replace(/[^0-9.-]/g, '')) : Number(v);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  }, [subject?.bath_count]);
  const subjectBathsDisplay = useMemo(() => {
    return formatBathCount(subject?.baths_full, subject?.baths_half, subject?.bath_count);
  }, [subject?.baths_full, subject?.baths_half, subject?.bath_count]);
  const subjectTotalRooms = useMemo(() => {
    if (subjectBedrooms === undefined) return undefined;
    return (subjectBedrooms as number) + 3;
  }, [subjectBedrooms]);

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
            <button
              type="button"
              className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-blue-600 border border-blue-600 text-white hover:bg-blue-700"
              aria-label="Generate PDF"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16l4-4h10a2 2 0 0 0 2-2V8z"/><path d="M12 12h3"/><path d="M12 15h3"/><path d="M9 12h.01"/><path d="M9 15h.01"/></svg>
              Generate PDF
            </button>
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

        {/* Neighborhood summary box */}
        <div className="mb-4 rounded-xl border border-slate-200 bg-white px-6 py-4">
          <p className="text-center">
            There are <span className="text-amber-700 font-semibold">X</span> comparable properties currently offered for sale in the subjects neighborhood ranging in price from <span className="text-amber-700 font-semibold">$x</span> to <span className="text-amber-700 font-semibold">$x</span>.
          </p>
          <p className="text-center mt-2">
            There are <span className="text-amber-700 font-semibold">8</span> comparable sales in the subject neighborhood within 12 months of the 1st of January ranging from <span className="text-amber-700 font-semibold">$x</span> to <span className="text-amber-700 font-semibold">$x</span>.
          </p>
        </div>

        <div className="mb-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex flex-col gap-1">
            <div className="text-base font-semibold text-slate-900">Comparable Sale Search</div>
            <div className="text-sm text-slate-600">
              Select up to six sales for {subject?.address || propertyId || 'the subject property'}. Selected transactions populate the sales-comparison grid below.
            </div>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-[minmax(260px,1fr)_160px_160px_auto_auto] lg:items-end">
            <label className="grid gap-1 text-sm text-slate-700">
              <span>Address, city, or parcel/account ID</span>
              <input
                value={salesQuery}
                onChange={(event) => setSalesQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void runSalesSearch();
                }}
                placeholder="e.g. SNOWMASS, Garland, or a 17-character ID"
                className="rounded-md border border-slate-300 px-3 py-2"
              />
            </label>
            <label className="grid gap-1 text-sm text-slate-700">
              <span>Closing date from</span>
              <input
                type="date"
                value={salesDateFrom}
                onChange={(event) => setSalesDateFrom(event.target.value)}
                className="rounded-md border border-slate-300 px-3 py-2"
              />
            </label>
            <label className="grid gap-1 text-sm text-slate-700">
              <span>Closing date to</span>
              <input
                type="date"
                value={salesDateTo}
                onChange={(event) => setSalesDateTo(event.target.value)}
                className="rounded-md border border-slate-300 px-3 py-2"
              />
            </label>
            <button
              type="button"
              onClick={() => void runRecommendedSales()}
              disabled={salesLoading || !propertyId}
              className="rounded-md border border-indigo-600 bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:cursor-wait disabled:opacity-60"
            >
              Recommend Top 6
            </button>
            <button
              type="button"
              onClick={() => void runSalesSearch()}
              disabled={salesLoading}
              className="rounded-md border border-emerald-600 bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:cursor-wait disabled:opacity-60"
            >
              {salesLoading ? 'Searching...' : 'Search Sales'}
            </button>
          </div>

          <div className="mt-3 rounded-lg border border-indigo-100 bg-indigo-50 px-3 py-2 text-sm text-indigo-950">
            Recommendations use DCAD parcel-center distance at 60% and living-area similarity at 40%.
            The 10% living-area setting controls how quickly that score declines; it does not exclude larger or smaller properties.
            Sales over two years old are flagged and are left out of the recommended six when at least six sales from the last year score above 70.
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
                    {sale && saleIsOverTwoYears(sale) && (
                      <div className="mt-1 text-xs font-semibold text-amber-800">Sale over two years old</div>
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
                  {' '}{recommendationSummary.recommendation_policy.recentHighScoreCount.toLocaleString()} sales from the last year scored above 70.
                  {recommendationSummary.recommendation_policy.olderSaleExclusionApplied
                    ? ' Sales over two years old were excluded from the recommended six.'
                    : ' Older sales remain eligible as clearly flagged fallbacks.'}
                </>
              )}
            </div>
          )}

          {salesResults.length > 0 && (
            <div className="mt-4 max-h-[430px] overflow-auto rounded-xl border border-slate-200">
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
                  {salesResults.map((sale) => {
                    const selected = selectedSales.some((item) => item && saleKey(item) === saleKey(sale));
                    const livingArea = sale.cad_living_area_sqft ?? sale.mls_living_area;
                    const bedrooms = sale.cad_bedroom_count ?? sale.mls_bedrooms_total;
                    const baths = sale.cad_bath_count ?? sale.mls_bathrooms_total_integer;
                    const olderThanTwoYears = saleIsOverTwoYears(sale);
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
                                Location {sale.locationScore?.toFixed(1)} · Size {sale.squareFootageScore?.toFixed(1)}
                              </div>
                              {sale.recommendationExclusionReason === 'six_recent_high_score_sales_available' && (
                                <div className="mt-1 text-xs font-medium text-amber-800">
                                  Not recommended because six recent sales scored above 70.
                                </div>
                              )}
                            </div>
                          ) : (
                            <span className="text-xs text-slate-500">Manual result</span>
                          )}
                        </td>
                        <td className="px-3 py-3">
                          <div className="font-semibold text-slate-900">{fmtCurrency(sale.sale_price) || 'Price unavailable'}</div>
                          <div className="mt-1 text-xs text-slate-500">{saleDateDisplay(sale.closing_date)} · DOM {sale.days_on_market ?? '—'}</div>
                        </td>
                        <td className="px-3 py-3 text-slate-700">
                          <div>{fmtSqftSafe(livingArea)} · {bedrooms ?? '—'} bd · {baths ?? '—'} ba</div>
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
                            {olderThanTwoYears && (
                              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900">Sale over 2 years old</span>
                            )}
                            {!sale.requires_additional_review &&
                              !missingHousingType &&
                              !unknownAttachment &&
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

            <div style={{ minWidth: 1180 }}>
              {/* Tighten cell padding by ~50% */}
              <style>{`.tight-grid th, .tight-grid td { padding: 0.25rem 0.5rem !important; }`}</style>
              <table className="w-full text-sm tight-grid" style={{ borderCollapse: 'separate', borderSpacing: 0 }}>
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
                    'Class',
                    'Actual Age',
                    'Condition/Updating',
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
                      // SALES SUBJECT CLASS: from subject.building_class (core.primary_improvements.building_class)
                      case 'Class':
                        subjectValue = subject?.building_class || '';
                        break;
                      case 'Actual Age':
                        subjectValue = subject?.actual_age ?? '';
                        break;
                      case 'Condition/Updating':
                        subjectValue = conditionCode || '';
                        break;
                      default:
                        subjectValue = '';
                    }
                    return (
                      <tr key={label}>
                        <td className="px-4 py-2 border-b border-slate-200 bg-white">{label}</td>
                        <td className="px-4 py-2 border-b border-slate-200" style={{ backgroundColor: '#FEF3C7' }}>
                          {subjectValue}
                        </td>
                        {Array.from({ length: COMPARABLE_COUNT }).map((_, i) => [
                          <td key={`${label}-desc-${i}`} className="px-4 py-2 border-b border-slate-200">
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
                              : label === 'Class'
                                ? String((compClasses || [])[i] ?? '')
                              : label === 'Actual Age'
                                ? (compAges[i] ?? '')
                              : label === 'Condition/Updating'
                                ? (conditionCode || '')
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
                              : label === 'Class'
                                ? (() => {
                                    const v = (classAdjustments || [])[i] ?? null;
                                    if (v === null || v === undefined || v === 0) return '';
                                    return fmtCurrency(v);
                                  })()
                              // SALES: Actual Age – adjustments fixed at $0 for all comparables
                              : label === 'Actual Age'
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
                  {/* SALES GRID: Additional features section — Basement SF, Functional Utility, Heating/Cooling, Solar Panels, Porches/Decks, Fencing, Pool, Easements, Secondary Improvements */}
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
                    'Easements',
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
                                ? fmtSqftSafe(subject?.garage_area_sqft)
                                : label === 'Porches/Decks'
                                  ? 'N/A'
                              : label === 'Fencing'
                                    ? (() => {
                                        const s = (subject?.fence_type ?? '').toString().trim();
                                        return s || '-';
                                      })()
                                    : label === 'Pool'
                                      ? poolDisplay(subject?.pool)
                                    : label === 'Easements'
                                      ? 'None Known'
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
                          // Pool (comparables): map subject pool code to display (N -> No, T -> Yes)
                          : label === 'Pool'
                            ? poolDisplay(subject?.pool)
                          // Easements: subject always displays "None Known"
                          : label === 'Easements'
                            ? 'None Known'
                          // Pool (comparables): map subject pool code to display (N -> No, T -> Yes)
                          : label === 'Pool'
                            ? poolDisplay(subject?.pool)
                          // Garage/Parking adjustments: comps use compGarage derived from subject (+2%, -2%, =, +2%)
                          : label === 'Garage/Parking'
                            ? fmtSqftSafe((compGarage || [])[i] ?? '')
                          // Secondary Improvements: placeholder display for comparables
                          : label === 'Secondary Improvements'
                            ? 'N/A'
                            : ''}
                        </td>,
                        <td
                          key={`${label}-adj-${i}`}
                          className="px-4 py-2 border-b border-slate-200 border-r"
                          style={{ borderLeft: '2px solid #e2e8f0', ...(i < COMPARABLE_COUNT - 1 ? { borderRightColor: '#cad5e2' } : {}) }}
                        ></td>,
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

        {/* Equity Analysis Grid (same layout as sales comparison) */}
        <div className="card bg-white shadow-sm rounded-2xl mt-6">
          <div className="card-body p-0 overflow-x-auto">
            <div className="px-6 pt-4 pb-3 flex items-center justify-between gap-3">
              <div>
                <div className="text-base font-semibold">Equity Analysis Grid</div>
                <div className="text-sm opacity-70">Grid layout to match the reference.</div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={onClickTest}
                  className="inline-flex items-center gap-2 px-3 py-1.5 text-sm rounded-md border border-red-600 bg-red-600 text-white hover:bg-red-700"
                >
                  Test
                </button>
                <button
                  type="button"
                  onClick={onClickRun}
                  className="inline-flex items-center gap-2 px-3 py-1.5 text-sm rounded-md border border-emerald-600 bg-emerald-600 text-white hover:bg-emerald-700"
                >
                  Run
                </button>
              </div>
            </div>

            {error && <div className="px-6 pb-4 text-red-600 text-sm">{error}</div>}

            <div style={{ minWidth: 1180 }}>
              <table className="w-full text-sm tight-grid" style={{ borderCollapse: 'separate', borderSpacing: 0 }}>
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
                  <tr>
                    <td className="px-4 py-2 border-b border-slate-200 bg-white">Address</td>
                    <td className="px-4 py-2 border-b border-slate-200" style={{ backgroundColor: '#FEF3C7' }}>
                      {subject?.address || ''}
                    </td>
                    {Array.from({ length: COMPARABLE_COUNT }).map((_, i) => [
                      <td key={`eq-addr-desc-${i}`} className="px-4 py-2 border-b border-slate-200">{compAddresses[i] || ''}</td>,
                        <td
                          key={`eq-addr-adj-${i}`}
                          className="px-4 py-2 border-b border-slate-200 border-r"
                          style={i < COMPARABLE_COUNT - 1 ? { borderRightColor: '#cad5e2' } : undefined}
                        ></td>,
                    ])}
                  </tr>
                  <tr>
                    <td className="px-4 py-2 border-b border-slate-200 bg-white">Value vs Sales</td>
                    <td className="px-4 py-2 border-b border-slate-200" style={{ backgroundColor: '#FEF3C7' }}>{fmtCurrency(subject?.market_value ?? '')}</td>
                    {Array.from({ length: COMPARABLE_COUNT }).map((_, i) => [
                      <td key={`eq-v-desc-${i}`} className="px-4 py-2 border-b border-slate-200">{fmtCurrency(compPrices[i] ?? '')}</td>,
                      <td
                        key={`eq-v-adj-${i}`}
                        className="px-4 py-2 border-b border-slate-200 border-r"
                        style={i < COMPARABLE_COUNT - 1 ? { borderRightColor: '#cad5e2' } : undefined}
                      ></td>,
                    ])}
                  </tr>
                  <tr className="font-semibold">
                    <td className="px-4 py-2 border-b border-slate-300 bg-slate-100">ADJUSTMENTS</td>
                    <td className="px-4 py-2 border-b border-slate-300" style={{ backgroundColor: '#FEF3C7' }}>
                      Description
                    </td>
                    {Array.from({ length: COMPARABLE_COUNT }).map((_, i) => [
                      <td key={`eq-adj-desc-${i}`} className="px-4 py-2 border-b border-slate-300">Description</td>,
                      <td
                        key={`eq-adj-adj-${i}`}
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
                    'Class',
                    'Actual Age',
                    'Condition/Updating',
                  ].map((label) => {
                    // SALES GRID ROW GUIDES (logic references for new developers):
                    // - Concessions: desc shows compConcessions[i]; adjustment shows negative concession
                    // - NBHD Code: desc shows subject.nbhd_code; no adjustment currently
                    // - Date of Sale/Time: adjustment uses compTimeAdjustments[i]
                    // - Land Size: adjustment fixed at $0 for all comps
                    // - View: desc mirrors subject.view; no adjustment currently
                    // - Const Type: desc via normalizeConstType; no adjustment currently
                    // - Class: desc shows compClasses[i]; no adjustment currently
                    // - Actual Age: desc shows compAges[i]; no adjustment currently
                    // - Condition/Updating: placeholder; no adjustment currently
                    let subjectValue: any = '';
                    switch (label) {
                      case 'Concessions':
                        subjectValue = 0;
                        break;
                      case 'NBHD Code':
                        subjectValue = subject?.nbhd_code || '';
                        break;
                      case 'Date of Sale/Time':
                        subjectValue = '';
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
                      // EQUITY SUBJECT CLASS: from subject.building_class (core.primary_improvements.building_class)
                      case 'Class':
                        subjectValue = subject?.building_class || '';
                        break;
                      case 'Actual Age':
                        subjectValue = subject?.actual_age ?? '';
                        break;
                      case 'Condition/Updating':
                        subjectValue = conditionCode || '';
                        break;
                      default:
                        subjectValue = '';
                    }
                    return (
                      <tr key={`eq-${label}`}>
                        <td className="px-4 py-2 border-b border-slate-200 bg-white">{label}</td>
                        <td className="px-4 py-2 border-b border-slate-200" style={{ backgroundColor: '#FEF3C7' }}>
                          {subjectValue}
                        </td>
                        {Array.from({ length: COMPARABLE_COUNT }).map((_, i) => [
                          <td key={`eq-${label}-desc-${i}`} className="px-4 py-2 border-b border-slate-200">
                            {label === 'Concessions'
                              ? fmtCurrency((compConcessions || [])[i] ?? '')
                              : label === 'NBHD Code'
                                ? (subject?.nbhd_code || '')
                              : label === 'Date of Sale/Time' ? '-'
                              : label === 'Land Size'
                                ? fmtSqftSafe((compLandSize || [])[i] ?? '')
                              : label === 'Housing Type'
                                ? housingTypeGridValue(selectedSales[i])
                              : label === 'Architectural Style'
                                ? (selectedSales[i]?.architectural_style || 'Not available')
                              : label === 'Const Type'
                                ? normalizeConstType(subject?.stories, subject?.construction_type)
                              : label === 'Class'
                                ? String((compClasses || [])[i] ?? '')
                              : label === 'Actual Age'
                                ? (compAges[i] ?? '')
                              : label === 'Condition/Updating'
                                ? (conditionCode || '')
                              : label === 'View'
                                ? ((subject?.view || 'Neutral') as any)
                                : ''}
                          </td>,
                          <td
                            key={`eq-${label}-adj-${i}`}
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
                              : label === 'Class'
                                ? (() => {
                                    const v = (classAdjustments || [])[i] ?? null;
                                    if (v === null || v === undefined || v === 0) return '';
                                    return fmtCurrency(v);
                                  })()
                              // EQUITY: Actual Age — adjustments fixed at $0 for all comparables
                              : label === 'Actual Age'
                                ? fmtCurrency(0)
                              : ''}
                          </td>,
                        ])}
                      </tr>
                    );
                  })}
                  <tr>
                    <td className="px-4 py-2 border-b border-slate-200 bg-white">Above Grade</td>
                    <td className="px-4 py-2 border-b border-slate-200" style={{ backgroundColor: '#FEF3C7' }}>
                      <div className="grid grid-cols-3 text-sm h-5"><div className="text-center h-full flex items-center justify-center">Total</div><div className="text-center h-full flex items-center justify-center" style={{ borderLeft: '2px solid #cbd5e1' }}>Beds</div><div className="text-center h-full flex items-center justify-center" style={{ borderLeft: '2px solid #cbd5e1' }}>Baths</div></div>
                    </td>
                    {Array.from({ length: COMPARABLE_COUNT }).map((_, i) => [
                      <td
                        key={`eq-ag-desc-${i}`}
                        className="px-4 py-2 border-b border-slate-200"
                      >
                        <div className="grid grid-cols-3 text-sm">
                          <div className="text-center">Tot</div>
                          <div className="text-center border-l-2 border-slate-300">Bd</div>
                          <div className="text-center border-l-2 border-slate-300">Bt</div>
                        </div>
                      </td>,
                      <td
                        key={`eq-ag-adj-${i}`}
                        className="px-4 py-2 border-b border-slate-200 border-r"
                        style={{ borderLeft: '2px solid #e2e8f0', ...(i < COMPARABLE_COUNT - 1 ? { borderRightColor: '#cad5e2' } : {}) }}
                      ></td>,
                    ])}
                  </tr>
                  {/* SALES GRID: Room Count — desc uses compRooms; adjustment cell intentionally blank */}
                  <tr>
                    <td className="px-4 py-2 border-b border-slate-200 bg-white">Room Count</td>
                    <td className="px-4 py-2 border-b border-slate-200" style={{ backgroundColor: '#FEF3C7' }}>
                      <div className="grid grid-cols-3 text-sm h-5">
                        <div className="text-center h-full flex items-center justify-center">{subjectTotalRooms ?? '-'}</div>
                        <div className="text-center h-full flex items-center justify-center" style={{ borderLeft: '2px solid #cbd5e1' }}>{subjectBedrooms ?? '-'}</div>
                        <div className="text-center h-full flex items-center justify-center" style={{ borderLeft: '2px solid #cbd5e1' }}>{subjectBathsDisplay || '-'}</div>
                      </div>
                    </td>
                    {Array.from({ length: COMPARABLE_COUNT }).map((_, i) => [
                      <td
                        key={`eq-rooms-desc-${i}`}
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
                        key={`eq-rooms-adj-${i}`}
                        className="px-4 py-2 border-b border-slate-200 bg-white border-r"
                        style={{ borderLeft: '2px solid #e2e8f0', ...(i < COMPARABLE_COUNT - 1 ? { borderRightColor: '#cad5e2' } : {}) }}
                      >
                        {/* EQUITY: Room Count adjustments = BedAdj + BathAdj */}
                        {fmtCurrency((roomCountTotalAdjustments || [])[i] ?? 0)}
                      </td>,
                    ])}
                  </tr>
                  {/* EQUITY: Gross Living Area — desc uses compGla; adjustment uses glaAdjustments[i] */}
                  <tr>
                    <td className="px-4 py-2 border-b border-slate-200 bg-white">Gross Living Area</td>
                    <td className="px-4 py-2 border-b border-slate-200" style={{ backgroundColor: '#FEF3C7' }}>
                      {loading ? 'Loading...' : fmtSqftSafe(subject?.total_living_area)}
                    </td>
                    {Array.from({ length: COMPARABLE_COUNT }).map((_, i) => [
                      <td key={`eq-gla-desc-${i}`} className="px-4 py-2 border-b border-slate-200">{fmtSqftSafe(compGla[i] ?? '')}</td>,
                      <td
                        key={`eq-gla-adj-${i}`}
                        className="px-4 py-2 border-b border-slate-200 border-r"
                        style={{ borderLeft: '2px solid #e2e8f0', ...(i < COMPARABLE_COUNT - 1 ? { borderRightColor: '#cad5e2' } : {}) }}
                      >{fmtCurrency((glaAdjustments || [])[i] ?? 0)}</td>,
                    ])}
                  </tr>
                  {[
                    'Basement SF',
                    'Functional Utility',
                    'Heating/Cooling',
                    'Solar Panels',
                    'Garage/Parking',
                    'Porches/Decks',
                    'Fencing',
                    'Pool',
                    'Easements',
                    'Secondary Improvements',
                  ].map((label) => (
                    // EQUITY GRID FEATURE ROW: Functional Utility — placeholder; add logic if/when defined
                    <tr key={`eq2-${label}`}>
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
                                ? fmtSqftSafe(subject?.garage_area_sqft)
                                : label === 'Porches/Decks'
                                  ? 'N/A'
                                  : label === 'Pool'
                                    ? poolDisplay(subject?.pool)
                                  : label === 'Fencing'
                                    ? (() => {
                                        const s = (subject?.fence_type ?? '').toString().trim();
                                        return s || '-';
                                      })()
                                    : label === 'Easements'
                                      ? 'None Known'
                                    // Secondary Improvements: placeholder display
                                    : label === 'Secondary Improvements'
                                      ? 'N/A'
                                      : ''}
                      </td>
                      {Array.from({ length: COMPARABLE_COUNT }).map((_, i) => [
                        <td key={`eq2-${label}-desc-${i}`} className="px-4 py-2 border-b border-slate-200">
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
                          // Pool (comparables): use same display helper as Sales grid
                          : label === 'Pool'
                            ? poolDisplay(subject?.pool)
                          // Easements: subject always displays "None Known"
                          : label === 'Easements'
                            ? 'None Known'
                          // Garage/Parking adjustments: comps use compGarage derived from subject (+2%, -2%, =, +2%)
                          : label === 'Garage/Parking'
                            ? fmtSqftSafe((compGarage || [])[i] ?? '')
                          // Secondary Improvements: placeholder display for comparables
                          : label === 'Secondary Improvements'
                            ? 'N/A'
                            : ''}
                        </td>,
                        <td
                          key={`eq2-${label}-adj-${i}`}
                          className="px-4 py-2 border-b border-slate-200 border-r"
                          style={{ borderLeft: '2px solid #e2e8f0', ...(i < COMPARABLE_COUNT - 1 ? { borderRightColor: '#cad5e2' } : {}) }}
                        ></td>,
                      ])}
                    </tr>
                  ))}
                  <tr className="font-medium">
                    <td className="px-4 py-2 border-b border-slate-300 bg-white">Net Adjustments</td>
                    <td className="px-4 py-2 border-b border-slate-300" style={{ backgroundColor: '#FEF3C7' }}>-</td>
                    {Array.from({ length: COMPARABLE_COUNT }).map((_, i) => [
                      <td key={`eq-net-desc-${i}`} className="px-4 py-2 border-b border-slate-300"></td>,
                      <td
                        key={`eq-net-adj-${i}`}
                        className="px-4 py-2 border-b border-slate-300 border-r"
                        style={{ borderLeft: '2px solid #e2e8f0', ...(i < COMPARABLE_COUNT - 1 ? { borderRightColor: '#cad5e2' } : {}) }}
                      >{fmtCurrency((netAdjustments || [])[i] ?? 0)}</td>,
                    ])}
                  </tr>
                  <tr className="font-medium">
                    <td className="px-4 py-2 border-b border-slate-300 bg-white">Gross Adjustments</td>
                    <td className="px-4 py-2 border-b border-slate-300" style={{ backgroundColor: '#FEF3C7' }}>-</td>
                    {Array.from({ length: COMPARABLE_COUNT }).map((_, i) => [
                      <td key={`eq-gross-desc-${i}`} className="px-4 py-2 border-b border-slate-300"></td>,
                      <td
                        key={`eq-gross-adj-${i}`}
                        className="px-4 py-2 border-b border-slate-300 border-r"
                        style={{ borderLeft: '2px solid #e2e8f0', ...(i < COMPARABLE_COUNT - 1 ? { borderRightColor: '#cad5e2' } : {}) }}
                      >{fmtCurrency((grossAdjustments || [])[i] ?? 0)}</td>,
                    ])}
                  </tr>
                  <tr className="font-semibold">
                    <td className="px-4 py-2 bg-orange-200 border-t border-b border-slate-300">INDICATED VALUE</td>
                    <td className="px-4 py-2 bg-slate-100 border-t border-b border-slate-300" style={{ backgroundColor: '#FEF3C7' }}>-</td>
                    {Array.from({ length: COMPARABLE_COUNT }).map((_, i) => [
                      <td key={`eq-iv-desc-${i}`} className="px-4 py-2 bg-slate-100 border-t border-b border-slate-300"></td>,
                      <td
                        key={`eq-iv-adj-${i}`}
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

        {/* Adjustment Breakdown */}
        <div className="mt-6">
          <div className="text-xl font-semibold text-slate-900">Adjustment Breakdown</div>
          <div className="text-sm text-slate-600">
            Detailed methodology comparison showing how our adjustments provide more accurate valuations than district assessments.
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

            {/* Class */}
            <div className="rounded-xl bg-white border border-slate-200 shadow-sm p-4 relative">
              <div className="absolute inset-y-0 left-0 w-1 rounded-l-xl" style={{ backgroundColor: '#f5a524' }} />
              <div className="pl-2">
                <div className="text-lg font-semibold mb-2">Class</div>
                <div className="text-green-700 font-semibold">Our Methodology</div>
                <p className="mt-2 text-sm text-slate-700">
                  We assess property class through detailed quality analysis including materials, craftsmanship,
                  finishes, and overall construction quality, comparing to recent sales of similar quality properties.
                </p>
                <div className="mt-3 text-red-600 font-semibold">District Method</div>
                <p className="mt-1 text-sm text-slate-700">
                  District classifications are often based on broad categories that don't capture subtle quality
                  differences that significantly impact market value.
                </p>
                <div className="mt-3 rounded-lg bg-slate-100 p-3">
                  <div className="font-semibold text-slate-800 text-sm">Why We're More Accurate</div>
                  <div className="text-xs text-slate-700 mt-1">
                    Our granular quality assessment provides more precise value adjustments based on actual market
                    reactions to quality differences.
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Third row of breakdown tiles */}
          <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Updating/Condition */}
            <div className="rounded-xl bg-white border border-slate-200 shadow-sm p-4 relative">
              <div className="absolute inset-y-0 left-0 w-1 rounded-l-xl" style={{ backgroundColor: '#f5a524' }} />
              <div className="pl-2">
                <div className="text-lg font-semibold mb-2">Updating/Condition</div>
                <div className="text-green-700 font-semibold">Our Methodology</div>
                <p className="mt-2 text-sm text-slate-700">
                  We evaluate property condition and updates through comprehensive analysis of renovation impact on sale
                  prices, considering the quality and appropriateness of improvements.
                </p>
                <div className="mt-3 text-red-600 font-semibold">District Method</div>
                <p className="mt-1 text-sm text-slate-700">
                  Districts often fail to properly account for the timing and quality of updates, applying generic
                  adjustments that don't reflect actual market premiums.
                </p>
                <div className="mt-3 rounded-lg bg-slate-100 p-3">
                  <div className="font-semibold text-slate-800 text-sm">Why We're More Accurate</div>
                  <div className="text-xs text-slate-700 mt-1">
                    Our method considers the specific impact of various improvement types and their current market
                    appeal.
                  </div>
                </div>
              </div>
            </div>

            {/* Bath Count */}
            <div className="rounded-xl bg-white border border-slate-200 shadow-sm p-4 relative">
              <div className="absolute inset-y-0 left-0 w-1 rounded-l-xl" style={{ backgroundColor: '#f5a524' }} />
              <div className="pl-2">
                <div className="text-lg font-semibold mb-2">Bath Count</div>
                <div className="text-green-700 font-semibold">Our Methodology</div>
                <p className="mt-2 text-sm text-slate-700">
                  We analyze the relationship between bathroom count and sale prices, considering the quality and
                  functionality of bathrooms, not just quantity.
                </p>
                <div className="mt-3 text-red-600 font-semibold">District Method</div>
                <p className="mt-1 text-sm text-slate-700">
                  Districts typically apply simple per-bathroom adjustments without accounting for bathroom quality,
                  size, or functionality.
                </p>
                <div className="mt-3 rounded-lg bg-slate-100 p-3">
                  <div className="font-semibold text-slate-800 text-sm">Why We're More Accurate</div>
                  <div className="text-xs text-slate-700 mt-1">
                    Our analysis recognizes that bathroom value depends on quality and appropriateness, not just count.
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
                <div className="text-green-700 font-semibold">Our Methodology</div>
                <p className="mt-2 text-sm text-slate-700">
                  We evaluate garage and parking features based on capacity, quality, and functionality, considering
                  regional climate factors and urban density impacts on parking value.
                </p>
                <div className="mt-3 text-red-600 font-semibold">District Method</div>
                <p className="mt-1 text-sm text-slate-700">
                  Districts typically use simple adjustments that don't account for garage quality, attached vs.
                  detached, or regional parking demand variations.
                </p>
                <div className="mt-3 rounded-lg bg-slate-100 p-3">
                  <div className="font-semibold text-slate-800 text-sm">Why We're More Accurate</div>
                  <div className="text-xs text-slate-700 mt-1">
                    Our method considers the full value impact of different parking configurations and regional demand
                    factors.
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
                <div className="text-green-700 font-semibold">Our Methodology</div>
                <p className="mt-2 text-sm text-slate-700">
                  We analyze pool features based on size, type, condition, and regional climate factors, considering
                  maintenance costs and buyer preferences in the specific market.
                </p>
                <div className="mt-3 text-red-600 font-semibold">District Method</div>
                <p className="mt-1 text-sm text-slate-700">
                  Districts often use outdated assumptions about pool values that don't reflect current maintenance
                  concerns or regional preferences.
                </p>
                <div className="mt-3 rounded-lg bg-slate-100 p-3">
                  <div className="font-semibold text-slate-800 text-sm">Why We're More Accurate</div>
                  <div className="text-xs text-slate-700 mt-1">
                    Our analysis considers the full cost-benefit analysis of pools in the current market environment.
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

















































