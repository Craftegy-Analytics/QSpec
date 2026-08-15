"use client";

import type { ReactElement } from "react";
import type { Dataset } from "@qspecs/core";
import { QSpecError } from "@qspecs/core";
import type { PiePresentation } from "@qspecs/charts";
import { Cell, Pie, PieChart as RechartsPieChart } from "recharts";
import { legendElement, tooltipElement } from "./shared.js";

export interface PieChartProps {
  readonly dataset: Dataset;
  readonly presentation: PiePresentation;
  /** See `CartesianChartProps.width`/`.height` in cartesian.tsx: same reasoning applies here. */
  readonly width: number;
  readonly height: number;
}

/** One dataset row, reshaped into what Recharts' `<Pie>` reads via `dataKey`/`nameKey`. */
interface PieRow {
  readonly name: unknown;
  readonly value: unknown;
}

/**
 * Mirrors `assertFieldsPresent` in cartesian.tsx: a pie presentation
 * referencing a field the dataset doesn't declare is a manifest defect, not
 * an empty result — `row[spec.field]` on a missing field simply reads
 * `undefined` for every row, which would render a pie of blank/zero slices
 * with no indication anything is wrong. Reported the same way: a thrown
 * `QSpecError` naming the field, not a silently empty chart.
 */
function assertFieldsPresent(dataset: Dataset, presentation: PiePresentation): void {
  const known = new Set(dataset.fields.map((field) => field.name));
  const missing: string[] = [];

  if (!known.has(presentation.category.field)) {
    missing.push(`category.field "${presentation.category.field}"`);
  }
  if (!known.has(presentation.value.field)) {
    missing.push(`value.field "${presentation.value.field}"`);
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

/**
 * One row per dataset row, unlike cartesian's `buildWideRows` — pie has no x
 * axis and no series to pivot onto a shared axis (`PiePresentation` carries
 * one category field and one value field for the whole chart), so there is
 * nothing to fold rows together on. A dataset with two rows for the same
 * category renders two slices, not one merged slice: aggregating is the
 * caller's job (a groupBy transform, or the underlying SQL), the same
 * division of responsibility cartesian's duplicate-x error leans on.
 */
function buildPieRows(dataset: Dataset, presentation: PiePresentation): readonly PieRow[] {
  const { category, value } = presentation;
  return dataset.rows.map((row): PieRow => ({
    name: row[category.field],
    value: row[value.field],
  }));
}

/**
 * Renders one `<Cell>` per row/category. `<Cell>` itself renders nothing —
 * Recharts reads it back off `<Pie>`'s children to know how many/which
 * slices to draw — but rendering one per row (rather than none, and letting
 * `<Pie>` infer slice count from `data` alone) keeps a styling hook in place
 * for a future caller without this package having to add theming now.
 *
 * `isAnimationActive={false}`: unlike `<Line>`/`<Bar>`/`<Area>` (whose
 * marks exist in the DOM immediately and animate via CSS), Recharts' `<Pie>`
 * computes each sector's geometry through a JS-interpolated animation whose
 * first committed frame renders zero sectors — nothing to plot until a
 * `requestAnimationFrame` tick that a synchronous `render()` (jsdom or any
 * other non-interactive consumer of this component) never reaches. Without
 * this, the exact "silently empty chart" the rest of this package's field
 * validation exists to avoid would arrive through the render animation
 * timing itself, on every pie, always, until something happened to trigger
 * a further tick. Not an exposed animation *option* — a fixed default
 * chosen so this component's own render output is complete the moment it
 * returns, matching `CartesianChartProps.width`/`.height`'s reasoning for
 * requiring an explicit pixel size instead of `<ResponsiveContainer>`.
 */
export function PieChart(props: PieChartProps): ReactElement {
  const { dataset, presentation, width, height } = props;
  assertFieldsPresent(dataset, presentation);
  const rows = buildPieRows(dataset, presentation);

  return (
    <RechartsPieChart width={width} height={height}>
      {legendElement(presentation.legend)}
      {tooltipElement(presentation.tooltip)}
      <Pie data={rows} dataKey="value" nameKey="name" isAnimationActive={false}>
        {rows.map((row, index) => (
          <Cell key={`${String(row.name)}:${index}`} />
        ))}
      </Pie>
    </RechartsPieChart>
  );
}
