import * as React from "react";

type Variant = "primary" | "secondary" | "ghost" | "outline";

export function Button({
  className = "",
  variant = "primary",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  const base = "btn"; // DaisyUI base
  const styles =
    variant === "secondary"
      ? "btn-secondary"
      : variant === "ghost"
      ? "btn-ghost"
      : variant === "outline"
      ? "btn-outline"
      : "btn-primary";
  return <button className={`${base} ${styles} ${className}`} {...props} />;
}
