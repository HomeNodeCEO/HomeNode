from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


FIELD_ALIASES = {
    "listing_key": ("ResourceRecordKey", "ListingKey"),
    "listing_id": ("ResourceRecordID", "ListingId"),
    "media_key": ("MediaKey", "OriginatingSystemMediaKey"),
    "media_url": ("MediaURL", "MediaUrl"),
    "order_number": ("Order", "OrderNumber"),
    "preferred_photo_yn": ("PreferredPhotoYN", "PreferredPhotoYesNo"),
    "media_category": ("ClassName", "MediaCategory", "MediaType"),
    "mime_type": ("MIMEType", "MimeType"),
    "short_description": ("ShortDescription", "MediaDescription"),
    "permission": ("Permission",),
    "modification_timestamp": ("ModificationTimestamp",),
}


@dataclass(frozen=True)
class PreparedMedia:
    source_row_number: int
    listing_key: str | None
    listing_id: str | None
    media_key: str | None
    media_url: str
    order_number: int | None
    preferred_photo_yn: bool
    media_category: str
    mime_type: str | None
    short_description: str | None
    permission: str | None
    modification_timestamp: datetime | None
    raw_payload: dict[str, str]


def _clean(value: str | None) -> str:
    return (value or "").strip()


def _source_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _find_header(headers: list[str], logical_name: str) -> str | None:
    header_map = {header.casefold(): header for header in headers}
    for candidate in FIELD_ALIASES[logical_name]:
        actual = header_map.get(candidate.casefold())
        if actual:
            return actual
    return None


def _parse_optional_int(value: str, field: str, row_number: int) -> int | None:
    if not value:
        return None
    try:
        result = int(value)
    except ValueError as error:
        raise ValueError(
            f"CSV row {row_number} has invalid {field}: {value!r}"
        ) from error
    if result < 0:
        raise ValueError(f"CSV row {row_number} has negative {field}: {value!r}")
    return result


def _parse_bool(value: str) -> bool:
    return value.strip().casefold() in {"true", "t", "yes", "y", "1"}


def _parse_timestamp(value: str, row_number: int) -> datetime | None:
    if not value:
        return None
    normalized = value.replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(normalized)
    except ValueError:
        for date_format in ("%m/%d/%Y %H:%M:%S", "%m/%d/%Y"):
            try:
                return datetime.strptime(value, date_format)
            except ValueError:
                continue
    raise ValueError(
        f"CSV row {row_number} has invalid ModificationTimestamp: {value!r}"
    )


def _media_category(value: str, mime_type: str) -> str:
    normalized = f"{value} {mime_type}".casefold()
    if "video" in normalized:
        return "video"
    if "virtual" in normalized or "tour" in normalized:
        return "virtual_tour"
    return "image"


def _load_media_rows(path: Path) -> list[PreparedMedia]:
    prepared: list[PreparedMedia] = []
    seen: set[tuple[str, str]] = set()
    with path.open("r", encoding="utf-8-sig", newline="") as source:
        reader = csv.DictReader(source)
        headers = reader.fieldnames or []
        media_url_header = _find_header(headers, "media_url")
        listing_key_header = _find_header(headers, "listing_key")
        listing_id_header = _find_header(headers, "listing_id")
        if not media_url_header:
            raise ValueError("CSV is missing MediaURL")
        if not listing_key_header and not listing_id_header:
            raise ValueError(
                "CSV needs ResourceRecordKey/ListingKey or "
                "ResourceRecordID/ListingId to attach each photo safely"
            )

        resolved_headers = {
            name: _find_header(headers, name) for name in FIELD_ALIASES
        }
        for row_number, source_row in enumerate(reader, start=2):
            raw_payload = {
                header: _clean(source_row.get(header)) for header in headers
            }
            value = lambda name: (
                raw_payload.get(resolved_headers[name] or "", "")
            )
            listing_key = value("listing_key") or None
            listing_id = value("listing_id") or None
            media_url = value("media_url")
            if not listing_key and not listing_id:
                raise ValueError(
                    f"CSV row {row_number} has no listing key or listing ID"
                )
            parsed_url = urlparse(media_url)
            if (
                parsed_url.scheme.casefold() not in {"http", "https"}
                or not parsed_url.netloc
            ):
                raise ValueError(
                    f"CSV row {row_number} has invalid MediaURL: {media_url!r}"
                )
            duplicate_key = (listing_key or listing_id or "", media_url)
            if duplicate_key in seen:
                raise ValueError(
                    f"CSV row {row_number} duplicates a listing/photo URL pair"
                )
            seen.add(duplicate_key)

            mime_type = value("mime_type")
            prepared.append(
                PreparedMedia(
                    source_row_number=row_number,
                    listing_key=listing_key,
                    listing_id=listing_id,
                    media_key=value("media_key") or None,
                    media_url=media_url,
                    order_number=_parse_optional_int(
                        value("order_number"), "Order", row_number
                    ),
                    preferred_photo_yn=_parse_bool(value("preferred_photo_yn")),
                    media_category=_media_category(
                        value("media_category"), mime_type
                    ),
                    mime_type=mime_type or None,
                    short_description=value("short_description") or None,
                    permission=value("permission") or None,
                    modification_timestamp=_parse_timestamp(
                        value("modification_timestamp"), row_number
                    ),
                    raw_payload=raw_payload,
                )
            )
    if not prepared:
        raise ValueError("CSV contains no media rows")
    return prepared


def _migration_sql() -> str:
    root = Path(__file__).resolve().parents[2]
    return (root / "migrations" / "010_sales_media.sql").read_text(
        encoding="utf-8"
    )


def import_sales_media(
    path: Path,
    dry_run: bool = False,
    replace: bool = False,
) -> dict[str, Any]:
    import psycopg2
    from psycopg2.extras import Json, execute_values

    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        raise RuntimeError("DATABASE_URL is not set")

    prepared = _load_media_rows(path)
    source_sha256 = _source_sha256(path)
    listing_keys = sorted(
        {row.listing_key for row in prepared if row.listing_key}
    )
    listing_ids = sorted({row.listing_id for row in prepared if row.listing_id})

    connection = psycopg2.connect(database_url)
    try:
        with connection.cursor() as cursor:
            cursor.execute(_migration_sql())
            cursor.execute(
                """
                SELECT id, listing_key, listing_id
                FROM core.sales_source_records
                WHERE listing_key = ANY(%s)
                   OR listing_id = ANY(%s)
                """,
                (listing_keys, listing_ids),
            )
            matches_by_key: dict[str, set[int]] = {}
            matches_by_id: dict[str, set[int]] = {}
            for source_record_id, listing_key, listing_id in cursor.fetchall():
                if listing_key:
                    matches_by_key.setdefault(listing_key, set()).add(
                        source_record_id
                    )
                if listing_id:
                    matches_by_id.setdefault(listing_id, set()).add(
                        source_record_id
                    )

            matched: list[tuple[PreparedMedia, int]] = []
            unmatched_rows: list[int] = []
            ambiguous_rows: list[int] = []
            for row in prepared:
                candidate_ids: set[int] = set()
                if row.listing_key:
                    candidate_ids.update(matches_by_key.get(row.listing_key, set()))
                if row.listing_id:
                    candidate_ids.update(matches_by_id.get(row.listing_id, set()))
                if len(candidate_ids) == 1:
                    matched.append((row, next(iter(candidate_ids))))
                elif not candidate_ids:
                    unmatched_rows.append(row.source_row_number)
                else:
                    ambiguous_rows.append(row.source_row_number)

            result = {
                "source_filename": path.name,
                "source_sha256": source_sha256,
                "source_rows": len(prepared),
                "image_rows": sum(
                    1 for row in prepared if row.media_category == "image"
                ),
                "matched_rows": len(matched),
                "unmatched_rows": len(unmatched_rows),
                "ambiguous_rows": len(ambiguous_rows),
                "unmatched_source_row_numbers": unmatched_rows[:50],
                "ambiguous_source_row_numbers": ambiguous_rows[:50],
                "replace": replace,
                "dry_run": dry_run,
            }
            if dry_run:
                connection.rollback()
                return result

            matched_record_ids = sorted(
                {source_record_id for _, source_record_id in matched}
            )
            if replace and matched_record_ids:
                cursor.execute(
                    """
                    DELETE FROM core.sales_source_media
                    WHERE source_record_id = ANY(%s)
                    """,
                    (matched_record_ids,),
                )

            values = [
                (
                    source_record_id,
                    row.media_key,
                    row.media_url,
                    row.media_category,
                    row.mime_type,
                    row.order_number,
                    row.preferred_photo_yn,
                    row.short_description,
                    row.permission,
                    row.modification_timestamp,
                    path.name,
                    source_sha256,
                    row.source_row_number,
                    Json(row.raw_payload),
                )
                for row, source_record_id in matched
            ]
            if values:
                execute_values(
                    cursor,
                    """
                    INSERT INTO core.sales_source_media (
                        source_record_id, media_key, media_url, media_category,
                        mime_type, order_number, preferred_photo_yn,
                        short_description, permission, modification_timestamp,
                        source_filename, source_sha256, source_row_number,
                        raw_payload
                    ) VALUES %s
                    ON CONFLICT (source_record_id, media_url) DO UPDATE SET
                        media_key = EXCLUDED.media_key,
                        media_category = EXCLUDED.media_category,
                        mime_type = EXCLUDED.mime_type,
                        order_number = EXCLUDED.order_number,
                        preferred_photo_yn = EXCLUDED.preferred_photo_yn,
                        short_description = EXCLUDED.short_description,
                        permission = EXCLUDED.permission,
                        modification_timestamp =
                            EXCLUDED.modification_timestamp,
                        source_filename = EXCLUDED.source_filename,
                        source_sha256 = EXCLUDED.source_sha256,
                        source_row_number = EXCLUDED.source_row_number,
                        raw_payload = EXCLUDED.raw_payload,
                        updated_at = now()
                    """,
                    values,
                    page_size=500,
                )
            result["media_rows_upserted"] = len(values)

        connection.commit()
        return result
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Attach ordered RESO MLS Media rows to previously imported "
            "listing/sale records"
        )
    )
    parser.add_argument("csv_path", type=Path)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate keys and report match coverage without changing the database",
    )
    parser.add_argument(
        "--replace",
        action="store_true",
        help="Replace existing galleries for matched listings before loading",
    )
    args = parser.parse_args()
    result = import_sales_media(
        args.csv_path.resolve(),
        dry_run=args.dry_run,
        replace=args.replace,
    )
    print(json.dumps(result, indent=2, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
