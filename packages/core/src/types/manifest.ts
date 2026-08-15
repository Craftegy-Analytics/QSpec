import type { JsonValue } from "../json.js";
import type { DatasetSchema } from "./dataset.js";
import type { ParameterDefinition } from "./parameters.js";
import type { PresentationDefinition } from "./presentation.js";
import type { QueryDefinition } from "./query.js";

/** Recommended machine-friendly name pattern. (SPEC.md §25) */
export const METADATA_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

export interface ManifestMetadata {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly tags?: readonly string[];
}

/** One entry in `spec.transforms`. (SPEC.md §40) */
export interface TransformDefinition {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface QSpecResourceSpec {
  readonly parameters?: { readonly [name: string]: ParameterDefinition };
  readonly query?: QueryDefinition;
  readonly dataset?: DatasetSchema;
  readonly transforms?: readonly TransformDefinition[];
  readonly presentation?: PresentationDefinition;
  readonly [key: string]: JsonValue | unknown;
}

/** The top-level QSpec resource structure. (SPEC.md §21) */
export interface QSpecManifest<TSpec = QSpecResourceSpec> {
  readonly $schema?: string;
  readonly apiVersion: string;
  readonly kind: string;
  readonly metadata: ManifestMetadata;
  readonly spec: TSpec;
}
