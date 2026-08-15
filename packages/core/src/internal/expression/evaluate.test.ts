import { describe, expect, it } from "vitest";
import { QSpecError } from "../../errors.js";
import { createRow, setKey } from "../../json.js";
import type { Expression } from "../../types/expression.js";
import { evaluateExpression } from "./evaluate.js";

function scope(
  fields: Record<string, unknown> = {},
  parameters: Record<string, never> | Record<string, unknown> = {},
) {
  const row = createRow();
  for (const [key, value] of Object.entries(fields)) setKey(row, key, value);
  return { row, parameters: parameters as Record<string, never> };
}

function evaluate(expression: Expression, fields: Record<string, unknown> = {}, parameters = {}) {
  return evaluateExpression(expression, scope(fields, parameters));
}

describe("leaf nodes", () => {
  it("reads literals, fields, and parameters", () => {
    expect(evaluate({ literal: 42 })).toBe(42);
    expect(evaluate({ field: "revenue" }, { revenue: 10 })).toBe(10);
    expect(evaluate({ parameter: "country" }, {}, { country: "US" })).toBe("US");
  });

  it("yields null for a missing field or parameter", () => {
    expect(evaluate({ field: "nope" })).toBeNull();
    expect(evaluate({ parameter: "nope" })).toBeNull();
  });

  it("does not read inherited properties, even from a row that has a prototype", () => {
    // createRow() is null-prototype, so asserting against it proves nothing —
    // there is no chain to leak from. A plain object exercises the guard: with
    // `in` instead of Object.hasOwn, this would return Object.prototype.toString.
    const row: Record<string, unknown> = {};
    expect(evaluateExpression({ field: "toString" }, { row, parameters: {} })).toBeNull();
  });

  it("does not read inherited properties for a parameter", () => {
    // `parameters` is an ordinary object, so this is where the guard matters.
    expect(evaluate({ parameter: "toString" })).toBeNull();
  });
});

describe("comparison", () => {
  const gt = (a: unknown, b: unknown) =>
    evaluate({ operator: "gt", arguments: [{ field: "a" }, { field: "b" }] }, { a, b });

  it("compares numbers and strings", () => {
    expect(gt(2, 1)).toBe(true);
    expect(gt(1, 2)).toBe(false);
    expect(gt("b", "a")).toBe(true);
  });

  it("is false rather than throwing when an operand is null", () => {
    expect(gt(null, 1)).toBe(false);
    expect(gt(1, null)).toBe(false);
  });

  it("is false for mismatched types", () => {
    expect(gt("2", 1)).toBe(false);
  });

  it("treats eq strictly and handles null equality", () => {
    const eq = (a: unknown, b: unknown) =>
      evaluate({ operator: "eq", arguments: [{ field: "a" }, { field: "b" }] }, { a, b });
    expect(eq(1, 1)).toBe(true);
    expect(eq(1, "1")).toBe(false);
    expect(eq(null, null)).toBe(true);
    expect(eq(null, 0)).toBe(false);
  });

  it("negates eq for ne", () => {
    expect(evaluate({ operator: "ne", arguments: [{ literal: 1 }, { literal: 2 }] })).toBe(true);
  });
});

describe("logical operators", () => {
  it("evaluates and / or / not", () => {
    expect(evaluate({ operator: "and", arguments: [{ literal: true }, { literal: false }] })).toBe(
      false,
    );
    expect(evaluate({ operator: "or", arguments: [{ literal: false }, { literal: true }] })).toBe(
      true,
    );
    expect(evaluate({ operator: "not", arguments: [{ literal: false }] })).toBe(true);
  });

  it("short-circuits `and` without evaluating later arguments", () => {
    // A tripwire accessor proves laziness. Using divide-by-zero as the second
    // argument would NOT: it evaluates to null rather than throwing, so an
    // eager implementation would produce the same `false` and the test would
    // pass against the very bug it is meant to catch.
    const row = createRow();
    let touched = 0;
    Object.defineProperty(row, "tripwire", {
      get: () => {
        touched += 1;
        return 1;
      },
      enumerable: true,
      configurable: true,
    });
    const scope = { row, parameters: {} as Record<string, never> };

    evaluateExpression(
      { operator: "and", arguments: [{ literal: false }, { field: "tripwire" }] },
      scope,
    );
    expect(touched).toBe(0);

    // Confirm the tripwire actually fires when it is reached, so the zero above
    // means "skipped", not "broken".
    evaluateExpression(
      { operator: "and", arguments: [{ literal: true }, { field: "tripwire" }] },
      scope,
    );
    expect(touched).toBe(1);
  });

  it("short-circuits `or` without evaluating later arguments", () => {
    const row = createRow();
    let touched = 0;
    Object.defineProperty(row, "tripwire", {
      get: () => {
        touched += 1;
        return 1;
      },
      enumerable: true,
      configurable: true,
    });
    const scope = { row, parameters: {} as Record<string, never> };

    evaluateExpression(
      { operator: "or", arguments: [{ literal: true }, { field: "tripwire" }] },
      scope,
    );
    expect(touched).toBe(0);

    // Confirm the tripwire actually fires when it is reached.
    evaluateExpression(
      { operator: "or", arguments: [{ literal: false }, { field: "tripwire" }] },
      scope,
    );
    expect(touched).toBe(1);
  });

  it("throws QSpecError, not a raw TypeError, for an un-normalized missing argument", () => {
    // normalizeExpression enforces arity before evaluation; this simulates a
    // caller bypassing that step with a hand-built malformed expression.
    expect(() => evaluate({ operator: "not", arguments: [] })).toThrow(QSpecError);
  });
});

describe("arithmetic", () => {
  it("adds, subtracts, multiplies, and divides", () => {
    const arith = (operator: string) =>
      evaluate({ operator, arguments: [{ literal: 6 }, { literal: 3 }] });
    expect(arith("add")).toBe(9);
    expect(arith("subtract")).toBe(3);
    expect(arith("multiply")).toBe(18);
    expect(arith("divide")).toBe(2);
  });

  it("propagates null", () => {
    expect(
      evaluate({ operator: "add", arguments: [{ field: "missing" }, { literal: 1 }] }),
    ).toBeNull();
  });

  it("yields null on divide by zero rather than Infinity", () => {
    expect(
      evaluate({ operator: "divide", arguments: [{ literal: 1 }, { literal: 0 }] }),
    ).toBeNull();
  });

  it("yields null for non-numeric operands", () => {
    expect(evaluate({ operator: "add", arguments: [{ literal: "a" }, { literal: 1 }] })).toBeNull();
  });
});

describe("in, isNull, coalesce", () => {
  it("tests membership against an array literal", () => {
    const expression: Expression = {
      operator: "in",
      arguments: [{ field: "country" }, { literal: ["US", "DE"] }],
    };
    expect(evaluate(expression, { country: "DE" })).toBe(true);
    expect(evaluate(expression, { country: "FR" })).toBe(false);
  });

  it("is false when the second argument is not an array", () => {
    expect(evaluate({ operator: "in", arguments: [{ literal: 1 }, { literal: 1 }] })).toBe(false);
  });

  it("detects null", () => {
    expect(evaluate({ operator: "isNull", arguments: [{ field: "nope" }] })).toBe(true);
    expect(evaluate({ operator: "isNull", arguments: [{ literal: 0 }] })).toBe(false);
  });

  it("coalesces to the first non-null value", () => {
    expect(
      evaluate({
        operator: "coalesce",
        arguments: [{ field: "nope" }, { literal: null }, { literal: "fallback" }],
      }),
    ).toBe("fallback");
  });
});
