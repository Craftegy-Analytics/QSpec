import { describe, expect, it } from "vitest";
import type { Dataset, Field } from "@qspecs/core";
import { selectTransform } from "./select.js";
import { emptyRow, setCell } from "./rows.js";

const fields: Field[] = [
  { name: "month", type: "datetime" },
  { name: "revenue", type: "number" },
  { name: "region", type: "string" },
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

const data = dataset([
  { month: "2026-01", revenue: 10, region: "west" },
  { month: "2026-02", revenue: 20, region: "east" },
]);

describe("select.execute", () => {
  it("keeps only the named fields", async () => {
    const out = await selectTransform.execute(data, { fields: ["revenue", "region"] }, context);
    expect(out.fields.map((f) => f.name)).toEqual(["revenue", "region"]);
  });

  it("preserves the order given in the spec, not the dataset's order", async () => {
    // Dataset order is month, revenue, region — the spec reverses it.
    const out = await selectTransform.execute(
      data,
      { fields: ["region", "revenue", "month"] },
      context,
    );
    expect(out.fields.map((f) => f.name)).toEqual(["region", "revenue", "month"]);
    expect(out.rows.map((r) => [r["region"], r["revenue"], r["month"]])).toEqual([
      ["west", 10, "2026-01"],
      ["east", 20, "2026-02"],
    ]);
  });

  it("drops unlisted fields from both `fields` and every row", async () => {
    const out = await selectTransform.execute(data, { fields: ["revenue"] }, context);
    expect(out.fields.map((f) => f.name)).toEqual(["revenue"]);
    for (const row of out.rows) {
      expect(Object.keys(row)).toEqual(["revenue"]);
    }
  });

  it("does not mutate the input dataset", async () => {
    const beforeFields = data.fields.map((f) => f.name);
    const beforeRows = data.rows.map((r) => ({ ...r }));
    await selectTransform.execute(data, { fields: ["revenue"] }, context);
    expect(data.fields.map((f) => f.name)).toEqual(beforeFields);
    expect(data.rows.map((r) => ({ ...r }))).toEqual(beforeRows);
  });

  it("keeps rows null-prototype", async () => {
    const out = await selectTransform.execute(data, { fields: ["revenue"] }, context);
    expect(Object.getPrototypeOf(out.rows[0])).toBeNull();
  });
});

describe("select.describe", () => {
  it("returns the projected fields in spec order", () => {
    const described = selectTransform.describe?.(fields, { fields: ["region", "month"] });
    expect(described?.map((f) => f.name)).toEqual(["region", "month"]);
  });
});

describe("select.validate", () => {
  it("accepts a well-formed spec", () => {
    expect(selectTransform.validate?.({ fields: ["revenue", "region"] }, fields)).toEqual([]);
  });

  it("rejects a `fields` that is not a non-empty array", () => {
    for (const invalid of [undefined, null, "revenue", [], {}]) {
      const issues = selectTransform.validate?.({ fields: invalid } as never, fields) ?? [];
      expect(issues).toHaveLength(1);
      expect(issues[0]?.path).toEqual(["fields"]);
    }
  });

  it("rejects a non-string or empty entry in the `fields` array", () => {
    for (const invalid of [
      ["revenue", 123],
      ["revenue", ""],
    ]) {
      const issues = selectTransform.validate?.({ fields: invalid } as never, fields) ?? [];
      expect(issues).toHaveLength(1);
      expect(issues[0]?.path).toEqual(["fields", 1]);
    }
  });

  it("rejects duplicates in the list", () => {
    const issues = selectTransform.validate?.({ fields: ["revenue", "revenue"] }, fields) ?? [];
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toEqual(["fields", 1]);
    expect(issues[0]?.message).toMatch(/revenue/);
  });

  it("rejects a reference to a field that will not exist, with a suggestion", () => {
    const issues = selectTransform.validate?.({ fields: ["reveneu"] }, fields) ?? [];
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toMatch(/reveneu/);
    expect(issues[0]?.suggestion).toBe("revenue");
  });

  it("skips the existence check when the schema is unknown", () => {
    expect(selectTransform.validate?.({ fields: ["anything"] }, undefined)).toEqual([]);
  });
});
