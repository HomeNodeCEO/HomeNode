import { ReactNode } from "react";

export function Badge({
  variant = "default",
  className = "",
  children,
}: {
  variant?: "default" | "secondary" | "outline" | "success" | "warning" | "destructive";
  className?: string;
  children: ReactNode;
}) {
  const base = "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium border";
  const styles =
    variant === "secondary" ? "bg-slate-100 text-slate-700 border-slate-200" :
    variant === "outline"   ? "bg-white text-slate-700 border-slate-300" :
    variant === "success"   ? "bg-emerald-50 text-emerald-700 border-emerald-200" :
    variant === "warning"   ? "bg-amber-50 text-amber-700 border-amber-200" :
    variant === "destructive"? "bg-rose-50 text-rose-700 border-rose-200" :
                               "bg-slate-900 text-white border-slate-900";
  return <span className={`${base} ${styles} ${className}`}>{children}</span>;
}
