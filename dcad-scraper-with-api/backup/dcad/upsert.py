from sqlalchemy import text
from .db.session import SessionLocal
def _infer_tax_year(detail: dict): return detail.get("tax_year")
def upsert_parsed(account_id: str, detail: dict, history: dict):
    tax_year = _infer_tax_year(detail)
    with SessionLocal() as s, s.begin():
        s.execute(text("INSERT INTO parcels(account_id, last_seen) VALUES (:id, NOW()) ON CONFLICT (account_id) DO UPDATE SET last_seen = EXCLUDED.last_seen"), {"id": account_id})
        mi = detail.get("main_improvement") or {}
        if mi:
            s.execute(text("""
                INSERT INTO main_improvements (
                  account_id, building_class, year_built, effective_year_built, actual_age, desirability,
                  living_area_sqft, total_area_sqft, percent_complete, stories, depreciation_pct,
                  construction_type, foundation, roof_type, roof_material, fence_type, exterior_material,
                  basement, heating, air_conditioning, baths_full, baths_half, kitchens, wet_bars,
                  fireplaces, sprinkler, deck, spa, pool, sauna
                )
                VALUES (
                  :account_id, :building_class, :year_built, :effective_year_built, :actual_age, :desirability,
                  :living_area_sqft, :total_area_sqft, :percent_complete, :stories, :depreciation_pct,
                  :construction_type, :foundation, :roof_type, :roof_material, :fence_type, :exterior_material,
                  :basement, :heating, :air_conditioning, :baths_full, :baths_half, :kitchens, :wet_bars,
                  :fireplaces, :sprinkler, :deck, :spa, :pool, :sauna
                )
            """), {**mi, "account_id": account_id})
        s.execute(text("DELETE FROM additional_improvements WHERE account_id=:id"), {"id": account_id})
        for row in detail.get("additional_improvements") or []:
            s.execute(text("""
                INSERT INTO additional_improvements (account_id, improvement_type, construction, floor, exterior_wall, area_sqft)
                VALUES (:account_id, :improvement_type, :construction, :floor, :exterior_wall, :area_sqft)
            """), {**row, "account_id": account_id})
        s.execute(text("DELETE FROM land_lines WHERE account_id=:id"), {"id": account_id})
        for row in detail.get("land_lines") or []:
            s.execute(text("""
                INSERT INTO land_lines (account_id, state_code, zoning, frontage, depth, area_sqft, pricing_method, unit_price, market_adjustment, adjusted_price, ag_land)
                VALUES (:account_id, :state_code, :zoning, :frontage, :depth, :area_sqft, :pricing_method, :unit_price, :market_adjustment, :adjusted_price, :ag_land)
            """), {**row, "account_id": account_id})
        if tax_year:
            for row in detail.get("exemption_summary") or []:
                s.execute(text("""
                    INSERT INTO exemption_summary (account_id, tax_year, jurisdiction, taxing_unit, homestead_exemption, taxable_value)
                    VALUES (:account_id, :tax_year, :jurisdiction, :taxing_unit, :homestead_exemption, :taxable_value)
                    ON CONFLICT (account_id, tax_year, jurisdiction) DO UPDATE
                    SET taxing_unit=EXCLUDED.taxing_unit,
                        homestead_exemption=EXCLUDED.homestead_exemption,
                        taxable_value=EXCLUDED.taxable_value
                """), {**row, "account_id": account_id, "tax_year": tax_year})
            for row in detail.get("estimated_taxes") or []:
                s.execute(text("""
                    INSERT INTO estimated_taxes (account_id, tax_year, jurisdiction, taxing_unit, tax_rate_per_100, taxable_value, estimated_taxes, tax_ceiling)
                    VALUES (:account_id, :tax_year, :jurisdiction, :taxing_unit, :tax_rate_per_100, :taxable_value, :estimated_taxes, :tax_ceiling)
                    ON CONFLICT (account_id, tax_year, jurisdiction) DO UPDATE
                    SET taxing_unit=EXCLUDED.taxing_unit,
                        tax_rate_per_100=EXCLUDED.tax_rate_per_100,
                        taxable_value=EXCLUDED.taxable_value,
                        estimated_taxes=EXCLUDED.estimated_taxes,
                        tax_ceiling=EXCLUDED.tax_ceiling
                """), {**row, "account_id": account_id, "tax_year": tax_year})
            total = detail.get("estimated_taxes_total")
            if total is not None:
                s.execute(text("""
                    INSERT INTO estimated_taxes_total (account_id, tax_year, total_estimated)
                    VALUES (:account_id, :tax_year, :total_estimated)
                    ON CONFLICT (account_id, tax_year) DO UPDATE SET total_estimated=EXCLUDED.total_estimated
                """), {"account_id": account_id, "tax_year": tax_year, "total_estimated": total})
        for vh in history.get("value_history") or []:
            s.execute(text("""
                INSERT INTO value_history (account_id, tax_year, land_value, improvement_value, market_value, taxable_value)
                VALUES (:account_id, :tax_year, :land_value, :improvement_value, :market_value, :taxable_value)
                ON CONFLICT (account_id, tax_year) DO UPDATE
                SET land_value=EXCLUDED.land_value,
                    improvement_value=EXCLUDED.improvement_value,
                    market_value=EXCLUDED.market_value,
                    taxable_value=EXCLUDED.taxable_value
            """), {**vh, "account_id": account_id})
        for oh in history.get("owner_history") or []:
            s.execute(text("""
                INSERT INTO owner_history (account_id, observed_year, owner_name, mail_address, mail_city, mail_state, mail_zip)
                VALUES (:account_id, :observed_year, :owner_name, :mail_address, :mail_city, :mail_state, :mail_zip)
            """), {"account_id": account_id, "observed_year": oh.get("observed_year"), "owner_name": oh.get("owner_name"),
                    "mail_address": oh.get("mail_address"), "mail_city": oh.get("mail_city"),
                    "mail_state": oh.get("mail_state"), "mail_zip": oh.get("mail_zip")})
