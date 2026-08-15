import { PluginRegistrationError, QSpecError } from "../errors.js";
import type { HookRegistry, QSpecLogger } from "../types/events.js";
import type { PresentationType } from "../types/presentation.js";
import type { Registry } from "../types/registry.js";
import type {
  DataSource,
  QSpecPlugin,
  QSpecPluginAPI,
  QueryLanguage,
  Renderer,
  ResourceKind,
  SemanticType,
  Transform,
} from "../types/plugin.js";
import {
  DEFAULT_LIMITS,
  type ExecutionContext,
  type PreparedResource,
  type QSpec,
  type QSpecLimits,
  type QSpecOptions,
  type QSpecResult,
} from "../types/runtime.js";
import { createHooks } from "./hooks.js";
import { createRegistry } from "./registry.js";
import { prepareResource } from "./prepare.js";

/** Everything the prepare/execute pipelines need from the runtime. */
export interface RuntimeInternals {
  readonly registries: {
    readonly queryLanguages: Registry<QueryLanguage>;
    readonly sources: Registry<DataSource>;
    readonly transforms: Registry<Transform>;
    readonly semanticTypes: Registry<SemanticType>;
    readonly resources: Registry<ResourceKind>;
    readonly presentations: Registry<PresentationType>;
    readonly renderers: Registry<Renderer>;
  };
  readonly hooks: HookRegistry;
  readonly limits: QSpecLimits;
  readonly logger: QSpecLogger;
}

export function createQSpec(options: QSpecOptions = {}): QSpec {
  const limits: QSpecLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const logger: QSpecLogger = options.logger ?? {};
  const hooks = createHooks((error) => {
    logger.warn?.("A QSpec lifecycle handler threw and was ignored.", error);
  });

  const registries = {
    queryLanguages: createRegistry<QueryLanguage>("query language"),
    sources: createRegistry<DataSource>("data source"),
    transforms: createRegistry<Transform>("transform"),
    semanticTypes: createRegistry<SemanticType>("semantic type"),
    resources: createRegistry<ResourceKind>("resource kind"),
    presentations: createRegistry<PresentationType>("presentation type"),
    renderers: createRegistry<Renderer>("renderer"),
  };

  // The one kind core owns: a resource with no presentation. Chart, Table,
  // Metric and Dashboard are supplied by downstream packages. (SPEC.md §24)
  registries.resources.register("Dataset", { requiresPresentation: false });

  const internals: RuntimeInternals = { registries, hooks, limits, logger };

  const pluginApi: QSpecPluginAPI = {
    queryLanguages: registries.queryLanguages,
    sources: registries.sources,
    transforms: registries.transforms,
    semanticTypes: registries.semanticTypes,
    resources: registries.resources,
    presentations: registries.presentations,
    renderers: registries.renderers,
    hooks: { on: hooks.on },
    logger,
    limits,
  };

  const queued: QSpecPlugin[] = [];
  const installed = new Set<string>();

  /** Memoized in-flight drain, so concurrent ready() calls share one pass. */
  let draining: Promise<void> | undefined;
  /**
   * A setup failure poisons the runtime: the capability registries are now in a
   * half-built state, so every later ready() re-throws the original error. The
   * error is stored rather than kept as a rejected promise, because a rejected
   * promise nobody is awaiting yet triggers an unhandled-rejection report.
   */
  let failure: { readonly error: unknown } | undefined;

  async function drain(): Promise<void> {
    // shift() is typed `T | undefined` under every strictness setting, so the
    // loop reads the value once and guards it rather than asserting on length.
    for (let plugin = queued.shift(); plugin !== undefined; plugin = queued.shift()) {
      if (installed.has(plugin.name)) {
        throw new PluginRegistrationError(`Plugin "${plugin.name}" is already installed.`, {
          plugin: plugin.name,
        });
      }
      installed.add(plugin.name);
      try {
        await plugin.setup(pluginApi);
      } catch (error) {
        if (error instanceof QSpecError) throw error;
        throw new PluginRegistrationError(
          `Plugin "${plugin.name}" failed during setup: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { plugin: plugin.name },
        );
      }
    }
  }

  const qspec: QSpec = {
    limits,
    on: hooks.on,

    use(plugin) {
      // Only queues. Clearing `draining` here would let a use() that lands
      // during an in-flight ready() start a second, concurrent drain, and
      // setups would then overlap and complete out of registration order.
      // An in-flight drain picks new arrivals up on its own, because it
      // re-reads the queue after every setup.
      queued.push(plugin);
      return qspec;
    },

    async ready() {
      if (failure !== undefined) throw failure.error;
      // Loops rather than memoizing one promise: a plugin queued while a drain
      // was in flight must still be awaited, and at most one drain may run at
      // a time. The `draining !== undefined` arm covers the window where the
      // queue is already empty but the last setup has not finished.
      while (queued.length > 0 || draining !== undefined) {
        const current =
          draining ??
          (draining = drain().finally(() => {
            draining = undefined;
          }));
        try {
          await current;
        } catch (error) {
          failure = { error };
          throw error;
        }
      }
    },

    async prepare(manifest): Promise<PreparedResource> {
      await qspec.ready();
      return prepareResource(manifest, internals);
    },

    async execute(manifest, context?: ExecutionContext): Promise<QSpecResult> {
      const prepared = await qspec.prepare(manifest);
      return prepared.execute(context);
    },

    async dispose() {
      for (const name of registries.sources.list()) {
        const source = registries.sources.get(name);
        await source?.dispose?.();
      }
    },
  };

  return qspec;
}
