"""Requeue false-success DCAD rows and seed the legacy recovery queue.

The default mode performs the complete operation inside a transaction and
rolls it back after reporting counts. Pass ``--apply`` to commit. Keeping this
one-time historical scan out of the worker's startup migration prevents normal
Render restarts from paying the audit cost.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

import psycopg2


REQUEUE_SQL = """
WITH suspicious AS (
    SELECT s.account_id
    FROM app.dcad_scrape_state s
    JOIN app.dcad_residential_targets t ON t.account_id = s.account_id
    JOIN LATERAL (
        SELECT r.raw
        FROM core.dcad_json_raw r
        WHERE r.account_id = s.account_id
        ORDER BY r.tax_year DESC, r.fetched_at DESC
        LIMIT 1
    ) latest ON true
    WHERE s.status = 'succeeded'
      AND lower(COALESCE(
            NULLIF(btrim(latest.raw #>> '{detail,property_location,address}'), ''),
            NULLIF(btrim(latest.raw #>> '{detail,property_location,subject_address}'), ''),
            'n/a'
          )) IN ('n/a', 'na', 'none', 'null', 'unassigned')
      AND lower(COALESCE(
            NULLIF(btrim(latest.raw #>> '{detail,value_summary,market_value}'), ''),
            'n/a'
          )) IN ('n/a', 'na', 'none', 'null', 'unassigned')
), reopened_state AS (
    UPDATE app.dcad_scrape_state s
    SET status = 'pending',
        attempts = 0,
        next_attempt_at = now(),
        lease_expires_at = NULL,
        worker_id = NULL,
        last_error = 'Requeued: prior scrape snapshot was missing both address and market value',
        quality_status = 'incomplete_requeued',
        quality_flags = ARRAY['missing_address', 'missing_market_value', 'suspicious_success'],
        canonical_account_id = NULL,
        updated_at = now()
    FROM suspicious q
    WHERE s.account_id = q.account_id
    RETURNING s.account_id
), reopened_targets AS (
    UPDATE app.dcad_residential_targets t
    SET initial_completed_at = CASE
            WHEN t.initial_missing THEN NULL
            ELSE t.initial_completed_at
        END,
        last_completed_cycle = LEAST(
            t.last_completed_cycle,
            GREATEST(COALESCE(c.cycle_number, 0) - 1, 0)
        )
    FROM reopened_state q
    LEFT JOIN app.dcad_residential_campaign c
      ON c.campaign_key = 'dallas_residential'
    WHERE t.account_id = q.account_id
    RETURNING t.account_id
), flagged_accounts AS (
    UPDATE core.accounts a
    SET data_quality_status = 'refresh_queued',
        data_quality_flags = ARRAY[
            'missing_address', 'missing_market_value', 'suspicious_success'
        ]
    FROM reopened_targets q
    WHERE a.account_id = q.account_id
    RETURNING a.account_id
)
SELECT count(*) FROM flagged_accounts
"""


SEED_LEGACY_SQL = """
WITH inserted AS (
    INSERT INTO app.dcad_account_reconciliations (
        source_account_id, source_address, source_city, source_postal_code,
        status, evidence
    )
    SELECT a.account_id,
           a.address,
           a.city,
           a.postal_code,
           CASE WHEN NULLIF(btrim(a.address), '') IS NULL
                THEN 'needs_review'
                ELSE 'pending_search'
           END,
           jsonb_build_object(
               'reason', 'legacy_dallas_account_without_complete_dcad_data',
               'identified_at', now()
           )
    FROM core.accounts a
    LEFT JOIN app.dcad_residential_targets t ON t.account_id = a.account_id
    WHERE t.account_id IS NULL
      AND upper(COALESCE(a.county, '')) LIKE '%DALLAS%'
      AND a.canonical_account_id IS NULL
      AND NOT EXISTS (
          SELECT 1
          FROM core.value_summary_current v
          WHERE v.account_id = a.account_id
            AND v.market_value IS NOT NULL
      )
      AND NOT EXISTS (
          SELECT 1
          FROM core.market_values v
          WHERE v.account_id = a.account_id
            AND v.total_value IS NOT NULL
      )
      AND NOT EXISTS (
          SELECT 1
          FROM core.dcad_json_raw r
          WHERE r.account_id = a.account_id
            AND (
              lower(COALESCE(
                  NULLIF(btrim(r.raw #>> '{detail,property_location,address}'), ''),
                  'n/a'
              )) NOT IN ('n/a', 'na', 'none', 'null', 'unassigned')
              OR lower(COALESCE(
                  NULLIF(btrim(r.raw #>> '{detail,value_summary,market_value}'), ''),
                  'n/a'
              )) NOT IN ('n/a', 'na', 'none', 'null', 'unassigned')
            )
      )
    ON CONFLICT (source_account_id) DO NOTHING
    RETURNING source_account_id
)
SELECT count(*) FROM inserted
"""


FLAG_LEGACY_SQL = """
UPDATE core.accounts a
SET data_quality_status = CASE
        WHEN r.status IN ('auto_matched', 'manual_matched') THEN 'legacy_resolved'
        ELSE 'legacy_review'
    END,
    data_quality_flags = CASE
        WHEN r.status IN ('auto_matched', 'manual_matched')
            THEN ARRAY['legacy_account', 'canonical_account_available']
        ELSE ARRAY['legacy_account', 'review_required']
    END,
    canonical_account_id = COALESCE(r.canonical_account_id, a.canonical_account_id)
FROM app.dcad_account_reconciliations r
WHERE a.account_id = r.source_account_id
  AND a.data_quality_status IS DISTINCT FROM 'verified'
"""


def migration_sql() -> str:
    return (
        Path(__file__).resolve().parents[1]
        / "migrations"
        / "011_dcad_data_quality_recovery.sql"
    ).read_text(encoding="utf-8")


def run(*, apply: bool = False) -> dict[str, object]:
    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        raise RuntimeError("DATABASE_URL is not set")

    connection = psycopg2.connect(database_url)
    try:
        with connection.cursor() as cursor:
            cursor.execute("SET LOCAL statement_timeout = '10min'")
            cursor.execute(migration_sql())
            cursor.execute(REQUEUE_SQL)
            requeued = int(cursor.fetchone()[0])
            cursor.execute(SEED_LEGACY_SQL)
            legacy_inserted = int(cursor.fetchone()[0])
            cursor.execute(FLAG_LEGACY_SQL)
            legacy_flagged = int(cursor.rowcount or 0)
            cursor.execute(
                """
                SELECT status, count(*)
                FROM app.dcad_account_reconciliations
                GROUP BY status
                ORDER BY status
                """
            )
            reconciliation_statuses = dict(cursor.fetchall())

        if apply:
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
        "suspicious_accounts_requeued": requeued,
        "legacy_reconciliations_inserted": legacy_inserted,
        "legacy_accounts_flagged": legacy_flagged,
        "reconciliation_statuses": reconciliation_statuses,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Requeue incomplete DCAD successes and seed legacy recovery"
    )
    parser.add_argument(
        "--apply", action="store_true", help="Commit changes (default is rollback-only)"
    )
    args = parser.parse_args()
    print(json.dumps(run(apply=args.apply), indent=2, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
