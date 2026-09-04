import type { AssignmentDetailsPayload } from "@/lib/api";
import { CheckboxChoice } from "@/components/PropertyReportControls";
import {
  activityTypeClass,
  activityTypeLabel,
  displayValue,
  formatDate,
  formatMoney,
  hasValue,
  sellerComparisonSummary,
} from "@/lib/propertyReportPresentation";

export type PropertyActivityRow = {
  sale_id?: string | number;
  source_record_id?: string | number;
  listing_key?: string;
  listing_id?: string;
  source?: string;
  activity_date?: string;
  listing_date?: string;
  contract_date?: string;
  closing_date?: string;
  list_price?: string | number;
  sale_price?: string | number;
  days_on_market?: string | number;
  buyer_financing?: string;
  concessions?: string | number;
  mls_status?: string;
  record_type?: string;
  requires_additional_review?: boolean;
  data_quality_flags?: string[];
};

const CONTRACT_AMOUNT_FIELDS = [
  ["contract_price", "Contract Price"],
  ["loan_amount", "Loan Amount"],
  ["down_payment", "Down Payment"],
  ["earnest_money", "Earnest Money"],
  ["seller_concessions", "Seller Concessions"],
] as const;

export default function ListingsContractsSalesContent({
  listingRows,
  salesHistoryRows,
  assignmentDraft,
  purchaseTransactionSelected,
  assignmentErrors,
  assignmentDirty,
  assignmentSaveMessage,
  assignmentSaveDisabled,
  savingAssignmentFile,
  contractSellerComparison,
  onAssignmentChange,
  onSave,
}: {
  listingRows: PropertyActivityRow[];
  salesHistoryRows: PropertyActivityRow[];
  assignmentDraft: AssignmentDetailsPayload;
  purchaseTransactionSelected: boolean;
  assignmentErrors: string[];
  assignmentDirty: boolean;
  assignmentSaveMessage: string;
  assignmentSaveDisabled: boolean;
  savingAssignmentFile: boolean;
  contractSellerComparison: ReturnType<typeof sellerComparisonSummary>;
  onAssignmentChange: <K extends keyof AssignmentDetailsPayload>(
    key: K,
    value: AssignmentDetailsPayload[K],
  ) => void;
  onSave: () => void;
}) {
  const listingColumns =
    "minmax(150px,1.2fr) minmax(115px,.85fr) minmax(115px,.85fr) minmax(115px,.85fr) minmax(150px,1.1fr) minmax(130px,1fr)";
  const salesColumns =
    "minmax(100px,.9fr) minmax(100px,.8fr) minmax(70px,.6fr) minmax(160px,1.3fr) minmax(110px,.9fr) minmax(110px,.9fr) minmax(70px,.5fr) minmax(190px,1.5fr)";

  return (
    <>
      <section>
        <div className="mb-3">
          <h3 className="text-sm font-semibold text-slate-900">Listings</h3>
          <p className="mt-0.5 text-xs text-slate-500">
            Consolidated MLS listing dates, contract activity, and closing terms.
          </p>
        </div>
        {listingRows.length ? (
          <div className="overflow-x-auto">
            <div className="min-w-[900px]">
              <div
                className="grid items-end gap-x-4 border-b border-slate-300 px-1 pb-2 text-xs font-semibold uppercase tracking-wide text-slate-600"
                style={{ gridTemplateColumns: listingColumns }}
              >
                <div>MLS / Source #</div><div>List Date</div><div>Contract Date</div>
                <div>Closing Date</div><div>Financing Type</div><div>Concessions</div>
              </div>
              {listingRows.slice(0, 20).map((event, index) => (
                <div
                  key={event.listing_id || event.listing_key || event.source_record_id || index}
                  className="grid items-start gap-x-4 border-b border-slate-200 px-1 py-2.5 text-sm last:border-b-0"
                  style={{ gridTemplateColumns: listingColumns }}
                >
                  <div>
                    <div className="font-medium text-slate-800">
                      {displayValue(event.listing_id || event.listing_key || event.source_record_id, "—")}
                    </div>
                    <div className="text-[11px] text-slate-500">{displayValue(event.source, "Source not reported")}</div>
                  </div>
                  <div className="whitespace-nowrap">{formatDate(event.listing_date)}</div>
                  <div className="whitespace-nowrap">{formatDate(event.contract_date)}</div>
                  <div className="whitespace-nowrap">{formatDate(event.closing_date)}</div>
                  <div>{displayValue(event.buyer_financing)}</div>
                  <div>{displayValue(event.concessions)}</div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-slate-300 bg-white p-4 text-sm text-slate-600">
            No linked MLS listing records are currently available for this parcel.
          </div>
        )}
      </section>

      <section className="mt-6 border-t border-slate-200 pt-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">Contract Analysis</h3>
            <p className="mt-0.5 text-xs text-slate-500">
              Assignment-specific contract terms and seller-to-public-record verification. Approved purchase-contract evidence opens and populates this section automatically.
            </p>
          </div>
          <div className="min-w-[230px]">
            <CheckboxChoice
              checked={Boolean(assignmentDraft.subject_under_contract)}
              label="Subject Under Contract"
              disabled={!purchaseTransactionSelected}
              onChange={(checked) => onAssignmentChange("subject_under_contract", checked)}
            />
          </div>
        </div>

        {!purchaseTransactionSelected ? (
          <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-900">
            Select Purchase Transaction before marking this manually. An approved purchase contract will add Purchase Transaction automatically as an E&amp;O fallback.
          </div>
        ) : null}

        <div className="mt-4 space-y-4">
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              <label className="block lg:col-span-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">Contract Buyer Name(s)</span>
                <input
                  type="text" maxLength={1000} className="input input-bordered input-sm mt-1 w-full bg-white"
                  value={assignmentDraft.contract_buyer_names || ""}
                  onChange={(event) => onAssignmentChange("contract_buyer_names", event.target.value)}
                  placeholder="Buyer name exactly as shown in the contract"
                />
              </label>
              <label className="block lg:col-span-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">Contract Seller Name(s)</span>
                <input
                  type="text" maxLength={1000} className="input input-bordered input-sm mt-1 w-full bg-white"
                  value={assignmentDraft.contract_seller_names || ""}
                  onChange={(event) => onAssignmentChange("contract_seller_names", event.target.value)}
                  placeholder="Seller name exactly as shown in the contract"
                />
              </label>
              <label className="block">
                <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">Contract Date</span>
                <input
                  type="date" className="input input-bordered input-sm mt-1 w-full bg-white"
                  value={String(assignmentDraft.contract_date || "").slice(0, 10)}
                  onChange={(event) => onAssignmentChange("contract_date", event.target.value)}
                />
              </label>
              <label className="block">
                <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">Closing Date</span>
                <input
                  type="date" className="input input-bordered input-sm mt-1 w-full bg-white"
                  value={String(assignmentDraft.contract_closing_date || "").slice(0, 10)}
                  onChange={(event) => onAssignmentChange("contract_closing_date", event.target.value)}
                />
              </label>
              {CONTRACT_AMOUNT_FIELDS.map(([field, label]) => (
                <label key={field} className="block">
                  <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">{label}</span>
                  <input
                    type="number" min="0" step="0.01" className="input input-bordered input-sm mt-1 w-full bg-white"
                    value={assignmentDraft[field] ?? ""}
                    onChange={(event) => onAssignmentChange(field, event.target.value)}
                    placeholder="Dollar amount"
                  />
                </label>
              ))}
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <label className="block">
                <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">Property Condition Provision</span>
                <select
                  className="select select-bordered select-sm mt-1 w-full bg-white"
                  value={assignmentDraft.contract_property_condition || ""}
                  onChange={(event) => onAssignmentChange("contract_property_condition", event.target.value)}
                >
                  <option value="">Not reported</option>
                  <option value="as_is">Buyer accepts the property As Is</option>
                  <option value="seller_repairs">As Is subject to seller repairs / treatments</option>
                </select>
              </label>
              <label className="block">
                <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">Seller Repairs / Treatments</span>
                <textarea
                  maxLength={5000}
                  className="textarea textarea-bordered mt-1 min-h-20 w-full bg-white"
                  value={assignmentDraft.contract_repairs || ""}
                  onChange={(event) => onAssignmentChange("contract_repairs", event.target.value)}
                  placeholder={assignmentDraft.contract_property_condition === "seller_repairs"
                    ? "Summarize the specific contract repairs or treatments."
                    : "No seller repair terms reported."}
                />
              </label>
            </div>

            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">Contract Analysis</span>
              <textarea
                maxLength={5000}
                className="textarea textarea-bordered mt-1 min-h-28 w-full bg-white leading-6"
                value={assignmentDraft.contract_analysis_summary || ""}
                onChange={(event) => onAssignmentChange("contract_analysis_summary", event.target.value)}
                placeholder="Approved contract evidence will generate the same narrative used in UAD 3.6."
              />
            </label>

            <div className="grid gap-4 lg:grid-cols-2">
              <fieldset className="rounded-xl border border-slate-200 bg-white p-3">
                <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-600">Arms Length</legend>
                <div className="grid grid-cols-2 gap-2">
                  <CheckboxChoice checked={assignmentDraft.contract_arms_length === true} label="Yes" onChange={(checked) => onAssignmentChange("contract_arms_length", checked ? true : null)} />
                  <CheckboxChoice checked={assignmentDraft.contract_arms_length === false} label="No" onChange={(checked) => onAssignmentChange("contract_arms_length", checked ? false : null)} />
                </div>
              </fieldset>
              <fieldset className="rounded-xl border border-slate-200 bg-white p-3">
                <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-600">Does Seller Match Public Records?</legend>
                <div className="grid grid-cols-2 gap-2">
                  <CheckboxChoice checked={assignmentDraft.seller_matches_public_records === true} label="Yes" onChange={(checked) => onAssignmentChange("seller_matches_public_records", checked ? true : null)} />
                  <CheckboxChoice checked={assignmentDraft.seller_matches_public_records === false} label="No" onChange={(checked) => onAssignmentChange("seller_matches_public_records", checked ? false : null)} />
                </div>
              </fieldset>
            </div>

            <div className={`rounded-xl border p-3 text-sm ${contractSellerComparison.matches === true ? "border-emerald-200 bg-emerald-50 text-emerald-900" : contractSellerComparison.matches === false ? "border-amber-300 bg-amber-50 text-amber-950" : "border-slate-200 bg-slate-50 text-slate-700"}`}>
              <div className="text-xs font-semibold uppercase tracking-wide">Seller Comparison</div>
              <p className="mt-1">{contractSellerComparison.summary}</p>
            </div>

            {assignmentDraft.seller_matches_public_records === false ? (
              <label className="block">
                <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">Seller Difference Explanation</span>
                <textarea
                  maxLength={3000} className="textarea textarea-bordered mt-1 min-h-20 w-full bg-white"
                  value={assignmentDraft.seller_mismatch_explanation || ""}
                  onChange={(event) => onAssignmentChange("seller_mismatch_explanation", event.target.value)}
                  placeholder="Required when the contract seller does not match CAD ownership"
                />
              </label>
            ) : null}
        </div>

        {assignmentErrors.length ? (
          <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
            <ul className="list-disc space-y-1 pl-5">{assignmentErrors.map((error) => <li key={error}>{error}</li>)}</ul>
          </div>
        ) : null}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <span className="text-xs text-slate-500">{assignmentSaveMessage || (assignmentDirty ? "Unsaved assignment changes" : "No unsaved changes")}</span>
          <button type="button" onClick={onSave} className="hn-action-primary btn btn-primary btn-sm normal-case rounded-lg shadow-sm" disabled={assignmentSaveDisabled}>
            {savingAssignmentFile ? "Saving..." : "Save Contract Analysis"}
          </button>
        </div>
      </section>

      <section className="mt-6 border-t border-slate-200 pt-5">
        <div className="mb-3">
          <h3 className="text-sm font-semibold text-slate-900">Sales History</h3>
          <p className="mt-0.5 text-xs text-slate-500">Closed MLS sales and CAD deed-transfer records.</p>
        </div>
        {salesHistoryRows.length ? (
          <div className="overflow-x-auto"><div className="min-w-[1120px]">
            <div className="grid items-end gap-x-4 border-b border-slate-300 px-1 pb-2 text-xs font-semibold uppercase tracking-wide text-slate-600" style={{ gridTemplateColumns: salesColumns }}>
              <div>Activity</div><div>Date</div><div>MLS</div><div>Status / Source</div>
              <div className="text-right">List Price</div><div className="text-right">Sale Price</div>
              <div className="text-right">DOM</div><div>Financing / Concessions</div>
            </div>
            {salesHistoryRows.slice(0, 20).map((event, index) => (
              <div key={event.source_record_id || event.sale_id || `${event.record_type}-${event.activity_date}-${index}`} className="grid items-start gap-x-4 border-b border-slate-200 px-1 py-2.5 text-sm last:border-b-0" style={{ gridTemplateColumns: salesColumns }}>
                <div>
                  <span className={`inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ${activityTypeClass(event.record_type)}`}>{activityTypeLabel(event.record_type)}</span>
                  {event.requires_additional_review ? <span className="ml-1 text-xs font-semibold text-amber-700" title="Source record needs review">!</span> : null}
                </div>
                <div className="whitespace-nowrap">{formatDate(event.activity_date || event.closing_date || event.listing_date)}</div>
                <div>{displayValue(event.listing_id, "—")}</div>
                <div>
                  <div className="font-medium text-slate-800">{displayValue(event.mls_status, activityTypeLabel(event.record_type))}</div>
                  <div className="text-[11px] text-slate-500">{displayValue(event.source, "Source not reported")}</div>
                </div>
                <div className="whitespace-nowrap text-right">{formatMoney(event.list_price)}</div>
                <div className="whitespace-nowrap text-right">{formatMoney(event.sale_price)}</div>
                <div className="text-right">{displayValue(event.days_on_market, "—")}</div>
                <div className="text-xs leading-5">
                  <div>{displayValue(event.buyer_financing, "Financing not reported")}</div>
                  {hasValue(event.concessions) ? <div className="mt-0.5 text-slate-500">Concessions: {displayValue(event.concessions)}</div> : null}
                </div>
              </div>
            ))}
          </div></div>
        ) : (
          <div className="rounded-xl border border-dashed border-slate-300 bg-white p-4 text-sm text-slate-600">No linked closed-sale or CAD deed-transfer records are currently available.</div>
        )}
      </section>
    </>
  );
}
