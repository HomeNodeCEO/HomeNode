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
        r÷ox¶‰Ëkºwµç@€€€€€ÕÉÍ½È¹•á•ÕÑ” (€€€€€€€€€€€€€€€€ˆˆˆ(€€€€€€€€€€€€€€€M1P¥°ÁÉ¥µ…Éå}…½Õ¹Ñ}¥°µ…Ñ¡}ÍÑ…ÑÕÌ(€€€€€€€€€€€€€€€I=4½É”¹Í…±•Í}Í½ÕÉ•}É•½É‘Ì(€€€€€€€€€€€€€€€]!I¥€ô9d •Ì¤(€€€€€€€€€€€€€€€€ˆˆˆ°(€€€€€€€€€€€€€€€€¡Í½ÕÉ•}É•½É‘}¥‘Ì°¤°(€€€€€€€€€€€€¤(€€€€€€€€€€€ÍÑ½É•‘}µ…Ñ¡•Ì€ôì(€€€€€€€€€€€€€€€É•½É‘}¥è€¡ÁÉ¥µ…Éå}…½Õ¹Ñ}¥°µ…Ñ¡}ÍÑ…ÑÕÌ¤(€€€€€€€€€€€€€€€™½ÈÉ•½É‘}¥°ÁÉ¥µ…Éå}…½Õ¹Ñ}¥°µ…Ñ¡}ÍÑ…ÑÕÌ¥¸ÕÉÍ½È¹™•Ñ¡…±° ¤(€€€€€€€€€€€ô(€€€€€€€€€€€ÁÉ•Á…É•‘}‰å}É•½É‘}¥€ôì(€€€€€€€€€€€€€€€É•½É‘}¥‘ÍmÉ½Ü¹Í½ÕÉ•}É•½É‘}¡…Í¡tèÉ½Ü™½ÈÉ½Ü¥¸ÁÉ•Á…É•(€€€€€€€€€€€ô(€€€€€€€€€€€µ…¹Õ…±±å}Ù•É¥™¥•‘}¥‘Ì€ôì(€€€€€€€€€€€€€€€É•½É‘}¥(€€€€€€€€€€€€€€€™½ÈÉ•½É‘}¥°€¡|°µ…Ñ¡}ÍÑ…ÑÕÌ¤¥¸ÍÑ½É•‘}µ…Ñ¡•Ì¹¥Ñ•µÌ ¤(€€€€€€€€€€€€€€€¥˜µ…Ñ¡}ÍÑ…ÑÕÌ€ôô€‰µ…¹Õ…±}Ù•É¥™¥•ˆ(€€€€€€€€€€€ô(€€€€€€€€€€€ÁÉ½Ñ•Ñ•‘}Í½ÕÉ•}É•½É‘}¥‘Ì€ôì(€€€€€€€€€€€€€€€É•½É‘}¥(€€€€€€€€€€€€€€€™½ÈÉ•½É‘}¥°€¡ÍÑ½É•‘}…½Õ¹Ñ}¥°ÍÑ½É•‘}µ…Ñ¡}ÍÑ…ÑÕÌ¤¥¸ÍÑ½É•‘}µ…Ñ¡•Ì¹¥Ñ•µÌ ¤(€€€€€€€€€€€€€€€¥˜É•½É‘}¥¥¸µ…¹Õ…±±å}Ù•É¥™¥•‘}¥‘Ì(€€€€€€€€€€€€€€€½ÈÍÑ½É•‘}…½Õ¹Ñ}¥(€€€€€€€€€€€€€€€€„ôÁÉ•Á…É•‘}‰å}É•½É‘}¥‘mÉ•½É‘}¥‘t¹ÁÉ¥µ…Éå}…½Õ¹Ñ}¥(€€€€€€€€€€€€€€€½ÈÍÑ½É•‘}µ…Ñ¡}ÍÑ…ÑÕÌ(€€€€€€€€€€€€€€€€„ôÁÉ•Á…É•‘}‰å}É•½É‘}¥‘mÉ•½É‘}¥‘t¹µ…Ñ¡}ÍÑ…ÑÕÌ(€€€€€€€€€€€ô(€€€€€€€€€€€É•Á±…•…‰±•}Í½ÕÉ•}É•½É‘}¥‘Ì€ôl(€€€€€€€€€€€€€€€Í½ÕÉ•}É•½É‘}¥(€€€€€€€€€€€€€€€™½ÈÍ½ÕÉ•}É•½É‘}¥¥¸Í½ÕÉ•}É•½É‘}¥‘Ì(€€€€€€€€€€€€€€€¥˜Í½ÕÉ•}É•½É‘}¥¹½Ğ¥¸ÁÉ½Ñ•Ñ•‘}Í½ÕÉ•}É•½É‘}¥‘Ì(€€€€€€€€€€€t((€€€€€€€€€€€¥˜É•Á±…•…‰±•}Í½ÕÉ•}É•½É‘}¥‘Ìè(€€€€€€€€€€€€€€€ÕÉÍ½È¹•á•ÕÑ” (€€€€€€€€€€€€€€€€€€€€‰1QI=4½É”¹Í…±•}Á…É•±Ì]!IÍ½ÕÉ•}É•½É‘}¥€ô9d •Ì¤ˆ°(€€€€€€€€€€€€€€€€€€€€¡É•Á±…•…‰±•}Í½ÕÉ•}É•½É‘}¥‘Ì°¤°(€€€€€€€€€€€€€€€€¤(€€€€€€€€€€€Á…É•±}Ù…±Õ•Ì€ômt(€€€€€€€€€€€™½ÈÉ½Ü¥¸ÁÉ•Á…É•è(€€€€€€€€€€€€€€€Í½ÕÉ•}É•½É‘}¥€ôÉ•½É‘}¥‘ÍmÉ½Ü¹Í½ÕÉ•}É•½É‘}¡…Í¡t(€€€€€€€€€€€€€€€¥˜Í½ÕÉ•}É•½É‘}¥¥¸ÁÉ½Ñ•Ñ•‘}Í½ÕÉ•}É•½É‘}¥‘Ìè(€€€€€€€€€€€€€€€€€€€½¹Ñ¥¹Õ”(€€€€€€€€€€€€€€€™½È±¥¹¬¥¸É½Ü¹Á…É•±}±¥¹­Ìè(€€€€€€€€€€€€€€€€€€€Á…É•±}Ù…±Õ•Ì¹…ÁÁ•¹ (€€€€€€€€€€€€€€€€€€€€€€€€ (€€€€€€€€€€€€€€€€€€€€€€€€€€€Í½ÕÉ•}É•½É‘}¥°(€€€€€€€€€€€€€€€€€€€€€€€€€€€±¥¹¬¹Í½ÕÉ•}Á½Í¥Ñ¥½¸°(€€€€€€€€€€€€€€€€€€€€€€€€€€€±¥¹¬¹Á…É•±}Í•ÅÕ•¹”°(€€€€€€€€€€€€€€€€€€€€€€€€€€€±¥¹¬¹Á…É•±}É½±”°(€€€€€€€€€€€€€€€€€€€€€€€€€€€±¥¹¬¹Á…É•±}¹Õµ‰•É}É…Ü°(€€€€€€€€€€€€€€€€€€€€€€€€€€€±¥¹¬¹Á…É•±}¹Õµ‰•É}¹½Éµ…±¥é•°(€€€€€€€€€€€€€€€€€€€€€€€€€€€±¥¹¬¹…½Õ¹Ñ}¥°(€€€€€€€€€€€€€€€€€€€€€€€€€€€±¥¹¬¹µ…Ñ¡}µ•Ñ¡½°(€€€€€€€€€€€€€€€€€€€€€€€€€€€‰½½°¡±¥¹¬¹…½Õ¹Ñ}¥¤°(€€€€€€€€€€€€€€€€€€€€€€€€¤(€€€€€€€€€€€€€€€€€€€€¤(€€€€€€€€€€€¥˜Á…É•±}Ù…±Õ•Ìè(€€€€€€€€€€€€€€€•á•ÕÑ•}Ù…±Õ•Ì (€€€€€€€€€€€€€€€€€€€ÕÉÍ½È°(€€€€€€€€€€€€€€€€€€€€ˆˆˆ(€€€€€€€€€€€€€€€€€€€%9MIP%9Q<½É”¹Í…±•}Á…É•±Ì€ (€€€€€€€€€€€€€€€€€€€€€€€Í½ÕÉ•}É•½É‘}¥°Í½ÕÉ•}Á½Í¥Ñ¥½¸°Á…É•±}Í•ÅÕ•¹”°(€€€€€€€€€€€€€€€€€€€€€€€Á…É•±}É½±”°Á…É•±}¹Õµ‰•É}É…Ü°Á…É•±}¹Õµ‰•É}¹½Éµ…±¥é•°(€€€€€€€€€€€€€€€€€€€€€€€…½Õ¹Ñ}¥°µ…Ñ¡}µ•Ñ¡½°¥Í}É•Í½±Ù•(€€€€€€€€€€€€€€€€€€€€¤Y1UL€•Ì(€€€€€€€€€€€€€€€€€€€€ˆˆˆ°(€€€€€€€€€€€€€€€€€€€Á…É•±}Ù…±Õ•Ì°(€€€€€€€€€€€€€€€€€€€Á…•}Í¥é”ôÄÀÀÀ°(€€€€€€€€€€€€€€€€¤((€€€€€€€€€€€µ…Ñ¡•‘}É½İÌ€ôl(€€€€€€€€€€€€€€€É½Ü(€€€€€€€€€€€€€€€™½ÈÉ½Ü¥¸ÁÉ•Á…É•(€€€€€€€€€€€€€€€¥˜É•½É‘}¥‘ÍmÉ½Ü¹Í½ÕÉ•}É•½É‘}¡…Í¡t¹½Ğ¥¸ÁÉ½Ñ•Ñ•‘}Í½ÕÉ•}É•½É‘}¥‘Ì(€€€€€€€€€€€€€€€…¹É½Ü¹ÁÉ¥µ…Éå}…½Õ¹Ñ}¥(€€€€€€€€€€€€€€€…¹É½Ü¹ÑåÁ•‘l‰É•½É‘}ÑåÁ”‰t€ôô€‰±½Í•‘}Í…±”ˆ(€€€€€€€€€€€€€€€…¹É½Ü¹ÑåÁ•‘l‰±½Í•}‘…Ñ”‰t¥Ì¹½Ğ9½¹”(€€€€€€€€€€€€€€€…¹É½Ü¹ÑåÁ•‘l‰ÕÉÉ•¹Ñ}ÁÉ¥”‰t¥Ì¹½Ğ9½¹”(€€€€€€€€€€€€€€€…¹É½Ü¹ÑåÁ•‘l‰ÕÉÉ•¹Ñ}ÁÉ¥”‰t€ø€À(€€€€€€€€€€€t(€€€€€€€€€€€…½Õ¹Ñ}¥‘Ì€ô±¥ÍĞ¡íÉ½Ü¹ÁÉ¥µ…Éå}…½Õ¹Ñ}¥™½ÈÉ½Ü¥¸µ…Ñ¡•‘}É½İÍô¤(€€€€€€€€€€€•á¥ÍÑ¥¹}‰å}­•äè‘¥ÑmÑÕÁ±•mÍÑÈ°‘…Ñ”ğ9½¹”°•¥µ…°ğ9½¹•t°±¥ÍÑmÑÕÁ±•m¥¹Ğ°¥¹Ğğ9½¹•uut€ôíô(€€€€€€€€€€€¥˜…½Õ¹Ñ}¥‘Ìè(€€€€€€€€€€€€€€€ÕÉÍ½È¹•á•ÕÑ” (€€€€€€€€€€€€€€€€€€€€ˆˆˆ(€€€€€€€€€€€€€€€€€€€M1P¥°…½Õ¹Ñ}¥°±½Í¥¹}‘…Ñ”°Í…±•}ÁÉ¥”°Í½ÕÉ•}É•½É‘}¥(€€€€€€€€€€€€€€€€€€€I=4½É”¹Í…±•Ì(€€€€€€€€€€€€€€€€€€€]!I…½Õ¹Ñ}¥€ô9d •Ì¤(€€€€€€€€€€€€€€€€€€€€ˆˆˆ°(€€€€€€€€€€€€€€€€€€€€¡…½Õ¹Ñ}¥‘Ì°¤°(€€€€€€€€€€€€€€€€¤(€€€€€€€€€€€€€€€™½ÈÍ…±•}¥°…½Õ¹Ñ}¥°±½Í¥¹}‘…Ñ”°Í…±•}ÁÉ¥”°Í½ÕÉ•}É•½É‘}¥¥¸ÕÉÍ½È¹™•Ñ¡…±° ¤è(€€€€€€€€€€€€€€€€€€€­•ä€ô€ (€€€€€€€€€€€€€€€€€€€€€€€…½Õ¹Ñ}¥°(€€€€€€€€€€€€€€€€€€€€€€€±½Í¥¹}‘…Ñ”°(€€€€€€€€€€€€€€€€€€€€€€€•¥µ…°¡Í…±•}ÁÉ¥”¤¥˜Í…±•}ÁÉ¥”¥Ì¹½Ğ9½¹”•±Í”9½¹”°(€€€€€€€€€€€€€€€€€€€€¤(€€€€€€€€€€€€€€€€€€€•á¥ÍÑ¥¹}‰å}­•ä¹Í•Ñ‘•™…Õ±Ğ¡­•ä°mt¤¹…ÁÁ•¹ ¡Í…±•}¥°Í½ÕÉ•}É•½É‘}¥¤¤((€€€€€€€€€€€…ÑÑ…¡}ÕÁ‘…Ñ•Ì€ômt(€€€€€€€€€€€Í…±•Í}Ù…±Õ•Ì€ômt(€€€€€€€€€€€•á¥ÍÑ¥¹}Í…±•Í}…ÑÑ…¡•€ô€À(€€€€€€€€€€€•á¥ÍÑ¥¹}Í…±•Í}…±É•…‘å}±¥¹­•€ô€À(€€€€€€€€€€€™½ÈÉ½Ü¥¸µ…Ñ¡•‘}É½İÌè(€€€€€€€€€€€€€€€ÑåÁ•€ôÉ½Ü¹ÑåÁ•(€€€€€€€€€€€€€€€Í½ÕÉ•}É•½É‘}¥€ôÉ•½É‘}¥‘ÍmÉ½Ü¹Í½ÕÉ•}É•½É‘}¡…Í¡t(€€€€€€€€€€€€€€€­•ä€ô€ (€€€€€€€€€€€€€€€€€€€É½Ü¹ÁÉ¥µ…Éå}…½Õ¹Ñ}¥°(€€€€€€€€€€€€€€€€€€€ÑåÁ•‘l‰±½Í•}‘…Ñ”‰t°(€€€€€€€€€€€€€€€€€€€ÑåÁ•‘l‰ÕÉÉ•¹Ñ}ÁÉ¥”‰t°(€€€€€€€€€€€€€€€€¤(€€€€€€€€€€€€€€€•á¥ÍÑ¥¹œ€ô•á¥ÍÑ¥¹}‰å}­•ä¹•Ğ¡­•ä°mt¤(€€€€€€€€€€€€€€€Í…µ•}±¥¹¬€ôm¥Ñ•´™½È¥Ñ•´¥¸•á¥ÍÑ¥¹œ¥˜¥Ñ•µlÅt€ôôÍ½ÕÉ•}É•½É‘}¥‘t(€€€€€€€€€€€€€€€…ÑÑ…¡…‰±”€ôm¥Ñ•´™½È¥Ñ•´¥¸•á¥ÍÑ¥¹œ¥˜¥Ñ•µlÅt¥Ì9½¹•t(€€€€€€€€€€€€€€€¥˜Í…µ•}±¥¹¬è(€€€€€€€€€€€€€€€€€€€•á¥ÍÑ¥¹}Í…±•Í}…±É•…‘å}±¥¹­•€¬ô€Ä(€€€€€€€€€€€€€€€€€€€½¹Ñ¥¹Õ”(€€€€€€€€€€€€€€€¥˜±•¸¡•á¥ÍÑ¥¹œ¤€ôô€Ä…¹±•¸¡…ÑÑ…¡…‰±”¤€ôô€Äè(€€€€€€€€€€€€€€€€€€€Í…±•}¥€ô…ÑÑ…¡…‰±•lÁulÁt(€€€€€€€€€€€€€€€€€€€…ÑÑ…¡}ÕÁ‘…Ñ•Ì¹…ÁÁ•¹ ¡Í½ÕÉ•}É•½É‘}¥°Í…±•}¥¤¤(€€€€€€€€€€€€€€€€€€€•á¥ÍÑ¥¹}Í…±•Í}…ÑÑ…¡•€¬ô€Ä(€€€€€€€€€€€€€€€€€€€½¹Ñ¥¹Õ”((€€€€€€€€€€€€€€€Í…±•Í}Ù…±Õ•Ì¹…ÁÁ•¹ (€€€€€€€€€€€€€€€€€€€€ (€€€€€€€€€€€€€€€€€€€€€€€É½Ü¹ÁÉ¥µ…Éå}…½Õ¹Ñ}¥°(€€€€€€€€€€€€€€€€€€€€€€€…½Õ¹ÑÍmÉ½Ü¹ÁÉ¥µ…Éå}…½Õ¹Ñ}¥‘ul‰…‘‘É•ÍÌ‰t°(€€€€€€€€€€€€€€€€€€€€€€€ÑåÁ•‘l‰±½Í•}‘…Ñ”‰t°(€€€€€€€€€€€€€€€€€€€€€€€ÑåÁ•‘l‰ÕÉÉ•¹Ñ}ÁÉ¥”‰t°(€€€€€€€€€€€€€€€€€€€€€€€ÑåÁ•‘l‰‘…åÍ}½¹}µ…É­•Ğ‰t°(€€€€€€€€€€€€€€€€€€€€€€€ÍÑÈ¡ÑåÁ•‘l‰Í•±±•É}½¹ÑÉ¥‰ÕÑ¥½¹Ì‰t¤(€€€€€€€€€€€€€€€€€€€€€€€¥˜ÑåÁ•‘l‰Í•±±•É}½¹ÑÉ¥‰ÕÑ¥½¹Ì‰t¥Ì¹½Ğ9½¹”(€€€€€€€€€€€€€€€€€€€€€€€•±Í”9½¹”°(€€€€€€€€€€€€€€€€€€€€€€€Í½ÕÉ•}¹…µ”°(€€€€€€€€€€€€€€€€€€€€€€€Í½ÕÉ•}É•½É‘}¥°(€€€€€€€€€€€€€€€€€€€€¤(€€€€€€€€€€€€€€€€¤((€€€€€€€€€€€¥˜…ÑÑ…¡}ÕÁ‘…Ñ•Ìè(€€€€€€€€€€€€€€€•á•ÕÑ•}‰…Ñ  (€€€€€€€€€€€€€€€€€€€ÕÉÍ½È°(€€€€€€€€€€€€€€€€€€€€ˆˆˆ(€€€€€€€€€€€€€€€€€€€UAQ½É”¹Í…±•Ì(€€€€€€€€€€€€€€€€€€€MPÍ½ÕÉ•}É•½É‘}¥€ô€•Ì(€€€€€€€€€€€€€€€€€€€]!I¥€ô€•Ì9Í½ÕÉ•}É•½É‘}¥%L9U10(€€€€€€€€€€€€€€€€€€€€ˆˆˆ°(€€€€€€€€€€€€€€€€€€€…ÑÑ…¡}ÕÁ‘…Ñ•Ì°(€€€€€€€€€€€€€€€€€€€Á…•}Í¥é”ôÔÀÀ°(€€€€€€€€€€€€€€€€¤((€€€€€€€€€€€¥˜Í…±•Í}Ù…±Õ•Ìè(€€€€€€€€€€€€€€€•á•ÕÑ•}Ù…±Õ•Ì (€€€€€€€€€€€€€€€€€€€ÕÉÍ½È°(€€€€€€€€€€€€€€€€€€€€ˆˆˆ(€€€€€€€€€€€€€€€€€€€%9MIP%9Q<½É”¹Í…±•Ì€ (€€€€€€€€€€€€€€€€€€€€€€€…½Õ¹Ñ}¥°…‘‘É•ÍÌ°±½Í¥¹}‘…Ñ”°Í…±•}ÁÉ¥”°(€€€€€€€€€€€€€€€€€€€€€€€‘…åÍ}½¹}µ…É­•Ğ°½¹•ÍÍ¥½¹Ì°Í½ÕÉ”°Í½ÕÉ•}É•½É‘}¥(€€€€€€€€€€€€€€€€€€€€¤Y1UL€•Ì(€€€€€€€€€€€€€€€€€€€=8=91%P€¡Í½ÕÉ•}É•½É‘}¥¤(€€€€€€€€€€€€€€€€€€€€€€€]!IÍ½ÕÉ•}É•½É‘}¥%L9=P9U10(€€€€€€€€€€€€€€€€€€€<UAQMP(€€€€€€€€€€€€€€€€€€€€€€€…½Õ¹Ñ}¥€ôa1U¹…½Õ¹Ñ}¥°(€€€€€€€€€€€€€€€€€€€€€€€…‘‘É•ÍÌ€ô=1M¡a1U¹…‘‘É•ÍÌ°½É”¹Í…±•Ì¹…‘‘É•ÍÌ¤°(€€€€€€€€€€€€€€€€€€€€€€€±½Í¥¹}‘…Ñ”€ôa1U¹±½Í¥¹}‘…Ñ”°(€€€€€€€€€€€€€€€€€€€€€€€Í…±•}ÁÉ¥”€ôa1U¹Í…±•}ÁÉ¥”°(€€€€€€€€€€€€€€€€€€€€€€€‘…åÍ}½¹}µ…É­•Ğ€ôa1U¹‘…åÍ}½¹}µ…É­•Ğ°(€€€€€€€€€€€€€€€€€€€€€€€½¹•ÍÍ¥½¹Ì€ôa1U¹½¹•ÍÍ¥½¹Ì°(€€€€€€€€€€€€€€€€€€€€€€€Í½ÕÉ”€ôa1U¹Í½ÕÉ”°(€€€€€€€€€€€€€€€€€€€€€€€±½…‘•‘}…Ğ€ô¹½Ü ¤(€€€€€€€€€€€€€€€€€€€€ˆˆˆ°(€€€€€€€€€€€€€€€€€€€Í…±•Í}Ù…±Õ•Ì°(€€€€€€€€€€€€€€€€€€€Á…•}Í¥é”ôÔÀÀ°(€€€€€€€€€€€€€€€€¤((€€€€€€€€€€€É•ÍÕ±Ğ¹ÕÁ‘…Ñ” (€€€€€€€€€€€€€€€ì(€€€€€€€€€€€€€€€€€€€€‰Í½ÕÉ•}É•½É‘Í}ÕÁÍ•ÉÑ•ˆè±•¸¡É•½É‘}¥‘Ì¤°(€€€€€€€€€€€€€€€€€€€€‰…¹½¹¥…±}Í…±•Í}ÍÕ‰µ¥ÑÑ•ˆè±•¸¡Í…±•Í}Ù…±Õ•Ì¤°(€€€€€€€€€€€€€€€€€€€€‰±¥ÍÑ¥¹Í}ÁÉ•Í•ÉÙ•ˆèÍÕ´ (€€€€€€€€€€€€€€€€€€€€€€€€Ä(€€€€€€€€€€€€€€€€€€€€€€€™½ÈÉ½Ü¥¸ÁÉ•Á…É•(€€€€€€€€€€€€€€€€€€€€€€€¥˜É½Ü¹ÑåÁ•‘l‰É•½É‘}ÑåÁ”‰t€ôô€‰±¥ÍÑ¥¹œˆ(€€€€€€€€€€€€€€€€€€€€¤°(€€€€€€€€€€€€€€€€€€€€‰±½Í•‘}É½İÍ}¹½Ñ}…¹½¹¥…±¥é•ˆèÍÕ´ (€€€€€€€€€€€€€€€€€€€€€€€€Ä(€€€€€€€€€€€€€€€€€€€€€€€™½ÈÉ½Ü¥¸ÁÉ•Á…É•(€€€€€€€€€€€€€€€€€€€€€€€¥˜É½Ü¹ÑåÁ•‘l‰É•½É‘}ÑåÁ”‰t€ôô€‰±½Í•‘}Í…±”ˆ(€€€€€€€€€€€€€€€€€€€€€€€…¹É½Ü¹½Ğ¥¸µ…Ñ¡•‘}É½İÌ(€€€€€€€€€€€€€€€€€€€€¤°(€€€€€€€€€€€€€€€€€€€€‰•á¥ÍÑ¥¹}Í…±•Í}…ÑÑ…¡•ˆè•á¥ÍÑ¥¹}Í…±•Í}…ÑÑ…¡•°(€€€€€€€€€€€€€€€€€€€€‰•á¥ÍÑ¥¹}Í…±•Í}…±É•…‘å}±¥¹­•ˆè•á¥ÍÑ¥¹}Í…±•Í}…±É•…‘å}±¥¹­•°(€€€€€€€€€€€€€€€ô(€€€€€€€€€€€€¤((€€€€€€€€€€€€ŒÙ•ÉäÍÕ•ÍÍ™Õ±±äµ…Ñ¡•…±±…Ì½Õ¹ÑäÍ…±”½±¥ÍÑ¥¹œ¥ÌÅÕ•Õ•(€€€€€€€€€€€€Œ™½È±½…Ñ¥½¸ÁÉ½•ÍÍ¥¹œ¥¸Ñ¡”Í…µ”ÑÉ…¹Í…Ñ¥½¸…ÌÑ¡”¥µÁ½ÉĞ¸(€€€€€€€€€€€€ŒQ¡¥Ì­••ÁÌMX¥µÁ½ÉÑÌ…¹™ÕÑÕÉ”ÁÉ½Ù¥‘•È¥µÁ½ÉÑÌ½¸Ñ¡”Í…µ”(€€€€€€€€€€€€ŒÁ½ÍĞµ¥¹•ÍĞÁ…Ñ İ¥Ñ¡½ÕĞµ…­¥¹œÑ¡”¥µÁ½ÉĞİ…¥Ğ½¸%L¸(€€€€€€€€€€€ÕÉÍ½È¹•á•ÕÑ” (€€€€€€€€€€€€€€€€‰M1PÑ½}É•±…ÍÌ ½É”¹…½Õ¹Ñ}±½…Ñ¥½¹Ìœ¤%L9=P9U10ˆ(€€€€€€€€€€€€¤(€€€€€€€€€€€±½…Ñ¥½¹Í}…Ù…¥±…‰±”€ô‰½½°¡ÕÉÍ½È¹™•Ñ¡½¹” ¥lÁt¤(€€€€€€€€€€€±½…Ñ¥½¹}©½¥¸€ô€ (€€€€€€€€€€€€€€€€‰1P)=%8½É”¹…½Õ¹Ñ}±½…Ñ¥½¹Ì±½…Ñ¥½¸€ˆ(€€€€€€€€€€€€€€€€‰=8±½…Ñ¥½¸¹…½Õ¹Ñ}¥€ô…½Õ¹Ğ¹…½Õ¹Ñ}¥ˆ(€€€€€€€€€€€€€€€¥˜±½…Ñ¥½¹Í}…Ù…¥±…‰±”(€€€€€€€€€€€€€€€•±Í”€ˆˆ(€€€€€€€€€€€€¤(€€€€€€€€€€€µ¥ÍÍ¥¹}±½…Ñ¥½¸€ô€ (€€€€€€€€€€€€€€€€‰9€¡±½…Ñ¥½¸¹…½Õ¹Ñ}¥%L9U10€ˆ(€€€€€€€€€€€€€€€€‰=H±½…Ñ¥½¸¹ÍÑ…ÑÕÌ€ğø€µ…Ñ¡•œ€ˆ(€€€€€€€€€€€€€€€€‰=H±½…Ñ¥½¸¹±…Ñ¥ÑÕ‘”%L9U10€ˆ(€€€€€€€€€€€€€€€€‰=H±½…Ñ¥½¸¹±½¹¥ÑÕ‘”%L9U10¤ˆ(€€€€€€€€€€€€€€€¥˜±½…Ñ¥½¹Í}…Ù…¥±…‰±”(€€€€€€€€€€€€€€€•±Í”€ˆˆ(€€€€€€€€€€€€¤(€€€€€€€€€€€ÕÉÍ½È¹•á•ÕÑ” (€€€€€€€€€€€€€€€˜ˆˆˆ(€€€€€€€€€€€€€€€]%Q …¹‘¥‘…Ñ•ÌL€ (€€€€€€€€€€€€€€€€€€€M1P%MQ%9P(€€€€€€€€€€€€€€€€€€€€€€€…½Õ¹Ğ¹…½Õ¹Ñ}¥°(€€€€€€€€€€€€€€€€€€€€€€€…½Õ¹Ğ¹…‘‘É•ÍÌ°(€€€€€€€€€€€€€€€€€€€€€€€…½Õ¹Ğ¹½Õ¹Ñä°(€€€€€€€€€€€€€€€€€€€€€€€M(€€€€€€€€€€€€€€€€€€€€€€€€€€€]!8=1M (€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€Í½ÕÉ”¹±½Í•}‘…Ñ”°(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€Í½ÕÉ”¹±¥ÍÑ¥¹}½¹ÑÉ…Ñ}‘…Ñ”(€€€€€€€€€€€€€€€€€€€€€€€€€€€€¤€øôUII9Q}Q€´¥¹Ñ•ÉÙ…°€œÄå•…ÈœQ!8€àÀ(€€€€€€€€€€€€€€€€€€€€€€€€€€€1M€ĞÀ(€€€€€€€€€€€€€€€€€€€€€€€9LÁÉ¥½É¥Ñä(€€€€€€€€€€€€€€€€€€€I=4½É”¹Í…±•Í}Í½ÕÉ•}É•½É‘ÌÍ½ÕÉ”(€€€€€€€€€€€€€€€€€€€)=%8½É”¹…½Õ¹ÑÌ…½Õ¹Ğ(€€€€€€€€€€€€€€€€€€€€€=8…½Õ¹Ğ¹…½Õ¹Ñ}¥€ôÍ½ÕÉ”¹ÁÉ¥µ…Éå}…½Õ¹Ñ}¥(€€€€€€€€€€€€€€€€€€€í±½…Ñ¥½¹}©½¥¹ô(€€€€€€€€€€€€€€€€€€€]!IÍ½ÕÉ”¹¥€ô9d •Ì¤(€€€€€€€€€€€€€€€€€€€€€9€ (€€€€€€€€€€€€€€€€€€€€€€€…½Õ¹Ğ¹½Õ¹Ñä%L9U10(€€€€€€€€€€€€€€€€€€€€€€€=H…½Õ¹Ğ¹½Õ¹Ñä%1%-€œ”•‘…±±…Ì””œ(€€€€€€€€€€€€€€€€€€€€€€¤(€€€€€€€€€€€€€€€€€€€€€íµ¥ÍÍ¥¹}±½…Ñ¥½¹ô(€€€€€€€€€€€€€€€€¤°ÅÕ•Õ•L€ (€€€€€€€€€€€€€€€€€€€%9MIP%9Q<…ÁÀ¹±½…Ñ¥½¹}‰…­™¥±±}ÅÕ•Õ”€ (€€€€€€€€€€€€€€€€€€€€€€€…½Õ¹Ñ}¥°…‘‘É•ÍÌ°½Õ¹Ñä°ÁÉ¥½É¥Ñä°ÍÑ…ÑÕÌ°É•…Í½¸°(€€€€€€€€€€€€€€€€€€€€€€€…ÑÑ•µÁÑÌ°¹•áÑ}…ÑÑ•µÁÑ}…Ğ°±•…Í•‘}…Ğ°İ½É­•É}¥°(€€€€€€€€€€€€€€€€€€€€€€€±…ÍÑ}•ÉÉ½È°½µÁ±•Ñ•‘}…Ğ°ÕÁ‘…Ñ•‘}…Ğ(€€€€€€€€€€€€€€€€€€€€¤(€€€€€€€€€€€€€€€€€€€M1P(€€€€€€€€€€€€€€€€€€€€€€€…½Õ¹Ñ}¥°(€€€€€€€€€€€€€€€€€€€€€€€…‘‘É•ÍÌ°(€€€€€€€€€€€€€€€€€€€€€€€½Õ¹Ñä°(€€€€€€€€€€€€€€€€€€€€€€€ÁÉ¥½É¥Ñä°(€€€€€€€€€€€€€€€€€€€€€€€€Á•¹‘¥¹œœ°(€€€€€€€€€€€€€€€€€€€€€€€€Í…±•Í}¥µÁ½ÉĞœ°(€€€€€€€€€€€€€€€€€€€€€€€€À°(€€€€€€€€€€€€€€€€€€€€€€€¹½Ü ¤°(€€€€€€€€€€€€€€€€€€€€€€€9U10°(€€€€€€€€€€€€€€€€€€€€€€€9U10°(€€€€€€€€€€€€€€€€€€€€€€€9U10°(€€€€€€€€€€€€€€€€€€€€€€€9U10°(€€€€€€€€€€€€€€€€€€€€€€€¹½Ü ¤(€€€€€€€€€€€€€€€€€€€I=4…¹‘¥‘…Ñ•Ì(€€€€€€€€€€€€€€€€€€€=8=91%P€¡…½Õ¹Ñ}¥¤<UAQMP(€€€€€€€€€€€€€€€€€€€€€€€…‘‘É•ÍÌ€ô=1M (€€€€€€€€€€€€€€€€€€€€€€€€€€€a1U¹…‘‘É•ÍÌ°(€€€€€€€€€€€€€€€€€€€€€€€€€€€…ÁÀ¹±½…Ñ¥½¹}‰…­™¥±±}ÅÕ•Õ”¹…‘‘É•ÍÌ(€€€€€€€€€€€€€€€€€€€€€€€€¤°(€€€€€€€€€€€€€€€€€€€€€€€½Õ¹Ñä€ô=1M (€€€€€€€€€€€€€€€€€€€€€€€€€€€a1U¹½Õ¹Ñä°(€€€€€€€€€€€€€€€€€€€€€€€€€€€…ÁÀ¹±½…Ñ¥½¹}‰…­™¥±±}ÅÕ•Õ”¹½Õ¹Ñä(€€€€€€€€€€€€€€€€€€€€€€€€¤°(€€€€€€€€€€€€€€€€€€€€€€€ÁÉ¥½É¥Ñä€ôIQMP (€€€€€€€€€€€€€€€€€€€€€€€€€€€…ÁÀ¹±½…Ñ¥½¹}‰…­™¥±±}ÅÕ•Õ”¹ÁÉ¥½É¥Ñä°(€€€€€€€€€€€€€€€€€€€€€€€€€€€a1U¹ÁÉ¥½É¥Ñä(€€€€€€€€€€€€€€€€€€€€€€€€¤°(€€€€€€€€€€€€€€€€€€€€€€€ÍÑ…ÑÕÌ€ôM(€€€€€€€€€€€€€€€€€€€€€€€€€€€]!8…ÁÀ¹±½…Ñ¥½¹}‰…­™¥±±}ÅÕ•Õ”¹ÍÑ…ÑÕÌ%8€ (€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ÁÉ½•ÍÍ¥¹œœ°€µ…¹Õ…±}É•Ù¥•Üœ(€€€€€€€€€€€€€€€€€€€€€€€€€€€€¤Q!8…ÁÀ¹±½…Ñ¥½¹}‰…­™¥±±}ÅÕ•Õ”¹ÍÑ…ÑÕÌ(€€€€€€€€€€€€€€€€€€€€€€€€€€€1M€Á•¹‘¥¹œœ(€€€€€€€€€€€€€€€€€€€€€€€9°(€€€€€€€€€€€€€€€€€€€€€€€É•…Í½¸€ôa1U¹É•…Í½¸°(€€€€€€€€€€€€€€€€€€€€€€€¹•áÑ}…ÑÑ•µÁÑ}…Ğ€ôM(€€€€€€€€€€€€€€€€€€€€€€€€€€€]!8…ÁÀ¹±½…Ñ¥½¹}‰…­™¥±±}ÅÕ•Õ”¹ÍÑ…ÑÕÌ%8€ (€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ÁÉ½•ÍÍ¥¹œœ°€µ…¹Õ…±}É•Ù¥•Üœ(€€€€€€€€€€€€€€€€€€€€€€€€€€€€¤Q!8…ÁÀ¹±½…Ñ¥½¹}‰…­™¥±±}ÅÕ•Õ”¹¹•áÑ}…ÑÑ•µÁÑ}…Ğ(€€€€€€€€€€€€€€€€€€€€€€€€€€€1M¹½Ü ¤(€€€€€€€€€€€€€€€€€€€€€€€9°(€€€€€€€€€€€€€€€€€€€€€€€±•…Í•‘}…Ğ€ôM(€€€€€€€€€€€€€€€€€€€€€€€€€€€]!8…ÁÀ¹±½…Ñ¥½¹}‰…­™¥±±}ÅÕ•Õ”¹ÍÑ…ÑÕÌ€ô€ÁÉ½•ÍÍ¥¹œœ(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€Q!8…ÁÀ¹±½…Ñ¥½¹}‰…­™¥±±}ÅÕ•Õ”¹±•…Í•‘}…Ğ(€€€€€€€€€€€€€€€€€€€€€€€€€€€1M9U10(€€€€€€€€€€€€€€€€€€€€€€€9°(€€€€€€€€€€€€€€€€€€€€€€€İ½É­•É}¥€ôM(€€€€€€€€€€€€€€€€€€€€€€€€€€€]!8…ÁÀ¹±½…Ñ¥½¹}‰…­™¥±±}ÅÕ•Õ”¹ÍÑ…ÑÕÌ€ô€ÁÉ½•ÍÍ¥¹œœ(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€Q!8…ÁÀ¹±½…Ñ¥½¹}‰…­™¥±±}ÅÕ•Õ”¹İ½É­•É}¥(€€€€€€€€€€€€€€€€€€€€€€€€€€€1M9U10(€€€€€€€€€€€€€€€€€€€€€€€9°(€€€€€€€€€€€€€€€€€€€€€€€½µÁ±•Ñ•‘}…Ğ€ôM(€€€€€€€€€€€€€€€€€€€€€€€€€€€]!8…ÁÀ¹±½…Ñ¥½¹}‰…­™¥±±}ÅÕ•Õ”¹ÍÑ…ÑÕÌ€ô€µ…¹Õ…±}É•Ù¥•Üœ(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€Q!8…ÁÀ¹±½…Ñ¥½¹}‰…­™¥±±}ÅÕ•Õ”¹½µÁ±•Ñ•‘}…Ğ(€€€€€€€€€€€€€€€€€€€€€€€€€€€1M9U10(€€€€€€€€€€€€€€€€€€€€€€€9°(€€€€€€€€€€€€€€€€€€€€€€€ÕÁ‘…Ñ•‘}…Ğ€ô¹½Ü ¤(€€€€€€€€€€€€€€€€€€€IQUI9%9…½Õ¹Ñ}¥(€€€€€€€€€€€€€€€€¤(€€€€€€€€€€€€€€€M1P=U9P ¨¤èé¥¹Ñ••ÈI=4ÅÕ•Õ•(€€€€€€€€€€€€€€€€ˆˆˆ°(€€€€€€€€€€€€€€€€¡Í½ÕÉ•}É•½É‘}¥‘Ì°¤°(€€€€€€€€€€€€¤(€€€€€€€€€€€É•ÍÕ±Ñl‰±½…Ñ¥½¹}‰…­™¥±±}ÅÕ•Õ•‰t€ô¥¹Ğ¡ÕÉÍ½È¹™•Ñ¡½¹” ¥lÁt¤((€€€€€€€½¹¹•Ñ¥½¸¹½µµ¥Ğ ¤(€€€€€€€É•ÑÕÉ¸É•ÍÕ±Ğ(€€€•á•ÁĞá•ÁÑ¥½¸è(€€€€€€€½¹¹•Ñ¥½¸¹É½±±‰…¬ ¤(€€€€€€€É…¥Í”(€€€™¥¹…±±äè(€€€€€€€½¹¹•Ñ¥½¸¹±½Í” ¤(()‘•˜µ…¥¸ ¤€´ø¥¹Ğè(€€€Á…ÉÍ•È€ô…ÉÁ…ÉÍ”¹ÉÕµ•¹ÑA…ÉÍ•È (€€€€€€€‘•ÍÉ¥ÁÑ¥½¸ô‰1½…„Í…±•ÌMXİ¡¥±”ÁÉ•Í•ÉÙ¥¹œÉ…Ü°Õ¹µ…Ñ¡•°…¹µÕ±Ñ¤µÁ…É•°É½İÌˆ(€€€€¤(€€€Á…ÉÍ•È¹…‘‘}…ÉÕµ•¹Ğ ‰ÍÙ}Á…Ñ ˆ°ÑåÁ”õA…Ñ ¤(€€€Á…ÉÍ•È¹…‘‘}…ÉÕµ•¹Ğ (€€€€€€€€ˆ´µÍ½ÕÉ”µ¹…µ”ˆ°(€€€€€€€‘•™…Õ±Ğô‰51LÍ…±•Ì•áÁ½ÉĞˆ°(€€€€€€€¡•±Àô‰!Õµ…¸µÉ•…‘…‰±”Í½ÕÉ”±…‰•°ÍÑ½É•İ¥Ñ Ñ¡”Í…±”É•½É‘Ìˆ°(€€€€¤(€€€Á…ÉÍ•È¹…‘‘}…ÉÕµ•¹Ğ (€€€€€€€€ˆ´µ‘ÉäµÉÕ¸ˆ°(€€€€€€€…Ñ¥½¸ô‰ÍÑ½É•}ÑÉÕ”ˆ°(€€€€€€€¡•±Àô‰¹…±åé”…¹µ…Ñ É½İÌİ¥Ñ¡½ÕĞ¡…¹¥¹œÑ¡”‘…Ñ…‰…Í”ˆ°(€€€€¤(€€€Á…ÉÍ•È¹…‘‘}…ÉÕµ•¹Ğ (€€€€€€€€ˆ´µ‘•™…Õ±Ğµ¥Ñäˆ°(€€€€€€€¡•±Àô‰¥ÑäÕÍ•™½È•á…Ğ…‘‘É•ÍÌ™…±±‰…¬İ¡•¸Ñ¡”MX½µ¥ÑÌ„¥Ñä½±Õµ¸ˆ°(€€€€¤(€€€Á…ÉÍ•È¹…‘‘}…ÉÕµ•¹Ğ (€€€€€€€€ˆ´µ‘•™…Õ±Ğµ½Õ¹Ñäˆ°(€€€€€€€¡•±Àô‰½Õ¹ÑäÕÍ•Ñ¼½¹ÍÑÉ…¥¸•á…Ğ…‘‘É•ÍÌ™…±±‰…¬µ…Ñ¡•Ìˆ°(€€€€¤(€€€…ÉÌ€ôÁ…ÉÍ•È¹Á…ÉÍ•}…ÉÌ ¤(€€€É•ÍÕ±Ğ€ô¥µÁ½ÉÑ}Í…±•Ì (€€€€€€€…ÉÌ¹ÍÙ}Á…Ñ ¹É•Í½±Ù” ¤°(€€€€€€€…ÉÌ¹Í½ÕÉ•}¹…µ”¹ÍÑÉ¥À ¤°(€€€€€€€‘Éå}ÉÕ¸õ…ÉÌ¹‘Éå}ÉÕ¸°(€€€€€€€‘•™…Õ±Ñ}¥Ñäõ…ÉÌ¹‘•™…Õ±Ñ}¥Ñä°(€€€€€€€‘•™…Õ±Ñ}½Õ¹Ñäõ…ÉÌ¹‘•™…Õ±Ñ}½Õ¹Ñä°(€€€€¤(€€€ÁÉ¥¹Ğ¡©Í½¸¹‘ÕµÁÌ¡É•ÍÕ±Ğ°¥¹‘•¹ĞôÈ°‘•™…Õ±ĞõÍÑÈ¤¤(€€€É•ÑÕÉ¸€À(()¥˜}}¹…µ•}|€ôô€‰}}µ…¥¹}|ˆè(€€€É…¥Í”MåÍÑ•µá¥Ğ¡µ…¥¸ ¤¤