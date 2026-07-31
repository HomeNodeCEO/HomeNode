from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Mapping


NULLISH_TEXT = {"", "N/A", "NA", "NONE", "NULL", "UNASSIGNED", "N\\A", "-", "--"}
NO_DATA_PATTERNS = (
    re.compile(r"\bNO\s+DATA\b", re.I),
    re.compile(r"\bNO\s+ACCOUNT\s+(?:DATA|FOUND)\b", re.I),
    re.compile(r"\bACCOUNT\s+(?:DOES\s+NOT\s+EXIST|NOT\s+FOUND)\b", re.I),
)


class IncompleteScrapeError(RuntimeError):
    """Raised when DCAD returned HTML but not a usable property record."""

    def __init__(self, account_id: str, assessment: "CompletenessAssessment") -> None:
        self.account_id = account_id
        self.assessment = assessment
        super().__init__(
            f"Incomplete DCAD detail for {account_id}: {', '.join(assessment.reasons)}"
        )


@dataclass(frozen=True)
class CompletenessAssessment:
    complete: bool
    address_present: bool
    market_value_present: bool
    explicit_no_data: bool
    reasons: tuple[str, ...]


def _meaningful(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        return value.strip().upper() not in NULLISH_TEXT
    return True


def _mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def assess_detail_completeness(
    detail: Mapping[str, Any] | None,
    detail_html: str | None = None,
) -> CompletenessAssessment:
    """Apply a deliberately small check to an already parsed detail response.

    Residential accounts are considered suspicious only when both the situs
    address and market value are absent, or when DCAD explicitly says the
    account has no data. This catches transient blank pages without rejecting
    legitimate parcels that happen to omit one nonessential field.
    """

    parsed = _mapping(detail)
    location = _mapping(parsed.get("property_location"))
    values = _mapping(parsed.get("value_summary"))
    address_present = _meaningful(
        location.get("address") or location.get("subject_address")
    )
    market_value_present = _meaningful(values.get("market_value"))
    page_text = str(detail_html or "")
    explicit_no_data = any(pattern.search(page_text) for pattern in NO_DATA_PATTERNS)

    reasons: list[str] = []
    if explicit_no_data:
        reasons.append("dcad_reported_no_data")
    if not address_present:
        reasons.append("missing_address")
    if not market_value_present:
        reasons.append("missing_market_value")

    complete = not explicit_no_data and (address_present or market_value_present)
    return CompletenessAssessment(
        complete=complete,
        address_present=address_present,
        market_value_present=market_value_present,
        explicit_no_data=explicit_no_data,
        reasons=tuple(reasons),
    )


def require_complete_detail(
    account_id: str,
    detail: Mapping[str, Any] | None,
    detail_html: str | None = None,
) -> CompletenessAssessment:
    assessment = assess_detail_completeness(detail, detail_html)
    if not assessment.complete:
        raise IncompleteScrapeError(account_id, assessment)
    return assessment
