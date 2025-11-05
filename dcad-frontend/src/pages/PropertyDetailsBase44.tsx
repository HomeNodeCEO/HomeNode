import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { fetchProperty } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  ArrowLeft, Upload, ChevronLeft, ChevronRight, ChevronDown,
  DollarSign, Landmark, TrendingDown, Building, MapPin,
  Home, BedDouble, Bath, Car, Zap, AlertTriangle, User,
  Ruler, Percent, Layers, Hammer, Box, Triangle, Square, Grid2x2, Shapes,
  ArrowDownToLine, Thermometer, Snowflake, UtensilsCrossed, Wine, Flame, Droplets,
  DoorOpen, Sparkles, Waves, Sun, Tag, Calendar, CalendarClock, ClipboardCheck, Hash, Map, Pencil
} from "lucide-react";

// Display helper: shows fallback until value exists
function Bind({ value, fallback, format }: { value: any; fallback?: any; format?: (v: any) => any }) {
  const has = value !== undefined && value !== null && value !== "";
  const out = has ? (format ? format(value) : value) : fallback;
  return <span>{out}</span>;
}

type Property = {
  account_number?: string;
  address?: string;
  photos?: string[];

  // values
  market_value?: number | "";
  appraised_value?: number | ""; // (often "capped" or taxable)
  improvement_value?: number | "";
  land_value?: number | "";
  neighborhood_multiplier?: number | "";
  county?: string;
  neighborhood_code?: string;
  subdivision?: string;

  // details
  square_footage?: number | "";
  land_acreage?: number | "";
  bedroom_count?: number | "";
  bath_count?: number | ""; // stored as 2.5 => "2 Full, 5 Half" via formatter below
  garage_bay_count?: number | "";
  solar_panels?: boolean;
  functional_obsolescence?: boolean;

  // county details
  classification?: string;
  year_built?: number | "";
  effective_year_built?: number | "";
  last_inspection_year?: number | "";

  // protest history (optional)
  protest_history?: Array<{ year: number; status: string; initial_value: number; final_value: number }>;
};

export default function PropertyDetailsBase44() {
  const { countyId, accountId } = useParams<{ countyId: string; accountId: string }>();

  const [property, setProperty] = useState<Property>({
    account_number: accountId || "",
    photos: [],
  });
  const [loading, setLoading] = useState(false);
  const [raw, setRaw] = useState<any>(null);
  const hasAutoLoaded = useRef(false);
  const [currentImageIndex, setCurrentImageIndex] = useState(0);

  function toNum(v: any): number | "" {
    if (v === null || v === undefined || v === "") return "";
    const n = Number(String(v).replace(/[,$\s]/g, ""));
    return Number.isFinite(n) ? n : "";
  }

  // Map the MERGED endpoint payload -> our local Property shape
  function mapMergedToProperty(detail: any): Partial<Property> {
    // value_summary exists on the merged payload; fall back to top-level if present
    const vs = detail?.value_summary ?? {};

    // Try to preserve decimals for baths if present (e.g., 2.5)
    const bathNum =
      detail?.bath_count_num ??
      (typeof detail?.bath_count_display === "number" ? detail?.bath_count_display : undefined);

    return {
      account_number: detail?.account_id ?? property.account_number ?? "",
      address: detail?.situs_address ?? detail?.address ?? "",
      photos: detail?.photos ?? [],

      market_value: toNum(vs.market_value ?? detail?.market_value),
      appraised_value: toNum(vs.capped_value ?? detail?.taxable_value ?? detail?.appraised_value),
      improvement_value: toNum(vs.improvement_value),
      land_value: toNum(vs.land_value),
      neighborhood_multiplier: toNum(detail?.neighborhood?.multiplier ?? detail?.neighborhood_multiplier),

      county: detail?.county ?? detail?.county_name ?? "",

      square_footage: toNum(detail?.living_area_sqft ?? detail?.total_living_area),
      land_acreage: toNum(detail?.land_acreage ?? detail?.land?.acreage),
      bedroom_count: toNum(detail?.bedroom_count),
      bath_count: bathNum ?? "",
      garage_bay_count: toNum(detail?.garage_bay_count),
      solar_panels: !!detail?.solar_panels,
      functional_obsolescence: !!detail?.functional_obsolescence,

      classification: detail?.building_class ?? detail?.classification,
      year_built: toNum(detail?.year_built),
      effective_year_built: toNum(detail?.effective_year_built),
      last_inspection_year: toNum(detail?.last_inspection_year),

      neighborhood_code: detail?.neighborhood_code ?? detail?.neighborhood?.code,
      subdivision: detail?.subdivision ?? detail?.neighborhood?.subdivision,

      protest_history: detail?.protest_history ?? [],
    };
  }

  async function loadFromMerged() {
    if (!countyId || !accountId) return;
    setLoading(true);
    try {
      const resp = await fetchProperty(Number(countyId), accountId);
      setRaw(resp);
      const mapped = mapMergedToProperty(resp);
      setProperty(prev => ({ ...prev, ...mapped }));
    } catch (e: any) {
      console.error(e);
      alert(e?.message || "Load failed");
    } finally {
      setLoading(false);
    }
  }

  // Auto-load on first mount or when params change
  useEffect(() => {
    if (!countyId || !accountId) return;
    if (!hasAutoLoaded.current) {
      hasAutoLoaded.current = true;
      void loadFromMerged();
    } else {
      // if user navigates to a different record without full reload
      setProperty(p => ({ ...p, account_number: accountId }));
      void loadFromMerged();
    }
  }, [countyId, accountId]);

  const capLoss = (property.market_value || 0) - (property.appraised_value || 0);

  const nextImage = () => {
    if ((property.photos?.length || 0) > 1) {
      setCurrentImageIndex((i) => (i + 1) % (property.photos as string[]).length);
    }
  };
  const prevImage = () => {
    if ((property.photos?.length || 0) > 1) {
      setCurrentImageIndex((i) => (i - 1 + (property.photos as string[]).length) % (property.photos as string[]).length);
    }
  };

  const formatBathCount = (count: any) => {
    if (count === undefined || count === null || count === "") return "N/A";
    const n = Number(count);
    const full = Math.floor(n);
    const half = Math.round((n % 1) * 10);
    return half > 0 ? `${full} Full, ${half} Half` : `${full} Full`;
  };

  return (
    <div className="bg-slate-50 min-h-screen p-4 sm:p-6 lg:p-8">
      <div className="max-w-5xl mx-auto space-y-6">
        {/* Top bar */}
        <div className="flex items-center justify-between">
          <Link to="/" className="text-sm underline">
            <ArrowLeft className="w-4 h-4 inline -mt-1 mr-1" />
            Back
          </Link>
          <h1 className="text-3xl font-bold text-slate-900">Property Report</h1>
          <div />
        </div>

        {/* Account + Refresh */}
        <Card>
          <CardHeader className="grid gap-3 sm:grid-cols-[160px_1fr_auto] items-center">
            <label className="text-sm font-medium text-slate-700">Account ID</label>
            <Input value={property.account_number || ""} readOnly />
            <Button onClick={loadFromMerged} disabled={loading || !property.account_number}>
              {loading ? "Loading..." : "Refresh"}
            </Button>
          </CardHeader>
        </Card>

        {/* Hero card with photo + address + actions */}
        <Card className="overflow-hidden shadow-lg rounded-[1%]">
          <CardHeader className="p-0 relative">
            <img
              src={(property.photos && property.photos[currentImageIndex]) || "https://images.unsplash.com/photo-1580587771525-78b9dba3b914?q=80&w=1974&auto=format&fit=crop"}
              alt="Property"
              className="w-full h-60 object-cover"
            />
            {(property.photos?.length || 0) > 1 && (
              <>
                <Button size="icon" variant="secondary" className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full" onClick={prevImage}>
                  <ChevronLeft />
                </Button>
                <Button size="icon" variant="secondary" className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full" onClick={nextImage}>
                  <ChevronRight />
                </Button>
              </>
            )}
            <Button size="sm" variant="secondary" className="absolute top-2 right-2 bg-gray-900/50 text-white hover:bg-gray-900/70">
              <Upload className="w-4 h-4 mr-2" />
              Upload Photos
            </Button>
          </CardHeader>

          <div className="p-6">
            <div className="flex justify-between items-start">
              <div>
                <h2 className="text-3xl font-bold text-slate-900">
                  <Bind value={property.address} fallback="123 Main St, Dallas, TX 75201" />
                </h2>
                {/* jurisdiction chips (static examples; wire your tax modal later) */}
                <div className="flex items-center gap-2 mt-2 flex-wrap">
                  <Button variant="outline" size="sm" className="bg-blue-100 text-[#185fbc] hover:bg-blue-200 px-4 py-2 rounded-[10%]">
                    <Bind value={property.county} fallback="Dallas" /> County
                  </Button>
                  <Button variant="outline" size="sm" className="bg-blue-100 text-[#185fbc] hover:bg-blue-200 px-4 py-2 rounded-[10%]">Dallas ISD</Button>
                  <Button variant="outline" size="sm" className="bg-blue-100 text-[#185fbc] hover:bg-blue-200 px-4 py-2 rounded-[10%]">City of Dallas</Button>
                  <Button variant="outline" size="sm" className="bg-blue-100 text-[#185fbc] hover:bg-blue-200 px-4 py-2 rounded-[10%]">Parkland Hospital</Button>
                </div>
              </div>
              <div className="flex gap-2">
                <Button size="sm" className="bg-blue-600 hover:bg-blue-700 text-[#ffffff] rounded-[10%] px-4 py-2">Change Log</Button>
                <Button size="sm" className="bg-red-600 hover:bg-red-700 text-[#ffffff] rounded-[10%] px-4 py-2">Generate PDF
                </Button>
              </div>
            </div>
          </div>

          {/* Stat cards */}
          <CardContent className="bg-white p-6 pt-0 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            <StatCard icon={<DollarSign className="w-6 h-6" color="#16a34a" />} label="Market Value"
              value={`$${(property.market_value as number | undefined)?.toLocaleString?.() || "N/A"}`} />
            <StatCard icon={<Landmark className="w-6 h-6" color="#2563eb" />} label="Assessed Value"
              value={`$${(property.appraised_value as number | undefined)?.toLocaleString?.() || "N/A"}`} />
            <StatCard icon={<TrendingDown className="w-6 h-6" color="#dd4041" />} label="Cap Loss"
              value={Number.isFinite(capLoss) ? `$${(capLoss as number).toLocaleString()}` : "—"} />
            <StatCard icon={<Building className="w-6 h-6" color="#9333ea" />} label="Improvement Value"
              value={`$${(property.improvement_value as number | undefined)?.toLocaleString?.() || "N/A"}`} />
            <StatCard icon={<MapPin className="w-6 h-6" color="#ea580c" />} label="Land Value"
              value={`$${(property.land_value as number | undefined)?.toLocaleString?.() || "N/A"}`} />
            <StatCard icon={<User className="w-6 h-6" color="#8b4513" />} label="Tax Agent"
              value={<Bind value={property.tax_agent} fallback="—" />} />
          </CardContent>
        </Card>

        {/* Ownership Information */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <SectionCard title="" hideHeader className="!bg-[#ffffff] rounded-[1%] py-[1%] px-[1%] lg:col-span-2 text-[16px]">
            <details className="group">
              {/* Collapsible header row */}
              <summary className="flex items-center justify-between cursor-pointer select-none">
                <div className="text-sm font-semibold text-slate-700">Ownership Information</div>
                <ChevronDown className="w-5 h-5 transition-transform group-open:rotate-180" />
              </summary>

              {/* Collapsible content */}
              <div className="mt-3">
                {/* 3 columns */}
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                  {/* Column 1 — Current Owner */}
                  <div className="p-[1%] space-y-[1%]">
                    <div className="text-sm font-semibold text-slate-700 pb-2 border-b border-slate-300">Current Owner</div>
                    <PlainKV label="Name"><Bind value={property.owner_name} fallback="John Doe" /></PlainKV>
                    <PlainKV label="Mailing Address"><Bind value={property.owner_mailing_address} fallback="123 Main St, Dallas, TX 75201" /></PlainKV>
                    <PlainKV label="Owner Type"><Bind value={property.owner_type} fallback="Individual" /></PlainKV>
                    <PlainKV label="Ownership %"><Bind value={property.ownership_percent} fallback="100%" /></PlainKV>
                  </div>

                  {/* Column 2 — Ownership Details */}
                  <div className="p-[1%]">
                    <div className="text-sm font-semibold text-slate-700 pb-2 border-b border-slate-300">Ownership Details</div>
                    <PlainKV label="Deed Date"><Bind value={property.deed_date} fallback="03/14/2010" /></PlainKV>
                    <PlainKV label="Deed Type"><Bind value={property.deed_type} fallback="Warranty Deed" /></PlainKV>
                    <PlainKV label="Purchase Price"><Bind value={property.purchase_price} fallback="$285,000" /></PlainKV>
                    <PlainKV label="Grantor"><Bind value={property.grantor} fallback="Previous Owner LLC" /></PlainKV>
                  </div>

                  {/* Column 3 — Additional Info */}
                  <div className="p-[1%]">
                    <div className="text-sm font-semibold text-slate-700 pb-2 border-b border-slate-300">Additional Info</div>
                    <PlainKV label="Homestead"><Bind value={property.homestead_display} fallback="Yes" /></PlainKV>
                    <PlainKV label="Agricultural Use"><Bind value={property.ag_use_display} fallback="No" /></PlainKV>
                    <PlainKV label="Mineral Rights"><Bind value={property.mineral_rights_display} fallback="Included" /></PlainKV>
                    <PlainKV label="Legal Description"><Bind value={property.legal_description} fallback="Lot 15, Block A, Downtown Historic District" /></PlainKV>
                  </div>
                </div>

                {/* Divider + Notes */}
                <hr className="border-slate-300 my-2" />
                <div className="px-[1%] mt-4">
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-semibold text-slate-700">Notes</div>
                    <Button size="sm" variant="outline" className="rounded-[10%]">
                      <Pencil className="w-4 h-4 mr-2" />
                      Edit
                    </Button>
                  </div>
                  <p className="mt-2 text-slate-700">
                    <Bind value={property.owner_notes} fallback="Property was purchased from a trust. No known liens." />
                  </p>
                </div>

                <hr className="border-slate-300 my-2" />

                {/* Ownership History */}
                <div className="px-[1%] mt-4">
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-semibold text-slate-700">Ownership History</div>
                  </div>

                  <div className="mt-3 border border-slate-200 rounded-md overflow-hidden">
                    {/* Column headers */}
                    <div className="grid grid-cols-[100px_140px_1fr_1.5fr] bg-slate-50 text-slate-600 text-sm font-semibold px-4 py-2">
                      <div>Year</div><div>Transfer Date</div><div>Owner</div><div>Legal Description</div>
                    </div>
                  
                    {/* Rows (scrollable) */}
                    <div className="px-4 py-3 text-slate-500 text-sm max-h-64 overflow-y-auto">
                      <div className="text-slate-700 text-sm">
                        <div className="grid grid-cols-[100px_140px_1fr_1.5fr] px-4 py-2 border-t border-slate-100">
                          <div>2023</div><div>02/17/2023</div><div>Oak Crest Holdings LLC</div><div>Lot 15, Block A, Downtown Historic District</div>
                        </div>
                        <div className="grid grid-cols-[100px_140px_1fr_1.5fr] px-4 py-2 border-t border-slate-100">
                          <div>2019</div><div>07/08/2019</div><div>Jane Miller</div><div>Lot 15, Block A, Downtown Historic District</div>
                        </div>
                        <div className="grid grid-cols-[100px_140px_1fr_1.5fr] px-4 py-2 border-t border-slate-100">
                          <div>2016</div><div>11/22/2016</div><div>Greenfield Trust</div><div>Lot 15, Block A, Downtown Historic District</div>
                        </div>
                        <div className="grid grid-cols-[100px_140px_1fr_1.5fr] px-4 py-2 border-t border-slate-100">
                          <div>2013</div><div>04/03/2013</div><div>Douglas &amp; Renee Park</div><div>Lot 15, Block A, Downtown Historic District</div>
                        </div>
                        <div className="grid grid-cols-[100px_140px_1fr_1.5fr] px-4 py-2 border-t border-slate-100">
                          <div>2010</div><div>03/14/2010</div><div>Previous Owner LLC</div><div>Lot 15, Block A, Downtown Historic District</div>
                        </div>
                        <div className="grid grid-cols-[100px_140px_1fr_1.5fr] px-4 py-2 border-t border-slate-100">
                          <div>2005</div><div>09/30/2005</div><div>Whitestone Ventures</div><div>Lot 15, Block A, Downtown Historic District</div>
                        </div>
                        <div className="grid grid-cols-[100px_140px_1fr_1.5fr] px-4 py-2 border-t border-slate-100">
                          <div>2001</div><div>06/18/2001</div><div>Robert Chen</div><div>Lot 15, Block A, Downtown Historic District</div>
                        </div>
                        <div className="grid grid-cols-[100px_140px_1fr_1.5fr] px-4 py-2 border-t border-slate-100">
                          <div>1998</div><div>12/02/1998</div><div>Historic Development Co</div><div>Lot 15, Block A, Downtown Historic District</div>
                        </div>
                        <div className="grid grid-cols-[100px_140px_1fr_1.5fr] px-4 py-2 border-t border-slate-100">
                          <div>1993</div><div>08/25/1993</div><div>Martin &amp; Elise Garza</div><div>Lot 15, Block A, Downtown Historic District</div>
                        </div>
                        <div className="grid grid-cols-[100px_140px_1fr_1.5fr] px-4 py-2 border-t border-slate-100">
                          <div>1988</div><div>01/15/1988</div><div>Downtown Realty Partners</div><div>Lot 15, Block A, Downtown Historic District</div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </details>
          </SectionCard>
        </div>

        <SectionCard title="Property Details" className="bg-[#ffffff] rounded-[2%] p-[1%] lg:col-span-2 text-[16px]">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            <KeyVal icon={<Home className="w-4 h-4 text-slate-500" />} label="Square Footage">
              <Bind value={property.square_footage} fallback="2,500" /> sq ft
            </KeyVal>
            <KeyVal icon={<Ruler className="w-4 h-4 text-slate-500" />} label="Total Square Footage">
              <Bind value={property.total_living_area} fallback="2,750" /> sq ft
            </KeyVal>
            <KeyVal icon={<Percent className="w-4 h-4 text-slate-500" />} label="Percent Complete">
              <Bind value={property.percent_complete} fallback="100%" format={(v:any) => {
                const n = Number(v);
                return Number.isFinite(n) ? `${n}%` : v;
              }} />
            </KeyVal>
            <KeyVal icon={<Layers className="w-4 h-4 text-slate-500" />} label="Stories">
              <Bind value={property.stories || property.stories_num} fallback="2" />
            </KeyVal>
            <KeyVal icon={<Hammer className="w-4 h-4 text-slate-500" />} label="Construction Type">
              <Bind value={property.construction_type_display || property.construction_type} fallback="Frame" />
            </KeyVal>
            <KeyVal icon={<Box className="w-4 h-4 text-slate-500" />} label="Foundation">
              <Bind value={property.foundation_display || property.foundation_type} fallback="Slab" />
            </KeyVal>
            <KeyVal icon={<Triangle className="w-4 h-4 text-slate-500" />} label="Roof Type">
              <Bind value={property.roof_type} fallback="Gable" />
            </KeyVal>
            <KeyVal icon={<Square className="w-4 h-4 text-slate-500" />} label="Roof Material">
              <Bind value={property.roof_material} fallback="Composition Shingle" />
            </KeyVal>
            <KeyVal icon={<Grid2x2 className="w-4 h-4 text-slate-500" />} label="Fence Type">
              <Bind value={property.fence_type} fallback="Wood Privacy" />
            </KeyVal>
            <KeyVal icon={<Shapes className="w-4 h-4 text-slate-500" />} label="Exterior Material">
              <Bind value={property.exterior_material} fallback="Brick Veneer" />
            </KeyVal>
            <KeyVal icon={<ArrowDownToLine className="w-4 h-4 text-slate-500" />} label="Basement">
              <Bind value={property.basement_display || property.basement} fallback="None" />
            </KeyVal>
            <KeyVal icon={<Thermometer className="w-4 h-4 text-slate-500" />} label="Heating">
              <Bind value={property.heating_display || property.heating_type} fallback="Central Gas" />
            </KeyVal>
            <KeyVal icon={<Snowflake className="w-4 h-4 text-slate-500" />} label="Air Conditioning">
              <Bind value={property.cooling_display || property.air_conditioning} fallback="Central Air" />
            </KeyVal>
            <KeyVal icon={<MapPin className="w-4 h-4 text-slate-500" />} label="Land Size">
              <Bind value={property.land_acreage} fallback="0.25" /> acres
            </KeyVal>
            <KeyVal icon={<BedDouble className="w-4 h-4 text-slate-500" />} label="Bedroom Count">
              <Bind value={property.bedroom_count} fallback="4" />
            </KeyVal>
            <KeyVal icon={<Bath className="w-4 h-4 text-slate-500" />} label="Bath Count">
              <Bind value={property.bath_count} fallback="2 full, 1 half" format={formatBathCount} />
            </KeyVal>
            <KeyVal icon={<UtensilsCrossed className="w-4 h-4 text-slate-500" />} label="Kitchens">
              <Bind value={(property as any).kitchen_count} fallback="1" />
            </KeyVal>
            <KeyVal icon={<Wine className="w-4 h-4 text-slate-500" />} label="Wet Bars">
              <Bind value={(property as any).wet_bar_count} fallback="1" />
            </KeyVal>
            <KeyVal icon={<Flame className="w-4 h-4 text-slate-500" />} label="Fireplaces">
              <Bind value={(property as any).fireplace_count} fallback="2" />
            </KeyVal>
            <KeyVal icon={<Droplets className="w-4 h-4 text-slate-500" />} label="Sprinkler">
              <Bind value={(property as any).sprinkler_display} fallback="Yes" />
            </KeyVal>
            <KeyVal icon={<DoorOpen className="w-4 h-4 text-slate-500" />} label="Deck/Porches">
              <Bind value={(property as any).deck_porches_display} fallback="Covered Porch" />
            </KeyVal>
            <KeyVal icon={<Sparkles className="w-4 h-4 text-slate-500" />} label="Spa">
              <Bind value={(property as any).spa_display} fallback="No" />
            </KeyVal>
            <KeyVal icon={<Waves className="w-4 h-4 text-slate-500" />} label="Pool">
              <Bind value={property.pool_display || (property as any).pool} fallback="No" />
            </KeyVal>
            <KeyVal icon={<Sun className="w-4 h-4 text-slate-500" />} label="Sauna">
              <Bind value={(property as any).sauna_display} fallback="No" />
            </KeyVal>
            <KeyVal icon={<Car className="w-4 h-4 text-slate-500" />} label="Garage Bay Count">
              <Bind value={property.garage_bay_count} fallback="2" />
            </KeyVal>
            <KeyVal icon={<Zap className="w-4 h-4 text-slate-500" />} label="Solar Panels">
              <Badge variant={(property.solar_panels ? "default" : "secondary") as any}>
                {property.solar_panels ? "Yes" : "No"}
              </Badge>
            </KeyVal>
            <KeyVal icon={<AlertTriangle className="w-4 h-4 text-slate-500" />} label="Functional Obsolescence">
              <Badge variant={(property.functional_obsolescence ? "destructive" : "secondary") as any}>
                {property.functional_obsolescence ? "Yes" : "No"}
              </Badge>
            </KeyVal>
            <KeyVal icon={<Tag className="w-4 h-4 text-slate-500" />} label="Classification">
              <Bind value={property.classification} fallback="12" />
            </KeyVal>
            <KeyVal icon={<Calendar className="w-4 h-4 text-slate-500" />} label="Actual Year Built">
              <Bind value={property.year_built} fallback="1985" />
            </KeyVal>
            <KeyVal icon={<CalendarClock className="w-4 h-4 text-slate-500" />} label="Effective Year Built">
              <Bind value={property.effective_year_built} fallback="1995" />
            </KeyVal>
            <KeyVal icon={<ClipboardCheck className="w-4 h-4 text-slate-500" />} label="Last Inspection">
              <Bind value={property.last_inspection_year} fallback="2023" />
            </KeyVal>
            <KeyVal icon={<Hash className="w-4 h-4 text-slate-500" />} label="Neighborhood Code">
              <Bind value={property.neighborhood_code} fallback="1559463" />
            </KeyVal>
            <KeyVal icon={<Map className="w-4 h-4 text-slate-500" />} label="Subdivision">
              <Bind value={(property as any).subdivision} fallback="Downtown Historic District" />
            </KeyVal>
          </div>
        </SectionCard>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <SectionCard title="Land Details" className="bg-[#ffffff] px-[2%] py-[2%] rounded-[2%]">
            <div className="space-y-3">
              {/* Labels use default/darker text to match Property Details */}
              <div className="flex items-start gap-3 text-[16px]">
                <span className="leading-6 w-[120px] shrink-0">State Code:</span>
                <span className="font-medium leading-6 flex-1 min-w-0 text-right break-words">TX001</span>
              </div>
               <div className="flex items-start gap-3 text-[16px]">
                <span className="leading-6 w-[120px] shrink-0">Zoning:</span>
                <span className="font-medium leading-6 flex-1 min-w-0 text-right break-words">SF-3</span>
              </div>

              <div className="flex items-start gap-3 text-[16px]">
                <span className="leading-6 w-[120px] shrink-0">Frontage Ft:</span>
                <span className="font-medium leading-6 flex-1 min-w-0 text-right break-words">75</span>
              </div>

              <div className="flex items-start gap-3 text-[16px]">
                <span className="leading-6 w-[120px] shrink-0">Depth Ft:</span>
                <span className="font-medium leading-6 flex-1 min-w-0 text-right break-words">150</span>
              </div>

              <div className="flex items-start gap-3 text-[16px]">
                <span className="leading-6 w-[120px] shrink-0">Area SF:</span>
                <span className="font-medium leading-6 flex-1 min-w-0 text-right break-words">11,250</span>
              </div>

              <div className="flex items-start gap-3 text-[16px]">
                <span className="leading-6 w-[120px] shrink-0">Pricing Method:</span>
                <span className="font-medium leading-6 flex-1 min-w-0 text-right break-words">Market</span>
              </div>

              <div className="flex items-start gap-3 text-[16px]">
                <span className="leading-6 w-[120px] shrink-0">Unit Price:</span>
                <span className="font-medium leading-6 flex-1 min-w-0 text-right break-words">$8.89</span>
              </div>

              <div className="flex items-start gap-3 text-[16px]">
                <span className="leading-6 w-[120px] shrink-0">Market Adjustment %:</span>
                <span className="font-medium leading-6 flex-1 min-w-0 text-right break-words">0.0%</span>
              </div>

              <div className="flex items-start gap-3 text-[16px]">
                <span className="leading-6 w-[120px] shrink-0">Adjusted Price:</span>
                <span className="font-medium leading-6 flex-1 min-w-0 text-right break-words">$8.89</span>
              </div>

              <div className="flex items-start gap-3 text-[16px]">
                <span className="leading-6 w-[120px] shrink-0">AG Land?:</span>
                <span className="leading-6 flex-1 min-w-0 text-right">
                  <Badge variant="secondary" className="rounded-full px-3">No</Badge>
                </span>
              </div>
            </div>
          </SectionCard>

          <SectionCard title="Secondary Improvements" className="bg-[#ffffff] px-[2%] py-[2%] rounded-[5%]">
            {/* Scrollable viewable area sized similarly to Land Details */}
            <div className="h-[350px] overflow-y-auto pr-2">
              {/* Tile grid now contains tiles #1–#5 with consistent multi-line <li> formatting */}
              <div className="grid grid-cols-1 gap-4">
                {/* Tile #1 */}
                <div className="rounded-[5%] border border-slate-200 p-4">
                  <div className="mb-2 text-sm font-semibold text-slate-700">#1</div>
                  <div className="grid grid-cols-2 gap-6">
                    <ul className="list-disc list-inside space-y-1">
                      <li>&nbsp;</li>
                      <li>&nbsp;</li>
                      <li>&nbsp;</li>
                      <li>&nbsp;</li>
                      <li>&nbsp;</li>
                    </ul>
                    <ul className="list-disc list-inside space-y-1">
                      <li>&nbsp;</li>
                      <li>&nbsp;</li>
                      <li>&nbsp;</li>
                      <li>&nbsp;</li>
                      <li>&nbsp;</li>
                    </ul>
                  </div>
                </div>

                {/* Tile #2 */}
                <div className="rounded-[5%] border border-slate-200 p-4">
                  <div className="mb-2 text-sm font-semibold text-slate-700">#2</div>
                  <div className="grid grid-cols-2 gap-6">
                    <ul className="list-disc list-inside space-y-1">
                      <li>&nbsp;</li>
                      <li>&nbsp;</li>
                      <li>&nbsp;</li>
                      <li>&nbsp;</li>
                      <li>&nbsp;</li>
                    </ul>
                    <ul className="list-disc list-inside space-y-1">
                      <li>&nbsp;</li>
                      <li>&nbsp;</li>
                      <li>&nbsp;</li>
                      <li>&nbsp;</li>
                      <li>&nbsp;</li>
                    </ul>
                  </div>
                </div>

                {/* Tile #3 */}
                <div className="rounded-[5%] border border-slate-200 p-4">
                  <div className="mb-2 text-sm font-semibold text-slate-700">#3</div>
                  <div className="grid grid-cols-2 gap-6">
                    <ul className="list-disc list-inside space-y-1">
                      <li>&nbsp;</li>
                      <li>&nbsp;</li>
                      <li>&nbsp;</li>
                      <li>&nbsp;</li>
                      <li>&nbsp;</li>
                    </ul>
                    <ul className="list-disc list-inside space-y-1">
                      <li>&nbsp;</li>
                      <li>&nbsp;</li>
                      <li>&nbsp;</li>
                      <li>&nbsp;</li>
                      <li>&nbsp;</li>
                    </ul>
                  </div>
                </div>

                {/* Tile #4 */}
                <div className="rounded-[5%] border border-slate-200 p-4">
                  <div className="mb-2 text-sm font-semibold text-slate-700">#4</div>
                  <div className="grid grid-cols-2 gap-6">
                    <ul className="list-disc list-inside space-y-1">
                      <li>&nbsp;</li>
                      <li>&nbsp;</li>
                      <li>&nbsp;</li>
                      <li>&nbsp;</li>
                      <li>&nbsp;</li>
                    </ul>
                    <ul className="list-disc list-inside space-y-1">
                      <li>&nbsp;</li>
                      <li>&nbsp;</li>
                      <li>&nbsp;</li>
                      <li>&nbsp;</li>
                      <li>&nbsp;</li>
                    </ul>
                  </div>
                </div>

                {/* Tile #5 */}
                <div className="rounded-[5%] border border-slate-200 p-4">
                  <div className="mb-2 text-sm font-semibold text-slate-700">#5</div>
                  <div className="grid grid-cols-2 gap-6">
                    <ul className="list-disc list-inside space-y-1">
                      <li>&nbsp;</li>
                      <li>&nbsp;</li>
                      <li>&nbsp;</li>
                      <li>&nbsp;</li>
                      <li>&nbsp;</li>
                    </ul>
                    <ul className="list-disc list-inside space-y-1">
                      <li>&nbsp;</li>
                      <li>&nbsp;</li>
                      <li>&nbsp;</li>
                      <li>&nbsp;</li>
                      <li>&nbsp;</li>
                    </ul>
                  </div>
                </div>
              </div>
            </div>
          </SectionCard>
        </div>
        
        {/* Protest history table */}
        <SectionCard title="Protest History">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Year</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Initial Value</TableHead>
                <TableHead>Final Value</TableHead>
                <TableHead>Change</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {property.protest_history?.length ? (
                property.protest_history.map((row, i) => (
                  <TableRow key={i}>
                    <TableCell>{row.year}</TableCell>
                    <TableCell><Badge variant={row.status === "Completed" ? "default" : "secondary"}>{row.status}</Badge></TableCell>
                    <TableCell>${row.initial_value.toLocaleString()}</TableCell>
                    <TableCell>${row.final_value.toLocaleString()}</TableCell>
                    <TableCell className={row.final_value < row.initial_value ? "text-green-600" : "text-slate-500"}>
                      ${(row.final_value - row.initial_value).toLocaleString()}
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={5} className="text-center">No protest history available.</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </SectionCard>

        {/* Raw JSON while wiring */}
        <details className="mt-2">
          <summary className="cursor-pointer">Show raw API JSON</summary>
          <pre className="whitespace-pre-wrap bg-slate-50 p-3 rounded-md text-sm">
{JSON.stringify(raw, null, 2)}
          </pre>
        </details>
      </div>
    </div>
  );
}

/* --- small helpers mirrored from your structure --- */
function StatCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center gap-4 p-4 bg-slate-100/80 rounded-lg justify-between">
      <div className="flex items-center gap-4">
        <div className="bg-slate-200 p-3 rounded-lg">{icon}</div>
        <div>
          <p className="text-sm text-slate-600">{label}</p>
          <p className="font-bold text-slate-900 text-xl">{value}</p>
        </div>
      </div>
    </div>
  );
}

function SectionCard({
  title,
  children,
  className,
  hideHeader,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
  hideHeader?: boolean;
}) {
  return (
    <Card className={`shadow-lg overflow-hidden ${className ?? ""}`}>
      {!hideHeader && (
        <CardHeader className={`flex flex-row items-center justify-between ${className ?? ""}`}>
          <CardTitle>{title}</CardTitle>
          <Button size="sm" variant="outline">Edit</Button>
        </CardHeader>
      )}
      <CardContent className={className}>{children}</CardContent>
    </Card>
  );
}

function KeyVal({ icon, label, children }: { icon?: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between items-center text-[16px]">
      <span className="flex items-center gap-2">{icon}{label}:</span>
      <span className="font-medium">{children}</span>
    </div>
  );
}

function PlainKV({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 text-[16px]">
      {/* Fixed-width label that can wrap to two lines (e.g., "Mailing Address:") */}
      <span className="text-slate-600 leading-6 w-[120px] shrink-0">
        {label}:
      </span>

      {/* Value fills remaining space, stays right-aligned, and wraps under itself */}
      <span className="font-medium leading-6 flex-1 min-w-0 text-right break-words">
        {children}
      </span>
    </div>
  );
}
