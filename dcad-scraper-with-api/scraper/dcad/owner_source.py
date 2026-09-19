"""Explicit current-owner provenance, independent of certified valuation years."""
from collections.abc import Mapping
import re

_YEAR = re.compile(r"[1-9][0-9]{3}")
_HEADINGS = {
    "owner": re.compile(r"Owner\s*\(\s*Current\s+([1-9][0-9]{3})\s*\)", re.I),
    "parties": re.compile(r"Multi[- ]Owner\s*\(\s*Current\s+([1-9][0-9]{3})\s*\)", re.I),
}
_WITHHELD = frozenset({"WITHHELD", "CONFIDENTIAL", "REDACTED", "NOT AVAILABLE",
    "OWNER WITHHELD", "OWNER INFORMATION WITHHELD", "OWNER INFORMATION CONFIDENTIAL"})
_STATUTORY_WITHHELD = re.compile(
    r"OWNER WITHHELD PER SEC\.?#?\s*25\.025 OR 25\.026 OF TEXAS PROPERTY TAX CODE\.?",
    re.I,
)


def owner_name_key(value) -> str | None:
    if not isinstance(value, str):
        return None
    name = " ".join(value.upper().split())
    if name in {"", "N/A", "NA", "NONE", "NULL", "UNASSIGNED", "N\\A", "-", "--"} or name.endswith("&"):
        return None
    return name


def heading_year(value, kind="owner") -> int | None:
    if not isinstance(value, str) or len(value) > 200:
        return None
    match = _HEADINGS[kind].fullmatch(value.strip())
    return int(match.group(1)) if match else None


def owner_source_year(owner) -> int | None:
    """No valuation/calendar fallback, even for otherwise usable owner names."""
    if not isinstance(owner, Mapping):
        return None
    declared = owner.get("source_year")
    if isinstance(declared, bool) or not _YEAR.fullmatch(str(declared)):
        return None
    year = heading_year(owner.get("source_heading"))
    if year != int(declared):
        return None
    parties_heading = owner.get("parties_source_heading")
    if parties_heading is not None and heading_year(parties_heading, "parties") != year:
        return None
    return year


def owner_withheld(owner) -> bool:
    if not isinstance(owner, Mapping):
        return False
    names = [owner.get("owner_name")]
    parties = owner.get("multi_owner")
    if isinstance(parties, list):
        names.extend(row.get("owner_name") for row in parties if isinstance(row, Mapping))
    for name in names:
        if not isinstance(name, str) or len(name) > 500:
            continue
        normalized = " ".join(name.upper().split())
        if normalized in _WITHHELD or _STATUTORY_WITHHELD.fullmatch(normalized):
            return True
    return False


def owner_bundle_is_usable(owner) -> bool:
    """Shared pre-write eligibility, not a claim that optional fields are full."""
    if (owner_source_year(owner) is None or owner_withheld(owner)
            or not owner_name_key(owner.get("owner_name"))):
        return False
    parties = owner.get("multi_owner")
    return parties is None or (isinstance(parties, list) and all(
        isinstance(party, dict) and owner_name_key(party.get("owner_name"))
        for party in parties
    ))


def owner_source_year_sql(raw_alias: str) -> str:
    """Bounded join key only; fresh parsed provenance is checked independently.

    A four-digit cast cannot overflow. Never substitute raw.tax_year or the
    newest normalized owner for a missing source year.
    """
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", raw_alias):
        raise ValueError("Invalid raw owner alias")
    value = f"({raw_alias}.raw #>> '{{detail,owner,source_year}}')"
    return f"(CASE WHEN {value} ~ '^[1-9][0-9]{{3}}$' THEN {value}::integer END)"
