"""Explicitly scoped, read-only-by-default DCAD completeness audit.

Use account IDs or a bounded keyset page for production pilots. Full-campaign
reporting requires --full-scan and cannot apply repairs. Deploy the matching
exact-field worker before --apply. Parsed JSON cannot prove source absence.
"""

from __future__ import annotations

import argparse
import json
import os
from collections import Counter, defaultdict
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any

import psycopg2
from psycopg2.extras import RealDictCursor

from scraper.dcad.field_completeness import (
    assess_field_completeness,
    COMMON_REQUIRED_FIELDS,
    IMPROVED_REQUIRED_FIELDS,
    FieldCompletenessAssessment,
    parsed_verification_row,
    primary_structure_sql,
    repair_request_fields,
    verification_presence,
)


AUDIT_SQL = """
WITH latest_raw AS (
    SELECT DISTINCT ON (r.account_id)
           r.account_id,
           r.fetched_at
    FROM core.dcad_json_raw r
    ORDER BY r.account_id, r.tax_year DESC, r.fetched_at DESC
), latest_owner AS (
    SELECT DISTINCT ON (o.account_id)
           o.account_id,
           o.tax_year,
           o.owner_name,
           o.mailing_address
    FROM core.owner_summary o
    ORDER BY o.account_id, o.tax_year DESC
), party_stats AS (
    SELECT p.account_id,
           count(*) AS party_count,
           count(*) FILTER (WHERE p.ownership_pct IS NULL) AS missing_pct_count,
           sum(p.ownership_pct) FILTER (WHERE p.ownership_pct IS NOT NULL)
               AS ownership_percentage
    FROM core.owner_parties p
    JOIN latest_owner latest
      ON latest.account_id = p.account_id
     AND latest.tax_year = p.tax_year
    GROUP BY p.account_id
), primary_improvement AS (
    SELECT DISTINCT ON (p.account_id)
           p.account_id,
           p.building_class,
           COALESCE(p.living_area_sqft, p.total_living_area, p.total_area_sqft) AS gla
    FROM core.primary_improvements p
    ORDER BY p.account_id
), latest_land_year AS (
    SELECT account_id, max(tax_year) AS tax_year
    FROM core.land_detail
    GROUP BY account_id
), land_stats AS (
    SELECT l.account_id,
           string_agg(DISTINCT NULLIF(btrim(l.state_code), ''), ' | ')
               AS state_codes,
           max(l.area_sqft) AS land_area,
           bool_or(upper(COALESCE(l.state_code, '')) LIKE '%VACANT%'
               OR upper(COALESCE(l.state_code, '')) LIKE '%VAC LOT%'
               OR upper(COALESCE(l.state_code, '')) LIKE '%LOTS/TRACTS%')
               AS explicit_vacant_state_code
    FROM core.land_detail l
    JOIN latest_land_year latest USING (account_id, tax_year)
    GROUP BY l.account_id
)
SELECT t.account_id,
       raw.fetched_at,
       a.address,
       owner.owner_name,
       owner.mailing_address,
       CASE
           WHEN parties.party_count > 0 AND parties.missing_pct_count = 0
           THEN parties.ownership_percentage
           ELSE NULL
       END AS ownership_percentage,
       (improvement.account_id IS NOT NULL) AS has_primary_improvement,
       improvement.building_class,
       improvement.gla,
       values.improvement_value,
       values.land_value,
       values.market_value,
       values.certified_year AS tax_year,
       land.state_codes,
       land.land_area,
       COALESCE(land.explicit_vacant_state_code, false)
           AS explicit_vacant_state_code,
       COALESCE(legal.deed_transfer_date::text, legal.deed_transfer_raw)
           AS deed_transfer,
       state.status AS scrape_status
FROM app.dcad_residential_targets t
LEFT JOIN core.accounts a ON a.account_id = t.account_id
LEFT JOIN latest_raw raw ON raw.account_id = t.account_id
LEFT JOIN latest_owner owner ON owner.account_id = t.account_id
LEFT JOIN party_stats parties ON parties.account_id = t.account_id
LEFT JOIN primary_improvement improvement
  ON improvement.account_id = t.account_id
LEFT JOIN core.value_summary_current values ON values.account_id = t.account_id
LEFT JOIN land_stats land ON land.account_id = t.account_id
LEFT JOIN core.legal_description_current legal ON legal.account_id = t.account_id
LEFT JOIN app.dcad_scrape_state state ON state.account_id = t.account_id
ORDER BY t.account_id
"""

# Deliberately select IDs before inspecting details. The keyset uses the target
# primary key; every expensive detail read below is restricted to one account.
MAX_BATCH_SIZE = 500
KEYSET_SQL = """
SELECT account_id FROM app.dcad_residential_targets
WHERE account_id > %(after_account_id)s
ORDER BY account_id LIMIT %(page_size)s
"""

ACCOUNT_AUDIT_SQL = f"""
SELECT t.account_id, raw.fetched_at, raw.raw -> 'detail' AS parsed_detail,
       a.address, owner.owner_name, owner.mailing_address,
       parties.ownership_percentage,
       {primary_structure_sql("improvement")} AS has_primary_improvement,
       improvement.building_class,
       COALESCE(NULLIF(improvement.living_area_sqft, 0),
                NULLIF(improvement.total_living_area, 0), improvement.total_area_sqft) AS gla,
       value.improvement_value, value.land_value, value.market_value,
       value.certified_year AS tax_year,
       land.state_codes, land.land_area, land.has_land_details,
       COALESCE(legal.deed_transfer_date::text, legal.deed_transfer_raw) AS deed_transfer,
       state.status AS scrape_status,
       q.status AS field_repair_status,
       q.requested_fields AS field_repair_requested_fields,
       q.remaining_fields AS field_repair_remaining_fields
FROM app.dcad_residential_targets t
LEFT JOIN LATERAL (
    SELECT r.tax_year, r.fetched_at, r.raw FROM core.dcad_json_raw r
    WHERE r.account_id = t.account_id
    ORDER BY r.fetched_at DESC, r.tax_year DESC LIMIT 1
) raw ON true
LEFT JOIN core.accounts a ON a.account_id = t.account_id
LEFT JOIN core.owner_summary owner
  ON owner.account_id = t.account_id AND owner.tax_year = raw.tax_year
LEFT JOIN core.primary_improvements improvement ON improvement.account_id = t.account_id
LEFT JOIN core.value_summary_current value
  ON value.account_id = t.account_id AND value.certified_year = raw.tax_year
LEFT JOIN core.legal_description_current legal
  ON legal.account_id = t.account_id AND legal.tax_year = raw.tax_year
LEFT JOIN LATERAL (
    SELECT max(area_sqft) AS land_area, array_agg(state_code) AS state_codes,
           count(*) > 0 AS has_land_details
    FROM core.land_detail WHERE account_id = t.account_id AND tax_year = raw.tax_year
) land ON true
LEFT JOIN LATERAL (
    SELECT CASE WHEN count(*) > 0 AND count(*) = count(ownership_pct)
                THEN sum(ownership_pct) END AS ownership_percentage
    FROM core.owner_parties WHERE account_id = t.account_id AND tax_year = raw.tax_year
) parties ON true
LEFT JOIN app.dcad_scrape_state state ON state.account_id = t.account_id
LEFT JOIN app.dcad_field_repair_queue q ON q.account_id = t.account_id
WHERE t.account_id = %(account_id)s
"""


def json_default(value: Any) -> Any:
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    raise TypeError(f"Cannot serialize {type(value).__name__}")


def scrape_date(value: Any) -> str:
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    return "never_scraped"


def bounded_assessment(row: dict[str, Any]) -> FieldCompletenessAssessment:
    """Use shared classification and the worker's exact presence predicates."""
    codes = row.get("state_codes") or []
    if isinstance(codes, str):
        codes = codes.split(" | ")
    normalized = {**row, "state_codes": codes}
    assessment = assess_field_completeness({
        **normalized, "state_codes": " | ".join(str(code) for code in codes if code),
    })
    required = COMMON_REQUIRED_FIELDS
    if assessment.property_classification == "improved":
        required += IMPROVED_REQUIRED_FIELDS
    presence = verification_presence(normalized)
    missing = tuple(field for field in required if not presence[f"missing_{field}"])
    return FieldCompletenessAssessment(
        assessment.property_classification, missing,
        assessment.property_classification == "improved" and bool(missing),
        assessment.vacant_reason,
    )


def candidate_action(row: dict[str, Any], missing_fields: tuple[str, ...]) -> str:
    if not missing_fields:
        return "none"
    status = row.get("field_repair_status")
    if row.get("scrape_status") == "leased" or status == "leased":
        return "defer_active"
    if row.get("scrape_status") != "succeeded":
        return "defer_primary"
    if row.get("fetched_at") is None or not isinstance(row.get("parsed_detail"), dict):
        return "defer_snapshot"
    requested = set(row.get("field_repair_requested_fields") or ())
    exact = {f"missing_{field}" for field in missing_fields}
    if status == "source_missing":
        # Even new obligations need review here: parser JSON is not source HTML.
        return "defer_terminal"
    if status == "succeeded":
        return "reopen" if exact - requested else "defer_terminal"
    if status is None:
        return "insert"
    if status in {"pending", "retry"}:
        desired = set(repair_request_fields(missing_fields))
        remaining = set(row.get("field_repair_remaining_fields") or ())
        return "merge" if desired - requested or desired - remaining else "none"
    return "defer_terminal"


def queue_candidates(
    cursor, candidates: list[tuple[str, list[str], list[str]]]
) -> int:
    """Merge reviewed candidates without resetting active work or terminal gaps.

    Callers must recheck scoped evidence while holding queue/state/account locks.
    The ON CONFLICT guard additionally handles a concurrent queue insertion.
    """
    changed = 0
    for account_id, flags, requested in candidates:
        cursor.execute(
            """
        INSERT INTO app.dcad_field_repair_queue AS existing (
            account_id, status, requested_fields, remaining_fields,
            attempts, next_attempt_at, reason, updated_at
        )
        VALUES (%(account_id)s, 'pending', %(requested)s::text[], %(requested)s::text[],
                0, now(), 'Queued by bounded exact-field completeness audit', now())
        ON CONFLICT (account_id) DO UPDATE
        SET status = CASE
                WHEN existing.status = 'succeeded' THEN 'pending'
                ELSE existing.status
            END,
            next_attempt_at = CASE
                WHEN existing.status = 'succeeded' THEN now()
                ELSE existing.next_attempt_at
            END,
            requested_fields = ARRAY(SELECT DISTINCT unnest(
                existing.requested_fields || EXCLUDED.requested_fields)),
            remaining_fields = ARRAY(SELECT DISTINCT unnest(
                existing.remaining_fields || EXCLUDED.remaining_fields)),
            updated_at = now()
        WHERE (existing.status IN ('pending', 'retry') AND NOT (
                   existing.requested_fields @> EXCLUDED.requested_fields
                   AND existing.remaining_fields @> EXCLUDED.remaining_fields))
           OR (existing.status = 'succeeded' AND EXISTS (
                   SELECT 1 FROM unnest(EXCLUDED.requested_fields) AS new(field)
                   WHERE left(field, 8) = 'missing_'
                     AND NOT (field = ANY(existing.requested_fields))))
        RETURNING account_id
            """,
            {"account_id": account_id, "requested": requested},
        )
        if cursor.fetchone() is None:
            continue
        changed += 1
        cursor.execute(
            """
        UPDATE core.accounts account
        SET data_quality_status = 'field_repair_queued',
            data_quality_flags = ARRAY(SELECT DISTINCT unnest(
                COALESCE(account.data_quality_flags, ARRAY[]::text[]) || %(flags)s::text[]))
        WHERE account.account_id = %(account_id)s
            """,
            {"account_id": account_id, "flags": flags},
        )
    return changed


def apply_account(cursor, account_id: str) -> str:
    """Re-read current evidence under the worker's queue -> state -> account order."""
    params = {"account_id": account_id}
    cursor.execute(
        "SELECT account_id FROM app.dcad_field_repair_queue "
        "WHERE account_id = %(account_id)s FOR UPDATE SKIP LOCKED", params,
    )
    locked_queue = cursor.fetchone()
    for table in ("app.dcad_scrape_state", "core.accounts"):
        cursor.execute(
            f"SELECT account_id FROM {table} WHERE account_id = %(account_id)s "
            "FOR UPDATE SKIP LOCKED", params,
        )
        if cursor.fetchone() is None:
            return "defer_locked_or_missing"
    cursor.execute(ACCOUNT_AUDIT_SQL, params)
    row = cursor.fetchone()
    if row is None:
        return "defer_not_target"
    if row.get("field_repair_status") is not None and locked_queue is None:
        return "defer_locked_or_changed"
    assessment = bounded_assessment(row)
    if not assessment.repair_required:
        return "no_longer_candidate"
    action = candidate_action(row, assessment.missing_fields)
    if action not in {"insert", "merge", "reopen"}:
        return action
    flags = [f"missing_{field}" for field in assessment.missing_fields]
    changed = queue_candidates(cursor, [(
        account_id, flags, list(repair_request_fields(assessment.missing_fields)),
    )])
    return action if changed else "concurrent_noop"


def run(
    *, apply: bool = False, limit: int | None = None,
    account_ids: list[str] | None = None, batch_size: int | None = None,
    after_account_id: str | None = None, full_scan: bool = False,
) -> dict[str, Any]:
    if sum((account_ids is not None, batch_size is not None, full_scan)) != 1:
        raise ValueError("Choose exactly one scope: account_ids, batch_size, or full_scan")
    if limit is not None and not 1 <= limit <= MAX_BATCH_SIZE:
        raise ValueError(f"limit must be between 1 and {MAX_BATCH_SIZE}")
    if batch_size is not None and not 1 <= batch_size <= MAX_BATCH_SIZE:
        raise ValueError(f"batch_size must be between 1 and {MAX_BATCH_SIZE}")
    if after_account_id is not None and batch_size is None:
        raise ValueError("after_account_id requires batch_size")

    def valid_id(value: Any) -> bool:
        return (isinstance(value, str) and 1 <= len(value) <= 64
                and value.isascii() and value.isalnum())

    if after_account_id is not None and not valid_id(after_account_id):
        raise ValueError("after_account_id must be an ASCII alphanumeric account ID")
    if full_scan and apply:
        raise ValueError("full_scan is reporting-only; apply a reviewed bounded scope instead")
    if account_ids is not None:
        if not account_ids or len(account_ids) > MAX_BATCH_SIZE:
            raise ValueError(f"Provide between 1 and {MAX_BATCH_SIZE} account IDs")
        if any(not valid_id(value) for value in account_ids):
            raise ValueError("account_ids must be ASCII alphanumeric strings; preserve leading zeroes")
        account_ids = list(dict.fromkeys(account_ids))
    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        raise RuntimeError("DATABASE_URL is not set")

    totals = Counter()
    missing_fields = Counter()
    missing_by_classification: dict[str, Counter] = defaultdict(Counter)
    by_date: dict[str, Counter] = defaultdict(Counter)
    samples: dict[str, list[str]] = defaultdict(list)
    candidates: list[str] = []
    actions = Counter()
    apply_counts = Counter()
    apply_results: list[dict[str, str]] = []
    records: list[dict[str, Any]] = []
    apply_errors: list[dict[str, str]] = []
    scope: dict[str, Any] = {
        "mode": "full_scan" if full_scan else "account_ids" if account_ids is not None else "keyset",
        "partial": not full_scan,
        "requested_accounts": len(account_ids) if account_ids is not None else batch_size,
        "scanned_accounts": 0,
        "after_account_id": after_account_id,
        "next_after_account_id": None,
        "has_more": None,
    }

    def inspect_row(row: dict[str, Any]) -> None:
        assessment = bounded_assessment(row)
        classification = assessment.property_classification
        day = scrape_date(row.get("fetched_at"))
        totals["accounts"] += 1
        totals[classification] += 1
        by_date[day]["accounts"] += 1
        by_date[day][classification] += 1
        for field in assessment.missing_fields:
            missing_fields[field] += 1
            missing_by_classification[classification][field] += 1
            by_date[day][f"missing_{field}"] += 1
            if len(samples[field]) < 20:
                samples[field].append(str(row["account_id"]))
        action = "not_improved_candidate"
        if assessment.repair_required:
            totals["repair_candidates"] += 1
            by_date[day]["repair_candidates"] += 1
            action = candidate_action(row, assessment.missing_fields)
            if action in {"insert", "merge", "reopen"}:
                if len(candidates) < (limit or MAX_BATCH_SIZE):
                    candidates.append(str(row["account_id"]))
                else:
                    action = "defer_apply_limit"
        actions[action] += 1
        if not full_scan:
            detail = row.get("parsed_detail")
            parsed = verification_presence(parsed_verification_row(detail)) if isinstance(detail, dict) else {}
            records.append({
                "account_id": row["account_id"], "fetched_at": row.get("fetched_at"),
                "classification": classification, "missing_fields": list(assessment.missing_fields),
                "field_repair_status": row.get("field_repair_status"), "action": action,
                "missing_fields_present_in_parsed_snapshot": [field for field in assessment.missing_fields
                                                              if parsed.get(f"missing_{field}", False)],
                "missing_fields_without_parsed_evidence": [field for field in assessment.missing_fields
                                                           if not parsed.get(f"missing_{field}", False)],
            })

    connection = psycopg2.connect(database_url, cursor_factory=RealDictCursor)
    try:
        connection.set_session(readonly=True)
        with connection.cursor() as cursor:
            cursor.execute("SET LOCAL statement_timeout = '15s'")
            cursor.execute("SET LOCAL lock_timeout = '1s'")
            if batch_size is not None:
                cursor.execute(KEYSET_SQL, {"after_account_id": after_account_id or "",
                                            "page_size": batch_size + 1})
                page = cursor.fetchall()
                account_ids = [str(row["account_id"]) for row in page[:batch_size]]
                scope["has_more"] = len(page) > batch_size
                scope["next_after_account_id"] = account_ids[-1] if account_ids else after_account_id
            if not full_scan:
                for account_id in account_ids or []:
                    cursor.execute(ACCOUNT_AUDIT_SQL, {"account_id": account_id})
                    row = cursor.fetchone()
                    if row is None:
                        totals["requested_ids_not_in_targets"] += 1
                    else:
                        inspect_row(row)
        if full_scan:
            with connection.cursor(name="dcad_field_completeness_audit") as cursor:
                cursor.itersize = 500
                cursor.execute(AUDIT_SQL)
                for row in cursor:
                    inspect_row(row)
        scope["scanned_accounts"] = totals["accounts"]
        connection.rollback()
        if apply:
            connection.set_session(readonly=False)
            # Commit one bounded, revalidated account at a time. Do not retain
            # locks while reading the rest of the pilot or making network calls.
            for account_id in candidates:
                try:
                    with connection.cursor() as cursor:
                        cursor.execute("SET LOCAL statement_timeout = '15s'")
                        cursor.execute("SET LOCAL lock_timeout = '1s'")
                        outcome = apply_account(cursor, account_id)
                    connection.commit()
                    apply_counts[outcome] += 1
                    apply_results.append({"account_id": account_id, "outcome": outcome})
                except Exception as error:
                    connection.rollback()
                    # Do not print SQL/connection strings or conceal earlier
                    # commits. Stop the batch and return explicit partial state.
                    apply_errors.append({"account_id": account_id, "error_type": type(error).__name__})
                    break
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()

    return {
        "applied": apply,
        "scope": scope,
        "counts_are_scope_only": not full_scan,
        "evidence_note": "Parsed snapshots do not establish source absence; source_missing rows require review.",
        "queue_limit": limit,
        "totals": dict(sorted(totals.items())),
        "missing_fields": dict(missing_fields.most_common()),
        "missing_fields_by_classification": {
            key: dict(value.most_common())
            for key, value in sorted(missing_by_classification.items())
        },
        "by_latest_scrape_date": {
            key: dict(sorted(value.items())) for key, value in sorted(by_date.items())
        },
        "sample_account_ids": dict(sorted(samples.items())),
        "repair_candidates_selected": len(candidates),
        "repair_accounts_queued": sum(apply_counts[action] for action in ("insert", "merge", "reopen")),
        "candidate_actions": dict(actions),
        "apply_outcomes": dict(apply_counts),
        "apply_results": apply_results,
        "apply_errors": apply_errors,
        "accounts": records,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Audit an explicit DCAD scope; default is a database-enforced read-only transaction"
    )
    scope = parser.add_mutually_exclusive_group(required=True)
    scope.add_argument("--account-ids", nargs="+", help="Explicit account IDs (at most 500)")
    scope.add_argument("--batch-size", type=int, help="Read one target keyset page (1-500 accounts)")
    scope.add_argument("--full-scan", action="store_true",
                       help="Explicit, potentially expensive full-campaign report; cannot --apply")
    parser.add_argument("--after-account-id", help="Exclusive keyset cursor; requires --batch-size")
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Recheck and merge bounded candidates; retain leases, retry history, and known unresolved cases",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Apply at most this many candidates (1-500); does not limit reads within the chosen scope",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=None,
        help="Optional JSON output path",
    )
    args = parser.parse_args()
    try:
        result = run(
            apply=args.apply, limit=args.limit, account_ids=args.account_ids,
            batch_size=args.batch_size, after_account_id=args.after_account_id,
            full_scan=args.full_scan,
        )
    except ValueError as error:
        parser.error(str(error))
    payload = json.dumps(result, indent=2, default=json_default)
    if args.output:
        args.output.write_text(payload + "\n", encoding="utf-8")
    print(payload)
    return 2 if result["apply_errors"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
