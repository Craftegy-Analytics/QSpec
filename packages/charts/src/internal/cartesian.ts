import type {
  FieldReference,
  PresentationType,
  PresentationValidationContext,
  QSpecIssue,
} from "@qspecs/core";
import type { CartesianPresentation } from "../types.js";
import { isNonEmptyString, isPlainObject } from "./guards.js";
import { issue } from "./issues.js";
import { validateDisplayBlock, validateOptionalLabel } from "./shared-validation.js";

/**
 * `definition` arrives typed as `CartesianPresentation`, but it is really an
 * unchecked `PresentationDefinition` at this point — validating its shape is
 * this function's entire job, so every access is defensive rather than
 * trusting the static type.
 */
function validateCartesian(definition: CartesianPresentation): readonly QSpecIssue[] {
  const issues: QSpecIssue[] = [];

  const x: unknown = definition.x;
  if (!isPlainObject(x)) {
    issues.push(issue("`x` is required and must be an object with a `field`.", ["x"]));
  } else if (!isNonEmptyString(x.field)) {
    issues.push(issue("`x.field` must be a non-empty string.", ["x", "field"]));
  }
  issues.push(...validateOptionalLabel(x, ["x"]));

  const series: unknown = definition.series;
  if (Array.isArray(series)) {
    if (series.length === 0) {
      issues.push(issue("`series` must contain at least one entry.", ["series"]));
    } else {
      // Duplicate `field` is rejected for the same reason `select` rejects a
      // duplicate selection: two entries keyed alike collapse into one identity.
      // `ResolvedSeries.key` is the field name for explicit series, and React
      // renderers use it as a list key — duplicates there corrupt the render
      // silently rather than failing.
      const seen = new Set<string>();
      series.forEach((entry: unknown, index) => {
        if (!isPlainObject(entry) || !isNonEmptyString(entry.field)) {
          issues.push(
            issue(`\`series[${index}].field\` must be a non-empty string.`, [
              "series",
              index,
              "field",
            ]),
          );
          return;
        }
        if (seen.has(entry.field)) {
          issues.push(
            issue(`Field "${entry.field}" is plotted as a series more than once.`, [
              "series",
              index,
              "field",
            ]),
          );
        }
        seen.add(entry.field);
        issues.push(...validateOptionalLabel(entry, ["series", index]));
      });
    }
  } else if (isPlainObject(series)) {
    if (!isNonEmptyString(series.field)) {
      issues.push(issue("`series.field` must be a non-empty string.", ["series", "field"]));
    }
    if (!isNonEmptyString(series.groupBy)) {
      issues.push(issue("`series.groupBy` must be a non-empty string.", ["series", "groupBy"]));
    }
    issues.push(...validateOptionalLabel(series, ["series"]));
  } else {
    issues.push(
      issue(
        "`series` must be an array of series, or a grouped series object with `field` and `groupBy`.",
        ["series"],
      ),
    );
  }

  const y: unknown = definition.y;
  if (y !== undefined) {
    if (!isPlainObject(y)) {
      issues.push(issue("`y` must be an object.", ["y"]));
    } else {
      issues.push(...validateOptionalLabel(y, ["y"]));
    }
  }

  issues.push(...validateDisplayBlock(definition.legend, "legend"));
  issues.push(...validateDisplayBlock(definition.tooltip, "tooltip"));

  return issues;
}

/**
 * Every dataset field this definition can reference. A grouped series reports
 * BOTH `field` (the plotted value) and `groupBy` (the partitioning column) —
 * omitting `groupBy` would let a manifest grouping by a misspelled column pass
 * `prepare()` and only fail, silently producing one bogus series, at render
 * time.
 *
 * Reads are defensive for the same reason `validateCartesian`'s are: this can
 * run against a definition `validate` already rejected, so it must report
 * what it can rather than throw.
 */
function cartesianFieldReferences(definition: CartesianPresentation): readonly FieldReference[] {
  const references: FieldReference[] = [];

  const x: unknown = definition.x;
  if (isPlainObject(x) && isNonEmptyString(x.field)) {
    references.push({ field: x.field, path: ["x", "field"] });
  }

  const series: unknown = definition.series;
  if (Array.isArray(series)) {
    series.forEach((entry: unknown, index) => {
      if (isPlainObject(entry) && isNonEmptyString(entry.field)) {
        references.push({ field: entry.field, path: ["series", index, "field"] });
      }
    });
  } else if (isPlainObject(series)) {
    if (isNonEmptyString(series.field)) {
      references.push({ field: series.field, path: ["series", "field"] });
    }
    if (isNonEmptyString(series.groupBy)) {
      references.push({ field: series.groupBy, path: ["series", "groupBy"] });
    }
  }

  return references;
}

/**
 * Shared validator and field-reference extractor for `line`, `bar`, `area`,
 * and `scatter`. They are registered under four distinct type names because
 * renderers treat them differently, but the shape — an x axis plus one or
 * more series — is identical, so one `PresentationType` backs all four.
 * (SPEC.md §17, §47)
 */
export const cartesianPresentationType: PresentationType<CartesianPresentation> = {
  validate(
    definition: CartesianPresentation,
    _context: PresentationValidationContext,
  ): readonly QSpecIssue[] {
    return validateCartesian(definition);
  },
  fieldReferences(definition: CartesianPresentation): readonly FieldReference[] {
    return cartesianFieldReferences(definition);
  },
};

/**
 * Compile-time proof that `CartesianPresentation` — a `type` alias, not an
 * `interface` — carries `PresentationDefinition`'s implicit index signature.
 * An `interface` here compiles right up until this line, then fails TS2375
 * with an error that does not name the cause. (docs/known-gaps.md)
 */
const _typeAliasCheck: PresentationType = cartesianPresentationType;
void _typeAliasCheck;
