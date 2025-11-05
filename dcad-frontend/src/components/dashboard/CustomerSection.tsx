import { useState } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Users, Search } from "lucide-react";

type Customer = {
  name?: string;
  address?: string;
  account_number?: string;
  phone?: string;
  email?: string;
  invoice_status?: "Pending" | "Sent" | "Paid" | "Overdue" | string;
  invoice_amount?: number;
};

export default function CustomerSection() {
  const [q, setQ] = useState("");
  const [found, setFound] = useState<Customer | null>(null);
  const [isSearching, setIsSearching] = useState(false);

  function statusColor(status?: string) {
    switch (status) {
      case "Pending": return "bg-yellow-100 text-yellow-800";
      case "Sent": return "bg-blue-100 text-blue-800";
      case "Paid": return "bg-green-100 text-green-800";
      case "Overdue": return "bg-red-100 text-red-800";
      default: return "bg-gray-100 text-gray-800";
    }
  }

  async function onSearch() {
    // TODO: wire to your customers source
    setIsSearching(true);
    // Placeholder demo:
    setTimeout(() => {
      setFound(null); // keep empty until backend exists
      setIsSearching(false);
    }, 400);
  }

  return (
    <Card className="shadow-lg border-0 bg-white/80 backdrop-blur-sm">
      <CardHeader className="bg-gradient-to-r from-orange-600 to-orange-700 text-white rounded-t-lg">
        <CardTitle className="flex items-center gap-3">
          <Users className="w-6 h-6" />
          Customer Information
        </CardTitle>
      </CardHeader>
      <CardContent className="p-6 space-y-4">
        <p className="text-slate-600">Search and manage customer information and invoices</p>

        <div className="flex gap-2">
          <Input
            placeholder="Search by name, address, or account number..."
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onSearch()}
            className="flex-1"
          />
          <Button onClick={onSearch} disabled={isSearching} className="bg-orange-600 hover:bg-orange-700">
            <Search className="w-4 h-4" />
          </Button>
        </div>

        {found && (
          <div className="p-4 bg-slate-50 rounded-lg space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="font-semibold text-slate-900">{found.name}</h4>
              {found.invoice_status && <Badge className={statusColor(found.invoice_status)}>{found.invoice_status}</Badge>}
            </div>

            <div className="space-y-2 text-sm">
              <p><strong>Address:</strong> {found.address}</p>
              <p><strong>Account:</strong> {found.account_number}</p>
              {found.phone && <p><strong>Phone:</strong> {found.phone}</p>}
              {found.email && <p><strong>Email:</strong> {found.email}</p>}
              {Number.isFinite(found.invoice_amount) && <p><strong>Invoice Amount:</strong> ${found.invoice_amount!.toLocaleString()}</p>}
            </div>
          </div>
        )}

        {q && !found && !isSearching && (
          <div className="p-4 bg-yellow-50 rounded-lg">
            <p className="text-yellow-800">No customer found matching: {q}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
