import asyncio, csv, os, sys, time
from dotenv import load_dotenv
from dcad.fetch import browser, get_detail_html, get_history_html, polite_pause
from dcad.parse_detail import parse_detail_html
from dcad.parse_history import parse_history_html
from dcad.upsert import upsert_parsed
load_dotenv()
DELAY_MIN = float(os.environ.get("BATCH_DELAY_MIN", "0.75"))
RETRIES = int(os.environ.get("BATCH_RETRIES", "3"))
async def scrape_one(page, account_id: str):
    for attempt in range(1, RETRIES+1):
        try:
            t0 = time.time()
            detail_html = await get_detail_html(page, account_id); await polite_pause()
            hist_html = await get_history_html(page, account_id)
            detail = parse_detail_html(detail_html); history = parse_history_html(hist_html)
            upsert_parsed(account_id, detail, history)
            print(f"[OK] {account_id} in {(time.time()-t0)*1000:.0f} ms")
            return True
        except Exception as e:
            print(f"[WARN] {account_id} attempt {attempt}/{RETRIES} failed: {e}")
            await asyncio.sleep(1.5 * attempt)
    print(f"[FAIL] {account_id}"); return False
async def run_batch(accounts):
    async with browser() as page:
        for acct in accounts:
            acct = acct.strip(); if not acct: continue
            await scrape_one(page, acct); await asyncio.sleep(DELAY_MIN)
def load_accounts_from_csv(path):
    with open(path, newline='') as f: return [row[0].strip() for row in csv.reader(f) if row]
if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python batch.py <accounts.csv | comma,separated,ids>"); sys.exit(1)
    arg = sys.argv[1]
    accounts = load_accounts_from_csv(arg) if os.path.isfile(arg) else [a.strip() for a in arg.split(",") if a.strip()]
    asyncio.run(run_batch(accounts))
