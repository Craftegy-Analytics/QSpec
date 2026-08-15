import type { JsonValue } from "@qspecs/core";
import type { CompiledSqlQuery } from "@qspecs/sql";

/**
 * Joins the dialect-neutral segments with Postgres placeholders.
 *
 * A repeated parameter gets a distinct placeholder and its value appears twice
 * — see the plan's decision 2. Reusing one placeholder would be valid Postgres
 * but requires mapping names to indices, and getting that wrong binds arguments
 * to the wrong slots.
 */
export function renderPostgres(compiled: CompiledSqlQuery): {
  readonly text: string;
  readonly values: readonly JsonValue[];
} {
  let text = "";
  compiled.segments.forEach((segment, index) => {
    text += segment;
    if (index < compiled.parameterNames.length) text += `$${index + 1}`;
  });
  return { text, values: compiled.values };
}
