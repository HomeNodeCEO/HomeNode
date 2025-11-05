# scraper/dcad/fetch.py
import time
from contextlib import contextmanager
from typing import Generator

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

# Slightly richer headers to avoid basic bot blocks
DEFAULT_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.dallascad.org/",
    "Connection": "keep-alive",
}

def _new_session() -> requests.Session:
    s = requests.Session()
    s.headers.update(DEFAULT_HEADERS)

    # Retry on transient errors and 429/5xx
    retry = Retry(
        total=3,
        connect=3,
        read=3,
        backoff_factor=0.6,
        status_forcelist=(429, 500, 502, 503, 504),
        allowed_methods=("GET", "HEAD"),
        raise_on_status=False,
    )
    adapter = HTTPAdapter(max_retries=retry, pool_connections=10, pool_maxsize=10)
    s.mount("http://", adapter)
    s.mount("https://", adapter)
    return s

@contextmanager
def browser() -> Generator[requests.Session, None, None]:
    """
    Simple HTTP 'browser' using requests.Session as a context manager (sync).
    Use with: `with browser() as session: ...`
    """
    s = _new_session()
    try:
        yield s
    finally:
        s.close()

def polite_pause(seconds: float = 1.0) -> None:
    """Small sleep between requests."""
    time.sleep(seconds)

def _get(session: requests.Session, url: str, timeout: float = 30.0) -> str:
    resp = session.get(url, timeout=timeout)
    # Raise for non-2xx; Retry adapter will already have attempted
    resp.raise_for_status()
    return resp.text

def get_detail_html(session: requests.Session, account_id: str) -> str:
    """
    Fetch the Residential Account Detail page HTML for a given account.
    Example URL:
      https://www.dallascad.org/AcctDetailRes.aspx?ID=26272500060150000
    """
    url = f"https://www.dallascad.org/AcctDetailRes.aspx?ID={account_id}"
    return _get(session, url)

def get_history_html(session: requests.Session, account_id: str) -> str:
    """
    Fetch the Account History page HTML for a given account.
    """
    url = f"https://www.dallascad.org/AcctHistory.aspx?ID={account_id}"
    return _get(session, url)
