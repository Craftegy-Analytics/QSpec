import { describe, expect, it } from "vitest";
import { LimitExceededError, ManifestValidationError } from "../../errors.js";
import { normalizeExpression } from "./normalize.js";

const at = ["spec", "transforms", 0, "where"] as const;

function normalize(input: unknown, maxDepth = 32) {
  return normalizeExpression(input, at, maxDepth);
}

describe("normalizeExpression", () => {
  it("passes leaf nodes through", () => {
    expect(normalize({ field: "revenue" })).toEqual({ field: "revenue" });
    expect(normalize({ literal: 0 })).toEqual({ literal: 0 });
    expect(normalize({ parameter: "from" })).toEqual({ parameter: "from" });
  });

  it("passes an operator node through, normalizing its arguments", () => {
    expect(normalize({ operator: "gt", arguments: [{ field: "r" }, { literal: 0 }] })).toEqual({
      operator: "gt",
      arguments: [{ field: "r" }, { literal: 0 }],
    });
  });

  it("expands the SPEC.md 40 comparison shorthand into the AST form", () => {
    expect(normalize({ field: "revenue", operator: "gt", value: 0 })).toEqual({
      operator: "gt",
      arguments: [{ field: "revenue" }, { literal: 0 }],
    });
  });

  it("rejects an unknown operator and suggests a close one", () => {
    try {
      normalize({ operator: "gte_", arguments: [{ field: "r" }, { literal: 0 }] });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ManifestValidationError);
      expect((error as ManifestValidationError).issues[0]?.suggestion).toBe("gte");
    }
  });

  it("rejects wrong arity", () => {
    expect(() => normalize({ operator: "not", arguments: [] })).toThrow(ManifestValidationError);
    expect(() => normalize({ operator: "eq", arguments: [{ literal: 1 }] })).toThrow(
      ManifestValidationError,
    );
  });

  it("accepts variadic and / or / coalesce", () => {
    const expression = normalize({
      operator: "and",
      arguments: [{ literal: true }, { literal: false }, { literal: true }],
    });
    expect(expression).toHaveProperty("arguments");
  });

  it("rejects a node that is neither a leaf nor an operator", () => {
    expect(() => normalize({})).toThrow(ManifestValidationError);
    expect(() => normalize("row => row.revenue > 100")).toThrow(ManifestValidationError);
    expect(() => normalize(null)).toThrow(ManifestValidationError);
  });

  it("reports the path of the offending node", () => {
    try {
      normalize({ operator: "and", arguments: [{ field: "a" }, {}] });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as ManifestValidationError).issues[0]?.path).toEqual([
        "spec",
        "transforms",
        0,
        "where",
        "arguments",
        1,
      ]);
    }
  });

  it("enforces the depth limit", () => {
    let expression: unknown = { field: "a" };
    for (let i = 0; i < 6; i += 1) {
      expression = { operator: "not", arguments: [expression] };
    }
    expect(() => normalize(expression, 3)).toThrow(LimitExceededError);
  });
});
