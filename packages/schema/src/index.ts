import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import schemaDocument from "./schemas/v1/qspec.json" with { type: "json" };

/** Immutable once published. (SPEC.md §76) */
export const QSPEC_V1_SCHEMA_ID = "https://qspec.dev/schemas/v1/qspec.json";

/**
 * The official QSpec v1 JSON Schema document. (SPEC.md §13)
 *
 * Frozen because `validator()` compiles it lazily: without this, mutating the
 * export before the first `validateWithJsonSchema` call would silently change
 * what every later call validates. The freeze is shallow — enough to stop the
 * realistic accident (reassigning a top-level keyword) without walking a large
 * document on every import.
 */
export const qspecV1Schema: Record<string, unknown> = Object.freeze(
  schemaDocument as Record<string, unknown>,
);

export interface SchemaIssue {
  /** Dotted path into the manifest, e.g. `metadata.name`. */
  readonly path: string;
  readonly message: string;
}

export interface SchemaValidationResult {
  readonly valid: boolean;
  readonly errors: readonly SchemaIssue[];
}

// Compiled lazily and cached: recompiling per call is exactly the cost
// SPEC.md §112 says to avoid.
let compiled: ValidateFunction | undefined;

function validator(): ValidateFunction {
  if (compiled === undefined) {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    compiled = ajv.compile(qspecV1Schema);
  }
  return compiled;
}

function toPath(error: ErrorObject): string {
  // Ajv emits "/metadata/name"; QSpec diagnostics use "metadata.name".
  return error.instancePath.replace(/^\//, "").replace(/\//g, ".");
}

/**
 * Validates against the published JSON Schema. This is the editor/CI validator;
 * `@qspecs/core`'s `validateManifestStructure` is the runtime validator, and the
 * conformance test asserts the two never disagree. (design §2.7)
 */
export function validateWithJsonSchema(manifest: unknown): SchemaValidationResult {
  const validate = validator();
  const valid = validate(manifest) as boolean;
  if (valid) return { valid: true, errors: [] };
  return {
    valid: false,
    errors: (validate.errors ?? []).map((error) => ({
      path: toPath(error),
      message: error.message ?? "Schema validation failed.",
    })),
  };
}
