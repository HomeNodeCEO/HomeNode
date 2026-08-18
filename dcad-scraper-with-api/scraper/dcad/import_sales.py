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
        flags.append("miss￿��z{-�霪ם￿\ל۝\�ٗܙXۜ�˞YX\�؝Z[
K�ۛܙW٘]HHӐSTБJVӕQQ�ۛܙW٘]Kۜ�K�؛\ל۝\�ٗܙXۜ�˘ۛܙW٘]JK�ٛ\�؛۝�X�][ۜȏHӐSTБJVӕQQ�ٛ\�؛۝�X�][ۜˈۜ�K�؛\ל۝\�ٗܙXۜ�˜ٛ\�؛۝�X�][ۜʋ�[לݘ]\ȏHӐSTБJVӕQQ�[לݘ]\ˈۜ�K�؛\ל۝\�ٗܙXۜ�˛[לݘ]\ʋ�؜�YٗܜXٜȏHӐSTБJVӕQQ�؜�YٗܜXٜˈۜ�K�؛\ל۝\�ٗܙXۜ�˙؜�YٗܜXٜʋ�؜�Yٗޛ�HӐSTБJVӕQQ�؜�Yٗޛ�ۜ�K�؛\ל۝\�ٗܙXۜ�˙؜�Yٗޛ�K�ۛޛ�HӐSTБJVӕQQ�ۛޛ�ۜ�K�؛\ל۝\�ٗܙXۜ�˜ۛޛ�K�\ݚ[�טۛ��Xݗ٘]HHӐSTБJVӕQQ�\ݚ[�טۛ��Xݗ٘]Kۜ�K�؛\ל۝\�ٗܙXۜ�˛\ݚ[�טۛ��Xݗ٘]JK�\�ٛ۝[X�\�ܘ]ȏHӐSTБJVӕQQ�\�ٛ۝[X�\�ܘ]ˈۜ�K�؛\ל۝\�ٗܙXۜ�˜\�ٛ۝[X�\�ܘ]ʋ�\�ٛ۝[X�\��ܘ]ȏHӐSTБJVӕQQ�\�ٛ۝[X�\��ܘ]ˈۜ�K�؛\ל۝\�ٗܙXۜ�˜\�ٛ۝[X�\��ܘ]ʋ��^Y\�ٚ[�[�ڛ�ȏHӐSTБJVӕQQ��^Y\�ٚ[�[�ڛ�ˈۜ�K�؛\ל۝\�ٗܙXۜ�˘�^Y\�ٚ[�[�ڛ�ʋ��Xۜ�ݞ\HHДт�ґS�VӕQQ�[לݘ]\ȒTȓ�S�S�ۜ�K�؛\ל۝\�ٗܙXۜ�˜�Xۜ�ݞ\B�SшVӕQQ��Xۜ�ݞ\B�S��ݜ�Xݝ\�[ܝ[HHӐSTБJVӕQQ�ݜ�Xݝ\�[ܝ[Kۜ�K�؛\ל۝\�ٗܙXۜ�˜ݜ�Xݝ\�[ܝ[JK�ݜڛ�ם\HHӐSTБJVӕQQ�ݜڛ�ם\Kۜ�K�؛\ל۝\�ٗܙXۜ�˚ݜڛ�ם\JK�]XڛY[�ݞ\HHДт�ґS�VӕQQ�ݜ�Xݝ\�[ܝ[HTȓ�S�S�ۜ�K�؛\ל۝\�ٗܙXۜ�˘]XڛY[�ݞ\B�SшVӕQQ�]XڛY[�ݞ\B�S��\�ښ]Xݝ\�[ܝ[HHӐSTБJVӕQQ�\�ښ]Xݝ\�[ܝ[Kۜ�K�؛\ל۝\�ٗܙXۜ�˘\�ښ]Xݝ\�[ܝ[JK�\ݚ[�ךٞHHӐSTБJ��SQ�VӕQQ�\ݚ[�ךٞK	ɊK�ۜ�K�؛\ל۝\�ٗܙXۜ�˛\ݚ[�ךٞB�
K�\ݚ[�ךYHӐSTБJ��SQ�VӕQQ�\ݚ[�ךY	ɊK�ۜ�K�؛\ל۝\�ٗܙXۜ�˛\ݚ[�ךY�
K��[X\�Wؘ؛ݛ�ڙHДт�ґS�ۜ�K�؛\ל۝\�ٗܙXۜ�˛X]ڗܝ]\ȏH	ۘ[�X[ݙ\�Y�YY	S�ۜ�K�؛\ל۝\�ٗܙXۜ�˜�[X\�Wؘ؛ݛ�ڙ�ґS�ۜ�K�؛\ל۝\�ٗܙXۜ�˜�[X\�Wؘ؛ݛ�ڙTȓ�Ո�S�S�ۜ�K�؛\ל۝\�ٗܙXۜ�˛X]ڗܝ]\ȏ�	ݛ�X]ڙY	S�VӕQQ�X]ڗܝ]\ȒS�
	ݛ�X]ڙY	ˈ	ؙ�\܉ʂ�S�ۜ�K�؛\ל۝\�ٗܙXۜ�˜�[X\�Wؘ؛ݛ�ڙ�SшVӕQQ��[X\�Wؘ؛ݛ�ڙ�S��X]ڗܝ]\ȏHДт�ґS�ۜ�K�؛\ל۝\�ٗܙXۜ�˛X]ڗܝ]\ȏH	ۘ[�X[ݙ\�Y�YY	S�ۜ�K�؛\ל۝\�ٗܙXۜ�˛X]ڗܝ]\ґS�ۜ�K�؛\ל۝\�ٗܙXۜ�˜�[X\�Wؘ؛ݛ�ڙTȓ�Ո�S�S�ۜ�K�؛\ל۝\�ٗܙXۜ�˛X]ڗܝ]\ȏ�	ݛ�X]ڙY	S�VӕQQ�X]ڗܝ]\ȒS�
	ݛ�X]ڙY	ˈ	ؙ�\܉ʂ�S�ۜ�K�؛\ל۝\�ٗܙXۜ�˛X]ڗܝ]\SшVӕQQ�X]ڗܝ]\S��\כ][\Wܘ\�ٛ۝[X�\�ȏHVӕQQ�\כ][\Wܘ\�ٛ۝[X�\�˃B�][Wܘ\�ٛܝ]\ȏHVӕQQ�][Wܘ\�ٛܝ]\˃B�\ם[��\ۛ�Yܘ\�ٛHДт�ґS�ۜ�K�؛\ל۝\�ٗܙXۜ�˛X]ڗܝ]\ȏH	ۘ[�X[ݙ\�Y�YY	S�ۜ�K�؛\ל۝\�ٗܙXۜ�˚\ם[��\ۛ�Yܘ\�ٛ�SшVӕQQ�\ם[��\ۛ�Yܘ\�ٛ�S���\]Z\�\טY][ۘ[ܙ]�Y]ȏHДт�ґS�ۜ�K�؛\ל۝\�ٗܙXۜ�˛X]ڗܝ]\ȏH	ۘ[�X[ݙ\�Y�YY	S�ۜ�K�؛\ל۝\�ٗܙXۜ�˜�\]Z\�\טY][ۘ[ܙ]�Y]SшVӕQQ��\]Z\�\טY][ۘ[ܙ]�Y]S��]WܝX[]WٛY܈HДт�ґS�ۜ�K�؛\ל۝\�ٗܙXۜ�˛X]ڗܝ]\ȏH	ۘ[�X[ݙ\�Y�YY	S�ۜ�K�؛\ל۝\�ٗܙXۜ�˙]WܝX[]WٛY܂�SшVӕQQ�]WܝX[]WٛY܂�S���]ל^[ؙHVӕQQ��]ל^[ؙB�\]Y؝H�݊
CB��UT��S�ȚY۝\�ٗܙXۜ�ژ\ڃB����B�۝\�ٗݘ[Y\˃B�Yٗܚ^�OMLB��]ڏU�YKB�
CB��Xۜ�ڙȏHܙXۜ�ژ\ڎ��Xۜ�ڙ�܈�Xۜ�ڙ�Xۜ�ژ\ڈ[��]\��YB�۝\�ٗܙXۜ�ڙȏH\݊�Xۜ�ڙ˝�[Y\ʊJB��ݜ�ۜ��^XݝJ�����ѓPՈY�[X\�Wؘ؛ݛ�ڙX]ڗܝ]\��ӈۜ�K�؛\ל۝\�ٗܙXۜ�ґT�HYHS�J	\ʂ�����
۝\�ٗܙXۜ�ڙˊK�
B�ݛܙYۘ]ڙ\ȏH�Xۜ�ڙ�
�[X\�Wؘ؛ݛ�ڙX]ڗܝ]\ʂ��܈�Xۜ�ڙ�[X\�Wؘ؛ݛ�ڙX]ڗܝ]\Ț[�ݜ�ۜ���]ژ[

B�B��\\�Y؞WܙXۜ�ڙH�Xۜ�ڙ֜�݋�۝\�ٗܙXۜ�ژ\ڗN��݈�܈�݈[��\\�Y�B�X[�X[Wݙ\�Y�YYڙȏH�Xۜ�ڙ��܈�Xۜ�ڙ
ˈX]ڗܝ]\ʈ[�ݛܙYۘ]ڙ\˚][\ʊB�Y�X]ڗܝ]\ȏOH�X[�X[ݙ\�Y�YY��B��ݙXݙYܛݜ�ٗܙXۜ�ڙȏH�Xۜ�ڙ��܈�Xۜ�ڙ
ݛܙYؘ؛ݛ�ڙݛܙYۘ]ڗܝ]\ʈ[�ݛܙYۘ]ڙ\˚][\ʊB�Y��Xۜ�ڙ[�X[�X[Wݙ\�Y�YYڙ܈ݛܙYؘ؛ݛ�ڙ�OH�\\�Y؞WܙXۜ�ڙܙXۜ�ڙK��[X\�Wؘ؛ݛ�ڙ�܈ݛܙYۘ]ڗܝ]\OH�\\�Y؞WܙXۜ�ڙܙXۜ�ڙK�X]ڗܝ]\B��\X٘X�Wܛݜ�ٗܙXۜ�ڙȏH۝\�ٗܙXۜ�ڙ��܈۝\�ٗܙXۜ�ڙ[�۝\�ٗܙXۜ�ڙY�۝\�ٗܙXۜ�ڙ�݈[��ݙXݙYܛݜ�ٗܙXۜ�ڙB��Y��\X٘X�Wܛݜ�ٗܙXۜ�ڙ΂�ݜ�ۜ��^XݝJ��SUH��ӈۜ�K�؛Wܘ\�ٛȕґT�H۝\�ٗܙXۜ�ڙHS�J	\ʈ��
�\X٘X�Wܛݜ�ٗܙXۜ�ڙˊK�
B�\�ٛݘ[Y\ȏHׂ��܈�݈[��\\�Y��۝\�ٗܙXۜ�ڙH�Xۜ�ڙ֜�݋�۝\�ٗܙXۜ�ژ\ڗB�Y�۝\�ٗܙXۜ�ڙ[��ݙXݙYܛݜ�ٗܙXۜ�ڙ΂�ۛ�[�YB��܈[�Ț[��݋�\�ٛۚ[�܎��\�ٛݘ[Y\˘\[�
B�
B�۝\�ٗܙXۜ�ڙB�[�˜۝\�ٗܛܚ][ۋB�[�˜\�ٛܙ\]Y[�ًB�[�˜\�ٛܛۙKB�[�˜\�ٛ۝[X�\�ܘ]˃B�[�˜\�ٛ۝[X�\�ۛܛX[^�YB�[�˘X؛ݛ�ڙB�[�˛X]ڗۙ]ًB��ۛ
[�˘X؛ݛ�ڙ
KB�
CB�
CB�Y�\�ٛݘ[Y\΂�^XݝWݘ[Y\ʂ�ݜ�ۜ������S�є�S�Șۜ�K�؛Wܘ\�ٛȊ�۝\�ٗܙXۜ�ڙ۝\�ٗܛܚ][ۋ\�ٛܙ\]Y[�ً�\�ٛܛۙK\�ٛ۝[X�\�ܘ]ˈ\�ٛ۝[X�\�ۛܛX[^�Y�X؛ݛ�ڙX]ڗۙ]ً\ל�\ۛ�Y�
H�SQTȉ\����\�ٛݘ[Y\˂�Yٗܚ^�OLL�
B�B�X]ڙYܛݜȏH�݂��܈�݈[��\\�Y�Y��Xۜ�ڙ֜�݋�۝\�ٗܙXۜ�ژ\ڗH�݈[��ݙXݙYܛݜ�ٗܙXۜ�ڙ[��݋��[X\�Wؘ؛ݛ�ڙ�[��݋�\YȜ�Xۜ�ݞ\H�HOH�ۛܙYܘ[H��[��݋�\YȘۛܙW٘]H�H\ț�݈�ۙB�[��݋�\YȘݜ��[�ܜ�Xو�H\ț�݈�ۙB�[��݋�\YȘݜ��[�ܜ�Xو�H��B�X؛ݛ�ڙȏH\݊ܛ݋��[X\�Wؘ؛ݛ�ڙ�܈�݈[�X]ڙYܛݜߊCB�^\ݚ[�ט�Wڙ^N�Xݖݝ\Vܝ�]H�ۙKXڛX[�ۙWK\ݖݝ\Vڛ�[��ۙWWWHH߃B�Y�X؛ݛ�ڙ΃B�ݜ�ۜ��^XݝJB����B�ѓPՈYX؛ݛ�ڙۛܚ[�י]K؛Wܜ�Xً۝\�ٗܙXۜ�ڙB���ӈۜ�K�؛\Â�ґT�HX؛ݛ�ڙHS�J	\ʃB����B�
X؛ݛ�ڙˊKB�
CB��܈؛WڙX؛ݛ�ڙۛܚ[�י]K؛Wܜ�Xً۝\�ٗܙXۜ�ڙ[�ݜ�ۜ���]ژ[

N�B�ٞHH
B�X؛ݛ�ڙB�ۛܚ[�י]KB�XڛX[
؛Wܜ�XيHY�؛Wܜ�Xو\ț�݈�ۙH[و�ۙKB�
CB�^\ݚ[�ט�Wڙ^K�ٝY�][
ٞK׊K�\[�

؛Wڙ۝\�ٗܙXۜ�ڙ
JCB�B�]Xڗݜ]\ȏH׃B�؛\ם�[Y\ȏH׃B�^\ݚ[�ל؛\ט]XڙYHB�^\ݚ[�ל؛\ט[�XYWۚ[�ٙHB��܈�݈[�X]ڙYܛݜ΃B�\YH�݋�\YB�۝\�ٗܙXۜ�ڙH�Xۜ�ڙ֜�݋�۝\�ٗܙXۜ�ژ\ڗCB�ٞHH
B��݋��[X\�Wؘ؛ݛ�ڙB�\YȘۛܙW٘]H�KB�\YȘݜ��[�ܜ�Xو�KB�
CB�^\ݚ[�ȏH^\ݚ[�ט�Wڙ^K�ٝ
ٞK׊CB�؛YWۚ[�ȏHڝ[H�܈][H[�^\ݚ[�ȚY�][V̗HOH۝\�ٗܙXۜ�ڙCB�]XژX�HHڝ[H�܈][H[�^\ݚ[�ȚY�][V̗H\ȓ�ۙWCB�Y�؛YWۚ[�΃B�^\ݚ[�ל؛\ט[�XYWۚ[�ٙ
ψCB�ۛ�[�YCB�Y�[�^\ݚ[�ʈOHH[�[�]XژX�JHOHN�B�؛WڙH]XژX�V̗V̗CB�]Xڗݜ]\˘\[�

۝\�ٗܙXۜ�ڙ؛Wڙ
JCB�^\ݚ[�ל؛\ט]XڙY
ψCB�ۛ�[�YCB�B�؛\ם�[Y\˘\[�
B�
B��݋��[X\�Wؘ؛ݛ�ڙB�X؛ݛ�֜�݋��[X\�Wؘ؛ݛ�ڙVȘY�\܈�KB�\YȘۛܙW٘]H�KB�\YȘݜ��[�ܜ�Xو�KB�\Yș^\כۗۘ\�ٝ�KB�ݜ�\YȜٛ\�؛۝�X�][ۜȗJCB�Y�\YȜٛ\�؛۝�X�][ۜȗH\ț�݈�ۙCB�[و�ۙKB�۝\�ٗۘ[YKB�۝\�ٗܙXۜ�ڙB�
CB�
CB�B�Y�]Xڗݜ]\΃B�^XݝWؘ]ڊB�ݜ�ۜ�B����B�TUHۜ�K�؛\Â�ѕ۝\�ٗܙXۜ�ڙH	\Â�ґT�HYH	\ȐS�۝\�ٗܙXۜ�ڙTȓ�SB����B�]Xڗݜ]\˃B�Yٗܚ^�OMLB�
CB�B�Y�؛\ם�[Y\΃B�^XݝWݘ[Y\ʃB�ݜ�ۜ�B����B�S�є�S�Șۜ�K�؛\ȊB�X؛ݛ�ڙY�\܋ۛܚ[�י]K؛Wܜ�XًB�^\כۗۘ\�ٝۛ�ٜܚ[ۜˈ۝\�ً۝\�ٗܙXۜ�ڙB�
H�SQTȉ\Â�ӈӓ��PՈ
۝\�ٗܙXۜ�ڙ
CB�ґT�H۝\�ٗܙXۜ�ڙTȓ�Ո�SB�ȕTUHѕB�X؛ݛ�ڙHVӕQQ�X؛ݛ�ڙB�Y�\܈HӐSTБJVӕQQ�Y�\܋ۜ�K�؛\˘Y�\܊KB�ۛܚ[�י]HHVӕQQ�ۛܚ[�י]KB�؛Wܜ�XوHVӕQQ�؛Wܜ�XًB�^\כۗۘ\�ٝHVӕQQ�^\כۗۘ\�ٝB�ۛ�ٜܚ[ۜȏHVӕQQ�ۛ�ٜܚ[ۜ˃B�۝\�وHVӕQQ�۝\�ًB�ؙY؝H�݊
CB����B�؛\ם�[Y\˃B�Yٗܚ^�OMLB�
CB�B��\ݛ�\]JB�Â��۝\�ٗܙXۜ�ם\ٜ�Y��[��Xۜ�ڙʋB��؛�ۚX؛ܘ[\לݘ�Z]Y��[�؛\ם�[Y\ʋ��\ݚ[�ܗܜ�\ٜ��Y��ݛJ�B��܈�݈[��\\�Y�Y��݋�\YȜ�Xۜ�ݞ\H�HOH�\ݚ[�Ȃ�
K��ۛܙYܛݜכ�ݗؘ[�ۚX؛^�Y��ݛJ�B��܈�݈[��\\�Y�Y��݋�\YȜ�Xۜ�ݞ\H�HOH�ۛܙYܘ[H��[��݈�݈[�X]ڙYܛݜ
K��^\ݚ[�ל؛\ט]XڙY��^\ݚ[�ל؛\ט]XڙYB��^\ݚ[�ל؛\ט[�XYWۚ[�ٙ��^\ݚ[�ל؛\ט[�XYWۚ[�ٙB�CB�
CB�B�ۛ��Xݚ[ۋ�ۛ[Z]

CB��]\���\ݛB�^ٜ^ٜ[ێ�B�ۛ��Xݚ[ۋ��ۛ�Xڊ
CB��Z\كB��[�[N�B�ۛ��Xݚ[ۋ�ۛܙJ
CB�B�B�Y�XZ[�
HO�[��B�\�ٜ�H\�ܘ\�ً�\�ݛY[�\�ٜ�B�\؜�\[ۏH�ؙH؛\Ȑԕ�ښ[H�\ٜ��[�Ȝ�]ˈ[�X]ڙY[�][K\\�ٛ�ݜȃB�
CB�\�ٜ��Y؜�ݛY[�
�ܝ�ܘ]�\OT]
CB�\�ٜ��Y؜�ݛY[�
B��K\۝\�ً[�[YH�B�Y�][H�SȜ؛\ș^ܝ�B�[H�[X[�\�XYX�H۝\�وX�[ݛܙYڝH؛H�Xۜ�ȋB�
CB�\�ٜ��Y؜�ݛY[�
��KY�K\�[���Xݚ[ۏH�ݛܙWݜ�YH��[H�[�[^�H[�X]ڈ�ݜȝڝݝژ[�ڛ�ȝH]X�\و��
B�\�ٜ��Y؜�ݛY[�
��KYY�][XڝH��[H�ڝH\ٙ�܈^X݈Y�\܈�[�Xڈڙ[�Hԕ�ۚ]ȘHڝHۛ[[���
B�\�ٜ��Y؜�ݛY[�
��KYY�][X۝[�H��[H�۝[�H\ٙȘۛ�ݜ�Z[�^X݈Y�\܈�[�XڈX]ڙ\ȋ�
B�\�܈H\�ٜ��\�ٗ؜�܊
B��\ݛH[\ܝܘ[\ʂ�\�܋�ܝ�ܘ]��\ۛ�J
K�\�܋�۝\�ٗۘ[YK�ݜ�\

K��Wܝ[�X\�܋��Wܝ[��Y�][ؚ]OX\�܋�Y�][ؚ]K�Y�][؛ݛ�OX\�܋�Y�][؛ݛ�K�
B��[�
�ۛ��[\ʜ�\ݛ[�[�L�Y�][\ݜ�JCB��]\��B�B�B�Y�כ�[YW׈OH�כXZ[�׈��B��Z\وޜݙ[Q^]
XZ[�
JCB￿