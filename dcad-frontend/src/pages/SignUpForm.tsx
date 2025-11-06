import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import * as api from '@/lib/api';
import { fetchDetail } from '@/lib/dcad';

type PropertyItem = { accountNumber: string; situsAddress: string; legalDescription: string };
type OverlayFields = {
  appraisalDistrictName: string;
  ownerName: string;
  ownerTelephone: string;
  ownerAddress: string;
  ownerCity: string;
  ownerState: string;
  ownerZip: string;
  allPropertyAtAddress: boolean;
  listedProperties: PropertyItem[];
  additionalSheets: string;
  agentName: string;
  agentTelephone: string;
  agentAddress: string;
  agentCity: string;
  agentState: string;
  agentZip: string;
  representAll: boolean;
  representSpecificText: string;
  consentConfidentialInfo: boolean;
  communicationsChiefAppraiser: boolean;
  communicationsReviewBoard: boolean;
  communicationsAllTaxingUnits: boolean;
  authorityEnds: string;
  signerPrintedName: string;
  signerTitle: string;
  signerRole: 'owner'|'authorized-agent'|'other';
};

export default function SignUpForm() {
  const location = useLocation();
  const accountId = useMemo(() => {
    const p = new URLSearchParams(location.search);
    return p.get('accountId') || '';
  }, [location.search]);
  const ownerNameFromQuery = useMemo(() => {
    const p = new URLSearchParams(location.search);
    return p.get('ownerName') || '';
  }, [location.search]);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const [sigUrl, setSigUrl] = useState<string | null>(null);
  const [showPad, setShowPad] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [isDrawing, setIsDrawing] = useState(false);

  // Use the exact file name provided; place it under /public or point VITE_SIGNUP_PDF_URL to a backend URL serving the file
  // IMPORTANT: use the true path with a space; let encodeURIComponent handle the space once
  const rawPdfUrl = (import.meta as any)?.env?.VITE_SIGNUP_PDF_URL || '/AOA Form.pdf';
  // PDF viewer removed; keeping only the HTML form

  const [fields, setFields] = useState<OverlayFields>({
    appraisalDistrictName: '',
    ownerName: '',
    ownerTelephone: '',
    ownerAddress: '',
    ownerCity: '',
    ownerState: '',
    ownerZip: '',
    allPropertyAtAddress: true,
    listedProperties: [
      { accountNumber: '', situsAddress: '', legalDescription: '' },
      { accountNumber: '', situsAddress: '', legalDescription: '' },
      { accountNumber: '', situsAddress: '', legalDescription: '' },
    ],
    additionalSheets: '',
    agentName: 'HomeNode, Inc.',
    agentTelephone: '719-888-0042',
    agentAddress: '1717 Independence Pkwy, Apt 116',
    agentCity: 'Plano',
    agentState: 'Texas',
    agentZip: '75075',
    representAll: true,
    representSpecificText: '',
    consentConfidentialInfo: true,
    communicationsChiefAppraiser: true,
    communicationsReviewBoard: true,
    communicationsAllTaxingUnits: true,
    authorityEnds: '',
    signerPrintedName: '',
    signerTitle: '',
    signerRole: 'owner',
  });

  // If arrived from Property Report with an accountId, fetch owner name and prefill
  useEffect(() => {
    if (!accountId) return;
    if (ownerNameFromQuery) return; // priority: honor explicitly provided ownerName
    let cancelled = false;
    (async () => {
      try {
        const detail: any = await fetchDetail(accountId);
        const fromOwner = detail?.owner?.owner_name || detail?.owner_name || detail?.owner?.name || '';
        const fromMulti = Array.isArray(detail?.owner?.multi_owner) && detail.owner.multi_owner.length
          ? (detail.owner.multi_owner[0]?.owner_name || detail.owner.multi_owner[0]?.name || '')
          : '';
        const fromHistory = Array.isArray(detail?.history?.owner_history) && detail.history.owner_history.length
          ? (detail.history.owner_history[0]?.owner || '')
          : '';
        const ownerName: string | undefined = (fromOwner || fromMulti || fromHistory || '').toString().trim();
        if (!cancelled && ownerName) {
          setFields(f => ({ ...f, ownerName }));
        }
      } catch (_) {
        // silently ignore; user can fill manually
      }
    })();
    return () => { cancelled = true; };
  }, [accountId, ownerNameFromQuery]);

  // If ownerName is passed via query param, set it immediately
  useEffect(() => {
    if (!ownerNameFromQuery) return;
    setFields(f => ({ ...f, ownerName: ownerNameFromQuery }));
  }, [ownerNameFromQuery]);

  function openFilePicker() {
    inputRef.current?.click();
  }

  function start(e: React.MouseEvent<HTMLCanvasElement>) {
    setIsDrawing(true);
    const ctx = canvasRef.current!.getContext('2d')!;
    ctx.strokeStyle = '#111827';
    ctx.lineWidth = 2.0;
    ctx.beginPath();
    const rect = canvasRef.current!.getBoundingClientRect();
    ctx.moveTo(e.clientX - rect.left, e.clientY - rect.top);
  }
  function draw(e: React.MouseEvent<HTMLCanvasElement>) {
    if (!isDrawing) return;
    const ctx = canvasRef.current!.getContext('2d')!;
    const rect = canvasRef.current!.getBoundingClientRect();
    ctx.lineTo(e.clientX - rect.left, e.clientY - rect.top);
    ctx.stroke();
  }
  function end() { setIsDrawing(false); }
  function clearSig() {
    const c = canvasRef.current!;
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, c.width, c.height);
  }
  function saveSig() {
    const c = canvasRef.current!;
    setSigUrl(c.toDataURL('image/png'));
    setShowPad(false);
  }

  async function submit() {
    try {
      // Fetch base PDF (original form) to send to backend for stamping
      const baseResp = await fetch(rawPdfUrl);
      if (!baseResp.ok) throw new Error('Unable to fetch base PDF');
      const baseBlob = await baseResp.blob();
      const reader = new FileReader();
      const basePdfData: string = await new Promise((res, rej) => {
        reader.onload = () => res(String(reader.result));
        reader.onerror = () => rej(new Error('Failed to read base PDF'));
        reader.readAsDataURL(baseBlob);
      });
      const payload = { accountId, signature: sigUrl, basePdfData, fields };
      const res = await fetch(api.makeUrl('/api/signup/submit'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(await res.text());
      alert('Submitted! We will follow up by email.');
    } catch (e: any) {
      alert(e?.message || 'Submit failed');
    }
  }

  return (
    <div className="min-h-screen bg-base-200">
      <div className="max-w-6xl mx-auto p-4">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h1 className="text-2xl font-semibold">Sign Up (No Upfront Cost)</h1>
            <div className="text-sm opacity-70">Fill and e‑sign the authorization form below.</div>
          </div>
          <div className="flex items-center gap-2">
            <Link to={accountId ? `/report/${encodeURIComponent(accountId)}` : '/'} className="btn px-4 py-2 rounded-md border">Back</Link>
            <button className="btn px-4 py-2 rounded-md bg-emerald-600 border-emerald-600 text-white" onClick={() => setShowPad(true)}>Draw Signature</button>
            <button className="btn px-4 py-2 rounded-md bg-blue-600 border-blue-600 text-white" onClick={submit} disabled={!sigUrl}>Submit Enrollment</button>
          </div>
        </div>

        {/* Embedded PDF viewer removed per requirement; the HTML form remains below */}

        {/* Combined outline wrapper for Steps 1–4 (and subsequent steps) */}
        <div className="mt-4 bg-white border rounded-xl p-4">

        {/* HTML Overlay Form - Page 1 (now inside combined wrapper) */}
        <div className="">
          <div className="font-semibold mb-2">STEP 1: Owner’s Name and Address</div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <label className="text-sm">Appraisal District Name
              <input className="border rounded px-2 py-1 w-full" value={fields.appraisalDistrictName} onChange={e=>setFields(f=>({...f, appraisalDistrictName:e.target.value}))} />
            </label>
            {/* Removed per request: Date Received (district use only) */}
            <label className="text-sm md:col-span-2">Owner Name
              <input className="border rounded px-2 py-1 w-full" value={fields.ownerName} onChange={e=>setFields(f=>({...f, ownerName:e.target.value}))} />
            </label>
            <label className="text-sm md:col-span-2">Address
              <input className="border rounded px-2 py-1 w-full" value={fields.ownerAddress} onChange={e=>setFields(f=>({...f, ownerAddress:e.target.value}))} />
            </label>
            <div className="grid grid-cols-3 gap-2 md:col-span-2">
              <label className="text-sm">City
                <input className="border rounded px-2 py-1 w-full" value={fields.ownerCity} onChange={e=>setFields(f=>({...f, ownerCity:e.target.value}))} />
              </label>
              <label className="text-sm">State
                <input className="border rounded px-2 py-1 w-full" value={fields.ownerState} onChange={e=>setFields(f=>({...f, ownerState:e.target.value}))} />
              </label>
              <label className="text-sm">Zip
                <input className="border rounded px-2 py-1 w-full" value={fields.ownerZip} onChange={e=>setFields(f=>({...f, ownerZip:e.target.value}))} />
              </label>
            </div>
            <label className="text-sm">Telephone (include area code)
              <input className="border rounded px-2 py-1 w-full" value={fields.ownerTelephone} onChange={e=>setFields(f=>({...f, ownerTelephone:e.target.value}))} />
            </label>
          </div>

          <div className="font-semibold mt-4 mb-2">STEP 2: Identify the Property for Which Authority is Granted</div>
          <div className="text-sm mb-2">(check one)</div>
          <label className="text-sm inline-flex items-center gap-2">
            <input type="radio" checked={fields.allPropertyAtAddress} onChange={() => setFields(f=>({...f, allPropertyAtAddress:true}))} />
            All property listed for me at the above address
          </label>
          <label className="text-sm inline-flex items-center gap-2 ml-4">
            <input type="radio" checked={!fields.allPropertyAtAddress} onChange={() => setFields(f=>({...f, allPropertyAtAddress:false}))} />
            The property(ies) listed below:
          </label>

          {/* Step 2 primary fields (always visible beneath the checkboxes) */}
          <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3">
            <label className="text-sm">Appraisal District Account Number
              <input
                className="border rounded px-2 py-1 w-full"
                value={fields.listedProperties[0]?.accountNumber || ''}
                onChange={e => {
                  const val = e.target.value;
                  setFields(f => {
                    const lp = [...f.listedProperties];
                    if (!lp[0]) lp[0] = { accountNumber: '', situsAddress: '', legalDescription: '' } as PropertyItem;
                    lp[0] = { ...lp[0], accountNumber: val };
                    return { ...f, listedProperties: lp };
                  });
                }}
              />
            </label>
            <label className="text-sm">Physical or Situs Address of Property
              <input
                className="border rounded px-2 py-1 w-full"
                value={fields.listedProperties[0]?.situsAddress || ''}
                onChange={e => {
                  const val = e.target.value;
                  setFields(f => {
                    const lp = [...f.listedProperties];
                    if (!lp[0]) lp[0] = { accountNumber: '', situsAddress: '', legalDescription: '' } as PropertyItem;
                    lp[0] = { ...lp[0], situsAddress: val };
                    return { ...f, listedProperties: lp };
                  });
                }}
              />
            </label>
            <label className="text-sm md:col-span-2">Legal Description
              <textarea
                className="border rounded px-2 py-1 w-full"
                rows={2}
                value={fields.listedProperties[0]?.legalDescription || ''}
                onChange={e => {
                  const val = e.target.value;
                  setFields(f => {
                    const lp = [...f.listedProperties];
                    if (!lp[0]) lp[0] = { accountNumber: '', situsAddress: '', legalDescription: '' } as PropertyItem;
                    lp[0] = { ...lp[0], legalDescription: val };
                    return { ...f, listedProperties: lp };
                  });
                }}
              />
            </label>
          </div>

          {!fields.allPropertyAtAddress && (
            <div className="mt-3 grid grid-cols-1 gap-3">
              {fields.listedProperties.map((p, idx) => (
                <div key={idx} className="grid grid-cols-1 md:grid-cols-2 gap-3 border rounded p-3">
                  <label className="text-sm">Appraisal District Account Number
                    <input className="border rounded px-2 py-1 w-full" value={p.accountNumber} onChange={e=>{
                      const val = e.target.value; setFields(f=>{ const lp=[...f.listedProperties]; lp[idx] = {...lp[idx], accountNumber:val}; return {...f, listedProperties:lp}; });
                    }} />
                  </label>
                  <label className="text-sm">Physical or Situs Address of Property
                    <input className="border rounded px-2 py-1 w-full" value={p.situsAddress} onChange={e=>{
                      const val = e.target.value; setFields(f=>{ const lp=[...f.listedProperties]; lp[idx] = {...lp[idx], situsAddress:val}; return {...f, listedProperties:lp}; });
                    }} />
                  </label>
                  <label className="text-sm md:col-span-2">Legal Description
                    <textarea className="border rounded px-2 py-1 w-full" rows={2} value={p.legalDescription} onChange={e=>{
                      const val = e.target.value; setFields(f=>{ const lp=[...f.listedProperties]; lp[idx] = {...lp[idx], legalDescription:val}; return {...f, listedProperties:lp}; });
                    }} />
                  </label>
                </div>
              ))}
              <div className="text-sm">Number of additional sheets attached:
                <input className="border rounded px-2 py-1 ml-2 w-24" value={fields.additionalSheets} onChange={e=>setFields(f=>({...f, additionalSheets:e.target.value}))} />
              </div>
            </div>
          )}
        </div>

        {/* HTML Overlay Form - Page 2 (now inside combined wrapper) */}
        <div className="mt-4">
          <div className="font-semibold mb-2">STEP 3: Identify the Agent</div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <label className="text-sm">Name
              <input className="border rounded px-2 py-1 w-full" value={fields.agentName} readOnly />
            </label>
            <label className="text-sm">Telephone Number
              <input className="border rounded px-2 py-1 w-full" value={fields.agentTelephone} readOnly />
            </label>
            <label className="text-sm md:col-span-2">Address
              <input className="border rounded px-2 py-1 w-full" value={fields.agentAddress} readOnly />
            </label>
            <div className="grid grid-cols-3 gap-2 md:col-span-2">
              <label className="text-sm">City
                <input className="border rounded px-2 py-1 w-full" value={fields.agentCity} readOnly />
              </label>
              <label className="text-sm">State
                <input className="border rounded px-2 py-1 w-full" value={fields.agentState} readOnly />
              </label>
              <label className="text-sm">Zip
                <input className="border rounded px-2 py-1 w-full" value={fields.agentZip} readOnly />
              </label>
            </div>
          </div>

          <div className="font-semibold mt-4 mb-2">STEP 4: Specify the Agent’s Authority</div>
          <div className="grid grid-cols-1 gap-2">
            <label className="text-sm inline-flex items-center gap-2">
              <input type="radio" checked={fields.representAll} onChange={()=>setFields(f=>({...f, representAll:true}))} /> All property tax matters concerning the property identified
            </label>
            <label className="text-sm inline-flex items-center gap-2">
              <input type="radio" checked={!fields.representAll} onChange={()=>setFields(f=>({...f, representAll:false}))} /> The following specific property tax matters:
            </label>
            {!fields.representAll && (
              <textarea className="border rounded px-2 py-1 w-full" rows={3} value={fields.representSpecificText} onChange={e=>setFields(f=>({...f, representSpecificText:e.target.value}))} />
            )}
            <label className="text-sm inline-flex items-center gap-2 mt-2"><input type="checkbox" checked={fields.consentConfidentialInfo} onChange={e=>setFields(f=>({...f, consentConfidentialInfo:e.target.checked}))} /> Agent is authorized to receive confidential information</label>
            <label className="text-sm inline-flex items-center gap-2"><input type="checkbox" checked={fields.communicationsChiefAppraiser} onChange={e=>setFields(f=>({...f, communicationsChiefAppraiser:e.target.checked}))} /> All communications from the chief appraiser</label>
            <label className="text-sm inline-flex items-center gap-2"><input type="checkbox" checked={fields.communicationsReviewBoard} onChange={e=>setFields(f=>({...f, communicationsReviewBoard:e.target.checked}))} /> All communications from the appraisal review board</label>
            <label className="text-sm inline-flex items-center gap-2"><input type="checkbox" checked={fields.communicationsAllTaxingUnits} onChange={e=>setFields(f=>({...f, communicationsAllTaxingUnits:e.target.checked}))} /> All communications from all taxing units participating in the appraisal district</label>
          </div>

          <div className="font-semibold mt-4 mb-2">STEP 5: Date the Agent’s Authority Ends</div>
          <label className="text-sm">Agent’s Authority Ends
            <input className="border rounded px-2 py-1 w-full" value={fields.authorityEnds} onChange={e=>setFields(f=>({...f, authorityEnds:e.target.value}))} />
          </label>

          <div className="font-semibold mt-4 mb-2">STEP 6: Identification, Signature, and Date</div>
          <label className="text-sm">Signature Date
            <input className="border rounded px-2 py-1 w-full" value={fields.authorityEnds} onChange={e=>setFields(f=>({...f, authorityEnds:e.target.value}))} />
          </label>
          <label className="text-sm mt-2 block">Signature (use Draw Signature button above)</label>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-2">
            <label className="text-sm">Printed Name of Property Owner / Property Manager / Other Person Authorized to Act
              <input className="border rounded px-2 py-1 w-full" value={fields.signerPrintedName} onChange={e=>setFields(f=>({...f, signerPrintedName:e.target.value}))} />
            </label>
            <label className="text-sm">Title
              <input className="border rounded px-2 py-1 w-full" value={fields.signerTitle} onChange={e=>setFields(f=>({...f, signerTitle:e.target.value}))} />
            </label>
          </div>
          <div className="text-sm mt-3">The individual signing this form is (check one):</div>
          <div className="flex flex-col gap-1 mt-1">
            <label className="text-sm inline-flex items-center gap-2"><input type="radio" checked={fields.signerRole==='owner'} onChange={()=>setFields(f=>({...f, signerRole:'owner'}))} /> the property owner</label>
            <label className="text-sm inline-flex items-center gap-2"><input type="radio" checked={fields.signerRole==='authorized-agent'} onChange={()=>setFields(f=>({...f, signerRole:'authorized-agent'}))} /> a property manager authorized to designate agents for the owner</label>
            <label className="text-sm inline-flex items-center gap-2"><input type="radio" checked={fields.signerRole==='other'} onChange={()=>setFields(f=>({...f, signerRole:'other'}))} /> other person authorized to act on behalf of the owner</label>
          </div>
        </div>

        {/* End combined outline wrapper */}
        </div>

        {/* Signature preview / upload */}
        <div className="mt-3 flex items-center gap-3">
          <input ref={inputRef} type="file" accept="image/*" className="hidden" onChange={(e) => setSigUrl(e.target.files?.[0] ? URL.createObjectURL(e.target.files[0]) : null)} />
          <button className="px-3 py-2 rounded-md border" onClick={openFilePicker}>Upload Signature Image</button>
          {sigUrl && (
            <div className="flex items-center gap-2">
              <div className="text-sm">Signature ready</div>
              <img alt="signature" src={sigUrl} style={{ height: 36 }} />
            </div>
          )}
        </div>

        {/* Signature pad modal */}
        {showPad && (
          <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
            <div className="bg-white rounded-xl p-4 w-[560px]">
              <div className="font-semibold mb-2">Draw your signature</div>
              <canvas ref={canvasRef} width={520} height={180} className="border rounded" onMouseDown={start} onMouseMove={draw} onMouseUp={end} onMouseLeave={end} />
              <div className="mt-3 flex gap-2 justify-end">
                <button className="px-3 py-2 rounded-md border" onClick={clearSig}>Clear</button>
                <button className="px-3 py-2 rounded-md bg-slate-800 text-white" onClick={() => setShowPad(false)}>Cancel</button>
                <button className="px-3 py-2 rounded-md bg-emerald-600 text-white" onClick={saveSig}>Save Signature</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

