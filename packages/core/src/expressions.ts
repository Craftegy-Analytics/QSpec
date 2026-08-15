import type { PathSegment } from "./errors.js";
import { normalizeExpression as normalizeInternal } from "./internal/expression/normalize.js";
import type { Expression } from "./types/expression.js";

export type { ComparisonShorthand, Expression } from "./types/expression.js";
export { evaluateExpression, type EvaluationScope } from "./internal/expression/evaluate.js";

export interface NormalizeExpressionOptions {
  /**
   * Maximum nesting depth. Plugins should pass `api.limits.maxExpressionDepth`,
   * captured at setup — that is how SPEC.md §72.5's limit reaches the code that
   * can enforce it.
   */
  readonly maxDepth: number;
  /**
   * Prefix for issue paths, so a transform can report against its own location
   * in the manifest. Defaults to empty.
   */
  readonly path?: readonly PathSegment[];
}

/**
 * Validates and canonicalizes an expression: expands the comparison shorthand,
 * rejects unknown operators and wrong arity, and enforces the depth limit.
 *
 * The internal implementation carries a fourth `depth` recursion parameter;
 * it is deliberately not part of this signature.
 */
export function normalizeExpression(
  input: unknown,
  options: NormalizeExpressionOptions,
): Expression {
  return normalizeInternal(input, options.path ?? [], options.maxDepth);
}
