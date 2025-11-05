from __future__ import annotations

import os
import sys
import json
from typing import Any, Dict, List, Optional

from sqlalchemy import create_engine, text


def env_schema() -> Optional[str]:
    return os.getenv("DB_SCHEMA") or os.getenv("DCAD_SCHEMA") or os.getenv("PGSCHEMA")


def tbl(name: str, schema: Optional[str]) -> str:
    return f"{schema}.{name}" if schema else name


def money(v: Any) -> str:
    try:
        if v is None:
            return ""
        s = str(v)
        if s == "":
            return ""
        # Already numeric-ish
        n = float(s)
        return f"${n:,.2f}"
    except Exception:
        return str(v or "")


def print_row(prefix: str, row: Dict[str, Any], keys: List[str]) -> None:
    vals = []
    for k in keys:
        v = row.get(k)
        vals.append(f"{k}={v if v is not None else ''}")
    print(f"{prefix} " + ", ".join(vals))


def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: python -m dcad.report <ACCOUNT_ID>")
        sys.exit(2)

    account_id = sys.argv[1].strip()
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        print("ERROR: DATABASE_URL not set")
        sys.exit(2)

    schema = env_schema() or "core"
    eng = create_engine(db_url, future=True)

    with eng.connect() as conn:
        print(f"== DCAD Report for account_id={account_id} (schema={schema}) ==")

        # Accounts (basic)
        row = conn.execute(text(f"SELECT account_id, address, neighborhood_code FROM {tbl('accounts', schema)} WHERE account_id=:id"), {"id": account_id}).mappings().first()
        if row:
            print_row("Account:", dict(row), ["address", "neighborhood_code"]) 
        else:
            print("Account: (not present in accounts table)")

        # Primary Improvements
        pi = conn.execute(text(f"SELECT * FROM {tbl('primary_improvements', schema)} WHERE account_id=:id"), {"id": account_id}).mappings().first()
        if pi:
            fields = [
                ("stories", pi.get("stories")), ("living_area_sqft", pi.get("living_area_sqft")),
                ("bedroom_count", pi.get("bedroom_count")), ("bath_count", pi.get("bath_count")),
                ("year_built", pi.get("year_built")), ("construction_type", pi.get("construction_type")),
                ("foundation", pi.get("foundation")), ("roof_type", pi.get("roof_type")),
            ]
            kv = ", ".join(f"{k}={v if v is not None else ''}" for k, v in fields)
            print(f"Primary Improvements: {kv}")
        else:
            print("Primary Improvements: (none)")

        # Secondary Improvements (count + first few)
        sec_count = conn.execute(text(f"SELECT count(*) FROM {tbl('secondary_improvements', schema)} WHERE account_id=:id"), {"id": account_id}).scalar() or 0
        print(f"Secondary Improvements: {sec_count} rows")
        if sec_count:
            sec_rows = conn.execute(text(f"SELECT sec_imp_number, sec_imp_type, sec_imp_desc, sec_imp_sqft, sec_imp_value FROM {tbl('secondary_improvements', schema)} WHERE account_id=:id ORDER BY sec_imp_number LIMIT 5"), {"id": account_id}).mappings().all()
            for r in sec_rows:
                v = money(r.get("sec_imp_value"))
                print(f"  - #{r.get('sec_imp_number')} {r.get('sec_imp_type')}: {r.get('sec_imp_desc')} (sqft={r.get('sec_imp_sqft')}, value={v})")

        # Owner
        osum = conn.execute(text(f"SELECT tax_year, owner_name FROM {tbl('owner_summary', schema)} WHERE account_id=:id ORDER BY tax_year DESC LIMIT 1"), {"id": account_id}).mappings().first()
        if osum:
            print(f"Owner Summary: {osum.get('owner_name')} (tax_year={osum.get('tax_year')})")
            parts = conn.execute(text(f"SELECT owner_name, ownership_pct FROM {tbl('owner_parties', schema)} WHERE account_id=:id AND tax_year=:y ORDER BY owner_name"), {"id": account_id, "y": osum.get("tax_year")}).mappings().all()
            for p in parts[:5]:
                print(f"  - {p.get('owner_name')} ({p.get('ownership_pct') or ''}%)")
            if len(parts) > 5:
                print(f"  (+{len(parts)-5} more)")
        else:
            print("Owner Summary: (none)")

        # Value Summary (current)
        vcur = conn.execute(text(f"SELECT certified_year, improvement_value, land_value, market_value, capped_value FROM {tbl('value_summary_current', schema)} WHERE account_id=:id"), {"id": account_id}).mappings().first()
        if vcur:
            print("Value Summary Current:")
            print(f"  - certified_year={vcur.get('certified_year')}, improvement={money(vcur.get('improvement_value'))}, land={money(vcur.get('land_value'))}, market={money(vcur.get('market_value'))}, capped={money(vcur.get('capped_value'))}")
        else:
            print("Value Summary Current: (none)")

        # Ownership history (latest 5)
        own_hist = conn.execute(text(f"SELECT observed_year, deed_transfer_date_raw, deed_transfer_date FROM {tbl('ownership_history', schema)} WHERE account_id=:id ORDER BY observed_year DESC LIMIT 5"), {"id": account_id}).mappings().all()
        if own_hist:
            print("Ownership History (latest 5 years):")
            for r in own_hist:
                print(f"  - {r.get('observed_year')}: deed_raw={r.get('deed_transfer_date_raw') or ''}, deed_date={r.get('deed_transfer_date') or ''}")

        # Market Value History (last 5)
        mv_hist = conn.execute(text(f"SELECT tax_year, imp_value, land_value, total_market_value FROM {tbl('market_value_history', schema)} WHERE account_id=:id ORDER BY tax_year DESC LIMIT 5"), {"id": account_id}).mappings().all()
        if mv_hist:
            print("Market Value History (latest 5):")
            for r in mv_hist:
                print(f"  - {r.get('tax_year')}: imp={money(r.get('imp_value'))}, land={money(r.get('land_value'))}, total={money(r.get('total_market_value'))}")

        # Taxable Value History (last 5 years condensed)
        tv_hist = conn.execute(text(f"SELECT tax_year, jurisdiction_key, taxable_value FROM {tbl('taxable_value_history', schema)} WHERE account_id=:id ORDER BY tax_year DESC, jurisdiction_key"), {"id": account_id}).mappings().all()
        if tv_hist:
            print("Taxable Value History (condensed):")
            by_year: Dict[int, Dict[str, Any]] = {}
            for r in tv_hist:
                y = r.get("tax_year")
                by_year.setdefault(y, {})[r.get("jurisdiction_key")] = r.get("taxable_value")
            shown = 0
            for y in sorted(by_year.keys(), reverse=True):
                row = by_year[y]
                parts = [f"{k}={money(row.get(k))}" for k in ["city","county","school","college","hospital","special_district"] if k in row]
                print(f"  - {y}: " + ", ".join(parts))
                shown += 1
                if shown >= 5:
                    break

        # Exemptions (current)
        ex_rows = conn.execute(text(f"SELECT jurisdiction_key, taxing_jurisdiction, homestead_exemption, taxable_value FROM {tbl('exemptions_summary', schema)} WHERE account_id=:id ORDER BY jurisdiction_key"), {"id": account_id}).mappings().all()
        if ex_rows:
            print("Exemptions (current):")
            for r in ex_rows:
                print(f"  - {r.get('jurisdiction_key')}: unit={r.get('taxing_jurisdiction')}, homestead={money(r.get('homestead_exemption'))}, taxable={money(r.get('taxable_value'))}")

        # Land detail (current year, sample)
        land = conn.execute(text(f"SELECT tax_year, line_number, zoning, area_sqft, unit_price, adjusted_price FROM {tbl('land_detail', schema)} WHERE account_id=:id ORDER BY line_number"), {"id": account_id}).mappings().all()
        if land:
            print("Land Detail:")
            for r in land[:5]:
                print(f"  - line {r.get('line_number')}: zoning={r.get('zoning')}, area={r.get('area_sqft')}, unit={money(r.get('unit_price'))}, adjusted={money(r.get('adjusted_price'))}")
            if len(land) > 5:
                print(f"  (+{len(land)-5} more)")

        # Legal description (current)
        lcur = conn.execute(text(f"SELECT tax_year, legal_text, deed_transfer_raw FROM {tbl('legal_description_current', schema)} WHERE account_id=:id"), {"id": account_id}).mappings().first()
        if lcur:
            print("Legal Description (current):")
            print(f"  - tax_year={lcur.get('tax_year')}, deed_transfer={lcur.get('deed_transfer_raw') or ''}")
            txt = (lcur.get('legal_text') or '')
            print(f"  - {txt[:240]}{'…' if txt and len(txt)>240 else ''}")

        # Estimated taxes (current)
        et_rows = conn.execute(text(f"SELECT jurisdiction_key, taxing_unit, tax_rate_per_100, taxable_value, estimated_taxes_amt, tax_ceiling FROM {tbl('estimated_taxes', schema)} WHERE account_id=:id ORDER BY jurisdiction_key"), {"id": account_id}).mappings().all()
        if et_rows:
            print("Estimated Taxes (current):")
            for r in et_rows:
                print(f"  - {r.get('jurisdiction_key')}: rate={r.get('tax_rate_per_100') or ''}, taxable={money(r.get('taxable_value'))}, est={money(r.get('estimated_taxes_amt'))}, ceiling={money(r.get('tax_ceiling'))}")
        tot = conn.execute(text(f"SELECT tax_year, total_estimated FROM {tbl('estimated_taxes_total', schema)} WHERE account_id=:id"), {"id": account_id}).mappings().first()
        if tot:
            print(f"Estimated Taxes Total: {money(tot.get('total_estimated'))} (tax_year={tot.get('tax_year')})")


if __name__ == "__main__":
    main()
