import * as React from "react";

type Variant = "primary" | "default" | "secondary" | "ghost" | "outline" | "destructive";
type Size = "sm" | "default" | "lg" | "icon";

export function Button({
  className = "",
  variant = "primary",
  size = "default",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  const base = "btn app-action-button";
  const styles =
    variant === "secondary"
      ? "btn-secondary"
      : variant === "ghost"
      ? "btn-ghost"
      : variant === "outline"
      ? "btn-outline"
      : variant === "destructive"
      ? "btn-error"
      : "btn-primary";
  const sizing =
    size === "sm"
      ? "btn-sm"
      : size === "lg"
      ? "btn-lg"
      : size === "icon"
      ? "btn-square"
      : "";
  return <button className={`${base} ${styles} ${sizing} ${className}`} {...props} />;
}
