import { describe, expect, it } from "vitest";
import { postgresTypeName } from "./types.js";

describe("postgresTypeName", () => {
  const cases: readonly (readonly [number, string])[] = [
    [16, "bool"],
    [20, "int8"],
    [21, "int2"],
    [23, "int4"],
    [25, "text"],
    [114, "json"],
    [700, "float4"],
    [701, "float8"],
    [1043, "varchar"],
    [1082, "date"],
    [1083, "time"],
    [1114, "timestamp"],
    [1184, "timestamptz"],
    [1700, "numeric"],
    [2950, "uuid"],
    [3802, "jsonb"],
  ];

  it.each(cases)("maps OID %i to %s", (oid, name) => {
    expect(postgresTypeName(oid)).toBe(name);
  });

  it("returns undefined for an OID it does not cover, rather than a guess", () => {
    expect(postgresTypeName(999999)).toBeUndefined();
  });
});
