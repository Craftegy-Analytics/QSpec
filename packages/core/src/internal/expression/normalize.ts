import { LimitExceededError, ManifestValidationError, type PathSegment } from "../../errors.js";
import { isPlainObject, type JsonValue } from "../../json.js";
import type { Expression } from "../../types/expression.js";
import { suggest } from "../suggest.js";

interface Arity {
  readonly minArity: number;
  readonly maxArity: number;
}

const VARIADIC = Number.POSITIVE_INFINITY;

/**
 * The complete operator set. Deliberately fixed and not registry-extensible:
 * an expression's meaning must not depend on which plugins are installed.
 * (SPEC.md §42; design §2.2)
 */
export const OPERATORS: ReadonlyMap<string, Arity> = new Map<string, Arity>([
  ["eq", { minArity: 2, maxArity: 2 }],
  ["ne", { minArity: 2, maxArity: 2 }],
  ["gt", { minArity: 2, maxArity: 2 }],
  ["gte", { minArity: 2, maxArity: 2 }],
  ["lt", { minArity: 2, maxArity: 2 }],
  ["lte", { minArity: 2, maxArity: 2 }],
  ["and", { minArity: 1, maxArity: VARIADIC }],
  ["or", { minArity: 1, maxArity: VARIADIC }],
  ["not", { minArity: 1, maxArity: 1 }],
  ["in", { minArity: 2, maxArity: 2 }],
  ["isNull", { minArity: 1, maxArity: 1 }],
  ["add", { minArity: 2, maxArity: 2 }],
  ["subtract", { minArity: 2, maxArity: 2 }],
  ["multiply", { minArity: 2, maxArity: 2 }],
  ["divide", { minArity: 2, maxArity: 2 }],
  ["coalesce", { minArity: 1, maxArity: VARIADIC }],
]);

function fail(message: string, path: readonly PathSegment[], suggestion?: string): never {
  throw new ManifestValidationError(message, {
    issues: [
      {
        code: "QSPEC_MANIFEST_INVALID",
        message,
        path,
        ...(suggestion === undefined ? {} : { suggestion }),
      },
    ],
  });
}

/**
 * Converts any accepted expression form into the canonical AST, validating
 * operator names, arity, and nesting depth. (SPEC.md §42, §72.5)
 */
export function normalizeExpression(
  input: unknown,
  path: readonly PathSegment[],
  maxDepth: number,
  depth = 1,
): Expression {
  if (depth > maxDepth) {
    throw new LimitExceededError(
      `Expression nesting exceeds the configured maximum depth of ${maxDepth}.`,
      { limit: "maxExpressionDepth", allowed: maxDepth, path },
    );
  }

  if (!isPlainObject(input)) {
    fail(
      "An expression must be an object: { field }, { literal }, { parameter }, or { operator, arguments }. " +
        "Embedded code is not permitted.",
      path,
    );
  }

  const hasOperator = typeof input["operator"] === "string";

  // Comparison shorthand: { field, operator, value } with no `arguments`.
  if (hasOperator && !Object.hasOwn(input, "arguments")) {
    if (typeof input["field"] !== "string" || !Object.hasOwn(input, "value")) {
      fail(
        "Shorthand comparison requires `field`, `operator`, and `value`. " +
          "Otherwise use the { operator, arguments } form.",
        path,
      );
    }
    return normalizeOperator(
      input["operator"] as string,
      [{ field: input["field"] }, { literal: input["value"] as JsonValue }],
      path,
      maxDepth,
      depth,
    );
  }

  if (hasOperator) {
    const args = input["arguments"];
    if (!Array.isArray(args)) {
      fail("`arguments` must be an array of expressions.", [...path, "arguments"]);
    }
    const normalized = args.map((argument, index) =>
      normalizeExpression(argument, [...path, "arguments", index], maxDepth, depth + 1),
    );
    return normalizeOperator(input["operator"] as string, normalized, path, maxDepth, depth);
  }

  if (typeof input["field"] === "string") return { field: input["field"] };
  if (typeof input["parameter"] === "string") return { parameter: input["parameter"] };
  if (Object.hasOwn(input, "literal")) return { literal: input["literal"] as JsonValue };

  fail(
    "Unrecognized expression node. Expected { field }, { literal }, { parameter }, or { operator, arguments }.",
    path,
  );
}

function normalizeOperator(
  operator: string,
  args: readonly Expression[],
  path: readonly PathSegment[],
  _maxDepth: number,
  _depth: number,
): Expression {
  const arity = OPERATORS.get(operator);
  if (arity === undefined) {
    fail(
      `Unknown operator "${operator}". Supported operators: ${[...OPERATORS.keys()].join(", ")}.`,
      [...path, "operator"],
      suggest(operator, [...OPERATORS.keys()]),
    );
  }
  if (args.length < arity.minArity || args.length > arity.maxArity) {
    const expected =
      arity.maxArity === VARIADIC
        ? `at least ${arity.minArity}`
        : arity.minArity === arity.maxArity
          ? `exactly ${arity.minArity}`
          : `${arity.minArity} to ${arity.maxArity}`;
    fail(`Operator "${operator}" expects ${expected} argument(s) but received ${args.length}.`, [
      ...path,
      "arguments",
    ]);
  }
  return { operator, arguments: args };
}
