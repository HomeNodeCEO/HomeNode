from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Iterable
from urllib.parse import parse_qs, urljoin, urlparse

import requests
from bs4 import BeautifulSoup

from dcad.data_quality import assess_detail_completeness
from dcad.fetch import get_detail_html
from dcad.parse_detail import parse_detail_html


BASE_URL = "https://www.dallascad.org"
SEARCH_URL = f"{BASE_URL}/SearchAddr.aspx"
SPACE_RE = re.compile(r"\s+")
CITY_SUFFIX_RE = re.compile(r"\s*\((?:DALLAS|COLLIN)\s+CO(?:UNTY)?\)\s*$", re.I)
STATE_ZIP_RE = re.compile(r"\s*,?\s*(?:TX|TEXAS)?\s*\d{5}(?:-\d{4})?\s*$", re.I)
STREET_TYPE_RE = re.compile(
    r"\s+(?:ALY|ALLEY|AVE|AVENUE|BLVD|BOULEVARD|CIR|CIRCLE|CT|COURT|DR|DRIVE|"
    r"EXPY|EXPRESSWAY|FWY|FREEWAY|HWY|HIGHWAY|LN|LANE|LOOP|PKWY|PARKWAY|PL|PLACE|"
    r"RD|ROAD|SQ|SQUARE|ST|STREET|TER|TERRACE|TRL|TRAIL|WAY)\.?$",
    re.I,
)
DIRECTION_RE = re.compile(r"^(N|S|E|W|NE|NW|SE|SW)\s+(.+)$", re.I)


@dataclass(frozen=True)
class AddressCandidate:
    account_id: str
    address: str
    city: str
    owner: str = ""
    total_value: str = ""
    property_type: str = ""


def clean_text(value: object) -> str:
    return SPACE_RE.sub(" ", str(value or "").strip())


def address_line(value: object, city: object = None) -> str:
    """Return the situs line without a trailing city/state/ZIP heading."""

    text = clean_text(value).strip(" ,")
    if not text:
        return ""
    city_text = normalize_city(city)
    parts = [clean_text(part) for part in text.split(",") if clean_text(part)]
    if city_text:
        for index, part in enumerate(parts[1:], start=1):
            if normalize_city(part) == city_text:
                return ", ".join(parts[:index])
    if len(parts) >= 3:
        return ", ".join(parts[:-2])
    if len(parts) == 2 and (STATE_ZIP_RE.search(parts[1]) or re.search(r"\d{5}", parts[1])):
        return parts[0]
    return parts[0] if len(parts) > 1 else text


def normalize_address(value: object, city: object = None) -> str:
    text = address_line(value, city).upper()
    text = re.sub(r"[^A-Z0-9]+", " ", text)
    return SPACE_RE.sub(" ", text).strip()


def normalize_city(value: object) -> str:
    text = CITY_SUFFIX_RE.sub("", clean_text(value)).upper()
    text = re.sub(r"[^A-Z0-9]+", " ", text)
    return SPACE_RE.sub(" ", text).strip()


def _tokens(html: str) -> dict[str, str]:
    soup = BeautifulSoup(html, "lxml")
    return {
        field: (soup.find("input", {"name": field}) or {}).get("value", "")
        for field in (
            "__EVENTTARGET",
            "__EVENTARGUMENT",
            "__VIEWSTATE",
            "__VIEWSTATEGENERATOR",
            "__EVENTVALIDATION",
        )
    }


def _parse_results(html: str) -> list[AddressCandidate]:
    soup = BeautifulSoup(html, "lxml")
    rows: list[AddressCandidate] = []
    seen: set[str] = set()
    for link in soup.select('a[href*="AcctDetail"]'):
        href = urljoin(BASE_URL + "/", link.get("href", ""))
        query = parse_qs(urlparse(href).query)
        account_id = (query.get("ID") or query.get("id") or [""])[0].strip().upper()
        if not re.fullmatch(r"[A-Z0-9]{17}", account_id) or account_id in seen:
            continue
        tr = link.find_parent("tr")
        cells = [clean_text(cell.get_text(" ")) for cell in tr.find_all("td")] if tr else []
        address = clean_text(link.get_text(" "))
        city = cells[2] if len(cells) > 2 else ""
        owner = cells[3] if len(cells) > 3 else ""
        total_value = cells[4] if len(cells) > 4 else ""
        property_type = cells[5] if len(cells) > 5 else ""
        rows.append(
            AddressCandidate(
                account_id=account_id,
                address=address,
                city=city,
                owner=owner,
                total_value=total_value,
                property_type=property_type,
            )
        )
        seen.add(account_id)
    return rows


def search_by_address(
    session: requests.Session,
    address: str,
    city: str | None = None,
) -> list[AddressCandidate]:
    """Submit DCAD's ASP.NET address form and return its first result set."""

    source_line = address_line(address, city)
    match = re.match(r"\s*(\d+[A-Z]?(?:-\d+[A-Z]?)?(?:\s+1/2)?)\s+(.+)$", source_line, re.I)
    if not match:
        return []

    initial = session.get(SEARCH_URL, timeout=30)
    initial.raise_for_status()
    soup = BeautifulSoup(initial.text, "lxml")
    form = _tokens(initial.text)
    city_value = ""
    expected_city = normalize_city(city)
    if expected_city:
        for option in soup.select("#listCity option"):
            if normalize_city(option.get_text(" ")) == expected_city:
                city_value = clean_text(option.get("value"))
                break

    street = STREET_TYPE_RE.sub("", match.group(2)).strip()
    direction = ""
    direction_match = DIRECTION_RE.match(street)
    if direction_match:
        direction = direction_match.group(1).upper()
        street = direction_match.group(2)
    form.update(
        {
            "txtAddrNum": match.group(1),
            "txtStName": street,
            "listStDir": direction,
            "listCity": city_value,
            "txtBldgID": "",
            "txtUnitID": "",
            "txtAddrNum1": "",
            "txtAddrNum2": "",
            "AcctTypeCheckList1:chkAcctType:0": "on",
            "cmdSubmit": "Search",
        }
    )
    response = session.post(
        SEARCH_URL,
        data=form,
        headers={"Referer": SEARCH_URL},
        timeout=30,
    )
    response.raise_for_status()
    return _parse_results(response.text)


def exact_candidates(
    candidates: Iterable[AddressCandidate],
    source_address: str,
    source_city: str | None = None,
) -> list[AddressCandidate]:
    expected_address = normalize_address(source_address, source_city)
    expected_city = normalize_city(source_city)
    exact: list[AddressCandidate] = []
    for candidate in candidates:
        if normalize_address(candidate.address, candidate.city) != expected_address:
            continue
        if expected_city and normalize_city(candidate.city) != expected_city:
            continue
        exact.append(candidate)
    return exact


def dcad_site_is_healthy(session: requests.Session, sentinel_account_id: str) -> bool:
    try:
        html = get_detail_html(session, sentinel_account_id)
        detail = parse_detail_html(html)
        return assess_detail_completeness(detail, html).complete
    except Exception:
        return False
