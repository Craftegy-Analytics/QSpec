import {
  FIELD_TYPES,
  LimitExceededError,
  ManifestValidationError,
  evaluateExpression,
  normalizeExpression,
  suggest,
  type Dataset,
  type Expression,
  type Field,
  type FieldType,
  type QSpecIssue,
  type Transform,
} from "@qspecs/core";
import { referencedFields } from "./expressions.js";
import { issue, unknownFieldIssue } from "./issues.js";
import { emptyRow, setCell } from "./rows.js";

export interface DeriveSpec {
  /** Name of the new, computed field. Must not collide with an existing field. */
  readonly field: string;
  /**
   * Required, not defaulted. An expression can return a string, a number, a
   * boolean, or null depending on its inputs — guessing "number" would feed
   * core's dataset validator a schema claim this transform cannot honor.
   */
  readonly fieldType: FieldType;
  readonly expression: unknown;
}

/**
 * `maxExpressionDepth` is injected rather than read from a global, for the
 * same reason `createFilterTransform` takes it: it is runtime configuration
 * captured from `api.limits.maxExpressionDepth` at plugin setup.
 */
/**
 * Any expression can evaluate to null (arithmetic on a missing field is one
 * way), so the derived field is always nullable — anything else would be a
 * promise this transform cannot keep. Shared by describe() and execute() so
 * the two cannot drift apart on what the derived field looks like.
 */
function derivedField(spec: DeriveSpec): Field {
  return { name: spec.field, type: spec.fieldType, nullable: true };
}

export function createDeriveTransform(maxExpressionDepth: number): Transform<DeriveSpec> {
  const compile = (spec: DeriveSpec): Expression =>
    normalizeExpression(spec.expression, { maxDepth: maxExpressionDepth, path: ["expression"] });

  return {
    execute(dataset: Dataset, spec: DeriveSpec, context): Dataset {
      // Compiled once per execution, not per row.
      const expression = compile(spec);
      const rows = dataset.rows.map((row) => {
        const next = emptyRow();
        for (const field of dataset.fields) setCell(next, field.name, row[field.name]);
        const value = evaluateExpression(expression, { row, parameters: context.parameters });
        setCell(next, spec.field, value ?? null);
        return next;
      });
      // dataset.fields must gain the derived column too — execute()'s rows
      // and describe()'s projected schema have to agree on what fields exist,
      // or prepare() validates downstream stages against a schema execute()
      // does not actually produce. (SPEC.md §64, §89)
      return { ...dataset, fields: [...dataset.fields, derivedField(spec)], rows };
    },

    describe(fields: readonly Field[], spec: DeriveSpec): readonly Field[] {
      return [...fields, derivedField(spec)];
    },

    validate(spec: DeriveSpec, fields: readonly Field[] | undefined): readonly QSpecIssue[] {
      if (spec === null || typeof spec !== "object" || !("field" in spec) || spec.field === "") {
        return [issue("`derive` requires a non-empty `field` name.", ["field"])];
      }
      if (typeof spec.field !== "string") {
        return [issue("`derive.field` must be a string.", ["field"])];
      }

      if (!("fieldType" in spec) || spec.fieldType === undefined) {
        return [issue("`derive` requires a `fieldType`.", ["fieldType"])];
      }

      // FIELD_TYPES is imported from @qspecs/core, not hand-copied here — a
      // second literal list would drift the moment core adds a field type,
      // producing exactly the kind of skew this project keeps correcting.
      if (!FIELD_TYPES.includes(spec.fieldType)) {
        return [
          issue(
            `Unknown field type ${JSON.stringify(spec.fieldType)}. ` +
              `Supported types: ${FIELD_TYPES.join(", ")}.`,
            ["fieldType"],
            suggest(String(spec.fieldType), [...FIELD_TYPES]),
          ),
        ];
      }

      if (!("expression" in spec) || spec.expression === undefined) {
        return [issue("`derive` requires an `expression`.", ["expression"])];
      }

      let expression: Expression;
      try {
        expression = compile(spec);
      } catch (error) {
        // normalizeExpression reports precise paths already; surface them
        // rather than flattening to a single message.
        if (error instanceof LimitExceededError) {
          return [issue(error.message, ["expression"])];
        }
        if (error instanceof ManifestValidationError) {
          return error.issues;
        }
        return [issue(error instanceof Error ? error.message : String(error), ["expression"])];
      }

      const issues: QSpecIssue[] = [];

      if (fields === undefined) return issues;

      const known = fields.map((field) => field.name);
      const knownSet = new Set(known);

      if (knownSet.has(spec.field)) {
        issues.push(
          issue(
            `Field "${spec.field}" already exists; \`derive\` cannot overwrite an existing field.`,
            ["field"],
          ),
        );
      }

      const referenced = new Set<string>();
      referencedFields(expression, referenced);

      for (const name of referenced) {
        if (!knownSet.has(name)) {
          issues.push(unknownFieldIssue(name, known, ["expression"]));
        }
      }

      return issues;
    },
  };
}
