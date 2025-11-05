import React from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export default function TaxRateModal({
  isOpen, onClose,
}: { isOpen: boolean; onClose: (open:boolean)=>void }) {
  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>Tax Rates</DialogTitle></DialogHeader>
        <div className="p-4 text-sm text-slate-700">
          Hook up to your rates API here (or CSV). For now this is a placeholder modal.
        </div>
        <DialogFooter><Button onClick={() => onClose(false)}>Close</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
