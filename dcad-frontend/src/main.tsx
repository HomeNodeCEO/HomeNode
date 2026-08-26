import React, { lazy, Suspense } from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate, useParams } from 'react-router-dom';
import './index.css';

import { ApplicationAuthGate, ApplicationAuthProvider } from './features/auth/ApplicationAuth';

const PropertySearch = lazy(() => import('./pages/PropertySearch'));
const PropertyDetailsBase44 = lazy(() => import('./pages/PropertyDetailsBase44'));
const PropertyReport = lazy(() => import('./pages/PropertyReport'));
const ComparableSalesAnalysis = lazy(() => import('./pages/ComparableSalesAnalysis'));
const AppraisalReport = lazy(() => import('./pages/AppraisalReport'));
const CostApproach = lazy(() => import('./pages/CostApproach'));
const IncomeApproach = lazy(() => import('./pages/IncomeApproach'));
const FinalReconciliation = lazy(() => import('./pages/FinalReconciliation'));
const SignUpForm = lazy(() => import('./pages/SignUpForm'));
const PropertyTaxProtest = lazy(() => import('./pages/PropertyTaxProtest'));
const UadWorkspaceEntry = lazy(() => import('./features/uad/pages/UadWorkspaceEntry'));

function LegacyDetailRedirect() {
  const { accountId } = useParams();
  return <Navigate to={`/property/1/${encodeURIComponent(accountId || '')}`} replace />;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ApplicationAuthProvider>
      <ApplicationAuthGate>
        <BrowserRouter>
          <Suspense fallback={<div className="route-loading" role="status">Loading…</div>}>
            <Routes>
              <Route path="/" element={<PropertySearch />} />
              <Route path="/property/:countyId/:accountId" element={<PropertyDetailsBase44 />} />
              <Route path="/property/:accountId" element={<LegacyDetailRedirect />} />
              <Route path="/report/:accountId" element={<PropertyReport />} />
              <Route path="/ComparableSalesAnalysis" element={<ComparableSalesAnalysis />} />
              <Route path="/AppraisalReport" element={<AppraisalReport />} />
              <Route path="/CostApproach" element={<CostApproach />} />
              <Route path="/IncomeApproach" element={<IncomeApproach />} />
              <Route path="/FinalReconciliation" element={<FinalReconciliation />} />
              <Route path="/PropertyTaxProtest" element={<PropertyTaxProtest />} />
              <Route path="/uad-3.6/:accountId" element={<UadWorkspaceEntry />} />
              <Route path="/signup" element={<SignUpForm />} />
            </Routes>
          </Suspense>
        </BrowserRouter>
      </ApplicationAuthGate>
    </ApplicationAuthProvider>
  </React.StrictMode>,
);
