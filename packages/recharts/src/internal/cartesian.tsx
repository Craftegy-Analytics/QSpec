"use client";

import type { ReactElement } from "react";
import type { Dataset } from "@qspecs/core";
import { QSpecError } from "@qspecs/core";
import {
  isGroupedSeries,
  resolveSeries,
  type CartesianPresentation,
  type ResolvedSeries,
} from "@qspecs/charts";
import {
  Area,
  AreaChart as RechartsAreaChart,
  Bar,
  BarChart as RechartsBarChart,
  Line,
  LineChart as RechartsLineChart,
  Scatter,
  ScatterChart as RechartsScatterChart,
  XAxis,
  YAxis,
} from "recharts";
import { legendElement, tooltipElement } from "./shared.js";

export interface CartesianChartProps {
  readonly dataset: Dataset;
  readonly presentation: CartesianPresentation;
  /**
   * Required rather than defaulted to a `<ResponsiveContainer>` wrapper —
   * Recharts' chart components render nothing meaningful without an
   * explicit pixel size, `ResponsiveContainer` measures its parent (which
   * jsdom reports as zero-sized, so tests would silently render an empty
   * chart), and a responsive wrapper is a separate, YAGNI-for-now concern a
   * caller can add around this component themselves.
   */
  readonly width: number;
  readonly height: number;
}

/**
 * One row of the wide table Recharts' `<Line>`/`<Bar>`/`<Area>` expect when
 * several series share one chart: one row per distinct x value, with each
 * series' y value (or `undefined`, if that series has no point at this x)
 * at its own index in `values`.
 *
 * `x` and `values` are read back through `dataKey` FUNCTION accessors
 * (`(row) => row.x`, `(row) => row.values[i]`), not string property names
 * keyed by field or series identity. A string dataKey would have to be a
 * real property name, and every candidate — the x field's name, a series'
 * key — is a name this component does not control: it is whatever a
 * manifest author chose for a dataset field. Reusing it risks a series
 * whose field happens to be named "x" colliding with the axis's own column.
 * Function accessors close over a fixed index instead, so the row shape
 * (`x`, `values`) never has to avoid caller-chosen names at all.
 */
interface WideRow {
  readonly x: unknown;
  readonly values: readonly unknown[];
}

/**
 * Every dataset field name a `CartesianPresentation` can reference, checked
 * against what the dataset's schema actually declares. `resolveSeries`
 * itself does not validate this — `row[spec.field]` on a field the dataset
 * doesn't have simply reads `undefined` for every row, which would render a
 * chart with a flat/empty line and no indication anything is wrong. A
 * misconfigured field name is a manifest defect, not an empty result, so it
 * is reported the same way the rest of this codebase reports one: a thrown
 * `QSpecError` naming the field, not a silently empty chart.
 */
function assertFieldsPresent(dataset: Dataset, presentation: CartesianPresentation): void {
  const known = new Set(dataset.fields.map((field) => field.name));
  const missing: string[] = [];

  if (!known.has(presentation.x.field)) {
    missing.push(`x.field "${presentation.x.field}"`);
  }

  if (isGroupedSeries(presentation.series)) {
    if (!known.has(presentation.series.field)) {
      missing.push(`series.field "${presentation.series.field}"`);
    }
    if (!known.has(presentation.series.groupBy)) {
      missing.push(`series.groupBy "${presentation.series.groupBy}"`);
    }
  } else {
    presentation.series.forEach((spec, index) => {
      if (!known.has(spec.field)) {
        missing.push(`series[${index}].field "${spec.field}"`);
      }
    });
  }

  if (missing.length > 0) {
    const availability =
      known.size === 0
        ? "the dataset declares no fields"
        : `known fields: ${[...known].join(", ")}`;
    throw new QSpecError(
      `Chart presentation references field(s) the dataset does not have: ${missing.join(", ")} (${availability}).`,
      { code: "QSPEC_CHART_FIELD_MISSING" },
    );
  }
}

interface PivotRow {
  x: unknown;
  values: unknown[];
  /** The lowest source dataset row index of any point folded into this row — see `buildWideRows`. */
  minIndex: number;
  /** Which `values` slots are filled, so a legitimate `undefined` y value cannot be mistaken for "not yet set". */
  filled: Set<number>;
}

/**
 * Pivots resolved series (one x/y point list per series, each point
 * carrying the source dataset row's `index` — see `SeriesPoint` in
 * `@qspecs/charts`) into the shared wide table Recharts wants for
 * `<Line>`/`<Bar>`/`<Area>`: one row per distinct x value. `Scatter` does
 * not go through this — each `<Scatter>` plots its own point cloud directly
 * from `ResolvedSeries.points`, so pivoting would throw away the very shape
 * Recharts wants there.
 *
 * x values are deduplicated by `typeof + String`, not `String` alone, so a
 * numeric `1` and a string `"1"` never collide onto one row.
 *
 * Row order is `minIndex` across every point folded into that row, NOT
 * first-appearance order while walking series in turn. Per-series point
 * order matches dataset order (grouped series keep each group's rows in
 * dataset order), but the INTERLEAVING between series does not survive
 * grouping — series-by-series iteration for dataset rows
 * `Jan/West, Feb/East, Mar/West` would visit West's `Jan, Mar` before
 * East's `Feb`, emitting an x axis in the wrong order (`Jan, Mar, Feb`)
 * with no error. Sorting by each row's earliest contributing dataset row
 * recovers the correct order regardless of how resolveSeries partitioned
 * the rows into series.
 *
 * Two points landing on the same x value WITHIN one series (an
 * unaggregated dataset — e.g. two rows both labelled "Jan" for the same
 * series) has no sensible rendering: Recharts can plot one y value per
 * series per x, not two. Rather than silently keep the last one and drop
 * the other (silent data loss, and a behavior change from the per-series
 * `data` shape this pivot replaced), that's a loud, named `QSpecError` —
 * consistent with how `assertFieldsPresent` already treats a
 * misconfigured chart as a manifest defect, not something to render around.
 *
 * A point whose x is `null` or `undefined` — `resolveSeries` deliberately
 * keeps these rather than dropping the row (see its "yields undefined for
 * missing x" test) — is skipped here instead of pivoted. It is NOT treated
 * as "two points at the same x" the way two real `"Jan"` values would be:
 * unlike a genuine duplicate, which signals an unaggregated dataset worth
 * failing loudly over, two points that are both simply MISSING an x carry
 * no information that distinguishes one from the other, so there is no
 * "real" x = undefined for them to collide on in the first place. Prior to
 * this pivot, each series kept its own independent point list, so two
 * missing-x rows in one series never collided; folding every series onto
 * one shared row set must not turn that into a hard failure. Dropping the
 * point (not plotting it) is consistent with this file's other graceful-
 * degradation case — a zero-row dataset renders an empty chart, not a
 * throw — rather than treating incomplete data as a manifest defect.
 */
function buildWideRows(series: readonly ResolvedSeries[]): readonly WideRow[] {
  const rowsByX = new Map<string, PivotRow>();

  series.forEach((oneSeries, seriesIndex) => {
    for (const point of oneSeries.points) {
      if (point.x === null || point.x === undefined) continue;
      const xIdentity = `${typeof point.x}:${String(point.x)}`;
      let row = rowsByX.get(xIdentity);
      if (row === undefined) {
        row = {
          x: point.x,
          values: new Array<unknown>(series.length),
          minIndex: point.index,
          filled: new Set(),
        };
        rowsByX.set(xIdentity, row);
      } else if (point.index < row.minIndex) {
        row.minIndex = point.index;
      }
      if (row.filled.has(seriesIndex)) {
        throw new QSpecError(
          `Series "${oneSeries.field}" (${oneSeries.label}) has two points at x = ${String(point.x)} — a chart can only plot one y value per series per x. Aggregate the dataset before charting it (e.g. a groupBy transform, or aggregate in the underlying SQL).`,
          { code: "QSPEC_CHART_DUPLICATE_X" },
        );
      }
      row.filled.add(seriesIndex);
      row.values[seriesIndex] = point.y;
    }
  });

  return [...rowsByX.values()]
    .sort((a, b) => a.minIndex - b.minIndex)
    .map((row): WideRow => ({ x: row.x, values: row.values }));
}

/** Renders `label` only when the presentation supplies one — never a fallback to the field name. */
function labelProp(label: string | undefined): { readonly label: string } | Record<string, never> {
  return label === undefined ? {} : { label };
}

/** Every dataset field a scatter presentation's y axis can come from: one per explicit series, or the grouped spec's one field. */
function scatterYFields(presentation: CartesianPresentation): readonly string[] {
  return isGroupedSeries(presentation.series)
    ? [presentation.series.field]
    : presentation.series.map((spec) => spec.field);
}

/**
 * Recharts' `<XAxis>`/`<YAxis>` `type` picked from the dataset's OWN
 * declared field type, not hardcoded — a scatter presentation whose x (or
 * y) field is a `string`/`date`/etc. column plotted against a hardcoded
 * `type="number"` axis renders an empty plot with no error: the exact
 * "silently empty chart" this package exists to avoid, arriving through a
 * different door than a missing field. `"number"` only when every field
 * checked is declared `number` or `integer`; `"category"` otherwise
 * (including when a field isn't found, which `assertFieldsPresent` — always
 * called first — has already ruled out). `"category"` is the safe default:
 * unlike a wrongly-numeric axis, it still renders something for any field
 * type, numeric included.
 */
function scatterAxisType(dataset: Dataset, fieldNames: readonly string[]): "number" | "category" {
  const isNumeric = (name: string): boolean => {
    const field = dataset.fields.find((candidate) => candidate.name === name);
    return field?.type === "number" || field?.type === "integer";
  };
  return fieldNames.length > 0 && fieldNames.every(isNumeric) ? "number" : "category";
}

export function LineChart(props: CartesianChartProps): ReactElement {
  const { dataset, presentation, width, height } = props;
  assertFieldsPresent(dataset, presentation);
  const series = resolveSeries(dataset, presentation);
  const rows = buildWideRows(series);

  return (
    <RechartsLineChart width={width} height={height} data={rows}>
      <XAxis dataKey={(row: WideRow) => row.x} {...labelProp(presentation.x.label)} />
      <YAxis {...labelProp(presentation.y?.label)} />
      {legendElement(presentation.legend)}
      {tooltipElement(presentation.tooltip)}
      {series.map((oneSeries, index) => (
        // Keyed `${key}:${index}`, not `key` alone: resolveSeries keys an
        // EXPLICIT series by its field name, so two array entries plotting
        // the same field under different labels (e.g. "revenue" as both
        // "Gross" and "Net") share one `key` — the index suffix keeps
        // React's reconciliation from colliding. Grouped series don't need
        // this (each group's key is already a distinct value), but the
        // suffix is harmless there too, so every kind uses the same form.
        <Line
          key={`${oneSeries.key}:${index}`}
          name={oneSeries.label}
          dataKey={(row: WideRow) => row.values[index]}
        />
      ))}
    </RechartsLineChart>
  );
}

export function BarChart(props: CartesianChartProps): ReactElement {
  const { dataset, presentation, width, height } = props;
  assertFieldsPresent(dataset, presentation);
  const series = resolveSeries(dataset, presentation);
  const rows = buildWideRows(series);

  return (
    <RechartsBarChart width={width} height={height} data={rows}>
      <XAxis dataKey={(row: WideRow) => row.x} {...labelProp(presentation.x.label)} />
      <YAxis {...labelProp(presentation.y?.label)} />
      {legendElement(presentation.legend)}
      {tooltipElement(presentation.tooltip)}
      {series.map((oneSeries, index) => (
        <Bar
          key={`${oneSeries.key}:${index}`}
          name={oneSeries.label}
          dataKey={(row: WideRow) => row.values[index]}
        />
      ))}
    </RechartsBarChart>
  );
}

export function AreaChart(props: CartesianChartProps): ReactElement {
  const { dataset, presentation, width, height } = props;
  assertFieldsPresent(dataset, presentation);
  const series = resolveSeries(dataset, presentation);
  const rows = buildWideRows(series);

  return (
    <RechartsAreaChart width={width} height={height} data={rows}>
      <XAxis dataKey={(row: WideRow) => row.x} {...labelProp(presentation.x.label)} />
      <YAxis {...labelProp(presentation.y?.label)} />
      {legendElement(presentation.legend)}
      {tooltipElement(presentation.tooltip)}
      {series.map((oneSeries, index) => (
        <Area
          key={`${oneSeries.key}:${index}`}
          name={oneSeries.label}
          dataKey={(row: WideRow) => row.values[index]}
        />
      ))}
    </RechartsAreaChart>
  );
}

/**
 * Scatter does not pivot into `WideRow`s the way the other three do: each
 * series is its own point cloud with no expectation of sharing x values
 * with any other series, so `<Scatter data={oneSeries.points}>` — each
 * fed straight from `resolveSeries`' `{x, y}` points — is both simpler and
 * more correct here than forcing every series onto one shared row set.
 * Axis `type` is derived per axis from the dataset's declared field
 * type(s) (`scatterAxisType`), not hardcoded to `"number"` — see that
 * function's doc comment.
 */
export function ScatterChart(props: CartesianChartProps): ReactElement {
  const { dataset, presentation, width, height } = props;
  assertFieldsPresent(dataset, presentation);
  const series = resolveSeries(dataset, presentation);
  const xType = scatterAxisType(dataset, [presentation.x.field]);
  const yType = scatterAxisType(dataset, scatterYFields(presentation));

  return (
    <RechartsScatterChart width={width} height={height}>
      <XAxis dataKey="x" type={xType} {...labelProp(presentation.x.label)} />
      <YAxis dataKey="y" type={yType} {...labelProp(presentation.y?.label)} />
      {legendElement(presentation.legend)}
      {tooltipElement(presentation.tooltip)}
      {series.map((oneSeries, index) => (
        <Scatter key={`${oneSeries.key}:${index}`} name={oneSeries.label} data={oneSeries.points} />
      ))}
    </RechartsScatterChart>
  );
}
