import { describe, expect, it } from "vitest";
import type { Dataset, Field } from "@qspecs/core";
import { createFilterTransform } from "./filter.js";
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
const filter = createFilterTransform(32);

const data = dataset([
  { month: "2026-01", revenue: 10 },
  { month: "2026-02", revenue: 0 },
  { month: "2026-03", revenue: 25 },
]);

describe("filter.execute", () => {
  it("keeps rows the expression accepts", async () => {
    const out = await filter.execute(
      data,
      { where: { operator: "gt", arguments: [{ field: "revenue" }, { literal: 0 }] } },
      context,
    );
    expect(out.rows.map((r) => r["revenue"])).toEqual([10, 25]);
  });

  it("accepts the comparison shorthand", async () => {
    const out = await filter.execute(
      data,
      { where: { field: "revenue", operator: "gt", value: 0 } },
      context,
    );
    expect(out.rows).toHaveLength(2);
  });

  it("resolves parameters inside the expression", async () => {
    const out = await filter.execute(
      data,
      { where: { operator: "gte", arguments: [{ field: "revenue" }, { parameter: "floor" }] } },
      { ...context, parameters: { floor: 25 } },
    );
    expect(out.rows).toHaveLength(1);
  });

  it("does not mutate the input dataset", async () => {
    const before = data.rows.length;
    await filter.execute(data, { where: { field: "revenue", operator: "gt", value: 0 } }, context);
    expect(data.rows).toHaveLength(before);
  });

  it("preserves fields unchanged", async () => {
    const out = await filter.execute(data, { where: { literal: true } }, context);
    expect(out.fields).toEqual(fields);
  });

  it("keeps rows null-prototype", async () => {
    const out = await filter.execute(data, { where: { literal: true } }, context);
    expect(Object.getPrototypeOf(out.rows[0])).toBeNull();
  });
});

describe("filter.describe", () => {
  it("passes fields through unchanged — filtering changes rows, not schema", () => {
    expect(filter.describe?.(fields, { where: { literal: true } })).toEqual(fields);
  });
});

describe("filter.validate", () => {
  it("accepts a well-formed expression", () => {
    expect(
      filter.validate?.({ where: { field: "revenue", operator: "gt", value: 0 } }, fields),
    ).toEqual([]);
  });

  it("rejects a missing where clause", () => {
    const issues = filter.validate?.({} as never, fields) ?? [];
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toEqual(["where"]);
  });

  it("rejects an unknown operator, with the path relative to the transform", () => {
    const issues =
      filter.validate?.(
        { where: { operator: "gte_", arguments: [{ field: "revenue" }, { literal: 0 }] } },
        fields,
      ) ?? [];
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toEqual(["where", "operator"]);
    expect(issues[0]?.suggestion).toBe("gte");
  });

  it("rejects a reference to a field that will not exist, with a suggestion", () => {
    const issues =
      filter.validate?.({ where: { field: "reveneu", operator: "gt", value: 0 } }, fields) ?? [];
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toMatch(/reveneu/);
    expect(issues[0]?.suggestion).toBe("revenue");
  });

  it("skips the field check when the projected schema is unknown", () => {
    expect(
      filter.validate?.({ where: { field: "anything", operator: "gt", value: 0 } }, undefined),
    ).toEqual([]);
  });

  it("enforces the expression depth limit it was constructed with", () => {
    const shallow = createFilterTransform(2);
    let nested: unknown = { field: "revenue" };
    for (let i = 0; i < 5; i += 1) nested = { operator: "not", arguments: [nested] };
    const issues = shallow.validate?.({ where: nested }, fields) ?? [];
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toMatch(/depth/i);
  });
});
