import type { Dataset, Field, QSpecIssue, Transform } from "@qspecs/core";
import { issue } from "./issues.js";

export interface LimitSpec {
  readonly count: number;
  /** Rows to skip first. A slice offset, not a cursor. */
  readonly offset?: number;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export const limitTransform: Transform<LimitSpec> = {
  execute(dataset: Dataset, spec: LimitSpec): Dataset {
    const offset = spec.offset ?? 0;
    return { ...dataset, rows: dataset.rows.slice(offset, offset + spec.count) };
  },

  describe(fields: readonly Field[]): readonly Field[] {
    return fields;
  },

  validate(spec: LimitSpec): readonly QSpecIssue[] {
    const issues: QSpecIssue[] = [];
    if (!isNonNegativeInteger(spec?.count)) {
      issues.push(issue("`limit.count` must be a non-negative integer.", ["count"]));
    }
    if (spec?.offset !== undefined && !isNonNegativeInteger(spec.offset)) {
      issues.push(issue("`limit.offset` must be a non-negative integer.", ["offset"]));
    }
    return issues;
  },
};
