# scraper/api/main.py

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import RedirectResponse
from typing import Optional, Dict, Any

# ---- Relative imports into the dcad package ----
# (works when running: uvicorn scraper.api.main:app --reload)
from ..dcad.lookup import lookup_account
from ..dcad.fetch import get_detail_html, get_history_html, polite_pause
from ..dcad.parse_detail import parse_detail_html

# History parsing is optional — only import if you have it
try:
    from ..dcad.parse_history import parse_history_html  # noqa: F401
    HAS_HISTORY = True
except Exception:
    HAS_HISTORY = False

# Upsert is optional; if DB isn't configured, we skip it gracefully
try:
    from ..dcad.upsert import upsert_parsed  # noqa: F401
    HAS_UPSERT = True
except Exception:
    HAS_UPSERT = False

app = FastAPI(title="DCAD Scraper API", version="1.0.0")
from fastapi.middleware.cors import CORSMiddleware

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/")
def root():
    # Quick link to Swagger UI
    return RedirectResponse(url="/docs")


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/lookup")
async def lookup(
    account: str = Query(..., description="DCAD account number"),
    debug: bool = Query(False, description="If true, skip DB upsert and return raw data only"),
) -> Dict[str, Any]:
    """
    Fetch DCAD detail (and optionally history) for an account, parse it,
    and (optionally) upsert into the database.
    """
    try:
        # Normalize/validate the account (if your lookup does a transform)
        acct_id = lookup_account(account) if callable(lookup_account) else account

        # --- Fetch pages (async) ---
        detail_html = await get_detail_html(acct_id)
        if not detail_html:
            raise HTTPException(status_code=404, detail="Detail page not found or empty")

        # history is optional
        history_html: Optional[str] = None
        if HAS_HISTORY:
            # Be polite if you want to space requests out
            await polite_pause()
            try:
                history_html = await get_history_html(acct_id)
            except Exception:
                # Don't fail the whole request if history fails
                history_html = None

        # --- Parse pages ---
        detail = parse_detail_html(detail_html)

        history_parsed: Optional[Dict[str, Any]] = None
        if HAS_HISTORY and history_html:
            try:
                history_parsed = parse_history_html(history_html)
            except Exception:
                history_parsed = None

        payload: Dict[str, Any] = {
            "account_id": acct_id,
            "detail": detail,
        }
        if history_parsed is not None:
            payload["history"] = history_parsed

        # --- Optional DB upsert (skip when debug=true or upsert unavailable) ---
        if not debug and HAS_UPSERT:
            try:
                await upsert_parsed(acct_id, detail=detail, history=history_parsed)
                payload["db_upsert"] = "ok"
            except Exception as e:
                # Don't kill the API response if DB write fails; surface the error
                payload["db_upsert"] = f"error: {e.__class__.__name__}: {e}"

        return payload

    except HTTPException:
        # re-raise FastAPI HTTP errors
        raise
    except Exception as e:
        # Unknown/unexpected errors -> 500
        raise HTTPException(status_code=500, detail=str(e))
