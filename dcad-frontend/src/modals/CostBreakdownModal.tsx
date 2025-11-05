import React from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";

export default function CostBreakdownModal({
  isOpen, onClose, valueSummary, additionalImprovements,
}: {
  isOpen: boolean; onClose: (open:boolean)=>void;
  valueSummary?: any; additionalImprovements?: any[];
}) {
  const rows = [
    ["Improvement Value", valueSummary?.improvement_value ?? "—"],
    ["Land Value", valueSummary?.land_value ?? "—"],
    ["Market Value", valueSummary?.market_value ?? "—"],
  ];

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>Cost Breakdown</DialogTitle></DialogHeader>
        <div className="p-4 space-y-6">
          <Table>
            <TableHeader><TableRow><TableHead>Item</TableHead><TableHead>Value</TableHead></TableRow></TableHeader>
            <TableBody>
              {rows.map(([k,v])=>(
                <TableRow key={String(k)}>
                  <TableCell className="font-medium">{k}</TableCell>
                  <TableCell>{String(v)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <div>
            <div className="font-semibold mb-2">Secondary Improvements</div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>#</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Construction</TableHead>
                  <TableHead>Area (sqft)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(additionalImprovements || []).map((imp, i)=>(
                  <TableRow key={i}>
                    <TableCell>{i+1}</TableCell>
                    <TableCell>{imp.improvement_type}</TableCell>
                    <TableCell>{imp.construction}</TableCell>
                    <TableCell>{imp.area_sqft}</TableCell>
                  </TableRow>
                ))}
                {(!additionalImprovements || additionalImprovements.length===0) && (
                  <TableRow><TableCell colSpan={4} className="text-slate-500">None</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </div>
        <DialogFooter><Button onClick={() => onClose(false)}>Close</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
