import { describe, expect, it, vi } from "vitest";
import {
  DatasetValidationError,
  ParameterValidationError,
  QSpecAbortError,
  QueryExecutionError,
  TransformError,
} from "../errors.js";
import { definePlugin } from "../define.js";
import type { Dataset, RawQueryResult } from "../types/dataset.js";
import type { DataSourceContext, Transform } from "../types/plugin.js";
import { createQSpec } from "./runtime.js";

const rows: RawQueryResult = {
  columns: [{ name: "month" }, { name: "revenue" }],
  rows: [
    ["2026-01-01T00:00:00Z", 10],
    ["2026-02-01T00:00:00Z", 0],
  ],
};

function build(
  options: {
    execute?: (query: unknown, context: DataSourceContext) => Promise<RawQueryResult>;
    limits?: { maxRows?: number; queryTimeoutMs?: number };
  } = {},
) {
  const compile = vi.fn(
    (query: { statement: unknown }, ctx: { bindings: Record<string, unknown> }) => ({
      statement: query.statement,
      bindings: ctx.bindings,
    }),
  );
  const execute = options.execute ?? (async () => rows);

  const qspec = createQSpec(options.limits ? { limits: options.limits } : {}).use(
    definePlugin({
      name: "test",
      setup(api) {
        api.resources.register("Chart", { requiresQuery: true, requiresPresentation: true });
        api.queryLanguages.register("sql", { compile });
        api.sources.register("analytics", { execute });
        api.presentations.register("line", {});
        api.transforms.register("drop-zero", {
          execute: (dataset): Dataset => ({
            ...dataset,
            rows: dataset.rows.filter((row) => row["revenue"] !== 0),
          }),
          describe: (fields) => fields,
        });
      },
    }),
  );
  return { qspec, compile };
}

/**
 * An adapter that never settles on its own and reports when it has started, so
 * a test can abort while the query is genuinely in flight rather than before
 * the pipeline has reached it.
 */
function blockingAdapter() {
  let markStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const adapter = (_query: unknown, context: DataSourceContext): Promise<RawQueryResult> =>
    new Promise<RawQueryResult>((_resolve, reject) => {
      context.signal?.addEventListener("abort", () => {
        reject(new DOMException("Aborted", "AbortError"));
      });
      markStarted();
    });
  return { started, adapter };
}

/**
 * Runs a one-transform Chart through the pipeline and returns whatever it
 * threw, or the result if it did not throw. Everything except the transform
 * under test is held constant.
 */
async function runTransform(implementation: Transform, signal?: AbortSignal): Promise<unknown> {
  const qspec = createQSpec().use(
    definePlugin({
      name: "transform-under-test",
      setup(api) {
        api.resources.register("Chart", { requiresQuery: true, requiresPresentation: true });
        api.queryLanguages.register("sql", { compile: (query) => query.statement });
        api.sources.register("analytics", { execute: async () => rows });
        api.presentations.register("line", {});
        api.transforms.register("subject", implementation);
      },
    }),
  );
  return qspec
    .execute(
      { ...manifest, spec: { ...manifest.spec, transforms: [{ type: "subject" }] } },
      {
        parameters: { from: "2026-01-01" },
        ...(signal === undefined ? {} : { signal }),
      },
    )
    .catch((thrown: unknown) => thrown);
}

const manifest = {
  apiVersion: "qspec.dev/v1",
  kind: "Chart",
  metadata: { name: "monthly-revenue" },
  spec: {
    parameters: { from: { type: "date", required: true } },
    query: {
      source: "analytics",
      language: "sql",
      statement: "SELECT 1",
      bindings: { from: "$parameters.from" },
    },
    dataset: { fields: { month: { type: "datetime" }, revenue: { type: "number" } } },
    presentation: { type: "line" },
  },
};

describe("execute", () => {
  it("runs the pipeline and returns a normalized dataset", async () => {
    const { qspec } = build();
    const result = await qspec.execute(manifest, { parameters: { from: "2026-01-01" } });
    expect(result.data.rows).toHaveLength(2);
    expect(result.data.fields.map((f) => f.name)).toEqual(["month", "revenue"]);
    expect(result.presentation).toEqual({ type: "line" });
  });

  it("reports metadata without leaking bound values", async () => {
    const { qspec } = build();
    const result = await qspec.execute(manifest, { parameters: { from: "2026-01-01" } });
    expect(result.meta.rowCount).toBe(2);
    expect(result.meta.query).toMatchObject({ source: "analytics", language: "sql" });
    expect(typeof result.meta.executionId).toBe("string");
    expect(JSON.stringify(result.meta)).not.toContain("2026-01-01");
  });

  it("validates parameters before compiling the query", async () => {
    const { qspec, compile } = build();
    await expect(qspec.execute(manifest, { parameters: {} })).rejects.toThrow(
      ParameterValidationError,
    );
    expect(compile).not.toHaveBeenCalled();
  });

  it("passes resolved bindings to the query compiler", async () => {
    const { qspec, compile } = build();
    await qspec.execute(manifest, { parameters: { from: "2026-01-01" } });
    expect(compile.mock.calls[0]?.[1]).toMatchObject({ bindings: { from: "2026-01-01" } });
  });

  it("runs transforms in declaration order", async () => {
    const { qspec } = build();
    const withTransform = {
      ...manifest,
      spec: { ...manifest.spec, transforms: [{ type: "drop-zero" }] },
    };
    const result = await qspec.execute(withTransform, { parameters: { from: "2026-01-01" } });
    expect(result.data.rows).toHaveLength(1);
    expect(result.meta.rowCount).toBe(1);
  });

  it("does not mutate the dataset a transform received", async () => {
    const seen: { rows: number }[] = [];
    const qspec = createQSpec().use(
      definePlugin({
        name: "observer",
        setup(api) {
          api.resources.register("Chart", { requiresQuery: true, requiresPresentation: true });
          api.queryLanguages.register("sql", { compile: (query) => query.statement });
          api.sources.register("analytics", { execute: async () => rows });
          api.presentations.register("line", {});
          api.transforms.register("drop-zero", {
            execute: (dataset): Dataset => {
              const output = {
                ...dataset,
                rows: dataset.rows.filter((row) => row["revenue"] !== 0),
              };
              // Recorded after building the output: the input must be untouched.
              seen.push({ rows: dataset.rows.length });
              return output;
            },
            describe: (fields) => fields,
          });
        },
      }),
    );
    const result = await qspec.execute(
      { ...manifest, spec: { ...manifest.spec, transforms: [{ type: "drop-zero" }] } },
      { parameters: { from: "2026-01-01" } },
    );
    // The transform still saw both rows; only its return value was filtered.
    expect(seen).toEqual([{ rows: 2 }]);
    expect(result.data.rows).toHaveLength(1);
  });

  it("validates the dataset against the declared schema", async () => {
    const { qspec } = build({
      execute: async () => ({ columns: [{ name: "month" }], rows: [["2026-01-01T00:00:00Z"]] }),
    });
    await expect(qspec.execute(manifest, { parameters: { from: "2026-01-01" } })).rejects.toThrow(
      DatasetValidationError,
    );
  });

  it("wraps an adapter failure in QueryExecutionError with the cause attached", async () => {
    const underlying = new Error("connection refused");
    const { qspec } = build({
      execute: async () => {
        throw underlying;
      },
    });
    try {
      await qspec.execute(manifest, { parameters: { from: "2026-01-01" } });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(QueryExecutionError);
      expect((error as QueryExecutionError).cause).toBe(underlying);
    }
  });

  it("throws QSpecAbortError when the signal is already aborted", async () => {
    const { qspec, compile } = build();
    const controller = new AbortController();
    controller.abort();
    await expect(
      qspec.execute(manifest, { parameters: { from: "2026-01-01" }, signal: controller.signal }),
    ).rejects.toThrow(QSpecAbortError);
    expect(compile).not.toHaveBeenCalled();
  });

  it("propagates the signal to the data source", async () => {
    let received: AbortSignal | undefined;
    const { qspec } = build({
      execute: async (_query, context) => {
        received = context.signal;
        return rows;
      },
    });
    const controller = new AbortController();
    await qspec.execute(manifest, {
      parameters: { from: "2026-01-01" },
      signal: controller.signal,
    });
    // With no timeout configured the caller's signal is passed straight
    // through, so this asserts identity rather than merely "not aborted".
    expect(received).toBe(controller.signal);
  });

  it("hands the adapter a derived signal when a timeout is configured", async () => {
    let received: AbortSignal | undefined;
    const { qspec } = build({
      limits: { queryTimeoutMs: 60_000 },
      execute: async (_query, context) => {
        received = context.signal;
        return rows;
      },
    });
    const controller = new AbortController();
    await qspec.execute(manifest, {
      parameters: { from: "2026-01-01" },
      signal: controller.signal,
    });
    expect(received).toBeDefined();
    expect(received).not.toBe(controller.signal);
    expect(received?.aborted).toBe(false);
  });

  it("wraps a transform failure in TransformError with its cause and path", async () => {
    const boom = new Error("transform exploded");
    const error = await runTransform({
      execute: () => {
        throw boom;
      },
    });
    expect(error).toBeInstanceOf(TransformError);
    expect((error as TransformError).cause).toBe(boom);
    expect((error as TransformError).path).toEqual(["spec", "transforms", 0]);
    // The message must name the failing transform and carry the original text.
    expect((error as TransformError).message).toContain("subject");
    expect((error as TransformError).message).toContain("transform exploded");
  });

  it("passes a QSpecError from a transform through unwrapped", async () => {
    const original = new ParameterValidationError("nope", { issues: [] });
    const error = await runTransform({
      execute: () => {
        throw original;
      },
    });
    expect(error).toBe(original);
  });

  it("reports an abort surfacing through a transform as a cancellation", async () => {
    const controller = new AbortController();
    const error = await runTransform(
      {
        execute: () => {
          // A transform that honours its signal: cancel, then reject the way
          // an aborted async primitive does.
          controller.abort();
          throw new DOMException("Aborted", "AbortError");
        },
      },
      controller.signal,
    );
    // The caller asked for this. Reporting it as a transform defect would
    // blame the plugin for a cancellation the caller requested.
    expect(error).toBeInstanceOf(QSpecAbortError);
    expect(error).not.toBeInstanceOf(TransformError);
  });

  it("aborts when a transform ignores its signal and returns normally", async () => {
    const controller = new AbortController();
    const error = await runTransform(
      {
        execute: (dataset) => {
          controller.abort();
          return dataset; // ignores the signal entirely
        },
      },
      controller.signal,
    );
    expect(error).toBeInstanceOf(QSpecAbortError);
  });

  it("aborts mid-flight when the caller cancels", async () => {
    // The abort must land while the adapter is genuinely in flight. Aborting
    // straight after calling execute() would only reach the pre-flight
    // throwIfAborted, which is already covered by the test above.
    const { started, adapter } = blockingAdapter();
    const { qspec } = build({ execute: adapter });
    const controller = new AbortController();
    const promise = qspec.execute(manifest, {
      parameters: { from: "2026-01-01" },
      signal: controller.signal,
    });
    await started;
    controller.abort();
    await expect(promise).rejects.toThrow(QSpecAbortError);
  });

  it("combines a configured timeout with the caller's own signal", async () => {
    // The timeout is far longer than the test can run, so the caller's signal
    // is the only thing that can possibly cancel this. If withTimeout replaced
    // the caller's signal instead of composing with it, nothing would abort.
    const { started, adapter } = blockingAdapter();
    const { qspec } = build({ limits: { queryTimeoutMs: 60_000 }, execute: adapter });
    const controller = new AbortController();
    const promise = qspec.execute(manifest, {
      parameters: { from: "2026-01-01" },
      signal: controller.signal,
    });
    await started;
    controller.abort();
    await expect(promise).rejects.toThrow(QSpecAbortError);
  });

  it("aborts when an adapter ignores its signal and returns anyway", async () => {
    const controller = new AbortController();
    const { qspec } = build({
      execute: async () => {
        controller.abort();
        return rows;
      },
    });
    await expect(
      qspec.execute(manifest, { parameters: { from: "2026-01-01" }, signal: controller.signal }),
    ).rejects.toThrow(QSpecAbortError);
  });

  it("aborts when the configured query timeout elapses", async () => {
    const { qspec } = build({
      limits: { queryTimeoutMs: 5 },
      execute: (_query, context) =>
        new Promise((_resolve, reject) => {
          context.signal?.addEventListener("abort", () => {
            reject(new Error("cancelled"));
          });
        }),
    });
    await expect(qspec.execute(manifest, { parameters: { from: "2026-01-01" } })).rejects.toThrow(
      QSpecAbortError,
    );
  });

  it("truncates at maxRows", async () => {
    const { qspec } = build({ limits: { maxRows: 1 } });
    const result = await qspec.execute(manifest, { parameters: { from: "2026-01-01" } });
    expect(result.data.rows).toHaveLength(1);
    expect(result.data.metadata?.truncated).toBe(true);
  });

  it("emits execution:complete on success and execution:error on failure", async () => {
    const { qspec } = build();
    const complete = vi.fn();
    const failed = vi.fn();
    qspec.on("execution:complete", complete);
    qspec.on("execution:error", failed);

    await qspec.execute(manifest, { parameters: { from: "2026-01-01" } });
    expect(complete).toHaveBeenCalledOnce();

    await qspec.execute(manifest, { parameters: {} }).catch(() => undefined);
    expect(failed).toHaveBeenCalledOnce();
    expect(failed.mock.calls[0]?.[0]).toMatchObject({ code: "QSPEC_PARAMETER_INVALID" });
  });

  it("emits a duplicate-column event when the adapter returns repeated names", async () => {
    const { qspec } = build({
      execute: async () => ({
        columns: [{ name: "month" }, { name: "revenue" }, { name: "revenue" }],
        rows: [["2026-01-01T00:00:00Z", 1, 2]],
      }),
    });
    const handler = vi.fn();
    qspec.on("dataset:normalize:duplicate-column", handler);
    const bare = { ...manifest, spec: { ...manifest.spec, dataset: undefined } };
    await qspec.execute(bare, { parameters: { from: "2026-01-01" } });
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ original: "revenue", renamed: "revenue_2" }),
    );
  });

  it("supports repeated execution of one prepared resource", async () => {
    const { qspec, compile } = build();
    const prepared = await qspec.prepare(manifest);
    await prepared.execute({ parameters: { from: "2026-01-01" } });
    await prepared.execute({ parameters: { from: "2026-02-01" } });
    expect(compile).toHaveBeenCalledTimes(2);
  });
});
