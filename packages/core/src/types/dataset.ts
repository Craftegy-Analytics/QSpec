import type { JsonObject } from "../json.js";

/** Standard field types. (SPEC.md §38) */
export type FieldType =
  "string" | "number" | "integer" | "boolean" | "date" | "datetime" | "object" | "array";

/**
 * Every valid `FieldType`, as a value. Plugins that construct a `Field` need
 * to validate against this — `@qspecs/transforms`' `derive` is the first. This
 * is the single authoritative list: core's own manifest validator derives its
 * lookup set from it too, so core and its plugins cannot drift about what a
 * field type is.
 */
export const FIELD_TYPES: readonly FieldType[] = [
  "string",
  "number",
  "integer",
  "boolean",
  "date",
  "datetime",
  "object",
  "array",
];

/** A field as declared in a manifest's `spec.dataset.fields`. (SPEC.md §37, §39) */
export interface FieldDefinition {
  readonly type: FieldType;
  readonly nullable?: boolean;
  readonly label?: string;
  /** Semantic meaning; never changes the storage type. (SPEC.md §39) */
  readonly semanticType?: string;
  readonly format?: JsonObject;
}

export interface DatasetSchema {
  readonly fields: { readonly [name: string]: FieldDefinition };
}

/** A field in a materialized dataset. Carries its own name; order is significant. */
export interface Field extends FieldDefinition {
  readonly name: string;
}

/** A dataset row. Always a null-prototype object. (design §2.4) */
export type DatasetRow = Record<string, unknown>;

export interface DatasetMetadata {
  /** True when rows were dropped because `limits.maxRows` was reached. */
  readonly truncated?: boolean;
  readonly [key: string]: unknown;
}

/** The normalized dataset produced by query execution. (SPEC.md §36) */
export interface Dataset {
  readonly fields: readonly Field[];
  readonly rows: readonly DatasetRow[];
  readonly metadata?: DatasetMetadata;
}

export interface RawColumn {
  readonly name: string;
  readonly nativeType?: string;
}

/**
 * What a data source adapter returns. Rows are positional so that duplicate
 * column names and prototype-shaped column names survive normalization, and so
 * columnar backends remain possible. (design §2.4; SPEC.md §62, §113)
 */
export interface RawQueryResult {
  readonly columns: readonly RawColumn[];
  readonly rows: readonly (readonly unknown[])[];
  readonly metadata?: { readonly durationMs?: number; readonly truncated?: boolean };
}
