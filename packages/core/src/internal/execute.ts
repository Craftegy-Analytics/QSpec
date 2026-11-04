import {
  QSpecAbortError,
  QSpecError,
  QueryCompilationError,
  QueryExecutionError,
  TransformError,
} from "../errors.js";
import { deepFreeze } from "../json.js";
import type { Dataset, RawQueryResult } from "../types/dataset.js";
import type { ExecutionPolicyInput, PolicyQuery } from "../types/policy.js";
import type { ExecutionContext, ExecutionMetadata, QSpecResult } from "../types/runtime.js";
import { isAbortLike, throwIfAborted } from "./abort.js";
import { normalizeResult } from "./normalize-result.js";
import { freezeMetadata, runPolicies } from "./policy.js";
import type { PreparedPlan } from "./prepare.js";
import { resolveBindings } from "./bindings.js";
import type { RuntimeInternals } from "./runtime.js";
import { assertValidDataset } from "./validate/dataset.js";
import { validateParameters } from "./validate/parameters.js";

interface ScopedSignal {
  readonly signal: AbortSignal | undefined;
  readonly dispose: () => void;
}

/**
 * Combines a caller-supplied signal with the configured query timeout, so a
 * timeout never discards the caller's own cancellation. (SPEC.md §60, §72.5)
 */
function withTimeout(signal: AbortSignal | undefined, timeoutMs: number | undefined): ScopedSignal {
  if (timeoutMs === undefined) {
    return { signal, dispose: () => {} };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`Query exceeded the ${timeoutMs}ms timeout.`));
  }, timeoutMs);
  const forward = () => {
    controller.abort(signal?.reason);
  };
  if (signal !== undefined) {
    // An already-aborted signal never fires another `abort` event, so the
    // listener alone would silently drop the caller's cancellation.
    if (signal.aborted) forward();
    else signal.addEventListener("abort", forward, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", forward);
    },
  };
}

/**
 * The one input every policy of this execution receives, frozen so no policy can change what the
 * next one sees. Carries no bound value: bindings are descriptions, the view is the language's
 * value-free view, and the manifest holds only what its author declared. (SPEC.md §61, §72.6)
 */
function policyInput(
  plan: PreparedPlan,
  executionId: string,
  metadata: Readonly<Record<string, unknown>> | undefined,
  signal: AbortSignal | undefined,
  query: PolicyQuery | undefined,
): ExecutionPolicyInput {
  return Object.freeze({
    executionId,
    resource: Object.freeze({ kind: plan.kind, name: plan.name }),
    manifest: plan.manifest,
    query: query === undefined ? undefined : Object.freeze(query),
    metadata,
    signal,
  });
}

/** Turns any adapter rejection into a QSpec error, preserving abort semantics. */
function asQueryError(error: unknown, signal: AbortSignal | undefined): QSpecError {
  if (error instanceof QSpecError) return error;
  if (isAbortLike(error, signal)) {
    return new QSpecAbortError("QSpec execution was aborted.", { cause: error });
  }
  return new QueryExecutionError(
    `Data source execution failed: ${error instanceof Error ? error.message : String(error)}`,
    { cause: error },
  );
}

export async function executePrepared(
  plan: PreparedPlan,
  internals: RuntimeInternals,
  context: ExecutionContext,
): Promise<QSpecResult> {
  const { hooks, limits, logger } = internals;
  const executionId = globalThis.crypto.randomUUID();
  const resource = plan.name;
  const startedAt = performance.now();
  const base = { executionId, resource } as const;

  try {
    // Plugin setup first. A PreparedResource outlives the moment it was prepared (`@qspecs/http`
    // caches one per resource for the handler's lifetime), so a policy plugin queued after
    // prepare() must be installed before this execution reads the policy list, and a setup that
    // failed (a policy whose parser did not load) must stop every execution, not only the next
    // prepare(). Throws the stored setup failure; otherwise a no-op once everything is installed.
    await internals.ready();
    // A snapshot, in registration order: the order the policies run in.
    const policies = internals.policies.entries();

    // Before any stage, so a context core cannot accept never reaches stage 3. Never logged,
    // never put in an event, an error or ExecutionMetadata. (SPEC.md §59, §72.6)
    const metadata = freezeMetadata(context.metadata);

    throwIfAborted(context.signal);

    // Stage 3: parameters.
    hooks.emit("validation:start", { stage: "parameters" });
    const parameters = validateParameters(plan.parameters, context.parameters);
    hooks.emit("validation:end", { stage: "parameters", issues: [] });

    let dataset: Dataset = { fields: [], rows: [] };
    let queryDurationMs: number | undefined;

    const query = plan.query;
    if (query !== undefined) {
      const { languageName, sourceName } = query;
      const bindings = resolveBindings(query.bindings, parameters);

      // Stage 4: compile.
      hooks.emit("query:compile:start", { ...base, language: languageName });
      const compileStart = performance.now();
      let compiled: unknown;
      try {
        compiled = await query.language.compile(query.definition, {
          source: sourceName,
          bindings,
          parameters,
        });
      } catch (error) {
        throw error instanceof QSpecError
          ? error
          : new QueryCompilationError(
              `Failed to compile the ${languageName} query: ${
                error instanceof Error ? error.message : String(error)
              }`,
              { cause: error },
            );
      }
      hooks.emit("query:compile:end", {
        ...base,
        language: languageName,
        durationMs: performance.now() - compileStart,
      });

      // Execution policies: after compile, before the source, on a view derived from the very
      // object the source receives. Skipped entirely when none is registered, so a runtime
      // without policies never calls policyView. (SPEC.md §110; policy design 3.2)
      if (policies.length > 0) {
        let view: unknown;
        try {
          view =
            query.language.policyView === undefined
              ? undefined
              : deepFreeze(query.language.policyView(compiled));
        } catch {
          // A language defect at the compile boundary. Unlike a compile throw, nothing the throw
          // carried is kept, not its message and not the error itself as `cause`, and a
          // QSpecError is wrapped rather than passed through: the view is built from a compiled
          // query that holds bound values, so anything thrown from here may contain one.
          throw new QueryCompilationError(
            `Failed to build the policy view of the ${languageName} query.`,
          );
        }
        await runPolicies(
          policies,
          policyInput(plan, executionId, metadata, context.signal, {
            language: languageName,
            source: sourceName,
            bindings: query.policyBindings,
            view,
          }),
          hooks,
        );
      }

      throwIfAborted(context.signal);

      // Execute against the adapter.
      const scoped = withTimeout(context.signal, limits.queryTimeoutMs);
      hooks.emit("query:execute:start", { ...base, source: sourceName, language: languageName });
      const queryStart = performance.now();
      let raw: RawQueryResult;
      try {
        raw = await query.source.execute(compiled, {
          executionId,
          signal: scoped.signal,
          locale: context.locale,
          timezone: context.timezone,
          logger,
          // Omitted rather than `undefined` when absent, so the context keeps its 0.1.0 shape.
          ...(metadata === undefined ? {} : { metadata }),
        });
      } catch (error) {
        throw asQueryError(error, scoped.signal);
      } finally {
        scoped.dispose();
      }
      queryDurationMs = performance.now() - queryStart;

      // An adapter is free to ignore its signal. Without this check a plan
      // with no transforms would resolve with data after being cancelled.
      throwIfAborted(scoped.signal);

      // Normalize.
      const outcome = normalizeResult(raw, {
        schema: plan.datasetSchema,
        maxRows: limits.maxRows,
      });
      dataset = outcome.dataset;
      for (const duplicate of outcome.duplicates) {
        hooks.emit("dataset:normalize:duplicate-column", { ...base, ...duplicate });
      }

      hooks.emit("query:execute:end", {
        ...base,
        source: sourceName,
        language: languageName,
        durationMs: queryDurationMs,
        rowCount: dataset.rows.length,
      });

      // Stage 5: dataset.
      hooks.emit("validation:start", { stage: "dataset" });
      assertValidDataset(dataset, plan.datasetSchema);
      hooks.emit("validation:end", { stage: "dataset", issues: [] });
    } else if (policies.length > 0) {
      // No query, so no data source: policies still decide whether this resource may execute
      // at all, right after stage 3 and before the transforms. (policy design 3.2)
      await runPolicies(
        policies,
        policyInput(plan, executionId, metadata, context.signal, undefined),
        hooks,
      );
    }

    // Transform pipeline. `dataset` is reassigned from each return value, never
    // mutated in place — a transform's input must survive untouched. (SPEC.md §64)
    for (const transform of plan.transforms) {
      throwIfAborted(context.signal);
      hooks.emit("transform:start", { ...base, type: transform.type, index: transform.index });
      const transformStart = performance.now();
      try {
        dataset = await transform.implementation.execute(dataset, transform.spec, {
          executionId,
          parameters,
          signal: context.signal,
        });
      } catch (error) {
        // Wrapped so the failure carries which transform failed and where.
        // A QSpecError from the transform passes through rather than being
        // double-wrapped, matching the compile and adapter boundaries.
        if (error instanceof QSpecError) throw error;
        // Check abort BEFORE wrapping: a cancellation surfacing through a
        // transform is still a cancellation. Wrapping it as TransformError
        // would report a plugin defect for something the caller asked for.
        if (isAbortLike(error, context.signal)) {
          throw new QSpecAbortError("QSpec execution was aborted.", { cause: error });
        }
        throw new TransformError(
          `Transform "${transform.type}" at index ${transform.index} failed: ` +
            `${error instanceof Error ? error.message : String(error)}`,
          { cause: error, path: ["spec", "transforms", transform.index] },
        );
      }
      hooks.emit("transform:end", {
        ...base,
        type: transform.type,
        index: transform.index,
        durationMs: performance.now() - transformStart,
        rowCount: dataset.rows.length,
      });
    }

    // A transform that ignores its signal and returns normally would otherwise
    // let a cancelled execution resolve with data — the same gap closed at the
    // adapter boundary above.
    throwIfAborted(context.signal);

    const durationMs = performance.now() - startedAt;
    hooks.emit("execution:complete", {
      ...base,
      durationMs,
      rowCount: dataset.rows.length,
      success: true,
    });

    // Deliberately excludes bound values, statements and connection details.
    // (SPEC.md §61, §72.6)
    const meta: ExecutionMetadata = {
      executionId,
      durationMs,
      rowCount: dataset.rows.length,
      ...(query === undefined
        ? {}
        : {
            query: {
              source: query.sourceName,
              language: query.languageName,
              ...(queryDurationMs === undefined ? {} : { durationMs: queryDurationMs }),
            },
          }),
    };

    return {
      data: dataset,
      ...(plan.presentation === undefined ? {} : { presentation: plan.presentation }),
      meta,
    };
  } catch (error) {
    hooks.emit("execution:error", {
      ...base,
      durationMs: performance.now() - startedAt,
      code: error instanceof QSpecError ? error.code : "QSPEC_UNKNOWN",
      success: false,
    });
    throw error;
  }
}
