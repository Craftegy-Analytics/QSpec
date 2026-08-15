import { describe, expect, it } from "vitest";
import type { CompiledSqlQuery } from "@qspecs/sql";
import { renderPostgres } from "./render.js";

function compiled(overrides: Partial<CompiledSqlQuery> = {}): CompiledSqlQuery {
  return {
    segments: ["SELECT 1"],
    parameterNames: [],
    values: [],
    source: "primary",
    ...overrides,
  };
}

describe("renderPostgres", () => {
  it("returns the statement unchanged when there are no parameters", () => {
    const result = renderPostgres(
      compiled({ segments: ["SELECT * FROM t"], parameterNames: [], values: [] }),
    );
    expect(result.text).toBe("SELECT * FROM t");
    expect(result.values).toEqual([]);
  });

  it("renders one parameter as $1", () => {
    const result = renderPostgres(
      compiled({
        segments: ["SELECT * FROM t WHERE a = ", ""],
        parameterNames: ["from"],
        values: ["x"],
      }),
    );
    expect(result.text).toBe("SELECT * FROM t WHERE a = $1");
    expect(result.values).toEqual(["x"]);
  });

  it("renders three parameters as $1, $2, $3 in order", () => {
    const result = renderPostgres(
      compiled({
        segments: ["a = ", " AND b = ", " AND c = ", ""],
        parameterNames: ["a", "b", "c"],
        values: [1, 2, 3],
      }),
    );
    expect(result.text).toBe("a = $1 AND b = $2 AND c = $3");
    expect(result.values).toEqual([1, 2, 3]);
  });

  it("gives a repeated parameter two distinct placeholders and two values", () => {
    const result = renderPostgres(
      compiled({
        segments: ["WHERE a = ", " OR b = ", ""],
        parameterNames: ["from", "from"],
        values: ["x", "x"],
      }),
    );
    expect(result.text).toBe("WHERE a = $1 OR b = $2");
    expect(result.values).toEqual(["x", "x"]);
  });

  it("never interpolates a bound value into the rendered text (SPEC.md 72.2)", () => {
    const payload = "'; DROP TABLE t; --";
    const result = renderPostgres(
      compiled({
        segments: ["SELECT * FROM t WHERE name = ", ""],
        parameterNames: ["name"],
        values: [payload],
      }),
    );
    expect(result.text).not.toContain(payload);
    expect(result.text).toBe("SELECT * FROM t WHERE name = $1");
    expect(result.values).toEqual([payload]);
  });
});
