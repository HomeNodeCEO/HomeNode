from __future__ import annotations

import os
import json
import logging
from decimal import Decimal, InvalidOperation
from typing import Any, Dict, Optional

from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import sessionmaker

log = logging.getLogger("dcad.upsert")

_SCHEMA = os.getenv("DB_SCHEMA") or os.getenv("DCAD_SCHEMA") or os.getenv("PGSCHEMA")

def _tbl(name: str) -> str:
    return f"{_SCHEMA}.{name}" if _SCHEMA else name

_ENGINE: Optional[Engine] = None
_Session = None

def get_engine() -> Engine:
    global _ENGINE, _Session
    if _ENGINE is None:
        db_url = os.getenv("DATABASE_URL")
        if not db_url:
            raise RuntimeError("DATABASE_URL is not set")
        _ENGINE = create_engine(db_url, pool_pre_ping=True, future=True)
        _Session = sessionmaker(bind=_ENGINE, autoflush=False, autocommit=False, future=True)
    return _ENGINE

def get_session():
    if _Session is None:
        get_engine()
    return _Session()

_NULLISH = {None, "", "N/A", "NA", "NONE", "UNASSIGNED", "NULL", "N\\A"}

def _is_nullish(v: Any) -> bool:
    if v is None:
        return True
    if isinstance(v, str):
        return v.strip().upper() in _NULLISH
    return False

def to_text_or_none(v: Any) -> Optional[str]:
    if _is_nullish(v):
        return None
    return str(v).strip()

def to_int_or_none(v: Any) -> Optional[int]:
    if _is_nullish(v):
        return None
    try:
        s = str(v)
        # normalize common formats like "$1,234" or "(1,234)"
        s = s.replace("$", "").replace(",", "").strip()
        if s.startswith("(") and s.endswith(")"):
            s = "-" + s[1:-1]
        if s == "":
            return None
        return int(float(s))
    except (ValueError, TypeError):
        return None

def to_decimal_or_none(v: Any) -> Optional[Decimal]:
    if _is_nullish(v):
        return None
    try:
        s = str(v)
        # strip currency/percent and commas; support parentheses for negatives
        s = s.replace("$", "").replace("%", "").replace(",", "").strip()
        if s.startswith("(") and s.endswith(")"):
            s = "-" + s[1:-1]
        if s == "":
            return None
        return Decimal(s)
    except (InvalidOperation, ValueError, TypeError):
        return None

def upsert_parsed(account_id: str, detail: Dict[str, Any], history: Dict[str, Any]) -> None:
    engine = get_engine()
    with get_session() as s:
        # Keep FK safety for core schema
        if (_SCHEMA or "").lower() == "core":
            s.execute(
                text(f"INSERT INTO {_tbl('accounts')} (account_id) VALUES (:account_id) ON CONFLICT (account_id) DO NOTHING"),
                {"account_id": account_id},
            )
            # Update basic situs/location metadata on accounts when available
            try:
                prop_loc = (detail or {}).get("property_location") or {}
                address = to_text_or_none(prop_loc.get("address") or prop_loc.get("subject_address"))
                neighborhood = to_text_or_none(prop_loc.get("neighborhood"))
                mapsco = to_text_or_none(prop_loc.get("mapsco"))
                legal = (detail or {}).get("legal_description") or {}
                lines = legal.get("lines") if isinstance(legal, dict) else None
                subdivision = None
                if isinstance(lines, list) and lines:
                    subdivision = to_text_or_none(lines[0])
                if address or neighborhood or mapsco or subdivision:
                    s.execute(
                        text(
                            f"""
                            UPDATE {_tbl('accounts')}
                            SET
                              address = COALESCE(:address, address),
                              neighborhood_code = COALESCE(:neighborhood, neighborhood_code),
                              mapsco = COALESCE(:mapsco, mapsco),
                              subdivision = COALESCE(:subdivision, subdivision)
                            WHERE account_id = :account_id
                            """
                        ),
                        {
                            "account_id": account_id,
                            "address": address,
                            "neighborhood": neighborhood,
                            "mapsco": mapsco,
                            "subdivision": subdivision,
                        },
                    )
            except Exception:
                pass
        # -------- primary_improvements (core mapping) --------
        primary: Dict[str, Any] = (
            (detail or {}).get("primary_improvements")
            or (detail or {}).get("main_improvement")
            or (detail or {}).get("primary")
            or {}
        )

        # Extract values
        def _bool(v):
            t = to_text_or_none(v)
            if t is None:
                return None
            return t.strip().upper() in {"Y", "YES", "TRUE", "1"}

        construction_type = to_text_or_none(primary.get("construction_type"))
        percent_complete = to_decimal_or_none(primary.get("percent_complete"))
        year_built = to_int_or_none(primary.get("year_built"))
        effective_year_built = to_int_or_none(primary.get("effective_year_built"))
        actual_age = to_int_or_none(primary.get("actual_age"))
        depreciation = to_decimal_or_none(primary.get("depreciation"))
        desirability = to_text_or_none(primary.get("desirability"))
        stories_text = to_text_or_none(primary.get("stories_raw")) or to_text_or_none(primary.get("stories"))
        living_area_sqft = to_int_or_none(primary.get("living_area_sqft"))
        total_living_area = to_int_or_none(primary.get("total_living_area"))
        bedroom_count = to_int_or_none(primary.get("bedroom_count"))
        baths_full = to_int_or_none(primary.get("baths_full"))
        baths_half = to_int_or_none(primary.get("baths_half"))
        bath_count = to_decimal_or_none(primary.get("bath_count"))
        basement = _bool(primary.get("basement"))
        kitchens = to_int_or_none(primary.get("kitchens"))
        wetbars = to_int_or_none(primary.get("wetbars"))
        fireplaces = to_int_or_none(primary.get("fireplaces"))
        sprinkler = _bool(primary.get("sprinkler"))
        spa = _bool(primary.get("spa"))
        pool = _bool(primary.get("pool"))
        sauna = _bool(primary.get("sauna"))
        air_conditioning = to_text_or_none(primary.get("air_conditioning"))
        heating = to_text_or_none(primary.get("heating"))
        foundation = to_text_or_none(primary.get("foundation"))
        roof_material = to_text_or_none(primary.get("roof_material"))
        roof_type = to_text_or_none(primary.get("roof_type"))
        exterior_material = to_text_or_none(primary.get("exterior_material"))
        fence_type = to_text_or_none(primary.get("fence_type"))
        number_units = to_int_or_none(primary.get("number_units"))
        building_class = to_text_or_none(primary.get("building_class"))
        desirability_raw = to_text_or_none(primary.get("desirability_raw"))
        desirability_id = to_int_or_none(primary.get("desirability_id"))
        total_area_sqft = to_int_or_none(primary.get("total_area_sqft"))
        stories_raw = to_text_or_none(primary.get("stories_raw"))
        deck = to_text_or_none(primary.get("deck"))
        basement_raw = to_text_or_none(primary.get("basement_raw"))

        if (_SCHEMA or "").lower() == "core":
            s.execute(
                text(
                    f"""
                    INSERT INTO {_tbl('primary_improvements')} (
                      account_id,
                      construction_type, percent_complete, year_built, effective_year_built, actual_age,
                      depreciation, desirability, stories, living_area_sqft, total_living_area,
                      bedroom_count, bath_count, basement, kitchens, wetbars, fireplaces, sprinkler,
                      spa, pool, sauna, air_conditioning, heating, foundation, roof_material, roof_type,
                      exterior_material, fence_type, number_units, building_class, desirability_raw,
                      desirability_id, total_area_sqft, stories_raw, baths_full, baths_half, deck, basement_raw
                    ) VALUES (
                      :account_id,
                      :construction_type, :percent_complete, :year_built, :effective_year_built, :actual_age,
                      :depreciation, :desirability, :stories, :living_area_sqft, :total_living_area,
                      :bedroom_count, :bath_count, :basement, :kitchens, :wetbars, :fireplaces, :sprinkler,
                      :spa, :pool, :sauna, :air_conditioning, :heating, :foundation, :roof_material, :roof_type,
                      :exterior_material, :fence_type, :number_units, :building_class, :desirability_raw,
                      :desirability_id, :total_area_sqft, :stories_raw, :baths_full, :baths_half, :deck, :basement_raw
                    )
                    ON CONFLICT (account_id) DO UPDATE SET
                      construction_type = COALESCE(EXCLUDED.construction_type, {_tbl('primary_improvements')}.construction_type),
                      percent_complete = COALESCE(EXCLUDED.percent_complete, {_tbl('primary_improvements')}.percent_complete),
                      year_built = COALESCE(EXCLUDED.year_built, {_tbl('primary_improvements')}.year_built),
                      effective_year_built = COALESCE(EXCLUDED.effective_year_built, {_tbl('primary_improvements')}.effective_year_built),
                      actual_age = COALESCE(EXCLUDED.actual_age, {_tbl('primary_improvements')}.actual_age),
                      depreciation = COALESCE(EXCLUDED.depreciation, {_tbl('primary_improvements')}.depreciation),
                      desirability = COALESCE(EXCLUDED.desirability, {_tbl('primary_improvements')}.desirability),
                      stories = COALESCE(EXCLUDED.stories, {_tbl('primary_improvements')}.stories),
                      living_area_sqft = COALESCE(EXCLUDED.living_area_sqft, {_tbl('primary_improvements')}.living_area_sqft),
                      total_living_area = COALESCE(EXCLUDED.total_living_area, {_tbl('primary_improvements')}.total_living_area),
                      bedroom_count = COALESCE(EXCLUDED.bedroom_count, {_tbl('primary_improvements')}.bedroom_count),
                      bath_count = COALESCE(EXCLUDED.bath_count, {_tbl('primary_improvements')}.bath_count),
                      basement = COALESCE(EXCLUDED.basement, {_tbl('primary_improvements')}.basement),
                      kitchens = COALESCE(EXCLUDED.kitchens, {_tbl('primary_improvements')}.kitchens),
                      wetbars = COALESCE(EXCLUDED.wetbars, {_tbl('primary_improvements')}.wetbars),
                      fireplaces = COALESCE(EXCLUDED.fireplaces, {_tbl('primary_improvements')}.fireplaces),
                      sprinkler = COALESCE(EXCLUDED.sprinkler, {_tbl('primary_improvements')}.sprinkler),
                      spa = COALESCE(EXCLUDED.spa, {_tbl('primary_improvements')}.spa),
                      pool = COALESCE(EXCLUDED.pool, {_tbl('primary_improvements')}.pool),
                      sauna = COALESCE(EXCLUDED.sauna, {_tbl('primary_improvements')}.sauna),
                      air_conditioning = COALESCE(EXCLUDED.air_conditioning, {_tbl('primary_improvements')}.air_conditioning),
                      heating = COALESCE(EXCLUDED.heating, {_tbl('primary_improvements')}.heating),
                      foundation = COALESCE(EXCLUDED.foundation, {_tbl('primary_improvements')}.foundation),
                      roof_material = COALESCE(EXCLUDED.roof_material, {_tbl('primary_improvements')}.roof_material),
                      roof_type = COALESCE(EXCLUDED.roof_type, {_tbl('primary_improvements')}.roof_type),
                      exterior_material = COALESCE(EXCLUDED.exterior_material, {_tbl('primary_improvements')}.exterior_material),
                      fence_type = COALESCE(EXCLUDED.fence_type, {_tbl('primary_improvements')}.fence_type),
                      number_units = COALESCE(EXCLUDED.number_units, {_tbl('primary_improvements')}.number_units),
                      building_class = COALESCE(EXCLUDED.building_class, {_tbl('primary_improvements')}.building_class),
                      desirability_raw = COALESCE(EXCLUDED.desirability_raw, {_tbl('primary_improvements')}.desirability_raw),
                      desirability_id = COALESCE(EXCLUDED.desirability_id, {_tbl('primary_improvements')}.desirability_id),
                      total_area_sqft = COALESCE(EXCLUDED.total_area_sqft, {_tbl('primary_improvements')}.total_area_sqft),
                      stories_raw = COALESCE(EXCLUDED.stories_raw, {_tbl('primary_improvements')}.stories_raw),
                      baths_full = COALESCE(EXCLUDED.baths_full, {_tbl('primary_improvements')}.baths_full),
                      baths_half = COALESCE(EXCLUDED.baths_half, {_tbl('primary_improvements')}.baths_half),
                      deck = COALESCE(EXCLUDED.deck, {_tbl('primary_improvements')}.deck),
                      basement_raw = COALESCE(EXCLUDED.basement_raw, {_tbl('primary_improvements')}.basement_raw)
                    """
                ),
                {
                    "account_id": account_id,
                    "construction_type": construction_type,
                    "percent_complete": percent_complete,
                    "year_built": year_built,
                    "effective_year_built": effective_year_built,
                    "actual_age": actual_age,
                    "depreciation": depreciation,
                    "desirability": desirability,
                    "stories": stories_text,
                    "living_area_sqft": living_area_sqft,
                    "total_living_area": total_living_area,
                    "bedroom_count": bedroom_count,
                    "bath_count": bath_count,
                    "basement": basement,
                    "kitchens": kitchens,
                    "wetbars": wetbars,
                    "fireplaces": fireplaces,
                    "sprinkler": sprinkler,
                    "spa": spa,
                    "pool": pool,
                    "sauna": sauna,
                    "air_conditioning": air_conditioning,
                    "heating": heating,
                    "foundation": foundation,
                    "roof_material": roof_material,
                    "roof_type": roof_type,
                    "exterior_material": exterior_material,
                    "fence_type": fence_type,
                    "number_units": number_units,
                    "building_class": building_class,
                    "desirability_raw": desirability_raw,
                    "desirability_id": desirability_id,
                    "total_area_sqft": total_area_sqft,
                    "stories_raw": stories_raw,
                    "baths_full": baths_full,
                    "baths_half": baths_half,
                    "deck": deck,
                    "basement_raw": basement_raw,
                },
            )

        # -------- secondary_improvements (core mapping) --------
        sec_list = (detail or {}).get("secondary_improvements") or []
        if (_SCHEMA or "").lower() == "core":
            s.execute(
                text(f"DELETE FROM {_tbl('secondary_improvements')} WHERE account_id = :account_id"),
                {"account_id": account_id},
            )
            if sec_list:
                ins = text(
                    f"""
                    INSERT INTO {_tbl('secondary_improvements')} (
                      account_id, tax_obj_id, sec_imp_number, sec_imp_type, sec_imp_desc,
                      sec_imp_year_built, sec_imp_cons_type, sec_imp_floor, sec_imp_ext_wall,
                      sec_imp_stories, sec_imp_sqft, sec_imp_value, sec_imp_depreciation
                    ) VALUES (
                      :account_id, :tax_obj_id, :sec_imp_number, :sec_imp_type, :sec_imp_desc,
                      :sec_imp_year_built, :sec_imp_cons_type, :sec_imp_floor, :sec_imp_ext_wall,
                      :sec_imp_stories, :sec_imp_sqft, :sec_imp_value, :sec_imp_depreciation
                    )
                    """
                )
                for row in sec_list:
                    num = to_int_or_none(row.get("imp_num"))
                    if num is None:
                        continue
                    s.execute(
                        ins,
                        {
                            "account_id": account_id,
                            "tax_obj_id": to_text_or_none(row.get("tax_obj_id")),
                            "sec_imp_number": num,
                            "sec_imp_type": to_text_or_none(row.get("imp_type")),
                            "sec_imp_desc": to_text_or_none(row.get("imp_desc")),
                            "sec_imp_year_built": to_int_or_none(row.get("year_built")),
                            "sec_imp_cons_type": to_text_or_none(row.get("construction")),
                            "sec_imp_floor": to_text_or_none(row.get("floor_type")),
                            "sec_imp_ext_wall": to_text_or_none(row.get("ext_wall")),
                            "sec_imp_stories": to_decimal_or_none(row.get("num_stories")),
                            "sec_imp_sqft": to_int_or_none(row.get("area_size")),
                            "sec_imp_value": to_decimal_or_none(row.get("value")),
                            "sec_imp_depreciation": to_decimal_or_none(row.get("depreciation")),
                        },
                    )

        # -------- owner_summary and owner_parties --------
        if (_SCHEMA or "").lower() == "core":
            # determine tax_year from detail
            try:
                tax_year = int((detail or {}).get("tax_year")) if (detail or {}).get("tax_year") else None
            except Exception:
                tax_year = None

            owner = (detail or {}).get("owner") or {}
            owner_name = to_text_or_none(owner.get("owner_name"))
            mailing_address = to_text_or_none(owner.get("mailing_address"))
            if tax_year:
                s.execute(
                    text(
                        f"""
                        INSERT INTO {_tbl('owner_summary')} (account_id, tax_year, owner_name, mailing_address)
                        VALUES (:account_id, :tax_year, :owner_name, :mailing_address)
                        ON CONFLICT (account_id, tax_year) DO UPDATE SET
                          owner_name = COALESCE(EXCLUDED.owner_name, {_tbl('owner_summary')}.owner_name),
                          mailing_address = COALESCE(EXCLUDED.mailing_address, {_tbl('owner_summary')}.mailing_address)
                        """
                    ),
                    {
                        "account_id": account_id,
                        "tax_year": tax_year,
                        "owner_name": owner_name,
                        "mailing_address": mailing_address,
                    },
                )
                s.execute(
                    text(f"DELETE FROM {_tbl('owner_parties')} WHERE account_id = :account_id AND tax_year = :tax_year"),
                    {"account_id": account_id, "tax_year": tax_year},
                )
                for p in (owner.get("multi_owner") or []):
                    s.execute(
                        text(
                            f"""
                            INSERT INTO {_tbl('owner_parties')} (account_id, tax_year, owner_name, ownership_pct)
                            VALUES (:account_id, :tax_year, :owner_name, :ownership_pct)
                            """
                        ),
                        {
                            "account_id": account_id,
                            "tax_year": tax_year,
                            "owner_name": to_text_or_none(p.get("owner_name")) or (owner_name or ""),
                            "ownership_pct": to_decimal_or_none(p.get("ownership_pct")),
                        },
                    )

            # ARB hearing
            arb = (detail or {}).get("arb_hearing") or {}
            info = to_text_or_none(arb.get("hearing_info")) or ""
            # crude parse: look for a date like MM/DD/YYYY
            import re
            m = re.search(r"(\d{1,2})/(\d{1,2})/(\d{4})", info)
            hearing_date = None
            if m:
                mm, dd, yy = m.groups()
                hearing_date = f"{yy}-{int(mm):02d}-{int(dd):02d}"
            m2 = re.search(r"Hearing Info:\s*([A-Z])\b", info)
            hearing_type = m2.group(1) if m2 else None
            if hearing_date or hearing_type or info:
                s.execute(
                    text(
                        f"""
                        INSERT INTO {_tbl('arb_hearing')} (account_id, hearing_date, hearing_type, result)
                        VALUES (:account_id, :hearing_date, :hearing_type, :result)
                        ON CONFLICT DO NOTHING
                        """
                    ),
                    {"account_id": account_id, "hearing_date": hearing_date, "hearing_type": hearing_type, "result": None},
                )

        # -------- value_summary current + history --------
        if (_SCHEMA or "").lower() == "core":
            vs = (detail or {}).get("value_summary") or {}
            def _money(v):
                return to_decimal_or_none(v)
            cert_year = None
            try:
                cert_year = int(vs.get("certified_year")) if vs.get("certified_year") else None
            except Exception:
                cert_year = None
            if cert_year:
                s.execute(
                    text(
                        f"""
                        INSERT INTO {_tbl('value_summary_current')} (
                          account_id, certified_year, improvement_value, land_value, market_value, capped_value,
                          tax_agent, revaluation_year, previous_revaluation_year
                        ) VALUES (
                          :account_id, :certified_year, :improvement_value, :land_value, :market_value, :capped_value,
                          :tax_agent, :revaluation_year, :previous_revaluation_year
                        )
                        ON CONFLICT (account_id) DO UPDATE SET
                          certified_year = COALESCE(EXCLUDED.certified_year, {_tbl('value_summary_current')}.certified_year),
                          improvement_value = COALESCE(EXCLUDED.improvement_value, {_tbl('value_summary_current')}.improvement_value),
                          land_value = COALESCE(EXCLUDED.land_value, {_tbl('value_summary_current')}.land_value),
                          market_value = COALESCE(EXCLUDED.market_value, {_tbl('value_summary_current')}.market_value),
                          capped_value = COALESCE(EXCLUDED.capped_value, {_tbl('value_summary_current')}.capped_value),
                          tax_agent = COALESCE(EXCLUDED.tax_agent, {_tbl('value_summary_current')}.tax_agent),
                          revaluation_year = COALESCE(EXCLUDED.revaluation_year, {_tbl('value_summary_current')}.revaluation_year),
                          previous_revaluation_year = COALESCE(EXCLUDED.previous_revaluation_year, {_tbl('value_summary_current')}.previous_revaluation_year)
                        """
                    ),
                    {
                        "account_id": account_id,
                        "certified_year": cert_year,
                        "improvement_value": _money(vs.get("improvement_value")),
                        "land_value": _money(vs.get("land_value")),
                        "market_value": _money(vs.get("market_value")),
                        "capped_value": _money(vs.get("capped_value")),
                        "tax_agent": to_text_or_none(vs.get("tax_agent")),
                        "revaluation_year": to_int_or_none(vs.get("revaluation_year")),
                        "previous_revaluation_year": to_int_or_none(vs.get("previous_revaluation_year")),
                    },
                )
                s.execute(
                    text(
                        f"""
                        INSERT INTO {_tbl('value_summary_history')} (
                          account_id, certified_year, improvement_value, land_value, market_value, capped_value,
                          tax_agent, revaluation_year, previous_revaluation_year
                        ) VALUES (
                          :account_id, :certified_year, :improvement_value, :land_value, :market_value, :capped_value,
                          :tax_agent, :revaluation_year, :previous_revaluation_year
                        )
                        ON CONFLICT (account_id, certified_year) DO UPDATE SET
                          improvement_value = COALESCE(EXCLUDED.improvement_value, {_tbl('value_summary_history')}.improvement_value),
                          land_value = COALESCE(EXCLUDED.land_value, {_tbl('value_summary_history')}.land_value),
                          market_value = COALESCE(EXCLUDED.market_value, {_tbl('value_summary_history')}.market_value),
                          capped_value = COALESCE(EXCLUDED.capped_value, {_tbl('value_summary_history')}.capped_value),
                          tax_agent = COALESCE(EXCLUDED.tax_agent, {_tbl('value_summary_history')}.tax_agent),
                          revaluation_year = COALESCE(EXCLUDED.revaluation_year, {_tbl('value_summary_history')}.revaluation_year),
                          previous_revaluation_year = COALESCE(EXCLUDED.previous_revaluation_year, {_tbl('value_summary_history')}.previous_revaluation_year)
                        """
                    ),
                    {
                        "account_id": account_id,
                        "certified_year": cert_year,
                        "improvement_value": _money(vs.get("improvement_value")),
                        "land_value": _money(vs.get("land_value")),
                        "market_value": _money(vs.get("market_value")),
                        "capped_value": _money(vs.get("capped_value")),
                        "tax_agent": to_text_or_none(vs.get("tax_agent")),
                        "revaluation_year": to_int_or_none(vs.get("revaluation_year")),
                        "previous_revaluation_year": to_int_or_none(vs.get("previous_revaluation_year")),
                    },
                )

        # -------- market_value_history --------
        if (_SCHEMA or "").lower() == "core":
            mv_list = (history or {}).get("market_value") or []
            for mv in mv_list:
                yr = to_int_or_none(mv.get("year"))
                if not yr:
                    continue
                s.execute(
                    text(
                        f"""
                        INSERT INTO {_tbl('market_value_history')} (
                          account_id, tax_year, imp_value, land_value, total_market_value, homestead_capped
                        ) VALUES (
                          :account_id, :tax_year, :imp_value, :land_value, :total_market_value, :homestead_capped
                        )
                        ON CONFLICT (account_id, tax_year) DO UPDATE SET
                          imp_value = COALESCE(EXCLUDED.imp_value, {_tbl('market_value_history')}.imp_value),
                          land_value = COALESCE(EXCLUDED.land_value, {_tbl('market_value_history')}.land_value),
                          total_market_value = COALESCE(EXCLUDED.total_market_value, {_tbl('market_value_history')}.total_market_value),
                          homestead_capped = COALESCE(EXCLUDED.homestead_capped, {_tbl('market_value_history')}.homestead_capped)
                        """
                    ),
                    {
                        "account_id": account_id,
                        "tax_year": yr,
                        "imp_value": to_decimal_or_none(mv.get("improvement")),
                        "land_value": to_decimal_or_none(mv.get("land")),
                        "total_market_value": to_decimal_or_none(mv.get("total_market")),
                        "homestead_capped": to_decimal_or_none(mv.get("homestead_capped")),
                    },
                )

        # -------- taxable_value_history --------
        if (_SCHEMA or "").lower() == "core":
            tv_list = (history or {}).get("taxable_value") or []
            for tv in tv_list:
                yr = to_int_or_none(tv.get("year"))
                if not yr:
                    continue
                for key in ("city","isd","county","college","hospital","special_district"):
                    val = to_decimal_or_none(tv.get(key))
                    if val is None:
                        continue
                    s.execute(
                        text(
                            f"""
                            INSERT INTO {_tbl('taxable_value_history')} (account_id, tax_year, jurisdiction_key, taxable_value)
                            VALUES (:account_id, :tax_year, :jur, :taxable_value)
                            ON CONFLICT (account_id, tax_year, jurisdiction_key) DO UPDATE SET
                              taxable_value = EXCLUDED.taxable_value
                            """
                        ),
                        {"account_id": account_id, "tax_year": yr, "jur": key, "taxable_value": val},
                    )

        # -------- exemptions summary + history (current year) --------
        if (_SCHEMA or "").lower() == "core":
            try:
                tax_year = int((detail or {}).get("tax_year")) if (detail or {}).get("tax_year") else None
            except Exception:
                tax_year = None
            ex = (detail or {}).get("exemptions") or {}
            if tax_year:
                for key, row in ex.items():
                    s.execute(
                        text(
                            f"""
                            INSERT INTO {_tbl('exemptions_summary')} (
                              account_id, tax_year, jurisdiction_key, taxing_jurisdiction, homestead_exemption, disabled_vet, taxable_value
                            ) VALUES (
                              :account_id, :tax_year, :jur, :tj, :he, :dv, :tv
                            )
                            ON CONFLICT (account_id, jurisdiction_key) DO UPDATE SET
                              taxing_jurisdiction = COALESCE(EXCLUDED.taxing_jurisdiction, {_tbl('exemptions_summary')}.taxing_jurisdiction),
                              homestead_exemption = COALESCE(EXCLUDED.homestead_exemption, {_tbl('exemptions_summary')}.homestead_exemption),
                              disabled_vet = COALESCE(EXCLUDED.disabled_vet, {_tbl('exemptions_summary')}.disabled_vet),
                              taxable_value = COALESCE(EXCLUDED.taxable_value, {_tbl('exemptions_summary')}.taxable_value)
                            """
                        ),
                        {
                            "account_id": account_id,
                            "tax_year": tax_year,
                            "jur": key,
                            "tj": to_text_or_none((row or {}).get("taxing_jurisdiction")),
                            "he": to_decimal_or_none((row or {}).get("homestead_exemption")) or 0,
                            "dv": to_decimal_or_none((row or {}).get("disabled_vet")) or 0,
                            "tv": to_decimal_or_none((row or {}).get("taxable_value")) or 0,
                        },
                    )
                    s.execute(
                        text(
                            f"""
                            INSERT INTO {_tbl('exemptions_history')} (
                              account_id, tax_year, jurisdiction_key, taxing_jurisdiction, homestead_exemption, disabled_vet, taxable_value
                            ) VALUES (
                              :account_id, :tax_year, :jur, :tj, :he, :dv, :tv
                            )
                            ON CONFLICT (account_id, tax_year, jurisdiction_key) DO UPDATE SET
                              taxing_jurisdiction = COALESCE(EXCLUDED.taxing_jurisdiction, {_tbl('exemptions_history')}.taxing_jurisdiction),
                              homestead_exemption = COALESCE(EXCLUDED.homestead_exemption, {_tbl('exemptions_history')}.homestead_exemption),
                              disabled_vet = COALESCE(EXCLUDED.disabled_vet, {_tbl('exemptions_history')}.disabled_vet),
                              taxable_value = COALESCE(EXCLUDED.taxable_value, {_tbl('exemptions_history')}.taxable_value)
                            """
                        ),
                        {
                            "account_id": account_id,
                            "tax_year": tax_year,
                            "jur": key,
                            "tj": to_text_or_none((row or {}).get("taxing_jurisdiction")),
                            "he": to_decimal_or_none((row or {}).get("homestead_exemption")) or 0,
                            "dv": to_decimal_or_none((row or {}).get("disabled_vet")) or 0,
                            "tv": to_decimal_or_none((row or {}).get("taxable_value")) or 0,
                        },
                    )

        # -------- land_detail (replace current year) --------
        if (_SCHEMA or "").lower() == "core":
            try:
                tax_year = int((detail or {}).get("tax_year")) if (detail or {}).get("tax_year") else None
            except Exception:
                tax_year = None
            land_rows = (detail or {}).get("land_detail") or []
            if tax_year and land_rows:
                s.execute(
                    text(f"DELETE FROM {_tbl('land_detail')} WHERE account_id = :account_id AND tax_year = :tax_year"),
                    {"account_id": account_id, "tax_year": tax_year},
                )
                ins = text(
                    f"""
                    INSERT INTO {_tbl('land_detail')} (
                      account_id, tax_year, line_number, state_code, zoning, frontage_ft, depth_ft,
                      area_sqft, pricing_method, unit_price, market_adjustment_pct, adjusted_price, ag_land
                    ) VALUES (
                      :account_id, :tax_year, :line_number, :state_code, :zoning, :frontage_ft, :depth_ft,
                      :area_sqft, :pricing_method, :unit_price, :market_adjustment_pct, :adjusted_price, :ag_land
                    )
                    """
                )
                for r in land_rows:
                    s.execute(
                        ins,
                        {
                            "account_id": account_id,
                            "tax_year": tax_year,
                            "line_number": to_int_or_none(r.get("number")) or 0,
                            "state_code": to_text_or_none(r.get("state_code")),
                            "zoning": to_text_or_none(r.get("zoning")),
                            "frontage_ft": to_decimal_or_none(r.get("frontage_ft")),
                            "depth_ft": to_decimal_or_none(r.get("depth_ft")),
                            "area_sqft": to_decimal_or_none(r.get("area_sqft")),
                            "pricing_method": to_text_or_none(r.get("pricing_method")),
                            "unit_price": to_decimal_or_none(r.get("unit_price")),
                            "market_adjustment_pct": to_decimal_or_none(r.get("market_adjustment_pct")),
                            "adjusted_price": to_decimal_or_none(r.get("adjusted_price")),
                            "ag_land": to_text_or_none(r.get("ag_land")),
                        },
                    )

        # -------- legal_description current + history --------
        if (_SCHEMA or "").lower() == "core":
            try:
                tax_year = int((detail or {}).get("tax_year")) if (detail or {}).get("tax_year") else None
            except Exception:
                tax_year = None
            ld = (detail or {}).get("legal_description") or {}
            if tax_year:
                s.execute(
                    text(
                        f"""
                        INSERT INTO {_tbl('legal_description_current')} (
                          account_id, tax_year, legal_lines, legal_text, deed_transfer_raw, deed_transfer_date
                        ) VALUES (
                          :account_id, :tax_year, CAST(:legal_lines_json AS JSONB), :legal_text, :deed_raw, :deed_date
                        )
                        ON CONFLICT (account_id) DO UPDATE SET
                          tax_year = EXCLUDED.tax_year,
                          legal_lines = EXCLUDED.legal_lines,
                          legal_text = EXCLUDED.legal_text,
                          deed_transfer_raw = EXCLUDED.deed_transfer_raw,
                          deed_transfer_date = COALESCE(EXCLUDED.deed_transfer_date, {_tbl('legal_description_current')}.deed_transfer_date)
                        """
                    ),
                    {
                        "account_id": account_id,
                        "tax_year": tax_year,
                        "legal_lines_json": json.dumps(ld.get("lines") or []),
                        "legal_text": "; ".join(ld.get("lines") or []),
                        "deed_raw": to_text_or_none(ld.get("deed_transfer_date")),
                        "deed_date": None,
                    },
                )

            # history from owner_history
            for oh in (history or {}).get("owner_history") or []:
                yr = to_int_or_none(oh.get("observed_year"))
                if not yr:
                    continue
                # Ownership history row
                s.execute(
                    text(
                        f"""
                        INSERT INTO {_tbl('ownership_history')} (
                          account_id, observed_year, deed_transfer_date_raw, deed_transfer_date
                        ) VALUES (
                          :account_id, :observed_year, :deed_raw, :deed_date
                        )
                        ON CONFLICT (account_id, observed_year) DO UPDATE SET
                          deed_transfer_date_raw = EXCLUDED.deed_transfer_date_raw,
                          deed_transfer_date = COALESCE(EXCLUDED.deed_transfer_date, {_tbl('ownership_history')}.deed_transfer_date)
                        """
                    ),
                    {
                        "account_id": account_id,
                        "observed_year": yr,
                        "deed_raw": to_text_or_none(oh.get("deed_transfer_date_raw")),
                        "deed_date": to_text_or_none(oh.get("deed_transfer_date_iso")),
                    },
                )
                lines = oh.get("legal_description_lines") or []
                s.execute(
                    text(
                        f"""
                        INSERT INTO {_tbl('legal_description_history')} (
                          account_id, tax_year, legal_lines, legal_text, deed_transfer_raw, deed_transfer_date
                        ) VALUES (
                          :account_id, :tax_year, CAST(:legal_lines_json AS JSONB), :legal_text, :deed_raw, :deed_date
                        )
                        ON CONFLICT (account_id, tax_year) DO UPDATE SET
                          legal_lines = EXCLUDED.legal_lines,
                          legal_text = EXCLUDED.legal_text,
                          deed_transfer_raw = EXCLUDED.deed_transfer_raw,
                          deed_transfer_date = COALESCE(EXCLUDED.deed_transfer_date, {_tbl('legal_description_history')}.deed_transfer_date)
                        """
                    ),
                    {
                        "account_id": account_id,
                        "tax_year": yr,
                        "legal_lines_json": json.dumps(lines),
                        "legal_text": "; ".join(lines),
                        "deed_raw": to_text_or_none(oh.get("deed_transfer_date_raw")),
                        "deed_date": to_text_or_none(oh.get("deed_transfer_date_iso")),
                    },
                )

        # -------- estimated_taxes and total (replace current year) --------
        if (_SCHEMA or "").lower() == "core":
            try:
                tax_year = int((detail or {}).get("tax_year")) if (detail or {}).get("tax_year") else None
            except Exception:
                tax_year = None
            et = (detail or {}).get("estimated_taxes") or {}
            if tax_year:
                s.execute(
                    text(f"DELETE FROM {_tbl('estimated_taxes')} WHERE account_id = :account_id AND tax_year = :tax_year"),
                    {"account_id": account_id, "tax_year": tax_year},
                )
                ins = text(
                    f"""
                    INSERT INTO {_tbl('estimated_taxes')} (
                      account_id, tax_year, jurisdiction_key, taxing_unit, tax_rate_per_100,
                      taxable_value, estimated_taxes_amt, tax_ceiling
                    ) VALUES (
                      :account_id, :tax_year, :jur, :unit, :rate, :taxable_value, :est_amt, :ceiling
                    )
                    """
                )
                for key in ("city","school","county","college","hospital","special_district"):
                    row = et.get(key) or {}
                    s.execute(
                        ins,
                        {
                            "account_id": account_id,
                            "tax_year": tax_year,
                            "jur": key,
                            "unit": to_text_or_none(row.get("taxing_unit")),
                            "rate": to_decimal_or_none(row.get("tax_rate_per_100")),
                            "taxable_value": to_decimal_or_none(row.get("taxable_value")) or 0,
                            "est_amt": to_decimal_or_none(row.get("estimated_taxes")) or 0,
                            "ceiling": to_decimal_or_none(row.get("tax_ceiling")),
                        },
                    )
                # total line
                s.execute(
                    text(
                        f"""
                        INSERT INTO {_tbl('estimated_taxes_total')} (account_id, tax_year, total_estimated)
                        VALUES (:account_id, :tax_year, :total)
                        ON CONFLICT (account_id) DO UPDATE SET
                          tax_year = COALESCE(EXCLUDED.tax_year, {_tbl('estimated_taxes_total')}.tax_year),
                          total_estimated = COALESCE(EXCLUDED.total_estimated, {_tbl('estimated_taxes_total')}.total_estimated)
                        """
                    ),
                    {
                        "account_id": account_id,
                        "tax_year": tax_year,
                        "total": to_decimal_or_none((detail or {}).get("estimated_taxes_total")) or 0,
                    },
                )

        s.commit()
        log.info("Upsert core estimated taxes complete for account_id=%s", account_id)
