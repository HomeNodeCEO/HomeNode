# scraper/dcad/fetch.py
import re
import time
from contextlib import contextmanager
from typing import Generator
from urllib.parse import parse_qs, urlparse

import requests
from bs4 import BeautifulSoup
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

MAX_HTML_BYTES = 5 * 1024 * 1024
_ALLOWED_HOSTS = {"dallascad.org", "www.dallascad.org"}


class DcadResponseValidationError(RuntimeError):
    """Raised when a successful HTTP response is not the requested DCAD page."""


def _response_text(resp: requests.Response, max_bytes: int = MAX_HTML_BYTES) -> str:
    """Read one bounded HTML response without trusting Content-Length alone."""
    content_type = str(resp.headers.get("Content-Type") or "").lower()
    if content_type and not any(
        allowed in content_type for allowed in ("text/html", "application/xhtml+xml")
    ):
        raise DcadResponseValidationError("dcad_response_content_type_invalid")

    declared_length = resp.headers.get("Content-Length")
    if declared_length:
        try:
            length = int(declared_length)
            if length < 0:
                raise DcadResponseValidationError("dcad_response_length_invalid")
            if length > max_bytes:
                raise DcadResponseValidationError("dcad_response_too_large")
        except ValueError:
            raise DcadResponseValidationError("dcad_response_length_invalid")

    body = bytearray()
    for chunk in resp.iter_content(chunk_size=64 * 1024):
        if not chunk:
            continue
        body.extend(chunk)
        if len(body) > max_bytes:
            raise DcadResponseValidationError("dcad_response_too_large")
    encoding = resp.encoding or "utf-8"
    return bytes(body).decode(encoding, errors="replace")


def _validate_final_url(
    resp: requests.Response, expected_path: str, expected_account_id: str
) -> None:
    for hop in [*(resp.history or []), resp]:
        hop_url = urlparse(str(hop.url or ""))
        if (
            hop_url.scheme.lower() != "https"
            or (hop_url.hostname or "").lower() not in _ALLOWED_HOSTS
        ):
            raise DcadResponseValidationError("dcad_response_redirect_invalid")
    parsed = urlparse(str(resp.url or ""))
    if parsed.path.lower() != expected_path.lower():
        raise DcadResponseValidationError("dcad_response_redirect_invalid")
    final_account = _account_from_action(str(resp.url or ""))
    if final_account and final_account != expected_account_id:
        raise DcadResponseValidationError("dcad_response_redirect_account_mismatch")


def _account_from_action(action: str | None) -> str | None:
    if not action:
        return None
    query = parse_qs(urlparse(action).query)
    for key, values in query.items():
        if key.lower() == "id" and values:
            return str(values[0]).strip()
    return None


def _validated_account_id(account_id: str) -> str:
    value = str(account_id or "").strip()
    if not re.fullmatch(r"[0-9]{17}", value):
        raise ValueError("dcad_account_id_invalid")
    return value


def _validate_account_page(html: str, expected_account_id: str, page: str) -> None:
    """Require stable page identity and exact agreement on every account marker."""
    soup = BeautifulSoup(html, "html.parser")
    title = " ".join((soup.title.get_text(" ", strip=True) if soup.title else "").split())
    expected_title = "Residential Acct Detail" if page == "detail" else "Account History"
    if expected_title.lower() not in title.lower():
        raise DcadResponseValidationError(f"dcad_{page}_page_identity_missing")

    account_markers: list[str] = []
    page_title = soup.find(id="lblPageTitle")
    if page_title is not None:
        match = re.search(r"#\s*([0-9]{10,20})\b", page_title.get_text(" "))
        if match:
            account_markers.append(match.group(1))

    if page == "detail":
        for marker_id in ("txtAccountNumber", "hdnReschedAcctNum"):
            marker = soup.find(id=marker_id)
            value = str(marker.get("value") or "").strip() if marker is not None else ""
            if value:
                account_markers.append(value)

    form = soup.find("form", id="Form1") or soup.find("form", attrs={"name": "Form1"})
    action_account = _account_from_action(form.get("action") if form is not None else None)
    if action_account:
        account_markers.append(action_account)

    if not account_markers:
        raise DcadResponseValidationError(f"dcad_{page}_account_identity_missing")
    if any(marker != expected_account_id for marker in account_markers):
        raise DcadResponseValidationError(f"dcad_{page}_account_identity_mismatch")

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
    """Context-managed requests.Session with reasonable defaults."""
    s = _new_session()
    try:
        yield s
    finally:
        s.close()

def polite_pause(seconds: float = 1.0) -> None:
    """Small, configurable delay between requests."""
    time.sleep(seconds)

def _get(
    session: requests.Session,
    url: str,
    expected_path: str,
    expected_account_id: str,
    page: str,
    timeout: float = 30.0,
) -> str:
    resp = session.get(url, timeout=timeout, stream=True, allow_redirects=True)
    resp.raise_for_status()
    _validate_final_url(resp, expected_path, expected_account_id)
    html = _response_text(resp)
    _validate_account_page(html, expected_account_id, page)
    return html

def get_detail_html(session: requests.Session, account_id: str) -> str:
    """Residential Account Detail HTML."""
    account_id = _validated_account_id(account_id)
    url = f"https://www.dallascad.org/AcctDetailRes.aspx?ID={account_id}"
    return _get(session, url, "/AcctDetailRes.aspx", account_id, "detail")

def get_history_html(session: requests.Session, account_id: str) -> str:
    """Account History HTML."""
    account_id = _validated_account_id(account_id)
    url = f"https://www.dallascad.org/AcctHistory.aspx?ID={account_id}"
    return _get(session, url, "/AcctHistory.aspx", account_id, "history")
