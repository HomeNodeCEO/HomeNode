import { useCallback, useEffect, useState } from "react";

import { deleteUadAsset, listUadAssets, uploadUadAsset, type UadAsset } from "../api";

const DEFAULT_ACCEPT = "image/avif,image/bmp,image/gif,image/jpeg,image/png,image/tiff,image/webp,image/heic,image/heif,application/pdf,application/json";

function displayOption(value: string) {
  return value.replace(/([a-z])([A-Z])/g, "$1 $2");
}

interface Props {
  workfileId: string;
  sectionNumber: number;
  title: string;
  captionTypes: string[];
  accept?: string;
  description?: string;
  emptyMessage?: string;
  uploadEnabled?: boolean;
  visibleCaptionTypes?: string[];
  entityId?: string;
}

export default function UadAssetPanel({
  workfileId,
  sectionNumber,
  title,
  captionTypes,
  accept = DEFAULT_ACCEPT,
  description = "Files upload directly to private object storage through a short-lived URL, then HomeNode verifies the stored object. The same API is ready for the future mobile capture app.",
  emptyMessage = "No files uploaded for this section yet.",
  uploadEnabled = true,
  visibleCaptionTypes,
  entityId,
}: Props) {
  const [assets, setAssets] = useState<UadAsset[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [captionType, setCaptionType] = useState(captionTypes[0]);
  const [caption, setCaption] = useState("");
  const [uploading, setUploading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setAssets((await listUadAssets(workfileId)).filter((asset) => (
        asset.section_number === sectionNumber
        && (!entityId || asset.entity_id === entityId)
        && (!visibleCaptionTypes || visibleCaptionTypes.includes(asset.caption_type || ""))
      )));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : `${title} files could not be loaded.`);
    }
  }, [entityId, sectionNumber, title, visibleCaptionTypes, workfileId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setCaptionType(captionTypes[0]); }, [captionTypes]);

  async function handleUpload() {
    if (!file || uploading) return;
    setUploading(true);
    setError(null);
    try {
      const extension = file.name.split(".").pop()?.toLowerCase();
      const assetKind = captionType === "FloorPlan"
        ? "floor_plan"
        : captionType === "SubjectPropertyImprovementSketch"
          ? "sketch"
          : captionType === "MeasurementSource"
            ? "measurement_source"
            : file.type === "application/pdf" || extension === "pdf"
        ? "supporting_document"
        : file.type === "application/json" || extension === "json"
          ? "measurement_source"
          : "photo";
      await uploadUadAsset(workfileId, file, {
        asset_kind: assetKind,
        section_number: sectionNumber,
        entity_id: entityId,
        caption_type: captionType,
        caption: caption || displayOption(captionType),
      });
      setFile(null);
      setCaption("");
      const picker = document.getElementById(`uad-asset-${sectionNumber}-${entityId || "root"}-${workfileId}`) as HTMLInputElement | null;
      if (picker) picker.value = "";
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : `The ${title.toLowerCase()} file could not be uploaded.`);
    } finally {
      setUploading(false);
    }
  }

  async function handleDelete(asset: UadAsset) {
    if (deletingId || !window.confirm(`Remove ${asset.caption || asset.original_file_name || "this file"} from the UAD workfile?`)) return;
    setDeletingId(asset.id);
    setError(null);
    try {
      await deleteUadAsset(workfileId, asset.id);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The file could not be removed.");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <fieldset className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5">
      <legend className="px-2 text-base font-semibold text-slate-900">{title}</legend>
      <p className="mt-2 text-xs leading-5 text-slate-600">{description}</p>
      {error && <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900">{error}</div>}
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <label className="text-sm font-medium text-slate-800">
          File
          <input
            accept={accept}
            className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
            disabled={!uploadEnabled}
            id={`uad-asset-${sectionNumber}-${entityId || "root"}-${workfileId}`}
            onChange={(event) => setFile(event.target.files?.[0] || null)}
            type="file"
          />
        </label>
        <label className="text-sm font-medium text-slate-800">
          Attachment category
          <select className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm" disabled={!uploadEnabled} onChange={(event) => setCaptionType(event.target.value)} value={captionType}>
            {captionTypes.map((option) => <option key={option} value={option}>{displayOption(option)}</option>)}
          </select>
        </label>
        <label className="text-sm font-medium text-slate-800 md:col-span-2">
          Caption
          <input className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm" disabled={!uploadEnabled} maxLength={100} onChange={(event) => setCaption(event.target.value)} value={caption} />
        </label>
      </div>
      <button
        className="mt-3 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        disabled={!uploadEnabled || !file || uploading}
        onClick={handleUpload}
        type="button"
      >
        {uploading ? "Uploading and verifying…" : "Upload file"}
      </button>
      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        {assets.map((asset) => (
          <div className="flex items-start justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm" key={asset.id}>
            <div>
              <div className="font-medium text-slate-900">{asset.caption || asset.original_file_name}</div>
              <div className="mt-1 text-xs text-slate-500">
                {displayOption(asset.caption_type || asset.asset_kind)} · {asset.status} · {asset.byte_size == null ? "size pending" : `${Math.max(1, Math.round(asset.byte_size / 1024))} KB`}
              </div>
            </div>
            <button className="text-xs font-semibold text-red-700 hover:text-red-900 disabled:opacity-50" disabled={Boolean(deletingId)} onClick={() => void handleDelete(asset)} type="button">
              {deletingId === asset.id ? "Removing…" : "Remove"}
            </button>
          </div>
        ))}
        {!assets.length && <div className="text-sm text-slate-500">{emptyMessage}</div>}
      </div>
    </fieldset>
  );
}
