"""Conservative normalization of one observed legacy vacant-row signature.

This does not infer the historical writer or clear a genuine former structure.
An empty Main section alone is never authorization to discard retained values.
"""
from collections.abc import Mapping

from dcad.field_completeness import (
    PRIMARY_NUMERIC_STRUCTURE_FIELDS,
    PRIMARY_STORY_FIELDS,
    PRIMARY_STRUCTURE_FIELDS,
    STRUCTURE_NULLISH_TEXT,
    STRUCTURE_ZERO_PATTERN,
    decimal_or_none,
)


PRIMARY_ALIASES = ("primary_improvements", "main_improvement", "main_improvements", "primary")
# This mutation path is deliberately narrower than general classification.
# Only the complete DCAD label verified for this legacy signature is accepted;
# near matches such as NOT VACANT or an unfamiliar code preserve the row.
EXPLICIT_VACANT_CODES = frozenset({"SFR - VACANT LOTS/TRACTS"})
EXTRA_AMENITY_FIELDS = ("basement", "sprinkler", "spa", "pool", "sauna",
                        "fence_type", "deck", "basement_raw")


def vacant_zero_cleanup_year(detail: Mapping) -> int | None:
    """Require this attempt's empty Main plus corroborated, explicit vacancy."""
    present = [detail[key] for key in PRIMARY_ALIASES if key in detail]
    if not present or any(not isinstance(value, Mapping) or value for value in present):
        return None
    if detail.get("secondary_improvements") or detail.get("additional_improvements"):
        return None
    land = detail.get("land_detail")
    if not isinstance(land, list) or not land or any(
        not isinstance(row, Mapping)
        or " ".join(str(row.get("state_code") or "").upper().split()) not in EXPLICIT_VACANT_CODES
        for row in land
    ):
        return None
    values = detail.get("value_summary")
    if not isinstance(values, Mapping):
        return None
    market = decimal_or_none(values.get("market_value"))
    if (market is None or market <= 0 or market != decimal_or_none(values.get("land_value"))
            or decimal_or_none(values.get("improvement_value")) != 0):
        return None
    year = decimal_or_none(values.get("revaluation_year"))
    certified = decimal_or_none(values.get("certified_year"))
    if (year is None or certified is None or year != year.to_integral_value()
            or certified != certified.to_integral_value()
            or not 1000 <= year <= certified <= 9999
            or certified != decimal_or_none(detail.get("tax_year"))):
        return None
    return int(year)


def vacant_zero_cleanup_sql(table: str) -> str:
    """One account-scoped UPDATE; the predicate rechecks the current locked row.

    All nonzero or ambiguous fields block cleanup, even those that are not valid
    structural evidence. Only numeric zero placeholders and the exact positive
    age/revaluation-year signature are cleared. The row itself is retained.
    """
    # The caller supplies its configured, qualified primary-improvements table,
    # just as it does for the surrounding upsert statements.
    nullish = ", ".join("'" + value.replace("'", "''") + "'"
                        for value in sorted(STRUCTURE_NULLISH_TEXT - {"TRUE"}))
    predicates = ["p.account_id = :account_id", "p.year_built = 0",
                  "p.effective_year_built = 0", "p.actual_age = :vacant_revaluation_year"]
    assignments = []
    for field in PRIMARY_STRUCTURE_FIELDS:
        if field == "actual_age":
            assignments.append("actual_age = NULL")
        elif field in PRIMARY_NUMERIC_STRUCTURE_FIELDS:
            predicates.append(f"(p.{field} IS NULL OR p.{field} = 0)")
            assignments.append(f"{field} = NULLIF(p.{field}, 0)")
        else:
            value = f"btrim(COALESCE(p.{field}::text, ''))"
            allowed = f"upper({value}) IN ({nullish})"
            if field in PRIMARY_STORY_FIELDS:
                allowed = f"({allowed} OR {value} ~ '{STRUCTURE_ZERO_PATTERN}')"
                assignments.append(f"{field} = CASE WHEN {value} ~ '{STRUCTURE_ZERO_PATTERN}' "
                                   f"THEN NULL ELSE p.{field} END")
            predicates.append(allowed)
    # Presence checks intentionally exclude absent amenity defaults. Cleanup is
    # stricter: an affirmative/unknown non-nullish amenity must preserve the row.
    for field in EXTRA_AMENITY_FIELDS:
        predicates.append(f"upper(btrim(COALESCE(p.{field}::text, ''))) "
                          f"IN ({nullish}, 'NO', 'N', '0')")
    return (f"UPDATE {table} AS p SET " + ", ".join(assignments)
            + " WHERE " + " AND ".join(predicates))
