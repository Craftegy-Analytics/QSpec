import type { PresentationDefinition } from "@qspecs/core";

export interface AxisSpec {
  readonly field: string;
  readonly label?: string;
}

export interface SeriesSpec {
  readonly field: string;
  readonly label?: string;
}

/** Series derived at render time by partitioning rows on `groupBy`. (SPEC.md §47) */
export interface GroupedSeriesSpec {
  readonly field: string;
  readonly groupBy: string;
  readonly label?: string;
}

export interface LegendSpec {
  readonly visible?: boolean;
}

export interface TooltipSpec {
  readonly visible?: boolean;
}

/**
 * Shared shape for line, bar, area, and scatter.
 *
 * Declared as a `type` alias, not an `interface`: `PresentationType<T>`
 * assignability requires `T` to carry `PresentationDefinition`'s implicit index
 * signature, and only aliases get one. An interface fails under
 * `exactOptionalPropertyTypes` with TS2375. (See docs/known-gaps.md.)
 */
export type CartesianPresentation = PresentationDefinition & {
  readonly type: "line" | "bar" | "area" | "scatter";
  readonly x: AxisSpec;
  readonly series: readonly SeriesSpec[] | GroupedSeriesSpec;
  readonly y?: { readonly label?: string };
  readonly legend?: LegendSpec;
  readonly tooltip?: TooltipSpec;
};

export function isGroupedSeries(
  series: CartesianPresentation["series"],
): series is GroupedSeriesSpec {
  return !Array.isArray(series);
}

export interface SeriesPoint {
  readonly x: unknown;
  readonly y: unknown;
  /**
   * The source dataset row's index (`dataset.rows[index]`). A renderer that
   * combines several series onto one shared axis — Recharts' `<Line>`/
   * `<Bar>`/`<Area>` all need one row per x value across every series —
   * needs this to order that shared axis correctly: per-series point order
   * survives resolution (grouped series keep each group's rows in dataset
   * order), but the INTERLEAVING of one series against another does not,
   * once grouping has partitioned rows into separate arrays. Sorting the
   * merged rows by the minimum `index` across the series that contributed
   * to them recovers dataset order without this package needing to know
   * anything about how a downstream renderer merges series.
   */
  readonly index: number;
}

/** One plottable series, after any grouping has been resolved. */
export interface ResolvedSeries {
  /** Stable identity. The field name for explicit series, the group value for grouped ones. */
  readonly key: string;
  /** Display name. Falls back to `key` when no label was declared. */
  readonly label: string;
  /** The dataset field the y values came from. */
  readonly field: string;
  readonly points: readonly SeriesPoint[];
}

export type PiePresentation = PresentationDefinition & {
  readonly type: "pie";
  readonly category: AxisSpec;
  readonly value: SeriesSpec;
  readonly legend?: LegendSpec;
  readonly tooltip?: TooltipSpec;
};
