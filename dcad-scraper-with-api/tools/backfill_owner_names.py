"""Recover complete owner names from retained DCAD ownership history.

The default mode is a rollback-only audit. Pass ``--apply`` to update both
``core.owner_summary`` and the matching sole 100% ``core.owner_parties`` row.
Ambiguous records are never modified and are reported for later re-scraping.
"""

from __future__ import annotations

import argparse
import json
import os

import psycopg2
from psycopg2.extras import execute_values

from scraper.dcad.owner_recovery import recover_complete_owner_name


CANDIDATES_SQL = """
WITH latest AS (
    SELECT DISTINCT ON (account_id)
           account_id, tax_year, owner_name, mailing_address
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
SELECT l.account_id,
       l.tax_year,
       l.owner_name,
       l.mailing_address,
       raw_snapshot.owner_line
FROM latest l
JOIN party_sets ps USING (account_id, tax_year)
LEFT JOIN LATERAL (
    SELECT raw #>> '{history,owner_history,0,owner_lines,0}' AS owner_line
    FROM core.dcad_json_raw r
    WHERE r.account_id = l.account_id
    ORDER BY r.tax_year DESC, r.fetched_at DESC
    LIMIT 1
) raw_snapshot ON true
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
            cursor.execute(CANDIDATES_SQL)
            rows = cursor.fetchall()

            recoveries: list[tuple[str, int, str, str]] = []
            no_history_line = 0
            ambiguous = 0
            for account_id, tax_year, owner_name, mailing_address, owner_line in rows:
                if not owner_line:
                    no_history_line += 1
                    continue
                recovered = recover_complete_owner_name(
                    owner_name, mailing_address, owner_line
                )
                if not recovered:
                    ambiguous += 1
                    continue
                recoveries.append((account_id, tax_year, owner_name, recovered))

            cursor.execute(
                """
                CREATE TEMP TABLE owner_name_recoveries (
                    account_id text NOT NULL,
                    tax_year integer NOT NULL,
                    expected_name text NOT NULL,
                    recovered_name text NOT NULL,
                    PRIMARY KEY (account_id, tax_year)
                ) ON COMMIT DROP
                """
            )
            if recoveries:
                execute_values(
                    cursor,
                    """
                    INSERT INTO owner_name_recoveries (
                        account_id, tax_year, expected_name, recovered_name
                    ) VALUES %s
                    """,
                    recoveries,
                    page_size=5000,
                )

            cursor.execute(
                """
                UPDATE core.owner_summary summary
                SET owner_name = recovery.recovered_name
                FROM owner_name_recoveries recovery
                WHERE summary.account_id = recovery.account_id
                  AND summary.tax_year = recovery.tax_year
                  AND summary.owner_name = recovery.expected_name
                """
            )
            summaries_updated = int(cursor.rowcount or 0)
            cursor.execute(
                """
                UPDATE core.owner_parties party
                SET owner_name = recovery.recovered_name
                FROM owner_name_recoveries recovery
                WHERE party.account_id = recovery.account_id
                  AND party.tax_year = recovery.tax_year
                  AND party.owner_name = recovery.expected_name
                  AND abs(party.ownership_pct - 100) < 0.01
                """
            )
            parties_updated = int(cursor.rowcount or 0)

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
        "candidates": len(rows),
        "recoverable": len(recoveries),
        "owner_summaries_updated": summaries_updated,
        "owner_parties_updated": parties_updated,
        "no_history_line": no_history_line,
        "ambiguous": ambiguous,
        "requires_rescrape": no_history_line + ambiguous,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Recover truncated owner names from DCAD history"
    )
    parser.add_argument(
        "--apply", action="store_true", help="Commit changes (default rolls back)"
    )
    args = parser.parse_args()
    print(json.dumps(run(apply=args.apply), indent=2, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
