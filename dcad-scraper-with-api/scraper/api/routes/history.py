# scraper/api/routes/history.py
from __future__ import annotations

from typing import Any, Dict, List
from fastapi import APIRouter, HTTPException
import httpx

# We try the most likely import path first (package root is "scraper"),
# but stay flexible if your project layout differs.
try:
    from scraper.dcad.parse_history import parse_history_html
except Exception:  # pragma: no cover
    try:
        from ..dcad.parse_history import parse_history_html  # type: ignore
    except Exception:
        from ...dcad.parse_history import parse_history_html  # type: ignore

router = APIRouter(prefix="/history", tags=["history"])

DCAD_HISTORY_URL_TMPL = "https://www.dallascad.org/AcctHistory.aspx?ID={account_id}"

def _normalize_history_keys(raw: Dict[str, Any]) -> Dict[str, Any]:
    """
    Normalize whatever the parser returns into our API's contract:
    {
      'history_url': str,
      'owner_history': list,
      'market_value': list,
      'taxable_value': list,
      'exemptions': list
    }
    """
    # Your existing parse_history.py (shared earlier) returns "owner_history" and "value_history".
    # If you've since expanded the parser to return "market_value" / "taxable_value" / "exemptions",
    # these lines will use those exact keys. Otherwise we gracefully map "value_history" -> "market_value".
    owner_history: List[Dict[str, Any]] = raw.get("owner_history") or raw.get("owners") or []
    market_value: List[Dict[str, Any]] = (
        raw.get("market_value") or raw.get("value_history") or []
    )
    taxable_value: List[Dict[str, Any]] = raw.get("taxable_value") or raw.get("tax_values") or []
    exemptions: List[Dict[str, Any]] = raw.get("exemptions") or raw.get("exemption_history") or []

    return {
        "owner_history": owner_history,
        "market_value": market_value,
        "taxable_value": taxable_value,
        "exemptions": exemptions,
    }

async def _fetch_history_html(account_id: str) -> tuple[str, str]:
    """
    Returns (html, url) for the account history page.
    DCAD puts Owner/Legal, Market, Taxable, Exemptions on one HTML page with anchors.
    """
    url = DCAD_HISTORY_URL_TMPL.format(account_id=account_id)
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                      "AppleWebKit/537.36 (KHTML, like Gecko) "
                      "Chrome/121.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://www.dallascad.org/",
        "Connection": "keep-alive",
    }
    timeout = httpx.Timeout(30.0, read=30.0)
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True, headers=headers) as client:
        resp = await client.get(url)
        # DCAD sometimes returns 200 with an error page; we still pass HTML to the parser to decide.
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail="History page not reachable")
        return resp.text, str(resp.url)

async def get_history_for_account(account_id: str) -> Dict[str, Any]:
    """
    Fetch + parse + normalize history for a single account.
    """
    html, final_url = await _fetch_history_html(account_id)
    parsed = parse_history_html(html)  # uses your bs4-based parser
    data = _normalize_history_keys(parsed)
    data["history_url"] = final_url
    return data

@router.get("/{account_id}")
async def history(account_id: str) -> Dict[str, Any]:
    """
    Public API route: GET /history/{account_id}
    Returns the normalized history payload used by the frontend.
    """
    try:
        return await get_history_for_account(account_id)
    except HTTPException:
        raise
    except Exception as e:  # pragma: no cover
        # Fail soft with empty arrays but keep the URL for traceability.
        url = DCAD_HISTORY_URL_TMPL.format(account_id=account_id)
        return {
            "history_url": url,
            "owner_history": [],
            "market_value": [],
            "taxable_value": [],
            "exemptions": [],
            "error": str(e),
        }

# Optional helper you can call from your existing /detail route:
async def attach_history(detail_payload: Dict[str, Any], account_id: str) -> Dict[str, Any]:
    """
    Mutates/returns the given detail payload with a 'history' key attached.
    """
    detail_payload = dict(detail_payload)  # shallow copy to be safe
    detail_payload["history"] = await get_history_for_account(account_id)
    return detail_payload
