import { describe, expect, it } from "vitest";
import {
  ManifestValidationError,
  QSpecAbortError,
  QueryExecutionError,
  createQSpec,
  definePlugin,
  isPlainObject,
  type DataSource,
  type QSpecManifest,
  type QSpecResourceSpec,
  type QueryLanguage,
} from "@qspecs/core";
import { memory } from "@qspecs/testing";
import { createQSpecHandler } from "./handler.js";
import { createHttpExecutor, type HttpExecutorOptions } from "./executor.js";

/** A minimal `Dataset`-kind manifest querying the memory source's `analytics` table. */
const ORDERS_MANIFEST: QSpecManifest<QSpecResourceSpec> = {
  apiVersion: "qspec.dev/v1",
  kind: "Dataset",
  metadata: { name: "orders" },
  spec: {
    query: { source: "analytics", language: "memory", statement: "analytics" },
  },
};

/**
 * A resource whose single row exercises every cell shape the round-trip
 * tests care about: a top-level `Date` (a `datetime` field), a `null`, a
 * non-integer `number`, a numeric-precision string (the shape a real driver
 * returns for an arbitrary-precision column, to avoid the float precision a
 * JS `number` would lose), and an `object` cell with a `Date` nested INSIDE
 * it, at the position core's `normalizeResult` deliberately does not touch.
 */
const NESTED_DATE = new Date("2026-02-02T03:04:05.000Z");
const TOP_LEVEL_DATE = new Date("2026-01-01T00:00:00.000Z");
const RICH_MANIFEST: QSpecManifest<QSpecResourceSpec> = {
  apiVersion: "qspec.dev/v1",
  kind: "Dataset",
  metadata: { name: "rich" },
  spec: {
    query: { source: "rich", language: "memory", statement: "rich" },
  },
};

/**
 * A manifest with TWO independent structural problems, so its aggregated
 * `ManifestValidationError.issues` is a genuine multi-issue array (not one
 * issue synthesized specially for this test):
 *
 * - `spec.query` is present, and well-typed enough to satisfy
 *   `QueryDefinition`, but its `source` and `language` are empty strings —
 *   both rejected by structural validation (`validateQuery`,
 *   packages/core/src/internal/validate/manifest.ts). Deliberately not
 *   simply an EMPTY `spec: {}` — core's built-in `Dataset` resource kind
 *   does not set `requiresQuery` (only `@qspecs/charts`'s `Chart` kind does;
 *   see packages/charts/src/index.ts), so an entirely absent `spec.query`
 *   on a `Dataset` manifest is valid and prepares successfully with no
 *   query at all.
 * - `metadata.name` does not match `METADATA_NAME_PATTERN`
 *   (`^[a-z][a-z0-9-]*$`), which `validateMetadata` rejects with an issue
 *   that ALSO carries a `suggestion` (`slugify(name)`) — the one field
 *   `QSpecIssue` has besides `code`/`message`/`path` that the query issues
 *   above never populate, needed so the "issues intact" test below can
 *   pin `suggestion` surviving the wire, not just `code` and `path`.
 */
const BROKEN_MANIFEST: QSpecManifest<QSpecResourceSpec> = {
  apiVersion: "qspec.dev/v1",
  kind: "Dataset",
  metadata: { name: "Not A Valid Name!" },
  spec: { query: { source: "", language: "", statement: "" } },
};

/** A resource whose table has a delay, so an in-flight request can be aborted mid-execution. */
const SLOW_MANIFEST: QSpecManifest<QSpecResourceSpec> = {
  apiVersion: "qspec.dev/v1",
  kind: "Dataset",
  metadata: { name: "slow" },
  spec: {
    query: { source: "slow", language: "memory", statement: "slow" },
  },
};

function buildRuntime() {
  const plugin = memory({
    tables: {
      analytics: { columns: ["month", "revenue"], rows: [["2026-01-01", 10]] },
      rich: {
        columns: ["amount", "createdAt", "note", "precise", "meta"],
        rows: [
          [
            1.5,
            TOP_LEVEL_DATE,
            null,
            "12345678901234567890.123456789",
            { nested: NESTED_DATE, flag: true },
          ],
        ],
      },
      slow: { columns: ["x"], rows: [["y"]], delayMs: 300 },
    },
  });
  return createQSpec().use(plugin);
}

/**
 * A `fetch` built directly from a `createQSpecHandler`-produced handler, with
 * no network involved — the highest-fidelity way to test this client: both
 * halves of `@qspecs/http`'s protocol run, for real, with neither mocked.
 */
function fetchFromHandler(
  handler: (request: Request) => Promise<Response>,
): typeof globalThis.fetch {
  return async (input, init) => handler(new Request(input, init));
}

/** A data source whose `execute` always rejects with a driver-shaped error embedding a password. */
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

/** Awaits a promise expected to reject, and returns what it rejected with. Fails the test otherwise. */
async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

/** Narrows `value` to a plain object, or fails the test — never casts. */
function expectPlainObject(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) throw new Error("expected a plain object");
  return value;
}

const URL_UNDER_TEST = "http://executor.test/execute";

describe("createHttpExecutor", () => {
  it("returns a QSpecResult deep-equal to what the server produced, for a successful execute()", async () => {
    const runtime = buildRuntime();
    const handler = createQSpecHandler({ runtime, manifests: { orders: ORDERS_MANIFEST } });

    // Captures the exact response body the handler produced for THIS
    // request (via `.clone()`, so the executor still consumes the original)
    // rather than issuing a second, independent request to compare against
    // — a second call would legitimately carry a different `executionId`
    // and `durationMs` in `meta`, which would make this assertion fail for
    // a reason that has nothing to do with the client.
    let serverBody: { ok: true; result: unknown } | undefined;
    const fetchImpl: typeof globalThis.fetch = async (input, init) => {
      const response = await handler(new Request(input, init));
      serverBody = (await response.clone().json()) as { ok: true; result: unknown };
      return response;
    };

    const executor = createHttpExecutor({ url: URL_UNDER_TEST, fetch: fetchImpl });
    const result = await executor.execute("orders");

    expect(serverBody).toBeDefined();
    expect(result).toEqual(serverBody?.result);
    expect(result.data.rows).toEqual([{ month: "2026-01-01", revenue: 10 }]);
  });

  it("round-trips a Dataset's datetime field, a null, a non-integer number, and a numeric-precision string", async () => {
    const runtime = buildRuntime();
    const handler = createQSpecHandler({ runtime, manifests: { rich: RICH_MANIFEST } });
    const executor = createHttpExecutor({ url: URL_UNDER_TEST, fetch: fetchFromHandler(handler) });

    const result = await executor.execute("rich");

    const createdAtField = result.data.fields.find((field) => field.name === "createdAt");
    expect(createdAtField?.type).toBe("datetime");
    const row = expectPlainObject(result.data.rows[0]);
    expect(row["amount"]).toBe(1.5);
    expect(row["createdAt"]).toBe(TOP_LEVEL_DATE.toISOString());
    expect(row["note"]).toBeNull();
    expect(row["precise"]).toBe("12345678901234567890.123456789");
  });

  /**
   * Pins core's documented limitation (see `normalize-result.ts`'s doc
   * comment, and `index.ts`'s package-level doc comment where this is
   * recorded): only a TOP-LEVEL `Date` cell is converted for the wire. A
   * `Date` nested inside an `object`-typed cell is left alone by
   * `normalizeResult`, so it survives as a live `Date` instance up until
   * `createQSpecHandler` JSON-serializes the whole result to send it — at
   * which point `JSON.stringify` calls the nested `Date`'s own `toJSON()`
   * regardless, producing an ISO string in the wire body with no marker
   * that it was ever a `Date`. This is NOT this package's bug to fix.
   */
  it("does not preserve a Date nested inside an object-typed cell as a Date — it becomes a plain ISO string", async () => {
    const runtime = buildRuntime();
    const handler = createQSpecHandler({ runtime, manifests: { rich: RICH_MANIFEST } });
    const executor = createHttpExecutor({ url: URL_UNDER_TEST, fetch: fetchFromHandler(handler) });

    const result = await executor.execute("rich");

    // Pinned on the mechanism the doc comment above describes, not only the
    // symptom: the FIELD is still inferred as "object" (normalizeResult's
    // inferType sees a plain object, not a Date, at the top level of this
    // cell) — it is specifically the VALUE nested inside it that stops being
    // a Date. If inference ever started reporting this field as "datetime"
    // or "string" instead, that would be a different, more surprising bug
    // than the one this test documents, and this assertion is what would
    // catch it rather than letting the test keep passing for the wrong reason.
    const metaField = result.data.fields.find((field) => field.name === "meta");
    expect(metaField?.type).toBe("object");

    const row = expectPlainObject(result.data.rows[0]);
    const meta = expectPlainObject(row["meta"]);
    // Pinned: NOT a Date instance, NOT typeof "object" — a plain string,
    // equal to the ISO text Date.prototype.toJSON would have produced.
    expect(meta["nested"]).toBe(NESTED_DATE.toISOString());
    expect(typeof meta["nested"]).toBe("string");
    expect(meta["nested"]).not.toBeInstanceOf(Date);
    expect(meta["flag"]).toBe(true);
  });

  it("reconstructs a 400 as a ManifestValidationError with its issues intact", async () => {
    const runtime = buildRuntime();
    const handler = createQSpecHandler({ runtime, manifests: { broken: BROKEN_MANIFEST } });

    // Captures the exact wire body for THIS request (see the successful
    // round-trip test above for why `.clone()`, not a second request).
    let serverIssues: readonly { path: readonly unknown[] }[] | undefined;
    const fetchImpl: typeof globalThis.fetch = async (input, init) => {
      const response = await handler(new Request(input, init));
      const parsed = (await response.clone().json()) as {
        ok: false;
        error: { issues?: readonly { path: readonly unknown[] }[] };
      };
      serverIssues = parsed.error.issues;
      return response;
    };
    const executor = createHttpExecutor({ url: URL_UNDER_TEST, fetch: fetchImpl });

    const error = await captureRejection(executor.execute("broken"));
    if (!(error instanceof ManifestValidationError)) {
      throw new Error(`expected a ManifestValidationError, got ${String(error)}`);
    }
    expect(error.code).toBe("QSPEC_MANIFEST_INVALID");
    // Two independent issues (see BROKEN_MANIFEST's doc comment) both
    // survive, not just a truncated first one.
    expect(error.issues.length).toBe(3);

    expect(serverIssues).toBeDefined();
    // The full array, not just one issue: proves reconstruction did not
    // drop, reorder, or otherwise transform ANY issue — a client that
    // rebuilt `issues` as `[{ message }]` (dropping code/path/suggestion,
    // the exact fields protocol.ts's QSpecErrorBody doc comment says
    // `issues` exists to carry verbatim) would fail this line even though
    // `issues.length` alone would not have caught it.
    expect(error.issues).toEqual(serverIssues);

    // And explicitly, on the one issue that carries every field QSpecIssue
    // has: metadata.name's issue is the only one with a `suggestion`.
    const nameIssue = error.issues.find((issue) => issue.path[0] === "metadata");
    if (nameIssue === undefined) throw new Error("expected an issue on metadata.name");
    expect(nameIssue.code).toBe("QSPEC_MANIFEST_INVALID");
    expect(nameIssue.path).toEqual(["metadata", "name"]);
    expect(nameIssue.suggestion).toBe("not-a-valid-name");
  });

  it("reconstructs a 500 as a QueryExecutionError whose message is the server's safe text", async () => {
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
    const executor = createHttpExecutor({ url: URL_UNDER_TEST, fetch: fetchFromHandler(handler) });

    const error = await captureRejection(executor.execute("broken"));
    if (!(error instanceof QueryExecutionError)) {
      throw new Error(`expected a QueryExecutionError, got ${String(error)}`);
    }
    // Never the invented status line or URL, and never the driver's message
    // or the password it embedded — exactly the server's own safe text.
    expect(error.message).toBe("The request could not be completed because of an internal error.");
    expect(error.message).not.toContain(password);
    expect(error.message).not.toContain(driverMessage);
  });

  /**
   * Falsifies signal forwarding directly: with `context.signal` (correctly)
   * wired into `fetch`'s `init.signal`, the constructed `Request` the fake
   * `fetch` builds for the in-process handler carries the same signal, the
   * memory source's 300ms delay is genuinely interrupted, and this rejects
   * with `QSpecAbortError` well inside the 150ms bound. Manually confirmed
   * this is load-bearing (not a race that would pass anyway) by temporarily
   * dropping the `signal` entry from `executor.ts`'s `requestInit`:
   *
   *   AssertionError: promise resolved "{"data":...}" instead of rejecting
   *
   * — with the signal not forwarded, the in-process handler's Request never
   * saw the abort, the memory source ran its full 300ms delay, and
   * `execute()` resolved successfully instead of rejecting at all. Restored
   * immediately after confirming the failure; the forwarding is intact in
   * the committed executor.ts.
   */
  it("rejects execute() with QSpecAbortError when context.signal aborts mid-request, and actually cancels the request", async () => {
    const runtime = buildRuntime();
    const handler = createQSpecHandler({ runtime, manifests: { slow: SLOW_MANIFEST } });
    const executor = createHttpExecutor({ url: URL_UNDER_TEST, fetch: fetchFromHandler(handler) });

    const controller = new AbortController();
    const started = performance.now();
    const resultPromise = executor.execute("slow", { signal: controller.signal });
    // Abort once the request is genuinely in flight — matches
    // handler.test.ts's own abort test and @qspecs/testing's memory.test.ts.
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();

    const error = await captureRejection(resultPromise);
    if (!(error instanceof QSpecAbortError)) {
      throw new Error(`expected a QSpecAbortError, got ${String(error)}`);
    }
    // "The request was aborted." — not "QSpec execution was aborted.".
    // Against this in-process handler, `fetchImpl` never rejects: the
    // request reaches the handler, which observes the abort itself and
    // returns a 499 (see handler.ts's `mapError`), so this rejection is
    // produced by `reconstructError`'s 499 branch, not by `execute()`'s own
    // `catch` block (executor.ts:224-225, message "QSpec execution was
    // aborted.") — that second path is a real, distinct branch (see the
    // fetch-itself-rejects tests below) but is NOT what this test exercises,
    // despite the name. Asserting the exact message makes which layer is
    // under test explicit, rather than leaving both messages
    // indistinguishable behind one `toBeInstanceOf(QSpecAbortError)`.
    expect(error.message).toBe("The request was aborted.");
    // Without this bound, the test would pass even if the signal never
    // reached the source and the 300ms delay simply ran to completion
    // before this assertion (in which case execute() would have RESOLVED,
    // not rejected — but the timing bound is defense in depth regardless).
    expect(performance.now() - started).toBeLessThan(150);
  });

  it("fails with a clear error, not a raw SyntaxError, when the response body is not JSON", async () => {
    const executor = createHttpExecutor({
      url: URL_UNDER_TEST,
      fetch: async () =>
        new Response("this is not JSON", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
    });

    const error = await captureRejection(executor.execute("orders"));
    if (!(error instanceof QueryExecutionError)) {
      throw new Error(`expected a QueryExecutionError, got ${String(error)}`);
    }
    expect(error).not.toBeInstanceOf(SyntaxError);
    expect(error.message).toBe("The QSpec server returned a response that was not valid JSON.");
  });

  it("sends configured headers with the request", async () => {
    const runtime = buildRuntime();
    const handler = createQSpecHandler({ runtime, manifests: { orders: ORDERS_MANIFEST } });
    let capturedHeaders: Headers | undefined;
    const fetchImpl: NonNullable<HttpExecutorOptions["fetch"]> = async (input, init) => {
      const request = new Request(input, init);
      capturedHeaders = request.headers;
      return handler(request);
    };
    const executor = createHttpExecutor({
      url: URL_UNDER_TEST,
      fetch: fetchImpl,
      headers: { "x-api-key": "secret-token" },
    });

    await executor.execute("orders");

    expect(capturedHeaders?.get("x-api-key")).toBe("secret-token");
    expect(capturedHeaders?.get("content-type")).toBe("application/json");
  });

  it("lets a caller-supplied header override the default content-type, case-insensitively", async () => {
    const runtime = buildRuntime();
    const handler = createQSpecHandler({ runtime, manifests: { orders: ORDERS_MANIFEST } });
    let capturedHeaders: Headers | undefined;
    const fetchImpl: NonNullable<HttpExecutorOptions["fetch"]> = async (input, init) => {
      const request = new Request(input, init);
      capturedHeaders = request.headers;
      return handler(request);
    };
    const executor = createHttpExecutor({
      url: URL_UNDER_TEST,
      fetch: fetchImpl,
      // Differently-cased from the default's "content-type", and a
      // different value — pins that this REPLACES the default (a single
      // "application/json; charset=utf-8" value) rather than the
      // comma-joined "application/json, application/json; charset=utf-8"
      // a plain object literal handed to `fetch` would have produced.
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });

    await executor.execute("orders");

    expect(capturedHeaders?.get("content-type")).toBe("application/json; charset=utf-8");
  });

  it("reconstructs a 400 with an empty issues array when the server sends none", async () => {
    const executor = createHttpExecutor({
      url: URL_UNDER_TEST,
      fetch: async () =>
        new Response(
          JSON.stringify({
            ok: false,
            error: { code: "QSPEC_MANIFEST_INVALID", message: "bad manifest" },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
    });

    const error = await captureRejection(executor.execute("orders"));
    if (!(error instanceof ManifestValidationError)) {
      throw new Error(`expected a ManifestValidationError, got ${String(error)}`);
    }
    expect(error.issues).toEqual([]);
  });

  it("fails with a clear error when an ok:true response has no result", async () => {
    const executor = createHttpExecutor({
      url: URL_UNDER_TEST,
      fetch: async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });

    const error = await captureRejection(executor.execute("orders"));
    if (!(error instanceof QueryExecutionError)) {
      throw new Error(`expected a QueryExecutionError, got ${String(error)}`);
    }
    expect(error.message).toBe("The QSpec server returned an ok:true response with no result.");
  });

  it("fails with a clear error, not a raw TypeError, when an ok:false response has no error field", async () => {
    const executor = createHttpExecutor({
      url: URL_UNDER_TEST,
      fetch: async () =>
        new Response(JSON.stringify({ ok: false }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
    });

    const error = await captureRejection(executor.execute("orders"));
    if (!(error instanceof QueryExecutionError)) {
      throw new Error(`expected a QueryExecutionError, got ${String(error)}`);
    }
    expect(error.message).toBe(
      "The QSpec server returned an ok:false response with no usable error.",
    );
  });

  it("fails with a clear error, not a QSpecError with a blank message, when an ok:false response's error is not the expected shape", async () => {
    const executor = createHttpExecutor({
      url: URL_UNDER_TEST,
      fetch: async () =>
        new Response(JSON.stringify({ ok: false, error: "oops" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
    });

    const error = await captureRejection(executor.execute("orders"));
    if (!(error instanceof QueryExecutionError)) {
      throw new Error(`expected a QueryExecutionError, got ${String(error)}`);
    }
    expect(error.message).toBe(
      "The QSpec server returned an ok:false response with no usable error.",
    );
  });

  it("fails with a QueryExecutionError, not the raw failure, when fetch itself rejects and no abort is in flight", async () => {
    const networkFailure = new TypeError("network is down");
    const executor = createHttpExecutor({
      url: URL_UNDER_TEST,
      fetch: async () => {
        throw networkFailure;
      },
    });

    const error = await captureRejection(executor.execute("orders"));
    if (!(error instanceof QueryExecutionError)) {
      throw new Error(`expected a QueryExecutionError, got ${String(error)}`);
    }
    expect(error).not.toBeInstanceOf(QSpecAbortError);
    expect(error.cause).toBe(networkFailure);
  });

  /**
   * The in-process seam every other test in this file uses cannot produce
   * this: the fake `fetch` there never rejects, and its `Response` body is
   * already fully in memory, so a failure reading the body was previously
   * untested and — before this task's fix — escaped `execute()` as a raw,
   * unwrapped error instead of a `QSpecError`. This is also the DOMINANT
   * abort shape against a real network: a caller's `AbortSignal` firing
   * after headers arrive but before a `Dataset`'s body finishes streaming,
   * which rejects `response.text()`, not `fetch()` itself.
   */
  it("reconstructs QSpecAbortError, not a raw error, when reading the response body fails after the caller aborted", async () => {
    const controller = new AbortController();
    const streamFailure = new DOMException("The operation was aborted.", "AbortError");
    const executor = createHttpExecutor({
      url: URL_UNDER_TEST,
      fetch: async () =>
        new Response(
          new ReadableStream({
            pull(streamController) {
              // The abort happens exactly as the body starts streaming —
              // after `fetch()` itself already resolved with a Response.
              controller.abort();
              streamController.error(streamFailure);
            },
          }),
        ),
    });

    const error = await captureRejection(executor.execute("orders", { signal: controller.signal }));
    if (!(error instanceof QSpecAbortError)) {
      throw new Error(`expected a QSpecAbortError, got ${String(error)}`);
    }
    expect(error.cause).toBe(streamFailure);
  });
});
