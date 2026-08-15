import type { Expression } from "@qspecs/core";

/**
 * Every `{ field: "..." }` node reachable in a normalized expression. Shared by
 * every transform that validates an expression against the incoming schema
 * (`filter`'s `where`, `derive`'s `expression`) so the walk is written once.
 */
export function referencedFields(expression: Expression, into: Set<string>): void {
  if ("field" in expression) {
    into.add(expression.field);
    return;
  }
  if ("operator" in expression) {
    for (const argument of expression.arguments) referencedFields(argument, into);
  }
}
