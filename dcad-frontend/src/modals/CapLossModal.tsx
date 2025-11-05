import React from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export default function CapLossModal({
  isOpen, onClose, history,
}: { isOpen: boolean; onClose: (open:boolean)=>void; history?: { taxable_value?: any[] } }) {
  // Simple placeholder that you can expand to compute lost cap if assessed value falls, etc.
  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-xl">
        <DialogHeader><DialogTitle>Cap Loss</DialogTitle></DialogHeader>
        <div className="p-4 text-sm text-slate-700">
          Add your cap-loss logic here (compare YoY assessed increases vs 10% limit).
        </div>
        <DialogFooter><Button onClick={() => onClose(false)}>Close</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
