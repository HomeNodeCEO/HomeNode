# scraper/api/main.py
from __future__ import annotations

import asyncio
import inspect
import re
from typing import Any, Dict, List, Optional
import json
from urllib.parse import urljoin, parse_qs, urlparse
from .na_utils import fill_na

import httpx
from bs4 import BeautifulSoup
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from datetime import datetime
import os, base64, io
from pathlib import Path
try:
    from PyPDF2 import PdfReader, PdfWriter  # type: ignore
    from reportlab.pdfgen import canvas  # type: ignore
    from reportlab.lib.pagesizes import letter  # type: ignore
    from reportlab.lib.utils import ImageReader  # type: ignore
    _PDF_LIBS_AVAILABLE = True
except Exception:
    PdfReader = None  # type: ignore
    PdfWriter = None  # type: ignore
    canvas = None  # type: ignore
    letter = None  # type: ignore
    ImageReader = None  # type: ignore
    _PDF_LIBS_AVAILABLE = False

# Load .env if present so DATABASE_URL/DB_SCHEMA are available when starting the API directly
try:
    from dotenv import load_dotenv  # type: ignore
    load_dotenv()
except Exception:
    pass

# Use relative imports when running as package (scraper.api.main),
# and fall back to absolute when launched as top-level (api.main)
try:
    from ..utils import normalize_account_id  # type: ignore
    from ..dcad.parse_detail import parse_detail_html  # type: ignore
    from ..dcad.history_service import build_history_for_account  # type: ignore
    from ..dcad.upsert import get_engine as _get_db_engine, _tbl as _tblname  # type: ignore
except Exception:
    from utils import normalize_account_id
    from dcad.parse_detail import parse_detail_html
    from dcad.history_service import build_history_for_account  # NEW
    from dcad.upsert import get_engine as _get_db_engine, _tbl as _tblname  # type: ignore

app = FastAPI(title="DCAD Scraper API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

BASE_URL = "https://www.dallascad.org"
ACCOUNT_PATH = "/AcctDetail.aspx?ID={account_id}"
HISTORY_PATH = "/AcctHistory.aspx?ID={account_id}"
EXEMPT_DETAILS_PATH = "/ExemptDetails.aspx?ID={account_id}"
EXEMPT_DETAILS_HISTORY_PATH = "/ExemptDetailHistory.aspx?ID={account_id}"
ADDRESS_SEARCH_PATH = "/SearchAddr.aspx"

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/120.0.0.0 Safari/537.36"
)
TIMEOUT = httpx.Timeout(30.0)


def _clean(s: Optional[str]) -> str:
    return re.sub(r"\s+", " ", (s or "").strip())


def _mkurl(path_tmpl: str, account_id: str) -> str:
    return BASE_URL + path_tmpl.format(account_id=account_id) if "{account_id}" in path_tmpl else BASE_URL + path_tmpl


# ---------------------- DB-first helpers ----------------------

from sqlalchemy import text as _sql_text  # type: ignore
from decimal import Decimal
from collections.abc import Mapping

def _db_engine_or_none():
    try:
        return _get_db_engine()
    except Exception:
        return None

def _jsonable(val):
    if isinstance(val, Decimal):
        try:
            return float(val)
        except Exception:
            return str(val)
    return val

def _to_jsonable(obj):
    if isinstance(obj, Mapping):
        return {k: _to_jsonable(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_to_jsonable(x) for x in obj]
    return _jsonable(obj)

def _db_primary_improvements(conn, account_id: str):
    sql = _sql_text(f"SELECT * FROM {_tblname('primary_improvements')} WHERE account_id=:id")
    row = conn.execute(sql, {"id": account_id}).mappings().first()
    if not row:
        return None
    # Map DB row to API shape
    out = {
        "building_class": row.get("building_class"),
        "year_built": row.get("year_built"),
        "effective_year_built": row.get("effective_year_built"),
        "actual_age": row.get("actual_age"),
        "desirability": row.get("desirability"),
        "desirability_raw": row.get("desirability_raw"),
        "desirability_id": row.get("desirability_id"),
        "living_area_sqft": row.get("living_area_sqft"),
        "total_living_area": row.get("total_living_area"),
        "total_area_sqft": row.get("total_area_sqft"),
        "percent_complete": row.get("percent_complete"),
        "stories": row.get("stories_raw") or row.get("stories"),
        "stories_raw": row.get("stories_raw"),
        "depreciation": row.get("depreciation"),
        "construction_type": row.get("construction_type"),
        "foundation": row.get("foundation"),
        "roof_type": row.get("roof_type"),
        "roof_material": row.get("roof_material"),
        "fence_type": row.get("fence_type"),
        "exterior_material": row.get("exterior_material"),
        "basement_raw": row.get("basement_raw"),
        "basement": row.get("basement"),
        "heating": row.get("heating"),
        "air_conditioning": row.get("air_conditioning"),
        "baths_full": row.get("baths_full"),
        "baths_half": row.get("baths_half"),
        "bath_count": row.get("bath_count"),
        "bedroom_count": row.get("bedroom_count"),
        "kitchens": row.get("kitchens"),
        "wetbars": row.get("wetbars"),
        "fireplaces": row.get("fireplaces"),
        "sprinkler": row.get("sprinkler"),
        "deck": row.get("deck"),
        "spa": row.get("spa"),
        "pool": row.get("pool"),
        "sauna": row.get("sauna"),
        "number_units": row.get("number_units"),
    }
    return {k: v for k, v in out.items() if v is not None}

def _db_secondary_improvements(conn, account_id: str):
    # Core schema columns are prefixed (sec_imp_*)
    sql = _sql_text(
        f"SELECT * FROM {_tblname('secondary_improvements')} WHERE account_id=:id ORDER BY sec_imp_number"
    )
    rows = conn.execute(sql, {"id": account_id}).mappings().all()
    out = []
    for r in rows:
        out.append({
            "imp_num": r.get("sec_imp_number"),
            "imp_type": r.get("sec_imp_type"),
            "imp_desc": r.get("sec_imp_desc"),
            "year_built": r.get("sec_imp_year_built"),
            "construction": r.get("sec_imp_cons_type"),
            "floor_type": r.get("sec_imp_floor"),
            "ext_wall": r.get("sec_imp_ext_wall"),
            "num_stories": r.get("sec_imp_stories"),
            "area_size": r.get("sec_imp_sqft"),
            "value": r.get("sec_imp_value"),
            "depreciation": r.get("sec_imp_depreciation"),
        })
    return out

def _db_value_summary(conn, account_id: str):
    sql = _sql_text(f"SELECT * FROM {_tblname('value_summary_current')} WHERE account_id=:id")
    row = conn.execute(sql, {"id": account_id}).mappings().first()
    if not row:
        return None
    vs = {
        "certified_year": row.get("certified_year"),
        "improvement_value": row.get("improvement_value"),
        "land_value": row.get("land_value"),
        "market_value": row.get("market_value"),
        "capped_value": row.get("capped_value"),
        "tax_agent": row.get("tax_agent"),
        "revaluation_year": row.get("revaluation_year"),
        "previous_revaluation_year": row.get("previous_revaluation_year"),
    }
    return vs

def _db_estimated_taxes(conn, account_id: str):
    out = {}
    sql = _sql_text(f"SELECT * FROM {_tblname('estimated_taxes')} WHERE account_id=:id")
    rows = conn.execute(sql, {"id": account_id}).mappings().all()
    for r in rows:
        key = r.get("jurisdiction_key")
        out[str(key)] = {
            "taxing_unit": r.get("taxing_unit"),
            "tax_rate_per_100": r.get("tax_rate_per_100"),
            "taxable_value": r.get("taxable_value"),
            "estimated_taxes": r.get("estimated_taxes_amt"),
            "tax_ceiling": r.get("tax_ceiling"),
        }
    total = None
    tot_row = conn.execute(_sql_text(f"SELECT * FROM {_tblname('estimated_taxes_total')} WHERE account_id=:id"), {"id": account_id}).mappings().first()
    if tot_row:
        total = tot_row.get("total_estimated")
    return out, total

def _db_exemptions(conn, account_id: str):
    sql = _sql_text(f"SELECT * FROM {_tblname('exemptions_summary')} WHERE account_id=:id")
    rows = conn.execute(sql, {"id": account_id}).mappings().all()
    out = {}
    for r in rows:
        key = r.get("jurisdiction_key")
        out[str(key)] = {
            "taxing_jurisdiction": r.get("taxing_jurisdiction"),
            "homestead_exemption": r.get("homestead_exemption"),
            "disabled_vet": r.get("disabled_vet"),
            "taxable_value": r.get("taxable_value"),
        }
    return out

def _db_land_detail(conn, account_id: str):
    sql = _sql_text(f"SELECT * FROM {_tblname('land_detail')} WHERE account_id=:id ORDER BY tax_year, line_number")
    rows = conn.execute(sql, {"id": account_id}).mappings().all()
    out = []
    for r in rows:
        out.append({
            "number": r.get("line_number"),
            "state_code": r.get("state_code"),
            "zoning": r.get("zoning"),
            "frontage_ft": r.get("frontage_ft"),
            "depth_ft": r.get("depth_ft"),
            "area_sqft": r.get("area_sqft"),
            "pricing_method": r.get("pricing_method"),
            "unit_price": r.get("unit_price"),
            "market_adjustment_pct": r.get("market_adjustment_pct"),
            "adjusted_price": r.get("adjusted_price"),
            "ag_land": r.get("ag_land"),
            "tax_year": r.get("tax_year"),
        })
    return out

def _db_owner(conn, account_id: str):
    owner = None
    # Use the latest tax_year row for owner_summary if available
    row = conn.execute(
        _sql_text(f"SELECT * FROM {_tblname('owner_summary')} WHERE account_id=:id ORDER BY tax_year DESC LIMIT 1"),
        {"id": account_id},
    ).mappings().first()
    if row:
        owner = {"owner_name": row.get("owner_name"), "mailing_address": row.get("mailing_address")}
    # Determine the latest tax_year in owner_parties and fetch that set
    ty_row = conn.execute(
        _sql_text(f"SELECT MAX(tax_year) AS ty FROM {_tblname('owner_parties')} WHERE account_id=:id"),
        {"id": account_id},
    ).mappings().first()
    latest_ty = ty_row.get("ty") if ty_row else None
    multi = []
    if latest_ty is not None:
        parties = conn.execute(
            _sql_text(
                f"SELECT owner_name, ownership_pct FROM {_tblname('owner_parties')} WHERE account_id=:id AND tax_year=:ty ORDER BY owner_name"
            ),
            {"id": account_id, "ty": latest_ty},
        ).mappings().all()
        for p in parties:
            multi.append({"owner_name": p.get("owner_name"), "ownership_pct": p.get("ownership_pct")})
    if owner and multi:
        owner["multi_owner"] = multi
    return owner

def _db_property_location(conn, account_id: str):
    # Pull basic situs/location info from core.accounts if available; fallback to raw snapshot if missing
    try:
        acc = conn.execute(_sql_text(f"SELECT address, neighborhood_code, mapsco FROM {_tblname('accounts')} WHERE account_id=:id"), {"id": account_id}).mappings().first()
    except Exception:
        acc = None
    address = acc.get("address") if acc else None
    neighborhood = acc.get("neighborhood_code") if acc else None
    mapsco = acc.get("mapsco") if acc else None

    if not address or not neighborhood or not mapsco:
        # Try to recover from latest raw JSON snapshot
        try:
            raw_row = conn.execute(_sql_text(f"SELECT raw FROM {_tblname('dcad_json_raw')} WHERE account_id=:id ORDER BY tax_year DESC LIMIT 1"), {"id": account_id}).mappings().first()
        except Exception:
            raw_row = None
        if raw_row:
            raw_obj = raw_row.get("raw")
            if isinstance(raw_obj, str):
                try:
                    raw_obj = json.loads(raw_obj)
                except Exception:
                    raw_obj = None
            if isinstance(raw_obj, dict):
                det = raw_obj.get("detail") or {}
                pl = det.get("property_location") or {}
                address = address or pl.get("address") or pl.get("subject_address")
                neighborhood = neighborhood or pl.get("neighborhood") or pl.get("neighborhood_code")
                mapsco = mapsco or pl.get("mapsco")
        # If we recovered anything, write back to accounts for future calls
        if (address or neighborhood or mapsco) and acc is not None:
            try:
                conn.execute(
                    _sql_text(
                        f"UPDATE {_tblname('accounts')} SET address=COALESCE(:a,address), neighborhood_code=COALESCE(:n,neighborhood_code), mapsco=COALESCE(:m,mapsco) WHERE account_id=:id"
                    ),
                    {"a": address, "n": neighborhood, "m": mapsco, "id": account_id},
                )
            except Exception:
                pass

    out = {k: v for k, v in {
        "address": address,
        "subject_address": address,
        "neighborhood": neighborhood,
        "mapsco": mapsco,
    }.items() if v is not None}
    return out if out else None

def _db_legal_current(conn, account_id: str):
    try:
        row = conn.execute(_sql_text(f"SELECT legal_lines, deed_transfer_raw, deed_transfer_date FROM {_tblname('legal_description_current')} WHERE account_id=:id"), {"id": account_id}).mappings().first()
    except Exception:
        row = None
    if not row:
        return None
    lines = row.get("legal_lines")
    # legal_lines may be JSON array already; if it's a string, do not split here
    return {
        "lines": lines if isinstance(lines, list) else lines,
        "deed_transfer_date": row.get("deed_transfer_date") or row.get("deed_transfer_raw"),
    }

def _db_owner_history_min(conn, account_id: str):
    # Build a minimal owner_history list with year and deed info; attach legal lines when available
    try:
        hist_rows = conn.execute(_sql_text(f"SELECT observed_year, deed_transfer_date_raw, deed_transfer_date FROM {_tblname('ownership_history')} WHERE account_id=:id ORDER BY observed_year DESC"), {"id": account_id}).mappings().all()
    except Exception:
        hist_rows = []
    items = []
    if not hist_rows:
        return items
    # Preload legal_description_history into a dict by year
    try:
        legals = conn.execute(_sql_text(f"SELECT tax_year, legal_lines FROM {_tblname('legal_description_history')} WHERE account_id=:id"), {"id": account_id}).mappings().all()
    except Exception:
        legals = []
    legal_by_year = {r.get("tax_year"): r.get("legal_lines") for r in legals}
    for r in hist_rows:
        y = r.get("observed_year")
        items.append({
            "year": y,
            "deed_transfer_date": r.get("deed_transfer_date") or r.get("deed_transfer_date_raw"),
            "legal_description": legal_by_year.get(y),
        })
    return items

def _db_value_history(conn, account_id: str):
    mv_rows = conn.execute(
        _sql_text(f"SELECT * FROM {_tblname('market_value_history')} WHERE account_id=:id ORDER BY tax_year DESC"),
        {"id": account_id},
    ).mappings().all()
    tv_rows = conn.execute(
        _sql_text(f"SELECT * FROM {_tblname('taxable_value_history')} WHERE account_id=:id ORDER BY tax_year DESC, jurisdiction_key"),
        {"id": account_id},
    ).mappings().all()
    # Convert RowMapping to plain dict + jsonable values
    def rows_to_dicts(rows):
        out = []
        for r in rows:
            d = {k: _jsonable(r.get(k)) for k in r.keys()}
            out.append(d)
        return out
    return rows_to_dicts(mv_rows), rows_to_dicts(tv_rows)

def _build_detail_from_db(conn, account_id: str) -> dict | None:
    primary = _db_primary_improvements(conn, account_id)
    vs = _db_value_summary(conn, account_id)
    land = _db_land_detail(conn, account_id)
    ex = _db_exemptions(conn, account_id)
    est, est_total = _db_estimated_taxes(conn, account_id)
    secondary = _db_secondary_improvements(conn, account_id)
    owner = _db_owner(conn, account_id)
    mv, tv = _db_value_history(conn, account_id)
    prop_loc = _db_property_location(conn, account_id)
    legal = _db_legal_current(conn, account_id)
    owner_hist = _db_owner_history_min(conn, account_id)

    # Consider data present if we have at least primary or value summary
    if not (primary or vs or land or ex or est or secondary or owner or mv or tv):
        return None

    tax_year = None
    if vs and vs.get("certified_year"):
        try:
            tax_year = int(vs.get("certified_year"))
        except Exception:
            tax_year = vs.get("certified_year")

    detail: dict = {
        "tax_year": tax_year,
        "owner": owner or {},
        "property_location": prop_loc or {},
        "legal_description": legal or {},
        "value_summary": vs or {},
        "primary_improvements": primary or {},
        "secondary_improvements": secondary or [],
        "main_improvement": primary or {},
        "main_improvements": primary or {},
        "land_detail": land or [],
        "exemptions": ex or {},
        "estimated_taxes": _to_jsonable(est or {}),
        "estimated_taxes_total": _jsonable(est_total),
        # History (compact): just surface raw lists; frontend can adapt if needed
        "history": {
            "market_value": mv,
            "taxable_value": tv,
            "owner_history": owner_hist,
        },
    }
    # Ensure property_location exists and carries subject_address key for consistency
    if not detail.get("property_location"):
        detail["property_location"] = {"subject_address": None}
    elif isinstance(detail.get("property_location"), dict):
        pl = detail["property_location"]
        addr = pl.get("address")
        if "subject_address" not in pl:
            pl["subject_address"] = addr
    return _to_jsonable(detail)


async def _fetch_text(client: httpx.AsyncClient, url: str) -> str:
    r = await client.get(url, headers={"User-Agent": UA})
    r.raise_for_status()
    try:
        return r.text or r.content.decode(r.encoding or "utf-8", errors="ignore")
    except Exception:
        return r.content.decode("utf-8", errors="ignore")


async def _fetch_all(account_id: str):
    acct_url = _mkurl(ACCOUNT_PATH, account_id)
    hist_url = _mkurl(HISTORY_PATH, account_id)
    exdt_url = _mkurl(EXEMPT_DETAILS_PATH, account_id)
    exdt_hist_url = _mkurl(EXEMPT_DETAILS_HISTORY_PATH, account_id)

    async with httpx.AsyncClient(timeout=TIMEOUT, follow_redirects=True) as client:
        detail_html, history_html, exdt_html, exdt_hist_html = await asyncio.gather(
            _fetch_text(client, acct_url),
            _fetch_text(client, hist_url),
            _fetch_text(client, exdt_url),
            _fetch_text(client, exdt_hist_url),
        )

    return (
        detail_html,
        history_html,
        exdt_html,
        exdt_hist_html,
        acct_url,
        hist_url,
        exdt_url,
        exdt_hist_url,
    )


def _extract_tokens(html: str) -> dict:
    soup = BeautifulSoup(html, "lxml")
    out = {}
    for name in ("__VIEWSTATE", "__EVENTVALIDATION", "__VIEWSTATEGENERATOR", "__EVENTTARGET", "__EVENTARGUMENT"):
        el = soup.find("input", {"name": name})
        if el and el.get("value") is not None:
            out[name] = el.get("value")
    out.setdefault("__EVENTTARGET", "")
    out.setdefault("__EVENTARGUMENT", "")
    return out


def _parse_results_table(html: str) -> List[Dict[str, str]]:
    soup = BeautifulSoup(html, "lxml")
    table = soup.find(id="SearchResults1_dgResults")

    if not table:
        def looks_like_results(tbl):
            hdr = tbl.find("tr")
            if not hdr:
                return False
            thtxt = _clean(hdr.get_text(" ")).upper()
            return ("PROPERTY ADDRESS" in thtxt and "OWNER" in thtxt) or ("TOTAL VALUE" in thtxt and "TYPE" in thtxt)
        for t in soup.find_all("table"):
            if looks_like_results(t):
                table = t
                break

    rows: List[Dict[str, str]] = []
    if not table:
        return rows

    for tr in table.find_all("tr"):
        tds = tr.find_all("td")
        if len(tds) < 6:
            continue
        a = tds[1].find("a", href=True)
        if not a:
            continue
        href = urljoin(BASE_URL + "/", a.get("href"))
        q = parse_qs(urlparse(href).query)
        acc = (q.get("ID") or q.get("id") or [""])[0].strip()
        rows.append({
            "account_id": acc,
            "address": _clean(a.get_text()),
            "city": _clean(tds[2].get_text()),
            "owner": _clean(tds[3].get_text()),
            "total_value": _clean(tds[4].get_text()),
            "type": _clean(tds[5].get_text()),
            "detail_url": href,
        })
    return rows


def _find_next_postback(html: str) -> Optional[str]:
    soup = BeautifulSoup(html, "lxml")
    for a in soup.select('a[href^="javascript:__doPostBack"]'):
        txt = _clean(a.get_text()).upper()
        if "NEXT" in txt or txt in (">", "»"):
            m = re.search(r"__doPostBack\('([^']+)'", a.get("href", ""))
            if m:
                return m.group(1)
    return None


async def _search_address_paged(client: httpx.AsyncClient, q: str, city: str | None, direction: str | None) -> List[Dict[str, str]]:
    search_url = _mkurl(ADDRESS_SEARCH_PATH, "")
    r0 = await client.get(search_url, headers={"User-Agent": UA})
    r0.raise_for_status()
    tokens = _extract_tokens(r0.text)

    # split optional house number
    house, street = "", q
    m = re.match(r"\s*(\d+)\s+(.+)$", q.strip())
    if m:
        house, street = m.group(1), m.group(2)

    form = {
        "__EVENTTARGET": tokens.get("__EVENTTARGET", ""),
        "__EVENTARGUMENT": tokens.get("__EVENTARGUMENT", ""),
        "__VIEWSTATE": tokens.get("__VIEWSTATE", ""),
        "__VIEWSTATEGENERATOR": tokens.get("__VIEWSTATEGENERATOR", ""),
        "__EVENTVALIDATION": tokens.get("__EVENTVALIDATION", ""),
        "txtAddrNum": house,
        "txtStName": street,
        "listStDir": (direction or ""),
        "listCity": (city or ""),
        "cmdSubmit": "Search",
    }
    r = await client.post(search_url, data=form, headers={"User-Agent": UA, "Referer": search_url})
    r.raise_for_status()

    all_rows: List[Dict[str, str]] = []
    pages = 0
    while True:
        pages += 1
        all_rows.extend(_parse_results_table(r.text))

        if pages >= 200:
            break
        next_target = _find_next_postback(r.text)
        if not next_target:
            break

        tokens = _extract_tokens(r.text)
        post = {
            "__EVENTTARGET": next_target,
            "__EVENTARGUMENT": "",
            "__VIEWSTATE": tokens.get("__VIEWSTATE", ""),
            "__VIEWSTATEGENERATOR": tokens.get("__VIEWSTATEGENERATOR", ""),
            "__EVENTVALIDATION": tokens.get("__EVENTVALIDATION", ""),
        }
        r = await client.post(search_url, data=post, headers={"User-Agent": UA, "Referer": search_url})
        r.raise_for_status()

    # de-dupe by account_id
    seen, uniq = set(), []
    for row in all_rows:
        acc = row.get("account_id")
        if acc and acc not in seen:
            uniq.append(row)
            seen.add(acc)
    return uniq


def _split_history(history_html: str) -> tuple[str, str, str]:
    soup = BeautifulSoup(history_html, "lxml")

    def section_html(rx: str) -> Optional[str]:
        for sp in soup.find_all("span", class_="DtlSectionHdr"):
            txt = _clean(sp.get_text()).upper()
            if re.search(rx, txt, re.I):
                frags: List[str] = []
                for sib in sp.next_siblings:
                    if getattr(sib, "name", None) == "span" and "DtlSectionHdr" in (sib.get("class") or []):
                        break
                    frags.append(str(sib))
                return f"<div>{''.join(frags)}</div>"
        return None

    owner = section_html(r"OWNER\s*HISTORY") or history_html
    market = section_html(r"MARKET\s*VALUE\s*HISTORY") or history_html
    taxable = section_html(r"TAXABLE\s*VALUE\s*HISTORY") or history_html
    return owner, market, taxable


def _parse_exempt_detail_history_latest(html: str) -> dict | None:
    soup = BeautifulSoup(html, "lxml")
    hdr = soup.find("span", class_="DtlSectionHdr")
    if not hdr:
        return None

    year_txt = _clean(hdr.get_text())
    table = None
    for el in hdr.next_elements:
        if getattr(el, "name", None) == "table":
            table = el
            break
        if getattr(el, "name", None) == "span" and "DtlSectionHdr" in el.get("class", []):
            break

    if not table:
        return {"year": year_txt}

    tds = table.find_all("td", recursive=True)
    if len(tds) < 2:
        return {"year": year_txt}

    left_tbl = tds[0].find("table")
    right_tbl = tds[1].find("table")
    if not left_tbl or not right_tbl:
        return {"year": year_txt}

    labels = [_clean(x.get_text()) for x in left_tbl.find_all(["th", "td"])]
    values = [_clean(x.get_text()) for x in right_tbl.find_all(["td"])]

    out: Dict[str, str] = {}
    for i, lab in enumerate(labels):
        if i >= len(values):
            break
        key = (
            lab.lower()
            .replace(" ", "_")
            .replace("%", "pct")
            .replace("/", "_")
            .replace("-", "_")
            .replace("__", "_")
            .strip("_")
        )
        if key:
            out[key] = values[i]
    out["year"] = year_txt
    return out or {"year": year_txt}


def _call_parse_detail_html_compat(
    *,
    account_id: str,
    detail_html: str,
    history_owner_html: str,
    history_market_html: str,
    history_taxable_html: str,
    exemption_details_html: str | None = "",
    exemption_details_history_html: str | None = "",
) -> dict:
    """
    Call dcad.parse_detail.parse_detail_html in a signature-agnostic way.

    We try (in order):
      1) keywords with account_html
      2) keywords with html
      3) keywords with detail_html
      4) positional (detail, owner, market, taxable, [exempt])
      Each attempt optionally includes account_id if supported.
    """
    attempts = []

    # (1) account_html with/without account_id
    attempts.append(
        dict(
            kwargs=dict(
                account_id=account_id,
                account_html=detail_html,
                history_owner_html=history_owner_html,
                history_market_html=history_market_html,
                history_taxable_html=history_taxable_html,
                exemption_details_html=(exemption_details_html or ""),
                exemption_details_history_html=(exemption_details_history_html or ""),
            ),
            positional=None,
        )
    )
    attempts.append(
        dict(
            kwargs=dict(
                account_html=detail_html,
                history_owner_html=history_owner_html,
                history_market_html=history_market_html,
                history_taxable_html=history_taxable_html,
                exemption_details_html=(exemption_details_html or ""),
                exemption_details_history_html=(exemption_details_history_html or ""),
            ),
            positional=None,
        )
    )

    # (2) html with/without account_id
    attempts.append(
        dict(
            kwargs=dict(
                account_id=account_id,
                html=detail_html,
                history_owner_html=history_owner_html,
                history_market_html=history_market_html,
                history_taxable_html=history_taxable_html,
                exemption_details_html=(exemption_details_html or ""),
                exemption_details_history_html=(exemption_details_history_html or ""),
            ),
            positional=None,
        )
    )
    attempts.append(
        dict(
            kwargs=dict(
                html=detail_html,
                history_owner_html=history_owner_html,
                history_market_html=history_market_html,
                history_taxable_html=history_taxable_html,
                exemption_details_html=(exemption_details_html or ""),
                exemption_details_history_html=(exemption_details_history_html or ""),
            ),
            positional=None,
        )
    )

    # (3) detail_html with/without account_id
    attempts.append(
        dict(
            kwargs=dict(
                account_id=account_id,
                detail_html=detail_html,
                history_owner_html=history_owner_html,
                history_market_html=history_market_html,
                history_taxable_html=history_taxable_html,
                exemption_details_html=(exemption_details_html or ""),
                exemption_details_history_html=(exemption_details_history_html or ""),
            ),
            positional=None,
        )
    )
    attempts.append(
        dict(
            kwargs=dict(
                detail_html=detail_html,
                history_owner_html=history_owner_html,
                history_market_html=history_market_html,
                history_taxable_html=history_taxable_html,
                exemption_details_html=(exemption_details_html or ""),
                exemption_details_history_html=(exemption_details_history_html or ""),
            ),
            positional=None,
        )
    )

    # (4) positional (oldest style)
    attempts.append(
        dict(
            kwargs=None,
            positional=[
                detail_html,
                history_owner_html,
                history_market_html,
                history_taxable_html,
                (exemption_details_html or ""),
                (exemption_details_history_html or ""),
            ],
        )
    )

    last_err: Exception | None = None
    for attempt in attempts:
        try:
            if attempt["kwargs"] is not None:
                return parse_detail_html(**attempt["kwargs"])
            else:
                return parse_detail_html(*attempt["positional"])  # type: ignore[arg-type]
        except TypeError as e:
            last_err = e
            continue
        except ValueError as e:
            # If parser insists on e.g. "account_html (or html) is required", try next style
            last_err = e
            continue
        except Exception as e:
            last_err = e
            break

    raise RuntimeError(f"parse_detail_html() incompatible with provided arguments: {last_err}")

# ---------------------- Pydantic models ----------------------

class DetailResponse(BaseModel):
    account_id: str
    detail: dict

class AddressSearchItem(BaseModel):
    account_id: str
    address: str
    city: str
    owner: str
    total_value: str
    type: str
    detail_url: str

class AddressSearchDetailsItem(BaseModel):
    summary: AddressSearchItem
    detail: dict | None = None
    error: str | None = None

class AddressSearchDetailsResponse(BaseModel):
    query: str
    total: int
    offset: int
    count: int
    results: List[AddressSearchDetailsItem]

# ---------------------- Routes ----------------------

@app.get("/health", include_in_schema=False)
def health():
    return {"ok": True, "pdf_features": _PDF_LIBS_AVAILABLE}

class SignupRequest(BaseModel):
    accountId: str | None = None
    signature: str | None = None
    pdfData: str | None = None  # kept for backward-compat (filled PDF)
    basePdfData: str | None = None  # original PDF data URL (preferred)
    fields: dict | None = None  # optional key->value for overlay text/checkboxes

def _ensure_storage_dir() -> Path:
    root = Path(os.environ.get('STORAGE_DIR', './storage/signed_forms')).resolve()
    root.mkdir(parents=True, exist_ok=True)
    return root

def _decode_data_url(data_url: str) -> bytes:
    if not data_url:
        return b''
    if ',' in data_url:
        header, b64 = data_url.split(',', 1)
        return base64.b64decode(b64)
    return base64.b64decode(data_url)

def _overlay_signature(pdf_bytes: bytes, sig_bytes: bytes) -> bytes:
    if not _PDF_LIBS_AVAILABLE:
        return pdf_bytes
    reader = PdfReader(io.BytesIO(pdf_bytes))
    writer = PdfWriter()

    packet = io.BytesIO()
    c = canvas.Canvas(packet, pagesize=letter)
    try:
        img = ImageReader(io.BytesIO(sig_bytes))
        dpi = 72
        width = 2.5 * dpi
        height = 1.0 * dpi
        c.drawImage(img, 1.5*dpi, 1.2*dpi, width=width, height=height, mask='auto')
    except Exception:
        pass
    c.save()
    packet.seek(0)

    sig_pdf = PdfReader(packet)
    for i, page in enumerate(reader.pages):
        if i == 0 and len(sig_pdf.pages):
            page.merge_page(sig_pdf.pages[0])
        writer.add_page(page)

    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()

@app.post('/signup/submit')
async def signup_submit(req: SignupRequest):
    try:
        # Choose base pdf bytes: prefer basePdfData, else pdfData
        base_pdf = _decode_data_url(req.basePdfData or '') if req.basePdfData else _decode_data_url(req.pdfData or '')
        if not base_pdf:
            raise HTTPException(status_code=400, detail='Missing PDF data')

        # If fields are provided, overlay text/checkboxes
        overlay = io.BytesIO()
        try:
            from reportlab.pdfgen import canvas as rlc
            from reportlab.lib.pagesizes import letter
            packet = io.BytesIO()
            c = rlc.Canvas(packet, pagesize=letter)
            f = (req.fields or {})
            # Example coordinates (in points from bottom-left). Adjust to match your AOA form layout.
            def draw_text(val: str, x: float, y: float):
                if not val:
                    return
                c.setFont('Helvetica', 10)
                c.drawString(x, y, str(val))
            def draw_checkbox(checked: bool, x: float, y: float):
                if checked:
                    c.setFont('Helvetica', 12)
                    c.drawString(x, y, '✔')

            draw_text(f.get('ownerName', ''), 72*1.2, 72*9.8)
            draw_text(f.get('email', ''), 72*1.2, 72*9.5)
            draw_text(f.get('phone', ''), 72*4.0, 72*9.5)
            draw_text(f.get('propertyAddress', ''), 72*1.2, 72*9.2)
            draw_text(f.get('city', ''), 72*1.2, 72*8.9)
            draw_text(f.get('state', ''), 72*3.5, 72*8.9)
            draw_text(f.get('zip', ''), 72*4.2, 72*8.9)
            draw_text(f.get('date', ''), 72*5.8, 72*8.9)
            draw_checkbox(bool(f.get('authorize')), 72*1.2, 72*8.6)

            c.save()
            packet.seek(0)
            overlay = packet
        except Exception:
            overlay = None

        base_reader = PdfReader(io.BytesIO(base_pdf))
        writer = PdfWriter()
        if overlay:
            overlay_reader = PdfReader(overlay)
        else:
            overlay_reader = None

        for i, page in enumerate(base_reader.pages):
            if i == 0 and overlay_reader and len(overlay_reader.pages):
                page.merge_page(overlay_reader.pages[0])
            writer.add_page(page)

        merged = io.BytesIO()
        writer.write(merged)
        merged_bytes = merged.getvalue()

        # Overlay signature if provided
        sig_bytes = _decode_data_url(req.signature or '') if req.signature else b''
        final_pdf = _overlay_signature(merged_bytes, sig_bytes) if sig_bytes else merged_bytes

        root = _ensure_storage_dir()
        ts = datetime.utcnow().strftime('%Y%m%d-%H%M%S')
        name = f"signed_{req.accountId or 'unknown'}_{ts}.pdf"
        path = root / name
        with open(path, 'wb') as f:
            f.write(final_pdf)

        # update index
        index_path = root / 'index.json'
        try:
            import json
            entries = []
            if index_path.exists():
                entries = json.loads(index_path.read_text('utf-8') or '[]')
            entries.append({'accountId': req.accountId, 'file': name, 'storedAt': ts, 'size': len(final_pdf)})
            index_path.write_text(json.dumps(entries, indent=2), 'utf-8')
        except Exception:
            pass

        return { 'ok': True, 'file': name }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/detail/{account_id}", response_model=DetailResponse)
async def get_detail(account_id: str):
    try:
        account_id = normalize_account_id(account_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    try:
        # DB-only: try to build detail from Postgres; do NOT scrape
        engine = _db_engine_or_none()
        if engine is None:
            raise HTTPException(status_code=503, detail="database_unavailable")
        with engine.connect() as conn:
            db_detail = _build_detail_from_db(conn, account_id)
        if db_detail:
            # If critical fields are missing, attempt a light scrape to fill them
            try:
                pl = (db_detail.get("property_location") or {}) if isinstance(db_detail, dict) else {}
                owner = (db_detail.get("owner") or {}) if isinstance(db_detail, dict) else {}
                need_loc = not bool(pl.get("address") or pl.get("subject_address")) or not bool(pl.get("neighborhood")) or not bool(pl.get("mapsco"))
                need_owner = owner.get("mailing_address") in (None, "")
                need_legal = not bool((db_detail.get("legal_description") or {}).get("lines"))
                if need_loc or need_owner or need_legal:
                    async with httpx.AsyncClient(timeout=TIMEOUT, follow_redirects=True) as client:
                        detail_html = await _fetch_text(client, _mkurl(ACCOUNT_PATH, account_id))
                    parsed = parse_detail_html(html=detail_html)
                    parsed_pl = (parsed.get("property_location") or {}) if isinstance(parsed, dict) else {}
                    parsed_owner = (parsed.get("owner") or {}) if isinstance(parsed, dict) else {}
                    parsed_legal = (parsed.get("legal_description") or {}) if isinstance(parsed, dict) else {}
                    # Merge location
                    if parsed_pl:
                        db_detail.setdefault("property_location", {})
                        if isinstance(db_detail["property_location"], dict):
                            if parsed_pl.get("address") and not db_detail["property_location"].get("address"):
                                db_detail["property_location"]["address"] = parsed_pl.get("address")
                            if parsed_pl.get("neighborhood") and not db_detail["property_location"].get("neighborhood"):
                                db_detail["property_location"]["neighborhood"] = parsed_pl.get("neighborhood")
                            if parsed_pl.get("mapsco") and not db_detail["property_location"].get("mapsco"):
                                db_detail["property_location"]["mapsco"] = parsed_pl.get("mapsco")
                            # Ensure subject_address mirrors address
                            addr = db_detail["property_location"].get("address")
                            db_detail["property_location"]["subject_address"] = addr
                    # Merge owner mailing (prefer parsed; fallback to direct DOM scrape)
                    if not owner.get("mailing_address"):
                        mailing = parsed_owner.get("mailing_address") if isinstance(parsed_owner, dict) else None
                        if not mailing:
                            try:
                                soup = BeautifulSoup(detail_html, "lxml")
                                sp = soup.find(id="lblOwner")
                                if sp is not None:
                                    lines = []
                                    for sib in sp.next_siblings:
                                        if getattr(sib, "name", None) == "span" and "DtlSectionHdr" in (sib.get("class") or []):
                                            break
                                        if isinstance(sib, str):
                                            t = sib.strip()
                                            if t:
                                                lines.append(t)
                                        else:
                                            t = (sib.get_text(" ") or "").strip()
                                            if t:
                                                lines.append(t)
                                    # normalize and derive mailing lines
                                    norm = [re.sub(r"\s+", " ", s).strip() for s in lines if s and s.strip()]
                                    if norm:
                                        # helper to detect address-like lines
                                        def looks_addr(s: str) -> bool:
                                            s_low = (s or "").lower()
                                            if any(k in s_low for k in [
                                                "multi-owner", "owner name", "ownership %", "application received",
                                                "hs application", "ownership", "owner("
                                            ]):
                                                return False
                                            if re.search(r"\b(tx|texas|[A-Z]{2})\b", s, flags=re.I):
                                                return True
                                            if re.search(r"\b\d{5}(?:-\d{4})?\b", s):
                                                return True
                                            if re.search(r"^\s*\d+\s+", s):
                                                return True
                                            if re.search(r"\b(apt|unit|#|ct|ln|rd|dr|st|ave|blvd|hwy|pkwy|cir|trl|way|lane|drive|court|road)\b", s_low):
                                                return True
                                            if "," in s:
                                                return True
                                            return False

                                        # if second line is co-owner (no digits / no city/state cues), treat as part of name
                                        rest = norm[1:]
                                        if len(norm) > 1 and not looks_addr(norm[1]) and len(norm[1]) <= 40:
                                            rest = norm[2:]
                                        if rest:
                                            addr_lines = [ln for ln in rest if looks_addr(ln)]
                                            if addr_lines:
                                                mailing = ", ".join(addr_lines).replace(" ,", ",").strip(", ")
                            except Exception:
                                pass
                        if mailing:
                            db_detail.setdefault("owner", {})
                            db_detail["owner"]["mailing_address"] = mailing
                    # Best-effort persist address fields back to accounts for future requests
                    # Merge legal description if missing
                    if need_legal and isinstance(parsed_legal, dict) and parsed_legal.get("lines"):
                        db_detail["legal_description"] = parsed_legal

                    try:
                        with engine.begin() as conn2:
                            addr = (db_detail.get("property_location") or {}).get("address")
                            nbh = (db_detail.get("property_location") or {}).get("neighborhood")
                            mco = (db_detail.get("property_location") or {}).get("mapsco")
                            # subdivision from first legal_description line
                            subdivisions = None
                            try:
                                ld = db_detail.get("legal_description") if isinstance(db_detail, dict) else None
                                lines = (ld or {}).get("lines") if isinstance(ld, dict) else None
                                if isinstance(lines, list) and lines:
                                    subdivisions = lines[0]
                            except Exception:
                                subdivisions = None
                            mailing_persist = (db_detail.get("owner") or {}).get("mailing_address")
                            if addr or nbh or mco or mailing_persist:
                                conn2.execute(
                                    _sql_text(f"UPDATE {_tblname('accounts')} SET address=COALESCE(:a,address), neighborhood_code=COALESCE(:n,neighborhood_code), mapsco=COALESCE(:m,mapsco), subdivision=COALESCE(:s, subdivision) WHERE account_id=:id"),
                                    {"a": addr, "n": nbh, "m": mco, "s": subdivisions, "id": account_id},
                                )
                                if mailing_persist:
                                    conn2.execute(
                                        _sql_text(f"UPDATE {_tblname('owner_summary')} SET mailing_address=COALESCE(:mail, mailing_address) WHERE account_id=:id"),
                                        {"mail": mailing_persist, "id": account_id},
                                    )
                                # Persist legal description if we have it and know the tax year
                                legal = db_detail.get("legal_description") if isinstance(db_detail, dict) else None
                                ty = db_detail.get("tax_year") if isinstance(db_detail, dict) else None
                                if legal and isinstance(legal, dict) and legal.get("lines") and ty:
                                    conn2.execute(
                                        _sql_text(
                                            f"""
                                            INSERT INTO {_tblname('legal_description_current')} (
                                              account_id, tax_year, legal_lines, legal_text, deed_transfer_raw, deed_transfer_date
                                            ) VALUES (
                                              :account_id, :tax_year, CAST(:legal_lines_json AS JSONB), :legal_text, :deed_raw, :deed_date
                                            )
                                            ON CONFLICT (account_id) DO UPDATE SET
                                              tax_year = EXCLUDED.tax_year,
                                              legal_lines = EXCLUDED.legal_lines,
                                              legal_text = EXCLUDED.legal_text,
                                              deed_transfer_raw = EXCLUDED.deed_transfer_raw,
                                              deed_transfer_date = COALESCE(EXCLUDED.deed_transfer_date, {_tblname('legal_description_current')}.deed_transfer_date)
                                            """
                                        ),
                                        {
                                            "account_id": account_id,
                                            "tax_year": ty,
                                            "legal_lines_json": json.dumps(legal.get("lines")),
                                            "legal_text": "; ".join(legal.get("lines") or []),
                                            "deed_raw": legal.get("deed_transfer_date"),
                                            "deed_date": None,
                                        },
                                    )
                    except Exception:
                        pass
            except Exception:
                pass
            # Ensure owner_history is present; if empty, fetch from history page
            try:
                hist = db_detail.get("history") if isinstance(db_detail, dict) else None
                oh = (hist or {}).get("owner_history") if isinstance(hist, dict) else None
                if not oh:
                    full_hist = await build_history_for_account(account_id)
                    if isinstance(full_hist, dict):
                        db_detail.setdefault("history", {})
                        if isinstance(db_detail["history"], dict):
                            db_detail["history"].update({
                                "owner_history": full_hist.get("owner_history", []),
                                "history_url": full_hist.get("history_url"),
                            })
            except Exception:
                pass
            # Ensure exemptions history is present as well
            try:
                hist = db_detail.get("history") if isinstance(db_detail, dict) else None
                ex_hist = (hist or {}).get("exemptions") if isinstance(hist, dict) else None
                if not ex_hist:
                    full_hist2 = await build_history_for_account(account_id)
                    if isinstance(full_hist2, dict):
                        db_detail.setdefault("history", {})
                        if isinstance(db_detail["history"], dict):
                            db_detail["history"].update({
                                "exemptions": full_hist2.get("exemptions", []),
                                "history_url": db_detail["history"].get("history_url") or full_hist2.get("history_url"),
                            })
            except Exception:
                pass
            # Ensure exemptions_table (details history) is present; build via parse_detail using history HTML
            try:
                if not db_detail.get("exemptions_table"):
                    async with httpx.AsyncClient(timeout=TIMEOUT, follow_redirects=True) as client:
                        exdt_hist_html = await _fetch_text(client, _mkurl(EXEMPT_DETAILS_HISTORY_PATH, account_id))
                    try:
                        parsed_tmp = parse_detail_html(html=" ", exemption_details_history_html=exdt_hist_html)
                        ex_table = (parsed_tmp or {}).get("exemptions_table")
                        if ex_table:
                            db_detail["exemptions_table"] = ex_table
                    except Exception:
                        pass
            except Exception:
                pass

            return DetailResponse(account_id=account_id, detail=db_detail)
        raise HTTPException(status_code=404, detail="not_found_in_db")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"db_lookup_failed: {e}")

def _row_to_item(row: Dict[str, Any]) -> AddressSearchItem:
    return AddressSearchItem(
        account_id=row.get("account_id", ""),
        address=row.get("address", ""),
        city=row.get("city", ""),
        owner=row.get("owner", ""),
        total_value=row.get("total_value", ""),
        type=row.get("type", ""),
        detail_url=row.get("detail_url", ""),
    )

@app.get("/search/address", response_model=AddressSearchDetailsResponse, response_model_exclude_none=True)
async def address_search(
    q: str = Query(..., description="Street or 'number street' (e.g., 'SNOWMASS' or '1909 SNOWMASS')"),
    city: str | None = Query(None),
    dir: str | None = Query(None, description="Street direction (N, S, E, W)"),
    include_detail: int | bool = Query(0, description="0=summary only, 1=also fetch detail"),
    max_results: int = Query(50, ge=1, le=50, description="Page size (API cap 50)"),
    offset: int = Query(0, ge=0, description="Pagination offset (0, 50, 100, …)"),
):
    # DB-only mode: disable remote DCAD search and return no results
    return AddressSearchDetailsResponse(query=q, total=0, offset=offset, count=0, results=[])
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT, follow_redirects=True) as client:
            full_rows = await _search_address_paged(client, q=q, city=city, direction=dir)

        total = len(full_rows)
        page_rows = full_rows[offset : offset + max_results]
        items = [_row_to_item(r) for r in page_rows]

        if not bool(int(include_detail)):
            return AddressSearchDetailsResponse(
                query=q, total=total, offset=offset, count=len(items),
                results=[AddressSearchDetailsItem(summary=it) for it in items],
            )

        sem = asyncio.Semaphore(6)

        async def fetch_detail(it: AddressSearchItem) -> AddressSearchDetailsItem:
            async with sem:
                try:
                    acc = normalize_account_id(it.account_id)
                    (
                        detail_html,
                        history_html,
                        exemption_details_html,
                        exemption_details_history_html,
                        acct_url,
                        hist_url,
                        exdt_url,
                        exdt_hist_url,
                    ) = await _fetch_all(acc)

                    owner_html, market_html, taxable_html = _split_history(history_html)

                    parsed = _call_parse_detail_html_compat(
                        account_id=acc,
                        detail_html=detail_html,
                        history_owner_html=owner_html,
                        history_market_html=market_html,
                        history_taxable_html=taxable_html,
                        exemption_details_html=exemption_details_html or "",
                        exemption_details_history_html=exemption_details_history_html or "",
                    )

                    parsed.setdefault("history", {}) if isinstance(parsed.get("history"), dict) else parsed.update({"history": {}})
                    parsed["history"].setdefault("history_url", hist_url)

                    parsed.setdefault("exemption_details", {}) if isinstance(parsed.get("exemption_details"), dict) else parsed.update({"exemption_details": {}})
                    parsed["exemption_details"].setdefault("details_url", exdt_url)

                    latest = _parse_exempt_detail_history_latest(exemption_details_history_html)
                    if latest:
                        parsed["exemption_history_latest"] = {**latest, "history_url": exdt_hist_url}
                    else:
                        parsed.setdefault("exemption_history_latest", {"history_url": exdt_hist_url})

                    # NEW: ensure inline detail also has full history populated
                    try:
                        full_history = await build_history_for_account(acc)
                        parsed["history"] = full_history
                    except Exception:
                        pass

                    return AddressSearchDetailsItem(summary=it, detail=parsed)
                except Exception as e:
                    return AddressSearchDetailsItem(summary=it, error=str(e))

        details = await asyncio.gather(*[fetch_detail(it) for it in items])
        return AddressSearchDetailsResponse(query=q, total=total, offset=offset, count=len(details), results=details)

    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=e.response.status_code, detail=f"Search failed: {e.request.url}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"address_search_failed: {e}")
