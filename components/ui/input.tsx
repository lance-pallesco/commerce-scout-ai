import type { InputHTMLAttributes } from "react";

import { cn } from "@/lib/utils";

export function Input({ className, type = "text", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "flex h-10 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-950 shadow-xs transition-[border-color,box-shadow] outline-none placeholder:text-slate-400 focus-visible:border-teal-600 focus-visible:ring-3 focus-visible:ring-teal-100 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500",
        className,
      )}
      type={type}
      {...props}
    />
  );
}
