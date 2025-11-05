# parse_detail.py
# --------------------------------------------------------------------
# Parse a DCAD "Account Detail" HTML page into a normalized JSON dict.
# Focus: robust capture for:
#   - primary_improvements.desirability (+ desirability_raw)
#   - primary_improvements.total_living_area (with strong backfills)
# Returns ONLY:
#   - primary_improvements
#   - secondary_improvements
#   - arb_hearing
#   - value_summary
# --------------------------------------------------------------------

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Tuple

from bs4 import BeautifulSoup


# ----------------------------- Helpers --------------------------------

_ws = re.compile(r"\s+")

def _t(s: Optional[str]) -> Optional[str]:
    """Tidy text -> stripped single-spaced string or None."""
    if s is None:
        return None
    s = s.strip()
    if not s:
        return None
    return _ws.sub(" ", s)

def _money_to_num(s: Optional[str]) -> Optional[float]:
    """Parse money-like strings: $302,630 -> 302630.0 ; 'N/A' -> None."""
    if s is None:
        return None
    s = s.strip()
    if not s or s.upper() == "N/A":
        return None
    cleaned = re.sub(r"[^0-9\.\-]", "", s)
    if cleaned in ("", "-", ".", "-."):
        return None
    try:
        return float(cleaned)
    except ValueError:
        return None

def _intish(s: Optional[str]) -> Optional[int]:
    """Parse integer-ish text (gracefully)."""
    if s is None:
        return None
    s = s.strip()
    if not s or s.upper() == "N/A":
        return None
    cleaned = re.sub(r"[^\d\-]", "", s)
    if cleaned in ("", "-"):
        return None
    try:
        return int(cleaned)
    except ValueError:
        return None

def _floatish(s: Optional[str]) -> Optional[float]:
    if s is None:
        return None
    s = s.strip()
    if not s or s.upper() == "N/A":
        return None
    cleaned = re.sub(r"[^0-9\.\-]", "", s)
    if cleaned in ("", "-", ".", "-."):
        return None
    try:
        return float(cleaned)
    except ValueError:
        return None

def _pct_to_num(s: Optional[str]) -> Optional[float]:
    """Convert '25%' or '100' to float (percent as numeric, not fraction)."""
    if s is None:
        return None
    s = s.strip()
    if not s or s.upper() == "N/A":
        return None
    cleaned = re.sub(r"[^0-9\.\-]", "", s)
    if cleaned in ("", "-", ".", "-."):
        return None
    try:
        return float(cleaned)
    except ValueError:
        return None

def _stories_to_num(s: Optional[str]) -> Optional[float]:
    """Try to coerce 'ONE STORY', '1', '1.5' -> float."""
    if s is None:
        return None
    raw = s.strip().upper()
    if not raw or raw == "N/A":
        return None
    words = {"ONE": 1.0, "TWO": 2.0, "THREE": 3.0, "FOUR": 4.0}
    first = raw.split()[0]
    if first in words:
        return words[first]
    val = _floatish(s)
    if val is not None:
        return val
    return None

def _label_match(txt: str, patterns: List[re.Pattern]) -> Optional[str]:
    """Return normalized label key if any compiled regex matches."""
    t = _t(txt)
    if t is None:
        return None
    for pat in patterns:
        m = pat.search(t)
        if m:
            if "key" in pat.groupindex:
                return m.group("key").lower()
            return t.lower()
    return None

def _table_kv_pairs(table) -> List[Tuple[str, str]]:
    """
    Parse a 2-col (or label/value style) table into (label, value) pairs.
    Accepts rows like:
      - <tr><th>Label</th><td>Value</td></tr>
      - <tr><td>Label</td><td>Value</td></tr>
    """
    out: List[Tuple[str, str]] = []
    if table is None:
        return out
    for tr in table.find_all("tr"):
        cells = tr.find_all(["th", "td"])
        if len(cells) < 2:
            continue
        label = _t(cells[0].get_text(" ", strip=True))
        value = _t(cells[1].get_text(" ", strip=True))
        if label is None:
            continue
        out.append((label, value or ""))
    return out


# ----------------------- Primary Improvements --------------------------

# Flexible patterns to catch label variations
_PAT_LBL = {
    "building_class": [
        re.compile(r"\b(building\s*class|bldg\s*class)\b", re.I),
        re.compile(r"\bclass\b", re.I),
    ],
    "year_built": [re.compile(r"\byear\s*built\b", re.I)],
    "effective_year_built": [
        re.compile(r"\beffective\s*year\s*built\b", re.I),
        re.compile(r"\b(eff(?:ective)?\.*\s*yr\.?\s*built)\b", re.I),
    ],
    "actual_age": [re.compile(r"\b(actual\s*age|age)\b", re.I)],
    "desirability": [re.compile(r"\bdesirability\b", re.I)],
    "desirability_id": [
        re.compile(r"\bdesirability\s*id\b", re.I),
        re.compile(r"\bdesirability\s*code\b", re.I),
    ],
    "living_area_sqft": [
        re.compile(r"\b(living\s*area|liv\.?\s*area)\b", re.I),
        re.compile(r"\bliving\s*area\s*\(sq\s*?ft\)\b", re.I),
    ],
    "total_living_area": [
        re.compile(r"\b(total\s*living\s*area)\b", re.I),
        re.compile(r"\b(tla|tot\s*liv(?:ing)?\s*area)\b", re.I),
    ],
    "total_area_sqft": [
        re.compile(r"\b(total\s*area)\b", re.I),
        re.compile(r"\b(gla|gross\s*liv(?:ing)?\s*area)\b", re.I),
    ],
    "percent_complete": [re.compile(r"\b(percent\s*complete|%?\s*complete)\b", re.I)],
    "stories": [re.compile(r"\bstories?\b", re.I)],
    "stories_raw": [re.compile(r"\bstories?\b", re.I)],
    "depreciation": [re.compile(r"\bdepreciation\b", re.I)],
    "construction_type": [
        re.compile(r"\bconstruction\s*type\b", re.I),
        re.compile(r"\bconstruction\b", re.I),
    ],
    "foundation": [re.compile(r"\bfoundation\b", re.I)],
    "roof_type": [re.compile(r"\broof\s*type\b", re.I)],
    "roof_material": [re.compile(r"\broof\s*material\b", re.I)],
    "fence_type": [re.compile(r"\bfence\s*type\b", re.I)],
    "exterior_material": [
        re.compile(r"\bexterior\s*material\b", re.I),
        re.compile(r"\bexterior\b", re.I),
    ],
    "basement_raw": [re.compile(r"\bbasement\b", re.I)],
    "basement": [re.compile(r"\bbasement\b", re.I)],
    "heating": [re.compile(r"\bheating\b", re.I)],
    "air_conditioning": [
        re.compile(r"\bair\s*conditioning\b", re.I),
        re.compile(r"\bA/C\b", re.I),
    ],
    "baths_full": [
        re.compile(r"\bbaths?\s*full\b", re.I),
        re.compile(r"\bfull\s*bath", re.I),
    ],
    "baths_half": [
        re.compile(r"\bbaths?\s*half\b", re.I),
        re.compile(r"\bhalf\s*bath", re.I),
    ],
    "kitchens": [re.compile(r"\bkitchens?\b", re.I)],
    "wetbars": [re.compile(r"\bwet\s*bars?\b", re.I)],
    "fireplaces": [re.compile(r"\bfireplaces?\b", re.I)],
    "sprinkler": [re.compile(r"\bsprinkler\b", re.I)],
    "deck": [re.compile(r"\bdeck\b", re.I)],
    "spa": [re.compile(r"\bspa\b", re.I)],
    "pool": [re.compile(r"\bpool\b", re.I)],
    "sauna": [re.compile(r"\bsauna\b", re.I)],
    "building_class_alt": [re.compile(r"\bbldg\s*class\b", re.I)],
}

def _match_key(label: str) -> Optional[str]:
    """Return a normalized key name for a table label, else None."""
    for key, pats in _PAT_LBL.items():
        if _label_match(label, pats):
            if key == "building_class_alt":
                return "building_class"
            if key == "basement_raw":
                return "basement_raw"
            return key
    return None

def _extract_primary_improvements(soup: BeautifulSoup) -> Dict[str, Any]:
    """
    Find 'Main/Primary Improvements' and parse into a dict.
    Includes hard ID overrides for desirability + areas (non-destructive).
    """

    # ----------------- BEGIN: Hard ID overrides for two fields -----------------
    def _txt_by_id(id_):
        el = soup.find(id=id_)
        return el.get_text(" ", strip=True) if el else None

    def _area_to_int(s: Optional[str]) -> Optional[int]:
        if not s:
            return None
        cleaned = re.sub(r"[^\d\-]", "", s)
        if cleaned in ("", "-"):
            return None
        try:
            return int(cleaned)
        except ValueError:
            return None

    desirability_val = _txt_by_id("MainImpRes1_lblCDU")            # e.g., "GOOD"
    living_area_val  = _txt_by_id("MainImpRes1_lblLivingArea")     # e.g., "2,115 sqft"
    total_area_val   = _txt_by_id("MainImpRes1_lblTotalArea")      # e.g., "2,115 sqft"

    # Initialize output schema so we can safely set these first.
    data: Dict[str, Any] = {
        "building_class": None,
        "year_built": None,
        "effective_year_built": None,
        "actual_age": None,
        "desirability": None,
        "desirability_raw": None,
        "desirability_id": None,
        "living_area_sqft": None,
        "total_living_area": None,
        "total_area_sqft": None,
        "percent_complete": None,
        "stories": None,
        "stories_raw": None,
        "depreciation": None,
        "construction_type": None,
        "foundation": None,
        "roof_type": None,
        "roof_material": None,
        "fence_type": None,
        "exterior_material": None,
        "basement_raw": None,
        "basement": None,
        "heating": None,
        "air_conditioning": None,
        "baths_full": None,
        "baths_half": None,
        "kitchens": None,
        "wetbars": None,
        "fireplaces": None,
        "sprinkler": None,
        "deck": None,
        "spa": None,
        "pool": None,
        "sauna": None,
    }

    # 1) Desirability from ID (authoritative but non-destructive)
    if desirability_val:
        data["desirability_raw"] = desirability_val
        data["desirability"] = desirability_val.strip().upper()

    # 2) Areas from IDs (authoritative), with bulletproof backfill
    la_num = _area_to_int(living_area_val)
    ta_num = _area_to_int(total_area_val)

    if la_num is not None:
        data["living_area_sqft"] = la_num
    if ta_num is not None:
        data["total_area_sqft"] = ta_num

    # Prefer total_area_sqft as total_living_area, else living_area_sqft
    if data["total_living_area"] is None:
        if data["total_area_sqft"] is not None:
            data["total_living_area"] = data["total_area_sqft"]
        elif data["living_area_sqft"] is not None:
            data["total_living_area"] = data["living_area_sqft"]
    # ------------------ END: Hard ID overrides for two fields ------------------

    # Strategy: try strong nearby header first; else pattern-based fallback.
    candidates = []
    for hdr in soup.find_all(["h2", "h3", "h4", "caption", "strong"]):
        text = _t(hdr.get_text(" ", strip=True))
        if not text:
            continue
        if re.search(r"\b(main|primary)\s+improvement", text, re.I) or \
           re.search(r"\bbuilding\s+information\b", text, re.I):
            tbl = hdr.find_next("table")
            if tbl:
                candidates.append(tbl)

    if not candidates:
        for tbl in soup.find_all("table"):
            kv = _table_kv_pairs(tbl)
            if not kv or len(kv) < 4:
                continue
            labels = " ".join([x[0].lower() for x in kv])
            if ("year" in labels and "built" in labels) or ("desirability" in labels):
                candidates.append(tbl)
                break

    if not candidates:
        return data  # nothing else found; keep the ID-derived values and defaults

    # Use first candidate table that yields something
    for tbl in candidates:
        kv = _table_kv_pairs(tbl)
        if not kv:
            continue

        # pass 1: gather raw values keyed by normalized label keys
        raw_map: Dict[str, str] = {}
        for label, val in kv:
            key = _match_key(label)
            if not key:
                continue
            raw_map[key] = val

            # capture desirability_raw explicitly (won't override earlier non-empty)
            if key == "desirability" and not data.get("desirability_raw"):
                data["desirability_raw"] = val

        # pass 2: normalize into output schema (do NOT clobber non-empty ID fields)
        if not data.get("building_class"):
            data["building_class"] = _t(raw_map.get("building_class") or raw_map.get("building_class_alt"))

        if data.get("year_built") is None:
            data["year_built"] = _intish(raw_map.get("year_built"))
        if data.get("effective_year_built") is None:
            data["effective_year_built"] = _intish(raw_map.get("effective_year_built"))
        if data.get("actual_age") is None:
            data["actual_age"] = _intish(raw_map.get("actual_age"))

        # desirability (normalize to upper-case word if present)
        if not data.get("desirability"):
            desir = _t(raw_map.get("desirability"))
            if desir:
                data["desirability"] = desir.upper()
                if not data.get("desirability_raw"):
                    data["desirability_raw"] = desir
        # desirability_id if a numeric code exists (rare)
        if data.get("desirability_id") is None:
            data["desirability_id"] = _intish(raw_map.get("desirability_id"))

        # living area (prefer existing ID-derived; else from table)
        if data.get("living_area_sqft") is None:
            data["living_area_sqft"] = _intish(raw_map.get("living_area_sqft"))

        # total living area: prefer existing value; else from table
        if data.get("total_living_area") is None:
            data["total_living_area"] = _intish(raw_map.get("total_living_area"))

        # total area as fallback (prefer existing ID-derived; else from table)
        if data.get("total_area_sqft") is None:
            data["total_area_sqft"] = _intish(raw_map.get("total_area_sqft"))

        # If total_living_area still missing, backfill from total_area_sqft, then living_area_sqft
        if data["total_living_area"] is None:
            if data["total_area_sqft"] is not None:
                data["total_living_area"] = data["total_area_sqft"]
            elif data["living_area_sqft"] is not None:
                data["total_living_area"] = data["living_area_sqft"]

        # percent complete (as number, not fraction)
        if data.get("percent_complete") is None:
            data["percent_complete"] = _pct_to_num(raw_map.get("percent_complete"))

        # stories: numeric + raw
        if data.get("stories_raw") is None or data.get("stories") is None:
            stories_raw = raw_map.get("stories_raw") or raw_map.get("stories")
            if stories_raw:
                data["stories_raw"] = _t(stories_raw)
                data["stories"] = _stories_to_num(stories_raw)

        if data.get("depreciation") is None:
            data["depreciation"] = _pct_to_num(raw_map.get("depreciation"))

        if not data.get("construction_type"):
            data["construction_type"] = _t(raw_map.get("construction_type"))
        if not data.get("foundation"):
            data["foundation"] = _t(raw_map.get("foundation"))
        if not data.get("roof_type"):
            data["roof_type"] = _t(raw_map.get("roof_type"))
        if not data.get("roof_material"):
            data["roof_material"] = _t(raw_map.get("roof_material"))
        if not data.get("fence_type"):
            data["fence_type"] = _t(raw_map.get("fence_type"))
        if not data.get("exterior_material"):
            data["exterior_material"] = _t(raw_map.get("exterior_material"))

        # basement raw and boolean
        if data.get("basement_raw") is None:
            b_raw = _t(raw_map.get("basement_raw") or raw_map.get("basement"))
            data["basement_raw"] = b_raw
            if b_raw:
                data["basement"] = None if b_raw.upper() == "UNASSIGNED" else (b_raw.upper() not in ("NO", "NONE", "N/A"))
            else:
                data["basement"] = None

        if not data.get("heating"):
            data["heating"] = _t(raw_map.get("heating"))
        if not data.get("air_conditioning"):
            data["air_conditioning"] = _t(raw_map.get("air_conditioning"))
        if data.get("baths_full") is None:
            data["baths_full"] = _intish(raw_map.get("baths_full"))
        if data.get("baths_half") is None:
            data["baths_half"] = _intish(raw_map.get("baths_half"))
        if data.get("kitchens") is None:
            data["kitchens"] = _intish(raw_map.get("kitchens"))
        if data.get("wetbars") is None:
            data["wetbars"] = _intish(raw_map.get("wetbars"))
        if data.get("fireplaces") is None:
            data["fireplaces"] = _intish(raw_map.get("fireplaces"))

        if data.get("sprinkler") is None:
            spr = _t(raw_map.get("sprinkler"))
            data["sprinkler"] = None if spr is None else (spr.upper() not in ("NO", "NONE", "N/A"))

        if not data.get("deck"):
            data["deck"] = _t(raw_map.get("deck"))
        if data.get("spa") is None:
            spa = _t(raw_map.get("spa"))
            data["spa"] = None if spa is None else (spa.upper() not in ("NO", "NONE", "N/A"))
        if data.get("pool") is None:
            pool = _t(raw_map.get("pool"))
            data["pool"] = None if pool is None else (pool.upper() not in ("NO", "NONE", "N/A"))
        if data.get("sauna") is None:
            sau = _t(raw_map.get("sauna"))
            data["sauna"] = None if sau is None else (sau.upper() not in ("NO", "NONE", "N/A"))

        # Parsed successfully; stop after first good table
        break

    return data


# ----------------------- Secondary Improvements ------------------------

def _extract_secondary_improvements(soup: BeautifulSoup) -> List[Dict[str, Any]]:
    """
    Parse a 'Secondary Improvements' table into a list of rows.
    We keep strings where exact tokens matter; parse obvious numerics.
    """
    # Find by nearby header
    tbl = None
    for hdr in soup.find_all(["h2", "h3", "h4", "caption", "strong"]):
        tx = _t(hdr.get_text(" ", strip=True))
        if not tx:
            continue
        if re.search(r"\bsecondary\s+improvements?\b", tx, re.I):
            cand = hdr.find_next("table")
            if cand:
                tbl = cand
                break

    # Fallback: any table that looks like a secondary improvements grid
    if tbl is None:
        for cand in soup.find_all("table"):
            head = cand.find("thead") or cand.find("tr")
            if not head:
                continue
            header_txt = _t(head.get_text(" ", strip=True) if head else "")
            if not header_txt:
                continue
            if re.search(r"\bimp\b.*(type|desc)|year\s*built|ext\s*wall|area|sq\s*ft", header_txt, re.I):
                tbl = cand
                break

    if tbl is None:
        return []

    rows = tbl.find_all("tr")
    if not rows:
        return []

    # Header map
    header_cells = rows[0].find_all(["th", "td"])
    headers = [_t(c.get_text(" ", strip=True)) or "" for c in header_cells]
    colmap = {}
    for i, h in enumerate(headers):
        hl = (h or "").lower()
        if "imp" in hl and ("no" in hl or "#" in hl or "num" in hl):
            colmap["imp_num"] = i
        elif "type" in hl:
            colmap["imp_type"] = i
        elif "desc" in hl:
            colmap["imp_desc"] = i
        elif "year" in hl and "built" in hl:
            colmap["year_built"] = i
        elif "construction" in hl:
            colmap["construction"] = i
        elif "floor" in hl:
            colmap["floor_type"] = i
        elif ("ext" in hl and "wall" in hl) or "exterior" in hl:
            colmap["ext_wall"] = i
        elif "storie" in hl:
            colmap["num_stories"] = i
        elif "area" in hl or "sq ft" in hl or "sqft" in hl:
            colmap["area_size"] = i
        elif "value" in hl:
            colmap["value"] = i
        elif "depreciation" in hl:
            colmap["depreciation"] = i

    out: List[Dict[str, Any]] = []
    for tr in rows[1:]:
        tds = tr.find_all("td")
        if not tds:
            continue

        def get(key: str) -> Optional[str]:
            idx = colmap.get(key)
            if idx is None or idx >= len(tds):
                return None
            return _t(tds[idx].get_text(" ", strip=True))

        row = {
            "imp_num": get("imp_num"),
            "imp_type": get("imp_type"),
            "imp_desc": get("imp_desc"),
            "year_built": _intish(get("year_built")),
            "construction": get("construction"),
            "floor_type": get("floor_type"),
            "ext_wall": get("ext_wall"),
            "num_stories": _floatish(get("num_stories")),
            "area_size": _intish(get("area_size")),
            "value": _money_to_num(get("value")),
            "depreciation": _pct_to_num(get("depreciation")),
        }

        if any(v is not None and v != "" for v in row.values()):
            out.append(row)

    return out


# ----------------------------- ARB Hearing -----------------------------

def _extract_arb_hearing(soup: BeautifulSoup) -> Dict[str, Any]:
    """
    Often missing; if not found, return {} to match API contract.
    """
    txt = soup.get_text(" ", strip=True)
    if not txt:
        return {}
    if not re.search(r"\b(ARB|appeal|hearing)\b", txt, re.I):
        return {}
    return {}


# ----------------------------- Value Summary ---------------------------

def _extract_value_summary(soup: BeautifulSoup) -> Dict[str, Any]:
    """No-op placeholder — your pipeline handles this elsewhere."""
    return {}


# ----------------------------- Public API ------------------------------

def parse_detail(html: str) -> Dict[str, Any]:
    """
    Main entry point. Feed it the HTML of a DCAD account detail page.
    Returns a dict that includes only:
      - 'primary_improvements'
      - 'secondary_improvements'
      - 'arb_hearing'
      - 'value_summary'
    """
    soup = BeautifulSoup(html, "lxml")

    primary = _extract_primary_improvements(soup)

    # Final belt-and-suspenders: if total_living_area is empty, adopt TA or LA as-is.
    if primary.get("total_living_area") is None:
        ta = primary.get("total_area_sqft")
        la = primary.get("living_area_sqft")
        if ta is not None:
            primary["total_living_area"] = ta
        elif la is not None:
            primary["total_living_area"] = la

    secondary = _extract_secondary_improvements(soup)
    arb = _extract_arb_hearing(soup)
    value_summary = _extract_value_summary(soup)

    return {
        "primary_improvements": primary,
        "secondary_improvements": secondary,
        "arb_hearing": arb,
        "value_summary": value_summary,
    }


# ----------------------------- CLI Smoke Test --------------------------

if __name__ == "__main__":
    import sys, json, pathlib
    p = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else None
    if not p or not p.exists():
        print("Usage: python parse_detail.py path/to/account_detail.html")
        sys.exit(2)
    html = p.read_text(encoding="utf-8", errors="ignore")
    parsed = parse_detail(html)
    print(json.dumps(parsed, indent=2, ensure_ascii=False))
