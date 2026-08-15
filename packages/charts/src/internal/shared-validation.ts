import { formatPath, type PathSegment, type QSpecIssue } from "@qspecs/core";
import { isPlainObject } from "./guards.js";
import { issue } from "./issues.js";

/**
 * `legend` and `tooltip` are optional presentation-wide display blocks, shared
 * verbatim by the cartesian types and by `pie`. Before this ran, `legend: 42`
 * reached a renderer untouched — and since `@qspecs/charts` renders nothing,
 * rejecting garbage here is the only thing the package can do for these fields.
 */
export function validateDisplayBlock(value: unknown, name: string): readonly QSpecIssue[] {
  if (value === undefined) return [];
  if (!isPlainObject(value)) {
    return [issue(`\`${name}\` must be an object.`, [name])];
  }
  if (value.visible !== undefined && typeof value.visible !== "boolean") {
    return [issue(`\`${name}.visible\` must be a boolean.`, [name, "visible"])];
  }
  return [];
}

/**
 * The optional display `label` carried by axis, series, and `y` specs.
 *
 * A non-object container is not this function's problem — the caller has
 * already reported it — so it yields nothing rather than a second issue for
 * the same defect.
 */
export function validateOptionalLabel(
  container: unknown,
  path: readonly PathSegment[],
): readonly QSpecIssue[] {
  if (!isPlainObject(container)) return [];
  const label: unknown = container.label;
  if (label === undefined || typeof label === "string") return [];
  const labelPath: readonly PathSegment[] = [...path, "label"];
  return [issue(`\`${formatPath(labelPath)}\` must be a string.`, labelPath)];
}
