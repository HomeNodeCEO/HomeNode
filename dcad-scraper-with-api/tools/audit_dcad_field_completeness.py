"""Audit normalized DCAD fields and safely queue incomplete improved parcels.

The command is read-only by default. Use ``--apply`` only after reviewing the
reported classifications and field counts. Vacant parcels are measured but are
never put in the improved-property repair queue.
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
from psycopg2.extras import RealDictCursor, execute_values

from scraper.dcad.field_completeness import (
    assess_field_completeness,
    repair_request_fields,
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
), latest_party_year AS (
    SELECT account_id, max(tax_year) AS tax_year
    FROM core.owner_parties
    GROUP BY account_id
), party_stats AS (
    SELECT p.account_id,
           count(*) AS party_count,
           count(*) FILTER (WHERE p.ownership_pct IS NULL) AS missing_pct_count,
           sum(p.ownership_pct) FILTER (WHERE p.ownership_pct IS NOT NULL)
               AS ownership_percentage
    FROM core.owner_parties p
    JOIN latest_party_year latest
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


def insert_candidates(
    cursor, candidates: list[tuple[str, list[str], list[str]]]
) -> None:
    cursor.execute(
        """
        CREATE TEMP TABLE dcad_field_repair_candidates (
            account_id text PRIMARY KEY,
            flags text[] NOT NULL,
            requested_fields text[] NOT NULL
        ) ON COMMIT DROP
        """
    )
    execute_values(
        cursor,
        """
        INSERT INTO dcad_field_repair_candidates (
            account_id, flags, requested_fields
        )
        VALUES %s
        ON CONFLICT (account_id) DO UPDATE
        SET flags = EXCLUDED.flags,
            requested_fields = EXCLUDED.requested_fields
        """,
        candidates,
        page_size=2_000,
    )


def queue_candidates(
    cursor, candidates: list[tuple[str, list[str], list[str]]]
) -> int:
    if not candidates:
        return 0
    insert_candidates(cursor, candidates)
    cursor.execute(
        """
        INSERT INTO app.dcad_field_repair_queue AS existing (
            account_id, status, requested_fields, remaining_fields,
            attempts, next_attempt_at, reason, updated_at
        )
        SELECT c.account_id, 'pending', c.requested_fields, c.requested_fields,
               0, now(), 'Queued by field-level completeness audit', now()
        FROM dcad_field_repair_candidates c
        ON CONFLICT (account_id) DO UPDATE
        SET status = CASE
                WHEN existing.status = 'leased' THEN existing.status
                ELSE 'pending'
            END,
            attempts = CASE
                WHEN existing.status = 'leased' THEN existing.attempts
                ELSE 0
            END,
            next_attempt_at = CASE
                WHEN existing.status = 'leased' THEN existing.next_attempt_at
                ELSE now()
            END,
            lease_expires_at = CASE
                WHEN existing.status = 'leased' THEN existing.lease_expires_at
                ELSE NULL
            END,
            worker_id = CASE
                WHEN existing.status = 'leased' THEN existing.worker_id
                ELSE NULL
            END,
            requested_fields = EXCLUDED.requested_fields,
            remaining_fields = EXCLUDED.remaining_fields,
            reason = EXCLUDED.reason,
            last_error = CASE
                WHEN existing.status = 'leased' THEN existing.last_error
                ELSE NULL
            END,
            updated_at = now()
        """
    )
    cursor.execute(
        """
        UPDATE core.accounts account
        SET data_quality_status = 'field_repair_queued',
            data_quality_flags = repair.flags
        FROM dcad_field_repair_candidates repair
        WHERE account.account_id = repair.account_id
        """
    )
    return len(candidates)


def run(*, apply: bool = False, limit: int | None = None) -> dict[str, Any]:
    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        raise RuntimeError("DATABASE_URL is not set")

    totals = Counter()
    missing_fields = Counter()
    missing_by_classification: dict[str, Counter] = defaultdict(Counter)
    by_date: dict[str, Counter] = defaultdict(Counter)
    samples: dict[str, list[str]] = defaultdict(list)
    candidates: list[tuple[str, list[str], list[str]]] = []

    connection = psycopg2.connect(database_url, cursor_factory=RealDictCursor)
    try:
        with connection.cursor(name="dcad_field_completeness_audit") as cursor:
            cursor.itersize = 2_000
            cursor.execute(AUDIT_SQL)
            for row in cursor:
                assessment = assess_field_completeness(row)
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

                if assessment.repair_required:
                    totals["repair_candidates"] += 1
                    by_date[day]["repair_candidates"] += 1
                    if row.get("scrape_status") == "leased":
                        totals["repair_candidates_deferred_leased"] += 1
                        by_date[day]["repair_candidates_deferred_leased"] += 1
                    elif limit is None or len(candidates) < limit:
                        flags = [f"missing_{field}" for field in assessment.missing_fields]
                        requested = list(
                            repair_request_fields(assessment.missing_fields)
                        )
                        candidates.append((str(row["account_id"]), flags, requested))

        queued = 0
        if apply:
            with connection.cursor() as cursor:
                queued = queue_candidates(cursor, candidates)
            connection.commit()
        else:
            connection.rollback()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()

    return {
        "applied": apply,
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
        "repair_accounts_queued": queued,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Audit DCAD field completeness and queue incomplete improved parcels"
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Commit the repair queue (default is a read-only audit)",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Queue at most this many repair candidates; audit counts remain complete",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=None,
        help="Optional JSON output path",
    )
    args = parser.parse_args()
    if args.limit is not None and args.limit <= 0:
        parser.error("--limit must be a positive integer")

    result = run(apply=args.apply, limit=args.limit)
    payload = json.dumps(result, indent=2, default=json_default)
    if args.output:
        args.output.write_text(payload + "\n", encoding="utf-8")
    print(payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
