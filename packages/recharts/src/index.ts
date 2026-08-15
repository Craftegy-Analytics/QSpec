"use client";

/**
 * Recharts renderers for every presentation type `@qspecs/charts`' `charts()`
 * plugin registers: `line`, `bar`, `area`, and `scatter`
 * (`@qspecs/charts`' `cartesianPresentationType` — see that package's
 * `index.ts`), plus `pie`. Each renderer consumes `resolveSeries`'s
 * already-resolved model (pie has no series to resolve — it reads its
 * dataset rows directly) and nothing else from the dataset, so grouped and
 * explicit series render identically here.
 *
 * `QSpecChart` dispatches a dataset + presentation pair to the renderer for
 * its `presentation.type`, throwing a named error for any type it doesn't
 * recognize rather than rendering nothing — see `qspec-chart.tsx`'s doc
 * comment and its completeness sweep test.
 *
 * `"use client"` at the top of this file marks every export below as
 * client-only for bundlers that understand React Server Components —
 * Recharts renders SVG via browser-only measurement and DOM APIs, so a
 * server component tree must cross a client boundary before rendering
 * anything from this package.
 */
export {
  LineChart,
  BarChart,
  AreaChart,
  ScatterChart,
  type CartesianChartProps,
} from "./internal/cartesian.js";
export { PieChart, type PieChartProps } from "./internal/pie.js";
export { QSpecChart, type QSpecChartProps } from "./internal/qspec-chart.js";
