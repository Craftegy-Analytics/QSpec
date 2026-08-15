import { definePlugin, type PresentationType, type QSpecPlugin } from "@qspecs/core";
import { cartesianPresentationType } from "./internal/cartesian.js";
import { piePresentationType } from "./internal/pie.js";

export type {
  AxisSpec,
  SeriesSpec,
  GroupedSeriesSpec,
  CartesianPresentation,
  LegendSpec,
  TooltipSpec,
  SeriesPoint,
  ResolvedSeries,
  PiePresentation,
} from "./types.js";
export { isGroupedSeries } from "./types.js";
export { resolveSeries, UNGROUPED_LABEL } from "./internal/resolve-series.js";

/**
 * Registers the five standard chart presentation types and the `Chart`
 * resource kind. `line`, `bar`, `area`, and `scatter` are registered under
 * distinct names because renderers treat them differently, but they share one
 * `PresentationType` implementation — the shape (an x axis plus one or more
 * series) is identical across the four. `pie` has no x axis and no dynamic
 * series, so it gets its own. (SPEC.md §17, §47)
 *
 * The internal `PresentationType` objects are deliberately not exported from
 * this package's public surface — a consumer registers them by installing
 * this plugin, not by importing them directly.
 */
export function charts(): QSpecPlugin {
  return definePlugin({
    name: "@qspecs/charts",
    setup(api) {
      api.presentations.register("line", cartesianPresentationType as PresentationType);
      api.presentations.register("bar", cartesianPresentationType as PresentationType);
      api.presentations.register("area", cartesianPresentationType as PresentationType);
      api.presentations.register("scatter", cartesianPresentationType as PresentationType);
      api.presentations.register("pie", piePresentationType as PresentationType);

      // requiresQuery: true because a chart with no data source cannot
      // render anything — failing at prepare() with a clear message beats
      // failing at execution with an empty dataset. requiresPresentation:
      // true because a Chart with no presentation gives a renderer nothing
      // to plot the dataset with. Core registers only "Dataset"; "Chart"
      // belongs here because the package that defines what a chart *is* is
      // the one that should declare what it needs. (SPEC.md §24)
      api.resources.register("Chart", {
        requiresQuery: true,
        requiresPresentation: true,
      });
    },
  });
}
