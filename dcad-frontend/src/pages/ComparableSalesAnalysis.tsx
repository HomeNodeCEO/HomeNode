import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useEffect, useMemo, useState, useRef } from 'react';
import * as api from '@/lib/api';
import { fetchDetail } from '@/lib/dcad';

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
};

export default function ComparableSalesAnalysis() {
  const location = useLocation();
  const navigate = useNavigate();
  const propertyId = useMemo(() => {
    const p = new URLSearchParams(location.search);
    return p.get('propertyId') || '';
  }, [location.search]);

  const [subject, setSubject] = useState<SubjectData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [photos, setPhotos] = useState<File[]>([]);
  const photoInputRef = useRef<HTMLInputElement | null>(null);
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
  const [compAddresses, setCompAddresses] = useState<string[]>(['', '', '', '']);
  const [compGla, setCompGla] = useState<Array<number | null>>([null, null, null, null]);
  const [compPrices, setCompPrices] = useState<Array<number | null>>([null, null, null, null]);
  const [compConcessions, setCompConcessions] = useState<Array<number | null>>([null, null, null, null]);
  const [compSaleDates, setCompSaleDates] = useState<string[]>(['', '', '', '']);
  const [compLandSize, setCompLandSize] = useState<Array<number | null>>([null, null, null, null]);
  const [compClasses, setCompClasses] = useState<Array<number | string | null>>([null, null, null, null]);
  // Test-mode comparable ages for the "Actual Age" row
  const [compAges, setCompAges] = useState<Array<number | null>>([null, null, null, null]);
  // Test-mode comparable garage areas
  const [compGarage, setCompGarage] = useState<Array<number | null>>([null, null, null, null]);
  const [compRooms, setCompRooms] = useState<Array<{ tot: number | null; bd: number | null; full: number | null; half: number | null }>>([
    { tot: null, bd: null, full: null, half: null },
    { tot: null, bd: null, full: null, half: null },
    { tot: null, bd: null, full: null, half: null },
    { tot: null, bd: null, full: null, half: null },
  ]);
  const parseSqftNum = (v: unknown): number | null => {
    if (v === null || v === undefined || v === '') return null;
    const n = typeof v === 'string' ? Number(String(v).replace(/[^0-9.-]/g, '')) : Number(v);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
  };
  const onClickTest = () => {
    setCompAddresses(['123 Main St', '456 Edge Dr', '789 Third St', '1012 Oak Rd']);
    const subj = parseSqftNum(subject?.total_living_area);
    if (subj && subj > 0) {
      const v1 = Math.round(subj * 0.95);
      const v2 = Math.round(subj * 1.05);
      const v3 = Math.round(subj * 1.0);
      const v4 = Math.round(subj * 1.02);
      setCompGla([v1, v2, v3, v4]);
    } else {
      setCompGla([null, null, null, null]);
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
      setCompPrices([p1, p2, p3, p4]);
    } else {
      setCompPrices([null, null, null, null]);
    }

    // Fixed concessions by comparable
    setCompConcessions([5000, 5000, 0, 3000]);

    // Fixed sale dates by comparable
    setCompSaleDates(['11/05/2025', '07/16/2025', '11/25/2025', '09/10/2025']);

    // Land size from subject +/- 2%
    const subjLand = parseSqftNum(subject?.land_size_sqft);
    if (subjLand && subjLand > 0) {
      const l1 = Math.round(subjLand * 1.02); // +2%
      const l2 = Math.round(subjLand * 0.98); // -2%
      const l3 = Math.round(subjLand * 0.98); // -2%
      const l4 = Math.round(subjLand * 1.02); // +2%
      setCompLandSize([l1, l2, l3, l4]);
    } else {
      setCompLandSize([null, null, null, null]);
    }

    // Garage/Parking sqft adjustments per comparable (rounded up)
    const subjGarage = parseSqftNum(subject?.garage_area_sqft);
    if (subjGarage && subjGarage > 0) {
      const g1 = Math.ceil(subjGarage * 1.02); // +2%
      const g2 = Math.ceil(subjGarage * 0.98); // -2%
      const g3 = Math.ceil(subjGarage * 1.0);  // same
      const g4 = Math.ceil(subjGarage * 1.02); // +2%
      setCompGarage([g1, g2, g3, g4]);
    } else {
      setCompGarage([null, null, null, null]);
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
      setCompClasses([c1, c2, c3, c4]);
    } else {
      // If not numeric, mirror the subject's class label for all comps
      const s = (subject?.building_class ?? '') as any;
      setCompClasses([s, s, s, s]);
    }

    // Actual Age adjustments per comparable
    // NOTE: If subject's age is 0, comps 1 and 4 should not go negative; they remain equal to subject.
    const subjAge = parseIntLike(subject?.actual_age);
    if (subjAge !== null) {
      let a1 = subjAge - 2; // comp 1: -2 years
      const a2 = subjAge + 3; // comp 2: +3 years
      const a3 = subjAge;     // comp 3: same
      let a4 = subjAge - 4; // comp 4: -4 years
      if (subjAge === 0) { a1 = 0; a4 = 0; }
      a1 = Math.max(0, a1);
      a4 = Math.max(0, a4);
      setCompAges([a1, a2, a3, a4]);
    } else {
      setCompAges([null, null, null, null]);
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
    setCompRooms([comp1, comp2, comp3, comp4]);
  };
  const onClickRun = () => {
    // Placeholder for future automation; keep state intact for now.
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
      setSalesNotes(
        `Selected comparable sales within the same neighborhood code and approximately a 0.5ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¹Ã…â€œmile radius of ${addr}, ` +
          `matching for age, size and quality to reflect current market activity.`
      );
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
      <div>${(summary || '').replace(/\n/g,'<br/>')}</div>
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
            baths_full: null,
            baths_half: null,
            basement: (imp as any)?.basement ?? null,
            basement_raw: (imp as any)?.basement_raw ?? null,
            heating: (imp as any)?.heating ?? null,
            air_conditioning: (imp as any)?.air_conditioning ?? null,
            deck: (imp as any)?.deck ?? null,
            fence_type: (imp as any)?.fence_type ?? null,
            pool: (imp as any)?.pool ?? null,
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
          // Final optional enrichment: if basement still missing and a scraper API base is configured, query it
          try {
            const env: any = (import.meta as any).env || {};
            const base = (env.VITE_SCRAPER_BASE || env.VITE_SCRAPER_URL || '').toString().replace(/\/+$/, '');
            if (base) {
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
  // Derived room counts for subject column
  const subjectBedrooms = useMemo(() => {
    const v = subject?.bedroom_count as any;
    if (v === null || v === undefined || v === '') return undefined;
    const n = typeof v === 'string' ? Number(String(v).replace(/[^0-9.-]/g, '')) : Number(v);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  }, [subject?.bedroom_count]);
  const subjectBathsFull = useMemo(() => {
    const v = subject?.baths_full as any;
    if (v === null || v === undefined || v === '') return undefined;
    const n = typeof v === 'string' ? Number(String(v).replace(/[^0-9.-]/g, '')) : Number(v);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  }, [subject?.baths_full]);
  const subjectBathsHalf = useMemo(() => {
    const v = subject?.baths_half as any;
    if (v === null || v === undefined || v === '') return undefined;
    const n = typeof v === 'string' ? Number(String(v).replace(/[^0-9.-]/g, '')) : Number(v);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  }, [subject?.baths_half]);
  const subjectBathCount = useMemo(() => {
    const v = subject?.bath_count as any;
    if (v === null || v === undefined || v === '') return undefined;
    const n = typeof v === 'string' ? Number(String(v).replace(/[^0-9.-]/g, '')) : Number(v);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  }, [subject?.bath_count]);
  const subjectBathsDisplay = useMemo(() => {
    if (subjectBathsFull !== undefined || subjectBathsHalf !== undefined) {
      const full = subjectBathsFull ?? 0;
      const half = subjectBathsHalf ?? 0;
      return `${full}.${half}`;
    }
    if (subjectBathCount !== undefined) return String(subjectBathCount);
    return '';
  }, [subjectBathsFull, subjectBathsHalf, subjectBathCount]);
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

            <div style={{ minWidth: 850 }}>
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
                {Array.from({ length: 4 }).map((_, i) => (
                  <th
                    key={i}
                    colSpan={2}
                    className={`text-left px-4 py-2 border-b border-slate-300 bg-white ${i < 3 ? 'border-r' : ''}`}
                    style={i < 3 ? { borderRightColor: '#cad5e2' } : undefined}
                  >
                    {`Comparable ${i + 1}`}
                  </th>
                ))}
              </tr>
            </thead>
                <tbody>
                  {/* Row: Address */}
                  <tr>
                    <td className="px-4 py-2 border-b border-slate-200 bg-white">Address</td>
                    <td className="px-4 py-2 border-b border-slate-200" style={{ backgroundColor: '#FEF3C7' }}>
                      {/* subject address (optional) */}
                      {subject?.address || ''}
                    </td>
                    {Array.from({ length: 4 }).map((_, i) => [
                      <td key={`addr-desc-${i}`} className="px-4 py-2 border-b border-slate-200">{compAddresses[i] || ''}</td>,
                      <td
                        key={`addr-adj-${i}`}
                        className="px-4 py-2 border-b border-slate-200 border-r"
                        style={i < 3 ? { borderRightColor: '#cad5e2' } : undefined}
                      ></td>,
                    ])}
                  </tr>

                  {/* Row: Value vs Sales */}
                  <tr>
                    <td className="px-4 py-2 border-b border-slate-200 bg-white">Value vs Sales</td>
                    <td className="px-4 py-2 border-b border-slate-200" style={{ backgroundColor: '#FEF3C7' }}>
                      {fmtCurrency(subject?.market_value ?? '')}
                    </td>
                    {Array.from({ length: 4 }).map((_, i) => [
                      <td key={`v-desc-${i}`} className="px-4 py-2 border-b border-slate-200">{fmtCurrency(compPrices[i] ?? '')}</td>,
                      <td
                        key={`v-adj-${i}`}
                        className="px-4 py-2 border-b border-slate-200 border-r"
                        style={i < 3 ? { borderRightColor: '#cad5e2' } : undefined}
                      ></td>,
                    ])}
                  </tr>

                  {/* Section header: ADJUSTMENTS with Description/Adjustment labels */}
                  <tr className="font-semibold">
                    <td className="px-4 py-2 border-b border-slate-300 bg-slate-100">ADJUSTMENTS</td>
                    <td className="px-4 py-2 border-b border-slate-300" style={{ backgroundColor: '#FEF3C7' }}>
                      Description
                    </td>
                    {Array.from({ length: 4 }).map((_, i) => [
                      <td key={`adj-desc-${i}`} className="px-4 py-2 border-b border-slate-300 border-r-2 border-slate-300">Description</td>,
                      <td
                        key={`adj-adj-${i}`}
                        className="px-4 py-2 border-b border-slate-300 border-r"
                        style={i < 3 ? { borderRightColor: '#cad5e2' } : undefined}
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
                        subjectValue = '';
                        break;
                      case 'Land Size':
                        subjectValue = fmtSqftSafe(subject?.land_size_sqft ?? null);
                        break;
                      case 'View':
                        subjectValue = subject?.view || 'Neutral';
                        break;
                      case 'Const Type':
                        subjectValue = normalizeConstType(subject?.stories, subject?.construction_type);
                        break;
                      case 'Class':
                        subjectValue = subject?.building_class || '';
                        break;
                      case 'Actual Age':
                        subjectValue = subject?.actual_age ?? '';
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
                        {Array.from({ length: 4 }).map((_, i) => [
                          <td key={`${label}-desc-${i}`} className="px-4 py-2 border-b border-slate-200 border-r-2 border-slate-300">
                            {label === 'Concessions'
                              ? fmtCurrency((compConcessions || [])[i] ?? '')
                              : label === 'NBHD Code'
                                ? (subject?.nbhd_code || '')
                              : label === 'Date of Sale/Time'
                                ? (compSaleDates[i] || '')
                              : label === 'Land Size'
                                ? fmtSqftSafe((compLandSize || [])[i] ?? '')
                              : label === 'Const Type'
                                ? normalizeConstType(subject?.stories, subject?.construction_type)
                              : label === 'Class'
                                ? String((compClasses || [])[i] ?? '')
                              : label === 'Actual Age'
                                ? (compAges[i] ?? '')
                              : label === 'View'
                                ? ((subject?.view || 'Neutral') as any)
                                : ''}
                          </td>,
                          <td
                            key={`${label}-adj-${i}`}
                            className="px-4 py-2 border-b border-slate-200 border-r"
                            style={i < 3 ? { borderRightColor: '#cad5e2' } : undefined}
                          ></td>,
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
                    {Array.from({ length: 4 }).map((_, i) => [
                      <td
                        key={`ag-desc-${i}`}
                        className="px-4 py-2 border-b border-slate-200 border-r-2 border-slate-300"
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
                        style={i < 3 ? { borderRightColor: '#cad5e2' } : undefined}
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
                    {Array.from({ length: 4 }).map((_, i) => [
                      <td
                        key={`rooms-desc-${i}`}
                        className="px-4 py-2 bg-white border-b border-slate-200 border-r-2 border-slate-300"
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
                        style={i < 3 ? { borderRightColor: '#cad5e2' } : undefined}
                      ></td>,
                    ])}
                  </tr>

                  {/* Gross Living Area */}
                  <tr>
                    <td className="px-4 py-2 border-b border-slate-200 bg-white">Gross Living Area</td>
                    <td className="px-4 py-2 border-b border-slate-200" style={{ backgroundColor: '#FEF3C7' }}>
                      {loading ? 'Loading...' : fmtSqftSafe(subject?.total_living_area)}
                    </td>
                    {Array.from({ length: 4 }).map((_, i) => [
                      <td key={`gla-desc-${i}`} className="px-4 py-2 border-b border-slate-200 border-r-2 border-slate-300">{fmtSqftSafe(compGla[i] ?? '')}</td>,
                      <td
                        key={`gla-adj-${i}`}
                        className="px-4 py-2 border-b border-slate-200 border-r"
                        style={i < 3 ? { borderRightColor: '#cad5e2' } : undefined}
                      ></td>,
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
                    <tr key={label}>
                      <td className="px-4 py-2 border-b border-slate-200 bg-white">{label}</td>
                      <td className="px-4 py-2 border-b border-slate-200" style={{ backgroundColor: '#FEF3C7' }}>
                        {label === 'Basement SF'
                          ? fmtSqftSafe(subject?.basement_sqft)
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
                              ? (subject?.solar_panels ? (subject?.solar_area_sqft ? fmtSqftSafe(subject?.solar_area_sqft) : 'Yes') : '-')
                              : label === 'Garage/Parking'
                                ? fmtSqftSafe(subject?.garage_area_sqft)
                                : label === 'Porches/Decks'
                                  ? (() => {
                                      const v: any = subject?.deck;
                                      if (typeof v === 'boolean') return v ? 'Yes' : '-';
                                      const s = (v ?? '').toString().trim();
                                      if (!s) return '-';
                                      return /^n(?:o)?$/i.test(s) ? '-' : s;
                                    })()
                                  : label === 'Fencing'
                                    ? (() => {
                                        const s = (subject?.fence_type ?? '').toString().trim();
                                        return s || '-';
                                      })()
                                    : label === 'Pool'
                                      ? (() => {
                                          const v: any = subject?.pool;
                                          const toBool = (x: any): boolean | null => {
                                            if (typeof x === 'boolean') return x;
                                            const s = String(x ?? '').trim().toLowerCase();
                                            if (!s) return null;
                                            if (['no','n','none','0','false'].includes(s)) return false;
                                            return true;
                                          };
                                          const b = toBool(v);
                                          return b === null ? '-' : (b ? 'Yes' : 'No');
                                        })()
                                      : ''}
                      </td>
                      {Array.from({ length: 4 }).map((_, i) => [
                        <td key={`${label}-desc-${i}`} className="px-4 py-2 border-b border-slate-200 border-r-2 border-slate-300">
                          {/* Basement SF mirroring: comparables match the subject's basement_sqft (including '-') */}
                          {label === 'Basement SF'
                            ? fmtSqftSafe(subject?.basement_sqft)
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
                              // Solar Panels mirroring: comparables show same presence/area as subject
                              : label === 'Solar Panels'
                                ? (subject?.solar_panels ? (subject?.solar_area_sqft ? fmtSqftSafe(subject?.solar_area_sqft) : 'Yes') : '-')
                              // Fencing mirroring: comparables show same fence type as subject
                              : label === 'Fencing'
                                ? (() => { const s = (subject?.fence_type ?? '').toString().trim(); return s || '-'; })()
                              : label === 'Garage/Parking'
                                ? fmtSqftSafe((compGarage || [])[i] ?? '')
                                : ''}
                        </td>,
                        <td
                          key={`${label}-adj-${i}`}
                          className="px-4 py-2 border-b border-slate-200 border-r"
                          style={i < 3 ? { borderRightColor: '#cad5e2' } : undefined}
                        ></td>,
                      ])}
                    </tr>
                  ))}

                  {/* Totals rows */}
                  <tr className="font-medium">
                    <td className="px-4 py-2 border-b border-slate-300 bg-white">Net Adjustments</td>
                    <td className="px-4 py-2 border-b border-slate-300" style={{ backgroundColor: '#FEF3C7' }}>-</td>
                    {Array.from({ length: 4 }).map((_, i) => [
                      <td key={`net-desc-${i}`} className="px-4 py-2 border-b border-slate-300 border-r-2 border-slate-300"></td>,
                      <td
                        key={`net-adj-${i}`}
                        className="px-4 py-2 border-b border-slate-300 border-r"
                        style={i < 3 ? { borderRightColor: '#cad5e2' } : undefined}
                      ></td>,
                    ])}
                  </tr>

                  <tr className="font-medium">
                    <td className="px-4 py-2 border-b border-slate-300 bg-white">Gross Adjustments</td>
                    <td className="px-4 py-2 border-b border-slate-300" style={{ backgroundColor: '#FEF3C7' }}>-</td>
                    {Array.from({ length: 4 }).map((_, i) => [
                      <td key={`gross-desc-${i}`} className="px-4 py-2 border-b border-slate-300 border-r-2 border-slate-300"></td>,
                      <td
                        key={`gross-adj-${i}`}
                        className="px-4 py-2 border-b border-slate-300 border-r"
                        style={i < 3 ? { borderRightColor: '#cad5e2' } : undefined}
                      ></td>,
                    ])}
                  </tr>

                  <tr className="font-semibold">
                    <td className="px-4 py-2 bg-orange-200 border-t border-b border-slate-300">INDICATED VALUE</td>
                    <td className="px-4 py-2 bg-slate-100 border-t border-b border-slate-300" style={{ backgroundColor: '#FEF3C7' }}>-</td>
                    {Array.from({ length: 4 }).map((_, i) => [
                      <td key={`iv-desc-${i}`} className="px-4 py-2 bg-slate-100 border-t border-b border-slate-300 border-r-2 border-slate-300"></td>,
                      <td
                        key={`iv-adj-${i}`}
                        className="px-4 py-2 bg-slate-100 border-t border-b border-slate-300 border-r"
                        style={i < 3 ? { borderRightColor: '#cad5e2' } : undefined}
                      ></td>,
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
            <div className="mt-2 text-5xl font-extrabold" style={{ color: '#9A4A00' }}>$466,000</div>
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

            <div style={{ minWidth: 850 }}>
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
                {Array.from({ length: 4 }).map((_, i) => (
                  <th
                    key={i}
                    colSpan={2}
                    className={`text-left px-4 py-2 border-b border-slate-300 bg-white ${i < 3 ? 'border-r' : ''}`}
                    style={i < 3 ? { borderRightColor: '#cad5e2' } : undefined}
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
                    {Array.from({ length: 4 }).map((_, i) => [
                      <td key={`eq-addr-desc-${i}`} className="px-4 py-2 border-b border-slate-200">{compAddresses[i] || ''}</td>,
                      <td
                        key={`eq-addr-adj-${i}`}
                        className="px-4 py-2 border-b border-slate-200 border-r"
                        style={i < 3 ? { borderRightColor: '#cad5e2' } : undefined}
                      ></td>,
                    ])}
                  </tr>
                  <tr>
                    <td className="px-4 py-2 border-b border-slate-200 bg-white">Value vs Sales</td>
                    <td className="px-4 py-2 border-b border-slate-200" style={{ backgroundColor: '#FEF3C7' }}>{fmtCurrency(subject?.market_value ?? '')}</td>
                    {Array.from({ length: 4 }).map((_, i) => [
                      <td key={`eq-v-desc-${i}`} className="px-4 py-2 border-b border-slate-200">{fmtCurrency(compPrices[i] ?? '')}</td>,
                      <td
                        key={`eq-v-adj-${i}`}
                        className="px-4 py-2 border-b border-slate-200 border-r"
                        style={i < 3 ? { borderRightColor: '#cad5e2' } : undefined}
                      ></td>,
                    ])}
                  </tr>
                  <tr className="font-semibold">
                    <td className="px-4 py-2 border-b border-slate-300 bg-slate-100">ADJUSTMENTS</td>
                    <td className="px-4 py-2 border-b border-slate-300" style={{ backgroundColor: '#FEF3C7' }}>
                      Description
                    </td>
                    {Array.from({ length: 4 }).map((_, i) => [
                      <td key={`eq-adj-desc-${i}`} className="px-4 py-2 border-b border-slate-300 border-r-2 border-slate-300">Description</td>,
                      <td
                        key={`eq-adj-adj-${i}`}
                        className="px-4 py-2 border-b border-slate-300 border-r"
                        style={i < 3 ? { borderRightColor: '#cad5e2' } : undefined}
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
                        subjectValue = '';
                        break;
                      case 'Land Size':
                        subjectValue = fmtSqftSafe(subject?.land_size_sqft ?? null);
                        break;
                      case 'View':
                        subjectValue = subject?.view || 'Neutral';
                        break;
                      case 'Const Type':
                        subjectValue = normalizeConstType(subject?.stories, subject?.construction_type);
                        break;
                      case 'Class':
                        subjectValue = subject?.building_class || '';
                        break;
                      case 'Actual Age':
                        subjectValue = subject?.actual_age ?? '';
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
                        {Array.from({ length: 4 }).map((_, i) => [
                          <td key={`eq-${label}-desc-${i}`} className="px-4 py-2 border-b border-slate-200 border-r-2 border-slate-300">
                            {label === 'Concessions'
                              ? fmtCurrency((compConcessions || [])[i] ?? '')
                              : label === 'NBHD Code'
                                ? (subject?.nbhd_code || '')
                              : label === 'Date of Sale/Time'
                                ? (compSaleDates[i] || '')
                              : label === 'Land Size'
                                ? fmtSqftSafe((compLandSize || [])[i] ?? '')
                              : label === 'Const Type'
                                ? normalizeConstType(subject?.stories, subject?.construction_type)
                              : label === 'Class'
                                ? String((compClasses || [])[i] ?? '')
                              : label === 'Actual Age'
                                ? (compAges[i] ?? '')
                              : label === 'View'
                                ? ((subject?.view || 'Neutral') as any)
                                : ''}
                          </td>,
                          <td
                            key={`eq-${label}-adj-${i}`}
                            className="px-4 py-2 border-b border-slate-200 border-r"
                            style={i < 3 ? { borderRightColor: '#cad5e2' } : undefined}
                          ></td>,
                        ])}
                      </tr>
                    );
                  })}
                  <tr>
                    <td className="px-4 py-2 border-b border-slate-200 bg-white">Above Grade</td>
                    <td className="px-4 py-2 border-b border-slate-200" style={{ backgroundColor: '#FEF3C7' }}>
                      <div className="grid grid-cols-3 text-sm h-5"><div className="text-center h-full flex items-center justify-center">Total</div><div className="text-center h-full flex items-center justify-center" style={{ borderLeft: '2px solid #cbd5e1' }}>Beds</div><div className="text-center h-full flex items-center justify-center" style={{ borderLeft: '2px solid #cbd5e1' }}>Baths</div></div>
                    </td>
                    {Array.from({ length: 4 }).map((_, i) => [
                      <td
                        key={`eq-ag-desc-${i}`}
                        className="px-4 py-2 border-b border-slate-200 border-r-2 border-slate-300"
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
                        style={i < 3 ? { borderRightColor: '#cad5e2' } : undefined}
                      ></td>,
                    ])}
                  </tr>
                  <tr>
                    <td className="px-4 py-2 border-b border-slate-200 bg-white">Room Count</td>
                    <td className="px-4 py-2 border-b border-slate-200" style={{ backgroundColor: '#FEF3C7' }}>
                      <div className="grid grid-cols-3 text-sm h-5">
                        <div className="text-center h-full flex items-center justify-center">{subjectTotalRooms ?? '-'}</div>
                        <div className="text-center h-full flex items-center justify-center" style={{ borderLeft: '2px solid #cbd5e1' }}>{subjectBedrooms ?? '-'}</div>
                        <div className="text-center h-full flex items-center justify-center" style={{ borderLeft: '2px solid #cbd5e1' }}>{subjectBathsDisplay || '-'}</div>
                      </div>
                    </td>
                    {Array.from({ length: 4 }).map((_, i) => [
                      <td
                        key={`eq-rooms-desc-${i}`}
                        className="px-4 py-2 bg-white border-b border-slate-200 border-r-2 border-slate-300"
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
                        style={i < 3 ? { borderRightColor: '#cad5e2' } : undefined}
                      ></td>,
                    ])}
                  </tr>
                  <tr>
                    <td className="px-4 py-2 border-b border-slate-200 bg-white">Gross Living Area</td>
                    <td className="px-4 py-2 border-b border-slate-200" style={{ backgroundColor: '#FEF3C7' }}>
                      {loading ? 'Loading...' : fmtSqftSafe(subject?.total_living_area)}
                    </td>
                    {Array.from({ length: 4 }).map((_, i) => [
                      <td key={`eq-gla-desc-${i}`} className="px-4 py-2 border-b border-slate-200 border-r-2 border-slate-300">{fmtSqftSafe(compGla[i] ?? '')}</td>,
                      <td
                        key={`eq-gla-adj-${i}`}
                        className="px-4 py-2 border-b border-slate-200 border-r"
                        style={i < 3 ? { borderRightColor: '#cad5e2' } : undefined}
                      ></td>,
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
                    <tr key={`eq2-${label}`}>
                      <td className="px-4 py-2 border-b border-slate-200 bg-white">{label}</td>
                      <td className="px-4 py-2 border-b border-slate-200" style={{ backgroundColor: '#FEF3C7' }}>
                        {label === 'Basement SF'
                          ? fmtSqftSafe(subject?.basement_sqft)
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
                              ? (subject?.solar_panels ? (subject?.solar_area_sqft ? fmtSqftSafe(subject?.solar_area_sqft) : 'Yes') : '-')
                              : label === 'Garage/Parking'
                                ? fmtSqftSafe(subject?.garage_area_sqft)
                                : label === 'Porches/Decks'
                                  ? (() => {
                                      const v: any = subject?.deck;
                                      if (typeof v === 'boolean') return v ? 'Yes' : '-';
                                      const s = (v ?? '').toString().trim();
                                      if (!s) return '-';
                                      return /^n(?:o)?$/i.test(s) ? '-' : s;
                                    })()
                                  : label === 'Fencing'
                                    ? (() => {
                                        const s = (subject?.fence_type ?? '').toString().trim();
                                        return s || '-';
                                      })()
                                    : ''}
                      </td>
                      {Array.from({ length: 4 }).map((_, i) => [
                        <td key={`eq2-${label}-desc-${i}`} className="px-4 py-2 border-b border-slate-200 border-r-2 border-slate-300">
                          {/* Basement SF mirroring: comparables match the subject's basement_sqft (including '-') */}
                          {label === 'Basement SF'
                            ? fmtSqftSafe(subject?.basement_sqft)
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
                              // Solar Panels mirroring: comparables show same presence/area as subject
                              : label === 'Solar Panels'
                                ? (subject?.solar_panels ? (subject?.solar_area_sqft ? fmtSqftSafe(subject?.solar_area_sqft) : 'Yes') : '-')
                              // Fencing mirroring: comparables show same fence type as subject
                              : label === 'Fencing'
                                ? (() => { const s = (subject?.fence_type ?? '').toString().trim(); return s || '-'; })()
                              : label === 'Garage/Parking'
                                ? fmtSqftSafe((compGarage || [])[i] ?? '')
                                : ''}
                        </td>,
                        <td
                          key={`eq2-${label}-adj-${i}`}
                          className="px-4 py-2 border-b border-slate-200 border-r"
                          style={i < 3 ? { borderRightColor: '#cad5e2' } : undefined}
                        ></td>,
                      ])}
                    </tr>
                  ))}
                  <tr className="font-medium">
                    <td className="px-4 py-2 border-b border-slate-300 bg-white">Net Adjustments</td>
                    <td className="px-4 py-2 border-b border-slate-300" style={{ backgroundColor: '#FEF3C7' }}>-</td>
                    {Array.from({ length: 4 }).map((_, i) => [
                      <td key={`eq-net-desc-${i}`} className="px-4 py-2 border-b border-slate-300 border-r-2 border-slate-300"></td>,
                      <td
                        key={`eq-net-adj-${i}`}
                        className="px-4 py-2 border-b border-slate-300 border-r"
                        style={i < 3 ? { borderRightColor: '#cad5e2' } : undefined}
                      ></td>,
                    ])}
                  </tr>
                  <tr className="font-medium">
                    <td className="px-4 py-2 border-b border-slate-300 bg-white">Gross Adjustments</td>
                    <td className="px-4 py-2 border-b border-slate-300" style={{ backgroundColor: '#FEF3C7' }}>-</td>
                    {Array.from({ length: 4 }).map((_, i) => [
                      <td key={`eq-gross-desc-${i}`} className="px-4 py-2 border-b border-slate-300 border-r-2 border-slate-300"></td>,
                      <td
                        key={`eq-gross-adj-${i}`}
                        className="px-4 py-2 border-b border-slate-300 border-r"
                        style={i < 3 ? { borderRightColor: '#cad5e2' } : undefined}
                      ></td>,
                    ])}
                  </tr>
                  <tr className="font-semibold">
                    <td className="px-4 py-2 bg-orange-200 border-t border-b border-slate-300">INDICATED VALUE</td>
                    <td className="px-4 py-2 bg-slate-100 border-t border-b border-slate-300" style={{ backgroundColor: '#FEF3C7' }}>-</td>
                    {Array.from({ length: 4 }).map((_, i) => [
                      <td key={`eq-iv-desc-${i}`} className="px-4 py-2 bg-slate-100 border-t border-b border-slate-300 border-r-2 border-slate-300"></td>,
                      <td
                        key={`eq-iv-adj-${i}`}
                        className="px-4 py-2 bg-slate-100 border-t border-b border-slate-300 border-r"
                        style={i < 3 ? { borderRightColor: '#cad5e2' } : undefined}
                      ></td>,
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
            <textarea value={salesNotes} onChange={(e) => setSalesNotes(e.target.value)} className="border rounded-md p-2 text-sm h-24"></textarea>
          </div>
          <div className="flex flex-col">
            <label className="text-xs mb-1 text-slate-600">Adjustment Analysis</label>
            <textarea value={adjustmentNotes} onChange={(e) => setAdjustmentNotes(e.target.value)} className="border rounded-md p-2 text-sm h-24"></textarea>
          </div>
          <div className="flex flex-col">
            <label className="text-xs mb-1 text-slate-600">Cost to Cure</label>
            <textarea value={ctcNotes} onChange={(e) => setCtcNotes(e.target.value)} className="border rounded-md p-2 text-sm h-24"></textarea>
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

function Category({ title, items }: { title: string; items: { label: string; cost: number }[] }) {
  const total = items.reduce((s, i) => s + i.cost, 0);
  const fmt = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  return (
    <div className="mb-6">
      <div className="font-semibold mb-2">{title}</div>
      <div className="space-y-2">
        {items.map((it, idx) => (
          <div key={idx} className="flex items-center justify-between rounded-md bg-slate-50 border border-slate-200 px-3 py-2">
            <div className="text-sm text-slate-800">{it.label}</div>
            <div className="text-sm font-semibold text-rose-600">{fmt(it.cost)}</div>
          </div>
        ))}
      </div>
      <div className="mt-2 text-sm text-slate-700">Category Total: <span className="font-semibold">{fmt(total)}</span></div>
    </div>
  );
}

// Helper bound in component scope via onClick
async function generateSummary(this: any) { /* placeholder to satisfy TS during parse in some tools */ }

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































