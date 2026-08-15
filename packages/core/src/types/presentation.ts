import type { PathSegment, QSpecIssue } from "../errors.js";
import type { Field } from "./dataset.js";

/**
 * Core treats presentation generically: it knows the `type` discriminator and
 * the `x-<vendor>` extension convention, and nothing else. Concrete shapes live
 * in packages such as @qspecs/charts. (SPEC.md §12, §44, §48)
 */
export interface PresentationDefinition {
  readonly type: string;
  readonly [key: string]: unknown;
}

/** A dataset field reference found inside a presentation definition. */
export interface FieldReference {
  /** The referenced field name. */
  readonly field: string;
  /** Where the reference sits, relative to `spec.presentation`. */
  readonly path: readonly PathSegment[];
}

export interface PresentationValidationContext {
  /** Fields projected to exist after the transform pipeline, or undefined if unknown. */
  readonly fields: readonly Field[] | undefined;
}

/**
 * Registered by presentation plugins. (SPEC.md §50)
 *
 * `validate` and `fieldReferences` use method syntax, matching `Transform`,
 * `QueryLanguage`, and `DataSource`. Declared as readonly properties they would
 * be checked contravariantly under `strictFunctionTypes`, so
 * `PresentationType<BarChart>` would not be assignable to `PresentationType`
 * and every typed plugin would need a cast to register.
 */
export interface PresentationType<TDefinition = PresentationDefinition> {
  /**
   * Structural checks specific to this presentation type. Return issues to
   * report several problems at once, or throw to reject with one.
   */
  validate?(
    definition: TDefinition,
    context: PresentationValidationContext,
  ): void | readonly QSpecIssue[];
  /**
   * Every dataset field this definition references. Core uses these to run
   * validation stage 6 with "did you mean" suggestions. (SPEC.md §80, §86)
   */
  fieldReferences?(definition: TDefinition): readonly FieldReference[];
}
