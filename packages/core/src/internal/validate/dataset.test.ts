import { describe, expect, it } from "vitest";
import { formatPath } from "../../errors.js";
import { createRow, setKey } from "../../json.js";
import type { Dataset, DatasetSchema, Field } from "../../types/dataset.js";
import { validateDataset } from "./dataset.js";

function dataset(fields: Field[], rows: Record<string, unknown>[]): Dataset {
  return {
    fields,
    rows: rows.map((source) => {
      const row = createRow();
      for (const [key, value] of Object.entries(source)) setKey(row, key, value);
      return row;
    }),
  };
}

const schema: DatasetSchema = {
  fields: {
    month: { type: "datetime", nullable: false },
    revenue: { type: "number", nullable: false },
  },
};

describe("validateDataset", () => {
  it("accepts a dataset matching its schema", () => {
    const data = dataset(
      [
        { name: "month", type: "datetime" },
        { name: "revenue", type: "number" },
      ],
      [{ month: "2026-01-01T00:00:00Z", revenue: 10 }],
    );
    expect(validateDataset(data, schema)).toEqual([]);
  });

  it("accepts everything when no schema is declared", () => {
    expect(validateDataset(dataset([], []), undefined)).toEqual([]);
  });

  it("allows extra undeclared fields", () => {
    const data = dataset(
      [
        { name: "month", type: "datetime" },
        { name: "revenue", type: "number" },
        { name: "extra", type: "string" },
      ],
      [{ month: "2026-01-01T00:00:00Z", revenue: 10, extra: "x" }],
    );
    expect(validateDataset(data, schema)).toEqual([]);
  });

  it("reports a missing declared field and suggests a close actual field", () => {
    const data = dataset(
      [
        { name: "month", type: "datetime" },
        { name: "reveneu", type: "number" },
      ],
      [],
    );
    const issues = validateDataset(data, schema);
    expect(issues).toHaveLength(1);
    expect(formatPath(issues[0]?.path ?? [])).toBe("spec.dataset.fields.revenue");
    expect(issues[0]?.suggestion).toBe("reveneu");
  });

  it("reports a declared type mismatch", () => {
    const data = dataset(
      [
        { name: "month", type: "datetime" },
        { name: "revenue", type: "string" },
      ],
      [],
    );
    const issues = validateDataset(data, schema);
    expect(issues[0]?.message).toMatch(/number.*string/);
  });

  it("accepts an integer value where a number is declared", () => {
    const data = dataset(
      [
        { name: "month", type: "datetime" },
        { name: "revenue", type: "integer" },
      ],
      [{ month: "2026-01-01T00:00:00Z", revenue: 10 }],
    );
    expect(validateDataset(data, schema)).toEqual([]);
  });

  it("rejects a null in a non-nullable field and names the row index", () => {
    const data = dataset(
      [
        { name: "month", type: "datetime" },
        { name: "revenue", type: "number" },
      ],
      [
        { month: "2026-01-01T00:00:00Z", revenue: 10 },
        { month: null, revenue: 1 },
      ],
    );
    const issues = validateDataset(data, schema);
    expect(issues).toHaveLength(1);
    expect(formatPath(issues[0]?.path ?? [])).toBe("rows[1].month");
  });

  it("allows nulls when the field is declared nullable", () => {
    const nullable: DatasetSchema = { fields: { a: { type: "string", nullable: true } } };
    const data = dataset([{ name: "a", type: "string" }], [{ a: null }]);
    expect(validateDataset(data, nullable)).toEqual([]);
  });

  it("caps the number of reported row issues", () => {
    const rows = Array.from({ length: 100 }, () => ({ month: null, revenue: 1 }));
    const data = dataset(
      [
        { name: "month", type: "datetime" },
        { name: "revenue", type: "number" },
      ],
      rows,
    );
    expect(validateDataset(data, schema, { maxIssues: 5 })).toHaveLength(5);
  });
});
