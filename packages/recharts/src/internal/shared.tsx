"use client";

import type { ReactElement } from "react";
import type { LegendSpec, TooltipSpec } from "@qspecs/charts";
import { Legend, Tooltip } from "recharts";

/**
 * `<Legend>` when the presentation opts in; nothing otherwise. Recharts' own
 * default is to omit it. Shared by every renderer in this package (cartesian
 * and pie alike) — `LegendSpec` is the same shape regardless of which
 * presentation it's attached to.
 */
export function legendElement(legend: LegendSpec | undefined): ReactElement | null {
  return legend?.visible === true ? <Legend /> : null;
}

/** `<Tooltip>` when the presentation opts in; nothing otherwise. */
export function tooltipElement(tooltip: TooltipSpec | undefined): ReactElement | null {
  return tooltip?.visible === true ? <Tooltip /> : null;
}
