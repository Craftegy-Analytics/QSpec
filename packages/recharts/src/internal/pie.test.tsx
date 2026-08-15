// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Dataset, Field } from "@qspecs/core";
import type { PiePresentation } from "@qspecs/charts";
import { PieChart } from "./pie.js";

// See cartesian.test.tsx for why no act(async () => ...) / controlled
// executor / error boundary is needed here: this package's chart components
// are ordinary synchronous components that never suspend.
afterEach(cleanup);

const fields: Field[] = [
  { name: "region", type: "string" },
  { name: "revenue", type: "number" },
];

// A fresh copy of `fields` every call — see cartesian.test.tsx's identical
// helper for why (the mutation test below deep-freezes its dataset).
function dataset(
  rows: Record<string, unknown>[],
  overrideFields: Field[] = fields.map((f) => ({ ...f })),
): Dataset {
  return { fields: overrideFields, rows };
}

function presentation(overrides: Partial<PiePresentation> = {}): PiePresentation {
  return {
    type: "pie",
    category: { field: "region" },
    value: { field: "revenue" },
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

describe("PieChart", () => {
  it("renders one sector per category", () => {
    const data = dataset([
      { region: "West", revenue: 10 },
      { region: "East", revenue: 20 },
      { region: "North", revenue: 30 },
    ]);

    const { container } = render(
      <PieChart dataset={data} presentation={presentation()} width={300} height={300} />,
    );

    // <Cell> itself renders nothing to the DOM (Recharts reads it back off
    // <Pie>'s children purely to know how many/which slices to draw), so
    // "one <Cell> per category" is observed through its effect: one
    // rendered sector per row. Three distinct categories -> three sectors.
    expect(container.querySelectorAll(".recharts-sector")).toHaveLength(3);
  });

  it("uses the value field to size slices, not just to count categories", () => {
    // Two renders, same two categories, values swapped. If `value.field`
    // genuinely drives each slice's angle, the FIRST sector's path geometry
    // must differ between the two renders (it spans a different arc when
    // it's the 10-of-100 slice vs. the 90-of-100 slice). If the component
    // instead ignored the value field — e.g. dividing the pie evenly by
    // category count — both renders would produce an identical 50/50 split
    // regardless of which row carries which number, and the two `d`
    // attributes below would be equal.
    const smallFirst = dataset([
      { region: "West", revenue: 10 },
      { region: "East", revenue: 90 },
    ]);
    const { container: c1 } = render(
      <PieChart dataset={smallFirst} presentation={presentation()} width={300} height={300} />,
    );
    // Asserted before reading `d`: `querySelector(...)?.getAttribute("d")`
    // yields `undefined`, not `null`, when the selector matches nothing —
    // `expect(d1).not.toBeNull()` would pass vacuously in exactly the
    // half-broken-render case it exists to catch. Asserting the sector count
    // is exactly 2 here also guards the case where only one of the two
    // renders produces a sector at all, which `d1 !== d2` alone would not
    // catch (a real path can differ trivially from `undefined`).
    expect(c1.querySelectorAll(".recharts-sector")).toHaveLength(2);
    const d1 = c1.querySelector(".recharts-sector")?.getAttribute("d");
    cleanup();

    const largeFirst = dataset([
      { region: "West", revenue: 90 },
      { region: "East", revenue: 10 },
    ]);
    const { container: c2 } = render(
      <PieChart dataset={largeFirst} presentation={presentation()} width={300} height={300} />,
    );
    expect(c2.querySelectorAll(".recharts-sector")).toHaveLength(2);
    const d2 = c2.querySelector(".recharts-sector")?.getAttribute("d");

    expect(typeof d1).toBe("string");
    expect(typeof d2).toBe("string");
    expect(d1).not.toEqual(d2);
  });

  it("throws a loud, named error when the category field is absent from the dataset, rather than rendering an empty chart", () => {
    const data = dataset([{ region: "West", revenue: 10 }]);
    const badPresentation = presentation({ category: { field: "segment" } });

    expect(() =>
      render(<PieChart dataset={data} presentation={badPresentation} width={300} height={300} />),
    ).toThrow(/segment/);
  });

  it("throws a loud, named error when the value field is absent from the dataset, rather than rendering an empty chart", () => {
    const data = dataset([{ region: "West", revenue: 10 }]);
    const badPresentation = presentation({ value: { field: "profit" } });

    expect(() =>
      render(<PieChart dataset={data} presentation={badPresentation} width={300} height={300} />),
    ).toThrow(/profit/);
  });

  it("renders an empty chart, not a throw, for a dataset with declared fields but zero rows", () => {
    const data = dataset([]);

    const { container } = render(
      <PieChart dataset={data} presentation={presentation()} width={300} height={300} />,
    );

    expect(container.querySelector("svg")).not.toBeNull();
    expect(container.querySelectorAll(".recharts-sector")).toHaveLength(0);
  });

  it("does not mutate the dataset it is given", () => {
    const data = deepFreeze(
      dataset([
        { region: "West", revenue: 10 },
        { region: "East", revenue: 20 },
      ]),
    );

    expect(() =>
      render(<PieChart dataset={data} presentation={presentation()} width={300} height={300} />),
    ).not.toThrow();
  });
});
