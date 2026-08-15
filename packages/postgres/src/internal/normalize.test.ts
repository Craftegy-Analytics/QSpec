import { describe, expect, it } from "vitest";
import { normalizePgResult, type PgArrayModeQueryResult } from "./normalize.js";

describe("normalizePgResult", () => {
  it("maps column names and types from fields", () => {
    const result: PgArrayModeQueryResult = {
      fields: [
        { name: "id", dataTypeID: 23 },
        { name: "name", dataTypeID: 25 },
      ],
      rows: [[1, "a"]],
    };
    expect(normalizePgResult(result).columns).toEqual([
      { name: "id", nativeType: "int4" },
      { name: "name", nativeType: "text" },
    ]);
  });

  it("omits nativeType for an unknown OID", () => {
    const result: PgArrayModeQueryResult = {
      fields: [{ name: "geom", dataTypeID: 999999 }],
      rows: [],
    };
    // toStrictEqual (not toEqual) matters here: toEqual ignores keys whose
    // value is undefined, so it would pass equally for a column shaped
    // { name: "geom", nativeType: undefined } — which is exactly the bug
    // this test exists to rule out.
    expect(normalizePgResult(result).columns).toStrictEqual([{ name: "geom" }]);
  });

  it("yields columns and no rows for a zero-row result, without throwing", () => {
    const result: PgArrayModeQueryResult = {
      fields: [{ name: "id", dataTypeID: 23 }],
      rows: [],
    };
    const normalized = normalizePgResult(result);
    expect(normalized.columns).toEqual([{ name: "id", nativeType: "int4" }]);
    expect(normalized.rows).toEqual([]);
  });

  it("keeps both columns when SELECT 1 AS id, 2 AS id duplicates a name — the case row objects lose", () => {
    const result: PgArrayModeQueryResult = {
      fields: [
        { name: "id", dataTypeID: 23 },
        { name: "id", dataTypeID: 23 },
      ],
      rows: [[1, 2]],
    };
    const normalized = normalizePgResult(result);
    expect(normalized.columns).toEqual([
      { name: "id", nativeType: "int4" },
      { name: "id", nativeType: "int4" },
    ]);
    expect(normalized.rows).toEqual([[1, 2]]);
  });
});
