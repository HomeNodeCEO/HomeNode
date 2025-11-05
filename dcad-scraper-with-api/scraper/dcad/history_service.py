# scraper/dcad/history_service.py
from __future__ import annotations

import httpx
from typing import Dict, Any, Optional
from .parse_history import parse_history_html

HISTORY_URL_TMPL = "https://www.dallascad.org/AcctHistory.aspx?ID={account_id}"

async def fetch_text(url: str, timeout: float = 20.0) -> str:
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) MooolahScraper/1.0",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Connection": "keep-alive",
    }
    async with httpx.AsyncClient(headers=headers, timeout=timeout, follow_redirects=True) as client:
        r = await client.get(url)
        r.raise_for_status()
        return r.text

async def build_history_for_account(account_id: str) -> Dict[str, Any]:
    """
    Always constructs the DCAD history URL from the account id (so 'history_url' is never 'N/A'),
    fetches it, parses owner/legal history, value history, and exemptions (if present).
    """
    url = HISTORY_URL_TMPL.format(account_id=account_id)
    try:
        html = await fetch_text(url)
        parsed = parse_history_html(html)
        return {
            "history_url": url,
            "owner_history": parsed.get("owner_history", []),
            "market_value": parsed.get("market_value", []),
            "taxable_value": parsed.get("taxable_value", []),
            "exemptions": parsed.get("exemptions", []),
        }
    except Exception:
        # Return a consistent shape even on failures
        return {
            "history_url": url,
            "owner_history": [],
            "market_value": [],
            "taxable_value": [],
            "exemptions": [],
        }
