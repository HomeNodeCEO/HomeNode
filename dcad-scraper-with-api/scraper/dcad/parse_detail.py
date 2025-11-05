# scraper/dcad/parse_detail.py  (patched parse_owner safety)
from __future__ import annotations

import re
from typing import Any, Dict, List, Optional

from bs4 import BeautifulSoup, Tag, NavigableString

# Your repo's helpers
from .normalize import clean_text, to_bool, to_num, to_sqft, pct_to_num


PARSER_VERSION = "2025-09-07d"  # used only for debugging/verification


# ------------------------------------------------------------
# Small utilities
# ------------------------------------------------------------

def get_any(kv: Dict[str, str], *keys: str) -> str:
    for k in keys:
        if k in kv and kv[k]:
            return kv[k]
    return ""

def _headers_lower(t: Tag) -> List[str]:
    hdrs: List[str] = []
    thead = t.find("thead")
    if thead:
        ths = thead.find_all(["th", "td"])
    else:
        first = t.find("tr")
        ths = first.find_all(["th", "td"]) if first else []
    for th in ths:
        hdrs.append((th.get_text(" ", strip=True) or "").lower())
    return [h for h in hdrs if h]

def _txt(node: Tag | None, default: str = "N/A") -> str:
    if not node:
        return default
    try:
        t = node.get_text(strip=True)
    except Exception:
        t = str(node) if node else ""
    t = clean_text(t)
    return t if t else default

def _num_or_na(text: str | None, default: str = "N/A") -> str:
    if text is None:
        return default
    t = clean_text(text)
    return t or default


# ------------------------------------------------------------
# Table classification helpers
# ------------------------------------------------------------

_NAV_WORDS = {
    "navigation", "links", "link", "map", "property map",
    "print", "help", "disclaimer", "version", "top", "return"
}

def _is_nav_like_table(t: Tag) -> bool:
    """Filter out obvious navigation/utility tables."""
    hdrs = " | ".join(_headers_lower(t))
    if any(w in hdrs for w in _NAV_WORDS):
        return True
    first_tr = t.find("tr")
    if first_tr:
        cells = [clean_text(td.get_text()) for td in first_tr.find_all(["th","td"])]
        line = " ".join(cells).lower()
        if any(w in line for w in _NAV_WORDS):
            return True
    return False

def _is_land_like_table(t: Tag) -> bool:
    """Avoid confusing Land grids with Addl Improvements."""
    hdrs = " | ".join(_headers_lower(t))
    land_tokens = ["land", "acre", "acres", "frontage", "depth", "zoning"]
    value_tokens = ["market", "assessed", "appraised", "value", "productivity"]
    hits = sum(1 for tok in land_tokens if tok in hdrs) + sum(1 for tok in value_tokens if tok in hdrs)
    return hits >= 3 and ("imp" not in hdrs and "improvement" not in hdrs)

def _is_main_impr_table(t: Tag) -> bool:
    hdrs = _headers_lower(t)
    signals = [
        "effective year built", "year built", "yr built", "eff yr",
        "total living area", "living area", "total area",
        "stories", "# stories", "desirability", "desirability code",
        "construction", "construction type", "foundation",
        "roof", "roof type", "roof material", "exterior", "ext. wall",
        "baths", "bedrooms"
    ]
    return any(any(sig in h for h in hdrs) for sig in signals)

def _is_addl_impr_table(t: Tag) -> bool:
    if _is_land_like_table(t):
        return False
    if _is_nav_like_table(t):
        return False
    hdrs = _headers_lower(t)
    tokens = 0
    for k in [
        "imp", "improvement", "type", "desc", "description", "area", "size", "sq",
        "value", "depr", "depreciation", "year", "stories", "wall", "floor",
        "construction", "ext", "ext wall"
    ]:
        tokens += sum(1 for h in hdrs if k in h)
    return tokens >= 3


# ------------------------------------------------------------
# Locators
# ------------------------------------------------------------

def _find_after_header_span(soup: BeautifulSoup, header_id_prefix: str) -> Optional[Tag]:
    hdr = soup.find(
        lambda t: t.name == "span"
        and t.get("class") and "DtlSectionHdr" in t.get("class")
        and str(t.get("id", "")).lower().startswith(header_id_prefix.lower())
    )
    if not hdr:
        return None
    cur: Optional[Tag] = hdr
    for _ in range(20):
        cur = cur.find_next("table") if cur else None
        if not cur:
            break
        if cur.find(["th", "td"]):
            return cur
    return None

def _table_after_heading(soup: BeautifulSoup, heading_text: str) -> Optional[Tag]:
    ht = heading_text.lower()
    h = soup.find(lambda t: t.name in ("h2","h3","h4","b","strong") and ht in (t.get_text(strip=True) or "").lower())
    if not h:
        h = soup.find(lambda t: t.name == "span" and t.get("class") and "DtlSectionHdr" in t.get("class", []) and ht in (t.get_text(strip=True) or "").lower())
    if not h:
        node = soup.find(string=lambda x: x and ht in str(x).lower())
        h = node.parent if node else None
    if not h:
        return None
    cur: Optional[Tag] = h
    for _ in range(20):
        cur = cur.find_next("table") if cur else None
        if not cur:
            break
        if cur.find(["th","td"]):
            return cur
    return None

def _find_heading_table(soup: BeautifulSoup, phrases: List[str]) -> Optional[Tag]:
    patt = re.compile("|".join(re.escape(p) for p in phrases), re.I)
    candidates = soup.select("h1,h2,h3,h4,strong,label,div.section-title,div.card-title,span.DtlSectionHdr")
    for tag in candidates:
        text = (tag.get_text(" ", strip=True) or "")
        if patt.search(text):
            nxt: Optional[Tag] = tag
            for _ in range(16):
                if not nxt:
                    break
                nxt = nxt.find_next(["table","div"])
                if not nxt:
                    break
                if nxt.name == "table" and nxt.find("tr"):
                    return nxt
                maybe = nxt.find("table")
                if maybe and maybe.find("tr"):
                    return maybe
    return None


# ------------------------------------------------------------
# Generic extractors
# ------------------------------------------------------------

def parse_keyvalue_table(tbl: Tag) -> Dict[str, str]:
    out: Dict[str, str] = {}
    for tr in tbl.find_all("tr"):
        cells = tr.find_all(["td","th"])
        texts = [clean_text(c.get_text()) for c in cells]
        texts = [t for t in texts if t]
        if not texts:
            continue

        if len(texts) == 1 and ":" in texts[0]:
            parts = [p.strip() for p in re.split(r"\s*:\s*", texts[0], maxsplit=1)]
            if len(parts) == 2 and parts[0]:
                out.setdefault(parts[0].lower(), parts[1])
            continue

        if len(texts) == 2:
            k, v = texts[0].lower(), texts[1]
            if k:
                out.setdefault(k, v)
        elif len(texts) > 2:
            labels = [c for c in tr.find_all(class_=re.compile(r"(FieldName|FieldLabel)", re.I))]
            values = [c for c in tr.find_all(class_=re.compile(r"(FieldValue|FieldVal)", re.I))]
            if labels and values and len(labels) == len(values):
                for L, V in zip(labels, values):
                    lk = clean_text(L.get_text()).lower()
                    vv = clean_text(V.get_text())
                    if lk:
                        out.setdefault(lk, vv)
            else:
                for i in range(0, len(texts) - 1, 2):
                    k = texts[i].lower()
                    v = texts[i+1] if i+1 < len(texts) else ""
                    if k:
                        out.setdefault(k, v)
    return out

def _stories_to_number(s: str | None) -> Optional[float]:
    if not s:
        return None
    m = re.search(r"(\d+(\.\d+)?)", s)
    if m:
        return to_num(m.group(1))
    s_up = str(s).upper()
    words = {"ONE":1,"TWO":2,"THREE":3,"FOUR":4,"FIVE":5,"SIX":6}
    for w,n in words.items():
        if w in s_up:
            return n + 0.5 if "HALF" in s_up else n
    return None

def map_yn_to_none(s: str | None) -> str:
    if s is None:
        return "N/A"
    val = clean_text(s).upper()
    if val in {"N","NO","FALSE","NONE","UNASSIGNED",""}:
        return "NONE"
    if val in {"Y","YES","TRUE","1"}:
        return "Y"
    return val or "N/A"

def _parse_baths_full_half(kv: Dict[str, str]) -> tuple[Optional[float], Optional[float]]:
    key = "# baths (full/half)"
    v = kv.get(key)
    if not v:
        return None, None
    parts = [p.strip() for p in v.replace(" ","").split("/")]
    if len(parts) == 2:
        return to_num(parts[0]), to_num(parts[1])
    return None, None


# ------------------------------------------------------------
# Improvements
# ------------------------------------------------------------

_MAIN_HEADING_PHRASES = [
    "main improvement", "main improvements", "main building", "primary improvement",
    "residential improvements", "building information", "improvements - main",
    "res improvements", "primary building"
]

def _resolve_main_improvement_table(soup: BeautifulSoup) -> Optional[Tag]:
    return (
        _table_after_heading(soup, "main improvement")
        or _find_after_header_span(soup, "lblmainimp")
        or _find_heading_table(soup, _MAIN_HEADING_PHRASES)
        or next((t for t in soup.find_all("table") if _is_main_impr_table(t)), None)
    )

def _find_best_main_by_content(soup: BeautifulSoup) -> Optional[Tag]:
    best_tbl = None
    best_score = 0
    signals = [
        "year built", "effective year built", "yr built", "eff yr",
        "living area", "total living area", "total area",
        "# stories", "stories",
        "desirability", "construction", "foundation",
        "roof type", "roof material", "exterior", "ext. wall",
        "baths", "bedrooms", "basement"
    ]
    for t in soup.find_all("table"):
        if _is_nav_like_table(t) or _is_land_like_table(t):
            continue
        kv = parse_keyvalue_table(t)
        score = sum(1 for s in signals if any(s in k for k in kv.keys()))
        if score > best_score:
            best_score = score
            best_tbl = t
    return best_tbl if best_score >= 3 else None

def parse_main_improvement(soup: BeautifulSoup) -> Dict[str, Any]:
    mi_tbl = _resolve_main_improvement_table(soup) or _find_best_main_by_content(soup)
    if not mi_tbl:
        return {}
    kv = parse_keyvalue_table(mi_tbl)
    g = lambda k: kv.get(k, "")

    s_text = (g("# stories") or g("stories"))
    s_num = _stories_to_number(s_text)

    bf, bh = _parse_baths_full_half(kv)

    # Bedrooms can appear as "# Bedrooms" or "Bedrooms" depending on the page
    bedrooms_num = to_num(get_any(kv, "# bedrooms", "bedrooms", "bed rooms", "bed room", "bedroom"))

    raw_age = get_any(kv, "actual age", "age")
    age_num = None
    if raw_age:
        m = re.search(r"-?\d+(?:\.\d+)?", raw_age)
        if m:
            age_num = to_num(m.group(0))

    desirability_id = to_num(get_any(kv, "desirability id", "desirability code"))
    desirability_val = g("desirability")

    basement_text = get_any(kv, "basement")

    total_liv = to_sqft(get_any(kv, "total living area", "total liv area", "living area total", "total_living_area"))

    out = {
        "building_class": g("building class"),

        "year_built": to_num(get_any(kv, "year built", "yr built", "built")),
        "effective_year_built": to_num(get_any(kv, "effective year built", "eff year built", "eff yr")),
        "actual_age": age_num,

        "desirability": desirability_val,
        "desirability_raw": desirability_val,
        "desirability_id": desirability_id,

        "living_area_sqft": to_sqft(get_any(kv, "living area", "liv area", "area living")),
        "total_living_area": total_liv,
        "total_area_sqft": to_sqft(get_any(kv, "total area", "area total")),

        "percent_complete": to_num(get_any(kv, "% complete", "percent complete", "complete %")),

        "stories": s_num,
        "stories_raw": s_text,

        "depreciation": pct_to_num(get_any(kv, "depreciation", "depr %", "depreciation %")),

        "construction_type": get_any(kv, "construction type", "constr type", "construction"),
        "foundation": get_any(kv, "foundation", "found type"),
        "roof_type": get_any(kv, "roof type", "type roof"),
        "roof_material": get_any(kv, "roof material", "material roof"),
        "fence_type": get_any(kv, "fence type", "type fence"),
        "exterior_material": get_any(kv, "ext. wall material", "exterior wall material", "exterior"),

        "basement_raw": basement_text,
        "basement": map_yn_to_none(basement_text),

        "heating": get_any(kv, "heating", "heat type"),
        "air_conditioning": get_any(kv, "air condition", "air conditioning", "ac type"),

        "baths_full": bf if bf is not None else to_num(get_any(kv, "# baths (full)", "baths full", "full baths")),
        "baths_half": bh if bh is not None else to_num(get_any(kv, "# baths (half)", "baths half", "half baths")),
        "bedroom_count": bedrooms_num,
        "kitchens": to_num(get_any(kv, "# kitchens", "kitchens")),
        "wetbars": to_num(get_any(kv, "# wet bars", "wet bars")),
        "fireplaces": to_num(get_any(kv, "# fireplaces", "fireplaces")),
        "sprinkler": map_yn_to_none(get_any(kv, "sprinkler")),
        "deck": map_yn_to_none(get_any(kv, "deck")),
        "spa": map_yn_to_none(get_any(kv, "spa")),
        "pool": map_yn_to_none(get_any(kv, "pool")),
        "sauna": map_yn_to_none(get_any(kv, "sauna")),
    }

    out = {k: (v if v != "" else None) for k, v in out.items()}
    if not any(v is not None for v in out.values()):
        return {}
    return out


# ------------------------------------------------------------
# Additional Improvements
# ------------------------------------------------------------

def _resolve_additional_improvements_table(soup: BeautifulSoup) -> Optional[Tag]:
    return (
        soup.find(id="ResImp1_dgImp")
        or _find_after_header_span(soup, "lbladdimp")
        or _find_heading_table(soup, ["additional improvements", "other improvements", "outbuildings", "secondary improvements"])
        or next((t for t in soup.find_all("table") if _is_addl_impr_table(t)), None)
    )

def parse_additional_improvements(tbl: Tag | None) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    if not tbl or _is_nav_like_table(tbl):
        return rows

    trs = tbl.find_all("tr")
    if len(trs) <= 1:
        return rows

    # Header-driven mapping (DCAD column order can change)
    headers = [clean_text(h.get_text()).lower() for h in trs[0].find_all(["th", "td"])]
    header_line = " | ".join(headers)
    if any(w in header_line for w in _NAV_WORDS):
        return []

    # Build index map by fuzzy contains
    def idx(*keys: str) -> Optional[int]:
        for k in keys:
            for i, h in enumerate(headers):
                if k in h:
                    return i
        return None

    i_num   = idx("imp #", "imp#", "imp no", "number", "#")
    i_type  = idx("type")
    i_desc  = idx("desc")
    i_year  = idx("year")
    i_con   = idx("construction", "constr")
    i_floor = idx("floor")
    i_wall  = idx("ext wall", "exterior wall", "ext. wall", "wall")
    i_stor  = idx("stories", "# stories")
    i_area  = idx("area size", "area", "sq ft", "sqft", "size")
    i_val   = idx("value")
    i_depr  = idx("depr", "depreciation")

    for tr in trs[1:]:
        tds = [clean_text(td.get_text()) for td in tr.find_all("td")]
        if not tds:
            continue
        flat = " ".join(tds).lower()
        if any(w in flat for w in _NAV_WORDS):
            continue

        number = to_num(tds[i_num]) if (i_num is not None and i_num < len(tds)) else None
        if number is None:
            continue  # keep NOT NULL imp_num invariant

        entry: Dict[str, Any] = {
            "imp_num": str(int(number)) if number is not None else None,
            "imp_type": (tds[i_type] if (i_type is not None and i_type < len(tds)) else "N/A"),
            "imp_desc": (tds[i_desc] if (i_desc is not None and i_desc < len(tds)) else None),
            "year_built": to_num(tds[i_year]) if (i_year is not None and i_year < len(tds)) else None,
            "construction": (tds[i_con] if (i_con is not None and i_con < len(tds)) else "N/A"),
            "floor_type": (tds[i_floor] if (i_floor is not None and i_floor < len(tds)) else "N/A"),
            "ext_wall": (tds[i_wall] if (i_wall is not None and i_wall < len(tds)) else "N/A"),
            "num_stories": to_num(tds[i_stor]) if (i_stor is not None and i_stor < len(tds)) else None,
            "area_size": (tds[i_area] if (i_area is not None and i_area < len(tds)) else "0"),
            "value": (tds[i_val] if (i_val is not None and i_val < len(tds)) else None),
            "depreciation": (tds[i_depr] if (i_depr is not None and i_depr < len(tds)) else None),
        }

        # Normalize area to numeric sqft if possible (keeps your string fallback pattern)
        try:
            entry["area_sqft"] = to_sqft(entry["area_size"])
        except Exception:
            pass

        rows.append(entry)

    return rows

# ------------------------------------------------------------
# Land / Exemptions / Estimated Taxes
# (unchanged from earlier v2)
# ------------------------------------------------------------

def parse_land_detail_from_table(tbl: Tag | None) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    if not tbl:
        return out
    trs = tbl.find_all("tr")
    if len(trs) <= 1:
        return out
    for tr in trs[1:]:
        tds = [clean_text(td.get_text()) for td in tr.find_all("td")]
        if len(tds) >= 11:
            number = to_num(tds[0]) if tds[0] else None
            area_txt = tds[5] or ""
            area_num_part = clean_text(area_txt).split()[0] if area_txt else ""
            out.append({
                "number": number,
                "state_code": tds[1] or "N/A",
                "zoning": tds[2] or "N/A",
                "frontage_ft": to_num(tds[3]),
                "depth_ft": to_num(tds[4]),
                "area_sqft": to_sqft(area_num_part) if area_num_part else 0,
                "pricing_method": tds[6] or "N/A",
                "unit_price": tds[7] or "N/A",
                "market_adjustment_pct": tds[8] or "N/A",
                "adjusted_price": tds[9] or "N/A",
                "ag_land": ("NONE" if (tds[10] or "").upper() in {"N","NO","FALSE","NONE","UNASSIGNED"} else (tds[10] or "N/A")),
            })
    return out

def parse_land_detail(soup: BeautifulSoup) -> List[Dict[str, Any]]:
    land_tbl = soup.find(id="Land1_dgLand") or _find_after_header_span(soup, "lblland") or _table_after_heading(soup, "land")
    return parse_land_detail_from_table(land_tbl) if land_tbl else []

def parse_exemptions_sections(soup: BeautifulSoup) -> Dict[str, Any]:
    ex_tbl = _find_after_header_span(soup, "lblexempt") or _table_after_heading(soup, "exemptions")
    if ex_tbl:
        headers = [clean_text(th.get_text()) for th in ex_tbl.find_all("th")]
        if not any(str(h).lower() == "city" for h in headers):
            nested = ex_tbl.find("table")
            if nested:
                ex_tbl = nested
    if not ex_tbl:
        return {}
    rows = ex_tbl.find_all("tr")
    if len(rows) < 3:
        return {}

    header_cells = rows[0].find_all(["th","td"])
    headers = [clean_text(c.get_text()) for c in header_cells]
    col_headers = headers[1:]

    def row_values(row_idx: int):
        r = rows[row_idx]
        th = r.find("th")
        label = clean_text(th.get_text()) if th else ""
        tds = [clean_text(td.get_text()) for td in r.find_all("td")]
        return label, tds

    _, row1 = row_values(1)
    _, row2 = row_values(2)

    row3 = None
    for r in rows[3:]:
        if "taxable value" in clean_text(r.get_text()).lower():
            row3 = [clean_text(td.get_text()) for td in r.find_all("td")]
            break
    if row3 is None:
        tv_th = None
        for el in ex_tbl.find_all(["th","td"], recursive=False):
            if getattr(el, "name", None) == "th" and "taxable value" in clean_text(el.get_text()).lower():
                tv_th = el
                break
        if tv_th:
            tds_after: List[str] = []
            sib = tv_th.next_sibling
            while sib:
                if getattr(sib, "name", None) == "td":
                    tds_after.append(clean_text(sib.get_text()))
                sib = sib.next_sibling
            row3 = tds_after

    out: Dict[str, Any] = {}
    for idx, col in enumerate(col_headers):
        key = str(col).lower().replace(" ","_")
        tj = row1[idx] if idx < len(row1) else "N/A"
        he = row2[idx] if idx < len(row2) else "N/A"
        tv = row3[idx] if (row3 is not None and idx < len(row3)) else "N/A"
        out[key] = {"taxing_jurisdiction": tj or "N/A", "homestead_exemption": he or "N/A", "taxable_value": tv or "N/A"}
    return out

def parse_estimated_taxes(soup: BeautifulSoup) -> tuple[Dict[str, Any], str, str]:
    tbl = _find_after_header_span(soup, "lblesttax") or _table_after_heading(soup, "estimated taxes")
    if not tbl:
        return {}, "N/A", "OK"

    rows = [r for r in tbl.find_all("tr") if r.find_all(["th","td"])]
    if len(rows) < 3:
        return {}, "N/A", "OK"

    total_line_str = None
    total_span = soup.select_one("#TaxEst1_lblTotalTax")
    if total_span:
        total_line_str = clean_text(total_span.get_text())

    header_cells = [clean_text(c.get_text()) for c in rows[0].find_all(["th","td"])]
    col_headers = [h for h in header_cells[1:]]

    named_rows: Dict[str, List[str]] = {}
    for r in rows[1:]:
        th = r.find("th")
        label = clean_text(th.get_text()) if th else ""
        tds = [clean_text(td.get_text()) for td in r.find_all("td")]
        flat = clean_text(r.get_text())
        if "total estimated taxes" in flat.lower():
            if not total_line_str:
                last_cell = (r.find_all("td") or r.find_all("th"))[-1]
                total_line_str = clean_text(last_cell.get_text())
            continue
        if label:
            named_rows[label.upper()] = tds

    def row_vals(*names: str) -> List[str]:
        for n in names:
            v = named_rows.get(n.upper())
            if v:
                return v
        return []

    taxing_j = row_vals("TAXING JURISDICTION")
    rate_per_100 = row_vals("TAX RATE PER $100", "TAX RATE PER $100.00", "TAX RATE")
    taxable_value = row_vals("TAXABLE VALUE", "TAXABLE VALUES")
    est_taxes = row_vals("ESTIMATED TAXES", "ESTIMATED TAX")
    tax_ceiling = row_vals("TAX CEILING", "TAX CEILINGS")

    def bucket_for(label: str) -> str:
        lab = (label or "").lower()
        if "school" in lab or "isd" in lab:
            return "school"
        if "college" in lab:
            return "college"
        if "hospital" in lab:
            return "hospital"
        if "county" in lab:
            return "county"
        if "special" in lab:
            return "special_district"
        return "city"

    buckets: Dict[str, Any] = {}
    for idx, col in enumerate(col_headers):
        b = bucket_for(col)
        buckets[b] = {
            "taxing_unit": taxing_j[idx] if idx < len(taxing_j) else "N/A",
            "tax_rate_per_100": rate_per_100[idx] if idx < len(rate_per_100) else "N/A",
            "taxable_value": taxable_value[idx] if idx < len(taxable_value) else "N/A",
            "estimated_taxes": est_taxes[idx] if idx < len(est_taxes) else "N/A",
            "tax_ceiling": tax_ceiling[idx] if idx < len(tax_ceiling) else "N/A",
        }

    for k in ("city","school","county","college","hospital","special_district"):
        if k not in buckets:
            buckets[k] = {"taxing_unit":"N/A","tax_rate_per_100":"N/A","taxable_value":"N/A","estimated_taxes":"N/A","tax_ceiling":"N/A"}

    return buckets, _num_or_na(total_line_str), "OK"


# ------------------------------------------------------------
# History (unchanged from earlier v2)
# ------------------------------------------------------------

def _history_find_section_table(soup: BeautifulSoup, anchor_name: str, header_text: str) -> Optional[Tag]:
    anc = soup.find(lambda t: t.name in ("a","A") and t.has_attr("name") and str(t.get("name","")).lower() == anchor_name.lower())
    if anc:
        cur: Optional[Tag] = anc
        for _ in range(20):
            cur = cur.find_next(["table"])
            if cur and (cur.find("th") or cur.find("td")):
                return cur
    return _table_after_heading(soup, header_text)

def _iter_direct_cells(tbl: Tag):
    for el in (getattr(tbl, "contents", []) or []):
        if getattr(el, "name", None) in ("th","td"):
            yield el
        if getattr(el, "name", None) == "tr":
            for c in el.find_all(["th","td"], recursive=False):
                yield c

def parse_history_owner_table(history_html: str) -> List[Dict[str, Any]]:
    soup = BeautifulSoup(history_html, "html.parser")
    tbl = _history_find_section_table(soup, "Owner", "Owner / Legal")
    out: List[Dict[str, Any]] = []
    if not tbl:
        return out

    DATE_RE = re.compile(r"(\b[0-1]?\d[\/\-][0-3]?\d[\/\-](?:[0-9]{2}|[0-9]{4})\b|\b[12][0-9]{3}\b)")

    def extract_deed_date_from_cell(cell: Tag | None) -> str:
        if not cell:
            return "N/A"
        inner = cell.find("table")
        if inner:
            for r in inner.find_all("tr"):
                cells = r.find_all(["th","td"])
                if not cells:
                    continue
                if len(cells) >= 2:
                    label = clean_text(cells[0].get_text())
                    value = clean_text(cells[1].get_text())
                    if re.search(r"deed.*date", label, re.I):
                        m = DATE_RE.search(value) or DATE_RE.search(label)
                        if m:
                            return clean_text(m.group(1))
                row_text = clean_text(r.get_text(" "))
                if re.search(r"deed.*date", row_text, re.I):
                    m = DATE_RE.search(row_text)
                    if m:
                        return clean_text(m.group(1))
        flat = clean_text(cell.get_text(" "))
        m_labelled = re.search(r"deed.*date\s*[:\-]?\s*" + DATE_RE.pattern, flat, re.I)
        if m_labelled:
            return clean_text(m_labelled.groups()[-1])
        m_any = DATE_RE.search(flat)
        if m_any:
            return clean_text(m_any.group(1))
        return "N/A"

    got_any = False
    for tr in tbl.find_all("tr"):
        th = tr.find("th")
        tds = tr.find_all("td", recursive=False)
        if not th or len(tds) < 2:
            continue
        year_txt = clean_text(th.get_text())
        if not re.fullmatch(r"\d{4}", year_txt or ""):
            continue
        got_any = True
        year = int(year_txt)
        owner_raw = clean_text(tds[0].get_text(separator=" ").replace("\xa0"," "))
        owner = re.sub(r"\s+"," ", owner_raw).strip() or "N/A"
        right_cell = tds[1]
        deed_date = extract_deed_date_from_cell(right_cell)

        legal_lines: List[str] = []
        inner = right_cell.find("table")
        if inner:
            for r in inner.find_all("tr"):
                cells = r.find_all(["th","td"])
                if not cells:
                    continue
                label = clean_text(cells[0].get_text()) if len(cells) >= 1 else ""
                if re.search(r"deed.*date", label or "", re.I):
                    continue
                vals = [clean_text(c.get_text()) for c in cells[1:]] if len(cells) > 1 else []
                for v in vals:
                    if v:
                        legal_lines.append(v)
        else:
            lines = [clean_text(x) for x in right_cell.get_text(separator="\n").split("\n")]
            for ln in lines:
                if ln and not re.search(r"deed.*date", ln, re.I):
                    legal_lines.append(ln)

        out.append({"year": year, "owner": owner, "legal_description": legal_lines, "deed_transfer_date": deed_date})

    if got_any:
        return out

    cells = list(_iter_direct_cells(tbl))
    i = 0
    while i + 2 < len(cells):
        c0, c1, c2 = cells[i], cells[i+1], cells[i+2]
        if getattr(c0, "name", None) == "th" and getattr(c1, "name", None) == "td" and getattr(c2, "name", None) == "td":
            year_txt = clean_text(c0.get_text())
            if re.fullmatch(r"\d{4}", year_txt or ""):
                year = int(year_txt)
                owner_raw = clean_text(c1.get_text(separator=" ").replace("\xa0"," "))
                owner = re.sub(r"\s+"," ", owner_raw).strip() or "N/A"
                deed_date = extract_deed_date_from_cell(c2)

                legal_lines: List[str] = []
                inner = c2.find("table")
                if inner:
                    for r in inner.find_all("tr"):
                        cells2 = r.find_all(["th","td"])
                        if not cells2:
                            continue
                        label = clean_text(cells2[0].get_text()) if len(cells2) >= 1 else ""
                        if re.search(r"deed.*date", label or "", re.I):
                            continue
                        vals = [clean_text(cc.get_text()) for cc in cells2[1:]] if len(cells2) > 1 else []
                        for v in vals:
                            if v:
                                legal_lines.append(v)
                else:
                    lines = [clean_text(x) for x in c2.get_text(separator="\n").split("\n")]
                    for ln in lines:
                        if ln and not re.search(r"deed.*date", ln, re.I):
                            legal_lines.append(ln)

                out.append({"year": year, "owner": owner, "legal_description": legal_lines, "deed_transfer_date": deed_date})
                i += 3
                continue
        i += 1
    return out


# ------------------------------------------------------------
# Exemption details page (unchanged from earlier v2)
# ------------------------------------------------------------

def parse_exemption_details(details_html: str | None) -> Dict[str, Any]:
    if not details_html:
        return {"details_url": "N/A"}
    soup = BeautifulSoup(details_html, "html.parser")
    details_url = None
    form = soup.find("form", id="Form1")
    if form and form.get("action"):
        details_url = form.get("action")
    out: Dict[str, Any] = {"details_url": details_url or "N/A"}

    two_col_parent = None
    for outer in soup.find_all("table"):
        trs = outer.find_all("tr", recursive=False)
        if len(trs) != 1:
            continue
        tds = trs[0].find_all("td", recursive=False)
        if len(tds) != 2:
            continue
        left_tbl = tds[0].find("table")
        right_tbl = tds[1].find("table")
        if left_tbl and right_tbl:
            two_col_parent = (left_tbl, right_tbl)
            break

    def _norm_key(lbl: str, section: str | None = None) -> str:
        s = (lbl or "").strip().lower()
        s = s.replace("%"," pct ").replace("/"," ").replace("&"," ")
        s = re.sub(r"[^a-z0-9]+","_", s).strip("_")
        return f"{section}_{s}" if section else (s or (section or "field"))

    if two_col_parent:
        left_tbl, right_tbl = two_col_parent
        left_rows = [clean_text((tr.find(["th","td"]) or tr).get_text()) for tr in left_tbl.find_all("tr")]
        right_rows = [clean_text((tr.find("td") or tr).get_text()) for tr in right_tbl.find_all("tr")]
        n = min(len(left_rows), len(right_rows))
        current_section = None
        for i in range(n):
            label = left_rows[i]
            value = right_rows[i]
            if not label:
                continue
            lab_up = label.strip().upper()
            if lab_up == "ISD":
                current_section = "isd"; continue
            if lab_up == "COUNTY":
                current_section = "county"; continue
            key = _norm_key(label, current_section)
            out[key] = value if value else "N/A"
        return out

    tbl = soup.find("table")
    if not tbl:
        return out
    kv = {}
    for tr in tbl.find_all("tr"):
        tds = tr.find_all(["th","td"])
        if len(tds) >= 2:
            k = clean_text(tds[0].get_text())
            v = clean_text(tds[1].get_text())
            if k:
                kv[_norm_key(k)] = v or "N/A"
    out.update(kv)
    return out


# ------------------------------------------------------------
# Value summary & ARB hearing (unchanged), plus hardened parse_owner
# ------------------------------------------------------------

def parse_property_location(soup: BeautifulSoup) -> Dict[str, Any]:
    def txt_by_id(id_):
        el = soup.find(id=id_)
        return clean_text(el.get_text()) if el else None

    # Primary selectors used on DCAD
    # Prefer structured extraction that handles <br/> and embedded Bldg/Suite tokens
    addr_el = soup.find(id="PropAddr1_lblPropAddr")
    address = None
    if addr_el:
        raw = addr_el.get_text(" ", strip=True)
        # Drop building identifier (keep suite only)
        raw = re.sub(r"\bBldg:\s*\S+\b", "", raw, flags=re.I)
        # Normalize Suite/Ste to ", Suite X"
        raw = re.sub(r"\s*(Suite|Ste)\s*[:.]?\s*", ", Suite ", raw, flags=re.I)
        # Collapse multiple spaces and stray commas
        raw = re.sub(r"\s+,\s+", ", ", raw)
        raw = re.sub(r"\s{2,}", " ", raw).strip(" ,")
        address = clean_text(raw) or None
    else:
        address = txt_by_id("PropAddr1_lblPropAddr")
    neighborhood = txt_by_id("lblNbhd")
    mapsco = txt_by_id("lblMapsco")

    # Fallback: search for common id patterns if address missing
    if not address:
        cand = soup.find(lambda t: getattr(t, "name", "") and t.get("id") and any(k in t.get("id", "").lower() for k in ["propaddr", "situs", "siteaddr", "lblsitus", "lblpropaddr"]))
        if cand:
            try:
                address = clean_text(cand.get_text()) or None
            except Exception:
                address = None

    # Last resort: look for a header containing "Property Address" and take the next table/text
    if not address:
        hdr = soup.find(lambda t: getattr(t, "name", "") in ("span", "b", "strong", "h3") and "property address" in (t.get_text(strip=True) or "").lower())
        if hdr:
            nxt = hdr.find_next(string=True)
            if nxt:
                address = clean_text(str(nxt)) or None

    # Expose core elements of the situs/subject area
    # Include 'subject_address' inside property_location for clients expecting it within this section
    return {"address": address, "subject_address": address, "neighborhood": neighborhood, "mapsco": mapsco}

def parse_owner(soup: BeautifulSoup) -> Dict[str, Any]:
    owner_span = soup.find(id="lblOwner")
    owner_name = None
    mailing_address = None
    multi_owner: List[Dict[str, Any]] = []

    if owner_span:
        lines: List[str] = []
        for cur in owner_span.next_siblings:
            # Stop conditions
            name = (getattr(cur, "name", "") or "").lower()
            if name == "table" and hasattr(cur, "get") and cur.get("id", "") == "MultiOwner1_dgmultiOwner":
                break
            if hasattr(cur, "get") and cur.get("class") and "DtlSectionHdr" in (cur.get("class") or []):
                break
            # Only collect from Tag-like things
            if isinstance(cur, NavigableString):
                text = clean_text(str(cur))
            elif hasattr(cur, "get_text"):
                text = clean_text(cur.get_text(" ").strip())
            else:
                text = ""
            if text:
                low = text.lower()
                if "multi-owner" in low:
                    break
                if "owner name" in low and "ownership" in low:
                    break
                lines.append(text)
        # Heuristic: first line is often the owner name; subsequent lines comprise mailing address
        non_empty = [ln for ln in lines if ln]
        if non_empty:
            # Heuristic: first line is primary owner; second may be co-owner or start of address
            name1 = re.sub(r"owner name\s*ownership\s*%.*$", "", non_empty[0], flags=re.I).strip(", ")
            name2 = non_empty[1] if len(non_empty) > 1 else ""

            def looks_like_address(s: str) -> bool:
                s_low = s.lower()
                return bool(
                    re.search(r"\d", s) or "," in s or
                    re.search(r"\b(tx|texas|[A-Z]{2})\b", s, flags=re.I) or
                    re.search(r"\b\d{5}(?:-\d{4})?\b", s)
                )

            if name2 and not looks_like_address(name2) and len(name2) <= 40:
                owner_name = clean_text(f"{name1} {name2}") or None
                rest = non_empty[2:]
            else:
                owner_name = clean_text(name1) or None
                rest = non_empty[1:]

            if rest:
                # Keep only address-like lines (street/city/state/zip), drop labels like 'Multi-Owner', 'Owner Name', etc.
                def looks_like_address(s: str) -> bool:
                    s_low = (s or "").lower()
                    if any(k in s_low for k in ["multi-owner", "owner name", "ownership %", "application received", "hs application", "ownership", "owner("]):
                        return False
                    # City/state or ZIP present
                    if re.search(r"\b(tx|texas|[A-Z]{2})\b", s, flags=re.I):
                        return True
                    if re.search(r"\b\d{5}(?:-\d{4})?\b", s):
                        return True
                    # Street line: starts with a number or contains common street tokens
                    if re.search(r"^\s*\d+\s+", s):
                        return True
                    if re.search(r"\b(apt|unit|#|ct|ln|rd|dr|st|ave|blvd|hwy|pkwy|cir|trl|way|lane|drive|court|road)\b", s_low):
                        return True
                    # Comma-separated name,city might be acceptable
                    if "," in s:
                        return True
                    return False
                addr_lines = [ln for ln in rest if looks_like_address(ln)]
                if addr_lines:
                    mailing_joined = ", ".join(addr_lines)
                    mailing_address = clean_text(mailing_joined).replace(" ,", ",").strip(", ") or None

    mo = soup.find(id="MultiOwner1_dgmultiOwner")
    if mo:
        rows = mo.find_all("tr")
        for tr in rows[1:]:
            tds = [clean_text(td.get_text()) for td in tr.find_all("td")]
            if len(tds) >= 2:
                multi_owner.append({"owner_name": tds[0] or "N/A", "ownership_pct": tds[1] or "N/A"})

    out = {"owner_name": owner_name or "N/A", "multi_owner": multi_owner}
    # Always include mailing_address key for downstream consistency (may be None)
    out["mailing_address"] = mailing_address if mailing_address else None
    return out

def parse_legal_description(soup: BeautifulSoup) -> Dict[str, Any]:
    lines: List[str] = []
    for i in range(1, 8):
        el = soup.find(id=f"LegalDesc1_lblLegal{i}")
        if el:
            val = clean_text(el.get_text())
            if val:
                lines.append(val)
    sale_date_el = soup.find(id="LegalDesc1_lblSaleDate")
    sale_date = clean_text(sale_date_el.get_text()) if sale_date_el else None
    return {"lines": lines, "deed_transfer_date": sale_date}

def parse_value_summary(soup: BeautifulSoup) -> Dict[str, Any]:
    vs = {
        "certified_year": None,
        "improvement_value": "N/A",
        "land_value": "N/A",
        "market_value": "N/A",
        "capped_value": "N/A",
        "tax_agent": "N/A",
        "revaluation_year": None,
        "previous_revaluation_year": None,
    }
    year_lbl = soup.select_one("#tblValueSum #ValueSummary1_lblApprYr")
    if year_lbl:
        m = re.search(r"(20\d{2})", year_lbl.get_text())
        if m:
            try:
                vs["certified_year"] = int(m.group(1))
            except Exception:
                vs["certified_year"] = m.group(1)

    vs["improvement_value"] = _txt(soup.select_one("#tblValueSum #ValueSummary1_lblImpVal"))
    land_el = soup.select_one("#tblValueSum #ValueSummary1_pnlValue_lblLandVal") or soup.select_one("#tblValueSum #ValueSummary1_lblLandVal")
    vs["land_value"] = _txt(land_el)
    vs["market_value"] = _txt(soup.select_one("#tblValueSum #ValueSummary1_pnlValue_lblTotalVal") or soup.select_one("#tblValueSum #ValueSummary1_lblTotalVal"))

    tbl = soup.select_one("#tblValueSum")
    if tbl:
        row = tbl.find(string=lambda s: isinstance(s, str) and "Capped Value:" in s)
        if row:
            parent = row.find_parent("tr") or row.find_parent()
            if parent:
                fv = parent.select_one(".FieldValue")
                if fv:
                    vs["capped_value"] = _txt(fv)

        # Extract Tax Agent if present (handles single-row colspan or label/value patterns)
        try:
            # Look for a FieldTitle that contains 'Tax Agent'
            lab = tbl.find(lambda t: t and t.name in ("span","td","th") and re.search(r"tax\s*agent", clean_text(t.get_text() or ""), re.I) and (t.get("class") and any("FieldTitle" in c for c in t.get("class", []))))
            if lab:
                parent_tr = lab.find_parent("tr")
                val = None
                if parent_tr:
                    fv = parent_tr.select_one(".FieldValue")
                    if fv:
                        val = _txt(fv, "")
                if not val:
                    # fallback: next .FieldValue in DOM after label
                    nxt = lab.find_next(class_=re.compile(r"FieldValue", re.I))
                    if nxt:
                        val = _txt(nxt, "")
                if val:
                    vs["tax_agent"] = val
            else:
                # Fallback: search for literal text 'Tax Agent' anywhere in the table
                node = tbl.find(string=lambda s: isinstance(s, str) and re.search(r"tax\s*agent", s, re.I))
                if node:
                    row = node.find_parent("tr") or node.find_parent()
                    if row:
                        fv = row.select_one(".FieldValue") or row.find_next(class_=re.compile(r"FieldValue", re.I))
                        if fv:
                            vs["tax_agent"] = _txt(fv)
        except Exception:
            pass

    vs["revaluation_year"] = to_num(_txt(soup.select_one("#tblValueSum #ValueSummary1_lblRevalYr"), "")) or None
    vs["previous_revaluation_year"] = to_num(_txt(soup.select_one("#tblValueSum #ValueSummary1_lblPrevRevalYr"), "")) or None

    if vs["land_value"] == "N/A":
        try:
            imp_n = to_num(vs["improvement_value"]) if vs["improvement_value"] and vs["improvement_value"] != "N/A" else None
            mkt_n = to_num(vs["market_value"]) if vs["market_value"] and vs["market_value"] != "N/A" else None
            if imp_n is not None and mkt_n is not None and mkt_n >= imp_n:
                land_calc = mkt_n - imp_n
                if land_calc >= 0:
                    vs["land_value"] = f"${int(round(land_calc)):,.0f}"
        except Exception:
            pass
    return vs

def parse_arb_hearing(soup: BeautifulSoup) -> Dict[str, Any]:
    info_el = soup.find(id="lblHearingDate")
    info = clean_text(info_el.get_text()) if info_el else None
    return {"hearing_info": info} if info else {}


# ------------------------------------------------------------
# Public entry
# ------------------------------------------------------------

def parse_detail_html(
    account_html: str | None = None,
    history_html: str | None = None,
    exemption_details_html: str | None = None,
    exemption_details_history_html: str | None = None,
    html: str | None = None,
    **_unused: Any,
) -> Dict[str, Any]:
    if account_html is None and html is not None:
        account_html = html
    if not account_html:
        raise ValueError("parse_detail_html: account_html (or html) is required")

    soup = BeautifulSoup(account_html, "html.parser")

    property_location = parse_property_location(soup)
    owner = parse_owner(soup)
    legal_description = parse_legal_description(soup)
    value_summary = parse_value_summary(soup)
    arb_hearing = parse_arb_hearing(soup)

    main_improvement = parse_main_improvement(soup)
    ai_tbl = _resolve_additional_improvements_table(soup)
    additional_improvements = parse_additional_improvements(ai_tbl) if ai_tbl else []

    sec_rows: List[Dict[str, Any]] = []
    for r in (additional_improvements or []):
        imp_num = r.get("number") or r.get("imp_num")
        if imp_num is None:
            continue
        sec_rows.append({
            "imp_num": imp_num,
            "imp_type": r.get("improvement_type") or r.get("imp_type") or "N/A",
            "imp_desc": r.get("description") or r.get("desc") or r.get("imp_desc"),
            "year_built": r.get("year_built"),
            "construction": r.get("construction"),
            "floor_type": r.get("floor") or r.get("floor_type"),
            "ext_wall": r.get("exterior_wall") or r.get("ext_wall"),
            "num_stories": r.get("num_stories"),
            "area_size": r.get("area_sqft") or r.get("area_size"),
            "value": r.get("value"),
            "depreciation": r.get("depreciation"),
        })

    estimated_taxes, total_est_str, tax_status = parse_estimated_taxes(soup)
    exemptions = parse_exemptions_sections(soup)
    land_detail = parse_land_detail(soup)

    tax_year = None
    the_hdr = soup.find(string=lambda x: x and "certified values" in str(x).lower())
    if the_hdr:
        m = re.search(r"(20\d{2})", str(the_hdr))
        tax_year = int(m.group(1)) if m else None

    history = {"history_url": "N/A","owner_history": [],"market_value": [],"taxable_value": [],"exemptions": []}
    if history_html:
        hsoup = BeautifulSoup(history_html, "html.parser")
        form = hsoup.find("form", id="Form1")
        if form and form.get("action"):
            history["history_url"] = form.get("action")
        history["owner_history"] = parse_history_owner_table(history_html)
        history["market_value"] = parse_history_market_value(history_html)
        history["taxable_value"] = parse_history_taxable_value(history_html)
        history["exemptions"] = parse_history_exemptions(history_html)

    exemption_details = parse_exemption_details(exemption_details_html)

    # Parse Exemption Details History page into per-year rows if provided
    def _parse_exempt_details_history_all(details_hist_html: str | None) -> List[Dict[str, Any]]:
        if not details_hist_html:
            return []
        hsoup = BeautifulSoup(details_hist_html, "html.parser")
        def norm_label(lbl: str) -> str:
            s = clean_text(lbl or "").lower()
            s = s.replace("%", " pct ").replace("/", " ").replace("&", " and ")
            s = re.sub(r"[^a-z0-9]+", "_", s).strip("_")
            return s or "field"
        results: List[Dict[str, Any]] = []
        for sp in hsoup.find_all("span", class_="DtlSectionHdr"):
            ytxt = clean_text(sp.get_text())
            if not re.fullmatch(r"\d{4}", ytxt):
                continue
            year = int(ytxt)
            # Collect subsequent tables until next year header
            year_tables: List[Tag] = []  # type: ignore[name-defined]
            for el in sp.next_elements:
                if getattr(el, "name", None) == "span" and "DtlSectionHdr" in (el.get("class") or []):
                    break
                if getattr(el, "name", None) == "table":
                    year_tables.append(el)

            # Heuristic: left labels table contains many rows of single <th> labels including 'Applicant Name'
            def is_labels_table(t: Tag) -> bool:  # type: ignore[name-defined]
                # Must not contain nested tables (avoids picking the outer container)
                if t.find("table"):
                    return False
                trs = t.find_all("tr")
                if len(trs) < 6:
                    return False
                th_count = sum(1 for _ in t.find_all("th"))
                if th_count < 6:
                    return False
                labels = [clean_text((tr.find(["th","td"]) or tr).get_text()) for tr in trs]
                joined = " ".join(labels).lower()
                return ("applicant" in joined and "ownership" in joined and "homestead" in joined)

            left_idx = None
            for i, t in enumerate(year_tables):
                if is_labels_table(t):
                    left_idx = i
                    break

            fields: Dict[str, Any] = {}
            if left_idx is not None:
                # Right values table is usually the next table after labels
                right_tbl = None
                for j in range(left_idx + 1, len(year_tables)):
                    cand = year_tables[j]
                    # Skip any nested containers (those with nested tables)
                    if cand.find("table"):
                        continue
                    td_count = sum(1 for _ in cand.find_all("td"))
                    th_count = sum(1 for _ in cand.find_all("th"))
                    if td_count >= 6 and th_count <= 2:
                        right_tbl = cand
                        break

                # Extract ordered labels (support single-cell rows or multi-cell header rows)
                label_rows: List[str] = []
                for tr in year_tables[left_idx].find_all("tr"):
                    cells = tr.find_all(["th", "td"]) or []
                    if not cells:
                        continue
                    if len(cells) == 1:
                        txt = clean_text(cells[0].get_text())
                        if txt:
                            label_rows.append(txt)
                    else:
                        for c in cells:
                            txt = clean_text(c.get_text())
                            if txt:
                                label_rows.append(txt)

                value_rows = []
                if right_tbl is not None:
                    for tr in right_tbl.find_all("tr"):
                        # take first td text in the row
                        td = tr.find("td")
                        val = clean_text(td.get_text()) if td else clean_text(tr.get_text())
                        if val is not None:
                            value_rows.append(val)

                # Map labels to keys by normalization and known synonyms
                def key_for(label: str) -> str:
                    base = norm_label(label)
                    # Common remaps
                    remap = {
                        "applicant_name": "applicant_name",
                        "ownership_pct": "ownership_pct",
                        "homestead_date": "homestead_date",
                        "homestead_pct": "homestead_pct",
                        "other": "other",
                        "other_pct": "other_pct",
                        "other_disabled_date": "other_disabled_date",
                        "disabled_person": "disabled_person",
                        "disabled_pct": "disabled_pct",
                        "tax_deferred": "tax_deferred",
                        "transferred": "transferred",
                        "defer": "defer",
                        "capped_homestead": "capped_homestead",
                        "market_value": "market_value",
                    }
                    # Additional alias handling
                    aliases = {
                        "ownership": "ownership_pct",
                        "homestead_percent": "homestead_pct",
                        "other_disabled": "other_disabled_date",
                        "disabled": "disabled_person",
                        "disabled_percent": "disabled_pct",
                        "tax_deferred_": "tax_deferred",
                    }
                    if base in remap:
                        return remap[base]
                    for k, v in aliases.items():
                        if base.startswith(k):
                            return v
                    return base

                n = min(len(label_rows), len(value_rows)) if value_rows else 0
                for i in range(n):
                    k = key_for(label_rows[i])
                    v = value_rows[i] if value_rows and i < len(value_rows) else ""
                    fields[k] = v

            results.append({"year": year, "fields": fields})
        results.sort(key=lambda r: r.get("year") or 0, reverse=True)
        return results

    exemptions_table = _parse_exempt_details_history_all(exemption_details_history_html)

    detail_obj = {
        "parser_version": PARSER_VERSION,
        "tax_year": tax_year,
        "property_location": property_location,
        "owner": owner,
        "legal_description": legal_description,
        "value_summary": value_summary,
        "arb_hearing": arb_hearing,

        "primary_improvements": main_improvement,
        "secondary_improvements": sec_rows,

        # Maintain legacy key and add plural alias for clients expecting main_improvements
        "main_improvement": main_improvement,
        "main_improvements": main_improvement,
        "additional_improvements": sec_rows,

        "land_detail": land_detail,
        "exemptions": exemptions,
        "exemption_summary": [],

        "estimated_taxes": estimated_taxes,
        "estimated_taxes_total": _num_or_na(total_est_str),
        "estimated_taxes_status": tax_status,

        "history": history,
        "exemption_details": exemption_details,
    }
    if exemptions_table:
        detail_obj["exemptions_table"] = exemptions_table

    # Subject address is now part of property_location; no separate top-level copy
    return detail_obj
