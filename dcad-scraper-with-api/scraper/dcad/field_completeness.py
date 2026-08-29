from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Any, Mapping


NULLISH_TEXT = {"", "N/A", "NA", "NONE", "NULL", "UNASSIGNED", "N\\A", "-", "--"}
VACANT_STATE_CODE_TERMS = ("VACANT", "VAC LOT", "VAC. LOT", "LOTS/TRACTS")

COMMON_REQUIRED_FIELDS = (
    "address",
    "tax_year",
    "market_value",
    "land_value",
    "land_area",
    "owner_name",
    "mailing_address",
    "ownership_percentage",
    "state_code",
    "deed_transfer",
)
IMPROVED_REQUIRED_FIELDS = (
    "improvement_value",
    "building_class",
    "gla",
)
OWNER_REPAIR_FIELDS = {"owner_name", "mailing_address", "ownership_percentage"}
LAND_REPAIR_FIELDS = {"land_value", "land_area", "state_code"}
GLA_REPAIR_FIELDS = {"improvement_value", "building_class", "gla"}


@dataclass(frozen=True)
class FieldCompletenessAssessment:
    property_classification: str
    missing_fields: tuple[str, ...]
    repair_required: bool
    vacant_reason: str | None = None


def meaningful(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        return value.strip().upper() not in NULLISH_TEXT
    return True


def decimal_or_none(value: Any) -> Decimal | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, str):
        cleaned = value.strip().replace("$", "").replace(",", "")
        if cleaned.upper() in NULLISH_TEXT:
            return None
        value = cleaned
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None


def positive(value: Any) -> bool:
    parsed = decimal_or_none(value)
    return parsed is not None and parsed > 0


def state_code_is_vacant(value: Any) -> bool:
    normalized = str(value or "").strip().upper()
    return any(term in normalized for term in VACANT_STATE_CODE_TERMS)


def classify_property(row: Mapping[str, Any]) -> tuple[str, str | None]:
    if bool(row.get("explicit_vacant_state_code")) or state_code_is_vacant(
        row.get("state_codes")
    ):
        return "vacant", "state_code"

    has_primary = bool(row.get("has_primary_improvement"))
    if has_primary or positive(row.get("improvement_value")):
        return "improved", None

    market_value = decimal_or_none(row.get("market_value"))
    land_value = decimal_or_none(row.get("land_value"))
    improvement_value = decimal_or_none(row.get("improvement_value"))
    if (
        not has_primary
        and market_value is not None
        and land_value is not None
        and market_value == land_value
        and (improvement_value is None or improvement_value == 0)
    ):
        return "vacant", "land_equals_market_without_main_improvement"

    return "indeterminate", None


def assess_field_completeness(
    row: Mapping[str, Any],
) -> FieldCompletenessAssessment:
    classification, vacant_reason = classify_property(row)
    missing: list[str] = []

    values = {
        "address": row.get("address"),
        "tax_year": row.get("tax_year"),
        "market_value": row.get("market_value"),
        "land_value": row.get("land_value"),
        "land_area": row.get("land_area"),
        "owner_name": row.get("owner_name"),
        "mailing_address": row.get("mailing_address"),
        "ownership_percentage": row.get("ownership_percentage"),
        "state_code": row.get("state_codes"),
        "deed_transfer": row.get("deed_transfer"),
        "improvement_value": row.get("improvement_value"),
        "building_class": row.get("building_class"),
        "gla": row.get("gla"),
    }

    required = list(COMMON_REQUIRED_FIELDS)
    if classification == "improved":
        required.extend(IMPROVED_REQUIRED_FIELDS)

    for field in required:
        if not meaningful(values[field]):
            missing.append(field)

    return FieldCompletenessAssessment(
        property_classification=classification,
        missing_fields=tuple(missing),
        repair_required=classification == "improved" and bool(missing),
        vacant_reason=vacant_reason,
    )


def repair_request_fields(missing_fields: tuple[str, ...]) -> tuple[str, ...]:
    """Map detailed audit flags to the deployed worker's repair lanes."""
    requested: list[str] = []
    missing = set(missing_fields)
    if missing & OWNER_REPAIR_FIELDS:
        requested.append("owner")
    if missing & LAND_REPAIR_FIELDS:
        requested.append("land")
    if missing & GLA_REPAIR_FIELDS:
        requested.append("gla")
    if missing and not requested:
        # Address, tax-year, market-value, and deed omissions still require a
        # complete detail scrape. The legacy worker's broad detail lane is GLA.
        requested.append("gla")
    return tuple(requested)
