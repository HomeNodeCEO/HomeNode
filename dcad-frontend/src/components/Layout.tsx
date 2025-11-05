// src/components/Layout.tsx
import React from "react";
import { Building } from "lucide-react";
import { Link } from "react-router-dom";

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen w-full bg-slate-100">
      <header className="bg-white/90 backdrop-blur-sm border-b border-slate-200 px-4 sm:px-6 py-3 sticky top-0 z-50">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <Link to="/" className="flex items-center gap-3 cursor-pointer">
            <div className="w-10 h-10 bg-gradient-to-br from-blue-600 to-blue-700 rounded-xl flex items-center justify-center shadow-lg">
              <Building className="w-6 h-6 text-white" />
            </div>
            <div>
              <h1 className="font-bold text-slate-900 text-lg">Mooolah, Inc</h1>
              <p className="text-xs text-slate-500">Property Tax Consulting</p>
            </div>
          </Link>
        </div>
      </header>
      <main>{children}</main>
    </div>
  );
}
