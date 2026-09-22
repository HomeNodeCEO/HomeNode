# main.py
from pathlib import Path
from typing import Annotated

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from app.search_index import (
    ACCOUNT_ID_PATTERN,
    MAX_SEARCH_QUERY_CHARS,
    MAX_SEARCH_RESULTS,
    SearchCapacityError,
    SearchConcurrencyGuard,
    build_data_snapshot,
    read_bounded_detail,
    search_snapshot,
)

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
DATA_SNAPSHOT = build_data_snapshot(DATA_DIR)
SEARCH_GUARD = SearchConcurrencyGuard()


@app.get("/detail/{account_id}")
def get_detail(account_id: str):
    """
    Returns: { "account_id": "...", "detail": {...} }
    The `detail` shape matches your scraper JSON.
    """
    if not ACCOUNT_ID_PATTERN.fullmatch(str(account_id)):
        raise HTTPException(status_code=400, detail="Invalid account ID")
    fp = DATA_SNAPSHOT.detail_files.get(account_id)
    if fp is None or not fp.is_file():
        raise HTTPException(status_code=404, detail="Not Found")

    detail = read_bounded_detail(fp)

    return {
        "account_id": account_id,
        "detail": detail,
    }


@app.get("/search")
def search(
    q: Annotated[str, Query(min_length=1, max_length=MAX_SEARCH_QUERY_CHARS)],
    limit: Annotated[int, Query(ge=1, le=MAX_SEARCH_RESULTS)] = 5,
):
    """
    Super-simple search across all JSON files in ./data.
    Returns the standard shape you showed earlier:
      { query, results: [ { summary: {...} } ] }
    """
    try:
        with SEARCH_GUARD.slot():
            return search_snapshot(DATA_SNAPSHOT, q, limit)
    except SearchCapacityError as error:
        raise HTTPException(
            status_code=503,
            detail="Search temporarily unavailable",
            headers={"Retry-After": "1"},
        ) from error
    except ValueError as error:
        raise HTTPException(status_code=400, detail="Invalid search query or limit") from error
