"use client";

import type { CSSProperties, HTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/utils";

export type ChartConfig = Record<
  string,
  {
    label?: ReactNode;
    color?: string;
  }
>;

export function ChartContainer({
  className,
  config,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & { config: ChartConfig }) {
  const chartStyle = Object.entries(config).reduce<Record<string, string>>(
    (style, [key, value]) => {
      if (value.color) style[`--color-${key}`] = value.color;
      return style;
    },
    {},
  );

  return (
    <div
      className={cn("relative w-full text-xs [&_.recharts-cartesian-axis-tick_value]:fill-slate-500", className)}
      data-chart="chart"
      style={chartStyle as CSSProperties}
      {...props}
    >
      {children}
    </div>
  );
}
