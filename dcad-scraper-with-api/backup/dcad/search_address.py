# scraper/dcad/search_address.py
from __future__ import annotations
import re
from typing import List, Dict, Optional, Tuple
from bs4 import BeautifulSoup

ACCOUNT_LINK_RE = re.compile(r'AcctDetail.*\.aspx\?ID=([A-Za-z0-9]{17})')

def _clean(s: Optional[str]) -> str:
    return re.sub(r'\s+', ' ', (s or '').strip())

def _find_results_rows(soup: BeautifulSoup) -> List[Dict[str, str]]:
    """
    Find rows in any results table that contains links to AcctDetail...ID=XXXX.
    Returns a list of dicts: account_id, address, owner, city, zip (when present).
    """
    rows = []
    # Any link that looks like an account link
    for a in soup.find_all('a', href=True):
        m = ACCOUNT_LINK_RE.search(a.get('href') or '')
        if not m:
            continue
        account_id = m.group(1)

        # Try to read neighbor cells in the same row
        tr = a.find_parent('tr')
        if not tr:
            # fallback: use link text only
            rows.append({"account_id": account_id, "address": _clean(a.get_text()), "owner": "N/A", "city": "N/A", "zip": "N/A"})
            continue

        cells = tr.find_all(['td', 'th'])
        texts = [_clean(c.get_text()) for c in cells]
        # Heuristics: DCAD variants typically include address and owner on the same row
        address = "N/A"
        owner = "N/A"
        city = "N/A"
        zipc = "N/A"

        # Prefer the cell containing the link as address; then read neighbors for owner/city/zip
        # Locate index of cell with our link
        idx = None
        for i, c in enumerate(cells):
            if c.find('a', href=True) == a:
                idx = i
                break
        if idx is not None:
            address = texts[idx] or "N/A"
            # Look left/right for typical columns
            if idx + 1 < len(texts):
                owner = texts[idx + 1] or owner
            if idx + 2 < len(texts):
                # Sometimes city/zip combined; try to split
                maybe_cityzip = texts[idx + 2]
                mcz = re.search(r'(.+)\b(\d{5})(?:-\d{4})?$', maybe_cityzip)
                if mcz:
                    city = _clean(mcz.group(1).rstrip(','))
                    zipc = mcz.group(2)
                else:
                    city = maybe_cityzip or city

        rows.append({
            "account_id": account_id,
            "address": address,
            "owner": owner,
            "city": city,
            "zip": zipc,
        })
    # Deduplicate by account_id, keep first
    seen = set()
    out = []
    for r in rows:
        if r["account_id"] in seen:
            continue
        seen.add(r["account_id"])
        out.append(r)
    return out

def _extract_form(soup: BeautifulSoup) -> Tuple[Optional[str], Dict[str, str], Dict[str, str]]:
    """
    Extract form action and all inputs/selects/textareas as a dict.
    Also return a map of label_text -> control_name via <label for="...">.
    Returns (action_url, fields, label_to_name).
    """
    form = soup.find('form')  # DCAD usually uses id='Form1'
    if not form:
        return None, {}, {}

    action = form.get('action') or ''
    fields: Dict[str, str] = {}
    name_for: Dict[str, str] = {}  # label_text (lower) -> input name/id

    # Build a map from 'for' -> element name/id
    labels = form.find_all('label')
    for lab in labels:
        txt = _clean(lab.get_text()).lower()
        fr = lab.get('for')
        if not txt or not fr:
            continue
        # Find the control that this label points to
        control = form.find(attrs={"id": fr}) or form.find(attrs={"name": fr})
        if control:
            nm = control.get('name') or control.get('id')
            if nm:
                name_for[txt] = nm

    # Capture all fields (keep hidden fields intact for ASP.NET)
    for el in form.find_all(['input', 'select', 'textarea']):
        name = el.get('name') or el.get('id')
        if not name:
            continue
        t = (el.get('type') or '').lower()
        if t in ('checkbox', 'radio'):
            if el.has_attr('checked'):
                fields[name] = el.get('value') or 'on'
            else:
                continue
        else:
            fields[name] = el.get('value') or ''

    return action, fields, name_for

def _guess_address_field_names(fields: Dict[str, str], label_to_name: Dict[str, str]) -> Dict[str, str]:
    """
    Guess DCAD's address field names using both field names and <label> text.
    Returns a map like {'street_num': '...', 'street_name': '...', 'city': '...', 'zip': '...'}
    """
    picks: Dict[str, str] = {}

    # 1) Try via labels
    label_patterns = {
        "street_num": [r'street.*(no|num|number)', r'\bhouse\b.*(no|num|number)'],
        "street_name": [r'(street|addr|address).*(name|line)?', r'^\s*address\s*$'],
        "city": [r'\bcity\b'],
        "zip": [r'\bzip\b|zipcode|postal'],
        "unit": [r'(unit|apt|suite)'],
    }
    for want, pats in label_patterns.items():
        for lbl_txt, nm in label_to_name.items():
            for p in pats:
                if re.search(p, lbl_txt, re.I):
                    picks.setdefault(want, nm)

    # 2) Fall back to field names when labels didn’t match
    name_patterns = {
        "street_num": [r'street.*(no|num|number)', r'addr.*(no|num|number)', r'\bhouse(no|num|number)\b'],
        "street_name": [r'(street|addr|address|stname|st_name|addr1|address1)'],
        "city": [r'\bcity\b'],
        "zip": [r'\bzip\b|zipcode|postal'],
        "unit": [r'(unit|apt|suite)'],
    }
    for want, pats in name_patterns.items():
        if want in picks:
            continue
        for k in fields.keys():
            lk = k.lower()
            if any(re.search(p, lk) for p in pats):
                picks[want] = k
                break

    return picks

async def search_by_address(client, base_url: str, address: str, city: str | None = None, zip_code: str | None = None) -> List[Dict[str, str]]:
    """
    Attempts:
      1) GET: naive querystring on likely endpoints
      2) POST: fetch an address search form, fill via labels/field names, try a few strategies
    """
    # --- Attempt 1: naive GET on a likely endpoint ---
    likely_paths = [
        "/SearchAddr.aspx",
        "/SearchAddress.aspx",
        "/AcctSearch.aspx",
        "/PropertySearch.aspx",
    ]
    for path in likely_paths:
        try:
            url = f"{base_url}{path}?q={address}"
            resp = await client.get(url, headers={"User-Agent": UA})
            if resp.status_code == 200:
                txt = resp.text
                if "AcctDetail" in txt:
                    soup = BeautifulSoup(txt, 'lxml')
                    rows = _find_results_rows(soup)
                    if rows:
                        return rows
        except Exception:
            pass

    # --- Attempt 2: robust form POST using labels + names ---
    search_pages = [
        "/SearchAddr.aspx",
        "/SearchAddress.aspx",
        "/PropertySearch.aspx",
        "/Search.aspx",
        "/AcctFind.aspx",
    ]
    start_html = None
    start_url = None
    for path in search_pages:
        try:
            url = f"{base_url}{path}"
            r = await client.get(url, headers={"User-Agent": UA})
            if r.status_code == 200 and '<form' in r.text.lower():
                start_html = r.text
                start_url = url
                break
        except Exception:
            continue

    if not start_html:
        return []

    soup = BeautifulSoup(start_html, 'lxml')
    action, fields, label_to_name = _extract_form(soup)
    if not fields:
        return []

    picks = _guess_address_field_names(fields, label_to_name)

    # Helper to set a field if we found a name for it
    def set_if(key: str, value: str | None):
        if value is None:
            return
        nm = picks.get(key)
        if nm:
            fields[nm] = value

    # Parse address into number + street
    m = re.match(r'\s*(\d+)\s+(.*)', address.strip())
    street_num = m.group(1) if m else ''
    street_name = m.group(2) if m else address.strip()

    # Some forms need an explicit search button value; try to set it
    for k in list(fields.keys()):
        if re.search(r'(btn|search|submit)', k, re.I) and not fields[k]:
            fields[k] = "Search"

    # Resolve form action
    post_url = action if action and action.startswith('http') else (
        f"{base_url}/{action.lstrip('/')}" if action else start_url
    )

    # We’ll try a few quick strategies:
    attempts = []

    # A) number + street (as-is)
    fA = fields.copy()
    set_if('street_num', street_num)
    set_if('street_name', street_name)
    set_if('city', city)
    set_if('zip', zip_code)
    attempts.append(("num+street", fA))

    # B) full address into street_name field (if exists)
    fB = fields.copy()
    if picks.get('street_name'):
        fB[picks['street_name']] = address
    if picks.get('street_num'):
        fB[picks['street_num']] = ''
    set_if('city', city)
    set_if('zip', zip_code)
    attempts.append(("full->street_name", fB))

    # C) uppercase full address (some sites normalize)
    fC = fields.copy()
    if picks.get('street_name'):
        fC[picks['street_name']] = address.upper()
    if picks.get('street_num'):
        fC[picks['street_num']] = street_num
    set_if('city', city)
    set_if('zip', zip_code)
    attempts.append(("upper_full", fC))

    # D) if we have a single free text field (no clear picks), drop the full address into the first empty text input
    if not picks.get('street_name') and not picks.get('street_num'):
        for k in fields.keys():
            # choose any plausible text field
            if re.search(r'(addr|address|search|query|text)', k, re.I):
                fD = fields.copy()
                fD[k] = address
                attempts.append(("fallback_free_text", fD))
                break

    # Execute attempts until we find rows
    for tag, payload in attempts:
        try:
            r2 = await client.post(post_url, data=payload, headers={"Referer": start_url, "User-Agent": UA})
            if r2.status_code != 200:
                continue
            soup2 = BeautifulSoup(r2.text, 'lxml')
            rows = _find_results_rows(soup2)
            if rows:
                return rows
        except Exception:
            continue

    return []
