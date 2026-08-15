import { describe, expect, it } from "vitest";
import type { Dataset, Field } from "@qspecs/core";
import { resolveSeries } from "./resolve-series.js";
import type { CartesianPresentation } from "../types.js";

const fields: Field[] = [
  { name: "month", type: "string" },
  { name: "region", type: "string" },
  { name: "revenue", type: "number" },
  { name: "cost", type: "number" },
];

function dataset(rows: Record<string, unknown>[]): Dataset {
  return { fields, rows };
}

function presentation(overrides: Partial<CartesianPresentation> = {}): CartesianPresentation {
  return {
    type: "line",
    x: { field: "month" },
    series: [{ field: "revenue" }],
    ...overrides,
  };
}

describe("resolveSeries — explicit array series", () => {
  it("produces one ResolvedSeries per entry, in spec order", () => {
    const data = dataset([
      { month: "Jan", revenue: 10, cost: 5 },
      { month: "Feb", revenue: 20, cost: 8 },
    ]);
    const result = resolveSeries(
      data,
      presentation({ series: [{ field: "revenue" }, { field: "cost" }] }),
    );
    expect(result.map((s) => s.field)).toEqual(["revenue", "cost"]);
  });

  it("keys each series by its field name and falls back label to field name when absent", () => {
    const data = dataset([{ month: "Jan", revenue: 10 }]);
    const result = resolveSeries(data, presentation({ series: [{ field: "revenue" }] }));
    expect(result[0]?.key).toBe("revenue");
    expect(result[0]?.label).toBe("revenue");
  });

  it("uses the declared label when present", () => {
    const data = dataset([{ month: "Jan", revenue: 10 }]);
    const result = resolveSeries(
      data,
      presentation({ series: [{ field: "revenue", label: "Revenue ($)" }] }),
    );
    expect(result[0]?.label).toBe("Revenue ($)");
  });

  it("shares the dataset's row order for x values across every series", () => {
    const data = dataset([
      { month: "Mar", revenue: 1, cost: 2 },
      { month: "Jan", revenue: 3, cost: 4 },
      { month: "Feb", revenue: 5, cost: 6 },
    ]);
    const result = resolveSeries(
      data,
      presentation({ series: [{ field: "revenue" }, { field: "cost" }] }),
    );
    const xs = (series: (typeof result)[number]) => series.points.map((p) => p.x);
    expect(xs(result[0] as (typeof result)[number])).toEqual(["Mar", "Jan", "Feb"]);
    expect(xs(result[1] as (typeof result)[number])).toEqual(["Mar", "Jan", "Feb"]);
  });

  it("yields one empty-pointed series per entry for an empty dataset", () => {
    const data = dataset([]);
    const result = resolveSeries(
      data,
      presentation({ series: [{ field: "revenue" }, { field: "cost" }] }),
    );
    expect(result).toHaveLength(2);
    expect(result[0]?.points).toEqual([]);
    expect(result[1]?.points).toEqual([]);
  });

  it("yields undefined for missing x or y values rather than dropping the row", () => {
    const data = dataset([{ month: "Jan" }, { revenue: 20 }]);
    const result = resolveSeries(data, presentation({ series: [{ field: "revenue" }] }));
    expect(result[0]?.points).toEqual([
      { x: "Jan", y: undefined, index: 0 },
      { x: undefined, y: 20, index: 1 },
    ]);
  });

  it("carries the source dataset row index on every point, for callers that merge series back onto one shared axis", () => {
    const data = dataset([
      { month: "Mar", revenue: 1 },
      { month: "Jan", revenue: 3 },
      { month: "Feb", revenue: 5 },
    ]);
    const result = resolveSeries(data, presentation({ series: [{ field: "revenue" }] }));
    expect(result[0]?.points.map((p) => p.index)).toEqual([0, 1, 2]);
  });
});

describe("resolveSeries — grouped series", () => {
  it("produces one series per distinct groupBy value, in first-appearance order (not sorted)", () => {
    const data = dataset([
      { month: "Jan", region: "West", revenue: 1 },
      { month: "Jan", region: "East", revenue: 2 },
      { month: "Feb", region: "West", revenue: 3 },
      { month: "Feb", region: "Central", revenue: 4 },
    ]);
    const result = resolveSeries(
      data,
      presentation({ series: { field: "revenue", groupBy: "region" } }),
    );
    // Alphabetical would be Central, East, West — first-appearance is West, East, Central.
    expect(result.map((s) => s.key)).toEqual(["West", "East", "Central"]);
  });

  it("includes only the rows belonging to each group, in dataset order", () => {
    const data = dataset([
      { month: "Jan", region: "West", revenue: 1 },
      { month: "Feb", region: "East", revenue: 2 },
      { month: "Mar", region: "West", revenue: 3 },
    ]);
    const result = resolveSeries(
      data,
      presentation({ series: { field: "revenue", groupBy: "region" } }),
    );
    const west = result.find((s) => s.key === "West");
    expect(west?.points).toEqual([
      { x: "Jan", y: 1, index: 0 },
      { x: "Mar", y: 3, index: 2 },
    ]);
  });

  it("carries the source dataset row index on every point of a grouped series, not the group's own point position", () => {
    const data = dataset([
      { month: "Jan", region: "West", revenue: 1 },
      { month: "Feb", region: "East", revenue: 2 },
      { month: "Mar", region: "West", revenue: 3 },
    ]);
    const result = resolveSeries(
      data,
      presentation({ series: { field: "revenue", groupBy: "region" } }),
    );
    // West's second point is dataset row 2, not point-position 1 — this is
    // the distinction a renderer needs to reorder a merged multi-group axis
    // back into dataset order.
    expect(result.find((s) => s.key === "West")?.points.map((p) => p.index)).toEqual([0, 2]);
    expect(result.find((s) => s.key === "East")?.points.map((p) => p.index)).toEqual([1]);
  });

  it("groups a nullish value into key '' labelled '(none)' instead of dropping the row", () => {
    const data = dataset([
      { month: "Jan", region: "West", revenue: 1 },
      { month: "Feb", region: null, revenue: 2 },
      { month: "Mar", revenue: 3 },
    ]);
    const result = resolveSeries(
      data,
      presentation({ series: { field: "revenue", groupBy: "region" } }),
    );
    const ungrouped = result.find((s) => s.key === "");
    expect(ungrouped).toBeDefined();
    expect(ungrouped?.label).toBe("(none)");
    expect(ungrouped?.points).toEqual([
      { x: "Feb", y: 2, index: 1 },
      { x: "Mar", y: 3, index: 2 },
    ]);
  });

  // Decision: an empty-string group value shares key "" with a nullish group
  // value, so the two merge into one series labelled "(none)" rather than
  // staying separate. See the comment at the `key` assignment in
  // resolve-series.ts for why: no sentinel key is safe from colliding with a
  // real group value, so this is the deliberate, honestly-documented tradeoff.
  it("merges a null group with an empty-string group into one '(none)' series", () => {
    const data = dataset([
      { month: "Jan", region: null, revenue: 1 },
      { month: "Feb", region: "", revenue: 2 },
    ]);
    const result = resolveSeries(
      data,
      presentation({ series: { field: "revenue", groupBy: "region" } }),
    );
    const ungrouped = result.filter((s) => s.key === "");
    expect(ungrouped).toHaveLength(1);
    expect(ungrouped[0]?.label).toBe("(none)");
    expect(ungrouped[0]?.points).toEqual([
      { x: "Jan", y: 1, index: 0 },
      { x: "Feb", y: 2, index: 1 },
    ]);
  });

  // Decision: a `label` on a grouped series spec is used as a PREFIX, joined to
  // the group value with ": " — e.g. label "Revenue" + group "West" => "Revenue: West".
  // A bare group value is often ambiguous on its own (a legend showing "West",
  // "East" doesn't say what's being measured), and a manifest author who bothered
  // to declare a label is signalling they want it visible. Ignoring it would
  // silently discard information the author explicitly provided.
  it("uses a declared label as a prefix on each group's label", () => {
    const data = dataset([
      { month: "Jan", region: "West", revenue: 1 },
      { month: "Feb", region: null, revenue: 2 },
    ]);
    const result = resolveSeries(
      data,
      presentation({ series: { field: "revenue", groupBy: "region", label: "Revenue" } }),
    );
    expect(result.find((s) => s.key === "West")?.label).toBe("Revenue: West");
    expect(result.find((s) => s.key === "")?.label).toBe("Revenue: (none)");
  });

  it("leaves the group value as the label when no label is declared", () => {
    const data = dataset([{ month: "Jan", region: "West", revenue: 1 }]);
    const result = resolveSeries(
      data,
      presentation({ series: { field: "revenue", groupBy: "region" } }),
    );
    expect(result.find((s) => s.key === "West")?.label).toBe("West");
  });

  it("yields an empty array for an empty dataset", () => {
    const data = dataset([]);
    const result = resolveSeries(
      data,
      presentation({ series: { field: "revenue", groupBy: "region" } }),
    );
    expect(result).toEqual([]);
  });

  it("yields undefined for a missing x or y value rather than dropping the row", () => {
    const data = dataset([{ region: "West" }, { month: "Jan", region: "West", revenue: 5 }]);
    const result = resolveSeries(
      data,
      presentation({ series: { field: "revenue", groupBy: "region" } }),
    );
    const west = result.find((s) => s.key === "West");
    expect(west?.points).toEqual([
      { x: undefined, y: undefined, index: 0 },
      { x: "Jan", y: 5, index: 1 },
    ]);
  });
});

describe("resolveSeries — return-value ownership", () => {
  // Decision: the returned series and their `points` arrays are freshly
  // constructed on every call — never the dataset's own arrays or objects —
  // so a caller that mutates what it gets back cannot corrupt the dataset it
  // came from (or a second call's result). This costs an allocation per call,
  // which is fine: this package renders nothing, so callers are renderers that
  // call it once per chart, not a hot loop.
  it("returns new objects: mutating the result does not affect the dataset", () => {
    const data = dataset([{ month: "Jan", revenue: 10 }]);
    const result = resolveSeries(data, presentation({ series: [{ field: "revenue" }] }));

    const points = result[0]?.points as { x: unknown; y: unknown; index: number }[];
    points.push({ x: "mutated", y: 999, index: -1 });
    (points[0] as { x: unknown; y: unknown; index: number }).y = -1;

    expect(data.rows).toEqual([{ month: "Jan", revenue: 10 }]);
  });

  it("returns new objects for grouped series too", () => {
    const data = dataset([{ month: "Jan", region: "West", revenue: 10 }]);
    const result = resolveSeries(
      data,
      presentation({ series: { field: "revenue", groupBy: "region" } }),
    );

    const points = result[0]?.points as { x: unknown; y: unknown; index: number }[];
    points.push({ x: "mutated", y: 999, index: -1 });

    const second = resolveSeries(
      data,
      presentation({ series: { field: "revenue", groupBy: "region" } }),
    );
    expect(second[0]?.points).toEqual([{ x: "Jan", y: 10, index: 0 }]);
  });

  it("splicing the returned array and reassigning a point's x leaves a second call unaffected", () => {
    const data = dataset([
      { month: "Jan", revenue: 10 },
      { month: "Feb", revenue: 20 },
    ]);
    const result = resolveSeries(data, presentation({ series: [{ field: "revenue" }] }));
    const mutableResult = [...result];
    mutableResult.splice(0, 1);
    expect(mutableResult).toHaveLength(0);

    const point = result[0]?.points[0] as { x: unknown; y: unknown } | undefined;
    if (point !== undefined) point.x = "reassigned";

    const second = resolveSeries(data, presentation({ series: [{ field: "revenue" }] }));
    expect(second[0]?.points).toEqual([
      { x: "Jan", y: 10, index: 0 },
      { x: "Feb", y: 20, index: 1 },
    ]);
  });

  // Caveat pinned here per the doc comment on resolveSeries: point VALUES are
  // not cloned. `x`/`y` reference the row's cell directly, so mutating the
  // INTERNALS of an object- or array-valued cell reached through a point does
  // reach the dataset — freshness only covers the containers, not composite
  // cell contents.
  it("aliases object-valued cells: mutating a point's object value reaches the dataset", () => {
    const cell = { nested: 1 };
    const data = dataset([{ month: "Jan", revenue: cell }]);
    const result = resolveSeries(data, presentation({ series: [{ field: "revenue" }] }));

    const point = result[0]?.points[0] as { x: unknown; y: { nested: number } };
    point.y.nested = 999;

    expect(cell.nested).toBe(999);
    expect((data.rows[0] as { revenue: { nested: number } }).revenue.nested).toBe(999);
  });
});
