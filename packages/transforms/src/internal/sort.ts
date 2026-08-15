import type { Dataset, Field, QSpecIssue, Transform } from "@qspecs/core";
import { issue, unknownFieldIssue } from "./issues.js";

export interface SortSpec {
  readonly field: string;
  readonly direction?: "asc" | "desc";
}

function isNullish(value: unknown): boolean {
  return value === null || value === undefined;
}

/**
 * Returns a comparison for two same-typed values, or undefined when they are
 * not comparable. Mirrors the expression evaluator's rules so `sort` and
 * `filter` cannot disagree about ordering.
 */
function compare(a: unknown, b: unknown): number | undefined {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  return undefined;
}

export const sortTransform: Transform<SortSpec> = {
  execute(dataset: Dataset, spec: SortSpec): Dataset {
    const descending = spec.direction === "desc";
    // Indexed decorate-sort-undecorate keeps equal keys in their original
    // order. Array.prototype.sort is specified as stable, but the index
    // tiebreak also keeps nulls-last stable, which the null branch below needs.
    const decorated = dataset.rows.map((row, index) => ({ row, index }));

    decorated.sort((left, right) => {
      const a = left.row[spec.field];
      const b = right.row[spec.field];

      // Nulls sort last in BOTH directions: they are absent data, not an
      // extreme value. Reversing them under `desc` would put "no data" first.
      if (isNullish(a) && isNullish(b)) return left.index - right.index;
      if (isNullish(a)) return 1;
      if (isNullish(b)) return -1;

      const result = compare(a, b);
      if (result === undefined || result === 0) return left.index - right.index;
      return descending ? -result : result;
    });

    return { ...dataset, rows: decorated.map((entry) => entry.row) };
  },

  describe(fields: readonly Field[]): readonly Field[] {
    return fields;
  },

  validate(spec: SortSpec, fields: readonly Field[] | undefined): readonly QSpecIssue[] {
    const issues: QSpecIssue[] = [];
    if (typeof spec?.field !== "string" || spec.field === "") {
      issues.push(issue("`sort` requires a non-empty `field`.", ["field"]));
    }
    if (spec?.direction !== undefined && spec.direction !== "asc" && spec.direction !== "desc") {
      issues.push(issue('`sort.direction` must be "asc" or "desc".', ["direction"]));
    }
    if (issues.length === 0 && fields !== undefined) {
      const known = fields.map((field) => field.name);
      if (!known.includes(spec.field)) {
        issues.push(unknownFieldIssue(spec.field, known, ["field"]));
      }
    }
    return issues;
  },
};
