from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import re
from collections import Counter
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

BASE_HEADERS = [
    "BedroomsTotal",
    "BathroomsTotalInteger",
    "BathroomsFull",
    "BathroomsHalf",
    "LivingArea",
    "LotSizeArea",
    "CurrentPrice",
    "RATIO_CurrentPrice_By_LivingArea",
    "RATIO_ClosePrice_By_ListPrice",
    "RATIO_ClosePrice_By_OriginalListPrice",
    "RATIO_ClosePrice_By_LivingArea",
    "DaysOnMarket",
    "YearBuilt",
    "CloseDate",
    "SellerContributions",
    "MlsStatus",
    "GarageSpaces",
    "GarageYN",
    "PoolYN",
    "ListingContractDate",
    "ParcelNumber",
    "ParcelNumber2",
    "BuyerFinancing",
]
STYLE_HEADERS = [
    "StructuralStyle",
    "ArchitecturalStyle",
]
EXPECTED_HEADERS = BASE_HEADERS + STYLE_HEADERS
OPTIONAL_SOURCE_HEADERS = [
    "ListingKey",
    "ListingId",
]
ACCOUNT_PATTERN = re.compile(r"^[A-Z0-9]{17}$")
EMBEDDED_ACCOUNT_PATTERN = re.compile(r"(?<![A-Z0-9])([A-Z0-9]{17})(?![A-Z0-9])")


@dataclass
class ParcelLink:
    source_position: int
    parcel_sequence: int
    parcel_role: str
    parcel_number_raw: str
    parcel_number_normalized: str | None
    account_id: str | None
    match_method: str


@dataclass
class PreparedSale:
    source_row_number: int
    raw_payload: dict[str, str]
    source_record_hash: str
    transaction_fingerprint: str
    typed: dict[str, Any]
    parcel_links: list[ParcelLink]
    primary_account_id: str | None
    match_status: str
    has_multiple_parcel_numbers: bool
    multi_parcel_status: str
    has_unresolved_parcel: bool
    requires_additional_review: bool
    data_quality_flags: list[str]


def _clean(value: str | None) -> str:
    return (value or "").strip()


def _clean_account(value: str | None) -> str:
    return _clean(value).upper()


def _source_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _stable_hash(value: object) -> str:
    encoded = json.dumps(
        value, sort_keys=True, ensure_ascii=False, separators=(",", ":")
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _classify_structural_style(value: str | None) -> tuple[str | None, str]:
    """Return a concise housing type and an attachment safeguard classification."""
    raw = _clean(value)
    if not raw:
        return None, "unknown"

    normalized = raw.casefold()
    has_detached = "single detached" in normalized
    has_attached = any(
        marker in normalized
        for marker in (
            "attached",
            "duplex",
            "condo/townhome",
            "apartment",
        )
    )
    if has_attached and has_detached:
        attachment_type = "mixed"
        housing_type = "Mixed/Review"
    elif has_attached:
        attachment_type = "attached"
        if "condo/townhome" in normalized:
            housing_type = "Condo/Townhome"
        elif "duplex" in normalized or "attached" in normalized:
            housing_type = "Attached/Duplex"
        else:
            housing_type = "Attached"
    elif has_detached:
        attachment_type = "detached"
        housing_type = "Single Family"
    elif "garden/zero lot line" in normalized:
        attachment_type = "unknown"
        housing_type = "Garden/Zero Lot Line"
    elif "farm/ranch house" in normalized:
        attachment_type = "unknown"
        housing_type = "Farm/Ranch House"
    else:
        attachment_type = "unknown"
        housing_type = raw

    return housing_type, attachment_type


def _load_rows(path: Path) -> list[tuple[int, dict[str, str]]]:
    rows: list[tuple[int, dict[str, str]]] = []
    hashes: set[str] = set()
    with path.open("r", encoding="utf-8-sig", newline="") as source:
        reader = csv.DictReader(source)
        headers = reader.fieldnames or []
        missing = [header for header in EXPECTED_HEADERS if header not in headers]
        if missing:
            raise ValueError(f"CSV is missing required columns: {', '.join(missing)}")

        source_headers = EXPECTED_HEADERS + [
            header for header in OPTIONAL_SOURCE_HEADERS if header in headers
        ]
        for source_row_number, source_row in enumerate(reader, start=2):
            raw_payload = {
                header: _clean(source_row.get(header)) for header in source_headers
            }
            # Style columns were added after the original import. Keeping the
            # original 23-column hash lets the revised export enrich those rows
            # in place instead of creating a second copy of every prior sale.
            record_hash = _stable_hash(
                {header: raw_payload[header] for header in BASE_HEADERS}
            )
            if record_hash in hashes:
                raise ValueError(
                    f"Duplicate source row content at CSV row {source_row_number}"
                )
            hashes.add(record_hash)
            rows.append((source_row_number, raw_payload))
    if not rows:
        raise ValueError("CSV contains no data rows")
    return rows


def _parcel_variants(value: str | None) -> list[tuple[str, str]]:
    raw = _clean_account(value)
    if not raw:
        return []

    variants: dict[str, str] = {}
    if ACCOUNT_PATTERN.fullmatch(raw):
        variants[raw] = "exact"

    collapsed = re.sub(r"[^A-Z0-9]", "", raw)
    if ACCOUNT_PATTERN.fullmatch(collapsed) and collapsed not in variants:
        variants[collapsed] = "punctuation_normalized"

    for embedded in EMBEDDED_ACCOUNT_PATTERN.findall(raw):
        variants.setdefault(embedded, "embedded_full_id")

    if len(collapsed) > 17 and len(collapsed) % 17 == 0:
        for start in range(0, len(collapsed), 17):
            candidate = collapsed[start : start + 17]
            if ACCOUNT_PATTERN.fullmatch(candidate):
                variants.setdefault(candidate, "concatenated_full_ids")

    return list(variants.items())


def _to_decimal(value: str, field: str, flags: list[str]) -> Decimal | None:
    raw = value.replace("$", "").replace(",", "").strip()
    if not raw:
        return None
    try:
        return Decimal(raw)
    except InvalidOperation:
        flags.append(f"invalid_{field}")
        return None


def _to_int(value: str, field: str, flags: list[str]) -> int | None:
    raw = value.strip()
    if not raw:
        return None
    try:
        return int(raw)
    except ValueError:
        flags.append(f"invalid_{field}")
        return None


def _to_date(value: str, field: str, flags: list[str]) -> date | None:
    raw = value.strip()
    if not raw:
        return None
    try:
        return datetime.strptime(raw, "%m/%d/%Y").date()
    except ValueError:
        flags.append(f"invalid_{field}")
        return None


def _to_bool(value: str, field: str, flags: list[str]) -> bool | None:
    raw = value.strip().upper()
    if not raw:
        return None
    if raw in {"TRUE", "T", "YES", "Y", "1"}:
        return True
    if raw in {"FALSE", "F", "NO", "N", "0"}:
        return False
    flags.append(f"invalid_{field}")
    return None


def _typed_values(raw: dict[str, str]) -> tuple[dict[str, Any], list[str]]:
    flags: list[str] = []
    mls_status = raw["MlsStatus"] or None
    record_type = (
        "closed_sale"
        if (mls_status or "").strip().casefold() == "closed"
        else "listing"
    )
    housing_type, attachment_type = _classify_structural_style(
        raw["StructuralStyle"]
    )
    typed = {
        "bedrooms_total": _to_int(raw["BedroomsTotal"], "bedrooms_total", flags),
        "bathrooms_total_integer": _to_int(
            raw["BathroomsTotalInteger"], "bathrooms_total_integer", flags
        ),
        "bathrooms_full": _to_int(raw["BathroomsFull"], "bathrooms_full", flags),
        "bathrooms_half": _to_int(raw["BathroomsHalf"], "bathrooms_half", flags),
        "living_area": _to_decimal(raw["LivingArea"], "living_area", flags),
        "lot_size_area": _to_decimal(raw["LotSizeArea"], "lot_size_area", flags),
        "current_price": _to_decimal(raw["CurrentPrice"], "current_price", flags),
        "ratio_current_price_by_living_area": _to_decimal(
            raw["RATIO_CurrentPrice_By_LivingArea"],
            "ratio_current_price_by_living_area",
            flags,
        ),
        "ratio_close_price_by_list_price": _to_decimal(
            raw["RATIO_ClosePrice_By_ListPrice"],
            "ratio_close_price_by_list_price",
            flags,
        ),
        "ratio_close_price_by_original_list_price": _to_decimal(
            raw["RATIO_ClosePrice_By_OriginalListPrice"],
            "ratio_close_price_by_original_list_price",
            flags,
        ),
        "ratio_close_price_by_living_area": _to_decimal(
            raw["RATIO_ClosePrice_By_LivingArea"],
            "ratio_close_price_by_living_area",
            flags,
        ),
        "days_on_market": _to_int(raw["DaysOnMarket"], "days_on_market", flags),
        "year_built": _to_int(raw["YearBuilt"], "year_built", flags),
        "close_date": _to_date(raw["CloseDate"], "close_date", flags),
        "seller_contributions": _to_decimal(
            raw["SellerContributions"], "seller_contributions", flags
        ),
        "mls_status": mls_status,
        "record_type": record_type,
        "garage_spaces": _to_decimal(raw["GarageSpaces"], "garage_spaces", flags),
        "garage_yn": _to_bool(raw["GarageYN"], "garage_yn", flags),
        "pool_yn": _to_bool(raw["PoolYN"], "pool_yn", flags),
        "listing_contract_date": _to_date(
            raw["ListingContractDate"], "listing_contract_date", flags
        ),
        "parcel_number_raw": raw["ParcelNumber"] or None,
        "parcel_number2_raw": raw["ParcelNumber2"] or None,
        "buyer_financing": raw["BuyerFinancing"] or None,
        "structural_style": raw["StructuralStyle"] or None,
        "housing_type": housing_type,
        "attachment_type": attachment_type,
        "architectural_style": raw["ArchitecturalStyle"] or None,
        "listing_key": raw.get("ListingKey") or None,
        "listing_id": raw.get("ListingId") or None,
    }

    price = typed["current_price"]
    days_on_market = typed["days_on_market"]
    contributions = typed["seller_contributions"]
    close_date = typed["close_date"]
    contract_date = typed["listing_contract_date"]

    if price is None:
        flags.append(
            "missing_sale_price"
            if record_type == "closed_sale"
            else "missing_listing_price"
        )
    elif price <= 0:
        flags.append("non_positive_sale_price")
    elif price < Decimal("10000"):
        flags.append("low_sale_price")
    if days_on_market is not None and days_on_market < 0:
        flags.append("negative_days_on_market")
    if record_type == "closed_sale" and close_date is None:
        flags.append("missing_close_date")
    if close_date and contract_date and contract_date > close_date:
        flags.append("listing_contract_date_after_close_date")
    if record_type == "closed_sale":
        if contributions is None:
            flags.append("missing_seller_contributions")
        elif price is not None and contributions > price:
            flags.append("seller_contributions_exceed_sale_price")
        if typed["buyer_financing"] is None:
            flags.append("missing_buyer_financing")
    if attachment_type == "mixed":
        flags.append("conflicting_attachment_classification")
    elif attachment_type == "attached":
        flags.append("attached_housing_type")
    if housing_type is None:
        flags.append("missing_housing_type")

    return typed, list(dict.fromkeys(flags))


def _migration_sql() -> str:
    root = Path(__file__).resolve().parents[2]
    migrations = (
        root / "migrations" / "004_sales_ingestion.sql",
        root / "migrations" / "009_verified_account_housing_profiles.sql",
        root / "migrations" / "010_sales_media.sql",
    )
    return "\n\n".join(path.read_text(encoding="utf-8") for path in migrations)


def _account_map(connection, variants: set[str]) -> dict[str, dict[str, Any]]:
    if not variants:
        return {}
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT account_id, county, address
            FROM core.accounts
            WHERE account_id = ANY(%s)
            """,
            (list(variants),),
        )
        return {
            account_id: {"county": county, "address": address}
            for account_id, county, address in cursor.fetchall()
        }


def _parcel_links(
    raw: dict[str, str], accounts: dict[str, dict[str, Any]]
) -> list[ParcelLink]:
    links: list[ParcelLink] = []
    for source_position, field in ((1, "ParcelNumber"), (2, "ParcelNumber2")):
        raw_value = raw[field]
        if not raw_value:
            continue

        matched: list[tuple[str, str]] = []
        for candidate, method in _parcel_variants(raw_value):
            if candidate in accounts and candidate not in {item[0] for item in matched}:
                matched.append((candidate, method))

        if matched:
            for parcel_sequence, (account_id, method) in enumerate(matched, start=1):
                links.append(
                    ParcelLink(
                        source_position=source_position,
                        parcel_sequence=parcel_sequence,
                        parcel_role="primary" if source_position == 1 else "additional",
                        parcel_number_raw=raw_value,
                        parcel_number_normalized=account_id,
                        account_id=account_id,
                        match_method=method,
                    )
                )
        else:
            normalized = next(
                (candidate for candidate, _ in _parcel_variants(raw_value)), None
            )
            links.append(
                ParcelLink(
                    source_position=source_position,
                    parcel_sequence=1,
                    parcel_role="primary" if source_position == 1 else "additional",
                    parcel_number_raw=raw_value,
                    parcel_number_normalized=normalized,
                    account_id=None,
                    match_method="unmatched",
                )
            )
    return links


def _prepare_sales(
    rows: list[tuple[int, dict[str, str]]],
    accounts: dict[str, dict[str, Any]],
) -> list[PreparedSale]:
    prepared: list[PreparedSale] = []
    for source_row_number, raw in rows:
        typed, flags = _typed_values(raw)
        links = _parcel_links(raw, accounts)
        resolved_accounts = list(
            dict.fromkeys(link.account_id for link in links if link.account_id)
        )
        primary_links = [
            link for link in links if link.source_position == 1 and link.account_id
        ]
        secondary_links = [
            link for link in links if link.source_position == 2 and link.account_id
        ]
        primary_account_id = (
            primary_links[0].account_id
            if primary_links
            else (secondary_links[0].account_id if secondary_links else None)
        )

        if not resolved_accounts:
            match_status = "unmatched"
        elif len(resolved_accounts) > 1:
            match_status = "multiple"
        elif primary_links and primary_links[0].match_method == "exact":
            match_status = "exact"
        elif primary_links:
            match_status = "normalized"
        else:
            match_status = "secondary"

        has_second_field = bool(raw["ParcelNumber2"])
        has_multiple_numbers = has_second_field or any(
            link.parcel_sequence > 1 for link in links
        )
        if len(resolved_accounts) > 1:
            multi_parcel_status = "confirmed"
            flags.append("confirmed_multi_parcel_sale")
        elif has_multiple_numbers:
            multi_parcel_status = "possible"
            flags.append("possible_multi_parcel_sale")
        else:
            multi_parcel_status = "single"

        has_unresolved = any(not link.account_id for link in links)
        if has_unresolved:
            flags.append("unresolved_parcel_number")

        flags = list(dict.fromkeys(flags))
        fingerprint_parcels = (
            sorted(resolved_accounts)
            if resolved_accounts
            else sorted(
                value
                for value in (
                    _clean_account(raw["ParcelNumber"]),
                    _clean_account(raw["ParcelNumber2"]),
                )
                if value
            )
        )
        transaction_fingerprint = _stable_hash(
            {
                "parcels": fingerprint_parcels,
                "close_date": str(typed["close_date"] or ""),
                "sale_price": str(typed["current_price"] or ""),
            }
        )

        prepared.append(
            PreparedSale(
                source_row_number=source_row_number,
                raw_payload=raw,
                source_record_hash=_stable_hash(
                    {header: raw[header] for header in BASE_HEADERS}
                ),
                transaction_fingerprint=transaction_fingerprint,
                typed=typed,
                parcel_links=links,
                primary_account_id=primary_account_id,
                match_status=match_status,
                has_multiple_parcel_numbers=has_multiple_numbers,
                multi_parcel_status=multi_parcel_status,
                has_unresolved_parcel=has_unresolved,
                requires_additional_review=bool(flags),
                data_quality_flags=flags,
            )
        )
    return prepared


def _summary(
    prepared: list[PreparedSale],
    accounts: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    match_counts = Counter(row.match_status for row in prepared)
    multi_counts = Counter(row.multi_parcel_status for row in prepared)
    flag_counts = Counter(
        flag for row in prepared for flag in row.data_quality_flags
    )
    resolved_accounts = {
        link.account_id
        for row in prepared
        for link in row.parcel_links
        if link.account_id
    }
    county_counts = Counter(
        (accounts[account_id]["county"] or "<blank county>")
        for row in prepared
        for account_id in [row.primary_account_id]
        if account_id
    )
    record_type_counts = Counter(row.typed["record_type"] for row in prepared)
    attachment_counts = Counter(
        row.typed["attachment_type"] for row in prepared
    )
    return {
        "source_rows": len(prepared),
        "match_status": dict(match_counts),
        "multi_parcel_status": dict(multi_counts),
        "rows_with_primary_account": sum(
            1 for row in prepared if row.primary_account_id
        ),
        "rows_without_primary_account": sum(
            1 for row in prepared if not row.primary_account_id
        ),
        "distinct_resolved_accounts": len(resolved_accounts),
        "county_rows": dict(county_counts),
        "record_type": dict(record_type_counts),
        "attachment_type": dict(attachment_counts),
        "parcel_link_rows": sum(len(row.parcel_links) for row in prepared),
        "resolved_parcel_links": sum(
            1 for row in prepared for link in row.parcel_links if link.account_id
        ),
        "unresolved_parcel_links": sum(
            1 for row in prepared for link in row.parcel_links if not link.account_id
        ),
        "rows_requiring_review": sum(
            1 for row in prepared if row.requires_additional_review
        ),
        "quality_flags": dict(flag_counts),
    }


def import_sales(
    path: Path, source_name: str, dry_run: bool = False
) -> dict[str, Any]:
    import psycopg2
    from psycopg2.extras import Json, execute_batch, execute_values

    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        raise RuntimeError("DATABASE_URL is not set")

    source_sha256 = _source_sha256(path)
    rows = _load_rows(path)
    all_variants = {
        candidate
        for _, raw in rows
        for field in ("ParcelNumber", "ParcelNumber2")
        for candidate, _ in _parcel_variants(raw[field])
    }

    connection = psycopg2.connect(database_url)
    try:
        accounts = _account_map(connection, all_variants)
        prepared = _prepare_sales(rows, accounts)
        result = {
            "source_name": source_name,
            "source_filename": path.name,
            "source_sha256": source_sha256,
            "dry_run": dry_run,
            **_summary(prepared, accounts),
        }
        if dry_run:
            connection.rollback()
            return result

        with connection.cursor() as cursor:
            cursor.execute(_migration_sql())

            source_values = []
            for row in prepared:
                typed = row.typed
                source_values.append(
                    (
                        source_name,
                        path.name,
                        [path.name],
                        source_sha256,
                        row.source_row_number,
                        row.source_record_hash,
                        row.transaction_fingerprint,
                        typed["bedrooms_total"],
                        typed["bathrooms_total_integer"],
                        typed["bathrooms_full"],
                        typed["bathrooms_half"],
                        typed["living_area"],
                        typed["lot_size_area"],
                        typed["current_price"],
                        typed["ratio_current_price_by_living_area"],
                        typed["ratio_close_price_by_list_price"],
                        typed["ratio_close_price_by_original_list_price"],
                        typed["ratio_close_price_by_living_area"],
                        typed["days_on_market"],
                        typed["year_built"],
                        typed["close_date"],
                        typed["seller_contributions"],
                        typed["mls_status"],
                        typed["garage_spaces"],
                        typed["garage_yn"],
                        typed["pool_yn"],
                        typed["listing_contract_date"],
                        typed["parcel_number_raw"],
                        typed["parcel_number2_raw"],
                        typed["buyer_financing"],
                        typed["record_type"],
                        typed["structural_style"],
                        typed["housing_type"],
                        typed["attachment_type"],
                        typed["architectural_style"],
                        typed["listing_key"],
                        typed["listing_id"],
                        row.primary_account_id,
                        row.match_status,
                        row.has_multiple_parcel_numbers,
                        row.multi_parcel_status,
                        row.has_unresolved_parcel,
                        row.requires_additional_review,
                        Json(row.data_quality_flags),
                        Json(row.raw_payload),
                    )
                )

            returned = execute_values(
                cursor,
                """
                INSERT INTO core.sales_source_records (
                    source_name, source_filename, source_files,
                    source_sha256, source_row_number, source_record_hash,
                    transaction_fingerprint, bedrooms_total,
                    bathrooms_total_integer, bathrooms_full, bathrooms_half,
                    living_area, lot_size_area, current_price,
                    ratio_current_price_by_living_area,
                    ratio_close_price_by_list_price,
                    ratio_close_price_by_original_list_price,
                    ratio_close_price_by_living_area, days_on_market,
                    year_built, close_date, seller_contributions, mls_status,
                    garage_spaces, garage_yn, pool_yn, listing_contract_date,
                    parcel_number_raw, parcel_number2_raw, buyer_financing,
                    record_type, structural_style, housing_type,
                    attachment_type, architectural_style, listing_key,
                    listing_id,
                    primary_account_id, match_status,
                    has_multiple_parcel_numbers, multi_parcel_status,
                    has_unresolved_parcel, requires_additional_review,
                    data_quality_flags, raw_payload
                ) VALUES %s
                ON CONFLICT (source_record_hash) DO UPDATE SET
                    source_name = EXCLUDED.source_name,
                    source_filename = EXCLUDED.source_filename,
                    source_files = CASE
                        WHEN core.sales_source_records.source_files @> EXCLUDED.source_files
                            THEN core.sales_source_records.source_files
                        ELSE core.sales_source_records.source_files || EXCLUDED.source_files
                    END,
                    source_sha256 = EXCLUDED.source_sha256,
                    source_row_number = EXCLUDED.source_row_number,
                    transaction_fingerprint = EXCLUDED.transaction_fingerprint,
                    bedrooms_total = EXCLUDED.bedrooms_total,
                    bathrooms_total_integer = EXCLUDED.bathrooms_total_integer,
                    bathrooms_full = EXCLUDED.bathrooms_full,
                    bathrooms_half = EXCLUDED.bathrooms_half,
                    living_area = EXCLUDED.living_area,
                    lot_size_area = EXCLUDED.lot_size_area,
                    current_price = EXCLUDED.current_price,
                    ratio_current_price_by_living_area = EXCLUDED.ratio_current_price_by_living_area,
                    ratio_close_price_by_list_price = EXCLUDED.ratio_close_price_by_list_price,
                    ratio_close_price_by_original_list_price = EXCLUDED.ratio_close_price_by_original_list_price,
                    ratio_close_price_by_living_area = EXCLUDED.ratio_close_price_by_living_area,
                    days_on_market = EXCLUDED.days_on_market,
                    year_built = EXCLUDED.year_built,
                    close_date = EXCLUDED.close_date,
                    seller_contributions = EXCLUDED.seller_contributions,
                    mls_status = EXCLUDED.mls_status,
                    garage_spaces = EXCLUDED.garage_spaces,
                    garage_yn = EXCLUDED.garage_yn,
                    pool_yn = EXCLUDED.pool_yn,
                    listing_contract_date = EXCLUDED.listing_contract_date,
                    parcel_number_raw = EXCLUDED.parcel_number_raw,
                    parcel_number2_raw = EXCLUDED.parcel_number2_raw,
                    buyer_financing = EXCLUDED.buyer_financing,
                    record_type = EXCLUDED.record_type,
                    structural_style = EXCLUDED.structural_style,
                    housing_type = EXCLUDED.housing_type,
                    attachment_type = EXCLUDED.attachment_type,
                    architectural_style = EXCLUDED.architectural_style,
                    listing_key = COALESCE(
                        NULLIF(EXCLUDED.listing_key, ''),
                        core.sales_source_records.listing_key
                    ),
                    listing_id = COALESCE(
                        NULLIF(EXCLUDED.listing_id, ''),
                        core.sales_source_records.listing_id
                    ),
                    primary_account_id = EXCLUDED.primary_account_id,
                    match_status = EXCLUDED.match_status,
                    has_multiple_parcel_numbers = EXCLUDED.has_multiple_parcel_numbers,
                    multi_parcel_status = EXCLUDED.multi_parcel_status,
                    has_unresolved_parcel = EXCLUDED.has_unresolved_parcel,
                    requires_additional_review = EXCLUDED.requires_additional_review,
                    data_quality_flags = EXCLUDED.data_quality_flags,
                    raw_payload = EXCLUDED.raw_payload,
                    updated_at = now()
                RETURNING id, source_record_hash
                """,
                source_values,
                page_size=500,
                fetch=True,
            )
            record_ids = {record_hash: record_id for record_id, record_hash in returned}
            source_record_ids = list(record_ids.values())

            cursor.execute(
                "DELETE FROM core.sale_parcels WHERE source_record_id = ANY(%s)",
                (source_record_ids,),
            )
            parcel_values = []
            for row in prepared:
                source_record_id = record_ids[row.source_record_hash]
                for link in row.parcel_links:
                    parcel_values.append(
                        (
                            source_record_id,
                            link.source_position,
                            link.parcel_sequence,
                            link.parcel_role,
                            link.parcel_number_raw,
                            link.parcel_number_normalized,
                            link.account_id,
                            link.match_method,
                            bool(link.account_id),
                        )
                    )
            execute_values(
                cursor,
                """
                INSERT INTO core.sale_parcels (
                    source_record_id, source_position, parcel_sequence,
                    parcel_role, parcel_number_raw, parcel_number_normalized,
                    account_id, match_method, is_resolved
                ) VALUES %s
                """,
                parcel_values,
                page_size=1000,
            )

            matched_rows = [
                row
                for row in prepared
                if row.primary_account_id
                and row.typed["record_type"] == "closed_sale"
                and row.typed["close_date"] is not None
                and row.typed["current_price"] is not None
                and row.typed["current_price"] > 0
            ]
            account_ids = list({row.primary_account_id for row in matched_rows})
            existing_by_key: dict[tuple[str, date | None, Decimal | None], list[tuple[int, int | None]]] = {}
            if account_ids:
                cursor.execute(
                    """
                    SELECT id, account_id, closing_date, sale_price, source_record_id
                    FROM core.sales
                    WHERE account_id = ANY(%s)
                    """,
                    (account_ids,),
                )
                for sale_id, account_id, closing_date, sale_price, source_record_id in cursor.fetchall():
                    key = (
                        account_id,
                        closing_date,
                        Decimal(sale_price) if sale_price is not None else None,
                    )
                    existing_by_key.setdefault(key, []).append((sale_id, source_record_id))

            attach_updates = []
            sales_values = []
            existing_sales_attached = 0
            existing_sales_already_linked = 0
            for row in matched_rows:
                typed = row.typed
                source_record_id = record_ids[row.source_record_hash]
                key = (
                    row.primary_account_id,
                    typed["close_date"],
                    typed["current_price"],
                )
                existing = existing_by_key.get(key, [])
                same_link = [item for item in existing if item[1] == source_record_id]
                attachable = [item for item in existing if item[1] is None]
                if same_link:
                    existing_sales_already_linked += 1
                    continue
                if len(existing) == 1 and len(attachable) == 1:
                    sale_id = attachable[0][0]
                    attach_updates.append((source_record_id, sale_id))
                    existing_sales_attached += 1
                    continue

                sales_values.append(
                    (
                        row.primary_account_id,
                        accounts[row.primary_account_id]["address"],
                        typed["close_date"],
                        typed["current_price"],
                        typed["days_on_market"],
                        str(typed["seller_contributions"])
                        if typed["seller_contributions"] is not None
                        else None,
                        source_name,
                        source_record_id,
                    )
                )

            if attach_updates:
                execute_batch(
                    cursor,
                    """
                    UPDATE core.sales
                    SET source_record_id = %s
                    WHERE id = %s AND source_record_id IS NULL
                    """,
                    attach_updates,
                    page_size=500,
                )

            if sales_values:
                execute_values(
                    cursor,
                    """
                    INSERT INTO core.sales (
                        account_id, address, closing_date, sale_price,
                        days_on_market, concessions, source, source_record_id
                    ) VALUES %s
                    ON CONFLICT (source_record_id)
                        WHERE source_record_id IS NOT NULL
                    DO UPDATE SET
                        account_id = EXCLUDED.account_id,
                        address = COALESCE(EXCLUDED.address, core.sales.address),
                        closing_date = EXCLUDED.closing_date,
                        sale_price = EXCLUDED.sale_price,
                        days_on_market = EXCLUDED.days_on_market,
                        concessions = EXCLUDED.concessions,
                        source = EXCLUDED.source,
                        loaded_at = now()
                    """,
                    sales_values,
                    page_size=500,
                )

            result.update(
                {
                    "source_records_upserted": len(record_ids),
                    "canonical_sales_submitted": len(sales_values),
                    "listings_preserved": sum(
                        1
                        for row in prepared
                        if row.typed["record_type"] == "listing"
                    ),
                    "closed_rows_not_canonicalized": sum(
                        1
                        for row in prepared
                        if row.typed["record_type"] == "closed_sale"
                        and row not in matched_rows
                    ),
                    "existing_sales_attached": existing_sales_attached,
                    "existing_sales_already_linked": existing_sales_already_linked,
                }
            )

        connection.commit()
        return result
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Load a sales CSV while preserving raw, unmatched, and multi-parcel rows"
    )
    parser.add_argument("csv_path", type=Path)
    parser.add_argument(
        "--source-name",
        default="MLS sales export",
        help="Human-readable source label stored with the sale records",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Analyze and match rows without changing the database",
    )
    args = parser.parse_args()
    result = import_sales(
        args.csv_path.resolve(), args.source_name.strip(), dry_run=args.dry_run
    )
    print(json.dumps(result, indent=2, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
