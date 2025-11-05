# scraper/dcad/parse_detail.py

from bs4 import BeautifulSoup
import re
from .normalize import clean_text, to_bool, to_num, to_sqft, pct_to_num

# -----------------------------
# Small utilities / helpers
# -----------------------------

def get_any(kv, *keys):
    for k in keys:
        if k in kv and kv[k]:
            return kv[k]
    return ''

def _find_after_header_span(soup, header_id_prefix: str):
    """
    Find a <span class="DtlSectionHdr" id^=header_id_prefix> and return
    the next meaningful <table> after it. Safe against missing headers and
    missing next tables.
    """
    hdr = soup.find(
        lambda t: t.name in ('span',)
        and t.get('class') and 'DtlSectionHdr' in t.get('class')
        and str(t.get('id', '')).lower().startswith(str(header_id_prefix or '').lower())
    )
    if not hdr:
        return None

    cur = hdr
    for _ in range(20):  # be generous but bounded
        cur = cur.find_next('table') if cur else None
        if not cur:
            break
        # Optional: ensure it looks like a data table (has cells)
        if cur.find(['th', 'td']):
            return cur
    return None

def _table_after_heading(soup, heading_text):
    """
    Find a heading-ish element containing heading_text, then return the first
    data table after it. Safe against missing headings and missing tables.
    """
    ht = str(heading_text or '').lower()

    h = soup.find(lambda t: t.name in ('h2','h3','h4','b','strong')
                           and ht in str(t.get_text(strip=True)).lower())
    if not h:
        h = soup.find(lambda t: hasattr(t, 'get_text')
                               and ht in str(t.get_text(strip=True)).lower()
                               and t.has_attr('class') and 'DtlSectionHdr' in t.get('class', []))
    if not h:
        hnode = soup.find(string=lambda x: x and ht in str(x).lower())
        h = hnode.parent if hnode else None
    if not h:
        return None

    cur = h
    for _ in range(20):
        cur = cur.find_next('table') if cur else None
        if not cur:
            break
        if cur.find(['th', 'td']):
            return cur
    return None

def parse_keyvalue_table(tbl):
    out = {}
    for tr in tbl.find_all('tr'):
        cells = tr.find_all(['td','th'])
        texts = [clean_text(c.get_text()) for c in cells]
        for i in range(0, len(texts) - 1, 2):
            k, v = texts[i], texts[i+1]
            if k:
                out[str(k).lower()] = v
    return out

def _stories_to_number(s: str):
    if not s:
        return None
    m = re.search(r'(\d+(\.\d+)?)', s)
    if m:
        return to_num(m.group(1))
    s_up = str(s).upper()
    words = {'ONE':1,'TWO':2,'THREE':3,'FOUR':4,'FIVE':5,'SIX':6}
    for w,n in words.items():
        if w in s_up:
            return n + 0.5 if 'HALF' in s_up else n
    return None

def map_yn_to_none(s: str):
    if s is None:
        return "N/A"
    val = clean_text(s).upper()
    if val in {'N','NO','FALSE','NONE','UNASSIGNED',''}:
        return "NONE"
    if val in {'Y','YES','TRUE','1'}:
        return 'Y'
    return val or "N/A"

def _parse_baths_full_half(kv):
    key = '# baths (full/half)'
    v = kv.get(key)
    if not v:
        return None, None
    parts = [p.strip() for p in v.replace(' ','').split('/')]
    if len(parts) == 2:
        return to_num(parts[0]), to_num(parts[1])
    return None, None

def _num_or_na(text):
    if text is None:
        return "N/A"
    t = clean_text(text)
    return t or "N/A"

def _txt(node, default="N/A"):
    if not node:
        return default
    try:
        t = node.get_text(strip=True)
    except Exception:
        t = str(node) if node else ""
    t = clean_text(t)
    return t if t else default

# -----------------------------
# Page sections
# -----------------------------

def parse_property_location(soup):
    def txt(id_):
        el = soup.find(id=id_)
        return clean_text(el.get_text()) if el else None
    return {
        "address": txt("PropAddr1_lblPropAddr"),
        "neighborhood": txt("lblNbhd"),
        "mapsco": txt("lblMapsco"),
    }

def parse_owner(soup):
    """
    Clean owner_name (name + mailing address only) and multi_owner grid.
    Filters out:
      - "Multi-Owner (Current ...)" banner text
      - Any "Owner Name Ownership %" header text
    Stops collecting owner_name when multi-owner grid or next section header appears.
    """
    owner_span = soup.find(id="lblOwner")
    owner_name = None
    multi_owner = []

    if owner_span:
        lines = []
        cur = owner_span.next_sibling
        for _ in range(30):
            if cur is None:
                break

            # Stop at multi-owner grid
            if str(getattr(cur, 'name', '')).lower() == 'table' and cur.get('id', '') == "MultiOwner1_dgmultiOwner":
                break

            # Stop at a new section header span
            if getattr(cur, 'get', lambda *_: None)('class') and 'DtlSectionHdr' in (cur.get('class') or []):
                break

            # Visible text
            text = clean_text(cur.get_text(separator=' ').strip()) if hasattr(cur, 'get_text') else clean_text(str(cur))
            if text:
                low = str(text).lower()
                if 'multi-owner' in low:
                    break
                if 'owner name' in low and 'ownership' in low:
                    break
                lines.append(text)

            cur = cur.next_sibling

        joined = ', '.join([ln for ln in lines if ln])
        joined = clean_text(joined).replace(' ,', ',').replace('  ', ' ').strip(', ')
        # Defensive strip of any stray header fragment
        joined = re.sub(r'(,\s*)?owner name\s+ownership\s*%.*$', '', joined, flags=re.I).strip(', ')
        owner_name = joined or None

    # Multi-owner grid
    mo = soup.find(id="MultiOwner1_dgmultiOwner")
    if mo:
        rows = mo.find_all('tr')
        for tr in rows[1:]:
            tds = [clean_text(td.get_text()) for td in tr.find_all('td')]
            if len(tds) >= 2:
                multi_owner.append({
                    "owner_name": tds[0] or "N/A",
                    "ownership_pct": tds[1] or "N/A",
                })

    return {"owner_name": owner_name or "N/A", "multi_owner": multi_owner}

def parse_legal_description(soup):
    lines = []
    for i in range(1, 8):
        el = soup.find(id=f"LegalDesc1_lblLegal{i}")
        if el:
            val = clean_text(el.get_text())
            if val:
                lines.append(val)
    sale_date_el = soup.find(id="LegalDesc1_lblSaleDate")
    sale_date = clean_text(sale_date_el.get_text()) if sale_date_el else None
    return {"lines": lines, "deed_transfer_date": sale_date}

# ---------- Value Summary (hardened) ----------

def parse_value_summary(soup):
    """
    Robust parse of Certified Values / Value Summary.
    Uses specific IDs DCAD renders (including underlined Land),
    falls back to table-row parsing and regex, and computes Land = Market - Improvement if needed.
    """
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

    # Year (e.g., "2025 Certified Values")
    year_lbl = soup.select_one("#tblValueSum #ValueSummary1_lblApprYr")
    if year_lbl:
        m = re.search(r"(20\d{2})", year_lbl.get_text())
        if m:
            try:
                vs["certified_year"] = int(m.group(1))
            except Exception:
                vs["certified_year"] = m.group(1)

    # Improvement, Land, Total (Market)
    vs["improvement_value"] = _txt(soup.select_one("#tblValueSum #ValueSummary1_lblImpVal"))
    # Land may be underlined inside a panel; use the specific id under the panel
    land_el = soup.select_one("#tblValueSum #ValueSummary1_pnlValue_lblLandVal") or soup.select_one("#tblValueSum #ValueSummary1_lblLandVal")
    vs["land_value"] = _txt(land_el)
    vs["market_value"] = _txt(soup.select_one("#tblValueSum #ValueSummary1_pnlValue_lblTotalVal") or soup.select_one("#tblValueSum #ValueSummary1_lblTotalVal"))

    # Capped Value (label row has no stable id)
    tbl = soup.select_one("#tblValueSum")
    if tbl:
        row = tbl.find(string=lambda s: isinstance(s, str) and "Capped Value:" in s)
        if row:
            parent = row.find_parent("tr") or row.find_parent()
            if parent:
                fv = parent.select_one(".FieldValue")
                if fv:
                    vs["capped_value"] = _txt(fv)

    # Revaluation years
    vs["revaluation_year"] = to_num(_txt(soup.select_one("#tblValueSum #ValueSummary1_lblRevalYr"), "")) or None
    vs["previous_revaluation_year"] = to_num(_txt(soup.select_one("#tblValueSum #ValueSummary1_lblPrevRevalYr"), "")) or None

    # Tax Agent from the table text
    if tbl:
        table_text = clean_text(tbl.get_text(" "))
        m = re.search(r"Tax Agent:\s*(.+?)\s*(Revaluation Year|Previous Revaluation Year|$)", table_text, re.I)
        if m:
            vs["tax_agent"] = clean_text(m.group(1)) or "N/A"

        # If some fields are still N/A, try key-value scan of rows
        if any(vs[k] == "N/A" for k in ("improvement_value","land_value","market_value","capped_value")):
            kv = {}
            for tr in tbl.find_all('tr'):
                th = tr.find('th')
                td = tr.find('td')
                if not td:
                    continue
                k = clean_text(th.get_text()) if th else ""
                v = clean_text(td.get_text())
                if k:
                    kv[k.lower()] = v

            def _pick(*cands):
                for c in cands:
                    for k in kv.keys():
                        if c in k:
                            return kv[k]
                return None

            if vs["improvement_value"] == "N/A":
                cand = _pick("improvement value", "improvement")
                if cand: vs["improvement_value"] = cand
            if vs["land_value"] == "N/A":
                cand = _pick("land value", "land")
                if cand: vs["land_value"] = cand
            if vs["market_value"] == "N/A":
                cand = _pick("total market", "market value", "total value", "total")
                if cand: vs["market_value"] = cand
            if vs["capped_value"] == "N/A":
                cand = _pick("capped value", "homestead cap", "capped")
                if cand: vs["capped_value"] = cand

    # Safety net: compute land if missing but market & improvement exist
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

def parse_arb_hearing(soup):
    info_el = soup.find(id="lblHearingDate")
    info = clean_text(info_el.get_text()) if info_el else None
    return {"hearing_info": info} if info else {}

# ---------- Main Improvement ----------

def parse_main_improvement(soup):
    mi_tbl = _table_after_heading(soup, 'main improvement') or _find_after_header_span(soup, 'lblmainimp')
    if not mi_tbl:
        return {}

    kv = parse_keyvalue_table(mi_tbl)
    g = lambda k: kv.get(k, '')

    s_text = (g('# stories') or g('stories'))
    s_num = _stories_to_number(s_text)

    bf, bh = _parse_baths_full_half(kv)

    raw_age = get_any(kv, 'actual age', 'age')
    age_num = None
    if raw_age:
        m = re.search(r'-?\d+(?:\.\d+)?', raw_age)
        if m:
            age_num = to_num(m.group(0))

    return {
        "building_class": g('building class'),
        "year_built": to_num(get_any(kv, 'year built', 'built')),
        "effective_year_built": to_num(get_any(kv, 'effective year built', 'eff year built')),
        "actual_age": age_num,
        "desirability": g('desirability'),
        "living_area_sqft": to_sqft(get_any(kv, 'living area', 'liv area', 'area living')),
        "total_area_sqft": to_sqft(get_any(kv, 'total area', 'area total')),
        "percent_complete": to_num(get_any(kv, '% complete', 'percent complete', 'complete %')),
        "stories": s_num,
        "stories_text": s_text,
        "depreciation_pct": pct_to_num(get_any(kv, 'depreciation', 'depr %', 'depreciation %')),
        "construction_type": get_any(kv, 'construction type', 'constr type'),
        "foundation": get_any(kv, 'foundation', 'found type'),
        "roof_type": get_any(kv, 'roof type', 'type roof'),
        "roof_material": get_any(kv, 'roof material', 'material roof'),
        "fence_type": get_any(kv, 'fence type', 'type fence'),
        "exterior_material": get_any(kv, 'ext. wall material', 'exterior wall material'),
        "basement": map_yn_to_none(get_any(kv, 'basement')),
        "heating": get_any(kv, 'heating', 'heat type'),
        "air_conditioning": get_any(kv, 'air condition', 'air conditioning', 'ac type'),
        "baths_full": bf if bf is not None else to_num(get_any(kv, '# baths (full)', 'baths full', 'full baths')),
        "baths_half": bh if bh is not None else to_num(get_any(kv, '# baths (half)', 'baths half', 'half baths')),
        "kitchens": to_num(get_any(kv, '# kitchens', 'kitchens')),
        "wet_bars": to_num(get_any(kv, '# wet bars', 'wet bars')),
        "fireplaces": to_num(get_any(kv, '# fireplaces', 'fireplaces')),
        "sprinkler": map_yn_to_none(get_any(kv, 'sprinkler')),
        "deck": map_yn_to_none(get_any(kv, 'deck')),
        "spa": map_yn_to_none(get_any(kv, 'spa')),
        "pool": map_yn_to_none(get_any(kv, 'pool')),
        "sauna": map_yn_to_none(get_any(kv, 'sauna')),
    }

# ---------- Additional Improvements (guarded) ----------

def parse_additional_improvements(tbl):
    rows = []
    if not tbl:
        return rows
    trs = tbl.find_all('tr')
    if len(trs) <= 1:
        return rows

    header_cells = [clean_text(h.get_text()) for h in trs[0].find_all(['th','td'])]

    # HARD GUARD: if this looks like the Land table, bail out
    land_headers = {'state code','zoning','frontage (ft)','depth (ft)','area','pricing method','unit price','market adjustment','adjusted price','ag land'}
    if any(h.lower() in land_headers for h in header_cells):
        return []

    # Expect something like: No., Improvement Type, Construction, Floor, Exterior Wall, Area (SqFt)
    if len(header_cells) < 5:
        return rows

    for tr in trs[1:]:
        tds = [clean_text(td.get_text()) for td in tr.find_all('td')]
        if len(tds) >= 6:
            num_txt = tds[0]
            number = to_num(num_txt) if num_txt else None
            if number is None and not any(tds[1:]):
                continue
            rows.append({
                "number": number,
                "improvement_type": tds[1] or "N/A",
                "construction": tds[2] or "N/A",
                "floor": tds[3] or "N/A",
                "exterior_wall": tds[4] or "N/A",
                "area_sqft": to_sqft(tds[-1]) if tds[-1] else 0,
            })
    return rows

# ---------- Land ----------

def parse_land_detail_from_table(tbl):
    out = []
    if not tbl:
        return out
    trs = tbl.find_all('tr')
    if len(trs) <= 1:
        return out
    for tr in trs[1:]:
        tds = [clean_text(td.get_text()) for td in tr.find_all('td')]
        if len(tds) >= 11:
            number = to_num(tds[0]) if tds[0] else None
            state_code = tds[1] or "N/A"
            zoning = tds[2] or "N/A"
            frontage_ft = to_num(tds[3])
            depth_ft = to_num(tds[4])
            area_txt = tds[5] or ""
            area_num_part = clean_text(area_txt).split()[0] if area_txt else ""
            area_sqft = to_sqft(area_num_part) if area_num_part else 0
            pricing_method = tds[6] or "N/A"
            unit_price = tds[7] or "N/A"
            market_adj = tds[8] or "N/A"
            adjusted_price = tds[9] or "N/A"
            ag_raw = tds[10] or "N/A"
            ag_land = "NONE"
            s = str(ag_raw).strip().upper()
            if s and s not in {'N','NO','FALSE','NONE','UNASSIGNED'}:
                ag_land = s
            out.append({
                "number": number,
                "state_code": state_code,
                "zoning": zoning,
                "frontage_ft": frontage_ft,
                "depth_ft": depth_ft,
                "area_sqft": area_sqft,
                "pricing_method": pricing_method,
                "unit_price": unit_price,
                "market_adjustment_pct": market_adj,
                "adjusted_price": adjusted_price,
                "ag_land": ag_land,
            })
    return out

def parse_land_detail(soup):
    land_tbl = soup.find(id="Land1_dgLand") or _find_after_header_span(soup, 'lblland') or _table_after_heading(soup, 'land')
    return parse_land_detail_from_table(land_tbl) if land_tbl else []

# ---------- Exemptions (Account page grid) ----------
# This table sometimes lacks a "Taxable Value" row.
# When missing, we will backfill taxable_value from the Estimated Taxes table (if available).

def parse_exemptions_sections(soup):
    ex_tbl = _find_after_header_span(soup, 'lblexempt') or _table_after_heading(soup, 'exemptions')
    if ex_tbl:
        headers = [clean_text(th.get_text()) for th in ex_tbl.find_all('th')]
        if not any(str(h).lower() == 'city' for h in headers):
            nested = ex_tbl.find('table')
            if nested:
                ex_tbl = nested
    if not ex_tbl:
        return {}

    rows = ex_tbl.find_all('tr')
    if len(rows) < 3:
        # We still may be able to read the "Taxable Value" orphan row later
        # but without header & homestead rows, we can't build the grid.
        return {}

    header_cells = rows[0].find_all(['th','td'])
    headers = [clean_text(c.get_text()) for c in header_cells]
    col_headers = headers[1:]  # skip first label cell

    def row_values(row_idx):
        r = rows[row_idx]
        th = r.find('th')
        label = clean_text(th.get_text()) if th else ''
        tds = [clean_text(td.get_text()) for td in r.find_all('td')]
        return label, tds

    # Expected: row1 = Taxing Jurisdiction, row2 = HOMESTEAD EXEMPTION
    _, row1 = row_values(1)
    _, row2 = row_values(2)

    # Try to find a proper <tr> row with "Taxable Value"
    row3 = None
    for r in rows[3:]:
        if 'taxable value' in str(clean_text(r.get_text())).lower():
            row3 = [clean_text(td.get_text()) for td in r.find_all('td')]
            break

    # ---- NEW: handle malformed "Taxable Value" row (orphan <th> with following <td> siblings) ----
    if row3 is None:
        # Look for a TH that says Taxable Value directly under the table (no wrapping <tr>)
        tv_th = None
        for el in ex_tbl.find_all(['th', 'td'], recursive=False):
            if getattr(el, 'name', None) == 'th' and 'taxable value' in clean_text(el.get_text()).lower():
                tv_th = el
                break
        if tv_th:
            # Collect the immediate following TD siblings at the same level
            tds_after = []
            sib = tv_th.next_sibling
            while sib:
                if getattr(sib, 'name', None) == 'td':
                    tds_after.append(clean_text(sib.get_text()))
                sib = sib.next_sibling
            # Use them as the Taxable Value row
            row3 = tds_after

    out = {}
    for idx, col in enumerate(col_headers):
        key = str(col).lower().replace(' ','_')
        tj = row1[idx] if idx < len(row1) else "N/A"
        he = row2[idx] if idx < len(row2) else "N/A"
        tv = row3[idx] if (row3 is not None and idx < len(row3)) else "N/A"
        out[key] = {
            "taxing_jurisdiction": tj or "N/A",
            "homestead_exemption": he or "N/A",
            "taxable_value": tv or "N/A",
        }
    return out

# ---------- Estimated Taxes (Account page grid -> dict by jurisdiction) ----------

def parse_estimated_taxes(soup):
    tbl = _find_after_header_span(soup, 'lblesttax') or _table_after_heading(soup, 'estimated taxes')
    if not tbl:
        return {}, "N/A", "OK"

    rows = [r for r in tbl.find_all('tr') if r.find_all(['th','td'])]
    if len(rows) < 3:
        return {}, "N/A", "OK"

    # NEW: direct read of the labeled total if available
    total_line_str = None
    total_span = soup.select_one("#TaxEst1_lblTotalTax")
    if total_span:
        total_line_str = clean_text(total_span.get_text())

    header_cells = [clean_text(c.get_text()) for c in rows[0].find_all(['th','td'])]
    col_headers = [h for h in header_cells[1:]]

    named_rows = {}
    for r in rows[1:]:
        th = r.find('th')
        label = clean_text(th.get_text()) if th else ''
        tds = [clean_text(td.get_text()) for td in r.find_all('td')]

        flat = clean_text(r.get_text())
        if 'total estimated taxes' in flat.lower():
            # If we didn't already read from span, capture from last cell (th or td)
            if not total_line_str:
                last_cell = (r.find_all('td') or r.find_all('th'))[-1]
                total_line_str = clean_text(last_cell.get_text())
            continue

        if label:
            named_rows[label.upper()] = tds

    # ... remainder of function unchanged ...

    # Normalize known labels (tolerant to slight label changes)
    def row_vals(*names):
        for n in names:
            v = named_rows.get(n.upper())
            if v:
                return v
        return []

    taxing_j = row_vals('TAXING JURISDICTION')
    rate_per_100 = row_vals('TAX RATE PER $100', 'TAX RATE PER $100.00', 'TAX RATE')
    taxable_value = row_vals('TAXABLE VALUE', 'TAXABLE VALUES')
    est_taxes = row_vals('ESTIMATED TAXES', 'ESTIMATED TAX')
    tax_ceiling = row_vals('TAX CEILING', 'TAX CEILINGS')

    def bucket_for(label):
        lab = (label or '').lower()
        if 'school' in lab or 'isd' in lab:
            return 'school'
        if 'college' in lab:
            return 'college'
        if 'hospital' in lab:
            return 'hospital'
        if 'county' in lab:
            return 'county'
        if 'special' in lab:
            return 'special_district'
        return 'city'

    buckets = {}
    for idx, col in enumerate(col_headers):
        b = bucket_for(col)
        buckets[b] = {
            "taxing_unit": taxing_j[idx] if idx < len(taxing_j) else "N/A",
            "tax_rate_per_100": rate_per_100[idx] if idx < len(rate_per_100) else "N/A",
            "taxable_value": taxable_value[idx] if idx < len(taxable_value) else "N/A",
            "estimated_taxes": est_taxes[idx] if idx < len(est_taxes) else "N/A",
            "tax_ceiling": tax_ceiling[idx] if idx < len(tax_ceiling) else "N/A",
        }

    # Fill any missing buckets with N/A rows for consistent shape
    for k in ("city","school","county","college","hospital","special_district"):
        if k not in buckets:
            buckets[k] = {
                "taxing_unit": "N/A",
                "tax_rate_per_100": "N/A",
                "taxable_value": "N/A",
                "estimated_taxes": "N/A",
                "tax_ceiling": "N/A",
            }

    return buckets, _num_or_na(total_line_str), "OK"

# ---------- History parsers (robust) ----------

def _history_find_section_table(soup, anchor_name: str, header_text: str):
    # Safe anchor search
    anc = soup.find(
        lambda t: t.name in ('a', 'A')
        and t.has_attr('name')
        and isinstance(t.get('name'), (str,))
        and str(t.get('name', '')).lower() == str(anchor_name or '').lower()
    )
    if anc:
        cur = anc
        for _ in range(20):
            cur = cur.find_next(['table'])
            if cur and (cur.find('th') or cur.find('td')):
                return cur
    return _table_after_heading(soup, header_text)

def _iter_direct_cells(tbl):
    for el in (getattr(tbl, 'contents', []) or []):
        if getattr(el, 'name', None) in ('th','td'):
            yield el
        if getattr(el, 'name', None) == 'tr':
            for c in el.find_all(['th','td'], recursive=False):
                yield c

def parse_history_owner_table(history_html: str):
    soup = BeautifulSoup(history_html, 'lxml')
    tbl = _history_find_section_table(soup, 'Owner', 'Owner / Legal')
    out = []
    if not tbl:
        return out

    # Accept mm/dd/yyyy, m/d/yy, mm-dd-yyyy, yyyy
    DATE_RE = re.compile(r'(\b[0-1]?\d[\/\-][0-3]?\d[\/\-](?:[0-9]{2}|[0-9]{4})\b|\b[12][0-9]{3}\b)')

    def extract_deed_date_from_cell(cell):
        """
        Robustly pull deed date from a TD cell that may contain:
        - a nested table with label/value pairs
        - inline text like 'Deed Transfer Date: 03/21/2019'
        - scattered text with dates
        """
        if not cell:
            return "N/A"

        # 1) If there is an inner table, look row-by-row for a deed date label
        inner = cell.find('table')
        if inner:
            for r in inner.find_all('tr'):
                cells = r.find_all(['th', 'td'])
                if not cells:
                    continue
                # Try label in first cell, value in second
                if len(cells) >= 2:
                    label = clean_text(cells[0].get_text())
                    value = clean_text(cells[1].get_text())
                    if re.search(r'deed.*date', label, re.I):
                        m = DATE_RE.search(value) or DATE_RE.search(label)
                        if m:
                            return clean_text(m.group(1))
                # If there’s only one cell or label/value are merged, scan entire row text
                row_text = clean_text(r.get_text(" "))
                if re.search(r'deed.*date', row_text, re.I):
                    m = DATE_RE.search(row_text)
                    if m:
                        return clean_text(m.group(1))

        # 2) Flattened text with possible 'Deed ... Date: <value>'
        flat = clean_text(cell.get_text(" "))
        m_labelled = re.search(r'deed.*date\s*[:\-]?\s*' + DATE_RE.pattern, flat, re.I)
        if m_labelled:
            # The final capturing group is the date (by our DATE_RE)
            return clean_text(m_labelled.groups()[-1])

        # 3) Last resort: first date-like token anywhere in the cell
        m_any = DATE_RE.search(flat)
        if m_any:
            return clean_text(m_any.group(1))

        return "N/A"

    # -------- Normal path (well-formed rows) --------
    got_any = False
    for tr in tbl.find_all('tr'):
        th = tr.find('th')
        tds = tr.find_all('td', recursive=False)
        if not th or len(tds) < 2:
            continue
        year_txt = clean_text(th.get_text())
        if not re.fullmatch(r'\d{4}', year_txt or ''):
            continue

        got_any = True
        year = int(year_txt)

        owner_raw = clean_text(tds[0].get_text(separator=' ').replace('\xa0',' '))
        owner = re.sub(r'\s+',' ', owner_raw).strip() or "N/A"

        # legal + deed date live in the right-hand cell (often with a nested table)
        right_cell = tds[1]
        deed_date = extract_deed_date_from_cell(right_cell)

        # Build legal description lines (exclude deed-date label lines if present)
        legal_lines = []
        inner = right_cell.find('table')
        if inner:
            for r in inner.find_all('tr'):
                cells = r.find_all(['th','td'])
                if not cells:
                    continue
                label = clean_text(cells[0].get_text()) if len(cells) >= 1 else ''
                # skip explicit deed/date label rows
                if re.search(r'deed.*date', label or '', re.I):
                    continue
                # add any non-empty values
                vals = [clean_text(c.get_text()) for c in cells[1:]] if len(cells) > 1 else []
                for v in vals:
                    if v:
                        legal_lines.append(v)
        else:
            # No inner table; split by lines and drop any deed/date label lines
            lines = [clean_text(x) for x in right_cell.get_text(separator='\n').split('\n')]
            for ln in lines:
                if ln and not re.search(r'deed.*date', ln, re.I):
                    legal_lines.append(ln)

        out.append({
            "year": year,
            "owner": owner,
            "legal_description": legal_lines,
            "deed_transfer_date": deed_date
        })

    if got_any:
        return out

    # -------- Fallback path (malformed tables) --------
    def _iter_direct_cells(tbl):
        for el in (getattr(tbl, 'contents', []) or []):
            if getattr(el, 'name', None) in ('th','td'):
                yield el
            if getattr(el, 'name', None) == 'tr':
                for c in el.find_all(['th','td'], recursive=False):
                    yield c

    cells = list(_iter_direct_cells(tbl))
    i = 0
    while i + 2 < len(cells):
        c0, c1, c2 = cells[i], cells[i+1], cells[i+2]
        if getattr(c0, 'name', None) == 'th' and getattr(c1, 'name', None) == 'td' and getattr(c2, 'name', None) == 'td':
            year_txt = clean_text(c0.get_text())
            if re.fullmatch(r'\d{4}', year_txt or ''):
                year = int(year_txt)
                owner_raw = clean_text(c1.get_text(separator=' ').replace('\xa0',' '))
                owner = re.sub(r'\s+',' ', owner_raw).strip() or "N/A"

                deed_date = extract_deed_date_from_cell(c2)

                # Build legal lines (same approach as above)
                legal_lines = []
                inner = c2.find('table')
                if inner:
                    for r in inner.find_all('tr'):
                        cells2 = r.find_all(['th','td'])
                        if not cells2:
                            continue
                        label = clean_text(cells2[0].get_text()) if len(cells2) >= 1 else ''
                        if re.search(r'deed.*date', label or '', re.I):
                            continue
                        vals = [clean_text(cc.get_text()) for cc in cells2[1:]] if len(cells2) > 1 else []
                        for v in vals:
                            if v:
                                legal_lines.append(v)
                else:
                    lines = [clean_text(x) for x in c2.get_text(separator='\n').split('\n')]
                    for ln in lines:
                        if ln and not re.search(r'deed.*date', ln, re.I):
                            legal_lines.append(ln)

                out.append({
                    "year": year,
                    "owner": owner,
                    "legal_description": legal_lines,
                    "deed_transfer_date": deed_date
                })
                i += 3
                continue
        i += 1

    return out

def parse_history_market_value(history_html: str):
    soup = BeautifulSoup(history_html, 'lxml')
    tbl = _history_find_section_table(soup, 'Market', 'Market Value')
    rows = []
    if not tbl:
        return rows

    trs = tbl.find_all('tr')
    if len(trs) >= 2:
        for tr in trs[1:]:
            tds = [clean_text(td.get_text()) for td in tr.find_all('td')]
            if len(tds) < 5:
                continue
            y = tds[0]
            if not re.fullmatch(r'\d{4}', y or ''):
                continue
            rows.append({
                "year": int(y),
                "improvement": tds[1] or "N/A",
                "land": tds[2] or "N/A",
                "total_market": tds[3] or "N/A",
                "homestead_capped": tds[4] or "N/A",
            })
        if rows:
            return rows

    cells = [c for c in _iter_direct_cells(tbl) if c.name == 'td']
    for i in range(0, len(cells) - 4, 5):
        y = clean_text(cells[i].get_text())
        if re.fullmatch(r'\d{4}', y or ''):
            rows.append({
                "year": int(y),
                "improvement": clean_text(cells[i+1].get_text()) or "N/A",
                "land": clean_text(cells[i+2].get_text()) or "N/A",
                "total_market": clean_text(cells[i+3].get_text()) or "N/A",
                "homestead_capped": clean_text(cells[i+4].get_text()) or "N/A",
            })
    return rows

def parse_history_taxable_value(history_html: str):
    soup = BeautifulSoup(history_html, 'lxml')
    tbl = _history_find_section_table(soup, 'Taxable', 'Taxable Value')
    rows = []
    if not tbl:
        return rows

    trs = tbl.find_all('tr')
    if len(trs) >= 2:
        for tr in trs[1:]:
            tds = [clean_text(td.get_text()) for td in tr.find_all('td')]
            if len(tds) < 7:
                continue
            y = tds[0]
            if not re.fullmatch(r'\d{4}', y or ''):
                continue
            rows.append({
                "year": int(y),
                "city": tds[1] or "N/A",
                "isd": tds[2] or "N/A",
                "county": tds[3] or "N/A",
                "college": tds[4] or "N/A",
                "hospital": tds[5] or "N/A",
                "special_district": tds[6] or "N/A",
            })
        if rows:
            return rows

    cells = [c for c in _iter_direct_cells(tbl) if c.name == 'td']
    for i in range(0, len(cells) - 6, 7):
        y = clean_text(cells[i].get_text())
        if re.fullmatch(r'\d{4}', y or ''):
            rows.append({
                "year": int(y),
                "city": clean_text(cells[i+1].get_text()) or "N/A",
                "isd": clean_text(cells[i+2].get_text()) or "N/A",
                "county": clean_text(cells[i+3].get_text()) or "N/A",
                "college": clean_text(cells[i+4].get_text()) or "N/A",
                "hospital": clean_text(cells[i+5].get_text()) or "N/A",
                "special_district": clean_text(cells[i+6].get_text()) or "N/A",
            })
    return rows

# ---------- Exemptions History (History page) ----------

def parse_history_exemptions(history_html: str):
    soup = BeautifulSoup(history_html, 'lxml')
    # The exemptions section is below Taxable Value; find by anchor or heading
    tbl = _history_find_section_table(soup, 'Exemptions', 'Exemptions')
    out = []
    if not tbl:
        return out

    trs = tbl.find_all('tr')
    if not trs:
        return out

    # Table is year-first layout (th=year, then a 2-col grid for each jurisdiction),
    # OR sometimes a "No Exemptions" single cell spanning columns for that year.
    for tr in trs:
        th = tr.find('th')
        if not th:
            continue
        year_txt = clean_text(th.get_text())
        if not re.fullmatch(r'\d{4}', year_txt or ''):
            continue
        year = int(year_txt)

        # The remainder of the row contains either:
        #  - a single TD with text "No Exemptions"
        #  - or a TD that holds a nested table with three "lines":
        #       Taxing Jurisdiction / Homestead Exemption / Taxable Value
        tds = tr.find_all('td', recursive=False)
        if not tds:
            # no details
            out.append({"year": year, "exemptions": {}})
            continue

        # If 1 TD and says "No Exemptions"
        if len(tds) == 1 and 'no exemptions' in clean_text(tds[0].get_text()).lower():
            out.append({"year": year, "note": "No Exemptions", "exemptions": {}})
            continue

        # Otherwise we expect the first/second TD to contain a nested table with rows
        second_td = tds[0] if len(tds) == 1 else (tds[1] if len(tds) >= 2 else None)
        inner = second_td.find('table') if second_td else None

        exemptions_map = {}
        if inner:
            rows = inner.find_all('tr')

            # Header row then data rows (one per "line"); headers look like:
            # ['', 'City','School','County','College','Hospital','Special District']
            headers = [clean_text(x.get_text()) for x in rows[0].find_all(['th','td'])] if rows else []
            labels = [h for h in headers[1:]] if headers else []  # skip first label cell

            # Collect each line as a list of column values
            lines = []
            for r in rows[1:]:
                lines.append([clean_text(td.get_text()) for td in r.find_all('td')])

            # Expected lines: 0 = Taxing Jurisdiction, 1 = Homestead Exemption, 2 = Taxable Value
            tj = lines[0][0:len(labels)] if len(lines) > 0 else []
            he = lines[1][0:len(labels)] if len(lines) > 1 else []
            tv = lines[2][0:len(labels)] if len(lines) > 2 else []

            # ---- Fallback for malformed "Taxable Value" row (orphan <th> with sibling <td>s) ----
            if (not tv) or all(not (x or '').strip() for x in tv):
                tv_th = None
                for el in inner.find_all(['th', 'td'], recursive=False):
                    if getattr(el, 'name', None) == 'th' and 'taxable value' in clean_text(el.get_text()).lower():
                        tv_th = el
                        break
                if tv_th:
                    vals = []
                    sib = tv_th.next_sibling
                    while sib:
                        if getattr(sib, 'name', None) == 'td':
                            vals.append(clean_text(sib.get_text()))
                        sib = sib.next_sibling
                    tv = vals[:len(labels)]

            def key_for(label):
                lab = (label or "").lower()
                if 'school' in lab or 'isd' in lab:
                    return 'school'
                if 'college' in lab:
                    return 'college'
                if 'hospital' in lab:
                    return 'hospital'
                if 'county' in lab:
                    return 'county'
                if 'special' in lab:
                    return 'special_district'
                return 'city'

            for i, label in enumerate(labels):
                k = key_for(label)
                exemptions_map[k] = {
                    "taxing_jurisdiction": tj[i] if i < len(tj) and tj[i] else "N/A",
                    "homestead_exemption": he[i] if i < len(he) and he[i] else "N/A",
                    "taxable_value": tv[i] if i < len(tv) and tv[i] else "N/A",
                }

        # Append a record for this year
        out.append({"year": year, "exemptions": exemptions_map})

    return out

# ---------- Exemption Details page ----------

def parse_exemption_details(details_html: str | None):
    if not details_html:
        return {"details_url": "N/A"}

    soup = BeautifulSoup(details_html, 'lxml')

    # capture the form action to show source URL if present
    details_url = None
    form = soup.find('form', id='Form1')
    if form and form.get('action'):
        details_url = form.get('action')

    out = {"details_url": details_url or "N/A"}

    # Find a table whose direct child is a single <tr> with exactly two <td>s,
    # each containing an inner <table> (left = labels, right = values).
    two_col_parent = None
    for outer in soup.find_all('table'):
        trs = outer.find_all('tr', recursive=False)
        if len(trs) != 1:
            continue
        tds = trs[0].find_all('td', recursive=False)
        if len(tds) != 2:
            continue
        left_tbl = tds[0].find('table')
        right_tbl = tds[1].find('table')
        if left_tbl and right_tbl:
            two_col_parent = (left_tbl, right_tbl)
            break

    def _norm_key(lbl: str, section: str | None = None) -> str:
        s = (lbl or "").strip().lower()
        s = s.replace('%', ' pct ').replace('/', ' ').replace('&', ' ')
        s = re.sub(r'[^a-z0-9]+', '_', s).strip('_')
        return f"{section}_{s}" if section else (s or (section or "field"))

    if two_col_parent:
        left_tbl, right_tbl = two_col_parent

        # Row-wise label/value pairing
        left_rows = [clean_text((tr.find(['th','td']) or tr).get_text()) for tr in left_tbl.find_all('tr')]
        right_rows = [clean_text((tr.find('td') or tr).get_text()) for tr in right_tbl.find_all('tr')]
        n = min(len(left_rows), len(right_rows))

        current_section = None  # becomes 'isd' or 'county' when we hit those headers on the left
        for i in range(n):
            label = left_rows[i]
            value = right_rows[i]

            if not label:
                continue

            lab_up = label.strip().upper()
            if lab_up == 'ISD':
                current_section = 'isd'
                continue
            if lab_up == 'COUNTY':
                current_section = 'county'
                continue

            key = _norm_key(label, current_section)
            out[key] = value if value else "N/A"

        return out

    # ---- Fallback to simple label/value table (older pages) ----
    tbl = soup.find('table')
    if not tbl:
        return out

    kv = {}
    for tr in tbl.find_all('tr'):
        tds = tr.find_all(['th','td'])
        if len(tds) >= 2:
            k = clean_text(tds[0].get_text())
            v = clean_text(tds[1].get_text())
            if k:
                kv[_norm_key(k)] = v or "N/A"

    out.update(kv)
    return out

# -----------------------------
# Main parse entry
# -----------------------------

def parse_detail_html(
    account_html: str | None = None,
    history_html: str | None = None,
    exemption_details_html: str | None = None,
    html: str | None = None,
    **_unused,
):
    """
    account_html: required (Account View). For backward-compat, you may also pass html=...
    history_html: optional (History View)
    exemption_details_html: optional (Exemption Details View)
    """
    # Backward compatibility for callers that pass html=...
    if account_html is None and html is not None:
        account_html = html

    if not account_html:
        raise ValueError("account_html (or html) is required")

    soup = BeautifulSoup(account_html, 'lxml')

    property_location = parse_property_location(soup)
    owner = parse_owner(soup)
    legal_description = parse_legal_description(soup)
    value_summary = parse_value_summary(soup)
    arb_hearing = parse_arb_hearing(soup)
    main_improvement = parse_main_improvement(soup)

    ai_tbl = soup.find(id="ResImp1_dgImp")
    additional_improvements = parse_additional_improvements(ai_tbl) if ai_tbl else []

    # Estimated taxes first, so exemptions can backfill taxable values if needed
    estimated_taxes, total_est_str, tax_status = parse_estimated_taxes(soup)

    # Exemptions (pass estimated taxes for taxable_value backfill if row is missing)
    exemptions = parse_exemptions_sections(soup)

    land_detail = parse_land_detail(soup)

    tax_year = None
    the_hdr = soup.find(string=lambda x: x and 'certified values' in str(x).lower())
    if the_hdr:
        m = re.search(r'(20\d{2})', str(the_hdr))
        tax_year = int(m.group(1)) if m else None

    # History (owner, market value, taxable value, exemptions)
    history = {
        "history_url": "N/A",
        "owner_history": [],
        "market_value": [],
        "taxable_value": [],
        "exemptions": []
    }
    if history_html:
        hsoup = BeautifulSoup(history_html, 'lxml')
        form = hsoup.find('form', id='Form1')
        if form and form.get('action'):
            history["history_url"] = form.get('action')

        history["owner_history"] = parse_history_owner_table(history_html)
        history["market_value"] = parse_history_market_value(history_html)
        history["taxable_value"] = parse_history_taxable_value(history_html)
        history["exemptions"] = parse_history_exemptions(history_html)

    # Exemption details page
    exemption_details = parse_exemption_details(exemption_details_html)

    return {
        "tax_year": tax_year,
        "property_location": property_location,
        "owner": owner,
        "legal_description": legal_description,
        "value_summary": value_summary,
        "arb_hearing": arb_hearing,
        "main_improvement": main_improvement,
        "additional_improvements": additional_improvements,
        "land_detail": land_detail,
        "exemptions": exemptions,
        "exemption_summary": [],
        "estimated_taxes": estimated_taxes,
        "estimated_taxes_total": _num_or_na(total_est_str),
        "estimated_taxes_status": tax_status,
        "history": history,
        "exemption_details": exemption_details,
    }
