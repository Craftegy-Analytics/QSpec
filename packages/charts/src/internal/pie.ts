import type {
  FieldReference,
  PresentationType,
  PresentationValidationContext,
  QSpecIssue,
} from "@qspecs/core";
import type { PiePresentation } from "../types.js";
import { isNonEmptyString, isPlainObject } from "./guards.js";
import { issue } from "./issues.js";
import { validateDisplayBlock, validateOptionalLabel } from "./shared-validation.js";

/**
 * `definition` arrives typed as `PiePresentation`, but it is really an
 * unchecked `PresentationDefinition` at this point — validating its shape is
 * this function's entire job, so every access is defensive rather than
 * trusting the static type.
 */
function validatePie(definition: PiePresentation): readonly QSpecIssue[] {
  const issues: QSpecIssue[] = [];

  const category: unknown = definition.category;
  if (!isPlainObject(category)) {
    issues.push(
      issue("`category` is required and must be an object with a `field`.", ["category"]),
    );
  } else if (!isNonEmptyString(category.field)) {
    issues.push(issue("`category.field` must be a non-empty string.", ["category", "field"]));
  }
  issues.push(...validateOptionalLabel(category, ["category"]));

  const value: unknown = definition.value;
  if (!isPlainObject(value)) {
    issues.push(issue("`value` is required and must be an object with a `field`.", ["value"]));
  } else if (!isNonEmptyString(value.field)) {
    issues.push(issue("`value.field` must be a non-empty string.", ["value", "field"]));
  }
  issues.push(...validateOptionalLabel(value, ["value"]));

  issues.push(...validateDisplayBlock(definition.legend, "legend"));
  issues.push(...validateDisplayBlock(definition.tooltip, "tooltip"));

  return issues;
}

/**
 * Every dataset field this definition can reference: the category (slice
 * label) field and the value (slice size) field.
 *
 * Reads are defensive for the same reason `validatePie`'s are: core calls this
 * unconditionally, even against a definition `validate` already rejected, so
 * it must report what it can rather than throw.
 */
function pieFieldReferences(definition: PiePresentation): readonly FieldReference[] {
  const references: FieldReference[] = [];

  const category: unknown = definition.category;
  if (isPlainObject(category) && isNonEmptyString(category.field)) {
    references.push({ field: category.field, path: ["category", "field"] });
  }

  const value: unknown = definition.value;
  if (isPlainObject(value) && isNonEmptyString(value.field)) {
    references.push({ field: value.field, path: ["value", "field"] });
  }

  return references;
}

/**
 * Validator and field-reference extractor for `pie`. Unlike the cartesian
 * types, `pie` has no x axis and no dynamic series — one category field and
 * one value field describe the whole chart, so it gets its own
 * `PresentationType` rather than sharing `cartesianPresentationType`.
 * (SPEC.md §17, §47)
 */
export const piePresentationType: PresentationType<PiePresentation> = {
  validate(
    definition: PiePresentation,
    _context: PresentationValidationContext,
  ): readonly QSpecIssue[] {
    return validatePie(definition);
  },
  fieldReferences(definition: PiePresentation): readonly FieldReference[] {
    return pieFieldReferences(definition);
  },
};

/**
 * Compile-time proof that `PiePresentation` — a `type` alias, not an
 * `interface` — carries `PresentationDefinition`'s implicit index signature.
 * An `interface` here compiles right up until this line, then fails TS2375
 * with an error that does not name the cause. (docs/known-gaps.md)
 */
const _typeAliasCheck: PresentationType = piePresentationType;
void _typeAliasCheck;
