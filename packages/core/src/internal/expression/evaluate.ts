import { QSpecError } from "../../errors.js";
import type { JsonValue } from "../../json.js";
import type { DatasetRow } from "../../types/dataset.js";
import type { Expression } from "../../types/expression.js";

export interface EvaluationScope {
  readonly row: DatasetRow;
  readonly parameters: Record<string, JsonValue>;
}

function isNullish(value: unknown): boolean {
  return value === null || value === undefined;
}

/**
 * Reads a required argument. `normalizeExpression` enforces arity before any
 * expression reaches the evaluator, so a missing argument means an
 * un-normalized expression was passed directly. A cast would strip the
 * `undefined` that `noUncheckedIndexedAccess` correctly surfaces, turning that
 * mistake into a raw TypeError deep in the interpreter.
 */
function argAt(args: readonly Expression[], index: number): Expression {
  const argument = args[index];
  if (argument === undefined) {
    throw new QSpecError(
      `Expression is missing argument ${index}. Expressions must be normalized before evaluation.`,
      { code: "QSPEC_MANIFEST_INVALID" },
    );
  }
  return argument;
}

/** Ordering comparison. Returns undefined when the operands are not comparable. */
function compare(left: unknown, right: unknown): number | undefined {
  if (isNullish(left) || isNullish(right)) return undefined;
  if (typeof left === "number" && typeof right === "number") return left - right;
  if (typeof left === "string" && typeof right === "string") {
    return left < right ? -1 : left > right ? 1 : 0;
  }
  if (typeof left === "boolean" && typeof right === "boolean") {
    return Number(left) - Number(right);
  }
  return undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function arithmetic(operator: string, left: unknown, right: unknown): number | null {
  const a = asNumber(left);
  const b = asNumber(right);
  if (a === undefined || b === undefined) return null;
  switch (operator) {
    case "add":
      return a + b;
    case "subtract":
      return a - b;
    case "multiply":
      return a * b;
    case "divide":
      // Infinity and NaN do not survive JSON, so a null result is used instead.
      return b === 0 ? null : a / b;
    default:
      return null;
  }
}

/**
 * Interprets a normalized expression. Never uses eval or the Function
 * constructor. (SPEC.md §41, §72.3)
 */
export function evaluateExpression(expression: Expression, scope: EvaluationScope): unknown {
  if ("literal" in expression) return expression.literal;

  if ("field" in expression) {
    // Object.hasOwn keeps inherited properties from leaking into results.
    return Object.hasOwn(scope.row, expression.field)
      ? (scope.row[expression.field] ?? null)
      : null;
  }

  if ("parameter" in expression) {
    return Object.hasOwn(scope.parameters, expression.parameter)
      ? (scope.parameters[expression.parameter] ?? null)
      : null;
  }

  const { operator, arguments: args } = expression;

  switch (operator) {
    case "and": {
      for (const argument of args) {
        if (!evaluateExpression(argument, scope)) return false;
      }
      return true;
    }
    case "or": {
      for (const argument of args) {
        if (evaluateExpression(argument, scope)) return true;
      }
      return false;
    }
    case "not":
      return !evaluateExpression(argAt(args, 0), scope);
    case "coalesce": {
      for (const argument of args) {
        const value = evaluateExpression(argument, scope);
        if (!isNullish(value)) return value;
      }
      return null;
    }
    case "isNull":
      return isNullish(evaluateExpression(argAt(args, 0), scope));
    default:
      break;
  }

  const left = evaluateExpression(argAt(args, 0), scope);
  const right = args.length > 1 ? evaluateExpression(argAt(args, 1), scope) : undefined;

  switch (operator) {
    case "eq":
      return isNullish(left) && isNullish(right) ? true : left === right;
    case "ne":
      return !(isNullish(left) && isNullish(right)) && left !== right;
    case "gt": {
      const result = compare(left, right);
      return result === undefined ? false : result > 0;
    }
    case "gte": {
      const result = compare(left, right);
      return result === undefined ? false : result >= 0;
    }
    case "lt": {
      const result = compare(left, right);
      return result === undefined ? false : result < 0;
    }
    case "lte": {
      const result = compare(left, right);
      return result === undefined ? false : result <= 0;
    }
    case "in":
      return Array.isArray(right) && right.some((candidate) => candidate === left);
    case "add":
    case "subtract":
    case "multiply":
    case "divide":
      return arithmetic(operator, left, right);
    default:
      // Unreachable: normalizeExpression rejects unknown operators.
      return null;
  }
}
