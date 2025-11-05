import { ReactNode } from "react";

export function Card({ className = "", children }: { className?: string; children: ReactNode }) {
  // Keep children as-is so Header/Content can be separate "card-body" blocks.
  return <div className={`card bg-base-100 shadow-sm ${className}`}>{children}</div>;
}

export function CardHeader({ className = "", children }: { className?: string; children: ReactNode }) {
  // Base44/DaisyUI puts titles inside a "card-body"
  return <div className={`card-body pb-2 ${className}`}>{children}</div>;
}

export function CardTitle({ className = "", children }: { className?: string; children: ReactNode }) {
  return <h2 className={`card-title ${className}`}>{children}</h2>;
}

export function CardContent({ className = "", children }: { className?: string; children: ReactNode }) {
  // Another body section for the content (separate from header block)
  return <div className={`card-body pt-0 ${className}`}>{children}</div>;
}
