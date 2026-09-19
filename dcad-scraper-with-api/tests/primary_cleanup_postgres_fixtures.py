"""Table-free PostgreSQL checks of the exact generated cleanup expressions.

No connection is opened. An operator may execute build_sql() in READ ONLY mode;
it returns fixed synthetic labels and pass/fail flags, never stored account data.
"""
import re

from dcad.field_completeness import PRIMARY_NUMERIC_STRUCTURE_FIELDS, PRIMARY_STRUCTURE_FIELDS, primary_structure_sql
from dcad.primary_cleanup import EXTRA_AMENITY_FIELDS, vacant_zero_cleanup_sql


NUMERICS = {"percent_complete", "depreciation", "bath_count"}
BOOLEANS = {"basement", "sprinkler", "spa", "pool", "sauna"}
FIELDS = ("account_id", *PRIMARY_STRUCTURE_FIELDS, *EXTRA_AMENITY_FIELDS)


def literal(value):
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "true" if value else "false"
    return "'" + str(value).replace("'", "''") + "'"


def fixture_cases():
    legacy = dict.fromkeys(PRIMARY_NUMERIC_STRUCTURE_FIELDS, 0)
    legacy.update(account_id="fixture", actual_age=2025)
    legacy.update(dict.fromkeys(BOOLEANS, False))
    cases = [("legacy_signature", legacy, True, True, False)]
    for field in PRIMARY_STRUCTURE_FIELDS:
        if field in {"year_built", "effective_year_built", "actual_age"}:
            value = 1999 if field != "actual_age" else 20
        elif field in PRIMARY_NUMERIC_STRUCTURE_FIELDS:
            value = 1
        else:
            value = "SLAB" if field == "foundation" else "MEANINGFUL"
        cases.append(("preserve_" + field, {**legacy, field: value}, False, True, True))
    for field in EXTRA_AMENITY_FIELDS:
        value = True if field in BOOLEANS else "PRESENT"
        cases.append(("preserve_" + field, {**legacy, field: value}, False, True, True))
    for label, changes in (
        ("negative_numeric", {"bath_count": -1}),
        ("nan_numeric", {"bath_count": "NaN"}),
        ("infinite_numeric", {"bath_count": "Infinity"}),
        ("negative_story", {"stories_raw": "-1"}),
        ("nonzero_story", {"stories_raw": "1"}),
        ("missing_year_signature", {"year_built": None}),
        ("different_account", {"account_id": "other"}),
    ):
        cases.append((label, {**legacy, **changes}, False, True, True))
    cases.append(("zero_story_text", {**legacy, "stories": "0.000", "stories_raw": "+00e-3"}, True, True, False))
    cases.append(("nullish_text", {**legacy, "foundation": "N/A", "roof_type": "UNKNOWN"}, True, True, False))
    zero = {**legacy, "actual_age": 0}
    cases.append(("all_zero_no_age_signature", zero, False, False, False))
    for field in sorted(PRIMARY_NUMERIC_STRUCTURE_FIELDS):
        for suffix, value, present in (("negative", -1, False), ("positive", 1, True)):
            cases.append((f"presence_{field}_{suffix}", {**zero, field: value}, False, present, present))
    for suffix, value, present in (("zero", "+0.000e9", False), ("negative", "-1", False),
                                   ("positive", "0.01", True), ("text", "ONE STORY", True),
                                   ("infinity", "Infinity", False), ("nan", "NaN", False)):
        cases.append(("story_presence_" + suffix, {**zero, "stories_raw": value}, False, present, present))
    return cases


def build_sql():
    update = vacant_zero_cleanup_sql("fixture_primary")
    start = "UPDATE fixture_primary AS p SET "
    assert update.startswith(start)
    assignments, where = update[len(start):].split(" WHERE ", 1)
    assignment_parts = re.split(r", (?=[a-z_]+ = )", assignments)
    expressions = dict(part.split(" = ", 1) for part in assignment_parts)
    where = where.replace(":account_id", "'fixture'").replace(":vacant_revaluation_year", "2025")
    assert ":account_id" not in where and ":vacant_revaluation_year" not in where
    rows = []
    for label, row, eligible, before, after in fixture_cases():
        values = [literal(label), literal(eligible), literal(before), literal(after)]
        for field in FIELDS:
            kind = ("numeric" if field in NUMERICS else "integer" if field in PRIMARY_NUMERIC_STRUCTURE_FIELDS
                    else "boolean" if field in BOOLEANS else "text")
            values.append(literal(row.get(field)) + "::" + kind)
        rows.append("(" + ", ".join(values) + ")")
    applied = ",\n       ".join(
        f"CASE WHEN decision.eligible THEN {expressions[field]} ELSE p.{field} END AS {field}"
        if field in expressions else f"p.{field}"
        for field in FIELDS
    )
    expected_pairs = ", ".join(literal(field) + ", NULL" for field in expressions)
    original = "jsonb_build_object(" + ", ".join(literal(field) + ", p." + field for field in FIELDS) + ")"
    # Genuine literal zero land/value data is outside this primary-only fixture.
    # Everything except precisely the generated SET columns must remain equal.
    expected = f"CASE WHEN p.expected_eligible THEN {original} || jsonb_build_object({expected_pairs}) ELSE {original} END"
    sql = ("WITH fixture_primary(case_name, expected_eligible, expected_before, expected_after, "
           + ", ".join(FIELDS) + ") AS (VALUES\n" + ",\n".join(rows) + ")\n"
           + "SELECT p.case_name, decision.eligible = p.expected_eligible AS predicate_passed,\n"
           + f"       {primary_structure_sql('p')} = p.expected_before AS presence_before_passed,\n"
           + f"       {primary_structure_sql('cleaned')} = p.expected_after AS presence_after_passed,\n"
           + f"       to_jsonb(cleaned) = ({expected}) AS exact_update_passed\n"
           + "FROM fixture_primary p CROSS JOIN LATERAL (SELECT ((" + where + ") IS TRUE) AS eligible) decision\n"
           + "CROSS JOIN LATERAL (SELECT " + applied + ") cleaned\nORDER BY p.case_name;")
    assert not re.search(r"\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)\b", sql)
    assert "core." not in sql and "app." not in sql
    return sql
