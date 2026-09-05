import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import * as api from '@/lib/api';
import { fetchDetail } from '@/lib/dcad';
import {
  countyFromAccount,
  legalDescriptionFromAccount,
  legalDescriptionFromDetail,
  mailingAddressFromDetail,
  mapscoFromDetail,
  ownerNameFromDetail,
  signupErrorMessage,
  subjectAddressFromAccount,
  subjectAddressFromDetail,
} from '@/features/signup/signupPrefill';

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
  signatureDate: string;
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
  const propertyTaxFileId = useMemo(() => {
    const p = new URLSearchParams(location.search);
    return p.get('propertyTaxFileId') || '';
  }, [location.search]);
  const ownerNameFromQuery = useMemo(() => {
    const p = new URLSearchParams(location.search);
    return p.get('ownerName') || '';
  }, [location.search]);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const [sigUrl, setSigUrl] = useState<string | null>(null);
  const [signatureAttested, setSignatureAttested] = useState(false);
  const [hasSignatureStroke, setHasSignatureStroke] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const clientSubmissionIdRef = useRef(globalThis.crypto.randomUUID());
  const [showPad, setShowPad] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [isDrawing, setIsDrawing] = useState(false);

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
    signatureDate: new Date().toISOString().slice(0, 10),
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
        const detail: unknown = await fetchDetail(accountId);
        const ownerName = ownerNameFromDetail(detail);
        if (!cancelled && ownerName) {
          setFields(f => ({ ...f, ownerName }));
        }
      } catch {
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

  // Helper to title-case county words (handles inputs like "Dallas", "Dallas County", "COLLIN county")
  function titleCaseCounty(base: string): string {
    return base
      .split(/\s+/)
      .filter(Boolean)
      .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(' ');
  }

  // Auto-fill Appraisal District Name using DB county (preferred) or mapsco (fallback)
  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    (async () => {
      try {
        let name = '';
        // Prefer county from DB
        try {
          const d = await api.getAccount(accountId);
          const trimmed = countyFromAccount(d);
          if (trimmed) {
            const base = titleCaseCounty(trimmed.replace(/\s*county$/i, '').trim());
            if (base) name = `${base} Central Appraisal District`;
          }
        } catch {}
        // Fallback to mapsco via scraper detail => Dallas CAD
        if (!name) {
          try {
            const det: unknown = await fetchDetail(accountId);
            const mapsco = mapscoFromDetail(det);
            if (mapsco) name = 'Dallas Central Appraisal District';
          } catch {}
        }
        // Final fallback: default to Dallas CAD if neither county nor mapsco yielded a value
        if (!name) name = 'Dallas Central Appraisal District';
        if (!cancelled && name) {
          setFields(f => (f.appraisalDistrictName ? f : { ...f, appraisalDistrictName: name }));
        }
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [accountId]);

  // Force legal description from Property Report detail (Ownership section) to ensure all lines are captured
  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    (async () => {
      try {
        const det: unknown = await fetchDetail(accountId);
        const text = legalDescriptionFromDetail(det);
        if (!cancelled && text) {
          setFields(f => {
            const lp = [...f.listedProperties];
            if (!lp[0]) lp[0] = { accountNumber: '', situsAddress: '', legalDescription: '' };
            lp[0] = { ...lp[0], legalDescription: text };
            return { ...f, listedProperties: lp };
          });
        }
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [accountId]);

  // --- Step 1 auto-fill: Address/City/State/Zip from mailing address when it matches subject address ---
  function parseMailingParts(addr: string): { line: string; city: string; state: string; zip: string } {
    // Simple parser for formats like:
    //   "123 Main St, Apt 5, Dallas, TX 75201" or "123 Main St Dallas TX 75201"
    // Normalize newlines to commas to capture multi-line mailing addresses
    const s = String(addr || '').replace(/[\r\n]+/g, ', ').replace(/\s+,/g, ',').trim();
    let line = '', city = '', state = '', zip = '';
    const parts = s.split(',').map(p => p.trim()).filter(Boolean);
    if (parts.length >= 3) {
      line = parts[0];
      city = parts[1];
      // Third part may be "TX 75201" or "Texas 75201"
      const rest = parts.slice(2).join(' ');
      const m = rest.match(/([A-Za-z]{2,})\s*(\d{5})(?:-\d{4})?/);
      if (m) { state = m[1]; zip = m[2]; }
    } else {
      // Fallback: attempt space-delimited
      const segs = s.split(/\s+/);
      const zipIdx = segs.findIndex(t => /^\d{5}(?:-\d{4})?$/.test(t));
      if (zipIdx > 1) {
        zip = segs[zipIdx];
        state = segs[zipIdx - 1] || '';
        line = segs.slice(0, zipIdx - 2).join(' ');
        city = segs.slice(zipIdx - 2, zipIdx - 1).join(' ');
      } else {
        line = s;
      }
    }
    return { line, city, state, zip };
  }

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    (async () => {
      try {
        // Subject (situs) address from DB or scraper
        let subjectAddress = '';
        let legalFromDetail: string = '';
        try {
          const d = await api.getAccount(accountId);
          subjectAddress = subjectAddressFromAccount(d);
          // Prefer legal description from DB current if available
          legalFromDetail = legalDescriptionFromAccount(d);
        } catch {}
        if (!subjectAddress) {
          try {
            const det: unknown = await fetchDetail(accountId);
            subjectAddress = subjectAddressFromDetail(det);
            // Try to extract legal description lines
            legalFromDetail = legalDescriptionFromDetail(det) || legalFromDetail;
          } catch {}
        }
        // Mailing address from Property Report
        let mailingAddress = '';
        try {
          const det: unknown = await fetchDetail(accountId);
          mailingAddress = mailingAddressFromDetail(det);
        } catch {}
        if (mailingAddress) {
          const parts = parseMailingParts(mailingAddress);
          if (!cancelled) {
            setFields(f => ({
              ...f,
              ownerAddress: parts.line || mailingAddress,
              ownerCity: parts.city || '',
              ownerState: 'Texas',
              ownerZip: parts.zip || '',
            }));
          }
        }

        // Auto-fill Step 2 primary fields from subject
        if (!cancelled && subjectAddress) {
          setFields(f => {
            const lp = [...f.listedProperties];
            if (!lp[0]) lp[0] = { accountNumber: '', situsAddress: '', legalDescription: '' };
            const updated0 = {
              accountNumber: accountId,
              situsAddress: subjectAddress,
              legalDescription: f.listedProperties[0]?.legalDescription || legalFromDetail || '',
            };
            lp[0] = updated0;
            return { ...f, listedProperties: lp };
          });
        }
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [accountId]);

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
    setHasSignatureStroke(true);
  }
  function end() { setIsDrawing(false); }
  function clearSig() {
    const c = canvasRef.current!;
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, c.width, c.height);
    setHasSignatureStroke(false);
    setSigUrl(null);
    setSignatureAttested(false);
  }
  function saveSig() {
    if (!hasSignatureStroke) {
      alert('Please draw your signature before saving it.');
      return;
    }
    const c = canvasRef.current!;
    setSigUrl(c.toDataURL('image/png'));
    setSignatureAttested(false);
    setShowPad(false);
  }

  function loadSignatureFile(file: File | undefined) {
    if (!file) return;
    setSigUrl(null);
    setSignatureAttested(false);
    if (file.type !== 'image/png' || file.size > 256 * 1024) {
      alert('Signature uploads must be PNG images no larger than 256 KiB.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== 'string' || !reader.result.startsWith('data:image/png;base64,')) {
        alert('The signature image could not be read as a PNG.');
        return;
      }
      setSigUrl(reader.result);
      setSignatureAttested(false);
    };
    reader.onerror = () => alert('The signature image could not be read.');
    reader.readAsDataURL(file);
  }

  async function submit() {
    if (!accountId || !propertyTaxFileId || !sigUrl || !signatureAttested || !fields.signerPrintedName.trim()) {
      alert('Open a Property Tax file, complete the signer name, add a signature, and accept the verification attestation.');
      return;
    }
    setSubmitting(true);
    try {
      const payload = {
        accountId,
        authorization: fields,
        clientSubmissionId: clientSubmissionIdRef.current,
        propertyTaxFileId,
        signatureAttestation: true,
        signatureDataUrl: sigUrl,
      };
      await api.fetchJSON<{
        ok: boolean;
        verification_status: 'pending_manual_verification'|'verified'|'rejected';
      }>(api.makeUrl('/api/signup/email'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        timeoutMs: 15000,
      });
      clientSubmissionIdRef.current = globalThis.crypto.randomUUID();
      alert('Request received. HomeNode staff must verify identity and signature authority before treating it as authorization.');
    } catch (error: unknown) {
      alert(signupErrorMessage(error));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="hn-app-shell">
      <div className="max-w-6xl mx-auto p-4">
        <div className="hn-app-header flex flex-wrap items-center justify-between gap-3 mb-3 rounded-2xl border px-5 py-4">
          <div>
            <h1 className="text-2xl font-semibold">Sign Up (No Upfront Cost)</h1>
            <div className="text-sm opacity-70">Fill and e‑sign the authorization form below.</div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Link to={accountId ? `/report/${encodeURIComponent(accountId)}` : '/'} className="hn-action-secondary btn px-4 py-2 rounded-md border">Back</Link>
            <button className="hn-action-primary btn px-4 py-2 rounded-md" onClick={() => setShowPad(true)}>Draw Signature</button>
            <button
              className="hn-action-gold btn px-4 py-2 rounded-md"
              onClick={submit}
              disabled={submitting || !accountId || !propertyTaxFileId || !sigUrl || !signatureAttested || !fields.signerPrintedName.trim()}
            >
              {submitting ? 'Submitting…' : 'Submit for Verification'}
            </button>
          </div>
        </div>

        {/* Embedded PDF viewer removed per requirement; the HTML form remains below */}

        {/* Combined outline wrapper for Steps 1–4 (and subsequent steps) */}
        <div className="hn-workspace-surface mt-4 border rounded-xl p-4">

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
            {/* Full-width field for specific matters (always visible) */}
            <textarea
              className="border rounded px-2 py-1 w-full"
              rows={3}
              placeholder="Describe specific property tax matters (if applicable)"
              value={fields.representSpecificText}
              onChange={e=>setFields(f=>({...f, representSpecificText:e.target.value}))}
            />

            {/* Confidential information authorization text with Yes/No radios */}
            <div className="text-sm mt-2">
              The agent identified above is authorized to receive confidential information pursuant to Tax Code sections 11.48(b)(2), 22.27(b)(2), 23.123(c)(2), 23.126(c)(2) and 23.45(b)(2)
            </div>
            <div className="flex items-center gap-4 text-sm">
              <label className="inline-flex items-center gap-2">
                <input type="radio" name="confInfo" checked={fields.consentConfidentialInfo === true} onChange={()=>setFields(f=>({...f, consentConfidentialInfo:true}))} /> Yes
              </label>
              <label className="inline-flex items-center gap-2">
                <input type="radio" name="confInfo" checked={fields.consentConfidentialInfo === false} onChange={()=>setFields(f=>({...f, consentConfidentialInfo:false}))} /> No
              </label>
            </div>
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
            <input type="date" className="border rounded px-2 py-1 w-full" value={fields.signatureDate} onChange={e=>setFields(f=>({...f, signatureDate:e.target.value}))} />
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
          <input ref={inputRef} type="file" accept="image/png" className="hidden" onChange={(e) => loadSignatureFile(e.target.files?.[0])} />
          <button className="hn-action-secondary px-3 py-2 rounded-md border" onClick={openFilePicker}>Upload Signature Image</button>
          {sigUrl && (
            <div className="flex items-center gap-2">
              <div className="text-sm">Signature ready</div>
              <img alt="signature" src={sigUrl} style={{ height: 36 }} />
            </div>
          )}
        </div>
        <label className="mt-3 flex max-w-4xl items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-950">
          <input
            type="checkbox"
            className="mt-1"
            checked={signatureAttested}
            onChange={(event) => setSignatureAttested(event.target.checked)}
          />
          <span>
            I attest that the signer information and signature are supplied by a person authorized to act for this property. I understand HomeNode must independently verify identity and authority before this request is treated as an enrollment or legal authorization.
          </span>
        </label>

        {/* Signature pad modal */}
        {showPad && (
          <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
            <div className="bg-white rounded-xl p-4 w-[560px]">
              <div className="font-semibold mb-2">Draw your signature</div>
              <canvas ref={canvasRef} width={520} height={180} className="border rounded" onMouseDown={start} onMouseMove={draw} onMouseUp={end} onMouseLeave={end} />
              <div className="mt-3 flex gap-2 justify-end">
                <button className="hn-action-secondary px-3 py-2 rounded-md border" onClick={clearSig}>Clear</button>
                <button className="hn-action-secondary px-3 py-2 rounded-md border" onClick={() => setShowPad(false)}>Cancel</button>
                <button className="hn-action-primary px-3 py-2 rounded-md border" onClick={saveSig}>Save Signature</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

