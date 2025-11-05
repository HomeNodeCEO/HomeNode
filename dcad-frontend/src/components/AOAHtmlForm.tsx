import React from 'react';

type PropertyItem = { accountNumber: string; situsAddress: string; legalDescription: string };
export type OverlayFields = {
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

const steel = '#5e6b78';

export default function AOAHtmlForm({ fields, setFields }: { fields: OverlayFields; setFields: React.Dispatch<React.SetStateAction<OverlayFields>> }) {
  return (
    <div style={{ fontFamily: 'ui-sans-serif, system-ui, Segoe UI, Roboto, Helvetica, Arial', color: '#0b1f33' }}>
      <div className="bg-white rounded-xl border overflow-hidden">
        {Header()}
        {Title()}
        <div className="px-4 pt-2 pb-4 text-[13px]" style={{ color: steel }}>This form is for use by a property owner...</div>
        {BlueBar('STEP 1: Owner’s Name and Address:')}
        <div className="px-4 mt-2 flex flex-col md:flex-row md:items-end md:gap-3">
          <label className="text-[12px] w-full">Name<input className="w-full border rounded px-2 py-1" value={fields.ownerName} onChange={e=>setFields(f=>({...f, ownerName:e.target.value}))} /></label>
          <label className="text-[12px] w-[280px] ml-3">Telephone<input className="w-full border rounded px-2 py-1" value={fields.ownerTelephone} onChange={e=>setFields(f=>({...f, ownerTelephone:e.target.value}))} /></label>
        </div>
        {LabeledLine('Address', fields.ownerAddress, v=>setFields(f=>({...f, ownerAddress:v})))}
      </div>
    </div>
  );
}

function Header() {
  return (
    <div className="flex items-center justify-between px-4 py-3" style={{ background: '#f2f5f9', borderBottom: '1px solid #d7dee7' }}>
      <div className="text-[14px] font-medium" style={{ color: '#334155' }}>Texas Comptroller of Public Accounts</div>
      <div className="text-[12px] px-3 py-1 rounded" style={{ background: '#1f5081', color: 'white' }}>Form 50-162</div>
    </div>
  );
}

function Title() {
  return (
    <div className="px-4 py-3"><div className="text-[28px] font-semibold" style={{ color: '#2a4365' }}>Appointment of Agent for Property Tax Matters</div></div>
  );
}

function BlueBar(text: string) {
  return (
    <div className="px-4 py-2 mt-3" style={{ background: '#2f6fa2', color: 'white', fontWeight: 600, fontSize: '13px' }}>{text}</div>
  );
}

function LabeledLine(label: string, value: string, onChange: (v: string)=>void) {
  return (
    <div className="px-4 mt-2 text-[12px]"><label className="text-[12px] block">{label}<input className="w-full border rounded px-2 py-1" value={value} onChange={e=>onChange(e.target.value)} /></label></div>
  );
}

