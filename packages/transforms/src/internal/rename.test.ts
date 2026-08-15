import { describe, expect, it } from "vitest";
import type { Dataset, Field } from "@qspecs/core";
import { renameTransform, type RenameSpec } from "./rename.js";
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

describe("rename.execute", () => {
  it("renames one field", async () => {
    const out = await renameTransform.execute(data, { fields: { revenue: "amount" } }, context);
    expect(out.fields.map((f) => f.name)).toEqual(["month", "amount", "region"]);
    expect(out.rows.map((r) => r["amount"])).toEqual([10, 20]);
    for (const row of out.rows) expect("revenue" in row).toBe(false);
  });

  it("refuses to produce two fields with the same name", () => {
    // Reachable only when the schema was unknown at validate() time — a
    // schema-opaque upstream transform leaves validate() with
    // `fields === undefined`, so its collision check is skipped. Without this
    // guard the result carried fields ["month", "region", "region"] against
    // rows holding a single "region" key, breaking the Transform contract's
    // "row keys match the returned fields exactly" and dropping a column.
    expect(renameTransform.validate?.({ fields: { revenue: "region" } }, undefined)).toEqual([]);
    // execute() is synchronous here, so the throw is synchronous too; core's
    // transform boundary wraps it as a TransformError naming this transform
    // and its index.
    expect(() => renameTransform.execute(data, { fields: { revenue: "region" } }, context)).toThrow(
      /two fields named "region"/,
    );
  });

  it("still allows a swap, which passes through a transient duplicate only in intent", async () => {
    const out = await renameTransform.execute(
      data,
      { fields: { month: "revenue", revenue: "month" } },
      context,
    );
    expect(out.fields.map((f) => f.name)).toEqual(["revenue", "month", "region"]);
    expect(out.rows.map((r) => [r["revenue"], r["month"]])).toEqual([
      ["2026-01", 10],
      ["2026-02", 20],
    ]);
  });

  it("renames several fields at once", async () => {
    const out = await renameTransform.execute(
      data,
      { fields: { revenue: "amount", region: "area" } },
      context,
    );
    expect(out.fields.map((f) => f.name)).toEqual(["month", "amount", "area"]);
    expect(out.rows.map((r) => [r["amount"], r["area"]])).toEqual([
      [10, "west"],
      [20, "east"],
    ]);
  });

  it("leaves unlisted fields alone", async () => {
    const out = await renameTransform.execute(data, { fields: { revenue: "amount" } }, context);
    expect(out.fields.find((f) => f.name === "month")).toEqual(fields[0]);
    expect(out.rows.map((r) => r["month"])).toEqual(["2026-01", "2026-02"]);
  });

  it("preserves the original field order — a rename is not a reorder", async () => {
    // Renaming "month" -> "zzz" would sort last alphabetically, and
    // "revenue" -> "aaa" would sort first — if the output were reordered
    // by new name, "region" (untouched) would land in the middle instead
    // of last. Assert the original position order survives regardless.
    const out = await renameTransform.execute(
      data,
      { fields: { month: "zzz", revenue: "aaa" } },
      context,
    );
    expect(out.fields.map((f) => f.name)).toEqual(["zzz", "aaa", "region"]);
  });

  it("does not mutate the input dataset", async () => {
    const beforeFields = data.fields.map((f) => f.name);
    const beforeRows = data.rows.map((r) => ({ ...r }));
    await renameTransform.execute(data, { fields: { revenue: "amount" } }, context);
    expect(data.fields.map((f) => f.name)).toEqual(beforeFields);
    expect(data.rows.map((r) => ({ ...r }))).toEqual(beforeRows);
  });

  it("keeps rows null-prototype", async () => {
    const out = await renameTransform.execute(data, { fields: { revenue: "amount" } }, context);
    expect(Object.getPrototypeOf(out.rows[0])).toBeNull();
  });

  it("leaves a field named `constructor` alone when it is not in the mapping", async () => {
    // Bare bracket access (`mapping[name]`) would read Object.prototype.constructor
    // here — a FUNCTION, not undefined — and rename the field to a function.
    // This codebase supports prototype-shaped column names everywhere else;
    // rename must not be the exception.
    const protoFields: Field[] = [
      { name: "constructor", type: "string" },
      { name: "revenue", type: "number" },
    ];
    const row = emptyRow();
    setCell(row, "constructor", "keep me");
    setCell(row, "revenue", 1);
    const protoData: Dataset = { fields: protoFields, rows: [row] };

    const out = await renameTransform.execute(protoData, { fields: { revenue: "total" } }, context);
    expect(out.fields.map((f) => f.name)).toEqual(["constructor", "total"]);
    expect(out.rows[0]?.["constructor"]).toBe("keep me");
  });

  it("renames a field named `constructor` when it IS in the mapping", async () => {
    const protoFields: Field[] = [{ name: "constructor", type: "string" }];
    const row = emptyRow();
    setCell(row, "constructor", "value");
    const protoData: Dataset = { fields: protoFields, rows: [row] };

    const out = await renameTransform.execute(
      protoData,
      { fields: { constructor: "kind" } },
      context,
    );
    expect(out.fields.map((f) => f.name)).toEqual(["kind"]);
    expect(out.rows[0]?.["kind"]).toBe("value");
  });
});

describe("rename.describe", () => {
  it("maps names identically to what execute produces — a divergence here is exactly the bug describe exists to prevent", async () => {
    // A stress fixture: a swap (month <-> revenue) plus an ordinary rename
    // (region -> area), all at once.
    const spec: RenameSpec = { fields: { month: "revenue", revenue: "month", region: "area" } };
    const described = renameTransform.describe?.(fields, spec) ?? [];
    const out = await renameTransform.execute(data, spec, context);
    expect(described.map((f) => f.name)).toEqual(out.fields.map((f) => f.name));
  });

  it("keeps a field named `constructor` in the projection when it is not in the mapping", () => {
    const protoFields: Field[] = [
      { name: "constructor", type: "string" },
      { name: "revenue", type: "number" },
    ];
    const described =
      renameTransform.describe?.(protoFields, { fields: { revenue: "total" } }) ?? [];
    expect(described.map((f) => f.name)).toEqual(["constructor", "total"]);
  });
});

describe("rename.validate", () => {
  it("accepts a well-formed spec", () => {
    expect(renameTransform.validate?.({ fields: { revenue: "amount" } }, fields)).toEqual([]);
  });

  it("rejects a `fields` that is not a plain object", () => {
    for (const invalid of [undefined, null, [], "revenue"]) {
      const issues = renameTransform.validate?.({ fields: invalid } as never, fields) ?? [];
      expect(issues).toHaveLength(1);
      expect(issues[0]?.path).toEqual(["fields"]);
    }
  });

  it("rejects a non-string or empty rename target", () => {
    const issues = renameTransform.validate?.({ fields: { revenue: "" } } as never, fields) ?? [];
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toEqual(["fields", "revenue"]);
  });

  it("rejects a source field that will not exist, with a suggestion", () => {
    const issues = renameTransform.validate?.({ fields: { reveneu: "amount" } }, fields) ?? [];
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toMatch(/reveneu/);
    expect(issues[0]?.suggestion).toBe("revenue");
  });

  it("rejects a target colliding with an existing un-renamed field", () => {
    const issues = renameTransform.validate?.({ fields: { revenue: "region" } }, fields) ?? [];
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((i) => i.message.includes("collide"))).toBe(true);
  });

  it("rejects two sources renaming to the same target", () => {
    const issues =
      renameTransform.validate?.({ fields: { revenue: "amount", region: "amount" } }, fields) ?? [];
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((i) => i.message.includes("amount"))).toBe(true);
  });

  it("accepts a swap — renaming onto a field that is itself being renamed away is fine", () => {
    const issues =
      renameTransform.validate?.({ fields: { month: "revenue", revenue: "month" } }, fields) ?? [];
    expect(issues).toEqual([]);
  });

  it("skips existence checks when the schema is unknown", () => {
    expect(renameTransform.validate?.({ fields: { anything: "else" } }, undefined)).toEqual([]);
  });

  it("still rejects two sources renaming to the same target when the schema is unknown", () => {
    // The duplicate-TARGET check does not need the schema, so it must not be
    // skipped along with the existence checks above.
    const issues =
      renameTransform.validate?.({ fields: { revenue: "amount", region: "amount" } }, undefined) ??
      [];
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((i) => i.message.includes("amount"))).toBe(true);
  });

  it("still detects a collision against a field literally named `constructor`", () => {
    // Object.entries only reads own properties, so this isn't fooled by the
    // prototype chain the way bare bracket access would be — but the
    // knownSet.has(to) collision check is worth pinning directly, since it
    // is the piece that would need to special-case "constructor" if Sets
    // behaved like plain objects (they don't).
    const protoFields: Field[] = [
      { name: "constructor", type: "string" },
      { name: "revenue", type: "number" },
    ];
    const issues =
      renameTransform.validate?.({ fields: { revenue: "constructor" } }, protoFields) ?? [];
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((i) => i.message.includes("collide"))).toBe(true);
  });
});
