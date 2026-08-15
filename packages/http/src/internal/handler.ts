import {
  ManifestValidationError,
  ParameterValidationError,
  QSpecAbortError,
  QSpecError,
  type PreparedResource,
  type QSpec,
  type QSpecManifest,
  type QSpecResourceSpec,
} from "@qspecs/core";
import { parseExecuteRequest, type QSpecErrorBody, type QSpecExecuteResponse } from "./protocol.js";

/**
 * What this handler needs from the host: its own runtime (already carrying
 * whatever credentials its plugins were configured with) and the fixed set of
 * manifests it is willing to execute, keyed by the resource name a request
 * asks for. Nothing else — no logger, no auth hook, no rate limiter. Those
 * are the host's concern, layered around the `(Request) => Promise<Response>`
 * this factory returns; they are not this package's job.
 *
 * A reviewer can confirm the trust property from this type alone: the
 * browser sends `QSpecExecuteRequest` (resource name + parameter values,
 * nothing executable — see protocol.ts), and this handler resolves that name
 * against a registry the HOST supplied at construction time, then executes on
 * the HOST's own runtime. The request can never name a table, a query, or a
 * connection string the host did not already put here itself.
 */
export interface QSpecHandlerOptions {
  /** The server's own runtime, with its own credentials. */
  readonly runtime: QSpec;
  /** The only manifests this endpoint will execute, by resource name. */
  readonly manifests: Readonly<Record<string, QSpecManifest<QSpecResourceSpec> | string>>;
}

function jsonResponse(
  status: number,
  body: QSpecExecuteResponse,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function errorResponse(
  status: number,
  error: QSpecErrorBody,
  headers?: Record<string, string>,
): Response {
  return jsonResponse(status, { ok: false, error }, headers);
}

/**
 * Resolves `resource` against the host's registry with `Object.hasOwn`,
 * never a plain bracket lookup. This is not defense in depth for a name
 * Task 1's wire-protocol parser already blocks (`__proto__`, `constructor`,
 * `prototype`): it is the ONLY guard against a resource name the parser does
 * NOT reject but `manifests` — a plain object — still inherits, e.g.
 * `"toString"`, `"valueOf"`, `"hasOwnProperty"`. A plain `manifests[resource]`
 * lookup for `resource: "toString"` resolves to `Object.prototype.toString`,
 * a function, which is not `undefined` — the request would then be treated
 * as naming a registered resource it never named. See handler.test.ts's
 * falsification, which uses exactly that name because `"constructor"` itself
 * never reaches this function at all (Task 1 rejects it earlier).
 */
function resolveManifest(
  manifests: QSpecHandlerOptions["manifests"],
  resource: string,
): QSpecManifest<QSpecResourceSpec> | string | undefined {
  return Object.hasOwn(manifests, resource) ? manifests[resource] : undefined;
}

/**
 * Renders any failure from `prepare()` or `execute()` as an HTTP response.
 *
 * `ManifestValidationError` and `ParameterValidationError` both aggregate
 * `QSpecIssue`s the same way — they share a base class core keeps internal —
 * so both map to 400 with their issues attached. The manifest case is a host
 * configuration error; the parameter case is the caller's own bad input
 * (SPEC.md's "a parameter violating the manifest's declared type" case).
 * Either way `error.message` is safe to forward: both are built from the
 * manifest's own declared shape and the caller's own supplied values, never
 * from a driver.
 *
 * Everything else — every other `QSpecError`, and anything that is not a
 * `QSpecError` at all — becomes a 500 whose message THIS function composes,
 * never `error.message`. That is deliberate, not an oversight: core's own
 * fallback in `executePrepared`'s `asQueryError` embeds an adapter's raw
 * thrown message into `QueryExecutionError.message` when the adapter throws
 * a plain `Error` (packages/core/src/internal/execute.ts) — so a driver's
 * connection string can arrive on `error.message` even once it is wrapped in
 * a QSpecError. Only `error.code` is trusted from an arbitrary QSpecError;
 * the code is a fixed, known-safe string this package never composes from
 * caller or driver input, unlike the message. (SPEC.md §72.6)
 */
function mapError(error: unknown): Response {
  if (error instanceof ManifestValidationError || error instanceof ParameterValidationError) {
    return errorResponse(400, { code: error.code, message: error.message, issues: error.issues });
  }
  if (error instanceof QSpecAbortError) {
    return errorResponse(499, { code: error.code, message: "The request was aborted." });
  }
  const code = error instanceof QSpecError ? error.code : "QSPEC_INTERNAL_ERROR";
  return errorResponse(500, {
    code,
    message: "The request could not be completed because of an internal error.",
  });
}

/**
 * Builds the `(Request) => Promise<Response>` an HTTP framework wires up as
 * one route. Six steps per request:
 *
 * 1. Only `POST` is accepted; anything else is `405`.
 * 2. The body is parsed as JSON, then validated through `parseExecuteRequest`
 *    (Task 1's hardened wire-protocol parser). Either failure is `400` with
 *    `code: "QSPEC_BAD_REQUEST"`, and neither reaches `manifests` or
 *    `runtime` at all.
 * 3. `resource` is resolved against `manifests` — see `resolveManifest`. An
 *    unknown resource is `404` with a message that does not enumerate the
 *    registry (see `handler.test.ts`'s falsification of this property).
 * 4. The resolved manifest is prepared once per resource and the
 *    `PreparedResource` is cached for the life of this handler — see the
 *    `prepared` map below for why a failure is cached too.
 * 5. It is executed with the request's parameters and `request.signal`, so a
 *    client that disconnects mid-request cancels the query rather than
 *    leaving it to run to completion unread.
 * 6. The outcome is mapped to a response — see `mapError`.
 */
export function createQSpecHandler(
  options: QSpecHandlerOptions,
): (request: Request) => Promise<Response> {
  const { runtime, manifests } = options;

  // Keyed by resource name. `prepare()` is the expensive half of the
  // pipeline (SPEC.md §81) and caching its result across requests for the
  // SAME resource is the whole reason the prepare/execute split exists.
  //
  // A rejected promise is cached too, deliberately, answering the design
  // question this task's brief raised explicitly: prepare() does no I/O of
  // its own. It is static validation of the manifest THIS HANDLER was
  // constructed with (an object or string fixed at `createQSpecHandler`
  // call time, never touched by request data) against registries `runtime`
  // already finished building the first time anything awaited `ready()`.
  // Neither input can change between one request and the next, so a
  // prepare() failure is a deterministic function of configuration that is
  // already wrong and will still be wrong on retry — there is no transient
  // failure mode here to protect by NOT caching (unlike `execute()`, which
  // is intentionally never cached below: that is where the real I/O, and any
  // real transient failure, happens, fresh on every request). Caching the
  // rejection turns "re-run the same doomed validation on every request for
  // a broken manifest" into "fail fast, once, until the host fixes and
  // redeploys its configuration" — a real efficiency win with no correctness
  // cost, because there is nothing transient to preserve.
  const prepared = new Map<string, Promise<PreparedResource>>();

  function prepareOnce(
    resource: string,
    manifest: QSpecManifest<QSpecResourceSpec> | string,
  ): Promise<PreparedResource> {
    const cached = prepared.get(resource);
    if (cached !== undefined) return cached;
    const promise = runtime.prepare(manifest);
    prepared.set(resource, promise);
    return promise;
  }

  return async function handleQSpecRequest(request: Request): Promise<Response> {
    // Step 1.
    if (request.method !== "POST") {
      return errorResponse(
        405,
        { code: "QSPEC_METHOD_NOT_ALLOWED", message: "This endpoint only accepts POST." },
        { allow: "POST" },
      );
    }

    // Step 2a: the transport-level JSON parse. A malformed body (invalid
    // JSON text, or none at all) never reaches `parseExecuteRequest`, let
    // alone `manifests` or `runtime`.
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return errorResponse(400, {
        code: "QSPEC_BAD_REQUEST",
        message: "Request body must be valid JSON.",
      });
    }

    // Step 2b: the wire-protocol shape. `parseExecuteRequest` is Task 1's
    // hardened parser; every failure it throws becomes a 400 here, still
    // before `manifests` or `runtime` is touched.
    let executeRequest;
    try {
      executeRequest = parseExecuteRequest(body);
    } catch (error) {
      return errorResponse(400, {
        code: "QSPEC_BAD_REQUEST",
        message: error instanceof Error ? error.message : "The request body is invalid.",
      });
    }

    // Step 3.
    const manifest = resolveManifest(manifests, executeRequest.resource);
    if (manifest === undefined) {
      // Deliberately generic: no list, no count, no did-you-mean. Naming
      // what else is registered would let an unauthenticated caller
      // enumerate this server's private manifest registry one probe at a
      // time. See handler.test.ts's falsification of this property.
      return errorResponse(404, {
        code: "QSPEC_RESOURCE_NOT_FOUND",
        message: "No resource is registered under the requested name.",
      });
    }

    try {
      // Step 4.
      const preparedResource = await prepareOnce(executeRequest.resource, manifest);
      // Step 5. `request.signal` always exists (the Fetch API guarantees a
      // live, non-optional AbortSignal even when the caller supplied none),
      // so a disconnected client — or an explicit client-side abort —
      // propagates straight into the runtime's own cancellation path.
      const result = await preparedResource.execute({
        ...(executeRequest.parameters === undefined
          ? {}
          : { parameters: executeRequest.parameters }),
        signal: request.signal,
      });
      // Step 6 (success).
      return jsonResponse(200, { ok: true, result });
    } catch (error) {
      // Step 6 (failure).
      return mapError(error);
    }
  };
}
