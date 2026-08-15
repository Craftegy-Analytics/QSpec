import {
  ManifestValidationError,
  ParameterValidationError,
  QSpecAbortError,
  QSpecError,
  QueryExecutionError,
  isPlainObject,
  type ExecutionContext,
  type QSpecResult,
} from "@qspecs/core";
import type { QSpecErrorBody, QSpecExecuteResponse } from "./protocol.js";

/**
 * What a host supplies to build a client executor. Deliberately small: no
 * retry policy, no cache, no auth hook. A host that wants any of those wraps
 * `fetch` itself and passes the wrapped function through `fetch` below —
 * this package stays a thin, predictable transport, not a place those
 * concerns accumulate.
 */
export interface HttpExecutorOptions {
  /** The endpoint a `createQSpecHandler`-built route is mounted at. */
  readonly url: string;
  /** Injected for tests and for hosts with their own fetch. */
  readonly fetch?: typeof globalThis.fetch;
  /**
   * Extra headers sent with every request. Merged over the executor's own
   * default `content-type: application/json`, header name by header name
   * and case-insensitively (per the Fetch API's `Headers`) — an entry here
   * with any casing of the name `content-type` replaces the default rather
   * than producing a combined, comma-joined value.
   */
  readonly headers?: Readonly<Record<string, string>>;
}

/** The client half of `@qspecs/http`'s wire protocol: runs a resource by name, over HTTP. */
export interface QSpecExecutor {
  execute(resource: string, context?: ExecutionContext): Promise<QSpecResult>;
}

/** The JSON body a request POSTs. Kept separate from `QSpecExecuteRequest` (protocol.ts):
 * that type requires `parameters` values to already be `JsonValue`, but an
 * `ExecutionContext.parameters` is `Record<string, unknown>` — a caller may
 * legitimately pass values (e.g. a `Date`) it expects `JSON.stringify` to
 * serialize, the same way `fetch(url, { body: JSON.stringify(x) })` always
 * has. Validating those values as `JsonValue` is `parseExecuteRequest`'s job,
 * server-side, on the far end of the wire — not this client's.
 *
 * A `Date` is only half interchangeable between this executor and
 * `createLocalExecutor`, despite both implementing the same `QSpecExecutor`
 * interface: over HTTP, `JSON.stringify` turns it into an ISO string before
 * it ever reaches core's `checkScalar`, which a `datetime` parameter accepts.
 * Passed to `createLocalExecutor` directly, in-process, the same `Date`
 * value is never stringified — `checkScalar`'s `datetime` branch requires
 * `typeof value === "string"` first and rejects a `Date` object outright
 * (`packages/core/src/internal/validate/parameters.ts`). A caller that wants
 * behavior identical across both executors must stringify the `Date` itself
 * before calling `execute()`, on either one.
 */
interface ExecuteRequestBody {
  readonly resource: string;
  readonly parameters?: Record<string, unknown>;
}

function buildRequestBody(
  resource: string,
  context: ExecutionContext | undefined,
): ExecuteRequestBody {
  return context?.parameters === undefined
    ? { resource }
    : { resource, parameters: context.parameters };
}

/**
 * Default `content-type` first, then every caller-supplied header `set`
 * (never `append`) over it — `set` replaces by normalized name rather than
 * combining values, which is what happens if two entries with the same
 * name-different-casing are handed to `fetch` in one plain object literal.
 * This is the one place `HttpExecutorOptions.headers`'s override behavior
 * (documented on that field) is implemented.
 */
function buildHeaders(custom: Readonly<Record<string, string>> | undefined): Headers {
  const headers = new Headers({ "content-type": "application/json" });
  if (custom !== undefined) {
    for (const [name, value] of Object.entries(custom)) {
      headers.set(name, value);
    }
  }
  return headers;
}

/**
 * Parses response text as JSON, failing with a `QueryExecutionError`
 * carrying a clear, client-authored message rather than letting a malformed
 * body surface as a raw `SyntaxError` from `JSON.parse` — a caller catching
 * QSpec errors should never need to also catch `SyntaxError` to handle a
 * broken server. Deliberately takes already-read `text`, not a `Response`:
 * reading the body itself can fail on its own (a dropped connection, or an
 * abort landing after headers arrive but before the body finishes streaming)
 * and that failure is handled by `execute()`'s outer `try`, alongside the
 * `fetch` call itself, not here.
 */
function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new QueryExecutionError("The QSpec server returned a response that was not valid JSON.", {
      cause,
    });
  }
}

/**
 * Confirms parsed JSON has at least the shape `QSpecExecuteResponse`
 * requires before trusting it as one: a plain object with a boolean `ok`,
 * and — when `ok` is `true` — a plain-object `result`, or — when `ok` is
 * `false` — an `error` that is at minimum a plain object with a string
 * `code` and a string `message`. Guards against a server returning valid
 * JSON that is not the wire protocol at all (`null`, an array, `{}`, an
 * `{ ok: true }` with no `result`, or an `{ ok: false }` with no usable
 * `error`) — without this, reading `.result` or `.error` off it below, or
 * `reconstructError` reading `.error.code`, would either throw an unrelated
 * `TypeError` or silently reconstruct a `QSpecError` with an empty message
 * and an `undefined` code, instead of throwing a `QSpecError` a caller can
 * `instanceof`-check like every other failure here.
 */
function asExecuteResponse(value: unknown): QSpecExecuteResponse {
  if (!isPlainObject(value) || typeof value["ok"] !== "boolean") {
    throw new QueryExecutionError(
      "The QSpec server returned a response that did not match the expected protocol shape.",
    );
  }
  if (value["ok"]) {
    if (!isPlainObject(value["result"])) {
      throw new QueryExecutionError(
        "The QSpec server returned an ok:true response with no result.",
      );
    }
  } else {
    const error = value["error"];
    if (
      !isPlainObject(error) ||
      typeof error["code"] !== "string" ||
      typeof error["message"] !== "string"
    ) {
      throw new QueryExecutionError(
        "The QSpec server returned an ok:false response with no usable error.",
      );
    }
  }
  return value as QSpecExecuteResponse;
}

/**
 * Maps a wire-format error to the `QSpecError` subclass a caller would have
 * caught from a purely local `execute()` call, so `instanceof` checks
 * against `@qspecs/core`'s error classes behave identically whether qspec ran
 * in this process or over HTTP.
 *
 * Only codes `handler.ts`'s `mapError` can actually produce are handled
 * specifically:
 * - `QSPEC_MANIFEST_INVALID` / `QSPEC_PARAMETER_INVALID` (400): reconstructed
 *   with `issues` intact. A response missing `issues` entirely (`handler.ts`
 *   always sends it for these two codes, but nothing on the wire guarantees
 *   a well-behaved server always will) reconstructs with an empty array
 *   rather than throwing a second, unrelated error while already handling
 *   the first.
 * - `QSPEC_EXECUTION_ABORTED` (499): reconstructed as `QSpecAbortError`.
 * - Any 5xx response, regardless of `error.code`: reconstructed as
 *   `QueryExecutionError`, carrying the server's message verbatim. A 500's
 *   code might be `QSPEC_DATASET_INVALID` or `QSPEC_TRANSFORM_FAILED` — both
 *   aggregate-issue error classes a 500 response never carries `issues` for
 *   (see `handler.ts`'s `mapError`) — or the generic `QSPEC_INTERNAL_ERROR`
 *   fallback; none of those can be reconstructed as their original class
 *   without data the wire never sent, so every 5xx collapses to the one
 *   class the task brief specifies.
 * - Everything else (404 `QSPEC_RESOURCE_NOT_FOUND`, 405
 *   `QSPEC_METHOD_NOT_ALLOWED`, and any other 4xx such as
 *   `QSPEC_BAD_REQUEST`): the base `QSpecError`, carrying the server's own
 *   code and message. There is no more specific core class for these — they
 *   are concerns of the HTTP boundary itself (Task 2's handler), not of
 *   anything core's local `execute()` can throw.
 */
function reconstructError(status: number, body: QSpecErrorBody): QSpecError {
  if (body.code === "QSPEC_MANIFEST_INVALID") {
    return new ManifestValidationError(body.message, { issues: body.issues ?? [] });
  }
  if (body.code === "QSPEC_PARAMETER_INVALID") {
    return new ParameterValidationError(body.message, { issues: body.issues ?? [] });
  }
  if (body.code === "QSPEC_EXECUTION_ABORTED") {
    return new QSpecAbortError(body.message);
  }
  if (status >= 500) {
    return new QueryExecutionError(body.message);
  }
  return new QSpecError(body.message, { code: body.code });
}

/**
 * Builds the browser/client half of `@qspecs/http`'s wire protocol: a
 * `QSpecExecutor` that POSTs `{ resource, parameters }` to `options.url` and
 * turns the response back into a `QSpecResult` or a faithfully reconstructed
 * `QSpecError`.
 *
 * `context.signal`, if given, is forwarded to `fetch` as `init.signal` and
 * is the only way an in-flight request is actually cancelled — this
 * function does not race a timer or synthesize its own cancellation. Three
 * distinct paths all surface a caller abort as `QSpecAbortError`:
 * - `fetch` itself rejects because the signal fired before or during the
 *   request.
 * - `response.text()` rejects because the signal fired after headers
 *   arrived but before the body finished streaming — against a real
 *   network this is the DOMINANT abort path for anything but a tiny
 *   `Dataset`, since a response typically streams for longer than its
 *   headers take to arrive.
 * - The request reached the server, which observed the abort and returned a
 *   499 response (see `handler.ts`'s `mapError`) — reachable in-process
 *   against a `fetch` built directly from `createQSpecHandler`, as
 *   `executor.test.ts` does.
 *
 * `context.locale`, `context.timezone`, and `context.metadata` are not part
 * of the wire protocol (`protocol.ts`'s `QSpecExecuteRequest` has no fields
 * for them) and are not sent.
 */
export function createHttpExecutor(options: HttpExecutorOptions): QSpecExecutor {
  const fetchImpl = options.fetch ?? globalThis.fetch;

  return {
    async execute(resource: string, context?: ExecutionContext): Promise<QSpecResult> {
      const requestInit: RequestInit = {
        method: "POST",
        headers: buildHeaders(options.headers),
        body: JSON.stringify(buildRequestBody(resource, context)),
        ...(context?.signal === undefined ? {} : { signal: context.signal }),
      };

      // Both the request itself AND reading its response body can fail —
      // deliberately one `try` for both, not two. Against a real network,
      // an abort landing after headers arrive but before the body finishes
      // streaming (the normal case for anything but a tiny `Dataset`) makes
      // `response.text()` reject, not `fetch()`; a mid-body connection drop
      // does too. Splitting these into separate `try` blocks would leave
      // the body-read failure unguarded and let a raw `DOMException` or
      // `TypeError` escape instead of the `QSpecError` every other failure
      // here is normalized to.
      let status: number;
      let text: string;
      try {
        const response = await fetchImpl(options.url, requestInit);
        status = response.status;
        text = await response.text();
      } catch (cause) {
        if (context?.signal?.aborted === true) {
          throw new QSpecAbortError("QSpec execution was aborted.", { cause });
        }
        throw new QueryExecutionError("The request to the QSpec server failed.", { cause });
      }

      const body = asExecuteResponse(parseJsonText(text));
      if (body.ok) return body.result;
      throw reconstructError(status, body.error);
    },
  };
}
