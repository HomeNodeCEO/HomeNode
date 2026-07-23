"""Backfill indexed account street/city search fields from the DCAD CSV.

The operation updates existing ``core.accounts`` rows only. It does not create
accounts or alter their situs address. The migration is applied automatically,
and the default mode rolls the transaction back after reporting its counts.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import tempfile
from pathlib import Path

ACCOUNT_PATTERN = re.compile(r"^[A-Z0-9]{17}$")
SPACE_PATTERN = re.compile(r"\s+")
COUNTY_SUFFIX_PATTERN = re.compile(r"\s*\([^)]*\)\s*$")


def normalize_text(value: str | None) -> str | None:
    normalized = SPACE_PATTERN.sub(" ", str(value or "").strip()).upper()
    return normalized or None


def normalize_city(value: str | None) -> str | None:
    return normalize_text(COUNTY_SUFFIX_PATTERN.sub("", str(value or "")))


def normalize_postal_code(value: str | None) -> str | None:
    digits = re.sub(r"\D", "", str(value or ""))
    return digits[:5] if len(digits) >= 5 else None


def iter_search_rows(csv_path: Path):
    with csv_path.open("r", encoding="utf-8-sig", newline="") as source:
        reader = csv.DictReader(source)
        required = {"ACCOUNT_NUM", "FULL_STREET_NAME", "PROPERTY_CITY", "PROPERTY_ZIPCODE"}
        missing = required.difference(reader.fieldnames or [])
        if missing:
            raise ValueError(f"CSV is missing required columns: {', '.join(sorted(missing))}")

        for row in reader:
            account_id = normalize_text(row.get("ACCOUNT_NUM"))
            if not account_id or not ACCOUNT_PATTERN.fullmatch(account_id):
                continue
            street_name = normalize_text(row.get("FULL_STREET_NAME"))
            if not street_name:
                continue
            yield (
                account_id,
                street_name,
                normalize_city(row.get("PROPERTY_CITY")),
                normalize_postal_code(row.get("PROPERTY_ZIPCODE")),
            )


def migration_sql() -> str:
    return (
        Path(__file__).resolve().parents[1]
        / "migrations"
        / "007_account_search_fields.sql"
    ).read_text(encoding="utf-8")


def backfill(csv_path: Path, *, apply: bool = False) -> dict[str, object]:
    import psycopg2

    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        raise RuntimeError("DATABASE_URL is not set")

    staged_rows = 0
    with tempfile.TemporaryFile(mode="w+", encoding="utf-8", newline="") as copy_file:
        writer = csv.writer(copy_file, lineterminator="\n")
        for search_row in iter_search_rows(csv_path):
            writer.writerow(search_row)
            staged_rows += 1
        copy_file.seek(0)

        connection = psycopg2.connect(database_url)
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    ALTER TABLE core.accounts
                        ADD COLUMN IF NOT EXISTS street_name text,
                        ADD COLUMN IF NOT EXISTS city text,
                        ADD COLUMN IF NOT EXISTS postal_code text
                    """
                )
                cursor.execute(
                    """
                    CREATE TEMP TABLE tmp_account_search_fields (
                        account_id text PRIMARY KEY,
                        street_name text NOT NULL,
                        city text,
                        postal_code text
                    ) ON COMMIT DROP
                    """
                )
                cursor.copy_expert(
                    """
                    COPY tmp_account_search_fields (
                        account_id, street_name, city, postal_code
                    ) FROM STDIN WITH (FORMAT csv)
                    """,
                    copy_file,
                )
                cursor.execute(
                    """
                    SELECT count(*)
                    FROM tmp_account_search_fields t
                    JOIN core.accounts a USING (account_id)
                    """
                )
                matched_accounts = cursor.fetchone()[0]
                cursor.execute(
                    """
                    UPDATE core.accounts a
                    SET street_name = t.street_name,
                        city = t.city,
                        postal_code = t.postal_code,
                        updated_at = now()
                    FROM tmp_account_search_fields t
                    WHERE a.account_id = t.account_id
                      AND (a.street_name, a.city, a.postal_code)
                          IS DISTINCT FROM (t.street_name, t.city, t.postal_code)
                    """
                )
                updated_accounts = cursor.rowcount

                # Collin records already carry a complete formatted address
                # ("street, city, TX zip"). Derive the same indexed fields for
                # accounts that were not present in the Dallas export.
                cursor.execute(
                    """
                    UPDATE core.accounts a
                    SET street_name = upper(btrim(regexp_replace(
                            split_part(a.address, ',', 1),
                            '^[[:space:]]*[0-9]+[A-Za-z]?(?:-[0-9]+[A-Za-z]?)?'
                            '(?:[[:space:]]+1/2)?[[:space:]]+',
                            '',
                            'i'
                        ))),
                        city = COALESCE(
                            a.city,
                            upper(NULLIF(btrim(split_part(a.address, ',', 2)), ''))
                        ),
                        postal_code = COALESCE(
                            a.postal_code,
                            substring(a.address from '([0-9]{5})[[:space:]]*$')
                        ),
                        updated_at = now()
                    WHERE NULLIF(btrim(a.street_name), '') IS NULL
                      AND NULLIF(btrim(a.address), '') IS NOT NULL
                      AND NULLIF(btrim(regexp_replace(
                            split_part(a.address, ',', 1),
                            '^[[:space:]]*[0-9]+[A-Za-z]?(?:-[0-9]+[A-Za-z]?)?'
                            '(?:[[:space:]]+1/2)?[[:space:]]+',
                            '',
                            'i'
                          )), '') IS NOT NULL
                    """
                )
                derived_accounts_updated = cursor.rowcount

                if apply:
                    # Build the search indexes after the bulk update so the
                    # import does not maintain them row by row.
                    cursor.execute(migration_sql())

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
        "csv_rows_staged": staged_rows,
        "matched_existing_accounts": matched_accounts,
        "accounts_updated": updated_accounts,
        "derived_accounts_updated": derived_accounts_updated,
        "applied": apply,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Backfill core.accounts street/city search fields from a DCAD account CSV"
    )
    parser.add_argument("csv_path", type=Path)
    parser.add_argument("--apply", action="store_true", help="Commit changes (default is rollback-only)")
    args = parser.parse_args()
    result = backfill(args.csv_path.resolve(), apply=args.apply)
    print(json.dumps(result, indent=2, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
