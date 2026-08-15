import { suggest, type PathSegment, type QSpecIssue } from "@qspecs/core";

/**
 * Transform validation issues use the code core uses for manifest defects, and
 * paths RELATIVE to this transform's entry in `spec.transforms` — core prefixes
 * the absolute location.
 */
export function issue(
  message: string,
  path: readonly PathSegment[],
  suggestion?: string,
): QSpecIssue {
  return {
    code: "QSPEC_MANIFEST_INVALID",
    message,
    path,
    ...(suggestion === undefined ? {} : { suggestion }),
  };
}

/**
 * The one "you referenced a column that isn't there" issue, shared by all five
 * transforms that can raise it (`select`, `filter`, `derive`, `rename`, `sort`).
 *
 * It was copy-pasted five times before: five copies means five chances for the
 * wording, the `(none)` fallback, or the did-you-mean hint to diverge between
 * transforms that should be indistinguishable to a user.
 *
 * The hint itself comes from core's `suggest`, which this package used to
 * reimplement line for line — same Levenshtein, same length-scaled threshold,
 * same sorted tie-break — back when `@qspecs/core` did not export it. It does
 * now, precisely so out-of-core plugins stop copying it.
 */
export function unknownFieldIssue(
  name: string,
  known: readonly string[],
  path: readonly PathSegment[],
): QSpecIssue {
  return issue(
    `Unknown dataset field "${name}". Available fields: ${known.join(", ") || "(none)"}.`,
    path,
    suggest(name, known),
  );
}
