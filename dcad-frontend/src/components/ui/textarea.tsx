import * as React from "react";

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className = "", ...props }, ref) => (
    <textarea
      ref={ref}
      className={
        "w-full rounded-xl border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 outline-none " + className
      }
      {...props}
    />
  )
);
Textarea.displayName = "Textarea";
