export * from "./errors.js";
export type { JsonObject, JsonPrimitive, JsonValue } from "./json.js";
// isPlainObject and isUnsafeKey are public for the same reason `suggest` is,
// below: @qspecs/http's wire-protocol parser needs to recognize plain objects
// and reject the exact prototype-polluting key names core's own manifest
// parsing rejects, and hand-copying that check would silently drift the
// moment core added a fourth unsafe key. The rest of json.ts — createRow,
// setKey, ownKeys, deepFreeze, and the UNSAFE_KEYS set itself — stays
// internal: those are storage details specific to dataset rows and prepared
// manifests, not something a plugin outside core needs.
export { isPlainObject, isUnsafeKey } from "./json.js";
export type { Registry } from "./types/registry.js";
export { QSPEC_V1, SUPPORTED_API_VERSIONS } from "./version.js";
export {
  defineManifest,
  definePlugin,
  parseManifest,
  type ParseManifestOptions,
} from "./define.js";
export { METADATA_NAME_PATTERN } from "./types/manifest.js";
export type {
  ManifestMetadata,
  QSpecManifest,
  QSpecResourceSpec,
  TransformDefinition,
} from "./types/manifest.js";
export type {
  ParameterDefinition,
  ParameterPresentation,
  ParameterType,
  ParameterValidation,
} from "./types/parameters.js";
export type { Binding, QueryDefinition } from "./types/query.js";
// The expression subsystem is public because plugins outside this package need
// it: @qspecs/transforms' `filter` and `derive` both compile and evaluate
// expressions, and cannot reach src/internal/. `maxDepth` is a required option
// rather than a default so a caller cannot silently bypass SPEC.md §72.5's
// limit — plugins pass `api.limits.maxExpressionDepth`.
export {
  evaluateExpression,
  normalizeExpression,
  type ComparisonShorthand,
  type EvaluationScope,
  type Expression,
  type NormalizeExpressionOptions,
} from "./expressions.js";
// `suggest` is public for the same reason as the expression subsystem above:
// plugins outside this package need "did you mean" hints against their own
// candidate lists (@qspecs/sql's name-coverage checks are the first case) and
// cannot reach src/internal/. `editDistance` stays internal — it is an
// implementation detail of `suggest`, not something a plugin calls directly.
export { suggest } from "./internal/suggest.js";
export { FIELD_TYPES } from "./types/dataset.js";
export type {
  Dataset,
  DatasetMetadata,
  DatasetRow,
  DatasetSchema,
  Field,
  FieldDefinition,
  FieldType,
  RawColumn,
  RawQueryResult,
} from "./types/dataset.js";
export type {
  FieldReference,
  PresentationDefinition,
  PresentationType,
  PresentationValidationContext,
} from "./types/presentation.js";
export { validateManifestStructure } from "./internal/validate/manifest.js";
export type {
  ExecutionEventBase,
  HookRegistry,
  QSpecEventHandler,
  QSpecEventMap,
  QSpecEventName,
  QSpecLogger,
} from "./types/events.js";
export { createQSpec } from "./internal/runtime.js";
export { DEFAULT_LIMITS } from "./types/runtime.js";
export type {
  ExecutionContext,
  ExecutionMetadata,
  PreparedResource,
  QSpec,
  QSpecLimits,
  QSpecOptions,
  QSpecResult,
} from "./types/runtime.js";
export type {
  DataSource,
  DataSourceContext,
  QSpecPlugin,
  QSpecPluginAPI,
  QueryCompileContext,
  QueryLanguage,
  RenderContext,
  Renderer,
  ResourceKind,
  ResourceKindContext,
  SemanticType,
  Transform,
  TransformContext,
} from "./types/plugin.js";
