import PropertySearchSection from "@/components/dashboard/PropertySearchSection";
import PropertyDataSection from "@/components/dashboard/PropertyDataSection";
import ProtestTrackingSection from "@/components/dashboard/ProtestTrackingSection";
import CustomerSection from "@/components/dashboard/CustomerSection";

export default function Dashboard() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100">
      <div className="max-w-7xl mx-auto p-6 space-y-8">
        {/* Header */}
        <div className="text-center space-y-2">
          <h1 className="text-4xl font-bold text-slate-900">Property Tax Consulting Dashboard</h1>
          <p className="text-slate-600 text-lg">
            Managing properties across Dallas, Collin, Tarrant, Denton, and Rockwall Counties
          </p>
        </div>

        {/* 2×2 grid in your specified order */}
        <div className="grid lg:grid-cols-2 gap-8">
          {/* Top left */}     <PropertySearchSection />
          {/* Top right */}    <PropertyDataSection />
          {/* Bottom left */}  <ProtestTrackingSection />
          {/* Bottom right */} <CustomerSection />
        </div>
      </div>
    </div>
  );
}
