from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
import re
from typing import Any, Mapping

from .owner_source import owner_source_year, owner_withheld


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
# Structural evidence mirrors the normalized worker query. Parser defaults for
# absent amenities (basement, sprinkler, pool, etc.) do not establish a building.
PRIMARY_STRUCTURE_FIELDS = (
    "construction_type", "percent_complete", "year_built", "effective_year_built",
    "actual_age", "depreciation", "desirability", "stories", "stories_raw",
    "living_area_sqft", "total_living_area", "bedroom_count", "bath_count",
    "number_units", "building_class", "total_area_sqft",
    "foundation", "roof_type", "roof_material", "exterior_material",
    "heating", "air_conditioning", "baths_full", "baths_half", "kitchens",
    "wetbars", "fireplaces", "desirability_raw", "desirability_id",
)
PRIMARY_NUMERIC_STRUCTURE_FIELDS = frozenset({
    "percent_complete", "year_built", "effective_year_built", "actual_age",
    "depreciation", "living_area_sqft", "total_living_area", "bedroom_count",
    "bath_count", "number_units", "total_area_sqft", "baths_full", "baths_half",
    "kitchens", "wetbars", "fireplaces", "desirability_id",
})
PRIMARY_STORY_FIELDS = frozenset({"stories", "stories_raw"})
# Shared Python/PostgreSQL grammar avoids casts of arbitrary text (including
# enormous exponents). Zero/negative/NaN numeric placeholders prove no structure.
STRUCTURE_NUMBER_PATTERN = r"^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)([eE][+-]?[0-9]+)?$"
STRUCTURE_POSITIVE_PATTERN = r"^[+]?([0-9]+([.][0-9]*)?|[.][0-9]+)([eE][+-]?[0-9]+)?$"
STRUCTURE_ZERO_PATTERN = r"^[+-]?(0+([.]0*)?|[.]0+)([eE][+-]?[0-9]+)?$"
STRUCTURE_NULLISH_TEXT = NULLISH_TEXT | {
    "UNKNOWN", "NOT AVAILABLE", "NOT APPLICABLE", "NAN", "SNAN",
    "INFINITY", "+INFINITY", "-INFINITY", "INF", "+INF", "-INF",
    "TRUE", "FALSE",
}


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


def primary_structure_present(row: Mapping[str, Any]) -> bool:
    """Recognize actual structural attributes, never absent amenity defaults."""
    for field in PRIMARY_STRUCTURE_FIELDS:
        value = row.get(field)
        normalized = str(value).strip() if value is not None else ""
        if field in PRIMARY_NUMERIC_STRUCTURE_FIELDS or (
            field in PRIMARY_STORY_FIELDS and re.fullmatch(STRUCTURE_NUMBER_PATTERN, normalized)
        ):
            if (re.fullmatch(STRUCTURE_POSITIVE_PATTERN, normalized)
                    and not re.fullmatch(STRUCTURE_ZERO_PATTERN, normalized)):
                return True
        elif normalized.upper() not in STRUCTURE_NULLISH_TEXT:
            return True
    return False


def primary_structure_sql(table_alias: str) -> str:
    """SQL equivalent of primary_structure_present for known normalized columns.

    Only the validated alias is variable; column names and nullish literals are
    local constants shared by the worker and bounded audit.
    """
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", table_alias):
        raise ValueError("Invalid primary-improvement table alias")
    nullish = ", ".join("'" + value.replace("'", "''") + "'"
                        for value in sorted(STRUCTURE_NULLISH_TEXT))
    predicates = []
    for field in PRIMARY_STRUCTURE_FIELDS:
        value = f"btrim(COALESCE({table_alias}.{field}::text, ''))"
        numeric = (f"({value} ~ '{STRUCTURE_POSITIVE_PATTERN}' "
                   f"AND {value} !~ '{STRUCTURE_ZERO_PATTERN}')")
        meaningful_text = f"upper({value}) NOT IN ({nullish})"
        if field in PRIMARY_NUMERIC_STRUCTURE_FIELDS:
            predicates.append(numeric)
        elif field in PRIMARY_STORY_FIELDS:
            predicates.append(f"(CASE WHEN {value} ~ '{STRUCTURE_NUMBER_PATTERN}' "
                              f"THEN {numeric} ELSE {meaningful_text} END)")
        else:
            predicates.append(meaningful_text)
    return "(" + " OR ".join(predicates) + ")"


def decimal_or_none(value: Any) -> Decimal | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, str):
        cleaned = value.strip().replace("$", "").replace(",", "")
        if cleaned.upper() in NULLISH_TEXT:
            return None
        value = cleaned
    try:
        parsed = Decimal(str(value))
        return parsed if parsed.is_finite() else None
    except (InvalidOperation, ValueError):
        return None


def positive(value: Any) -> bool:
    parsed = decimal_or_none(value)
    return parsed is not None and parsed > 0


def state_code_is_vacant(value: Any) -> bool:
    normalized = str(value or "").strip().upper()
    return any(term in normalized for term in VACANT_STATE_CODE_TERMS)


def normalized_state_codes(value: Any) -> list[str]:
    """Accept normalized SQL arrays and the audit's pipe-delimited aggregate."""
    values = value if isinstance(value, (list, tuple)) else str(value or "").split("|")
    return [str(code).strip() for code in values if meaningful(code)]


def classify_property(row: Mapping[str, Any]) -> tuple[str, str | None]:
    has_primary = (bool(row.get("has_primary_improvement"))
                   or positive(row.get("gla")) or primary_structure_present(row))
    if has_primary or positive(row.get("improvement_value")):
        return "improved", None

    codes = normalized_state_codes(row.get("state_codes"))
    vacant_codes = [state_code_is_vacant(code) for code in codes]
    if any(vacant_codes) and not all(vacant_codes):
        return "indeterminate", None
    if codes and all(vacant_codes):
        return "vacant", "state_code"

    market_value = decimal_or_none(row.get("market_value"))
    land_value = decimal_or_none(row.get("land_value"))
    improvement_value = decimal_or_none(row.get("improvement_value"))
    if (
        not has_primary
        and market_value is not None
        and market_value > 0
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
    """Retain exact audit obligations alongside compatible legacy lanes."""
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
    requested.extend(f"missing_{field}" for field in missing_fields)
    return tuple(dict.fromkeys(requested))


def parsed_verification_row(detail: Mapping[str, Any]) -> dict[str, Any]:
    """Flatten this attempt's parsed snapshot, without falling back to old rows.

    This is parser evidence, not proof about the original source HTML. It also
    includes any conservative owner-name recovery performed before persistence.
    """
    def mapping(value: Any) -> Mapping[str, Any]:
        return value if isinstance(value, Mapping) else {}

    location = mapping(detail.get("property_location"))
    owner = mapping(detail.get("owner"))
    values = mapping(detail.get("value_summary"))
    primary = mapping(detail.get("primary_improvements") or detail.get("main_improvement"))
    legal = mapping(detail.get("legal_description"))
    land = [row for row in (detail.get("land_detail") or []) if isinstance(row, Mapping)]
    parties = [row for row in (owner.get("multi_owner") or []) if isinstance(row, Mapping)]
    percentages = [decimal_or_none(str(row.get("ownership_pct", "")).replace("%", ""))
                   for row in parties]
    areas = [decimal_or_none(row.get("area_sqft")) for row in land]
    return {
        "address": location.get("address") or location.get("subject_address"),
        "tax_year": detail.get("tax_year"),
        "owner_source_year": owner_source_year(owner) if not owner_withheld(owner) else None,
        "owner_name": owner.get("owner_name"),
        "mailing_address": owner.get("mailing_address"),
        "ownership_percentage": sum(percentages) if percentages and all(
            value is not None for value in percentages
        ) else None,
        "market_value": values.get("market_value"),
        "land_value": values.get("land_value"),
        "improvement_value": values.get("improvement_value"),
        "land_area": max((value for value in areas if value is not None), default=None),
        "state_codes": [row.get("state_code") for row in land],
        "has_land_details": bool(land),
        "building_class": primary.get("building_class"),
        "gla": next((primary.get(key) for key in (
            "living_area_sqft", "total_living_area", "total_area_sqft"
        ) if positive(primary.get(key))), None),
        "has_primary_improvement": primary_structure_present(primary),
        "deed_transfer": legal.get("deed_transfer_date"),
    }


def verification_not_applicable(row: Mapping[str, Any]) -> frozenset[str]:
    """Return improvement-only obligations waived by affirmative vacant evidence.

    These are not present fields. A repair may waive them only when both its
    normalized row and fresh parsed snapshot independently agree they are N/A.
    """
    if classify_property(row)[0] != "vacant":
        return frozenset()
    return frozenset((*IMPROVED_REQUIRED_FIELDS,
                      *(f"missing_{field}" for field in IMPROVED_REQUIRED_FIELDS)))


def verification_presence(row: Mapping[str, Any]) -> dict[str, bool]:
    """Check exact fields independently; unknown fields are never satisfied."""
    def nonnegative(value: Any) -> bool:
        number = decimal_or_none(value)
        return number is not None and number >= 0

    codes = normalized_state_codes(row.get("state_codes"))
    vacant = classify_property(row)[0] == "vacant"
    owner_dated = bool(re.fullmatch(r"[1-9][0-9]{3}", str(row.get("owner_source_year"))))
    owner_dated = owner_dated and not owner_withheld({"owner_name": row.get("owner_name")})
    exact = {
        "address": meaningful(row.get("address")),
        "tax_year": positive(row.get("tax_year")),
        "market_value": nonnegative(row.get("market_value")),
        "land_value": nonnegative(row.get("land_value")),
        "land_area": positive(row.get("land_area")),
        "owner_name": owner_dated and meaningful(row.get("owner_name"))
        and not bool(re.search(r"&\s*$", str(row.get("owner_name") or ""))),
        "mailing_address": owner_dated and meaningful(row.get("mailing_address")),
        "ownership_percentage": owner_dated and nonnegative(row.get("ownership_percentage")),
        "state_code": bool(codes),
        "deed_transfer": meaningful(row.get("deed_transfer")),
        "improvement_value": nonnegative(row.get("improvement_value")),
        "building_class": meaningful(row.get("building_class")),
        "gla": positive(row.get("gla")),
    }
    presence = {f"missing_{field}": present for field, present in exact.items()}
    presence.update(exact)
    presence.update({"owner": exact["owner_name"],
                     "land": bool(row.get("has_land_details")),
                     "gla": exact["gla"] or vacant})
    return presence
