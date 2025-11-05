# scraper/api/main.py
from __future__ import annotations

import asyncio
import re
from typing import Any, Dict, List, Optional
from urllib.parse import urljoin, parse_qs, urlparse

import httpx
from bs4 import BeautifulSoup
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from scraper.utils import normalize_account_id
from ..dcad.parse_detail import parse_detail_html

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
ADDRESS_SEARCH_PATH = "/SearchAddr.aspx"

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/120.0.0.0 Safari/537.36"
)
TIMEOUT = httpx.Timeout(30.0)

def make_url(path_template: str, account_id: str) -> str:
    return BASE_URL + path_template.format(account_id=account_id)

def _clean(s: Optional[str]) -> str:
    return re.sub(r"\s+", " ", (s or "").strip())

async def fetch_text(client: httpx.AsyncClient, url: str) -> str:
    resp = await client.get(url, headers={"User-Agent": UA})
    resp.raise_for_status()
    try:
        text = resp.text or resp.content.decode(resp.encoding or "utf-8", errors="ignore")
    except Exception:
        text = resp.content.decode("utf-8", errors="ignore")
    return text

async def fetch_all_pages(account_id: str):
    acct_url = make_url(ACCOUNT_PATH, account_id)
    hist_url = make_url(HISTORY_PATH, account_id)
    exdt_url = make_url(EXEMPT_DETAILS_PATH, account_id)
    async with httpx.AsyncClient(timeout=TIMEOUT, follow_redirects=True) as client:
        acct_html, hist_html, exdt_html = await asyncio.gather(
            fetch_text(client, acct_url),
            fetch_text(client, hist_url),
            fetch_text(client, exdt_url),
        )
    return acct_html, hist_html, exdt_html, acct_url, hist_url, exdt_url

def _extract_aspnet_state_tokens(html: str) -> dict:
    soup = BeautifulSoup(html, "lxml")
    tokens = {}
    for name in ("__VIEWSTATE", "__EVENTVALIDATION", "__VIEWSTATEGENERATOR", "__EVENTTARGET", "__EVENTARGUMENT"):
        el = soup.find("input", {"name": name})
        if el and el.get("value") is not None:
            tokens[name] = el.get("value")
    tokens.setdefault("__EVENTTARGET", "")
    tokens.setdefault("__EVENTARGUMENT", "")
    return tokens

def _parse_address_results(html: str) -> List[Dict[str, str]]:
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
        cells = tr.find_all("td")
        if len(cells) < 6:
            continue
        link = cells[1].find("a", href=True)
        if not link:
            continue

        href = urljoin(BASE_URL + "/", link.get("href"))
        q = parse_qs(urlparse(href).query)
        account_id = (q.get("ID") or q.get("id") or [""])[0].strip()

        rows.append({
            "account_id": account_id,
            "address": _clean(link.get_text()),
            "city": _clean(cells[2].get_text()),
            "owner": _clean(cells[3].get_text()),
            "total_value": _clean(cells[4].get_text()),
            "type": _clean(cells[5].get_text()),
            "detail_url": href,
        })
    return rows

def _find_next_postback(html: str) -> Optional[str]:
    """
    Find the ASP.NET __doPostBack target for 'Next' pagination.
    """
    soup = BeautifulSoup(html, "lxml")
    for a in soup.select("a[href^=\"javascript:__doPostBack\"]"):
        txt = _clean(a.get_text()).upper()
        if "NEXT" in txt or txt in (">", "»"):
            m = re.search(r"__doPostBack\('([^']+)'", a.get("href", ""))
            if m:
                return m.group(1)
    return None

async def _search_by_address_http_paged(client: httpx.AsyncClient, q: str, city: str | None = None, direction: str | None = None, max_pages: int = 200) -> List[Dict[str, str]]:
    """
    Perform DCAD address search and follow 'Next' pages to collect all rows.
    """
    search_url = make_url(ADDRESS_SEARCH_PATH, "")
    r1 = await client.get(search_url, headers={"User-Agent": UA})
    r1.raise_for_status()
    tokens = _extract_aspnet_state_tokens(r1.text)

    house_num, street = "", q
    m = re.match(r"\s*(\d+)\s+(.+)$", q.strip())
    if m:
        house_num, street = m.group(1), m.group(2)

    # First search submit
    form = {
        "__EVENTTARGET": tokens.get("__EVENTTARGET", ""),
        "__EVENTARGUMENT": tokens.get("__EVENTARGUMENT", ""),
        "__VIEWSTATE": tokens.get("__VIEWSTATE", ""),
        "__VIEWSTATEGENERATOR": tokens.get("__VIEWSTATEGENERATOR", ""),
        "__EVENTVALIDATION": tokens.get("__EVENTVALIDATION", ""),
        "txtAddrNum": house_num,
        "txtStName": street,
        "listStDir": (direction or ""),
        "listCity": (city or ""),
        "cmdSubmit": "Search",
    }
    r = await client.post(search_url, data=form, headers={"User-Agent": UA, "Referer": search_url})
    r.raise_for_status()

    all_rows: List[Dict[str, str]] = []
    page_count = 0

    while True:
        page_count += 1
        all_rows.extend(_parse_address_results(r.text))

        if page_count >= max_pages:
            break

        next_target = _find_next_postback(r.text)
        if not next_target:
            break

        # advance to next page
        tokens = _extract_aspnet_state_tokens(r.text)
        form = {
            "__EVENTTARGET": next_target,
            "__EVENTARGUMENT": "",
            "__VIEWSTATE": tokens.get("__VIEWSTATE", ""),
            "__VIEWSTATEGENERATOR": tokens.get("__VIEWSTATEGENERATOR", ""),
            "__EVENTVALIDATION": tokens.get("__EVENTVALIDATION", ""),
        }
        r = await client.post(search_url, data=form, headers={"User-Agent": UA, "Referer": search_url})
        r.raise_for_status()

    # de-dupe while keeping order
    seen = set()
    uniq: List[Dict[str, str]] = []
    for row in all_rows:
        acc = row.get("account_id")
        if acc and acc not in seen:
            uniq.append(row)
            seen.add(acc)
    return uniq

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

@app.get("/health", include_in_schema=False)
def health():
    return {"ok": True}

@app.get("/detail/{account_id}", response_model=DetailResponse)
async def get_detail(account_id: str):
    try:
        account_id = normalize_account_id(account_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    try:
        acct_html, hist_html, exdt_html, acct_url, hist_url, exdt_url = await fetch_all_pages(account_id)
        detail = parse_detail_html(
            html=acct_html,
            history_html=hist_html,
            exemption_details_html=exdt_html,
        )
        if isinstance(detail.get("exemption_details"), dict):
            detail["exemption_details"].setdefault("details_url", exdt_url)
        else:
            detail["exemption_details"] = {"details_url": exdt_url}
        if isinstance(detail.get("history"), dict):
            detail["history"].setdefault("history_url", hist_url)
        else:
            detail["history"] = {
                "history_url": hist_url,
                "owner_history": [],
                "market_value": [],
                "taxable_value": [],
            }
        return DetailResponse(account_id=account_id, detail=detail)
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=e.response.status_code, detail=f"Fetch failed: {e.request.url}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"failed_to_parse_detail: {e}")

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
    include_detail: int | bool = Query(0, description="0=return summary only, 1=also fetch detail per result"),
    max_results: int = Query(50, ge=1, le=50, description="Page size (API-enforced cap 50)"),
    offset: int = Query(0, ge=0, description="Pagination offset (0, 50, 100, …)"),
):
    """
    Address search that crawls ALL DCAD result pages, then paginates locally:
      - total: total matches
      - offset: page start
      - count: items returned (<= max_results)
      - results: [{summary, detail?}]
    """
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT, follow_redirects=True) as client:
            full_rows = await _search_by_address_http_paged(client, q=q, city=city, direction=dir)

        total = len(full_rows)
        page_rows = full_rows[offset : offset + max_results]
        items = [_row_to_item(r) for r in page_rows]

        if not bool(int(include_detail)):
            return AddressSearchDetailsResponse(
                query=q, total=total, offset=offset, count=len(items),
                results=[AddressSearchDetailsItem(summary=it) for it in items],
            )

        sem = asyncio.Semaphore(6)

        async def fetch_detail_for(item: AddressSearchItem) -> AddressSearchDetailsItem:
            async with sem:
                try:
                    acct = normalize_account_id(item.account_id)
                    acct_html, hist_html, exdt_html, acct_url, hist_url, exdt_url = await fetch_all_pages(acct)
                    detail = parse_detail_html(
                        html=acct_html,
                        history_html=hist_html,
                        exemption_details_html=exdt_html,
                    )
                    if isinstance(detail.get("exemption_details"), dict):
                        detail["exemption_details"].setdefault("details_url", exdt_url)
                    else:
                        detail["exemption_details"] = {"details_url": exdt_url}
                    if isinstance(detail.get("history"), dict):
                        detail["history"].setdefault("history_url", hist_url)
                    else:
                        detail["history"] = {
                            "history_url": hist_url,
                            "owner_history": [],
                            "market_value": [],
                            "taxable_value": [],
                        }
                    return AddressSearchDetailsItem(summary=item, detail=detail)
                except Exception as e:
                    return AddressSearchDetailsItem(summary=item, error=str(e))

        detail_results = await asyncio.gather(*[fetch_detail_for(it) for it in items])
        return AddressSearchDetailsResponse(
            query=q, total=total, offset=offset, count=len(detail_results), results=detail_results
        )

    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=e.response.status_code, detail=f"Search failed: {e.request.url}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"address_search_failed: {e}")
