import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

type ChangeLogEntry = {
  section?: string;
  timestamp?: string | number;
  user?: string;
  before?: unknown;
  after?: unknown;
};

function printableChange(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) || "No value";
  } catch {
    return "Value could not be displayed";
  }
}

export default function ChangeLogModal({
  isOpen, onClose, logs,
}: { isOpen: boolean; onClose: (open:boolean)=>void; logs: ChangeLogEntry[] }) {
  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>Change Log</DialogTitle></DialogHeader>
        <div className="p-4 space-y-3 max-h-[60vh] overflow-auto text-sm">
          {(logs || []).length ? logs.map((log, i)=>(
            <div key={i} className="p-3 rounded-lg border">
              <div className="font-medium">
                {log.section || "Unspecified section"} — {log.timestamp ? new Date(log.timestamp).toLocaleString() : "Time unavailable"}
              </div>
              <div className="text-slate-600">User: {log.user || "Unknown"}</div>
              <pre className="mt-2 bg-slate-50 p-2 rounded">{printableChange({ before: log.before, after: log.after })}</pre>
            </div>
          )) : <div className="text-slate-600">No changes recorded yet.</div>}
        </div>
        <DialogFooter><Button onClick={() => onClose(false)}>Close</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
