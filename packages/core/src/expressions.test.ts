import { describe, expect, it } from "vitest";
import { LimitExceededError, ManifestValidationError } from "./errors.js";
import { evaluateExpression, normalizeExpression } from "./expressions.js";

describe("public expression API", () => {
  it("normalizes the AST form", () => {
    expect(
      normalizeExpression(
        { operator: "gt", arguments: [{ field: "r" }, { literal: 0 }] },
        {
          maxDepth: 32,
        },
      ),
    ).toEqual({ operator: "gt", arguments: [{ field: "r" }, { literal: 0 }] });
  });

  it("expands the comparison shorthand", () => {
    expect(normalizeExpression({ field: "r", operator: "gt", value: 0 }, { maxDepth: 32 })).toEqual(
      {
        operator: "gt",
        arguments: [{ field: "r" }, { literal: 0 }],
      },
    );
  });

  it("reports issue paths relative to the supplied path", () => {
    try {
      normalizeExpression({ operator: "nope", arguments: [] }, { maxDepth: 32, path: ["where"] });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ManifestValidationError);
      expect((error as ManifestValidationError).issues[0]?.path).toEqual(["where", "operator"]);
    }
  });

  it("defaults the path to empty when none is given", () => {
    try {
      normalizeExpression({ operator: "nope", arguments: [] }, { maxDepth: 32 });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as ManifestValidationError).issues[0]?.path).toEqual(["operator"]);
    }
  });

  it("enforces maxDepth", () => {
    let nested: unknown = { field: "a" };
    for (let i = 0; i < 6; i += 1) nested = { operator: "not", arguments: [nested] };
    expect(() => normalizeExpression(nested, { maxDepth: 3 })).toThrow(LimitExceededError);
    // The same structure must SUCCEED at a higher limit. Without this half, the
    // test cannot distinguish "forwards options.maxDepth" from "ignores it and
    // hardcodes a small constant".
    expect(() => normalizeExpression(nested, { maxDepth: 32 })).not.toThrow();
  });

  it("evaluates against a row and parameters", () => {
    const row: Record<string, unknown> = Object.create(null);
    Object.defineProperty(row, "revenue", { value: 10, enumerable: true });
    const expression = normalizeExpression(
      { operator: "gt", arguments: [{ field: "revenue" }, { parameter: "floor" }] },
      { maxDepth: 32 },
    );
    expect(evaluateExpression(expression, { row, parameters: { floor: 5 } })).toBe(true);
    expect(evaluateExpression(expression, { row, parameters: { floor: 50 } })).toBe(false);
  });
});
