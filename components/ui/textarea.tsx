import type { TextareaHTMLAttributes } from "react";

import { cn } from "@/lib/utils";

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(
        "flex min-h-24 w-full rounded-md border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-950 shadow-xs transition-[border-color,box-shadow] outline-none placeholder:text-slate-400 focus-visible:border-teal-600 focus-visible:ring-3 focus-visible:ring-teal-100 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500",
        className,
      )}
      {...props}
    />
  );
}
