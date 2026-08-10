"""Queue unresolved truncated owner names for verified DCAD re-scraping.

The default mode is a rollback-only audit. Pass ``--apply`` after the worker
containing the corrected owner parser has been deployed. This lane is separate
from the Dallas residential target campaign so completed-account repairs do
not reset or contaminate campaign progress.
"""

from __future__ import annotations

import argparse
import json
import os

import psycopg2


CANDIDATES_SQL = """
WITH latest AS (
    SELECT DISTINCT ON (account_id)
           account_id, tax_year, owner_name
    FROM core.owner_summary
    ORDER BY account_id, tax_year DESC
), party_sets AS (
    SELECT p.account_id, p.tax_year,
           count(*) AS party_count,
           sum(p.ownership_pct) AS total_pct
    FROM core.owner_parties p
    JOIN latest l USING (account_id, tax_year)
    GROUP BY p.account_id, p.tax_year
)
SELECT l.account_id
FROM latest l
JOIN party_sets ps USING (account_id, tax_year)
WHERE l.owner_name ~ '&\\s*$'
  AND ps.party_count = 1
  AND abs(ps.total_pct - 100) < 0.01
  AND EXISTS (
      SELECT 1
      FROM app.dcad_residential_targets target
      WHERE target.account_id = l.account_id
  )
"""


def run(*, apply: bool = False) -> dict[str, object]:
    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        raise RuntimeError("DATABASE_URL is not set")

    connection = psycopg2.connect(database_url)
    try:
        with connection.cursor() as cursor:
            cursor.execute("SET LOCAL statement_timeout = '15min'")
            cursor.execute(
                "SELECT to_regclass('app.dcad_owner_recovery_queue')"
            )
            if cursor.fetchone()[0] is None:
                raise RuntimeError(
                    "Owner recovery queue is missing; deploy migration 016 first"
                )

            cursor.execute(
                f"""
                WITH candidates AS ({CANDIDATES_SQL})
                SELECT count(*) AS candidates,
                       count(*) FILTER (
                           WHERE EXISTS (
                               SELECT 1
                               FROM app.dcad_residential_targets target
                               WHERE target.account_id = candidates.account_id
                           )
                       ) AS residential_campaign,
                       count(*) FILTER (
                           WHERE NOT EXISTS (
                               SELECT 1
                               FROM app.dcad_residential_targets target
                               WHERE target.account_id = candidates.account_id
                           )
                       ) AS outside_campaign
                FROM candidates
                """
            )
            candidates, residential, outside = cursor.fetchone()

            cursor.execute(
                f"""
                INSERT INTO app.dcad_owner_recovery_queue AS queue (
                    account_id, status, attempts, next_attempt_at, reason,
                    last_error, lease_expires_at, worker_id, updated_at
                )
                SELECT account_id, 'pending', 0, now(),
                       'Current sole 100% owner name is truncated after ampersand',
                       NULL, NULL, NULL, now()
                FROM ({CANDIDATES_SQL}) candidates
                ON CONFLICT (account_id) DO UPDATE
                SET status = 'pending',
                    attempts = 0,
                    next_attempt_at = now(),
                    reason = EXCLUDED.reason,
                    last_error = NULL,
                    lease_expires_at = NULL,
                    worker_id = NULL,
                    updated_at = now()
                WHERE queue.status <> 'leased'
                """
            )
            queued = int(cursor.rowcount or 0)

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
        "candidates": int(candidates),
        "queued": queued,
        "residential_campaign_accounts": int(residential),
        "outside_campaign_accounts": int(outside),
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Queue unresolved owner names for corrected-parser re-scraping"
    )
    parser.add_argument(
        "--apply", action="store_true", help="Commit queue changes (default rolls back)"
    )
    args = parser.parse_args()
    print(json.dumps(run(apply=args.apply), indent=2, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
"""Queue unresolved truncated owner names for verified DCAD re-scraping.

The default mode is a rollback-only audit. Pass ``--apply`` after the worker
containing the corrected owner parser has been deployed. This lane is separate
from the Dallas residential target campaign so completed-account repairs do
not reset or contaminate campaign progress.
"""

from __future__ import annotations

import argparse
import json
import os

import psycopg2


CANDIDATES_SQL = """
WITH latest AS (
    SELECT DISTINCT ON (account_id)
           account_id, tax_year, owner_name
    FROM core.owner_summary
    ORDER BY account_id, tax_year DESC
), party_sets AS (
    SELECT p.account_id, p.tax_year,
           count(*) AS party_count,
           sum(p.ownership_pct) AS total_pct
    FROM core.owner_parties p
    JOIN latest l USING (account_id, tax_year)
    GROUP BY p.account_id, p.tax_year
)
SELECT l.account_id
FROM latest l
JOIN party_sets ps USING (account_id, tax_year)
WHERE l.owner_name ~ '&\\s*$'
  AND ps.party_count = 1
  AND abs(ps.total_pct - 100) < 0.01
"""


def run(*, apply: bool = False) -> dict[str, object]:
    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        raise RuntimeError("DATABASE_URL is not set")

    connection = psycopg2.connect(database_url)
    try:
        with connection.cursor() as cursor:
            cursor.execute("SET LOCAL statement_timeout = '15min'")
            cursor.execute(
                "SELECT to_regclass('app.dcad_owner_recovery_queue')"
            )
            if cursor.fetchone()[0] is None:
                raise RuntimeError(
                    "Owner recovery queue is missing; deploy migration 016 first"
                )

            cursor.execute(
                f"""
                WITH candidates AS ({CANDIDATES_SQL})
                SELECT count(*) AS candidates,
                       count(*) FILTER (
                           WHERE EXISTS (
                               SELECT 1
                               FROM app.dcad_residential_targets target
                               WHERE target.account_id = candidates.account_id
                           )
                       ) AS residential_campaign,
                       count(*) FILTER (
                           WHERE NOT EXISTS (
                               SELECT 1
                               FROM app.dcad_residential_targets target
                               WHERE target.account_id = candidates.account_id
                           )
                       ) AS outside_campaign
                FROM candidates
                """
            )
            candidates, residential, outside = cursor.fetchone()

            cursor.execute(
                f"""
                INSERT INTO app.dcad_owner_recovery_queue AS queue (
                    account_id, status, attempts, next_attempt_at, reason,
                    last_error, lease_expires_at, worker_id, updated_at
                )
                SELECT account_id, 'pending', 0, now(),
                       'Current sole 100% owner name is truncated after ampersand',
                       NULL, NULL, NULL, now()
                FROM ({CANDIDATES_SQL}) candidates
                ON CONFLICT (account_id) DO UPDATE
                SET status = 'pending',
                    attempts = 0,
                    next_attempt_at = now(),
                    reason = EXCLUDED.reason,
                    last_error = NULL,
                    lease_expires_at = NULL,
                    worker_id = NULL,
                    updated_at = now()
                WHERE queue.status <> 'leased'
                """
            )
            queued = int(cursor.rowcount or 0)

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
        "candidates": int(candidates),
        "queued": queued,
        "residential_campaign_accounts": int(residential),
        "outside_campaign_accounts": int(outside),
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Queue unresolved owner names for corrected-parser re-scraping"
    )
    parser.add_argument(
        "--apply", action="store_true", help="Commit queue changes (default rolls back)"
    )
    args = parser.parse_args()
    print(json.dumps(run(apply=args.apply), indent=2, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
