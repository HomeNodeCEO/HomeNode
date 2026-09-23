# scraper/dcad/fetch.py
import time
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Generator
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

# Friendly headers to help avoid trivial bot blocking
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

_worker_session = ContextVar("dcad_worker_session", default=None)
_MAX_SESSION_ACCOUNTS = 100

def _new_session() -> requests.Session:
    s = requests.Session()
    s.headers.update(DEFAULT_HEADERS)
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
    """Use one account-scoped cookie jar, optionally reusing worker connections."""
    holder = _worker_session.get()
    if holder is None:
        s = _new_session()
        try:
            yield s
        finally:
            s.close()
        return

    if holder["session"] is None:
        holder["session"] = _new_session()
    s = holder["session"]
    try:
        yield s
    except BaseException:
        holder["session"] = None
        s.close()
        raise
    else:
        # Preserve per-account cookie isolation while retaining keep-alive TCP.
        s.cookies.clear()
        holder["accounts"] += 1
        if holder["accounts"] >= holder["maximum_accounts"]:
            holder["session"] = None
            holder["accounts"] = 0
            s.close()


@contextmanager
def reuse_browser_for_worker(maximum_accounts: int = _MAX_SESSION_ACCOUNTS) -> Generator[None, None, None]:
    """Scope HTTP connection reuse to one sequential worker or batch."""
    if maximum_accounts < 1:
        raise ValueError("maximum_accounts must be positive")
    if _worker_session.get() is not None:
        yield
        return
    holder = {"session": None, "accounts": 0, "maximum_accounts": maximum_accounts}
    token = _worker_session.set(holder)
    try:
        yield
    finally:
        _worker_session.reset(token)
        if holder["session"] is not None:
            holder["session"].close()

def polite_pause(seconds: float = 1.0) -> None:
    """Small, configurable delay between requests."""
    time.sleep(seconds)

def _get(session: requests.Session, url: str, timeout: float = 30.0) -> str:
    resp = session.get(url, timeout=timeout)
    resp.raise_for_status()
    return resp.text

def get_detail_html(session: requests.Session, account_id: str) -> str:
    """Residential Account Detail HTML."""
    url = f"https://www.dallascad.org/AcctDetailRes.aspx?ID={account_id}"
    return _get(session, url)

def get_history_html(session: requests.Session, account_id: str) -> str:
    """Account History HTML."""
    url = f"https://www.dallascad.org/AcctHistory.aspx?ID={account_id}"
    return _get(session, url)
