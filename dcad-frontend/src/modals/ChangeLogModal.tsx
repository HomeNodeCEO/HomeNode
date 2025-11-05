import React from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export default function ChangeLogModal({
  isOpen, onClose, logs,
}: { isOpen: boolean; onClose: (open:boolean)=>void; logs: any[] }) {
  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>Change Log</DialogTitle></DialogHeader>
        <div className="p-4 space-y-3 max-h-[60vh] overflow-auto text-sm">
          {(logs || []).length ? logs.map((log, i)=>(
            <div key={i} className="p-3 rounded-lg border">
              <div className="font-medium">{log.section} — {new Date(log.timestamp).toLocaleString()}</div>
              <div className="text-slate-600">User: {log.user}</div>
              <pre className="mt-2 bg-slate-50 p-2 rounded">{JSON.stringify({ before: log.before, after: log.after }, null, 2)}</pre>
            </div>
          )) : <div className="text-slate-600">No changes recorded yet.</div>}
        </div>
        <DialogFooter><Button onClick={() => onClose(false)}>Close</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
