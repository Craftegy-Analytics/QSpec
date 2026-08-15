import type { Dataset } from "@qspecs/core";
import {
  isGroupedSeries,
  type CartesianPresentation,
  type ResolvedSeries,
  type SeriesPoint,
} from "../types.js";

/** Label used for rows whose grouping value is null or absent. */
export const UNGROUPED_LABEL = "(none)";

/**
 * Turns a presentation's series declaration into concrete, plottable series.
 *
 * This lives in @qspecs/charts rather than in each renderer so that Recharts,
 * ECharts, a CLI renderer, and anything else cannot disagree about ordering,
 * null handling, or missing categories. The package still renders nothing.
 * (SPEC.md §47)
 *
 * Ownership: the returned series array, each series object, each points array,
 * and each point object are freshly allocated, so a caller may reorder, splice,
 * or reassign them without affecting the dataset or another call's result.
 * Point VALUES are not cloned — `x` and `y` reference the row's cell directly,
 * so mutating the internals of an object- or array-valued cell reached through
 * a point does reach the dataset. Cloning every cell would be a real cost on
 * large results for a hazard that only exists for composite cell types.
 */
export function resolveSeries(
  dataset: Dataset,
  presentation: CartesianPresentation,
): readonly ResolvedSeries[] {
  const xField = presentation.x.field;

  if (!isGroupedSeries(presentation.series)) {
    return presentation.series.map((spec) => ({
      key: spec.field,
      label: spec.label ?? spec.field,
      field: spec.field,
      points: dataset.rows.map((row, index): SeriesPoint => ({
        x: row[xField],
        y: row[spec.field],
        index,
      })),
    }));
  }

  const { field, groupBy, label } = presentation.series;
  // Insertion order of a Map is first-appearance order in the dataset, which is
  // deterministic and matches what the data actually looks like. Sorting would
  // be a second, invisible policy decision.
  const groups = new Map<string, SeriesPoint[]>();

  dataset.rows.forEach((row, index) => {
    const raw = row[groupBy];
    // Decision: a genuinely-empty-string group value shares key "" with
    // nullish values, so the two merge into one series labelled "(none)".
    // Deliberate, not an oversight: a distinct sentinel for "missing" would
    // itself have to be a string, and every string candidate is
    // either ugly or just as collidable with a real group value — there is
    // no key space wide enough to rule it out entirely. Merging the two
    // genuinely-empty cases is the honest tradeoff, pinned by the test
    // "merges a null group with an empty-string group" below.
    const key = raw === null || raw === undefined ? "" : String(raw);
    const points = groups.get(key);
    const point: SeriesPoint = { x: row[xField], y: row[field], index };
    if (points === undefined) groups.set(key, [point]);
    else points.push(point);
  });

  // Decision: a declared `label` on a grouped spec is used as a PREFIX, joined
  // to the group value with ": " (e.g. label "Revenue" + group "West" =>
  // "Revenue: West"). A bare group value alone is often ambiguous in a legend
  // ("West", "East" doesn't say what's being measured), and an author who
  // bothered to declare a label is signalling they want it visible — ignoring
  // it would silently discard information they explicitly provided.
  return [...groups.entries()].map(([key, points]) => {
    const groupLabel = key === "" ? UNGROUPED_LABEL : key;
    return {
      key,
      label: label === undefined ? groupLabel : `${label}: ${groupLabel}`,
      field,
      points,
    };
  });
}
