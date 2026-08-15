import { describe, expect, it } from "vitest";
import type { RawQueryResult } from "../types/dataset.js";
import { normalizeResult } from "./normalize-result.js";

function raw(columns: string[], rows: unknown[][]): RawQueryResult {
  return { columns: columns.map((name) => ({ name })), rows };
}

describe("normalizeResult", () => {
  it("converts positional rows into keyed rows", () => {
    const { dataset } = normalizeResult(raw(["month", "revenue"], [["2026-01", 10]]));
    expect(dataset.rows).toHaveLength(1);
    expect(dataset.rows[0]?.["month"]).toBe("2026-01");
    expect(dataset.rows[0]?.["revenue"]).toBe(10);
  });

  it("infers a column named after an Object.prototype member instead of reading the prototype", () => {
    // `toString` exists on Object.prototype, so an unguarded `declared[name]`
    // lookup against the declared-field record would return a function and
    // spread it into a Field with no `type` and no `nullable`.
    const { dataset } = normalizeResult(raw(["toString"], [["x"]]), {
      schema: { fields: { other: { type: "integer" } } },
    });

    expect(dataset.fields).toEqual([{ name: "toString", type: "string", nullable: false }]);
  });

  it("produces null-prototype rows", () => {
    const { dataset } = normalizeResult(raw(["a"], [[1]]));
    expect(Object.getPrototypeOf(dataset.rows[0])).toBeNull();
  });

  it("preserves column order in fields", () => {
    const { dataset } = normalizeResult(raw(["b", "a"], []));
    expect(dataset.fields.map((field) => field.name)).toEqual(["b", "a"]);
  });

  it("infers types from the first non-null value", () => {
    const { dataset } = normalizeResult(
      raw(
        ["s", "n", "i", "b", "o", "arr"],
        [
          [null, null, null, null, null, null],
          ["x", 1.5, 3, true, { a: 1 }, [1]],
        ],
      ),
    );
    const types = Object.fromEntries(dataset.fields.map((f) => [f.name, f.type]));
    expect(types).toEqual({
      s: "string",
      n: "number",
      i: "integer",
      b: "boolean",
      o: "object",
      arr: "array",
    });
  });

  it("defaults an all-null column to string", () => {
    const { dataset } = normalizeResult(raw(["a"], [[null], [null]]));
    expect(dataset.fields[0]?.type).toBe("string");
  });

  it("marks a column nullable when a null appears after the first value", () => {
    const { dataset } = normalizeResult(raw(["a"], [[10], [null]]));
    expect(dataset.fields[0]).toMatchObject({ name: "a", type: "integer", nullable: true });
  });

  it("marks a column non-nullable when no null appears anywhere", () => {
    const { dataset } = normalizeResult(raw(["a"], [[10], [20]]));
    expect(dataset.fields[0]?.nullable).toBe(false);
  });

  it("converts Date values to ISO strings so datasets stay JSON-serializable", () => {
    const { dataset } = normalizeResult(raw(["t"], [[new Date("2026-01-01T00:00:00Z")]]));
    expect(dataset.fields[0]?.type).toBe("datetime");
    expect(dataset.rows[0]?.["t"]).toBe("2026-01-01T00:00:00.000Z");
  });

  it("prefers declared schema metadata over inference", () => {
    const { dataset } = normalizeResult(raw(["revenue"], [[10]]), {
      schema: {
        fields: {
          revenue: {
            type: "number",
            nullable: false,
            semanticType: "currency",
            format: { currency: "USD" },
          },
        },
      },
    });
    expect(dataset.fields[0]).toMatchObject({
      name: "revenue",
      type: "number",
      semanticType: "currency",
      format: { currency: "USD" },
    });
  });

  it("renames duplicate columns and reports the renames", () => {
    const outcome = normalizeResult(raw(["id", "id", "id"], [[1, 2, 3]]));
    expect(outcome.dataset.fields.map((f) => f.name)).toEqual(["id", "id_2", "id_3"]);
    expect(outcome.dataset.rows[0]).toMatchObject({ id: 1, id_2: 2, id_3: 3 });
    expect(outcome.duplicates).toEqual([
      { original: "id", renamed: "id_2" },
      { original: "id", renamed: "id_3" },
    ]);
  });

  it("skips past a generated name that collides with a real column", () => {
    const outcome = normalizeResult(raw(["id", "id_2", "id"], [[1, 2, 3]]));
    expect(outcome.dataset.fields.map((f) => f.name)).toEqual(["id", "id_2", "id_3"]);
  });

  it("carries a column literally named __proto__ as an own property", () => {
    const { dataset } = normalizeResult(raw(["__proto__"], [[{ polluted: true }]]));
    const row = dataset.rows[0];
    // Reading row["__proto__"] alone proves nothing: on a plain object it would
    // return the prototype, and the assertion would still pass. Assert it is an
    // OWN property and that the row's prototype is still null.
    expect(row === undefined ? undefined : Object.hasOwn(row, "__proto__")).toBe(true);
    expect(row === undefined ? undefined : Object.getPrototypeOf(row)).toBeNull();
    expect(row?.["__proto__"]).toEqual({ polluted: true });
  });

  it("truncates at maxRows and flags it in metadata", () => {
    const { dataset } = normalizeResult(raw(["a"], [[1], [2], [3]]), { maxRows: 2 });
    expect(dataset.rows).toHaveLength(2);
    expect(dataset.metadata?.truncated).toBe(true);
  });

  it("does not flag truncation when the result fits", () => {
    const { dataset } = normalizeResult(raw(["a"], [[1]]), { maxRows: 2 });
    expect(dataset.metadata?.truncated).toBeUndefined();
  });

  it("fills missing trailing cells with null", () => {
    const { dataset } = normalizeResult(raw(["a", "b"], [[1]]));
    expect(dataset.rows[0]?.["b"]).toBeNull();
  });
});
