import { useCallback, useEffect, useState } from "react";
import {
  getLocationBackfillStatus,
  getSalesReconciliationQueue,
  reconcileSalesSourceRecord,
  searchAccounts,
  type AccountRow,
  type LocationBackfillStatus,
  type SalesReconciliationQueueItem,
  type SalesReconciliationQueueResponse,
} from "@/lib/api";

const PAGE_SIZE = 10;
const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

type Draft = {
  accountId: string;
  accountQuery: string;
  notes: string;
  results: AccountRow[];
  searching: boolean;
  saving: boolean;
  error: string | null;
};

function emptyDraft(item: SalesReconciliationQueueItem): Draft {
  return {
    accountId: item.primary_account_id || "",
    accountQuery: item.address_hint || item.parcel_number_raw || "",
    notes: "",
    results: [],
    searching: false,
    saving: false,
    error: null,
  };
}

function displayDate(value: string | null) {
  if (!value) return "Date unavailable";
  const parsed = new Date(`${value.slice(0, 10)}T12:00:00`);
  return Number.isNaN(parsed.valueOf())
    ? value
    : parsed.toLocaleDateString("en-US");
}

export default function SalesReconciliationQueue() {
  const [queue, setQueue] = useState<SalesReconciliationQueueResponse | null>(null);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [locationStatus, setLocationStatus] = useState<LocationBackfillStatus | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [editorKey, setEditorKey] = useState(() =>
    window.sessionStorage.getItem("homenode-editor-key") || "",
  );

  const loadQueue = useCallback(async (nextOffset = offset) => {
    setLoading(true);
    setError(null);
    try {
      const response = await getSalesReconciliationQueue(PAGE_SIZE, nextOffset);
      setQueue(response);
      setOffset(response.offset);
      setDrafts((current) => {
        const next = { ...current };
        for (const item of response.items) {
          const key = String(item.source_record_id);
          if (!next[key]) next[key] = emptyDraft(item);
        }
        return next;
      });
    } catch (loadError: any) {
      setError(loadError?.message || "Unable to load the sales reconciliation queue.");
    } finally {
      setLoading(false);
    }
  }, [offset]);

  const loadLocationStatus = useCallback(async () => {
    try {
      setLocationStatus(await getLocationBackfillStatus());
    } catch {
      // Reconciliation remains usable if the background-health endpoint is unavailable.
    }
  }, []);

  useEffect(() => {
    void loadQueue(0);
    void loadLocationStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function updateDraft(sourceRecordId: string | number, update: Partial<Draft>) {
    const key = String(sourceRecordId);
    setDrafts((current) => {
      const item = queue?.items.find(
        (candidate) => String(candidate.source_record_id) === key,
      );
      const base = current[key] || (item ? emptyDraft(item) : null);
      if (!base) return current;
      return { ...current, [key]: { ...base, ...update } };
    });
  }

  async function searchCad(item: SalesReconciliationQueueItem) {
    const key = String(item.source_record_id);
    const draft = drafts[key] || emptyDraft(item);
    const query = draft.accountQuery.trim();
    if (!query) {
      updateDraft(key, { error: "Enter an address or 17-character CAD account ID." });
      return;
    }
    updateDraft(key, { searching: true, error: null, results: [] });
    try {
      const results = await searchAccounts(query, 8);
      updateDraft(key, {
        searching: false,
        results,
        error: results.length ? null : "No CAD accounts matched that search.",
      });
    } catch (searchError: any) {
      updateDraft(key, {
        searching: false,
        error: searchError?.message || "CAD account search failed.",
      });
    }
  }

  async function saveMatch(item: SalesReconciliationQueueItem) {
    const key = String(item.source_record_id);
    const draft = drafts[key] || emptyDraft(item);
    if (!editorKey.trim()) {
      updateDraft(key, { error: "Enter your personal editor key before saving." });
      return;
    }
    if (!/^[0-9A-Za-z]{17}$/.test(draft.accountId.trim())) {
      updateDraft(key, { error: "Select or enter a valid 17-character CAD account ID." });
      return;
    }
    updateDraft(key, { saving: true, error: null });
    try {
      await reconcileSalesSourceRecord(
        item.source_record_id,
        {
          account_id: draft.accountId.trim(),
          notes: draft.notes.trim() || null,
          reviewer: "HomeNode sales reconciliation",
        },
        editorKey.trim(),
      );
      window.sessionStorage.setItem("homenode-editor-key", editorKey.trim());
      setDrafts((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
      await loadQueue(offset);
      void loadLocationStatus();
    } catch (saveError: any) {
      updateDraft(key, {
        saving: false,
        error:
          saveError?.message === "invalid_editor_key"
            ? "The editor key was not accepted."
            : saveError?.message || "The verified sale could not be saved.",
      });
    }
  }

  return (
    <section className="sales-reconciliation">
      <div className="sales-reconciliation__header">
        <div>
          <h2>Sales Reconciliation Queue</h2>
          <p>
            Unmatched MLS sales stay here until their CAD account is manually verified. Saving a match upserts the sale immediately; any missing Dallas parcel coordinates are completed by the background mapping queue.
          </p>
        </div>
        <div className="sales-reconciliation__count">
          {queue?.total.toLocaleString() ?? "—"} awaiting review
        </div>
      </div>

      {locationStatus && (
        <div className="sales-reconciliation__location-status">
          <div>
            <span>Mapped sales-account coverage</span>
            <strong>{locationStatus.coverage.coverage_percent.toFixed(2)}%</strong>
          </div>
          <div>
            <span>Located</span>
            <strong>
              {locationStatus.coverage.located_sale_account_count.toLocaleString()}
              {' / '}
              {locationStatus.coverage.sale_account_count.toLocaleString()}
            </strong>
          </div>
          <div>
            <span>Background queue</span>
            <strong>
              {(locationStatus.queue.pending +
                locationStatus.queue.processing +
                locationStatus.queue.retry).toLocaleString()}
            </strong>
          </div>
          <div>
            <span>Location review</span>
            <strong>{locationStatus.queue.manual_review.toLocaleString()}</strong>
          </div>
        </div>
      )}

      <label className="sales-reconciliation__editor">
        <span>Personal editor key</span>
        <input
          type="password"
          value={editorKey}
          onChange={(event) => setEditorKey(event.target.value)}
          placeholder="Required only when saving"
          autoComplete="off"
        />
      </label>

      {loading && <div className="sales-reconciliation__status">Loading reconciliation queue…</div>}
      {error && <div className="sales-reconciliation__error">{error}</div>}
      {!loading && !error && queue?.items.length === 0 && (
        <div className="sales-reconciliation__empty">No unresolved closed sales remain.</div>
      )}

      <div className="sales-reconciliation__list">
        {queue?.items.map((item) => {
          const key = String(item.source_record_id);
          const draft = drafts[key] || emptyDraft(item);
          const salePrice = Number(item.sale_price);
          return (
            <article className="sales-reconciliation__card" key={key}>
              <div className="sales-reconciliation__facts">
                <div>
                  <strong>MLS {item.listing_id || "number unavailable"}</strong>
                  <span>{displayDate(item.closing_date)} · {Number.isFinite(salePrice) ? money.format(salePrice) : "Price unavailable"}</span>
                </div>
                <div>
                  <strong>Source parcel</strong>
                  <span>{[item.parcel_number_raw, item.parcel_number2_raw].filter(Boolean).join(" / ") || "No usable parcel supplied"}</span>
                </div>
                <div>
                  <strong>MLS characteristics</strong>
                  <span>{item.living_area ? `${Number(item.living_area).toLocaleString()} SF` : "SF unavailable"} · {item.bedrooms_total ?? "—"} bd · {item.bathrooms_full ?? item.bathrooms_total_integer ?? "—"}.{item.bathrooms_half ?? 0} ba</span>
                </div>
                <div>
                  <strong>Classification</strong>
                  <span>{item.structural_style || item.attachment_type || "Unspecified"}</span>
                </div>
              </div>

              <div className="sales-reconciliation__badges">
                {item.queue_reasons.map((reason) => <span key={reason}>{reason}</span>)}
              </div>

              <div className="sales-reconciliation__controls">
                <label>
                  <span>Search CAD by address or account ID</span>
                  <div className="sales-reconciliation__search-row">
                    <input
                      value={draft.accountQuery}
                      onChange={(event) => updateDraft(key, { accountQuery: event.target.value })}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void searchCad(item);
                        }
                      }}
                      placeholder="Paste the MLS address or CAD account ID"
                    />
                    <button type="button" onClick={() => void searchCad(item)} disabled={draft.searching}>
                      {draft.searching ? "Searching…" : "Search CAD"}
                    </button>
                  </div>
                </label>

                {draft.results.length > 0 && (
                  <div className="sales-reconciliation__results">
                    {draft.results.map((account) => (
                      <button
                        type="button"
                        key={account.account_id}
                        onClick={() => updateDraft(key, {
                          accountId: account.canonical_account_id || account.account_id,
                          accountQuery: account.address || account.account_id,
                          results: [],
                          error: null,
                        })}
                      >
                        <strong>{account.address || "Address unavailable"}</strong>
                        <span>{account.account_id} · {[account.city, account.postal_code].filter(Boolean).join(" ")}</span>
                      </button>
                    ))}
                  </div>
                )}

                <div className="sales-reconciliation__save-grid">
                  <label>
                    <span>Verified CAD account ID</span>
                    <input
                      value={draft.accountId}
                      onChange={(event) => updateDraft(key, { accountId: event.target.value })}
                      placeholder="17-character account ID"
                    />
                  </label>
                  <label>
                    <span>Review note (optional)</span>
                    <input
                      value={draft.notes}
                      onChange={(event) => updateDraft(key, { notes: event.target.value })}
                      placeholder="How the account was confirmed"
                    />
                  </label>
                  <button type="button" onClick={() => void saveMatch(item)} disabled={draft.saving}>
                    {draft.saving ? "Saving…" : "Save & Upsert Sale"}
                  </button>
                </div>
                {draft.error && <div className="sales-reconciliation__error">{draft.error}</div>}
              </div>
            </article>
          );
        })}
      </div>

      {queue && queue.total > PAGE_SIZE && (
        <div className="sales-reconciliation__pagination">
          <button type="button" disabled={offset === 0 || loading} onClick={() => void loadQueue(Math.max(0, offset - PAGE_SIZE))}>Previous</button>
          <span>{offset + 1}–{Math.min(offset + queue.items.length, queue.total)} of {queue.total.toLocaleString()}</span>
          <button type="button" disabled={offset + PAGE_SIZE >= queue.total || loading} onClick={() => void loadQueue(offset + PAGE_SIZE)}>Next</button>
        </div>
      )}

      <style>{`
        .sales-reconciliation { margin-top: 22px; border: 1px solid #cbd5e1; border-radius: 16px; background: #f8fafc; padding: 16px; display: grid; gap: 14px; }
        .sales-reconciliation__header { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; }
        .sales-reconciliation__header h2 { margin: 0; font-size: 20px; color: #0f172a; }
        .sales-reconciliation__header p { margin: 6px 0 0; max-width: 820px; color: #475569; font-size: 13px; line-height: 1.5; }
        .sales-reconciliation__count { white-space: nowrap; border-radius: 999px; background: #fef3c7; color: #92400e; padding: 6px 10px; font-size: 12px; font-weight: 700; }
        .sales-reconciliation__location-status { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; border: 1px solid #bfdbfe; border-radius: 12px; background: #eff6ff; padding: 10px; }
        .sales-reconciliation__location-status div { display: grid; gap: 2px; }
        .sales-reconciliation__location-status span { color: #475569; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; }
        .sales-reconciliation__location-status strong { color: #1e3a8a; font-size: 15px; }
        .sales-reconciliation__editor { display: grid; gap: 5px; max-width: 360px; font-size: 12px; font-weight: 700; color: #334155; }
        .sales-reconciliation input { width: 100%; box-sizing: border-box; border: 1px solid #cbd5e1; border-radius: 8px; padding: 8px 10px; background: white; }
        .sales-reconciliation button { border: 1px solid #2563eb; border-radius: 8px; padding: 8px 11px; background: #2563eb; color: white; font-weight: 700; cursor: pointer; }
        .sales-reconciliation button:disabled { cursor: not-allowed; opacity: .55; }
        .sales-reconciliation__list { display: grid; gap: 12px; }
        .sales-reconciliation__card { border: 1px solid #e2e8f0; border-radius: 12px; background: white; padding: 14px; display: grid; gap: 12px; }
        .sales-reconciliation__facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; }
        .sales-reconciliation__facts div { display: grid; gap: 4px; min-width: 0; }
        .sales-reconciliation__facts strong { color: #0f172a; font-size: 13px; }
        .sales-reconciliation__facts span { color: #64748b; font-size: 12px; overflow-wrap: anywhere; }
        .sales-reconciliation__badges { display: flex; flex-wrap: wrap; gap: 6px; }
        .sales-reconciliation__badges span { border-radius: 999px; background: #ffedd5; color: #9a3412; padding: 3px 8px; font-size: 11px; font-weight: 700; }
        .sales-reconciliation__controls { display: grid; gap: 9px; border-top: 1px solid #e2e8f0; padding-top: 12px; }
        .sales-reconciliation__controls label { display: grid; gap: 5px; color: #334155; font-size: 12px; font-weight: 700; }
        .sales-reconciliation__search-row { display: grid; grid-template-columns: 1fr auto; gap: 8px; }
        .sales-reconciliation__results { display: grid; gap: 6px; border: 1px solid #dbeafe; border-radius: 10px; padding: 7px; background: #eff6ff; }
        .sales-reconciliation__results button { display: grid; gap: 3px; text-align: left; background: white; color: #1e3a8a; border-color: #bfdbfe; }
        .sales-reconciliation__results span { font-size: 11px; font-weight: 500; color: #475569; }
        .sales-reconciliation__save-grid { display: grid; grid-template-columns: minmax(210px, .8fr) minmax(260px, 1.2fr) auto; gap: 8px; align-items: end; }
        .sales-reconciliation__error { border-radius: 8px; background: #fef2f2; color: #b91c1c; padding: 8px 10px; font-size: 12px; }
        .sales-reconciliation__status, .sales-reconciliation__empty { color: #475569; font-size: 13px; }
        .sales-reconciliation__pagination { display: flex; justify-content: flex-end; align-items: center; gap: 10px; color: #475569; font-size: 12px; }
        .sales-reconciliation__pagination button { background: white; color: #1d4ed8; }
        @media (max-width: 760px) {
          .sales-reconciliation__header { display: grid; }
          .sales-reconciliation__count { width: fit-content; }
          .sales-reconciliation__save-grid, .sales-reconciliation__search-row { grid-template-columns: 1fr; }
        }
      `}</style>
    </section>
  );
}
