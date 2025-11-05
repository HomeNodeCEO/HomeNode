#!/usr/bin/env python
import argparse, csv, json, time, asyncio, os
from urllib.parse import urlencode
import httpx
import psycopg2
from psycopg2.extras import execute_values

def connect_db(dsn: str):
    return psycopg2.connect(dsn)

def existing_accounts(conn):
    with conn.cursor() as cur:
        cur.itersize = 50000
        cur.execute("SELECT account_id FROM properties")
        return {row[0] for row in cur.fetchall()}

def upsert_rows(conn, rows):
    cols = [
        "account_id","situs_address","city","owner_name","total_value","property_type","year_built",
        "stories","bedroom_count","bath_count","living_area_sqft","pool","basement",
        "market_value","land_value","improvement_value","source","raw"
    ]
    if not rows: return
    with conn.cursor() as cur:
        execute_values(cur, f"""
            INSERT INTO properties ({",".join(cols)})
            VALUES %s
            ON CONFLICT (account_id) DO UPDATE SET
              situs_address=EXCLUDED.situs_address,
              city=EXCLUDED.city,
              owner_name=EXCLUDED.owner_name,
              total_value=EXCLUDED.total_value,
              property_type=EXCLUDED.property_type,
              year_built=EXCLUDED.year_built,
              stories=EXCLUDED.stories,
              bedroom_count=EXCLUDED.bedroom_count,
              bath_count=EXCLUDED.bath_count,
              living_area_sqft=EXCLUDED.living_area_sqft,
              pool=EXCLUDED.pool,
              basement=EXCLUDED.basement,
              market_value=EXCLUDED.market_value,
              land_value=EXCLUDED.land_value,
              improvement_value=EXCLUDED.improvement_value,
              last_seen=now(),
              source=EXCLUDED.source,
              raw=EXCLUDED.raw
        """, [tuple(r.get(c) for c in cols) for r in rows])
    conn.commit()

def to_number(x):
    if x in (None, ""): return None
    try:
        return float(str(x).replace(",", "").replace("$", ""))
    except:
        return None

def row_from_detail(d: dict, source="scraper"):
    vs = d.get("value_summary", {}) or d.get("vs", {}) or {}
    return {
        "account_id": d.get("account_id") or d.get("account") or d.get("acct") or d.get("id"),
        "situs_address": d.get("address") or d.get("situs_address"),
        "city": d.get("city"),
        "owner_name": d.get("owner") or d.get("owner_name"),
        "total_value": to_number(vs.get("total_value") or d.get("total_value")),
        "property_type": d.get("type") or d.get("property_type"),
        "year_built": d.get("year_built") or d.get("yr_blt"),
        "stories": d.get("stories") or d.get("stories_display"),
        "bedroom_count": d.get("bedroom_count"),
        "bath_count": d.get("bath_count") or d.get("bath_count_display"),
        "living_area_sqft": d.get("living_area_sqft") or d.get("living_area"),
        "pool": str(d.get("pool") or d.get("pool_display") or "").lower() in ("y","yes","true","1"),
        "basement": str(d.get("basement") or d.get("basement_display") or "").lower() in ("y","yes","true","1"),
        "market_value": to_number(vs.get("market_value")),
        "land_value": to_number(vs.get("land_value")),
        "improvement_value": to_number(vs.get("improvement_value")),
        "source": source,
        "raw": json.dumps(d),
    }

async def search_accounts_paged(api_base: str, street: str, page_size=50, client: httpx.AsyncClient | None = None):
    """Walk pages using offset until empty page."""
    all_ids = []
    offset = 0
    while True:
        params = {"q": street, "include_detail": "0", "max_results": str(page_size), "offset": str(offset)}
        url = f"{api_base}/search/address?{urlencode(params)}"
        r = await client.get(url, timeout=60)
        r.raise_for_status()
        data = r.json()
        page = data.get("results", [])
        if not page:
            break
        for it in page:
            summary = it.get("summary", {})
            acc = summary.get("account_id")
            if acc:
                all_ids.append(acc)
        total = data.get("total")
        offset += len(page)
        if total is not None and offset >= int(total):
            break
        time.sleep(0.1)
    return list(dict.fromkeys(all_ids))

async def fetch_detail(api_base: str, account_id: str, client: httpx.AsyncClient):
    url = f"{api_base}/detail/{account_id}"
    r = await client.get(url, timeout=60)
    r.raise_for_status()
    data = r.json()
    return data.get("detail", data)

async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", required=True)
    ap.add_argument("--db", required=True)
    ap.add_argument("--streets", required=True)
    ap.add_argument("--csv", required=True)
    ap.add_argument("--concurrency", type=int, default=8)
    ap.add_argument("--checkpoint", default="backfill_missing.chk.jsonl")
    ap.add_argument("--max-results", type=int, default=50)
    args = ap.parse_args()

    with open(args.streets, "r", encoding="utf-8") as fh:
        streets = [ln.strip() for ln in fh if ln.strip() and not ln.strip().startswith("#")]

    conn = connect_db(args.db)
    had = existing_accounts(conn)
    print(f"Existing accounts in DB: {len(had):,}")

    done = set()
    if os.path.exists(args.checkpoint):
        with open(args.checkpoint, "r", encoding="utf-8") as ck:
            for ln in ck:
                try:
                    obj = json.loads(ln)
                    if obj.get("account_id"):
                        done.add(obj["account_id"])
                except:
                    pass
        print(f"Resuming; already processed: {len(done):,}")

    async with httpx.AsyncClient(follow_redirects=True) as client:
        candidates = set()
        for st in streets:
            try:
                accs = await search_accounts_paged(args.api, st, page_size=args.max_results, client=client)
                print(f"{st}: {len(accs)} accounts (paged)")
                candidates.update(accs)
                time.sleep(0.2)
            except Exception as e:
                print(f"search failed for {st}: {e}")

        print(f"Unique accounts from street seeds: {len(candidates):,}")

        missing = [a for a in candidates if (a not in had and a not in done)]
        print(f"Missing accounts to fetch: {len(missing):,}")

        out_cols = [
            "account_id","situs_address","city","owner_name","total_value","property_type","year_built",
            "stories","bedroom_count","bath_count","living_area_sqft","pool","basement",
            "market_value","land_value","improvement_value"
        ]
        os.makedirs(os.path.dirname(args.csv), exist_ok=True)
        csvfh = open(args.csv, "a", newline="", encoding="utf-8")
        writer = csv.DictWriter(csvfh, fieldnames=out_cols)
        if csvfh.tell() == 0:
            writer.writeheader()

        sem = asyncio.Semaphore(max(1, args.concurrency))
        batch, wrote = [], 0

        async def work(acc):
            async with sem:
                try:
                    d = await fetch_detail(args.api, acc, client)
                    row = row_from_detail(d, source="scraper")
                    if row["account_id"]:
                        writer.writerow({k: row.get(k) for k in out_cols})
                        batch.append(row)
                    with open(args.checkpoint, "a", encoding="utf-8") as ck:
                        ck.write(json.dumps({"account_id": acc}) + "\n")
                    return True
                except Exception as e:
                    print(f"detail failed for {acc}: {e}")
                    with open(args.checkpoint, "a", encoding="utf-8") as ck:
                        ck.write(json.dumps({"account_id": acc, "error": str(e)}) + "\n")
                    return False

        CHUNK = 200
        for i in range(0, len(missing), CHUNK):
            chunk = missing[i:i+CHUNK]
            _ = await asyncio.gather(*[work(a) for a in chunk])
            try:
                upsert_rows(conn, batch)
                wrote += len(batch)
                batch.clear()
                print(f"Upserted total: {wrote:,} / {len(missing):,}")
            except Exception as e:
                print("upsert error:", e)
            time.sleep(0.5)

        csvfh.close()
    conn.close()
    print("DONE")

if __name__ == "__main__":
    asyncio.run(main())
