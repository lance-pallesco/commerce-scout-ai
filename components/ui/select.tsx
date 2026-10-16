import type { SelectHTMLAttributes } from "react";

import { ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";

export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className="relative block">
      <select
        className={cn(
          "flex h-10 w-full appearance-none rounded-md border border-slate-200 bg-white py-2 pr-9 pl-3 text-sm text-slate-950 shadow-xs transition-[border-color,box-shadow] outline-none focus-visible:border-teal-600 focus-visible:ring-3 focus-visible:ring-teal-100 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500",
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-slate-400"
      />
    </span>
  );
}
