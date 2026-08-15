import { describe, expect, it } from "vitest";
import type { PresentationValidationContext } from "@qspecs/core";
import { cartesianPresentationType } from "./cartesian.js";
import type { CartesianPresentation } from "../types.js";

const context: PresentationValidationContext = { fields: undefined };

function wellFormed(overrides: Partial<CartesianPresentation> = {}): CartesianPresentation {
  return {
    type: "line",
    x: { field: "month" },
    series: [{ field: "revenue" }],
    ...overrides,
  };
}

describe("cartesianPresentationType.validate", () => {
  it("accepts a well-formed definition", () => {
    expect(cartesianPresentationType.validate?.(wellFormed(), context)).toEqual([]);
  });

  it("rejects a definition missing x", () => {
    const definition = { type: "line", series: [{ field: "revenue" }] } as never;
    const issues = cartesianPresentationType.validate?.(definition, context) ?? [];
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toEqual(["x"]);
  });

  it("rejects x.field when it is not a string", () => {
    const definition = wellFormed({ x: { field: 42 } as never });
    const issues = cartesianPresentationType.validate?.(definition, context) ?? [];
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toEqual(["x", "field"]);
  });

  it("rejects series that is neither an array nor a grouped object", () => {
    const definition = wellFormed({ series: "revenue" as never });
    const issues = cartesianPresentationType.validate?.(definition, context) ?? [];
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toEqual(["series"]);
  });

  it("rejects an empty series array", () => {
    const definition = wellFormed({ series: [] });
    const issues = cartesianPresentationType.validate?.(definition, context) ?? [];
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toEqual(["series"]);
  });

  it("rejects a series entry missing field", () => {
    const definition = wellFormed({ series: [{} as never] });
    const issues = cartesianPresentationType.validate?.(definition, context) ?? [];
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toEqual(["series", 0, "field"]);
  });

  it("rejects a grouped series missing groupBy", () => {
    const definition = wellFormed({ series: { field: "revenue" } as never });
    const issues = cartesianPresentationType.validate?.(definition, context) ?? [];
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toEqual(["series", "groupBy"]);
  });

  it("accepts a well-formed grouped series", () => {
    const definition = wellFormed({ series: { field: "revenue", groupBy: "region" } });
    expect(cartesianPresentationType.validate?.(definition, context)).toEqual([]);
  });

  it("rejects x.field when it is an empty string", () => {
    // Previously accepted here while `pie` rejected the same shape: the two
    // files carried separate guard copies and only pie's had isNonEmptyString.
    const definition = wellFormed({ x: { field: "" } });
    const issues = cartesianPresentationType.validate?.(definition, context) ?? [];
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toEqual(["x", "field"]);
  });

  it("rejects an empty-string series field", () => {
    const definition = wellFormed({ series: [{ field: "" }] });
    const issues = cartesianPresentationType.validate?.(definition, context) ?? [];
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toEqual(["series", 0, "field"]);
  });

  it("rejects an empty-string grouped series groupBy", () => {
    const definition = wellFormed({ series: { field: "revenue", groupBy: "" } });
    const issues = cartesianPresentationType.validate?.(definition, context) ?? [];
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toEqual(["series", "groupBy"]);
  });

  it("rejects two series plotting the same field", () => {
    // ResolvedSeries.key is the field name, so duplicates collapse into one
    // identity — and a React renderer keyed on it corrupts silently.
    const definition = wellFormed({
      series: [{ field: "revenue" }, { field: "revenue", label: "again" }],
    });
    const issues = cartesianPresentationType.validate?.(definition, context) ?? [];
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toEqual(["series", 1, "field"]);
    expect(issues[0]?.message).toMatch(/more than once/);
  });

  it("accepts two series plotting different fields", () => {
    const definition = wellFormed({ series: [{ field: "revenue" }, { field: "cost" }] });
    expect(cartesianPresentationType.validate?.(definition, context)).toEqual([]);
  });

  it("rejects a non-string label anywhere it is declared", () => {
    const definition = wellFormed({
      x: { field: "month", label: 1 as never },
      series: [{ field: "revenue", label: {} as never }],
      y: { label: false as never },
    });
    const issues = cartesianPresentationType.validate?.(definition, context) ?? [];
    expect(issues.map((i) => i.path)).toEqual([
      ["x", "label"],
      ["series", 0, "label"],
      ["y", "label"],
    ]);
  });

  it("rejects a non-string label on a grouped series", () => {
    const definition = wellFormed({
      series: { field: "revenue", groupBy: "region", label: 7 as never },
    });
    const issues = cartesianPresentationType.validate?.(definition, context) ?? [];
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toEqual(["series", "label"]);
  });

  it("rejects a non-object y", () => {
    const definition = wellFormed({ y: "revenue" as never });
    const issues = cartesianPresentationType.validate?.(definition, context) ?? [];
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toEqual(["y"]);
  });

  it("rejects a non-object legend and a non-object tooltip", () => {
    const definition = wellFormed({ legend: 42 as never, tooltip: [] as never });
    const issues = cartesianPresentationType.validate?.(definition, context) ?? [];
    expect(issues.map((i) => i.path)).toEqual([["legend"], ["tooltip"]]);
  });

  it("rejects a non-boolean legend.visible and tooltip.visible", () => {
    const definition = wellFormed({
      legend: { visible: "yes" as never },
      tooltip: { visible: 0 as never },
    });
    const issues = cartesianPresentationType.validate?.(definition, context) ?? [];
    expect(issues.map((i) => i.path)).toEqual([
      ["legend", "visible"],
      ["tooltip", "visible"],
    ]);
  });

  it("accepts well-formed optional display blocks", () => {
    const definition = wellFormed({
      x: { field: "month", label: "Month" },
      series: [{ field: "revenue", label: "Revenue" }],
      y: { label: "USD" },
      legend: { visible: false },
      tooltip: {},
    });
    expect(cartesianPresentationType.validate?.(definition, context)).toEqual([]);
  });

  it("reports several problems from one call, not just the first", () => {
    const definition = wellFormed({ x: { field: 42 } as never, series: [{} as never] });
    const issues = cartesianPresentationType.validate?.(definition, context) ?? [];
    expect(issues).toHaveLength(2);
    expect(issues.map((i) => i.path)).toEqual([
      ["x", "field"],
      ["series", 0, "field"],
    ]);
  });

  it("returns issues rather than throwing", () => {
    const definition = { type: "line" } as never;
    expect(() => cartesianPresentationType.validate?.(definition, context)).not.toThrow();
  });
});

describe("cartesianPresentationType.fieldReferences", () => {
  it("reports the x field", () => {
    const definition = wellFormed();
    const refs = cartesianPresentationType.fieldReferences?.(definition) ?? [];
    expect(refs).toContainEqual({ field: "month", path: ["x", "field"] });
  });

  it("reports each array series entry at its index", () => {
    const definition = wellFormed({
      series: [{ field: "revenue" }, { field: "cost" }],
    });
    const refs = cartesianPresentationType.fieldReferences?.(definition) ?? [];
    expect(refs).toContainEqual({ field: "revenue", path: ["series", 0, "field"] });
    expect(refs).toContainEqual({ field: "cost", path: ["series", 1, "field"] });
  });

  it("reports both the field and the groupBy column of a grouped series", () => {
    const definition = wellFormed({
      series: { field: "revenue", groupBy: "region" },
    });
    const refs = cartesianPresentationType.fieldReferences?.(definition) ?? [];
    expect(refs).toContainEqual({ field: "revenue", path: ["series", "field"] });
    expect(refs).toContainEqual({ field: "region", path: ["series", "groupBy"] });
  });

  it("does not report an empty-string field as a reference", () => {
    // An empty name matches no column, so reporting it would turn a shape
    // defect validate already flagged into a second, misleading unknown-field
    // error from core.
    const definition = wellFormed({ x: { field: "" }, series: [{ field: "" }] });
    expect(cartesianPresentationType.fieldReferences?.(definition)).toEqual([]);
  });

  it("reports exactly x plus one entry per array series, in order", () => {
    const definition = wellFormed({
      series: [{ field: "revenue" }, { field: "cost" }],
    });
    const refs = cartesianPresentationType.fieldReferences?.(definition) ?? [];
    expect(refs).toEqual([
      { field: "month", path: ["x", "field"] },
      { field: "revenue", path: ["series", 0, "field"] },
      { field: "cost", path: ["series", 1, "field"] },
    ]);
  });
});
