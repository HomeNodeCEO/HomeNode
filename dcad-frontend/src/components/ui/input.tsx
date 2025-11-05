import * as React from "react";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className = "", ...props }, ref) => (
    <input ref={ref} className={`input input-bordered w-full ${className}`} {...props} />
  )
);
Input.displayName = "Input";
