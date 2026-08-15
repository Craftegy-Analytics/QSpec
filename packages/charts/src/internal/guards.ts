/**
 * Shape guards shared by every presentation validator in this package.
 *
 * A presentation `definition` arrives typed (`CartesianPresentation`,
 * `PiePresentation`), but it is really an unchecked `PresentationDefinition` at
 * validation time — checking its shape is the validators' entire job, so every
 * access goes through these rather than trusting the static type.
 *
 * They live here, not next to each validator, because byte-identical copies in
 * `cartesian.ts` and `pie.ts` had already drifted: only `pie.ts` had
 * `isNonEmptyString`, so `x: { field: "" }` passed cartesian validation while
 * `category: { field: "" }` failed pie's. One home, one behaviour.
 */

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
