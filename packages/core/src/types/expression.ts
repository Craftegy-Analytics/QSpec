import type { JsonValue } from "../json.js";

/**
 * The QSpec expression AST. Intentionally limited: it must not become
 * JavaScript represented as JSON. (SPEC.md §42)
 */
export type Expression =
  | { readonly field: string }
  | { readonly literal: JsonValue }
  | { readonly parameter: string }
  | { readonly operator: string; readonly arguments: readonly Expression[] };

/**
 * The comparison shorthand shown in SPEC.md §40. Normalized into the AST form
 * during prepare(); the canonical serialization always uses the AST form.
 */
export interface ComparisonShorthand {
  readonly field: string;
  readonly operator: string;
  readonly value: JsonValue;
}
