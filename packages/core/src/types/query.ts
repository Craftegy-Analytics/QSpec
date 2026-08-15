import type { JsonValue } from "../json.js";

/**
 * A query binding. The string form is valid only when it matches
 * `^\$parameters\.[A-Za-z_]\w*$`; any other string is a manifest error.
 * Literal strings must use the `{ literal }` form. (SPEC.md §34; design §2.1)
 */
export type Binding = string | { readonly parameter: string } | { readonly literal: JsonValue };

/** `statement` is deliberately unconstrained so structured queries work. (SPEC.md §35) */
export interface QueryDefinition<TStatement = unknown> {
  readonly source: string;
  readonly language: string;
  readonly statement: TStatement;
  readonly bindings?: { readonly [name: string]: Binding };
}
