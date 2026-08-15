import type { Dataset, Field, QSpecIssue, Transform } from "@qspecs/core";
import { issue, unknownFieldIssue } from "./issues.js";
import { emptyRow, setCell } from "./rows.js";

export interface SelectSpec {
  readonly fields: readonly string[];
}

export const selectTransform: Transform<SelectSpec> = {
  execute(dataset: Dataset, spec: SelectSpec): Dataset {
    const byName = new Map(dataset.fields.map((field) => [field.name, field]));
    // Spec order wins: `select` is a projection, and the caller listed the
    // columns in the order they want them.
    const fields = spec.fields
      .map((name) => byName.get(name))
      .filter((field): field is Field => field !== undefined);

    const rows = dataset.rows.map((row) => {
      const next = emptyRow();
      for (const field of fields) setCell(next, field.name, row[field.name]);
      return next;
    });

    return { ...dataset, fields, rows };
  },

  describe(fields: readonly Field[], spec: SelectSpec): readonly Field[] {
    const byName = new Map(fields.map((field) => [field.name, field]));
    return spec.fields
      .map((name) => byName.get(name))
      .filter((field): field is Field => field !== undefined);
  },

  validate(spec: SelectSpec, fields: readonly Field[] | undefined): readonly QSpecIssue[] {
    if (!Array.isArray(spec?.fields) || spec.fields.length === 0) {
      return [issue("`select.fields` must be a non-empty array of field names.", ["fields"])];
    }

    const issues: QSpecIssue[] = [];
    const seen = new Set<string>();
    spec.fields.forEach((name, index) => {
      if (typeof name !== "string" || name === "") {
        issues.push(
          issue("Each entry in `select.fields` must be a non-empty string.", ["fields", index]),
        );
        return;
      }
      if (seen.has(name)) {
        issues.push(issue(`Field "${name}" is selected more than once.`, ["fields", index]));
      }
      seen.add(name);
    });

    if (issues.length === 0 && fields !== undefined) {
      const known = fields.map((field) => field.name);
      const knownSet = new Set(known);
      spec.fields.forEach((name, index) => {
        if (!knownSet.has(name)) {
          issues.push(unknownFieldIssue(name, known, ["fields", index]));
        }
      });
    }

    return issues;
  },
};
