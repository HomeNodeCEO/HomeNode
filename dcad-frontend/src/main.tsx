import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate, useParams } from 'react-router-dom';
import './index.css';

import PropertySearch from './pages/PropertySearch';
import PropertyDetailsBase44 from './pages/PropertyDetailsBase44';
import PropertyReport from './pages/PropertyReport';
import ComparableSalesAnalysis from './pages/ComparableSalesAnalysis';
import SignUpForm from './pages/SignUpForm';

function LegacyDetailRedirect() {
  const { accountId } = useParams();
  return <Navigate to={`/property/1/${encodeURIComponent(accountId || '')}`} replace />;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<PropertySearch />} />
        <Route path="/property/:countyId/:accountId" element={<PropertyDetailsBase44 />} />
        <Route path="/property/:accountId" element={<LegacyDetailRedirect />} />
        <Route path="/report/:accountId" element={<PropertyReport />} />
        <Route path="/ComparableSalesAnalysis" element={<ComparableSalesAnalysis />} />
        <Route path="/signup" element={<SignUpForm />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);
