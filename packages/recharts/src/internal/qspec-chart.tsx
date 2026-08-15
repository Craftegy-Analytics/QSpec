"use client";

import type { ReactElement } from "react";
import type { Dataset, PresentationDefinition } from "@qspecs/core";
import { QSpecError } from "@qspecs/core";
import type { CartesianPresentation, PiePresentation } from "@qspecs/charts";
import { AreaChart, BarChart, LineChart, ScatterChart } from "./cartesian.js";
import { PieChart } from "./pie.js";

export interface QSpecChartProps {
  readonly dataset: Dataset;
  /**
   * Typed as the generic `PresentationDefinition` — not a union of the five
   * presentation types this package currently knows how to render — because
   * that is genuinely what arrives here at runtime: `presentation.type` is
   * whatever a `@qspecs/charts`-style plugin registered, and a plugin this
   * package has never heard of (a sixth chart type, or a typo in a manifest)
   * is exactly the case the "no renderer for this type" throw below exists
   * to catch. A narrower prop type would make that case a compile-time
   * impossibility this component could never actually be asked to handle.
   */
  readonly presentation: PresentationDefinition;
  readonly width: number;
  readonly height: number;
}

/**
 * One renderer per presentation type this package knows how to draw, keyed
 * by `presentation.type`. A `Map`, not a plain object — `QSpecChart` looks
 * this up by `presentation.type`, a caller-supplied string arriving from a
 * parsed manifest, and a `Map`'s `get` sidesteps prototype-chain lookups
 * (`"constructor"`, `"__proto__"`, ...) entirely rather than needing an
 * `Object.hasOwn` guard at every read.
 *
 * This is also the ONE place the set of known types is spelled out — the
 * thrown error below reads its "renders: ..." list straight off this map's
 * keys, so a type added here can never leave that message stale the way a
 * second, hand-copied list of names could.
 */
const RENDERERS = new Map<string, (props: QSpecChartProps) => ReactElement>([
  [
    "line",
    ({ dataset, presentation, width, height }) => (
      <LineChart
        dataset={dataset}
        presentation={presentation as CartesianPresentation}
        width={width}
        height={height}
      />
    ),
  ],
  [
    "bar",
    ({ dataset, presentation, width, height }) => (
      <BarChart
        dataset={dataset}
        presentation={presentation as CartesianPresentation}
        width={width}
        height={height}
      />
    ),
  ],
  [
    "area",
    ({ dataset, presentation, width, height }) => (
      <AreaChart
        dataset={dataset}
        presentation={presentation as CartesianPresentation}
        width={width}
        height={height}
      />
    ),
  ],
  [
    "scatter",
    ({ dataset, presentation, width, height }) => (
      <ScatterChart
        dataset={dataset}
        presentation={presentation as CartesianPresentation}
        width={width}
        height={height}
      />
    ),
  ],
  [
    "pie",
    ({ dataset, presentation, width, height }) => (
      <PieChart
        dataset={dataset}
        presentation={presentation as PiePresentation}
        width={width}
        height={height}
      />
    ),
  ],
]);

/**
 * Dispatches a resolved dataset + presentation to the renderer for its
 * `presentation.type`. `RENDERERS` above is the one place in the package
 * that has to know about every presentation type `@qspecs/charts`' `charts()`
 * plugin registers — see `qspec-chart.test.tsx`'s completeness sweep, which
 * derives that list from the plugin's own registration calls rather than a
 * second, hand-maintained copy of it.
 *
 * An unrecognized `presentation.type` throws a loud, named `QSpecError`
 * instead of returning `null`/an empty fragment. A chart that silently
 * renders blank is indistinguishable, from the outside, from a chart that
 * rendered correctly and simply had nothing to plot — the exact ambiguity
 * `assertFieldsPresent` (cartesian.tsx, pie.tsx) already refuses to leave a
 * caller to debug on their own.
 */
export function QSpecChart(props: QSpecChartProps): ReactElement {
  const renderer = RENDERERS.get(props.presentation.type);
  if (renderer === undefined) {
    const known = [...RENDERERS.keys()].sort().join(", ");
    throw new QSpecError(
      `No chart renderer registered for presentation type "${props.presentation.type}". @qspecs/recharts renders: ${known}.`,
      { code: "QSPEC_CHART_TYPE_UNSUPPORTED" },
    );
  }
  return renderer(props);
}
