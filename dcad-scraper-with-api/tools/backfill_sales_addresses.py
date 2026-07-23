"""Backfill matched sale addresses from the DCAD account export.

The MLS sales export contains parcel numbers but no situs address. This tool
uses those parcel/account matches to copy the DCAD account export's property
address into existing ``core.accounts`` and linked ``core.sales`` rows.

It never creates accounts and never overwrites a nonblank address. The default
mode is a rollback-only dry run; pass ``--apply`` to commit the changes.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

import psycopg2
from psycopg2.extras import execute_values


DEFAULT_SOURCE_FILENAME = "Garland two year sales 07.21.2026.csv"
REQUIRED_COLUMNS = {
    "ACCOUNT_NUM",
    "STREET_NUM",
    "STREET_HALF_NUM",
    "FULL_STREET_NAME",
    "BLDG_ID",
    "UNIT_ID",
    "PROPERTY_CITY",
    "PROPERTY_ZIPCODE",
}


@dataclass(frozen=True)
class AddressRecord:
    account_id: str
    address: str
    city: str | None
    state: str
    zip_code: str | None


def _clean(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def _qualified_component(value: str, label: str) -> str:
    cleaned = _clean(value)
    if not cleaned:
        return ""
    if cleaned.upper().startswith((label, "#")):
        return cleaned
    return f"{label} {cleaned}"


def build_situs_address(row: dict[str, str]) -> str | None:
    street_number = _clean(row.get("STREET_NUM"))
    half_number = _clean(row.get("STREET_HALF_NUM"))
    street_name = _clean(row.get("FULL_STREET_NAME"))
    if not street_name or not (street_number or half_number):
        return None

    parts = [part for part in (street_number, half_number, street_name) if part]
    building = _qualified_component(row.get("BLDG_ID", ""), "BLDG")
    unit = _qualified_component(row.get("UNIT_ID", ""), "UNIT")
    if building:
        parts.append(building)
    if unit:
        parts.append(unit)
    return _clean(" ".join(parts)) or None


def address_record(row: dict[str, str]) -> AddressRecord | None:
    account_id = _clean(row.get("ACCOUNT_NUM"))
    address = build_situs_address(row)
    if not account_id or not address:
        return None
    return AddressRecord(
        account_id=account_id,
        address=address,
        city=_clean(row.get("PROPERTY_CITY")) or None,
        state="TX",
        zip_code=_clean(row.get("PROPERTY_ZIPCODE")) or None,
    )


def load_target_addresses(
    csv_path: Path, target_account_ids: set[str]
) -> tuple[dict[str, AddressRecord], set[str], int]:
    records: dict[str, AddressRecord] = {}
    conflicts: set[str] = set()
    rows_read = 0

    with csv_path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        columns = set(reader.fieldnames or [])
        missing = sorted(REQUIRED_COLUMNS - columns)
        if missing:
            raise ValueError(f"DCAD account CSV is missing columns: {', '.join(missing)}")

        for row in reader:
            rows_read += 1
            account_id = _clean(row.get("ACCOUNT_NUM"))
            if account_id not in target_account_ids:
                continue
            record = address_record(row)
            if record is None:
                continue
            existing = records.get(account_id)
            if existing is not None and existing != record:
                conflicts.add(account_id)
                continue
            records[account_id] = record

    for account_id in conflicts:
        records.pop(account_id, None)
    return records, conflicts, rows_read


def _target_account_ids(cursor: Any, source_filename: str) -> set[str]:
    cursor.execute(
        """
        SELECT DISTINCT account_id
        FROM (
            SELECT primary_account_id AS account_id
            FROM core.sales_source_records
            WHERE source_filename = %s
              AND primary_account_id IS NOT NULL

            UNION

            SELECT sp.account_id
            FROM core.sale_parcels sp
            JOIN core.sales_source_records src
              ON src.id = sp.source_record_id
            WHERE src.source_filename = %s
              AND sp.account_id IS NOT NULL
        ) linked_accounts
        """,
        (source_filename, source_filename),
    )
    return {row[0] for row in cursor.fetchall()}


def _insert_staging(cursor: Any, records: Iterable[AddressRecord]) -> None:
    cursor.execute(
        """
        CREATE TEMP TABLE sales_address_backfill (
            account_id text PRIMARY KEY,
            address text NOT NULL,
            city text,
            state text NOT NULL,
            zip text
        ) ON COMMIT DROP
        """
    )
    values = [
        (record.account_id, record.address, record.city, record.state, record.zip_code)
        for record in records
    ]
    if values:
        execute_values(
            cursor,
            """
            INSERT INTO sales_address_backfill (account_id, address, city, state, zip)
            VALUES %s
            """,
            values,
            page_size=1000,
        )


def _count_candidates(cursor: Any) -> dict[str, int]:
    cursor.execute(
        """
        SELECT
            COUNT(*) FILTER (
                WHERE NULLIF(BTRIM(a.address), '') IS NULL
            )::int AS account_addresses_to_fill,
            COUNT(*) FILTER (
                WHERE NULLIF(BTRIM(a.address), '') IS NOT NULL
            )::int AS account_addresses_preserved
        FROM sales_address_backfill b
        JOIN core.accounts a ON a.account_id = b.account_id
        """
    )
    account_counts = cursor.fetchone()

    cursor.execute(
        """
        SELECT
            COUNT(*) FILTER (
                WHERE NULLIF(BTRIM(s.address), '') IS NULL
            )::int AS sale_addresses_to_fill,
            COUNT(*) FILTER (
                WHERE NULLIF(BTRIM(s.city), '') IS NULL
            )::int AS sale_cities_to_fill,
            COUNT(*) FILTER (
                WHERE NULLIF(BTRIM(s.zip), '') IS NULL
            )::int AS sale_zips_to_fill
        FROM core.sales s
        JOIN sales_address_backfill b ON b.account_id = s.account_id
        """
    )
    sale_counts = cursor.fetchone()
    return {
        "account_addresses_to_fill": account_counts[0],
        "account_addresses_preserved": account_counts[1],
        "sale_addresses_to_fill": sale_counts[0],
        "sale_cities_to_fill": sale_counts[1],
        "sale_zips_to_fill": sale_counts[2],
    }


def _apply_updates(cursor: Any) -> dict[str, int]:
    cursor.execute(
        """
        UPDATE core.accounts a
        SET address = b.address,
            updated_at = now()
        FROM sales_address_backfill b
        WHERE a.account_id = b.account_id
          AND NULLIF(BTRIM(a.address), '') IS NULL
        """
    )
    accounts_updated = cursor.rowcount

    cursor.execute(
        """
        UPDATE core.sales s
        SET address = COALESCE(NULLIF(BTRIM(s.address), ''), b.address),
            city = COALESCE(NULLIF(BTRIM(s.city), ''), b.city),
            state = COALESCE(NULLIF(BTRIM(s.state), ''), b.state),
            zip = COALESCE(NULLIF(BTRIM(s.zip), ''), b.zip)
        FROM sales_address_backfill b
        WHERE s.account_id = b.account_id
          AND (
              NULLIF(BTRIM(s.address), '') IS NULL
              OR NULLIF(BTRIM(s.city), '') IS NULL
              OR NULLIF(BTRIM(s.state), '') IS NULL
              OR NULLIF(BTRIM(s.zip), '') IS NULL
          )
        """
    )
    sales_updated = cursor.rowcount
    return {"accounts_updated": accounts_updated, "sales_updated": sales_updated}


def backfill_sales_addresses(
    csv_path: Path, source_filename: str, apply: bool = False
) -> dict[str, Any]:
    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        raise RuntimeError("DATABASE_URL is not set")
    if not csv_path.is_file():
        raise FileNotFoundError(csv_path)

    connection = psycopg2.connect(database_url)
    try:
        with connection.cursor() as cursor:
            cursor.execute("SET LOCAL lock_timeout = '5s'")
            cursor.execute("SET LOCAL statement_timeout = '60s'")
            target_account_ids = _target_account_ids(cursor, source_filename)
            records, conflicts, rows_read = load_target_addresses(
                csv_path, target_account_ids
            )
            _insert_staging(cursor, records.values())
            candidate_counts = _count_candidates(cursor)
            update_counts = _apply_updates(cursor)

        result = {
            "dry_run": not apply,
            "source_filename": source_filename,
            "dcad_rows_read": rows_read,
            "target_accounts": len(target_account_ids),
            "addresses_found": len(records),
            "targets_without_csv_address": len(target_account_ids - records.keys()),
            "conflicting_csv_addresses": len(conflicts),
            **candidate_counts,
            **update_counts,
        }
        if apply:
            connection.commit()
        else:
            connection.rollback()
        return result
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("csv_path", type=Path, help="Path to DCAD Accounts.csv")
    parser.add_argument(
        "--source-filename",
        default=DEFAULT_SOURCE_FILENAME,
        help="Sales source_filename whose linked accounts should be repaired",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Commit updates; without this flag all database changes are rolled back",
    )
    args = parser.parse_args()
    result = backfill_sales_addresses(
        args.csv_path, source_filename=args.source_filename, apply=args.apply
    )
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
