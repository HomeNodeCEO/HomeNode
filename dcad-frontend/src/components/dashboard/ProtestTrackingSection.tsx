import { useState } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { FileText, Search } from "lucide-react";

type ProtestCase = {
  case_number: string;
  status?: "Active" | "Scheduled" | "Completed" | "Cancelled" | string;
  address?: string;
  account_number?: string;
  hearing_date?: string;
  appraised_value?: number;
  protested_value?: number;
};

export default function ProtestTrackingSection() {
  const [caseNumber, setCaseNumber] = useState("");
  const [foundCase, setFoundCase] = useState<ProtestCase | null>(null);
  const [isSearching, setIsSearching] = useState(false);

  function getStatusColor(status?: string) {
    switch (status) {
      case "Active": return "bg-blue-100 text-blue-800";
      case "Scheduled": return "bg-yellow-100 text-yellow-800";
      case "Completed": return "bg-green-100 text-green-800";
      case "Cancelled": return "bg-red-100 text-red-800";
      default: return "bg-gray-100 text-gray-800";
    }
  }

  async function handleCaseSearch() {
    // TODO: wire to your Protest cases source
    setIsSearching(true);
    // Placeholder demo:
    setTimeout(() => {
      setFoundCase(null); // keep empty until backend exists
      setIsSearching(false);
    }, 400);
  }

  return (
    <Card className="shadow-lg border-0 bg-white/80 backdrop-blur-sm">
      <CardHeader className="bg-gradient-to-r from-purple-600 to-purple-700 text-white rounded-t-lg">
        <CardTitle className="flex items-center gap-3">
          <FileText className="w-6 h-6" />
          Active Protests Tracking
        </CardTitle>
      </CardHeader>
      <CardContent className="p-6 space-y-4">
        <p className="text-slate-600">Track and manage active protest cases</p>

        <div className="flex gap-2">
          <Input
            placeholder="Enter case number..."
            value={caseNumber}
            onChange={(e) => setCaseNumber(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCaseSearch()}
            className="flex-1"
          />
          <Button onClick={handleCaseSearch} disabled={isSearching} className="bg-purple-600 hover:bg-purple-700">
            <Search className="w-4 h-4" />
          </Button>
        </div>

        {foundCase && (
          <div className="p-4 bg-slate-50 rounded-lg space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="font-semibold text-slate-900">Case #{foundCase.case_number}</h4>
              <Badge className={getStatusColor(foundCase.status)}>{foundCase.status || "Unknown"}</Badge>
            </div>
            <div className="space-y-2 text-sm">
              <p><strong>Address:</strong> {foundCase.address || "—"}</p>
              <p><strong>Account:</strong> {foundCase.account_number || "—"}</p>
              {foundCase.hearing_date && <p><strong>Hearing Date:</strong> {new Date(foundCase.hearing_date).toLocaleDateString()}</p>}
              {Number.isFinite(foundCase.appraised_value) && <p><strong>Appraised Value:</strong> ${foundCase.appraised_value!.toLocaleString()}</p>}
              {Number.isFinite(foundCase.protested_value) && <p><strong>Protested Value:</strong> ${foundCase.protested_value!.toLocaleString()}</p>}
            </div>
          </div>
        )}

        {caseNumber && !foundCase && !isSearching && (
          <div className="p-4 bg-yellow-50 rounded-lg">
            <p className="text-yellow-800">No case found with number: {caseNumber}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
