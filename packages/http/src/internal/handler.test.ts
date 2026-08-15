import { describe, expect, it } from "vitest";
import {
  createQSpec,
  definePlugin,
  QSpecAbortError,
  type DataSource,
  type DataSourceContext,
  type QSpecManifest,
  type QSpecResourceSpec,
  type QueryLanguage,
} from "@qspecs/core";
import { memory } from "@qspecs/testing";
import { createQSpecHandler, type QSpecHandlerOptions } from "./handler.js";
import type { QSpecErrorBody, QSpecExecuteResponse } from "./protocol.js";

/** A minimal `Dataset`-kind manifest querying the memory source's `analytics` table. */
const ORDERS_MANIFEST: QSpecManifest<QSpecResourceSpec> = {
  apiVersion: "qspec.dev/v1",
  kind: "Dataset",
  metadata: { name: "orders" },
  spec: {
    query: { source: "analytics", language: "memory", statement: "analytics" },
  },
};

/** A second, distinct resource so concurrency tests can prove independence. */
const CUSTOMERS_MANIFEST: QSpecManifest<QSpecResourceSpec> = {
  apiVersion: "qspec.dev/v1",
  kind: "Dataset",
  metadata: { name: "customers" },
  spec: {
    query: { source: "customers", language: "memory", statement: "customers" },
  },
};

/** Same shape as ORDERS_MANIFEST, plus one required, typed parameter. */
const PARAMETERIZED_MANIFEST: QSpecManifest<QSpecResourceSpec> = {
  apiVersion: "qspec.dev/v1",
  kind: "Dataset",
  metadata: { name: "orders-by-id" },
  spec: {
    parameters: { id: { type: "number", required: true } },
    query: { source: "analytics", language: "memory", statement: "analytics" },
  },
};

/**
 * A resource whose source has a delay, so an in-flight request can be
 * aborted. Backed by `recordingSlowSourcePlugin`, not `memory()` — the
 * abort-propagation test needs its source to record what it saw, which
 * `memory()`'s source does not expose.
 */
const SLOW_MANIFEST: QSpecManifest<QSpecResourceSpec> = {
  apiVersion: "qspec.dev/v1",
  kind: "Dataset",
  metadata: { name: "slow" },
  spec: {
    query: { source: "slow", language: "slow", statement: "irrelevant" },
  },
};

function buildRuntime() {
  const plugin = memory({
    tables: {
      analytics: { columns: ["month", "revenue"], rows: [["2026-01-01", 10]] },
      customers: { columns: ["id", "name"], rows: [["1", "Ada"]] },
    },
  });
  return { plugin, runtime: createQSpec().use(plugin) };
}

function post(body: unknown, init: RequestInit = {}): Request {
  return new Request("http://handler.test/execute", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...init,
  });
}

/** Parses the response body as `QSpecExecuteResponse`, for assertions. */
async function readBody(response: Response): Promise<QSpecExecuteResponse> {
  return (await response.json()) as QSpecExecuteResponse;
}

/** Narrows a `QSpecExecuteResponse` to its error half, or fails the test. */
function expectError(body: QSpecExecuteResponse): QSpecErrorBody {
  if (body.ok) throw new Error("expected an error response, got ok:true");
  return body.error;
}

/**
 * A data source (and its own single-purpose query language, so it needs no
 * dependency on `memory()`'s internals) whose `execute` always rejects with a
 * driver-shaped error embedding a password — the shape a real Postgres
 * driver error takes. Used to prove a 500 never repeats it.
 */
function failingSourcePlugin(sourceName: string, languageName: string, driverMessage: string) {
  const language: QueryLanguage<unknown, unknown> = {
    compile: (query) => query.statement,
  };
  const source: DataSource = {
    async execute() {
      throw new Error(driverMessage);
    },
  };
  return definePlugin({
    name: `test/failing-source/${sourceName}`,
    setup(api) {
      api.queryLanguages.register(languageName, language);
      api.sources.register(sourceName, source);
    },
  });
}

/**
 * A data source with a configurable delay whose `execute` records whether it
 * OBSERVED the abort itself — either `signal.aborted` already `true` at
 * entry, or an `abort` listener firing mid-delay — on the `observed` object
 * returned alongside the plugin. This lets the abort-propagation test below
 * assert directly on what the source saw, instead of inferring propagation
 * from how quickly the response came back (see that test's doc comment for
 * why elapsed time alone can pass without proving anything).
 *
 * Also exposes `entered`, a promise that resolves the instant `execute()`
 * itself starts running — before the delay/abort-listener setup below, in
 * the same synchronous stretch as `resolveEntered()`. A caller `await`s this
 * instead of racing a fixed delay against `prepare()` + JSON parsing to
 * decide when it is safe to abort, which is what made the caller's own
 * timing-based abort test flaky under slow CI (see that test's doc comment).
 */
function recordingSlowSourcePlugin(sourceName: string, languageName: string, delayMs: number) {
  const language: QueryLanguage<unknown, unknown> = {
    compile: (query) => query.statement,
  };
  const observed = { aborted: false };
  let resolveEntered: () => void;
  const entered = new Promise<void>((resolve) => {
    resolveEntered = resolve;
  });
  const source: DataSource = {
    async execute(_query, context: DataSourceContext) {
      resolveEntered();
      if (context.signal?.aborted === true) {
        observed.aborted = true;
        throw new QSpecAbortError("Recording source aborted before starting.");
      }
      // Captured outside the Promise executor (rather than inline in
      // `addEventListener`) so it can be removed on BOTH paths below —
      // matches @qspecs/testing's memory.ts, which the earlier version of
      // this function did not: `{ once: true }` alone only removes the
      // listener when abort actually fires, so a caller reusing one signal
      // across many executions would otherwise accumulate a listener per
      // completed call.
      let onAbort: (() => void) | undefined;
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, delayMs);
          onAbort = () => {
            observed.aborted = true;
            clearTimeout(timer);
            reject(new QSpecAbortError("Recording source aborted mid-flight."));
          };
          context.signal?.addEventListener("abort", onAbort, { once: true });
        });
      } finally {
        if (onAbort !== undefined) context.signal?.removeEventListener("abort", onAbort);
      }
      return { columns: [{ name: "x" }], rows: [["y"]] };
    },
  };
  const plugin = definePlugin({
    name: `test/recording-slow-source/${sourceName}`,
    setup(api) {
      api.queryLanguages.register(languageName, language);
      api.sources.register(sourceName, source);
    },
  });
  return { plugin, observed, entered };
}

describe("createQSpecHandler", () => {
  it("returns 200 with a result whose data matches the source, for a valid request", async () => {
    const { runtime } = buildRuntime();
    const handler = createQSpecHandler({ runtime, manifests: { orders: ORDERS_MANIFEST } });

    const response = await handler(post({ resource: "orders" }));
    expect(response.status).toBe(200);
    const body = await readBody(response);
    if (!body.ok) throw new Error(`expected ok:true, got error ${body.error.code}`);
    expect(body.result.data.rows).toEqual([{ month: "2026-01-01", revenue: 10 }]);
  });

  it("returns 405 for a GET request", async () => {
    const { runtime } = buildRuntime();
    const handler = createQSpecHandler({ runtime, manifests: { orders: ORDERS_MANIFEST } });

    const response = await handler(new Request("http://handler.test/execute", { method: "GET" }));
    expect(response.status).toBe(405);
    expect(expectError(await readBody(response)).code).toBe("QSPEC_METHOD_NOT_ALLOWED");
  });

  it("returns 400 for a malformed body and never reaches the runtime", async () => {
    const { runtime, plugin } = buildRuntime();
    const handler = createQSpecHandler({ runtime, manifests: { orders: ORDERS_MANIFEST } });

    const response = await handler(post("{not valid json"));
    expect(response.status).toBe(400);
    expect(expectError(await readBody(response)).code).toBe("QSPEC_BAD_REQUEST");
    expect(plugin.calls).toHaveLength(0);

    // Positive control for the assertion above: prove `plugin.calls` actually
    // records something for a request that DOES reach the runtime, so an
    // empty `calls` here is evidence the malformed body was rejected early —
    // not evidence that `calls` silently stopped recording at all (e.g. after
    // a rename), which would make the assertion above pass vacuously.
    const okResponse = await handler(post({ resource: "orders" }));
    expect(okResponse.status).toBe(200);
    expect(plugin.calls.length).toBeGreaterThan(0);
  });

  it("returns 400 for a JSON-valid body a __proto__ parameter makes protocol-invalid, and never reaches the runtime", async () => {
    // Step 2a (`request.json()`) succeeds on this body — it is valid JSON —
    // so this can only be caught by step 2b, `parseExecuteRequest`. Every
    // other 400 test in this file either fails step 2a first (the malformed-
    // body test above) or sends a body `parseExecuteRequest` accepts, so
    // neither exercises this specific call. Falsified by removing the
    // `parseExecuteRequest` call from handler.ts: the unsafe key then flows
    // straight through to `preparedResource.execute`, and this test fails —
    // either a different status/code, or the request reaching the runtime.
    const { runtime, plugin } = buildRuntime();
    const handler = createQSpecHandler({
      runtime,
      manifests: { "orders-by-id": PARAMETERIZED_MANIFEST },
    });

    // Built from a raw JSON string, not an object literal handed to
    // `JSON.stringify`: `{ __proto__: 1 }` as an object-literal key sets the
    // prototype at parse time rather than creating an own property, so
    // `JSON.stringify` would silently drop it and this test would pass
    // vacuously. `JSON.parse` (which `request.json()` uses under the hood)
    // has no such special case — it always creates a real own property.
    const response = await handler(
      post('{"resource":"orders-by-id","parameters":{"__proto__":1,"id":1}}'),
    );
    expect(response.status).toBe(400);
    const error = expectError(await readBody(response));
    expect(error.code).toBe("QSPEC_BAD_REQUEST");
    expect(error.message).toMatch(/"__proto__" is not allowed/);
    expect(plugin.calls).toHaveLength(0);
  });

  it("returns 404 for an unknown resource, without disclosing any registered name", async () => {
    const { runtime } = buildRuntime();
    const handler = createQSpecHandler({
      runtime,
      manifests: { orders: ORDERS_MANIFEST, customers: CUSTOMERS_MANIFEST },
    });

    const response = await handler(post({ resource: "does-not-exist" }));
    expect(response.status).toBe(404);
    const rawText = await response.clone().text();
    const error = expectError(await readBody(response));
    expect(error.code).toBe("QSPEC_RESOURCE_NOT_FOUND");
    // The registered names must not leak anywhere in the response body, not
    // only in the parsed `message` field — this is the property the plan
    // asked to falsify directly (see the falsification note at the bottom of
    // this file). "customers" and "orders" are two DIFFERENT registered
    // resources than the one requested, so their presence here would prove a
    // disclosure, not an echo of the query.
    expect(rawText).not.toContain("orders");
    expect(rawText).not.toContain("customers");
  });

  it("returns 400 with issues carrying paths for a parameter violating its declared type", async () => {
    const { runtime } = buildRuntime();
    const handler = createQSpecHandler({
      runtime,
      manifests: { "orders-by-id": PARAMETERIZED_MANIFEST },
    });

    const response = await handler(
      post({ resource: "orders-by-id", parameters: { id: "not-a-number" } }),
    );
    expect(response.status).toBe(400);
    const error = expectError(await readBody(response));
    expect(error.code).toBe("QSPEC_PARAMETER_INVALID");
    expect(error.issues).toBeDefined();
    expect(error.issues?.[0]?.path).toEqual(["parameters", "id"]);
  });

  it("prepares the same resource once across two requests", async () => {
    const { runtime } = buildRuntime();
    const handler = createQSpecHandler({ runtime, manifests: { orders: ORDERS_MANIFEST } });

    let parseEndCount = 0;
    runtime.on("manifest:parse:end", () => {
      parseEndCount += 1;
    });

    const first = await handler(post({ resource: "orders" }));
    const second = await handler(post({ resource: "orders" }));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    // manifest:parse:end fires exactly once per prepareResource() call
    // (packages/core/src/internal/prepare.ts) — a count of 1 across two
    // requests for the SAME resource is the only direct evidence that the
    // second request reused the cached PreparedResource instead of calling
    // runtime.prepare() again.
    expect(parseEndCount).toBe(1);
  });

  it("returns 500 whose body contains neither the connection string nor the driver's message", async () => {
    const password = "hunter2";
    const driverMessage = `password authentication failed for postgres://user:${password}@host/db`;
    const failingPlugin = failingSourcePlugin("broken-pg", "test-fail", driverMessage);
    const runtime = createQSpec().use(failingPlugin);
    const manifest: QSpecManifest<QSpecResourceSpec> = {
      apiVersion: "qspec.dev/v1",
      kind: "Dataset",
      metadata: { name: "broken" },
      spec: {
        query: { source: "broken-pg", language: "test-fail", statement: "irrelevant" },
      },
    };
    const handler = createQSpecHandler({ runtime, manifests: { broken: manifest } });

    const response = await handler(post({ resource: "broken" }));
    expect(response.status).toBe(500);
    const rawText = await response.clone().text();
    expect(rawText).not.toContain(password);
    expect(rawText).not.toContain(driverMessage);
    expect(rawText).not.toContain("postgres://");
    const error = expectError(await readBody(response));
    // The driver's plain Error is wrapped by core's asQueryError
    // (packages/core/src/internal/execute.ts) into a QueryExecutionError,
    // whose code is the fixed, known-safe QSPEC_QUERY_FAILED — asserting the
    // exact code (not merely "is a non-empty string") is what actually
    // exercises mapError's `error instanceof QSpecError ? error.code : ...`
    // branch on its true side, rather than passing identically if that
    // branch were replaced with an unconditional QSPEC_INTERNAL_ERROR.
    expect(error.code).toBe("QSPEC_QUERY_FAILED");
  });

  /**
   * The elapsed-time bound this test used to rely on exclusively can pass
   * while proving nothing: on slow CI, JSON parsing plus `prepare()` could
   * by itself exceed a fixed delay, so the abort would be caught by core's
   * PRE-execution guard (before the source ever runs) rather than
   * propagating INTO the source — and the response would still come back as
   * a 499 well under the elapsed-time bound either way, so the test would
   * pass without the signal ever reaching the source at all. Fixed two ways,
   * together:
   * - `recordingSlowSourcePlugin`'s source records directly whether IT
   *   observed the abort (`observed.aborted`), asserted on below as direct
   *   evidence of propagation, not an inference from timing.
   * - This test awaits `entered` — resolved by the source itself the
   *   instant its `execute()` starts — before calling `controller.abort()`,
   *   rather than racing a fixed delay against however long JSON parsing
   *   plus `prepare()` happen to take on the machine running this test. That
   *   removes the flake outright rather than merely tolerating it: on any
   *   machine, the abort cannot fire before the source has genuinely
   *   started.
   */
  it("propagates an aborted request signal into the runtime", async () => {
    const {
      plugin: slowPlugin,
      observed,
      entered,
    } = recordingSlowSourcePlugin("slow", "slow", 300);
    const runtime = createQSpec().use(slowPlugin);
    const handler = createQSpecHandler({ runtime, manifests: { slow: SLOW_MANIFEST } });

    const controller = new AbortController();
    const request = post({ resource: "slow" }, { signal: controller.signal });
    const started = performance.now();
    const responsePromise = handler(request);
    await entered;
    controller.abort();

    const response = await responsePromise;
    expect(response.status).toBe(499);
    expect(expectError(await readBody(response)).code).toBe("QSPEC_EXECUTION_ABORTED");
    // The load-bearing assertion: the SOURCE itself recorded seeing the
    // abort, not merely that the response arrived quickly.
    expect(observed.aborted).toBe(true);
    // Kept as defense in depth, not as the proof of propagation.
    expect(performance.now() - started).toBeLessThan(150);
  });

  it("handles concurrent requests for two different resources without interference", async () => {
    const { runtime } = buildRuntime();
    const handler = createQSpecHandler({
      runtime,
      manifests: { orders: ORDERS_MANIFEST, customers: CUSTOMERS_MANIFEST },
    });

    const [ordersResponse, customersResponse] = await Promise.all([
      handler(post({ resource: "orders" })),
      handler(post({ resource: "customers" })),
    ]);

    expect(ordersResponse.status).toBe(200);
    expect(customersResponse.status).toBe(200);
    const ordersBody = await readBody(ordersResponse);
    const customersBody = await readBody(customersResponse);
    if (!ordersBody.ok || !customersBody.ok) {
      throw new Error("expected both concurrent requests to succeed");
    }
    expect(ordersBody.result.data.fields.map((f) => f.name)).toEqual(["month", "revenue"]);
    expect(customersBody.result.data.fields.map((f) => f.name)).toEqual(["id", "name"]);
  });

  /**
   * Falsifies `resolveManifest`'s `Object.hasOwn` guard.
   *
   * `resource: "constructor"` — the name the plan's brief names for this
   * falsification — cannot be used here: Task 1's `parseExecuteRequest`
   * already rejects `"constructor"` as an unsafe key before this handler's
   * registry lookup ever runs, so removing `Object.hasOwn` from
   * `resolveManifest` would not change this test's outcome at all (it is
   * genuinely unreachable through the public request path). `"toString"` is
   * used instead: Task 1's parser does NOT reject it (only `__proto__`,
   * `constructor`, and `prototype` are unsafe keys — see
   * packages/core/src/json.ts), so a request naming it reaches
   * `resolveManifest` with a `manifests` object that has no own `"toString"`
   * property but, like every plain object, inherits one from
   * `Object.prototype`.
   *
   * Manually confirmed by temporarily replacing `resolveManifest`'s body with
   * `return manifests[resource];` (dropping the `Object.hasOwn` guard):
   *
   *   AssertionError: expected 400 to be 404 // Object.is equality
   *
   * (the handler proceeded to call `runtime.prepare(Object.prototype.toString)`,
   * which failed manifest parsing — a plain function is not a valid manifest
   * — producing a 400 ManifestValidationError response instead of the 404
   * "not found" this test expects; either way, proof the guard is
   * load-bearing). Restored immediately after confirming the failure; the
   * guard is intact in the committed handler.ts.
   */
  it("does not resolve a resource name to an inherited Object.prototype property", async () => {
    const { runtime } = buildRuntime();
    const manifests: QSpecHandlerOptions["manifests"] = { orders: ORDERS_MANIFEST };
    const handler = createQSpecHandler({ runtime, manifests });

    const response = await handler(post({ resource: "toString" }));
    expect(response.status).toBe(404);
    expect(expectError(await readBody(response)).code).toBe("QSPEC_RESOURCE_NOT_FOUND");
  });
});
