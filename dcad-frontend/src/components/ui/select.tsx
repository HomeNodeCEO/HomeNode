import * as React from "react";

export function Select({
  value,
  onValueChange,
  children,
  className = "",
}: {
  value?: string;
  onValueChange?: (v: string) => void;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <select
      className={`select select-bordered w-full ${className}`}
      value={value}
      onChange={(e) => onValueChange?.(e.target.value)}
    >
      {children}
    </select>
  );
}

export function SelectItem({ value, children }: { value: string; children: React.ReactNode }) {
  return <option value={value}>{children}</option>;
}

// Kept for compatibility with previous JSX, they just render children
export function SelectTrigger({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
export function SelectContent({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
export function SelectValue({ placeholder }: { placeholder?: string }) {
  return <span className="text-base-content/60">{placeholder}</span>;
}
