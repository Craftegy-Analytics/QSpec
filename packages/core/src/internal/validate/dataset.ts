import { DatasetValidationError, type QSpecIssue } from "../../errors.js";
import type { Dataset, DatasetSchema, FieldType } from "../../types/dataset.js";
import { suggest } from "../suggest.js";

export interface ValidateDatasetOptions {
  /** Upper bound on reported issues, so a wrong query cannot produce a million errors. */
  readonly maxIssues?: number;
}

const DEFAULT_MAX_ISSUES = 50;

/** `integer` satisfies a declared `number`; nothing else widens. */
function typeSatisfies(actual: FieldType, declared: FieldType): boolean {
  if (actual === declared) return true;
  return declared === "number" && actual === "integer";
}

/**
 * Validation stage 5. Undeclared fields are permitted: `spec.dataset` is a
 * contract on the fields a manifest depends on, not an exhaustive list.
 * (SPEC.md §37, §80)
 */
export function validateDataset(
  dataset: Dataset,
  schema: DatasetSchema | undefined,
  options: ValidateDatasetOptions = {},
): QSpecIssue[] {
  if (schema === undefined) return [];

  const maxIssues = options.maxIssues ?? DEFAULT_MAX_ISSUES;
  const issues: QSpecIssue[] = [];
  const actualNames = dataset.fields.map((field) => field.name);
  const byName = new Map(dataset.fields.map((field) => [field.name, field]));

  for (const [name, definition] of Object.entries(schema.fields)) {
    const field = byName.get(name);
    if (field === undefined) {
      const hint = suggest(name, actualNames);
      issues.push({
        code: "QSPEC_DATASET_INVALID",
        message:
          `Declared field "${name}" is not present in the query result. ` +
          `Result fields: ${actualNames.length === 0 ? "(none)" : actualNames.join(", ")}.`,
        path: ["spec", "dataset", "fields", name],
        ...(hint === undefined ? {} : { suggestion: hint }),
      });
      continue;
    }
    if (!typeSatisfies(field.type, definition.type)) {
      issues.push({
        code: "QSPEC_DATASET_INVALID",
        message: `Field "${name}" is declared as ${definition.type} but the result is ${field.type}.`,
        path: ["spec", "dataset", "fields", name, "type"],
      });
    }
  }

  const nonNullable = Object.entries(schema.fields)
    .filter(([, definition]) => definition.nullable === false)
    .map(([name]) => name);

  if (nonNullable.length > 0) {
    // `dataset.rows.entries()` yields each row already narrowed to its
    // element type, so no indexed access (and no cast stripping the
    // `noUncheckedIndexedAccess`-added `| undefined`) is needed to read it.
    outer: for (const [index, row] of dataset.rows.entries()) {
      if (issues.length >= maxIssues) break outer;
      for (const name of nonNullable) {
        if (!byName.has(name)) continue;
        const value = row[name];
        if (value === null || value === undefined) {
          issues.push({
            code: "QSPEC_DATASET_INVALID",
            message: `Field "${name}" is declared non-nullable but row ${index} contains null.`,
            path: ["rows", index, name],
          });
          if (issues.length >= maxIssues) break outer;
        }
      }
    }
  }

  return issues.slice(0, maxIssues);
}

export function assertValidDataset(
  dataset: Dataset,
  schema: DatasetSchema | undefined,
  options?: ValidateDatasetOptions,
): void {
  const issues = validateDataset(dataset, schema, options);
  if (issues.length > 0) {
    throw new DatasetValidationError(
      `Query result does not match the declared dataset schema (${issues.length} problem${
        issues.length === 1 ? "" : "s"
      }).`,
      { issues },
    );
  }
}
