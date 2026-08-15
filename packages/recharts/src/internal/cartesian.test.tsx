// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Dataset, Field } from "@qspecs/core";
import type { CartesianPresentation } from "@qspecs/charts";
import { AreaChart, BarChart, LineChart, ScatterChart } from "./cartesian.js";

// This package's chart components are ordinary synchronous components — they
// never suspend, never call a `QSpecExecutor`, and never touch React
// context. Unlike packages/react's Suspense-driven tests, nothing here
// needs `act(async () => ...)` around `render()`, a controlled executor, or
// an error boundary of its own: a bare `render()` covers rendering, and a
// bare `expect(() => render(...)).toThrow()` covers the one case that
// throws synchronously during render. `afterEach(cleanup)` is still
// required — see packages/react/src/internal/use-qspec-query.test.tsx for
// why @testing-library/react does not auto-register it for vitest.
afterEach(cleanup);

const fields: Field[] = [
  { name: "month", type: "string" },
  { name: "region", type: "string" },
  { name: "revenue", type: "number" },
  { name: "cost", type: "number" },
];

// A fresh copy of `fields` every call: the mutation test below deep-freezes
// its dataset, and freezing the shared module-level `fields` array would
// leak across every other test in this file that reuses the default.
function dataset(
  rows: Record<string, unknown>[],
  overrideFields: Field[] = fields.map((f) => ({ ...f })),
): Dataset {
  return { fields: overrideFields, rows };
}

function linePresentation(overrides: Partial<CartesianPresentation> = {}): CartesianPresentation {
  return {
    type: "line",
    x: { field: "month" },
    series: [{ field: "revenue" }, { field: "cost" }],
    ...overrides,
  };
}

/** Recursively freezes a value; used to prove a render pass never writes back into its input. */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  for (const key of Object.getOwnPropertyNames(value)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return Object.freeze(value);
}

describe("LineChart", () => {
  it("renders one <Line> per series, one dot per resolved point", () => {
    const data = dataset([
      { month: "Jan", revenue: 10, cost: 5 },
      { month: "Feb", revenue: 20, cost: 8 },
    ]);

    const { container } = render(
      <LineChart dataset={data} presentation={linePresentation()} width={400} height={300} />,
    );

    // One wrapper group per <Line>, matching resolveSeries' two entries —
    // this is the assertion the falsification run (see task report) proves
    // can actually fail, by rendering only the first series.
    expect(container.querySelectorAll(".recharts-line")).toHaveLength(2);
    // Two series x two rows (both series share the same "month" x values,
    // since resolveSeries maps each explicit series over the same dataset
    // rows) = four plotted points.
    expect(container.querySelectorAll(".recharts-line-dot")).toHaveLength(4);
    // The `name` prop (ResolvedSeries.label, falling back to field name)
    // Recharts renders straight onto the mark element as a DOM attribute —
    // confirms which series is which, not just how many there are.
    expect(container.querySelector('[name="revenue"]')).not.toBeNull();
    expect(container.querySelector('[name="cost"]')).not.toBeNull();
  });

  it("uses the presentation's axis labels, not the field names", () => {
    const data = dataset([{ month: "Jan", revenue: 10, cost: 5 }]);
    const presentation = linePresentation({
      x: { field: "month", label: "Calendar Month" },
      y: { label: "Amount ($)" },
    });

    const { container } = render(
      <LineChart dataset={data} presentation={presentation} width={400} height={300} />,
    );

    expect(container.textContent).toContain("Calendar Month");
    expect(container.textContent).toContain("Amount ($)");
    // The field names themselves must not leak in as a fallback label.
    expect(container.textContent).not.toContain("month");
  });

  it("throws a loud, named error when a series field is absent from the dataset, rather than rendering an empty chart", () => {
    const data = dataset([{ month: "Jan", revenue: 10 }]);
    const presentation = linePresentation({ series: [{ field: "profit" }] });

    expect(() =>
      render(<LineChart dataset={data} presentation={presentation} width={400} height={300} />),
    ).toThrow(/profit/);
  });

  it("throws a loud, named error for two points at the same x within one series, instead of silently keeping only the last", () => {
    // Two "Jan" rows for the same series — an unaggregated dataset.
    const data = dataset([
      { month: "Jan", revenue: 10, cost: 5 },
      { month: "Jan", revenue: 30, cost: 9 },
    ]);

    // Not `/revenue/`: this component's OTHER thrown error (missing-field,
    // above) also mentions "revenue" as part of its "known fields: …" list,
    // so `/revenue/` alone would still pass if this duplicate-x throw were
    // ever replaced by that other error. "has two points at x" is unique to
    // this failure mode.
    expect(() =>
      render(
        <LineChart dataset={data} presentation={linePresentation()} width={400} height={300} />,
      ),
    ).toThrow(/has two points at x/);
  });

  it("does not throw for two rows with a missing x in one series, instead of falsely reporting them as a duplicate x", () => {
    // Two rows where "month" is simply absent from the row object —
    // resolveSeries reads that as `x: undefined` for both (see its "yields
    // undefined for missing x" test) — plus one real "Jan" row. Both
    // missing-x points share the SAME pivot identity ("undefined:undefined"),
    // which is indistinguishable, before the fix, from two rows genuinely
    // both labelled "Jan": that collision used to trip the duplicate-x throw
    // above, hard-failing a chart whose only real problem is incomplete
    // data. The fix drops points with no x instead of pivoting them, so
    // rendering succeeds and only the "Jan" point is plotted.
    const data = dataset([{ revenue: 10 }, { revenue: 20 }, { month: "Jan", revenue: 30 }]);

    const { container } = render(
      <LineChart
        dataset={data}
        presentation={linePresentation({ series: [{ field: "revenue" }] })}
        width={400}
        height={300}
      />,
    );

    expect(container.querySelectorAll(".recharts-line-dot")).toHaveLength(1);
    const tickTexts = Array.from(
      container.querySelectorAll(".recharts-xAxis-tick-labels .recharts-cartesian-axis-tick-label"),
      (tick) => tick.textContent,
    );
    expect(tickTexts).toEqual(["Jan"]);
  });

  it("does not throw for two rows with an explicit null x in one series, instead of falsely reporting them as a duplicate x", () => {
    // The `null` counterpart to the absent-key test above. A SINGLE
    // explicit-null-x row alongside a real one would not exercise this at
    // all — `null` and `undefined` hash to different pivot identities, and
    // nothing collides with just one of either — so this needs two rows
    // that are BOTH explicitly `null`, the same way the absent-key test
    // needs two rows that are both missing the key. Before the fix, both
    // would land on pivot identity "object:null" and trip the duplicate-x
    // throw exactly as two literal "Jan" rows would; the fix drops them
    // instead, same as the absent-key case.
    const data = dataset([
      { month: null, revenue: 10 },
      { month: null, revenue: 20 },
      { month: "Jan", revenue: 30 },
    ]);

    const { container } = render(
      <LineChart
        dataset={data}
        presentation={linePresentation({ series: [{ field: "revenue" }] })}
        width={400}
        height={300}
      />,
    );

    expect(container.querySelectorAll(".recharts-line-dot")).toHaveLength(1);
    const tickTexts = Array.from(
      container.querySelectorAll(".recharts-xAxis-tick-labels .recharts-cartesian-axis-tick-label"),
      (tick) => tick.textContent,
    );
    expect(tickTexts).toEqual(["Jan"]);
  });

  it("does not collide on React key when two explicit series plot the same field under different labels", () => {
    const data = dataset([{ month: "Jan", revenue: 10 }]);
    const presentation = linePresentation({
      series: [
        { field: "revenue", label: "Gross" },
        { field: "revenue", label: "Net" },
      ],
    });
    // resolveSeries keys an explicit series by its field name, so both
    // series here share ResolvedSeries.key = "revenue" — a component that
    // used that key alone for React's `key` prop would make React log a
    // "two children with the same key" warning. Asserting console.error is
    // never called (rather than mocking a specific expected fragment) is
    // the point: there should be nothing to mock away.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { container } = render(
        <LineChart dataset={data} presentation={presentation} width={400} height={300} />,
      );
      expect(container.querySelectorAll(".recharts-line")).toHaveLength(2);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("renders an empty chart, not a throw, for a dataset with declared fields but zero rows", () => {
    const data = dataset([]);

    const { container } = render(
      <LineChart dataset={data} presentation={linePresentation()} width={400} height={300} />,
    );

    expect(container.querySelector("svg")).not.toBeNull();
    expect(container.querySelectorAll(".recharts-line-dot")).toHaveLength(0);
  });

  it("does not mutate the dataset it is given", () => {
    const data = deepFreeze(
      dataset([
        { month: "Jan", revenue: 10, cost: 5 },
        { month: "Feb", revenue: 20, cost: 8 },
      ]),
    );

    // A frozen dataset throws (TypeError, strict mode is implicit in ESM)
    // the moment any code tries to write to it, so rendering successfully
    // at all is the proof of no mutation.
    expect(() =>
      render(
        <LineChart dataset={data} presentation={linePresentation()} width={400} height={300} />,
      ),
    ).not.toThrow();
  });

  it("renders one <Line> per resolved group for a grouped-series presentation", () => {
    const data = dataset([
      { month: "Jan", region: "West", revenue: 10, cost: 5 },
      { month: "Jan", region: "East", revenue: 30, cost: 9 },
      { month: "Feb", region: "West", revenue: 15, cost: 6 },
    ]);
    const presentation = linePresentation({
      series: { field: "revenue", groupBy: "region" },
    });

    const { container } = render(
      <LineChart dataset={data} presentation={presentation} width={400} height={300} />,
    );

    // Two distinct regions -> two groups from resolveSeries -> two <Line>s.
    // Rendering this at all (rather than reading dataset.rows directly and
    // trying to treat `series` as an array) is the point of this test: a
    // component that re-derived series from the dataset instead of calling
    // resolveSeries would not know what "West" and "East" even are.
    expect(container.querySelectorAll(".recharts-line")).toHaveLength(2);
    expect(container.querySelector('[name="West"]')).not.toBeNull();
    expect(container.querySelector('[name="East"]')).not.toBeNull();
  });

  it("places each point on the x it actually belongs to — a ragged grouped series shares an axis in dataset order, not series-then-series order", () => {
    // West contributes Jan and Mar (its Feb row doesn't exist); East
    // contributes only Feb. Every non-grouped test elsewhere in this file
    // uses series with IDENTICAL x values, so an index-keyed pivot (rows
    // zipped by point position instead of matched by x value) would pass
    // those with the same dot/rect counts — this dataset is deliberately
    // ragged so the two approaches produce different, checkable output.
    //
    // Walking series in turn (West's points, then East's) would visit
    // Jan, Mar, Feb — the wrong axis order, silently. The x axis must read
    // Jan, Feb, Mar: dataset row order, recovered via each pivoted row's
    // minimum contributing SeriesPoint.index (see buildWideRows).
    const data = dataset([
      { month: "Jan", region: "West", revenue: 10 },
      { month: "Feb", region: "East", revenue: 20 },
      { month: "Mar", region: "West", revenue: 30 },
    ]);
    const presentation = linePresentation({
      series: { field: "revenue", groupBy: "region" },
    });

    const { container } = render(
      <LineChart dataset={data} presentation={presentation} width={400} height={300} />,
    );

    // Array.from, not a `[...NodeList]` spread — this repo's shared
    // tsconfig lib set (`ES2022`, `DOM`) doesn't include `DOM.Iterable`, so
    // `NodeListOf` has no `Symbol.iterator` under strict typechecking here;
    // `Array.from` only needs `length` + indexed access, which it does have.
    const tickTexts = Array.from(
      container.querySelectorAll(".recharts-xAxis-tick-labels .recharts-cartesian-axis-tick-label"),
      (tick) => tick.textContent,
    );
    expect(tickTexts).toEqual(["Jan", "Feb", "Mar"]);

    // Which x each y landed on, not just how many marks rendered: West
    // (declared first, so its dots render first) has a point at 2 of the 3
    // x values (Jan, Mar) — not at Feb, which is East's alone.
    const dotGroups = container.querySelectorAll(".recharts-line-dots");
    expect(dotGroups).toHaveLength(2);
    expect(dotGroups[0]?.querySelectorAll(".recharts-line-dot")).toHaveLength(2);
    expect(dotGroups[1]?.querySelectorAll(".recharts-line-dot")).toHaveLength(1);
  });
});

describe("BarChart", () => {
  it("renders one <Bar> per series with the resolved data", () => {
    const data = dataset([
      { month: "Jan", revenue: 10, cost: 5 },
      { month: "Feb", revenue: 20, cost: 8 },
    ]);

    // Unlike Line/Area/Scatter, Recharts does not spread `name` onto a
    // <Bar>'s rendered rect elements as a DOM attribute (verified directly:
    // a <Bar name="..."> rectangle's markup carries no `name` at all) — so
    // series identity here is checked through the legend text instead,
    // which Recharts does render from each <Bar>'s `name`.
    const { container } = render(
      <BarChart
        dataset={data}
        presentation={linePresentation({ legend: { visible: true } })}
        width={400}
        height={300}
      />,
    );

    expect(container.querySelectorAll(".recharts-bar")).toHaveLength(2);
    expect(container.querySelectorAll(".recharts-bar-rectangle")).toHaveLength(4);
    expect(container.textContent).toContain("revenue");
    expect(container.textContent).toContain("cost");
  });

  it("throws for a field absent from the dataset instead of rendering silently", () => {
    const data = dataset([{ month: "Jan", revenue: 10 }]);
    const presentation = linePresentation({ series: [{ field: "missingField" }] });
    expect(() =>
      render(<BarChart dataset={data} presentation={presentation} width={400} height={300} />),
    ).toThrow(/missingField/);
  });

  it("renders an empty chart for a zero-row dataset", () => {
    const data = dataset([]);

    const { container } = render(
      <BarChart dataset={data} presentation={linePresentation()} width={400} height={300} />,
    );

    expect(container.querySelector("svg")).not.toBeNull();
    expect(container.querySelectorAll(".recharts-bar-rectangle")).toHaveLength(0);
  });
});

describe("AreaChart", () => {
  it("renders one <Area> per series with the resolved data", () => {
    const data = dataset([
      { month: "Jan", revenue: 10, cost: 5 },
      { month: "Feb", revenue: 20, cost: 8 },
    ]);

    const { container } = render(
      <AreaChart dataset={data} presentation={linePresentation()} width={400} height={300} />,
    );

    expect(container.querySelectorAll(".recharts-area")).toHaveLength(2);
    expect(container.querySelector('[name="revenue"]')).not.toBeNull();
    expect(container.querySelector('[name="cost"]')).not.toBeNull();
  });

  it("throws for a field absent from the dataset instead of rendering silently", () => {
    const data = dataset([{ month: "Jan", revenue: 10 }]);
    const presentation = linePresentation({ series: [{ field: "missingField" }] });
    expect(() =>
      render(<AreaChart dataset={data} presentation={presentation} width={400} height={300} />),
    ).toThrow(/missingField/);
  });

  it("renders an empty chart for a zero-row dataset", () => {
    const data = dataset([]);

    const { container } = render(
      <AreaChart dataset={data} presentation={linePresentation()} width={400} height={300} />,
    );

    expect(container.querySelector("svg")).not.toBeNull();
    // Symmetric with Line/Bar/Scatter's zero-row tests: an empty dataset
    // renders an empty chart, not just "some svg" — zero marks, of any kind.
    expect(container.querySelectorAll(".recharts-area-curve")).toHaveLength(0);
  });
});

describe("ScatterChart", () => {
  function scatterPresentation(
    overrides: Partial<CartesianPresentation> = {},
  ): CartesianPresentation {
    return {
      type: "scatter",
      x: { field: "revenue" },
      series: [{ field: "cost" }],
      ...overrides,
    };
  }

  it("renders one <Scatter> per series with the resolved data", () => {
    const data = dataset([
      { month: "Jan", revenue: 10, cost: 5 },
      { month: "Feb", revenue: 20, cost: 8 },
    ]);
    const presentation = scatterPresentation({
      series: [{ field: "cost" }, { field: "revenue" }],
    });

    const { container } = render(
      <ScatterChart dataset={data} presentation={presentation} width={400} height={300} />,
    );

    expect(container.querySelectorAll(".recharts-scatter")).toHaveLength(2);
    // Two series x two rows each = four plotted points.
    expect(container.querySelectorAll(".recharts-scatter-symbol")).toHaveLength(4);
  });

  it("throws for a field absent from the dataset instead of rendering silently", () => {
    const data = dataset([{ month: "Jan", revenue: 10, cost: 5 }]);
    const presentation = scatterPresentation({ series: [{ field: "missingField" }] });
    expect(() =>
      render(<ScatterChart dataset={data} presentation={presentation} width={400} height={300} />),
    ).toThrow(/missingField/);
  });

  it("renders an empty chart for a zero-row dataset", () => {
    const data = dataset([]);

    const { container } = render(
      <ScatterChart dataset={data} presentation={scatterPresentation()} width={400} height={300} />,
    );

    expect(container.querySelector("svg")).not.toBeNull();
    expect(container.querySelectorAll(".recharts-scatter-symbol")).toHaveLength(0);
  });

  it("plots points for a categorical (non-numeric) x field instead of rendering an empty plot", () => {
    // A hardcoded `type="number"` x axis would pass assertFieldsPresent
    // (the field exists) and then render nothing: Recharts' numeric scale
    // can't place a string like "Jan" anywhere. The axis type must be
    // derived from the dataset's declared field type instead.
    const data = dataset([
      { month: "Jan", revenue: 10, cost: 5 },
      { month: "Feb", revenue: 20, cost: 8 },
    ]);
    const presentation = scatterPresentation({
      x: { field: "month" },
      series: [{ field: "revenue" }],
    });

    const { container } = render(
      <ScatterChart dataset={data} presentation={presentation} width={400} height={300} />,
    );

    expect(container.querySelectorAll(".recharts-scatter-symbol")).toHaveLength(2);
  });

  it("plots points for a categorical (non-numeric) y field instead of rendering an empty plot", () => {
    // Mirrors the x-side test above, on the y axis instead: a hardcoded
    // `type="number"` y axis would pass assertFieldsPresent (the field
    // exists) and then render nothing, since Recharts' numeric scale can't
    // place a string like "Jan" anywhere. The axis type must be derived
    // from the dataset's declared field type on the y side too, not only
    // the x side.
    const data = dataset([
      { month: "Jan", revenue: 10, cost: 5 },
      { month: "Feb", revenue: 20, cost: 8 },
    ]);
    const presentation = scatterPresentation({
      x: { field: "revenue" },
      series: [{ field: "month" }],
    });

    const { container } = render(
      <ScatterChart dataset={data} presentation={presentation} width={400} height={300} />,
    );

    expect(container.querySelectorAll(".recharts-scatter-symbol")).toHaveLength(2);
  });
});
