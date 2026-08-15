import type { JsonValue } from "../json.js";

/** Standard parameter types. (SPEC.md §28, §96) */
export type ParameterType =
  "string" | "number" | "integer" | "boolean" | "date" | "datetime" | "enum" | "array";

/**
 * Constraints applied after type coercion. (SPEC.md §29, §96)
 * `min`/`max` apply to `number` and `integer`.
 * `minLength`/`maxLength` apply to `string` length and to `array` length.
 */
export interface ParameterValidation {
  readonly min?: number;
  readonly max?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
}

/** Advisory UI hints. The core runtime must never depend on these. (SPEC.md §30) */
export interface ParameterPresentation {
  readonly control?: string;
  readonly label?: string;
  readonly placeholder?: string;
  readonly help?: string;
}

export interface ParameterDefinition {
  readonly type: ParameterType;
  readonly required?: boolean;
  readonly default?: JsonValue;
  readonly description?: string;
  /** Allowed values. Required when `type` is `enum`. (SPEC.md §29) */
  readonly values?: readonly JsonValue[];
  /** Element type. Required when `type` is `array`. */
  readonly items?: { readonly type: Exclude<ParameterType, "array" | "enum"> };
  readonly validation?: ParameterValidation;
  readonly presentation?: ParameterPresentation;
}
