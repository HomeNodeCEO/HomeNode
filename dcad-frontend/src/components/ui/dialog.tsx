import * as React from "react";
import type { ReactNode } from "react";

export function Dialog({
  open,
  onOpenChange,
  children,
}: { open: boolean; onOpenChange: (open: boolean) => void; children: ReactNode }) {
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onOpenChange(false); };
    if (open) document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={() => onOpenChange(false)} />
      {children}
    </div>
  );
}

export function DialogContent({ className = "", children }:{ className?: string; children: ReactNode }) {
  return (
    <div className={`relative z-10 w-[95vw] max-w-4xl rounded-2xl bg-white shadow-xl ${className}`}>
      {children}
    </div>
  );
}
export function DialogHeader({ children }:{ children: ReactNode }) {
  return <div className="p-4 border-b">{children}</div>;
}
export function DialogTitle({ children }:{ children: ReactNode }) {
  return <h3 className="text-lg font-semibold">{children}</h3>;
}
export function DialogFooter({ children }:{ children: ReactNode }) {
  return <div className="p-4 border-t flex justify-end gap-2">{children}</div>;
}
export function DialogClose({ children }:{ children: ReactNode }) {
  return <>{children}</>;
}
