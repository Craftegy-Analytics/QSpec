import type { Dataset } from "./dataset.js";
import type { HookRegistry, QSpecLogger } from "./events.js";
import type { QSpecManifest, QSpecResourceSpec } from "./manifest.js";
import type { PresentationDefinition } from "./presentation.js";
import type { QSpecPlugin } from "./plugin.js";

/** Host-enforceable execution limits. (SPEC.md §72.5) */
export interface QSpecLimits {
  readonly maxRows: number;
  readonly maxTransforms: number;
  /**
   * Cap on the size of a manifest supplied **as a JSON string**, in UTF-8
   * bytes. It does not apply when a manifest is handed in already parsed: see
   * `ParseManifestOptions.maxBytes` for why.
   */
  readonly maxManifestBytes: number;
  readonly maxExpressionDepth: number;
  /** Wall-clock cap per query, in milliseconds. `undefined` means no timeout. */
  readonly queryTimeoutMs: number | undefined;
}

export const DEFAULT_LIMITS: QSpecLimits = {
  maxRows: 1_000_000,
  maxTransforms: 64,
  maxManifestBytes: 1_048_576,
  maxExpressionDepth: 32,
  queryTimeoutMs: undefined,
};

export interface QSpecOptions {
  readonly limits?: Partial<QSpecLimits>;
  /** Quiet by default. (SPEC.md §85) */
  readonly logger?: QSpecLogger;
}

/** Per-execution inputs. (SPEC.md §59) */
export interface ExecutionContext {
  readonly parameters?: Record<string, unknown>;
  readonly signal?: AbortSignal;
  readonly locale?: string;
  readonly timezone?: string;
  readonly metadata?: Record<string, unknown>;
}

/** Never includes credentials or bound values. (SPEC.md §61, §72.6) */
export interface ExecutionMetadata {
  readonly executionId: string;
  readonly durationMs: number;
  readonly rowCount: number;
  readonly query?: {
    readonly source: string;
    readonly language: string;
    readonly durationMs?: number;
  };
}

export interface QSpecResult {
  readonly data: Dataset;
  readonly presentation?: PresentationDefinition;
  readonly meta: ExecutionMetadata;
}

export interface PreparedResource {
  readonly manifest: QSpecManifest<QSpecResourceSpec>;
  readonly kind: string;
  readonly name: string;
  /** Field names projected to exist after transforms, or undefined if not statically known. */
  readonly projectedFields: readonly string[] | undefined;
  execute(context?: ExecutionContext): Promise<QSpecResult>;
}

export interface QSpec {
  /** Queues a plugin and returns the runtime for chaining. (SPEC.md §52) */
  use(plugin: QSpecPlugin): QSpec;
  /** Awaits any queued plugin setups. Called implicitly by prepare/execute. */
  ready(): Promise<void>;
  prepare(manifest: QSpecManifest<QSpecResourceSpec> | string | unknown): Promise<PreparedResource>;
  execute(
    manifest: QSpecManifest<QSpecResourceSpec> | string | unknown,
    context?: ExecutionContext,
  ): Promise<QSpecResult>;
  /** Subscribe to lifecycle events. (SPEC.md §68) */
  on: HookRegistry["on"];
  /** Disposes every registered data source that declares a `dispose` method. */
  dispose(): Promise<void>;
  readonly limits: QSpecLimits;
}
