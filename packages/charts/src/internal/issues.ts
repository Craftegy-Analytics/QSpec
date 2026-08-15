import type { PathSegment, QSpecIssue } from "@qspecs/core";

/**
 * Presentation validation issues use the code core uses for manifest defects,
 * and paths RELATIVE to `spec.presentation` — core prefixes the absolute
 * location. Duplicated from @qspecs/transforms's internal helper of the same
 * shape rather than shared, so the two plugin packages stay independent.
 */
export function issue(message: string, path: readonly PathSegment[]): QSpecIssue {
  return {
    code: "QSPEC_MANIFEST_INVALID",
    message,
    path,
  };
}
