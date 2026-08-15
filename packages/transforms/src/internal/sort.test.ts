import { describe, expect, it } from "vitest";
import type { Dataset, Field } from "@qspecs/core";
import { sortTransform } from "./sort.js";
import { emptyRow, setCell } from "./rows.js";

const fields: Field[] = [
  { name: "name", type: "string" },
  { name: "score", type: "number" },
  { name: "active", type: "boolean" },
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

describe("sort.execute", () => {
  it("sorts ascending by default", async () => {
    const data = dataset([{ score: 3 }, { score: 1 }, { score: 2 }]);
    const out = await sortTransform.execute(data, { field: "score" }, context);
    expect(out.rows.map((r) => r["score"])).toEqual([1, 2, 3]);
  });

  it("sorts descending when direction is explicit", async () => {
    const data = dataset([{ score: 3 }, { score: 1 }, { score: 2 }]);
    const out = await sortTransform.execute(data, { field: "score", direction: "desc" }, context);
    expect(out.rows.map((r) => r["score"])).toEqual([3, 2, 1]);
  });

  it("orders numbers within their own type", async () => {
    const data = dataset([{ score: 10 }, { score: 2 }, { score: -5 }]);
    const out = await sortTransform.execute(data, { field: "score" }, context);
    expect(out.rows.map((r) => r["score"])).toEqual([-5, 2, 10]);
  });

  it("orders strings within their own type", async () => {
    const data = dataset([{ name: "banana" }, { name: "apple" }, { name: "cherry" }]);
    const out = await sortTransform.execute(data, { field: "name" }, context);
    expect(out.rows.map((r) => r["name"])).toEqual(["apple", "banana", "cherry"]);
  });

  it("orders booleans within their own type", async () => {
    const data = dataset([{ active: true }, { active: false }]);
    const out = await sortTransform.execute(data, { field: "active" }, context);
    expect(out.rows.map((r) => r["active"])).toEqual([false, true]);
  });

  // The comparator has two nullish branches — `isNullish(a)` and
  // `isNullish(b)` — and Array.prototype.sort's insertion-sort behavior on
  // small arrays only routes a null through a given branch depending on
  // where it sits relative to the values it gets compared against. Testing
  // a single null position leaves one branch unguarded (confirmed by
  // mutation testing — see task-4-report.md), so every position is
  // exercised for both directions.
  it.each([
    { label: "null first", values: [null, 1, 2], expected: [1, 2, null] },
    { label: "null middle", values: [2, null, 1], expected: [1, 2, null] },
    { label: "null last", values: [1, 2, null], expected: [1, 2, null] },
  ])(
    "sorts ascending with nulls last regardless of input position ($label)",
    async ({ values, expected }) => {
      const data = dataset(values.map((score) => ({ score })));
      const out = await sortTransform.execute(data, { field: "score" }, context);
      expect(out.rows.map((r) => r["score"])).toEqual(expected);
    },
  );

  it.each([
    { label: "null first", values: [null, 1, 2], expected: [2, 1, null] },
    { label: "null middle", values: [2, null, 1], expected: [2, 1, null] },
    { label: "null last", values: [1, 2, null], expected: [2, 1, null] },
  ])(
    "sorts descending with nulls last regardless of input position ($label) — absent data is not the largest value",
    async ({ values, expected }) => {
      const data = dataset(values.map((score) => ({ score })));
      const out = await sortTransform.execute(data, { field: "score", direction: "desc" }, context);
      expect(out.rows.map((r) => r["score"])).toEqual(expected);
    },
  );

  it("keeps rows with equal sort keys in their original relative order", async () => {
    const data = dataset([
      { name: "x", score: 1 },
      { name: "a", score: 1 },
    ]);
    const out = await sortTransform.execute(data, { field: "score" }, context);
    expect(out.rows.map((r) => r["name"])).toEqual(["x", "a"]);
  });

  it("does not mutate the input dataset", async () => {
    const data = dataset([{ score: 3 }, { score: 1 }, { score: 2 }]);
    const before = data.rows.map((r) => r["score"]);
    await sortTransform.execute(data, { field: "score" }, context);
    expect(data.rows.map((r) => r["score"])).toEqual(before);
  });

  it("keeps rows null-prototype", async () => {
    const data = dataset([{ score: 1 }]);
    const out = await sortTransform.execute(data, { field: "score" }, context);
    expect(Object.getPrototypeOf(out.rows[0])).toBeNull();
  });
});

describe("sort.describe", () => {
  it("returns fields unchanged — sorting reorders rows, not schema", () => {
    expect(sortTransform.describe?.(fields, { field: "score" })).toEqual(fields);
  });
});

describe("sort.validate", () => {
  it("accepts a well-formed spec", () => {
    expect(sortTransform.validate?.({ field: "score" }, fields)).toEqual([]);
  });

  it("rejects a non-string field", () => {
    const issues = sortTransform.validate?.({ field: 123 } as never, fields) ?? [];
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toEqual(["field"]);
  });

  it("rejects a direction other than asc or desc", () => {
    const issues =
      sortTransform.validate?.({ field: "score", direction: "up" } as never, fields) ?? [];
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toEqual(["direction"]);
  });

  it("rejects a reference to a field that will not exist, with a suggestion", () => {
    const issues = sortTransform.validate?.({ field: "scroe" }, fields) ?? [];
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toMatch(/scroe/);
    expect(issues[0]?.suggestion).toBe("score");
  });

  it("skips the field check when the projected schema is unknown", () => {
    expect(sortTransform.validate?.({ field: "anything" }, undefined)).toEqual([]);
  });
});
