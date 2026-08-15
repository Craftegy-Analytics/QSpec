import type { QSpecIssue } from "../errors.js";
import type { JsonValue } from "../json.js";
import type { Dataset, Field, FieldType, RawQueryResult } from "./dataset.js";
import type { HookRegistry, QSpecLogger } from "./events.js";
import type { PresentationDefinition, PresentationType } from "./presentation.js";
import type { QueryDefinition } from "./query.js";
import type { QSpecResourceSpec } from "./manifest.js";
import type { Registry } from "./registry.js";
import type { QSpecLimits } from "./runtime.js";

export interface DataSourceContext {
  readonly executionId: string;
  readonly signal?: AbortSignal | undefined;
  readonly locale?: string | undefined;
  readonly timezone?: string | undefined;
  readonly logger: QSpecLogger;
}

/** Connectivity and native execution only; never decides presentation. (SPEC.md §62) */
export interface DataSource<TCompiledQuery = unknown> {
  execute(query: TCompiledQuery, context: DataSourceContext): Promise<RawQueryResult>;
  /** Optional cleanup, called by `QSpec.dispose()`. */
  dispose?(): Promise<void> | void;
  /**
   * Query languages this source can execute. When present, `prepare()` rejects
   * a manifest pairing this source with any other language, so the mismatch
   * fails with a clear message instead of deep inside the adapter.
   *
   * Optional and additive: a source that omits it accepts any language, which
   * is the behavior every existing source had before this field existed. An
   * empty array is not the same as omitting it: it means the source executes
   * no language at all, so every request is rejected.
   */
  readonly supportedLanguages?: readonly string[];
}

export interface QueryCompileContext {
  readonly source: string;
  /** Bindings already resolved against validated parameters. */
  readonly bindings: Record<string, JsonValue>;
  readonly parameters: Record<string, JsonValue>;
}

/** Compiles a portable query declaration into something a data source can run. (SPEC.md §63) */
export interface QueryLanguage<TStatement = unknown, TCompiledQuery = unknown> {
  compile(
    query: QueryDefinition<TStatement>,
    context: QueryCompileContext,
  ): Promise<TCompiledQuery> | TCompiledQuery;
  /**
   * Static checks run during prepare(), before any database is touched.
   * Return issues to report several problems at once, or throw to reject with
   * one. Issue paths are relative to `spec.query`. (SPEC.md §81)
   */
  validate?(query: QueryDefinition<TStatement>): void | readonly QSpecIssue[];
}

export interface TransformContext {
  readonly executionId: string;
  readonly parameters: Record<string, JsonValue>;
  readonly signal?: AbortSignal | undefined;
}

/** Transforms must not mutate their input dataset. (SPEC.md §64) */
export interface Transform<TSpec = unknown> {
  execute(dataset: Dataset, spec: TSpec, context: TransformContext): Promise<Dataset> | Dataset;
  /**
   * Static schema inference: given the fields entering this transform, returns
   * the fields leaving it. Omitting this makes the transform schema-opaque and
   * stops static presentation validation at this point. (design §2.5)
   */
  describe?(fields: readonly Field[], spec: TSpec): readonly Field[];
  /**
   * Static validation of the transform's own declaration. Return issues to
   * report several problems at once, or throw to reject with one. Issue paths
   * are relative to this transform's entry in `spec.transforms`.
   */
  validate?(spec: TSpec, fields: readonly Field[] | undefined): void | readonly QSpecIssue[];
}

/** Semantic types annotate meaning without changing storage type. (SPEC.md §39) */
export interface SemanticType {
  readonly baseTypes?: readonly FieldType[];
  readonly description?: string;
}

export interface ResourceKindContext {
  readonly presentations: Registry<PresentationType>;
}

/** A registry-driven `kind`. (SPEC.md §24) */
export interface ResourceKind {
  readonly requiresQuery?: boolean;
  readonly requiresPresentation?: boolean;
  /**
   * Static validation of the whole spec. Return issues to report several
   * problems at once, or throw to reject with one. Issue paths are relative to
   * `spec`.
   */
  validate?(spec: QSpecResourceSpec, context: ResourceKindContext): void | readonly QSpecIssue[];
}

export interface RenderContext {
  readonly locale?: string | undefined;
  readonly timezone?: string | undefined;
}

/** Rendering sits entirely outside query execution. (SPEC.md §65) */
export interface Renderer<TPresentation = PresentationDefinition, TOutput = unknown> {
  render(dataset: Dataset, presentation: TPresentation, context: RenderContext): TOutput;
}

/**
 * The capability surface handed to every plugin. (SPEC.md §50)
 *
 * `hooks` deliberately exposes only `on`: plugins observe lifecycle events,
 * they never emit them. (SPEC.md §68)
 */
export interface QSpecPluginAPI {
  readonly queryLanguages: Registry<QueryLanguage>;
  readonly sources: Registry<DataSource>;
  readonly transforms: Registry<Transform>;
  readonly semanticTypes: Registry<SemanticType>;
  readonly resources: Registry<ResourceKind>;
  readonly presentations: Registry<PresentationType>;
  readonly renderers: Registry<Renderer>;
  readonly hooks: { readonly on: HookRegistry["on"] };
  readonly logger: QSpecLogger;
  readonly limits: Readonly<QSpecLimits>;
}

export interface QSpecPlugin {
  readonly name: string;
  readonly version?: string;
  setup(api: QSpecPluginAPI): void | Promise<void>;
}
