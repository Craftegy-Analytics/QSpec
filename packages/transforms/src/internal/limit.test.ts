import { describe, expect, it } from "vitest";
import type { Dataset, Field } from "@qspecs/core";
import { limitTransform } from "./limit.js";
import { emptyRow, setCell } from "./rows.js";

const fields: Field[] = [{ name: "score", type: "number" }];

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
const data = dataset([{ score: 1 }, { score: 2 }, { score: 3 }]);

describe("limit.execute", () => {
  it("truncates rows to count", async () => {
    const out = await limitTransform.execute(data, { count: 2 }, context);
    expect(out.rows.map((r) => r["score"])).toEqual([1, 2]);
  });

  it("is a no-op when count is larger than the row set", async () => {
    const out = await limitTransform.execute(data, { count: 100 }, context);
    expect(out.rows.map((r) => r["score"])).toEqual([1, 2, 3]);
  });

  it("count: 0 yields no rows", async () => {
    const out = await limitTransform.execute(data, { count: 0 }, context);
    expect(out.rows).toEqual([]);
  });

  it("offset skips rows from the start", async () => {
    const out = await limitTransform.execute(data, { count: 2, offset: 1 }, context);
    expect(out.rows.map((r) => r["score"])).toEqual([2, 3]);
  });

  it("offset beyond the end yields no rows", async () => {
    const out = await limitTransform.execute(data, { count: 2, offset: 10 }, context);
    expect(out.rows).toEqual([]);
  });

  it("does not mutate the input dataset", async () => {
    const before = data.rows.length;
    await limitTransform.execute(data, { count: 1 }, context);
    expect(data.rows).toHaveLength(before);
  });

  it("keeps rows null-prototype", async () => {
    const out = await limitTransform.execute(data, { count: 1 }, context);
    expect(Object.getPrototypeOf(out.rows[0])).toBeNull();
  });
});

describe("limit.describe", () => {
  it("returns fields unchanged — limiting drops rows, not schema", () => {
    expect(limitTransform.describe?.(fields, { count: 1 })).toEqual(fields);
  });
});

describe("limit.validate", () => {
  it("accepts a well-formed spec", () => {
    expect(limitTransform.validate?.({ count: 5 }, fields)).toEqual([]);
  });

  it("rejects a count that is not a non-negative integer", () => {
    for (const invalid of [-1, 1.5, "10", NaN]) {
      const issues = limitTransform.validate?.({ count: invalid as never }, fields) ?? [];
      expect(issues).toHaveLength(1);
      expect(issues[0]?.path).toEqual(["count"]);
    }
  });

  it("rejects an offset that is not a non-negative integer, when present", () => {
    for (const invalid of [-1, 1.5, "10", NaN]) {
      const issues =
        limitTransform.validate?.({ count: 5, offset: invalid as never }, fields) ?? [];
      expect(issues).toHaveLength(1);
      expect(issues[0]?.path).toEqual(["offset"]);
    }
  });

  it("rejects offset supplied without count — it is a slice, not a cursor", () => {
    const issues = limitTransform.validate?.({ offset: 2 } as never, fields) ?? [];
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]?.path).toEqual(["count"]);
  });
});
