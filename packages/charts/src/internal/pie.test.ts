import { describe, expect, it } from "vitest";
import type { PresentationValidationContext } from "@qspecs/core";
import { piePresentationType } from "./pie.js";
import type { PiePresentation } from "../types.js";

const context: PresentationValidationContext = { fields: undefined };

function wellFormed(overrides: Partial<PiePresentation> = {}): PiePresentation {
  return {
    type: "pie",
    category: { field: "region" },
    value: { field: "revenue" },
    ...overrides,
  };
}

describe("piePresentationType.validate", () => {
  it("accepts a well-formed definition", () => {
    expect(piePresentationType.validate?.(wellFormed(), context)).toEqual([]);
  });

  it("rejects a definition missing category", () => {
    const definition = { type: "pie", value: { field: "revenue" } } as never;
    const issues = piePresentationType.validate?.(definition, context) ?? [];
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toEqual(["category"]);
  });

  it("rejects category.field when it is not a non-empty string", () => {
    const definition = wellFormed({ category: { field: "" } });
    const issues = piePresentationType.validate?.(definition, context) ?? [];
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toEqual(["category", "field"]);
  });

  it("rejects category.field when it is not a string at all", () => {
    const definition = wellFormed({ category: { field: 42 } as never });
    const issues = piePresentationType.validate?.(definition, context) ?? [];
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toEqual(["category", "field"]);
  });

  it("rejects a definition missing value", () => {
    const definition = { type: "pie", category: { field: "region" } } as never;
    const issues = piePresentationType.validate?.(definition, context) ?? [];
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toEqual(["value"]);
  });

  it("rejects value.field when it is not a non-empty string", () => {
    const definition = wellFormed({ value: { field: "" } });
    const issues = piePresentationType.validate?.(definition, context) ?? [];
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toEqual(["value", "field"]);
  });

  it("rejects a non-string label on category or value", () => {
    const definition = wellFormed({
      category: { field: "region", label: 1 as never },
      value: { field: "revenue", label: null as never },
    });
    const issues = piePresentationType.validate?.(definition, context) ?? [];
    expect(issues.map((i) => i.path)).toEqual([
      ["category", "label"],
      ["value", "label"],
    ]);
  });

  it("rejects a non-object legend and a non-object tooltip", () => {
    const definition = wellFormed({ legend: 42 as never, tooltip: "on" as never });
    const issues = piePresentationType.validate?.(definition, context) ?? [];
    expect(issues.map((i) => i.path)).toEqual([["legend"], ["tooltip"]]);
  });

  it("rejects a non-boolean legend.visible and tooltip.visible", () => {
    const definition = wellFormed({
      legend: { visible: "yes" as never },
      tooltip: { visible: 1 as never },
    });
    const issues = piePresentationType.validate?.(definition, context) ?? [];
    expect(issues.map((i) => i.path)).toEqual([
      ["legend", "visible"],
      ["tooltip", "visible"],
    ]);
  });

  it("accepts well-formed optional display blocks", () => {
    const definition = wellFormed({
      category: { field: "region", label: "Region" },
      value: { field: "revenue", label: "Revenue" },
      legend: { visible: true },
      tooltip: {},
    });
    expect(piePresentationType.validate?.(definition, context)).toEqual([]);
  });

  it("reports both problems at once when category and value are both missing", () => {
    const definition = { type: "pie" } as never;
    const issues = piePresentationType.validate?.(definition, context) ?? [];
    expect(issues).toHaveLength(2);
    expect(issues.map((i) => i.path)).toEqual([["category"], ["value"]]);
  });

  it("returns issues rather than throwing on malformed input", () => {
    const definition = { type: "pie", category: null, value: 42 } as never;
    expect(() => piePresentationType.validate?.(definition, context)).not.toThrow();
  });
});

describe("piePresentationType.fieldReferences", () => {
  it("reports the category field", () => {
    const definition = wellFormed();
    const refs = piePresentationType.fieldReferences?.(definition) ?? [];
    expect(refs).toContainEqual({ field: "region", path: ["category", "field"] });
  });

  it("reports the value field", () => {
    const definition = wellFormed();
    const refs = piePresentationType.fieldReferences?.(definition) ?? [];
    expect(refs).toContainEqual({ field: "revenue", path: ["value", "field"] });
  });

  it("reports exactly category then value, in order", () => {
    const definition = wellFormed();
    const refs = piePresentationType.fieldReferences?.(definition) ?? [];
    expect(refs).toEqual([
      { field: "region", path: ["category", "field"] },
      { field: "revenue", path: ["value", "field"] },
    ]);
  });

  it("does not throw and reports nothing on a definition validate would reject", () => {
    const definition = { type: "pie" } as never;
    expect(() => piePresentationType.fieldReferences?.(definition)).not.toThrow();
    expect(piePresentationType.fieldReferences?.(definition)).toEqual([]);
  });

  it("does not throw on a completely malformed definition", () => {
    const definition = { type: "pie", category: null, value: 42 } as never;
    expect(() => piePresentationType.fieldReferences?.(definition)).not.toThrow();
    expect(piePresentationType.fieldReferences?.(definition)).toEqual([]);
  });
});
