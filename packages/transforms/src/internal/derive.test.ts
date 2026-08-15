import { describe, expect, it } from "vitest";
import { FIELD_TYPES, type Dataset, type Field } from "@qspecs/core";
import { createDeriveTransform } from "./derive.js";
import { emptyRow, setCell } from "./rows.js";

const fields: Field[] = [
  { name: "month", type: "datetime" },
  { name: "revenue", type: "number" },
];

function dataset(rows: Record<string, unknown>[]): Dataset {
  return {
    fields,
    rows: rows.map((source) => {
      const row = emptyRow();
      for (const [key, value] of Object.entries(source)) setCell(row, key, value);
      return row;
    }),
  };
}

const context = { executionId: "test", parameters: {} as Record<string, never> };
const derive = createDeriveTransform(32);

const data = dataset([
  { month: "2026-01", revenue: 10 },
  { month: "2026-02", revenue: 25 },
]);

const doubled = {
  field: "doubled",
  fieldType: "number" as const,
  expression: { operator: "multiply", arguments: [{ field: "revenue" }, { literal: 2 }] },
};

describe("derive.execute", () => {
  it("appends a computed field with the declared fieldType", async () => {
    const out = await derive.execute(data, doubled, context);
    expect(out.rows.map((r) => r["doubled"])).toEqual([20, 50]);
  });

  it("puts the new field last in every row and leaves existing fields untouched", async () => {
    const out = await derive.execute(data, doubled, context);
    for (const row of out.rows) {
      expect(Object.keys(row)).toEqual(["month", "revenue", "doubled"]);
    }
    expect(out.rows.map((r) => r["revenue"])).toEqual([10, 25]);
  });

  it("yields null when arithmetic is applied to a missing operand", async () => {
    const withGap = dataset([{ month: "2026-01" }]);
    const out = await derive.execute(withGap, doubled, context);
    expect(out.rows[0]?.["doubled"]).toBeNull();
  });

  it("does not mutate the input dataset", async () => {
    const before = data.rows.map((row) => ({ ...row }));
    await derive.execute(data, doubled, context);
    expect(data.rows.map((row) => ({ ...row }))).toEqual(before);
  });

  it("keeps rows null-prototype", async () => {
    const out = await derive.execute(data, doubled, context);
    expect(Object.getPrototypeOf(out.rows[0])).toBeNull();
  });

  it("resolves parameters inside the expression", async () => {
    const withParam = {
      field: "adjusted",
      fieldType: "number" as const,
      expression: { operator: "add", arguments: [{ field: "revenue" }, { parameter: "bonus" }] },
    };
    const out = await derive.execute(data, withParam, { ...context, parameters: { bonus: 5 } });
    expect(out.rows.map((r) => r["adjusted"])).toEqual([15, 30]);
  });

  it("adds the derived field to Dataset.fields, not just to the rows", async () => {
    // Regression: execute() previously returned `{ ...dataset, rows }`, so the
    // derived column existed in every row but never in `fields` — while
    // describe() projected it correctly. The two disagreed, which is exactly
    // what silently breaks static presentation validation downstream.
    const out = await derive.execute(data, doubled, context);
    expect(out.fields.map((field) => field.name)).toContain("doubled");
    expect(out.fields).toEqual(derive.describe?.(fields, doubled));
  });
});

describe("derive.describe", () => {
  it("appends the derived field last, with the declared type and nullable: true", () => {
    const out = derive.describe?.(fields, doubled) ?? [];
    expect(out).toEqual([...fields, { name: "doubled", type: "number", nullable: true }]);
  });

  it("leaves the incoming fields untouched", () => {
    const out = derive.describe?.(fields, doubled) ?? [];
    expect(out.slice(0, 2)).toEqual(fields);
  });
});

describe("derive.validate", () => {
  it("accepts a well-formed spec", () => {
    expect(derive.validate?.(doubled, fields)).toEqual([]);
  });

  it("rejects a missing field name", () => {
    const spec = { fieldType: "number", expression: { literal: 1 } } as never;
    const issues = derive.validate?.(spec, fields) ?? [];
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]?.path).toEqual(["field"]);
  });

  it("rejects a missing fieldType", () => {
    const spec = { field: "doubled", expression: { literal: 1 } } as never;
    const issues = derive.validate?.(spec, fields) ?? [];
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]?.path).toEqual(["fieldType"]);
  });

  it("rejects a missing expression", () => {
    const spec = { field: "doubled", fieldType: "number" } as never;
    const issues = derive.validate?.(spec, fields) ?? [];
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]?.path).toEqual(["expression"]);
  });

  it("rejects an expression referencing a field that will not exist", () => {
    const spec = {
      field: "doubled",
      fieldType: "number" as const,
      expression: { operator: "multiply", arguments: [{ field: "profit" }, { literal: 2 }] },
    };
    const issues = derive.validate?.(spec, fields) ?? [];
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((issue) => issue.message.includes("profit"))).toBe(true);
  });

  it("rejects overwriting an existing field name", () => {
    const spec = {
      field: "revenue",
      fieldType: "number" as const,
      expression: { literal: 1 },
    };
    const issues = derive.validate?.(spec, fields) ?? [];
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((issue) => /revenue/.test(issue.message))).toBe(true);
  });

  it("rejects a fieldType that is not a known FieldType", () => {
    const spec = { field: "doubled", fieldType: "uuid", expression: { literal: 1 } } as never;
    const issues = derive.validate?.(spec, fields) ?? [];
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toEqual(["fieldType"]);
  });

  it("suggests the nearest valid type for a near-miss fieldType", () => {
    const spec = { field: "doubled", fieldType: "integar", expression: { literal: 1 } } as never;
    const issues = derive.validate?.(spec, fields) ?? [];
    expect(issues[0]?.suggestion).toBe("integer");
  });

  it.each(FIELD_TYPES)("accepts fieldType %s", (fieldType) => {
    const spec = { field: "computed", fieldType, expression: { literal: null } };
    expect(derive.validate?.(spec, fields)).toEqual([]);
  });

  it("enforces the expression depth limit it was constructed with", () => {
    const shallow = createDeriveTransform(2);
    let nested: unknown = { field: "revenue" };
    for (let i = 0; i < 5; i += 1) nested = { operator: "not", arguments: [nested] };
    const issues =
      shallow.validate?.({ field: "flag", fieldType: "boolean", expression: nested }, fields) ?? [];
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toMatch(/depth/i);
  });
});
