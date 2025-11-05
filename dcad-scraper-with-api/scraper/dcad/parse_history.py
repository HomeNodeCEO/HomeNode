# scraper/dcad/parse_history.py

from __future__ import annotations
from typing import Any, Dict, List, Optional
import re
from bs4 import BeautifulSoup, Tag

# -----------------------
# Small helpers / cleaning
# -----------------------
_WS_RE = re.compile(r"\s+")
def _norm(s: str | None) -> str:
    if s is None:
        return ""
    return _WS_RE.sub(" ", s).strip()

def _to_year_or_none(txt: str | None) -> Optional[int]:
    t = _norm(txt)
    m = re.fullmatch(r"\d{4}", t)
    return int(m.group(0)) if m else None

def _history_find_section_table(soup: BeautifulSoup, *keywords: str) -> Optional[Tag]:
    """
    Find the first <table> that follows a section header <span class="DtlSectionHdr">
    whose text contains all given keywords (case-insensitive).
    """
    wanted = [k.lower() for k in keywords]
    for sp in soup.find_all("span", class_="DtlSectionHdr"):
        hdr = _norm(sp.get_text()).lower()
        if all(k in hdr for k in wanted):
            # walk forward until the first table (but stop on next section header)
            for el in sp.next_elements:
                if getattr(el, "name", None) == "span" and "DtlSectionHdr" in (el.get("class") or []):
                    break
                if getattr(el, "name", None) == "table":
                    return el
    return None

# ---------------------------------------
# Owner / Legal History (keep as you had)
# ---------------------------------------
# This parser supports both the compact <tr> layout and the multi-line nested
# legal-description layout DCAD uses on the Owner / Legal section.
# (Unchanged logic you already validated.)
_SALE_DATE_SPAN_ID_RE = re.compile(r"lblSaleDate\b", re.I)
_LEGAL_SPAN_ID_RE = re.compile(r"lblLegal\d+", re.I)
_DATE_LABEL_RE = re.compile(r"^\s*Deed\s+Transfer\s+Date\s*:\s*$", re.I)

def parse_owner_legal_history_from_soup(soup: BeautifulSoup) -> List[Dict[str, Any]]:
    tbl = _history_find_section_table(soup, "owner", "legal")
    if not tbl:
        return []

    out: List[Dict[str, Any]] = []
    rows = list(tbl.find_all(["tr", "th", "td"]))
    i = 0
    while i < len(rows):
        node = rows[i]
        # Pattern A: year appears as <th>YEAR</th><td>Owner…</td><td>…legal…(nested table)</td>
        if node.name == "th":
            year_text = _norm(node.get_text(" ", strip=True))
            if re.fullmatch(r"\d{4}", year_text):
                year = int(year_text)
                # Expect two following cells: owner TD and legal TD
                # move to next sibling TD/TH nodes
                owner_td, legal_td = None, None
                j = i + 1
                picked = []
                while j < len(rows) and len(picked) < 2:
                    if rows[j].name in ("td", "th"):
                        picked.append(rows[j])
                    j += 1
                if len(picked) == 2:
                    owner_td, legal_td = picked

                    owner_lines = [s for s in _norm(owner_td.get_text("\n", strip=True)).split("\n") if s]
                    legal_lines: List[str] = []
                    deed_raw, deed_iso = None, None

                    # Prefer explicit <span id="...lblLegalN">
                    spans = legal_td.find_all(lambda t: isinstance(t, Tag) and t.name == "span"
                                              and _LEGAL_SPAN_ID_RE.search(t.get("id","")))
                    if spans:
                        for sp in spans:
                            txt = _norm(sp.get_text(" ", strip=True))
                            if txt:
                                legal_lines.append(txt)
                    else:
                        # Fallback: collect <td> text in the nested table
                        for td in legal_td.find_all("td"):
                            txt = _norm(td.get_text(" ", strip=True))
                            if txt and not re.fullmatch(r"\d+:\s*", txt):
                                legal_lines.append(txt)

                    # Deed transfer date, if present
                    sale_span = legal_td.find(lambda t: isinstance(t, Tag) and t.name == "span"
                                              and _SALE_DATE_SPAN_ID_RE.search(t.get("id","")))
                    if sale_span:
                        deed_raw = _norm(sale_span.get_text(" ", strip=True))
                        # simple YYYY-MM-DD normalization attempt
                        m_dmy = re.search(r"(\d{1,2})/(\d{1,2})/(\d{4})", deed_raw or "")
                        if m_dmy:
                            mm, dd, yy = m_dmy.groups()
                            deed_iso = f"{yy}-{int(mm):02d}-{int(dd):02d}"

                    out.append({
                        "observed_year": year,
                        "owner_lines": owner_lines,
                        "legal_description_lines": legal_lines,
                        "deed_transfer_date_raw": deed_raw,
                        "deed_transfer_date_iso": deed_iso,
                    })
                i = j
                continue

        # Pattern B: well-formed table row
        if node.name == "tr":
            cells = node.find_all(["th","td"], recursive=False)
            if len(cells) >= 3:
                year_text = _norm(cells[0].get_text(" ", strip=True))
                if re.fullmatch(r"\d{4}", year_text):
                    year = int(year_text)
                    owner_td, legal_td = cells[1], cells[2]
                    owner_lines = [s for s in owner_td.get_text("\n", strip=True).split("\n") if s.strip()]

                    legal_lines, deed_raw, deed_iso = [], None, None
                    spans = legal_td.find_all(lambda t: isinstance(t, Tag) and t.name == "span"
                                              and _LEGAL_SPAN_ID_RE.search(t.get("id","")))
                    if spans:
                        for sp in spans:
                            txt = _norm(sp.get_text(" ", strip=True))
                            if txt: legal_lines.append(txt)
                    else:
                        for td in legal_td.find_all("td"):
                            txt = _norm(td.get_text(" ", strip=True))
                            if txt and not re.fullmatch(r"\d+:\s*", txt):
                                legal_lines.append(txt)

                    sale_span = legal_td.find(lambda t: isinstance(t, Tag) and t.name == "span"
                                              and _SALE_DATE_SPAN_ID_RE.search(t.get("id","")))
                    if sale_span:
                        deed_raw = _norm(sale_span.get_text(" ", strip=True))
                        m_dmy = re.search(r"(\d{1,2})/(\d{1,2})/(\d{4})", deed_raw or "")
                        if m_dmy:
                            mm, dd, yy = m_dmy.groups()
                            deed_iso = f"{yy}-{int(mm):02d}-{int(dd):02d}"

                    out.append({
                        "observed_year": year,
                        "owner_lines": owner_lines,
                        "legal_description_lines": legal_lines,
                        "deed_transfer_date_raw": deed_raw,
                        "deed_transfer_date_iso": deed_iso,
                    })
        i += 1

    out.sort(key=lambda r: r.get("observed_year", 0), reverse=True)
    return out

# ---------------------------------------
# Market Value History (strings preserved)
# ---------------------------------------
def parse_market_value_history_from_soup(soup: BeautifulSoup) -> List[Dict[str, Any]]:
    """
    Expected columns:
      Year | Improvement | Land | Total Market | Homestead Capped
    Returns raw cell strings for all value fields (year is int).
    """
    # 1) Real table id on DCAD history page
    tbl = soup.find("table", id="MarketHistory1_dgMarketHist")
    # 2) Legacy/alt id we’ve seen on some pages (keep as a fallback)
    if not tbl:
        tbl = soup.find("table", id="TaxHistory1_dgHistMktValue")
    # 3) Relaxed fallback by section header (no 'History' required)
    if not tbl:
        tbl = _history_find_section_table(soup, "market", "value")
    if not tbl:
        return []

    rows = tbl.find_all("tr")
    if not rows:
        return []

    hdr_cells = [_norm(th.get_text()) for th in rows[0].find_all(["th", "td"])]
    idx = {"year": None, "improvement": None, "land": None, "total_market": None, "homestead_capped": None}
    for i, h in enumerate(hdr_cells):
        hl = h.lower()
        if "year" in hl and idx["year"] is None: idx["year"] = i
        elif ("improvement" in hl or "impr" in hl) and idx["improvement"] is None: idx["improvement"] = i
        elif "land" in hl and idx["land"] is None: idx["land"] = i
        elif ("total market" in hl or (("market" in hl) and ("total" in hl))) and idx["total_market"] is None: idx["total_market"] = i
        elif ("homestead" in hl and "cap" in hl) and idx["homestead_capped"] is None: idx["homestead_capped"] = i

    out: List[Dict[str, Any]] = []
    for tr in rows[1:]:
        cells = [td.get_text(" ", strip=True) for td in tr.find_all("td")]
        if not cells:
            continue
        year_txt = cells[idx["year"]] if idx["year"] is not None and idx["year"] < len(cells) else ""
        y = _to_year_or_none(year_txt)
        if not y:
            continue

        out.append({
            "year": y,
            "improvement": cells[idx["improvement"]] if idx["improvement"] is not None and idx["improvement"] < len(cells) else "N/A",
            "land": cells[idx["land"]] if idx["land"] is not None and idx["land"] < len(cells) else "N/A",
            "total_market": cells[idx["total_market"]] if idx["total_market"] is not None and idx["total_market"] < len(cells) else "N/A",
            "homestead_capped": cells[idx["homestead_capped"]] if idx["homestead_capped"] is not None and idx["homestead_capped"] < len(cells) else "N/A",
        })

    out.sort(key=lambda r: r["year"], reverse=True)
    return out

# ----------------------------------------
# Taxable Value History (strings preserved)
# ----------------------------------------
def parse_taxable_value_history_from_soup(soup: BeautifulSoup) -> List[Dict[str, Any]]:
    """
    Expected columns:
      Year | City | ISD | County | College | Hospital | Special District
    Returns raw cell strings for all value fields (year is int).
    """
    # 1) Real table id on DCAD history page
    tbl = soup.find("table", id="TaxHistory1_dgTaxHistory")
    # 2) Relaxed fallback by section header (no 'History' required)
    if not tbl:
        tbl = _history_find_section_table(soup, "taxable", "value")
    if not tbl:
        return []

    rows = tbl.find_all("tr")
    if not rows:
        return []

    hdr_cells = [_norm(th.get_text()) for th in rows[0].find_all(["th", "td"])]
    idx = {"year": None, "city": None, "isd": None, "county": None, "college": None, "hospital": None, "special_district": None}
    for i, h in enumerate(hdr_cells):
        hl = h.lower()
        if "year" in hl and idx["year"] is None: idx["year"] = i
        elif "city" in hl and idx["city"] is None: idx["city"] = i
        elif ("isd" in hl or "school" in hl) and idx["isd"] is None: idx["isd"] = i
        elif "county" in hl and idx["county"] is None: idx["county"] = i
        elif "college" in hl and idx["college"] is None: idx["college"] = i
        elif "hospital" in hl and idx["hospital"] is None: idx["hospital"] = i
        elif ("special" in hl and "district" in hl) and idx["special_district"] is None: idx["special_district"] = i

    out: List[Dict[str, Any]] = []
    for tr in rows[1:]:
        cells = [td.get_text(" ", strip=True) for td in tr.find_all("td")]
        if not cells:
            continue
        year_txt = cells[idx["year"]] if idx["year"] is not None and idx["year"] < len(cells) else ""
        y = _to_year_or_none(year_txt)
        if not y:
            continue

        out.append({
            "year": y,
            "city": cells[idx["city"]] if idx["city"] is not None and idx["city"] < len(cells) else "N/A",
            "isd": cells[idx["isd"]] if idx["isd"] is not None and idx["isd"] < len(cells) else "N/A",
            "county": cells[idx["county"]] if idx["county"] is not None and idx["county"] < len(cells) else "N/A",
            "college": cells[idx["college"]] if idx["college"] is not None and idx["college"] < len(cells) else "N/A",
            "hospital": cells[idx["hospital"]] if idx["hospital"] is not None and idx["hospital"] < len(cells) else "N/A",
            "special_district": cells[idx["special_district"]] if idx["special_district"] is not None and idx["special_district"] < len(cells) else "N/A",
        })

    out.sort(key=lambda r: r["year"], reverse=True)
    return out

# -------------------------------------------------
# Exemptions History (strings; structured per year)
# -------------------------------------------------
_EXEMPT_CAT_ALIASES = {
    "city": "city",
    "isd": "school",
    "school": "school",
    "county": "county",
    "college": "college",
    "hospital": "hospital",
    "special district": "special_district",
    "specialdistrict": "special_district",
    "special dist": "special_district",
}

def _canon_category(label: str) -> Optional[str]:
    t = _norm(label).lower()
    t = t.replace("\xa0", " ").replace("  ", " ")
    if t in _EXEMPT_CAT_ALIASES:
        return _EXEMPT_CAT_ALIASES[t]
    # try exact matches after simple normalization
    return _EXEMPT_CAT_ALIASES.get(t.replace("  ", " "), None)

def parse_exemptions_history_from_soup(soup: BeautifulSoup) -> List[Dict[str, Any]]:
    """
    For each year, return:
    {
      "year": 2025,
      "exemptions": {
        "city":   {"taxing_jurisdiction": "...", "homestead_exemption": "...", "taxable_value": "..."},
        "school": {"taxing_jurisdiction": "...", "homestead_exemption": "...", "taxable_value": "..."},
        "county": {...},
        "college": {...},
        "hospital": {...},
        "special_district": {...}
      }
    }
    If a year shows “No Exemptions”, we return {"year": YYYY, "exemptions": {}}.
    All values are strings exactly as seen on the page (no numeric conversion).
    """
    tbl = _history_find_section_table(soup, "exempt")
    if not tbl:
        return []

    out: List[Dict[str, Any]] = []
    for tr in tbl.find_all("tr"):
        cells = tr.find_all(["th", "td"], recursive=False)
        if len(cells) < 2:
            continue

        y = _to_year_or_none(cells[0].get_text())
        if not y:
            continue

        body_td = cells[1]
        body_text = _norm(body_td.get_text(" ", strip=True)).lower()

        # Case 1: explicit "No Exemptions"
        if "no exemptions" in body_text:
            out.append({"year": y, "exemptions": {}})
            continue

        inner = body_td.find("table")
        if not inner:
            # absent or unexpected structure; return empty block rather than guessing
            out.append({"year": y, "exemptions": {}})
            continue

        inner_rows = inner.find_all("tr")
        if not inner_rows:
            out.append({"year": y, "exemptions": {}})
            continue

        # Header row should contain the 6 categories
        header_cells = [_norm(td.get_text()) for td in inner_rows[0].find_all(["th", "td"])]
        categories: List[str] = []
        for h in header_cells:
            key = _canon_category(h)
            if key:
                categories.append(key)
        # Be tolerant if they slipped an empty header cell:
        categories = [c for c in categories if c]

        if not categories:
            out.append({"year": y, "exemptions": {}})
            continue

        # Helper to extract the row that begins with a label like "Taxing Jurisdiction", "HOMESTEAD EXEMPTION", "Taxable Value"
        def find_values(prefixes: List[str]) -> List[str]:
            for r in inner_rows[1:]:
                tds = [_norm(td.get_text()) for td in r.find_all(["th", "td"])]
                if not tds:
                    continue
                head = tds[0].lower()
                if any(p in head for p in prefixes):
                    return tds[1:1+len(categories)]
            return []

        taxing = find_values(["taxing jurisdiction"])
        home_ex = find_values(["homestead exemption", "homestead", "exemption"])
        taxable = find_values(["taxable value"])

        # Build result map per category
        ex_map: Dict[str, Dict[str, str]] = {}
        for i, cat in enumerate(categories):
            ex_map[cat] = {
                "taxing_jurisdiction": taxing[i] if i < len(taxing) and taxing[i] else "N/A",
                "homestead_exemption": home_ex[i] if i < len(home_ex) and home_ex[i] else "N/A",
                "taxable_value": taxable[i] if i < len(taxable) and taxable[i] else "N/A",
            }

        out.append({"year": y, "exemptions": ex_map})

    out.sort(key=lambda r: r["year"], reverse=True)
    return out

# ---------------------------
# Public entry point (merges)
# ---------------------------
def parse_history_html(html: str) -> Dict[str, Any]:
    soup = BeautifulSoup(html, "lxml")

    owner_legal = parse_owner_legal_history_from_soup(soup)
    market_rows = parse_market_value_history_from_soup(soup)
    taxable_rows = parse_taxable_value_history_from_soup(soup)
    exemptions = parse_exemptions_history_from_soup(soup)

    return {
        "owner_history": owner_legal,
        "market_value": market_rows,
        "taxable_value": taxable_rows,
        "exemptions": exemptions,
    }
