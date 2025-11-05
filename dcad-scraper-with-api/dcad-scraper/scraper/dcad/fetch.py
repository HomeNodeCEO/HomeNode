# scraper/dcad/fetch.py
import time
from contextlib import contextmanager
import requests

DEFAULT_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    )
}

@contextmanager
def browser():
    """Simple requests session as a context manager (sync)."""
    s = requests.Session()
    s.headers.update(DEFAULT_HEADERS)
    try:
        yield s
    finally:
        s.close()

def polite_pause(seconds: float = 1.2):
    """Be nice to the remote site."""
    time.sleep(seconds)

def get_detail_html(session: requests.Session, account_id: str) -> str:
    url = f"https://www.dallascad.org/AcctDetailRes.aspx?ID={account_id}"
    resp = session.get(url, timeout=30)
    resp.raise_for_status()
    return resp.text

def get_history_html(session: requests.Session, account_id: str) -> str:
    url = f"https://www.dallascad.org/AcctHistory.aspx?ID={account_id}"
    resp = session.get(url, timeout=30)
    resp.raise_for_status()
    return resp.text
