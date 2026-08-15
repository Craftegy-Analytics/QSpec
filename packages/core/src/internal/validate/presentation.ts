import { PresentationError, type PathSegment, type QSpecIssue } from "../../errors.js";
import type { Field } from "../../types/dataset.js";
import type { PresentationDefinition, PresentationType } from "../../types/presentation.js";
import { issuesOf, rebaseIssues } from "../plugin-issues.js";
import { suggest } from "../suggest.js";

/** Plugin-reported presentation issues are relative to this node. */
const PRESENTATION_PATH: readonly PathSegment[] = ["spec", "presentation"];

/**
 * Validation stage 6. `projectedFields` is the field set expected to exist
 * *after* the transform pipeline; when it is undefined the projection could not
 * be computed statically and the check is deferred to runtime.
 * (SPEC.md §80, §86; design §2.5)
 */
export function validatePresentation(
  definition: PresentationDefinition,
  presentationType: PresentationType,
  projectedFields: readonly Field[] | undefined,
): QSpecIssue[] {
  const issues: QSpecIssue[] = [];

  if (presentationType.validate !== undefined) {
    try {
      const reported = presentationType.validate(definition, { fields: projectedFields });
      if (reported !== undefined) issues.push(...rebaseIssues(reported, PRESENTATION_PATH));
    } catch (error) {
      // An aggregate error carries every problem the plugin found; flattening
      // it to `.message` would throw all but the first away.
      const thrown = issuesOf(error);
      if (thrown !== undefined) {
        issues.push(...rebaseIssues(thrown, PRESENTATION_PATH));
      } else {
        issues.push({
          code: "QSPEC_PRESENTATION_INVALID",
          message: error instanceof Error ? error.message : String(error),
          path: [...PRESENTATION_PATH],
        });
      }
    }
  }

  if (projectedFields === undefined || presentationType.fieldReferences === undefined) {
    return issues;
  }

  const known = projectedFields.map((field) => field.name);
  const knownSet = new Set(known);

  for (const reference of presentationType.fieldReferences(definition)) {
    if (knownSet.has(reference.field)) continue;
    const hint = suggest(reference.field, known);
    issues.push({
      code: "QSPEC_PRESENTATION_INVALID",
      message:
        `Unknown dataset field "${reference.field}". ` +
        `Available fields: ${known.length === 0 ? "(none)" : known.join(", ")}.`,
      path: ["spec", "presentation", ...reference.path],
      ...(hint === undefined ? {} : { suggestion: hint }),
    });
  }

  return issues;
}

export function assertValidPresentation(
  definition: PresentationDefinition,
  presentationType: PresentationType,
  projectedFields: readonly Field[] | undefined,
): void {
  const issues = validatePresentation(definition, presentationType, projectedFields);
  if (issues.length > 0) {
    throw new PresentationError(
      `Presentation is invalid (${issues.length} problem${issues.length === 1 ? "" : "s"}).`,
      { issues },
    );
  }
}
