# main.py
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pathlib import Path
import json
import re
from typing import Any, Dict, List

app = FastAPI()

# --- CORS so the Vite app can call us during dev ---
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

DATA_DIR = Path(__file__).parent / "data"
DATA_DIR.mkdir(exist_ok=True)
ACCOUNT_ID_PATTERN = re.compile(r"^[0-9]{17}$", re.ASCII)


def _detail_file_paths(data_dir: Path) -> Dict[str, Path]:
    """Index only direct, numeric fixture files contained by the data directory."""
    paths: Dict[str, Path] = {}
    base_dir = data_dir.resolve()
    for entry in base_dir.iterdir():
        if not entry.is_file() or entry.suffix.lower() != ".json":
            continue
        account_id = entry.stem
        if not ACCOUNT_ID_PATTERN.fullmatch(account_id):
            continue
        candidate = entry.resolve()
        try:
            relative = candidate.relative_to(base_dir)
        except ValueError:
            continue
        if candidate.parent == base_dir and relative.name == entry.name:
            paths[account_id] = candidate
    return paths


def _detail_file_path(account_id: str, data_dir: Path) -> Path | None:
    """Select one server-indexed Dallas parcel fixture by exact account identifier."""
    normalized_account_id = str(account_id)
    if not ACCOUNT_ID_PATTERN.fullmatch(normalized_account_id):
        raise ValueError("invalid_account_id")
    return _detail_file_paths(data_dir).get(normalized_account_id)


def _load_detail_obj(raw: Dict[str, Any]) -> Dict[str, Any]:
    """
    Your files may be either:
      - the pure `detail` object, or
      - the full sample wrapper { "query": "...", "results": [ { "summary": {...}, "detail": {...} } ] }
    This normalizes both to return ONLY the `detail` dict.
    """
    if "detail" in raw and isinstance(raw["detail"], dict):
        return raw["detail"]
    if "results" in raw and isinstance(raw["results"], list) and raw["results"]:
        item = raw["results"][0]
        if "detail" in item and isinstance(item["detail"], dict):
            return item["detail"]
    # If it already looks like a detail object, just return it
    return raw

def _safe_get(d: Dict[str, Any], path: List[str], default=None):
    cur = d
    for key in path:
        if not isinstance(cur, dict) or key not in cur:
            return default
        cur = cur[key]
    return cur

def _to_num(v) -> float:
    if v is None:
        return 0.0
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).replace("$", "").replace(",", "").strip()
    try:
        return float(s)
    except:
        return 0.0

@app.get("/detail/{account_id}")
def get_detail(account_id: str):
    """
    Returns: { "account_id": "...", "detail": {...} }
    The `detail` shape matches your scraper JSON.
    """
    try:
        fp = _detail_file_path(account_id, DATA_DIR)
    except ValueError as error:
        raise HTTPException(status_code=400, detail="Invalid account ID") from error
    if fp is None or not fp.is_file():
        raise HTTPException(status_code=404, detail="Not Found")

    raw = json.loads(fp.read_text(encoding="utf-8"))
    detail = _load_detail_obj(raw)

    return {
        "account_id": account_id,
        "detail": detail,
    }

@app.get("/search")
def search(q: str, limit: int = 5):
    """
    Super-simple search across all JSON files in ./data.
    Returns the standard shape you showed earlier:
      { query, results: [ { summary: {...} } ] }
    """
    q_low = q.lower()
    out = {"query": q, "results": []}

    files = list(DATA_DIR.glob("*.json"))
    for fp in files:
        try:
            raw = json.loads(fp.read_text(encoding="utf-8"))
            detail = _load_detail_obj(raw)
        except Exception:
            continue

        account_id = fp.stem
        addr = _safe_get(detail, ["property_location", "address"], "") or ""
        owner_name = _safe_get(detail, ["owner", "owner_name"], "") or ""
        city = ""  # optional; you can parse from addr if needed

        # quick match by address/owner/account
        haystack = f"{account_id} {addr} {owner_name}".lower()
        if q_low not in haystack:
            continue

        market_from_summary = _to_num(_safe_get(detail, ["value_summary", "market_value"]))
        mv_hist_first = _safe_get(detail, ["history", "market_value"], [])
        if mv_hist_first and isinstance(mv_hist_first, list):
            market_hist_val = _to_num(mv_hist_first[0].get("total_market"))
        else:
            market_hist_val = 0.0

        total_value = "N/A"
        mv = market_from_summary or market_hist_val
        if mv:
            total_value = f"${mv:,.0f}"

        out["results"].append({
            "summary": {
                "account_id": account_id,
                "address": addr or account_id,
                "city": city,
                "owner": owner_name[:120],  # avoid super long strings
                "total_value": total_value if total_value != "N/A" else "Value in Dispute",
                "type": "RESIDENTIAL",
                "detail_url": f"https://www.dallascad.org/AcctDetailRes.aspx?ID={account_id}",
            }
        })

        if len(out["results"]) >= max(1, int(limit)):
            break

    return out
