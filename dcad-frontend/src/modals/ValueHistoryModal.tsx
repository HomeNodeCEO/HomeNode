import React, { useState, useRef, useMemo } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogClose } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Upload, Edit, Save } from "lucide-react";

const generateInitialHistory = () => {
  const history: Array<{year:number; marketValue:number; assessedValue:number}> = [];
  let marketValue = 50000;
  let assessedValue = 48000;
  const currentYear = new Date().getFullYear();
  for (let i = 0; i < 50; i++) {
    const year = currentYear - 50 + i + 1;
    history.push({ year, marketValue, assessedValue });
    marketValue = Math.round(marketValue * (1 + (Math.random() * 0.1 + 0.02)));
    const potentialAssessed = Math.round(assessedValue * (1 + (Math.random() * 0.12 + 0.02)));
    const cap = Math.round(assessedValue * 1.10);
    assessedValue = Math.min(potentialAssessed, cap, marketValue);
  }
  return history.reverse();
};

export default function ValueHistoryModal({
  isOpen,
  onClose,
  property,
}: {
  isOpen: boolean;
  onClose: (open: boolean) => void;
  property?: { address?: string };
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [valueHistory, setValueHistory] = useState(generateInitialHistory());
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleDataChange = (index: number, field: "year" | "marketValue" | "assessedValue", value: number) => {
    const next = [...valueHistory];
    next[index][field] = value;
    setValueHistory(next);
  };

  const handleImportClick = () => fileInputRef.current?.click();

  const handleFileImport = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (e) => {
        const content = String(e.target?.result || "");
        const rows = content.split("\n").slice(1);
        const imported = rows
          .map((row) => {
            const [year, marketValue, assessedValue] = row.split(",");
            return { year: parseInt(year), marketValue: parseInt(marketValue), assessedValue: parseInt(assessedValue) };
          })
          .filter((d) => !isNaN(d.year));
        if (imported.length > 0) setValueHistory(imported.sort((a, b) => b.year - a.year));
      };
      reader.readAsText(file);
    }
    event.target.value = "";
  };

  const processedHistory = useMemo(() => {
    const sorted = [...valueHistory].sort((a, b) => a.year - b.year);
    const result = [];
    for (let i = 0; i < sorted.length; i++) {
      const cur = sorted[i];
      const prev = i > 0 ? sorted[i - 1] : undefined;
      const marketInc = prev && prev.marketValue > 0 ? ((cur.marketValue - prev.marketValue) / prev.marketValue) * 100 : 0;
      const assessedInc = prev && prev.assessedValue > 0 ? ((cur.assessedValue - prev.assessedValue) / prev.assessedValue) * 100 : 0;
      const isCapped = assessedInc >= 9.99;
      result.push({ ...cur, marketInc, assessedInc, isCapped });
    }
    return result.reverse();
  }, [valueHistory]);

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>Value History {property?.address ? `for ${property.address}` : ""}</DialogTitle>
          <div className="absolute top-4 right-16 flex gap-2">
            <Button size="sm" className="bg-green-600 hover:bg-green-700" onClick={handleImportClick}>
              <Upload className="w-4 h-4 mr-2" /> Import
            </Button>
            <input type="file" ref={fileInputRef} onChange={handleFileImport} className="hidden" accept=".csv" />
            <Button size="sm" variant={isEditing ? "default" : "destructive"} onClick={() => setIsEditing(!isEditing)}>
              {isEditing ? <Save className="w-4 h-4 mr-2" /> : <Edit className="w-4 h-4 mr-2" />}
              {isEditing ? "Save" : "Edit"}
            </Button>
          </div>
        </DialogHeader>
        <div className="max-h-[70vh] overflow-y-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Year</TableHead>
                <TableHead>Market Value</TableHead>
                <TableHead>Market % Inc</TableHead>
                <TableHead>Assessed Value</TableHead>
                <TableHead>Assessed % Inc</TableHead>
                <TableHead>10% Cap?</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {processedHistory.map((item, index) => (
                <TableRow key={item.year}>
                  <TableCell>
                    {isEditing ? (
                      <Input type="number" value={item.year} onChange={(e) => handleDataChange(index, "year", parseInt(e.target.value))} />
                    ) : (
                      item.year
                    )}
                  </TableCell>
                  <TableCell>
                    {isEditing ? (
                      <Input type="number" value={item.marketValue} onChange={(e) => handleDataChange(index, "marketValue", parseInt(e.target.value))} />
                    ) : (
                      `$${item.marketValue.toLocaleString()}`
                    )}
                  </TableCell>
                  <TableCell className={item.marketInc >= 0 ? "text-green-600" : "text-red-600"}>
                    {item.marketInc.toFixed(2)}%
                  </TableCell>
                  <TableCell>
                    {isEditing ? (
                      <Input type="number" value={item.assessedValue} onChange={(e) => handleDataChange(index, "assessedValue", parseInt(e.target.value))} />
                    ) : (
                      `$${item.assessedValue.toLocaleString()}`
                    )}
                  </TableCell>
                  <TableCell className={item.assessedInc >= 10 ? "text-red-600 font-bold" : item.assessedInc >= 0 ? "text-green-600" : "text-red-600"}>
                    {item.assessedInc.toFixed(2)}%
                  </TableCell>
                  <TableCell>{item.isCapped ? "Yes" : "No"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <DialogFooter>
          <DialogClose>
            <Button type="button" variant="secondary" onClick={() => onClose(false)}>Close</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
