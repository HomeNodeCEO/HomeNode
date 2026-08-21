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
    "Address",
    "UnparsedAddress",
    "PropertyAddress",
    "StreetAddress",
    "City",
    "State",
    "StateOrProvince",
    "PostalCode",
    "Zip",
    "County",
    "CountyOrParish",
]
ACCOUNT_PATTERN = re.compile(r"^[A-Z0-9]{17}$")
EMBEDDED_ACCOUNT_PATTERN = re.compile(r"(?<![A-Z0-9])([A-Z0-9]{17})(?![A-Z0-9])")
COLLIN_VARIANT_PREFIX = "COLLIN:"
ADDRESS_FIELDS = ("Address", "UnparsedAddress", "PropertyAddress", "StreetAddress")
CITY_FIELDS = ("City",)
COUNTY_FIELDS = ("County", "CountyOrParish")
ADDRESS_TOKEN_ALIASES = {
    "ALLEY": "ALY",
    "AVENUE": "AVE",
    "BOULEVARD": "BLVD",
    "CIRCLE": "CIR",
    "COURT": "CT",
    "DRIVE": "DR",
    "EXPRESSWAY": "EXPY",
    "FREEWAY": "FWY",
    "HIGHWAY": "HWY",
    "LANE": "LN",
    "NORTH": "N",
    "NORTHEAST": "NE",
    "NORTHWEST": "NW",
    "PARKWAY": "PKWY",
    "PLACE": "PL",
    "ROAD": "RD",
    "SOUTH": "S",
    "SOUTHEAST": "SE",
    "SOUTHWEST": "SW",
    "SQUARE": "SQ",
    "STREET": "ST",
    "TERRACE": "TER",
    "TRAIL": "TRL",
    "WEST": "W",
    "APARTMENT": "UNIT",
    "APT": "UNIT",
    "SUITE": "UNIT",
    "STE": "UNIT",
}


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


def _first_value(raw: dict[str, str], fields: tuple[str, ...]) -> str:
    return next((_clean(raw.get(field)) for field in fields if _clean(raw.get(field))), "")


def _normalize_place(value: object) -> str:
    text = re.sub(r"[^A-Z0-9]+", " ", _clean(str(value or "")).upper())
    return re.sub(r"\s+", " ", text).strip()


def _normalize_situs_address(value: object) -> str:
    """Normalize an MLS or CAD situs line for conservative exact matching."""

    text = _clean(str(value or "")).upper().split(",", 1)[0]
    text = re.sub(r"#\s*([A-Z0-9-]+)", r" UNIT \1", text)
    tokens = re.sub(r"[^A-Z0-9]+", " ", text).split()
    normalized = [ADDRESS_TOKEN_ALIASES.get(token, token) for token in tokens]
    return " ".join(normalized)


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


def _source_record_hash(raw: dict[str, str]) -> str:
    """Use stable MLS identity, with the legacy row hash as a fallback."""

    listing_key = _clean(raw.get("ListingKey")).upper()
    if listing_key:
        return _stable_hash({"source": "NTREIS", "listing_key": listing_key})
    listing_id = _clean(raw.get("ListingId")).upper()
    if listing_id:
        return _stable_hash({"source": "NTREIS", "listing_id": listing_id})
    return _stable_hash({header: raw[header] for header in BASE_HEADERS})


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
            record_hash = _source_record_hash(raw_payload)
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

    # NTREIS agents commonly omit the punctuation (and sometimes the leading
    # R) from Collin CAD's authoritative geoID. The sentinel keeps this
    # comparison namespace separate from Dallas account IDs; the importer maps
    # it through app.county_account_identifiers and still stores the official
    # dashed Collin identifier there for display and audit.
    collin_key = collapsed[1:] if collapsed.startswith("R") else collapsed
    if (
        (collapsed.startswith("R") or not ACCOUNT_PATTERN.fullmatch(collapsed))
        and 4 <= len(collin_key) <= 99
    ):
        variants.setdefault(
            f"{COLLIN_VARIANT_PREFIX}{collin_key}",
            "punctuation_normalized",
        )

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
        root / "migrations" / "013_sales_listing_identity.sql",
        root / "migrations" / "014_sales_reconciliation.sql",
        root / "migrations" / "015_location_backfill_queue.sql",
        root / "migrations" / "017_native_county_account_identifiers.sql",
        root / "migrations" / "018_trestle_replication_readiness.sql",
    )
    return "\n\n".join(path.read_text(encoding="utf-8") for path in migrations)


def _existing_hashes_by_listing_id(
    connection, listing_ids: set[str]
) -> dict[str, str]:
    """Reuse legacy hashes for listings imported before MLS identity existed."""

    if not listing_ids:
        return {}
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT upper(btrim(listing_id)), source_record_hash
            FROM core.sales_source_records
            WHERE upper(btrim(listing_id)) = ANY(%s)
            """,
            (list(listing_ids),),
        )
        rows = cursor.fetchall()
    hashes: dict[str, str] = {}
    for listing_id, source_record_hash in rows:
        if listing_id in hashes and hashes[listing_id] != source_record_hash:
            raise ValueError(f"Multiple source records use MLS number {listing_id}")
        hashes[listing_id] = source_record_hash
    return hashes


def _account_map(connection, variants: set[str]) -> dict[str, dict[str, Any]]:
    if not variants:
        return {}
    direct_variants = [
        value for value in variants if not value.startswith(COLLIN_VARIANT_PREFIX)
    ]
    collin_keys = [
        value[len(COLLIN_VARIANT_PREFIX) :]
        for value in variants
        if value.startswith(COLLIN_VARIANT_PREFIX)
    ]
    accounts: dict[str, dict[str, Any]] = {}
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT account_id, county, address
            FROM core.accounts
            WHERE account_id = ANY(%s)
            """,
            (direct_variants,),
        )
        for account_id, county, address in cursor.fetchall():
            accounts[account_id] = {
                "account_id": account_id,
                "county": county,
                "address": address,
            }

        if collin_keys:
            cursor.execute(
                """
                SELECT to_regclass('app.county_account_identifiers') IS NOT NULL
                """
            )
            aliases_available = bool(cursor.fetchone()[0])
            if aliases_available:
                cursor.execute(
                    """
                    SELECT
                        identifier.normalized_account_id,
                        account.account_id,
                        account.county,
                        account.address
                    FROM app.county_account_identifiers identifier
                    JOIN core.accounts account
                      ON account.account_id = identifier.account_id
                    WHERE identifier.county = 'COLLIN'
                      AND identifier.normalized_account_id = ANY(%s)
                    """,
                    (collin_keys,),
                )
                for key, account_id, county, address in cursor.fetchall():
                    record = {
                        "account_id": account_id,
                        "county": county,
                        "address": address,
                    }
                    accounts.setdefault(account_id, record)
                    accounts[f"{COLLIN_VARIANT_PREFIX}{key}"] = record

    return accounts


def _address_resolutions(
    connection,
    rows: list[tuple[int, dict[str, str]]],
    default_city: str | None = None,
    default_county: str | None = None,
) -> dict[int, dict[str, Any]]:
    """Resolve only unique exact normalized situs-address matches.

    Address matching is deliberately a fallback. A city is required from the
    row or the import command, and ambiguity leaves the row unresolved for
    manual review rather than guessing.
    """

    requested: list[tuple[int, str, str, str]] = []
    cities: set[str] = set()
    for source_row_number, raw in rows:
        address = _normalize_situs_address(_first_value(raw, ADDRESS_FIELDS))
        city = _normalize_place(_first_value(raw, CITY_FIELDS) or default_city)
        county = _normalize_place(_first_value(raw, COUNTY_FIELDS) or default_county)
        if not address or not city:
            continue
        requested.append((source_row_number, address, city, county))
        cities.add(city)
    if not requested:
        return {}

    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT account_id, county, address, city, postal_code
            FROM core.accounts
            WHERE NULLIF(BTRIM(address), '') IS NOT NULL
              AND UPPER(
                    REGEXP_REPLACE(BTRIM(COALESCE(city, '')), '[^A-Z0-9]+', ' ', 'g')
                  ) = ANY(%s)
            """,
            (list(cities),),
        )
        candidates = cursor.fetchall()

    by_address: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for account_id, county, address, city, postal_code in candidates:
        record = {
            "account_id": account_id,
            "county": county,
            "address": address,
            "city": city,
            "postal_code": postal_code,
        }
        key = (_normalize_place(city), _normalize_situs_address(address))
        by_address.setdefault(key, []).append(record)

    resolutions: dict[int, dict[str, Any]] = {}
    for source_row_number, address, city, county in requested:
        matches = by_address.get((city, address), [])
        if county:
            matches = [
                match
                for match in matches
                if _normalize_place(match.get("county")) in {county, f"{county} COUNTY"}
                or county in {
                    _normalize_place(match.get("county")),
                    f"{_normalize_place(match.get('county'))} COUNTY",
                }
            ]
        unique = {
            match["account_id"]: match
            for match in matches
            if _clean(match.get("account_id"))
        }
        if len(unique) == 1:
            resolutions[source_row_number] = {
                "status": "matched",
                "account": next(iter(unique.values())),
            }
        elif len(unique) > 1:
            resolutions[source_row_number] = {
                "status": "ambiguous",
                "candidate_count": len(unique),
            }
    return resolutions


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
            if candidate not in accounts:
                continue
            account_id = accounts[candidate]["account_id"]
            if account_id not in {item[0] for item in matched}:
                matched.append((account_id, method))

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
    address_resolutions: dict[int, dict[str, Any]] | None = None,
) -> list[PreparedSale]:
    prepared: list[PreparedSale] = []
    address_resolutions = address_resolutions or {}
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

        address_resolution = address_resolutions.get(source_row_number, {})
        if not resolved_accounts and address_resolution.get("status") == "matched":
            address_account = address_resolution["account"]
            primary_account_id = address_account["account_id"]
            resolved_accounts.append(primary_account_id)
            accounts.setdefault(primary_account_id, address_account)
            flags.append("address_fallback_match")
        elif not resolved_accounts and address_resolution.get("status") == "ambiguous":
            flags.append("ambiguous_address_match")

        if not resolved_accounts:
            match_status = "unmatched"
        elif not primary_links and not secondary_links and address_resolution.get("status") == "matched":
            match_status = "address"
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
                source_record_hash=_source_record_hash(raw),
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
        row.primary_account_id for row in prepared if row.primary_account_id
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
    path: Path,
    source_name: str,
    dry_run: bool = False,
    default_city: str | None = None,
    default_county: str | None = None,
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
        address_resolutions = _address_resolutions(
            connection,
            rows,
            default_city=default_city,
            default_county=default_county,
        )
        prepared = _prepare_sales(rows, accounts, address_resolutions)
        existing_hashes = _existing_hashes_by_listing_id(
            connection,
            {
                _clean(row.typed.get("listing_id")).upper()
                for row in prepared
                if _clean(row.typed.get("listing_id"))
            },
        )
        for row in prepared:
            listing_id = _clean(row.typed.get("listing_id")).upper()
            if listing_id in existing_hashes:
                row.source_record_hash = existing_hashes[listing_id]
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
                    bedrooms_total = COALESCE(EXCLUDED.bedrooms_total, core.sales_source_records.bedrooms_total),
                    bathrooms_total_integer = COALESCE(EXCLUDED.bathrooms_total_integer, core.sales_source_records.bathrooms_total_integer),
                    bathrooms_full = COALESCE(EXCLUDED.bathrooms_full, core.sales_source_records.bathrooms_full),
                    bathrooms_half = COALESCE(EXCLUDED.bathrooms_half, core.sales_source_records.bathrooms_half),
                    living_area = COALESCE(EXCLUDED.living_area, core.sales_source_records.living_area),
                    lot_size_area = COALESCE(EXCLUDED.lot_size_area, core.sales_source_records.lot_size_area),
                    current_price = COALESCE(EXCLUDED.current_price, core.sales_source_records.current_price),
                    ratio_current_price_by_living_area = COALESCE(EXCLUDED.ratio_current_price_by_living_area, core.sales_source_records.ratio_current_price_by_living_area),
                    ratio_close_price_by_list_price = COALESCE(EXCLUDED.ratio_close_price_by_list_price, core.sales_source_records.ratio_close_price_by_list_price),
                    ratio_close_price_by_original_list_price = COALESCE(EXCLUDED.ratio_close_price_by_original_list_price, core.sales_source_records.ratio_close_price_by_original_list_price),
                    ratio_close_price_by_living_area = COALESCE(EXCLUDED.ratio_close_price_by_living_area, core.sales_source_records.ratio_close_price_by_living_area),
                    days_on_market = COALESCE(EXCLUDED.days_on_market, core.sales_source_records.days_on_market),
                    year_built = COALESCE(EXCLUDED.year_built, core.sales_source_records.year_built),
                    close_date = COALESCE(EXCLUDED.close_date, core.sales_source_records.close_date),
                    seller_contributions = COALESCE(EXCLUDED.seller_contributions, core.sales_source_records.seller_contributions),
                    mls_status = COALESCE(EXCLUDED.mls_status, core.sales_source_records.mls_status),
                    garage_spaces = COALESCE(EXCLUDED.garage_spaces, core.sales_source_records.garage_spaces),
                    garage_yn = COALESCE(EXCLUDED.garage_yn, core.sales_source_records.garage_yn),
                    pool_yn = COALESCE(EXCLUDED.pool_yn, core.sales_source_records.pool_yn),
                    listing_contract_date = COALESCE(EXCLUDED.listing_contract_date, core.sales_source_records.listing_contract_date),
                    parcel_number_raw = COALESCE(EXCLUDED.parcel_number_raw, core.sales_source_records.parcel_number_raw),
                    parcel_number2_raw = COALESCE(EXCLUDED.parcel_number2_raw, core.sales_source_records.parcel_number2_raw),
                    buyer_financing = COALESCE(EXCLUDED.buyer_financing, core.sales_source_records.buyer_financing),
                    record_type = CASE
                        WHEN EXCLUDED.mls_status IS NULL
                            THEN core.sales_source_records.record_type
                        ELSE EXCLUDED.record_type
                    END,
                    structural_style = COALESCE(EXCLUDED.structural_style, core.sales_source_records.structural_style),
                    housing_type = COALESCE(EXCLUDED.housing_type, core.sales_source_records.housing_type),
                    attachment_type = CASE
                        WHEN EXCLUDED.structural_style IS NULL
                            THEN core.sales_source_records.attachment_type
                        ELSE EXCLUDED.attachment_type
                    END,
                    architectural_style = COALESCE(EXCLUDED.architectural_style, core.sales_source_records.architectural_style),
                    listing_key = COALESCE(
                        NULLIF(EXCLUDED.listing_key, ''),
                        core.sales_source_records.listing_key
                    ),
                    listing_id = COALESCE(
                        NULLIF(EXCLUDED.listing_id, ''),
                        core.sales_source_records.listing_id
                    ),
                    primary_account_id = CASE
                        WHEN core.sales_source_records.match_status = 'manual_verified'
                            THEN core.sales_source_records.primary_account_id
                        WHEN core.sales_source_records.primary_account_id IS NOT NULL
                             AND core.sales_source_records.match_status <> 'unmatched'
                             AND EXCLUDED.match_status IN ('unmatched', 'address')
                            THEN core.sales_source_records.primary_account_id
                        ELSE EXCLUDED.primary_account_id
                    END,
                    match_status = CASE
                        WHEN core.sales_source_records.match_status = 'manual_verified'
                            THEN core.sales_source_records.match_status
                        WHEN core.sales_source_records.primary_account_id IS NOT NULL
                             AND core.sales_source_records.match_status <> 'unmatched'
                             AND EXCLUDED.match_status IN ('unmatched', 'address')
                            THEN core.sales_source_records.match_status
                        ELSE EXCLUDED.match_status
                    END,
                    has_multiple_parcel_numbers = EXCLUDED.has_multiple_parcel_numbers,
                    multi_parcel_status = EXCLUDED.multi_parcel_status,
                    has_unresolved_parcel = CASE
                        WHEN core.sales_source_records.match_status = 'manual_verified'
                            THEN core.sales_source_records.has_unresolved_parcel
                        ELSE EXCLUDED.has_unresolved_parcel
                    END,
                    requires_additional_review = CASE
                        WHEN core.sales_source_records.match_status = 'manual_verified'
                            THEN core.sales_source_records.requires_additional_review
                        ELSE EXCLUDED.requires_additional_review
                    END,
                    data_quality_flags = CASE
                        WHEN core.sales_source_records.match_status = 'manual_verified'
                            THEN core.sales_source_records.data_quality_flags
                        ELSE EXCLUDED.data_quality_flags
                    END,
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
                """
                SELECT id, primary_account_id, match_status
                FROM core.sales_source_records
                WHERE id = ANY(%s)
                """,
                (source_record_ids,),
            )
            stored_matches = {
                record_id: (primary_account_id, match_status)
                for record_id, primary_account_id, match_status in cursor.fetchall()
            }
            prepared_by_record_id = {
                record_ids[row.source_record_hash]: row for row in prepared
            }
            manually_verified_ids = {
                record_id
                for record_id, (_, match_status) in stored_matches.items()
                if match_status == "manual_verified"
            }
            protected_source_record_ids = {
                record_id
                for record_id, (stored_account_id, stored_match_status) in stored_matches.items()
                if record_id in manually_verified_ids
                or stored_account_id
                != prepared_by_record_id[record_id].primary_account_id
                or stored_match_status
                != prepared_by_record_id[record_id].match_status
            }
            replaceable_source_record_ids = [
                source_record_id
                for source_record_id in source_record_ids
                if source_record_id not in protected_source_record_ids
            ]

            if replaceable_source_record_ids:
                cursor.execute(
                    "DELETE FROM core.sale_parcels WHERE source_record_id = ANY(%s)",
                    (replaceable_source_record_ids,),
                )
            parcel_values = []
            for row in prepared:
                source_record_id = record_ids[row.source_record_hash]
                if source_record_id in protected_source_record_ids:
                    continue
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
            if parcel_values:
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
                if record_ids[row.source_record_hash] not in protected_source_record_ids
                and row.primary_account_id
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

            # Every successfully matched Dallas County sale/listing is queued
            # for location processing in the same transaction as the import.
            # The import never waits on DCAD GIS.
            cursor.execute(
                "SELECT to_regclass('core.account_locations') IS NOT NULL"
            )
            locations_available = bool(cursor.fetchone()[0])
            location_join = (
                "LEFT JOIN core.account_locations location "
                "ON location.account_id = account.account_id"
                if locations_available
                else ""
            )
            missing_location = (
                "AND (location.account_id IS NULL "
                "OR location.status <> 'matched' "
                "OR location.latitude IS NULL "
                "OR location.longitude IS NULL)"
                if locations_available
                else ""
            )
            cursor.execute(
                f"""
                WITH candidates AS (
                    SELECT DISTINCT
                        account.account_id,
                        account.address,
                        account.county,
                        CASE
                            WHEN COALESCE(
                                source.close_date,
                                source.listing_contract_date
                            ) >= CURRENT_DATE - interval '1 year' THEN 80
                            ELSE 40
                        END AS priority
                    FROM core.sales_source_records source
                    JOIN core.accounts account
                      ON account.account_id = source.primary_account_id
                    {location_join}
                    WHERE source.id = ANY(%s)
                      AND (
                        account.county IS NULL
                        OR account.county ILIKE '%%dallas%%'
                      )
                      {missing_location}
                ), queued AS (
                    INSERT INTO app.location_backfill_queue (
                        account_id, address, county, priority, status, reason,
                        attempts, next_attempt_at, leased_at, worker_id,
                        last_error, completed_at, updated_at
                    )
                    SELECT
                        account_id, address, county, priority, 'pending',
                        'sales_import', 0, now(), NULL, NULL, NULL, NULL, now()
                    FROM candidates
                    ON CONFLICT (account_id) DO UPDATE SET
                        address = COALESCE(
                            EXCLUDED.address,
                            app.location_backfill_queue.address
                        ),
                        county = COALESCE(
                            EXCLUDED.county,
                            app.location_backfill_queue.county
                        ),
                        priority = GREATEST(
                            app.location_backfill_queue.priority,
                            EXCLUDED.priority
                        ),
                        status = CASE
                            WHEN app.location_backfill_queue.status IN (
                                'processing', 'manual_review'
                            ) THEN app.location_backfill_queue.status
                            ELSE 'pending'
                        END,
                        reason = EXCLUDED.reason,
                        next_attempt_at = CASE
                            WHEN app.location_backfill_queue.status IN (
                                'processing', 'manual_review'
                            ) THEN app.location_backfill_queue.next_attempt_at
                            ELSE now()
                        END,
                        leased_at = CASE
                            WHEN app.location_backfill_queue.status = 'processing'
                                THEN app.location_backfill_queue.leased_at
                            ELSE NULL
                        END,
                        worker_id = CASE
                            WHEN app.location_backfill_queue.status = 'processing'
                                THEN app.location_backfill_queue.worker_id
                            ELSE NULL
                        END,
                        completed_at = CASE
                            WHEN app.location_backfill_queue.status = 'manual_review'
                                THEN app.location_backfill_queue.completed_at
                            ELSE NULL
                        END,
                        updated_at = now()
                    RETURNING account_id
                )
                SELECT COUNT(*)::integer FROM queued
                """,
                (source_record_ids,),
            )
            result["location_backfill_queued"] = int(cursor.fetchone()[0])

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
    parser.add_argument(
        "--default-city",
        help="City used for exact address fallback when the CSV omits a city column",
    )
    parser.add_argument(
        "--default-county",
        help="County used to constrain exact address fallback matches",
    )
    args = parser.parse_args()
    result = import_sales(
        args.csv_path.resolve(),
        args.source_name.strip(),
        dry_run=args.dry_run,
        default_city=args.default_city,
        default_county=args.default_county,
    )
    print(json.dumps(result, indent=2, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
