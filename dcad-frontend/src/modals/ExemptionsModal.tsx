import React from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";

export default function ExemptionsModal({
  isOpen, onClose, exemptions,
}: {
  isOpen: boolean; onClose: (open: boolean) => void;
  exemptions?: any;
}) {
  const rows = exemptions ? [
    ["City", exemptions.city],
    ["School", exemptions.school],
    ["County", exemptions.county],
    ["College", exemptions.college],
    ["Hospital", exemptions.hospital],
    ["Special District", exemptions.special_district],
  ] : [];

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>Current Exemptions</DialogTitle></DialogHeader>
        <div className="p-4">
          {rows.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Jurisdiction</TableHead>
                  <TableHead>Homestead Exemption</TableHead>
                  <TableHead>Taxable Value</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map(([name, v]: any, idx) => (
                  <TableRow key={idx}>
                    <TableCell className="font-medium">{name}</TableCell>
                    <TableCell>{v?.homestead_exemption ?? "—"}</TableCell>
                    <TableCell>{v?.taxable_value ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <div className="text-sm text-slate-600">No exemption data.</div>
          )}
        </div>
        <DialogFooter><Button onClick={() => onClose(false)}>Close</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
