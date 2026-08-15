import {
  LimitExceededError,
  ManifestValidationError,
  evaluateExpression,
  normalizeExpression,
  type Dataset,
  type Expression,
  type Field,
  type QSpecIssue,
  type Transform,
} from "@qspecs/core";
import { referencedFields } from "./expressions.js";
import { issue, unknownFieldIssue } from "./issues.js";

export interface FilterSpec {
  /** An expression, or the `{ field, operator, value }` comparison shorthand. */
  readonly where: unknown;
}

/**
 * `maxExpressionDepth` is injected rather than read from a global, because it is
 * runtime configuration: the plugin captures `api.limits.maxExpressionDepth` at
 * setup and passes it here. That is how SPEC.md §72.5's limit reaches the only
 * code that can enforce it.
 */
export function createFilterTransform(maxExpressionDepth: number): Transform<FilterSpec> {
  const compile = (spec: FilterSpec): Expression =>
    normalizeExpression(spec.where, { maxDepth: maxExpressionDepth, path: ["where"] });

  return {
    execute(dataset: Dataset, spec: FilterSpec, context): Dataset {
      // Compiled once per execution, not per row.
      const expression = compile(spec);
      const rows = dataset.rows.filter((row) =>
        Boolean(evaluateExpression(expression, { row, parameters: context.parameters })),
      );
      return { ...dataset, rows };
    },

    describe(fields: readonly Field[]): readonly Field[] {
      // Filtering removes rows, never columns.
      return fields;
    },

    validate(spec: FilterSpec, fields: readonly Field[] | undefined): readonly QSpecIssue[] {
      if (
        spec === null ||
        typeof spec !== "object" ||
        !("where" in spec) ||
        spec.where === undefined
      ) {
        return [issue("`filter` requires a `where` expression.", ["where"])];
      }

      let expression: Expression;
      try {
        expression = compile(spec);
      } catch (error) {
        // normalizeExpression reports precise paths already; surface them
        // rather than flattening to a single message.
        if (error instanceof LimitExceededError) {
          return [issue(error.message, ["where"])];
        }
        if (error instanceof ManifestValidationError) {
          return error.issues;
        }
        return [issue(error instanceof Error ? error.message : String(error), ["where"])];
      }

      if (fields === undefined) return [];

      const known = fields.map((field) => field.name);
      const knownSet = new Set(known);
      const referenced = new Set<string>();
      referencedFields(expression, referenced);

      return [...referenced]
        .filter((name) => !knownSet.has(name))
        .map((name) => unknownFieldIssue(name, known, ["where"]));
    },
  };
}
