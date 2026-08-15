import { QSpecError, type PathSegment, type QSpecIssue } from "../errors.js";

/**
 * Rebases plugin-reported issue paths onto the absolute manifest path.
 *
 * A plugin's `validate` hook is handed one node and reports paths relative to
 * it — the same convention `PresentationType.fieldReferences` already uses — so
 * a transform plugin says `["from"]` and core turns that into
 * `spec.transforms[0].from`. An issue with an empty path lands on the node
 * itself, which is what a whole-node complaint should point at.
 */
export function rebaseIssues(
  issues: readonly QSpecIssue[],
  base: readonly PathSegment[],
): readonly QSpecIssue[] {
  return issues.map((issue) => ({ ...issue, path: [...base, ...issue.path] }));
}

/**
 * The `issues` array carried by an aggregate QSpecError, or undefined for every
 * other throw. Lets a caller that catches a plugin's throw keep all the
 * problems the plugin reported instead of flattening them to one `.message`.
 */
export function issuesOf(error: unknown): readonly QSpecIssue[] | undefined {
  if (!(error instanceof QSpecError) || !("issues" in error)) return undefined;
  const issues: unknown = error.issues;
  return Array.isArray(issues) ? (issues as readonly QSpecIssue[]) : undefined;
}
