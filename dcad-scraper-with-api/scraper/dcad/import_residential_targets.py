from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import os
import re
from pathlib import Path

import psycopg2
from psycopg2.extras import Json


CAMPAIGN_KEY = "dallas_residential"
ACCOUNT_PATTERN = re.compile(r"^[A-Z0-9]{17}$")


def _source_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _load_source(path: Path) -> tuple[list[tuple[int, str]], int, list[str]]:
    rows: list[tuple[int, str]] = []
    seen: set[str] = set()
    invalid: list[str] = []
    total_rows = 0

    with path.open("r", encoding="utf-8-sig", newline="") as source:
        reader = csv.reader(source)
        try:
            header = next(reader)
        except StopIteration as error:
            raise ValueError("CSV is empty") from error
        if not header or header[0].strip().upper() != "ACCOUNT_NUM":
            raise ValueError("CSV must have ACCOUNT_NUM as its first column")

        for source_position, row in enumerate(reader, start=1):
            total_rows += 1
            account_id = (row[0] if row else "").strip().upper()
            if not ACCOUNT_PATTERN.fullmatch(account_id):
                invalid.append(account_id)
                continue
            if account_id in seen:
                raise ValueError(f"Duplicate account ID in CSV: {account_id}")
            seen.add(account_id)
            rows.append((source_position, account_id))

    if not rows:
        raise ValueError("CSV contains no valid account IDs")
    return rows, total_rows, invalid


def _migration_sql() -> str:
    root = Path(__file__).resolve().parents[2]
    return (root / "migrations" / "003_dcad_residential_campaign.sql").read_text(
        encoding="utf-8"
    )


def import_targets(path: Path) -> dict[str, object]:
    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        raise RuntimeError("DATABASE_URL is not set")

    source_sha256 = _source_sha256(path)
    rows, total_source_rows, invalid_rows = _load_source(path)

    copy_buffer = io.StringIO()
    writer = csv.writer(copy_buffer, lineterminator="\n")
    writer.writerows(rows)
    copy_buffer.seek(0)

    connection = psycopg2.connect(database_url)
    try:
        with connection.cursor() as cursor:
            cursor.execute(_migration_sql())
            cursor.execute(
                """
                CREATE TEMP TABLE tmp_dcad_residential_targets (
                    source_position integer PRIMARY KEY,
                    account_id text UNIQUE NOT NULL
                ) ON COMMIT DROP
                """
            )
            cursor.copy_expert(
                """
                COPY tmp_dcad_residential_targets (source_position, account_id)
                FROM STDIN WITH (FORMAT csv)
                """,
                copy_buffer,
            )

            cursor.execute(
                """
                SELECT source_sha256
                FROM app.dcad_residential_campaign
                WHERE campaign_key = %s
                """,
                (CAMPAIGN_KEY,),
            )
            existing = cursor.fetchone()
            if existing and existing[0] == source_sha256:
                cursor.execute(
                    """
                    SELECT count(*), count(*) FILTER (WHERE initial_missing)
                    FROM app.dcad_residential_targets
                    """
                )
                target_count, initial_missing_count = cursor.fetchone()
                connection.commit()
                return {
                    "campaign_key": CAMPAIGN_KEY,
                    "source_sha256": source_sha256,
                    "already_loaded": True,
                    "valid_targets": target_count,
                    "initial_missing": initial_missing_count,
                    "invalid_rows": invalid_rows,
                }

            cursor.execute(
                """
                INSERT INTO core.accounts (account_id, county)
                SELECT account_id, 'DALLAS COUNTY'
                FROM tmp_dcad_residential_targets
                ON CONFLICT (account_id) DO NOTHING
                """
            )
            accounts_inserted = cursor.rowcount

            cursor.execute("TRUNCATE TABLE app.dcad_residential_targets")
            cursor.execute(
                """
                INSERT INTO app.dcad_residential_targets (
                    account_id, source_position, source_filename, source_sha256,
                    initial_missing, initial_completed_at,
                    last_completed_cycle, imported_at
                )
                SELECT t.account_id,
                       t.source_position,
                       %s,
                       %s,
                       NOT EXISTS (
                           SELECT 1
                           FROM core.dcad_json_raw r
                           WHERE r.account_id = t.account_id
                       ),
                       NULL,
                       0,
                       now()
                FROM tmp_dcad_residential_targets t
                ORDER BY t.source_position
                """,
                (path.name, source_sha256),
            )

            cursor.execute(
                """
                SELECT count(*) FILTER (WHERE initial_missing)
                FROM app.dcad_residential_targets
                """
            )
            initial_missing_count = cursor.fetchone()[0]

            cursor.execute(
                "DELETE FROM app.dcad_campaign_events WHERE campaign_key = %s",
                (CAMPAIGN_KEY,),
            )
            cursor.execute(
                """
                INSERT INTO app.dcad_residential_campaign (
                    campaign_key, source_filename, source_sha256,
                    total_source_rows, total_valid_targets, invalid_source_rows,
                    initial_missing_count, phase, cycle_number,
                    loaded_at, phase_started_at, initial_completed_at,
                    current_cycle_started_at, last_cycle_completed_at, updated_at
                ) VALUES (
                    %s, %s, %s, %s, %s, %s, %s,
                    'initial_missing', 0,
                    now(), now(), NULL, NULL, NULL, now()
                )
                ON CONFLICT (campaign_key) DO UPDATE SET
                    source_filename = EXCLUDED.source_filename,
                    source_sha256 = EXCLUDED.source_sha256,
                    total_source_rows = EXCLUDED.total_source_rows,
                    total_valid_targets = EXCLUDED.total_valid_targets,
                    invalid_source_rows = EXCLUDED.invalid_source_rows,
                    initial_missing_count = EXCLUDED.initial_missing_count,
                    phase = 'initial_missing',
                    cycle_number = 0,
                    loaded_at = now(),
                    phase_started_at = now(),
                    initial_completed_at = NULL,
                    current_cycle_started_at = NULL,
                    last_cycle_completed_at = NULL,
                    updated_at = now()
                """,
                (
                    CAMPAIGN_KEY,
                    path.name,
                    source_sha256,
                    total_source_rows,
                    len(rows),
                    len(invalid_rows),
                    initial_missing_count,
                ),
            )
            payload = {
                "source_filename": path.name,
                "source_sha256": source_sha256,
                "total_source_rows": total_source_rows,
                "valid_targets": len(rows),
                "invalid_rows": len(invalid_rows),
                "initial_missing": initial_missing_count,
                "accounts_inserted": accounts_inserted,
            }
            cursor.execute(
                """
                INSERT INTO app.dcad_campaign_events (
                    campaign_key, event_type, cycle_number, event_payload
                ) VALUES (%s, 'campaign_loaded', 0, %s)
                """,
                (CAMPAIGN_KEY, Json(payload)),
            )
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()

    return {
        "campaign_key": CAMPAIGN_KEY,
        "source_sha256": source_sha256,
        "already_loaded": False,
        "source_rows": total_source_rows,
        "valid_targets": len(rows),
        "invalid_rows": invalid_rows,
        "initial_missing": initial_missing_count,
        "accounts_inserted": accounts_inserted,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Load the authoritative Dallas residential DCAD account campaign"
    )
    parser.add_argument("csv_path", type=Path)
    args = parser.parse_args()
    result = import_targets(args.csv_path.resolve())
    print(json.dumps(result, indent=2, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
