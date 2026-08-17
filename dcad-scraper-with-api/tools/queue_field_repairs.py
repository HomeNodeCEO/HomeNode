"""Audit and queue completed Dallas residential accounts with field gaps.

The default mode is rollback-only. Pass ``--apply`` after migration 017 has
been deployed. This lane is intentionally separate from the ordered missing-
first campaign, so legacy repairs do not reset campaign completion markers.
"""

from __future__ import annotations

import argparse
import json
import os

import psycopg2


VALID_FIELDS = ("owner", "land", "gla")


CANDIDATES_SQL = """
WITH owner_present AS (
    SELECT account_id
    FROM core.owner_summary
    GROUP BY account_id
    HAVING bool_or(NULLIF(btrim(owner_name), '') IS NOT NULL)
), land_present AS (
    SELECT DISTINCT account_id
    FROM core.land_detail
), gla_present AS (
    SELECT account_id
    FROM core.primary_improvements
    GROUP BY account_id
    HAVING bool_or(living_area_sqft IS NOT NULL AND living_area_sqft > 0)
), main_improvement_present AS (
    SELECT account_id
    FROM core.primary_improvements
    WHERE NULLIF(btrim(construction_type), '') IS NOT NULL
       OR percent_complete IS NOT NULL
       OR year_built IS NOT NULL
       OR effective_year_built IS NOT NULL
       OR actual_age IS NOT NULL
       OR depreciation IS NOT NULL
       OR NULLIF(btrim(desirability), '') IS NOT NULL
       OR NULLIF(btrim(stories), '') IS NOT NULL
       OR living_area_sqft IS NOT NULL
       OR total_living_area IS NOT NULL
       OR bedroom_count IS NOT NULL
       OR bath_count IS NOT NULL
       OR number_units IS NOT NULL
       OR NULLIF(btrim(building_class), '') IS NOT NULL
       OR total_area_sqft IS NOT NULL
), vacant_land_by_state_code AS (
    SELECT account_id
    FROM core.land_detail
    GROUP BY account_id
    HAVING bool_or(position('VACANT' in upper(state_code)) > 0)
       AND NOT bool_or(
           NULLIF(btrim(state_code), '') IS NOT NULL
           AND position('VACANT' in upper(state_code)) = 0
       )
), vacant_land_by_values AS (
    SELECT value.account_id
    FROM core.value_summary_current value
    LEFT JOIN main_improvement_present improvement USING (account_id)
    WHERE improvement.account_id IS NULL
      AND value.market_value IS NOT NULL
      AND value.market_value > 0
      AND value.land_value = value.market_value
), vacant_land AS (
    SELECT account_id FROM vacant_land_by_state_code
    UNION
    SELECT account_id FROM vacant_land_by_values
)
SELECT target.account_id,
       array_remove(ARRAY[
           CASE WHEN owner.account_id IS NULL AND 'owner' = ANY(%(fields)s)
                THEN 'owner' END,
           CASE WHEN land.account_id IS NULL AND 'land' = ANY(%(fields)s)
                THEN 'land' END,
           CASE WHEN gla.account_id IS NULL
                     AND vacant.account_id IS NULL
                     AND 'gla' = ANY(%(fields)s)
                THEN 'gla' END
       ], NULL)::text[] AS missing_fields
FROM app.dcad_residential_targets target
JOIN app.dcad_scrape_state state USING (account_id)
LEFT JOIN owner_present owner USING (account_id)
LEFT JOIN land_present land USING (account_id)
LEFT JOIN gla_present gla USING (account_id)
LEFT JOIN vacant_land vacant USING (account_id)
WHERE state.status = 'succeeded'
  AND (
      (owner.account_id IS NULL AND 'owner' = ANY(%(fields)s))
      OR (land.account_id IS NULL AND 'land' = ANY(%(fields)s))
      OR (
          gla.account_id IS NULL
          AND vacant.account_id IS NULL
          AND 'gla' = ANY(%(fields)s)
      )
  )
"""


def normalize_fields(values: list[str]) -> list[str]:
    selected: list[str] = []
    for value in values:
        field = value.strip().lower()
        if field not in VALID_FIELDS:
            raise ValueError(
                f"Unsupported field {value!r}; choose from {', '.join(VALID_FIELDS)}"
            )
        if field not in selected:
            selected.append(field)
    return selected


def run(*, apply: bool = False, fields: list[str] | None = None, limit: int | None = None) -> dict[str, object]:
    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        raise RuntimeError("DATABASE_URL is not set")

    selected = normalize_fields(fields or list(VALID_FIELDS))
    if not selected:
        raise ValueError("At least one repair field is required")
    if limit is not None and limit < 1:
        raise ValueError("--limit must be positive")

    limit_sql = " LIMIT %(limit)s" if limit is not None else ""
    params = {"fields": selected, "limit": limit}
    connection = psycopg2.connect(database_url)
    try:
        with connection.cursor() as cursor:
            cursor.execute("SET LOCAL statement_timeout = '20min'")
            cursor.execute("SELECT to_regclass('app.dcad_field_repair_queue')")
            if cursor.fetchone()[0] is None:
                raise RuntimeError(
                    "Field repair queue is missing; deploy migration 017 first"
                )

            cursor.execute(
                f"""
                WITH candidates AS ({CANDIDATES_SQL})
                SELECT count(*) AS candidates,
                       count(*) FILTER (WHERE 'owner' = ANY(missing_fields)) AS missing_owner,
                       count(*) FILTER (WHERE 'land' = ANY(missing_fields)) AS missing_land,
                       count(*) FILTER (WHERE 'gla' = ANY(missing_fields)) AS missing_gla
                FROM candidates
                """,
                params,
            )
            candidates, missing_owner, missing_land, missing_gla = cursor.fetchone()

            cursor.execute(
                f"""
                INSERT INTO app.dcad_field_repair_queue AS queue (
                    account_id, status, requested_fields, remaining_fields,
                    attempts, next_attempt_at, reason, last_error,
                    lease_expires_at, worker_id, updated_at
                )
                SELECT account_id, 'pending', missing_fields, missing_fields,
                       0, now(),
                       'Completed Dallas residential account is missing required fields',
                       NULL, NULL, NULL, now()
                FROM ({CANDIDATES_SQL}) candidates
                ORDER BY account_id
                {limit_sql}
                ON CONFLICT (account_id) DO UPDATE
                SET status = 'pending',
                    requested_fields = EXCLUDED.requested_fields,
                    remaining_fields = EXCLUDED.remaining_fields,
                    attempts = 0,
                    next_attempt_at = now(),
                    reason = EXCLUDED.reason,
                    last_error = NULL,
                    lease_expires_at = NULL,
                    worker_id = NULL,
                    updated_at = now()
                WHERE queue.status <> 'leased'
                """,
                params,
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
        "fields": selected,
        "candidates": int(candidates),
        "missing_owner": int(missing_owner),
        "missing_land": int(missing_land),
        "missing_gla": int(missing_gla),
        "queued": queued,
        "queue_limit": limit,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Queue completed Dallas accounts missing owner, land, or GLA"
    )
    parser.add_argument(
        "--apply", action="store_true", help="Commit queue changes (default rolls back)"
    )
    parser.add_argument(
        "--fields",
        nargs="+",
        default=list(VALID_FIELDS),
        help="Fields to audit: owner land gla",
    )
    parser.add_argument(
        "--limit", type=int, help="Queue only the first N accounts (audit counts remain complete)"
    )
    args = parser.parse_args()
    print(
        json.dumps(
            run(apply=args.apply, fields=args.fields, limit=args.limit),
            indent=2,
            default=str,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

