import { useCallback, useEffect, useState } from "react";

import { listUadAssets, uploadUadAsset, type UadAsset } from "../api";

const SITE_CAPTIONS = [
  "PropertyAccess", "PropertyPhoto", "SiteInfluence", "View", "SiteCharacteristic",
  "PropertyBoundaries", "Encroachment", "WaterFrontage", "SiteExhibit",
];

function displayOption(value: string) {
  return value.replace(/([a-z])([A-Z])/g, "$1 $2");
}

export default function UadAssetPanel({ workfileId }: { workfileId: string }) {
  const [assets, setAssets] = useState<UadAsset[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [captionType, setCaptionType] = useState("PropertyPhoto");
  const [caption, setCaption] = useState("");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setAssets((await listUadAssets(workfileId)).filter((asset) => asset.section_number === 4));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Site files could not be loaded.");
    }
  }, [workfileId]);

  useEffect(() => { void load(); }, [load]);

  async function handleUpload() {
    if (!file || uploading) return;
    setUploading(true);
    setError(null);
    try {
      const extension = file.name.split(".").pop()?.toLowerCase();
      const assetKind = file.type === "application/pdf" || extension === "pdf"
        ? "supporting_document"
        : file.type === "application/json" || extension === "json"
          ? "measurement_source"
          : file.type === "image/svg+xml" || extension === "svg"
            ? "sketch"
            : "photo";
      await uploadUadAsset(workfileId, file, {
        asset_kind: assetKind,
        section_number: 4,
        caption_type: captionType,
        caption: caption || displayOption(captionType),
      });
      setFile(null);
      setCaption("");
      const picker = document.getElementById(`uad-site-asset-${workfileId}`) as HTMLInputElement | null;
      if (picker) picker.value = "";
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The site file could not be uploaded.");
    } finally {
      setUploading(false);
    }
  }

  return (
    <fieldset className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5">
      <legend className="px-2 text-base font-semibold text-slate-900">Site photos, exhibits, and supporting files</legend>
      <p className="mt-2 text-xs leading-5 text-slate-600">
        Files upload directly to private object storage through a short-lived URL, then HomeNode verifies the stored object. The same API is ready for the future mobile capture app.
      </p>
      {error && <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900">{error}</div>}
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <label className="text-sm font-medium text-slate-800">
          File
          <input
            accept="image/jpeg,image/png,image/webp,image/heic,image/heif,image/svg+xml,application/pdf,application/json"
            className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
            id={`uad-site-asset-${workfileId}`}
            onChange={(event) => setFile(event.target.files?.[0] || null)}
            type="file"
          />
        </label>
        <label className="text-sm font-medium text-slate-800">
          Official image category
          <select className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm" onChange={(event) => setCaptionType(event.target.value)} value={captionType}>
            {SITE_CAPTIONS.map((option) => <option key={option} value={option}>{displayOption(option)}</option>)}
          </select>
        </label>
        <label className="text-sm font-medium text-slate-800 md:col-span-2">
          Caption
          <input className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm" maxLength={100} onChange={(event) => setCaption(event.target.value)} value={caption} />
        </label>
      </div>
      <button
        className="mt-3 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        disabled={!file || uploading}
        onClick={handleUpload}
        type="button"
      >
        {uploading ? "Uploading and verifying…" : "Upload site file"}
      </button>
      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        {assets.map((asset) => (
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm" key={asset.id}>
            <div className="font-medium text-slate-900">{asset.caption || asset.original_file_name}</div>
            <div className="mt-1 text-xs text-slate-500">
              {displayOption(asset.caption_type || asset.asset_kind)} · {asset.status} · {asset.byte_size == null ? "size pending" : `${Math.max(1, Math.round(asset.byte_size / 1024))} KB`}
            </div>
          </div>
        ))}
        {!assets.length && <div className="text-sm text-slate-500">No Site files uploaded yet.</div>}
      </div>
    </fieldset>
  );
}
