/**
 * The wire protocol for carrying QSpec execution across an HTTP boundary,
 * plus a server handler and a browser client built on top of it.
 * `internal/protocol.ts` has the wire shape and why it is what it is;
 * `internal/handler.ts` has the server half; `internal/executor.ts` has the
 * client half.
 *
 * **Known limitation — a `Date` nested inside an `object`-typed cell does
 * not survive a round trip.** Core's `normalizeResult` (see
 * `packages/core/src/internal/normalize-result.ts`) converts a *top-level*
 * `Date` cell to an ISO string specifically so a `Dataset` survives JSON —
 * so a `datetime`-typed field round-trips through this package correctly.
 * But per that function's own doc comment, a `Date` nested inside a
 * composite (`object`- or `array`-typed) cell is deliberately left alone,
 * on the theory that an adapter hands back JSON-shaped values inside
 * composite columns. `createQSpecHandler` JSON-serializes the whole
 * `QSpecResult` to send it, so a `Date` in that position round-trips as
 * whatever `JSON.stringify` turns it into (an ISO string, but no longer
 * recognizable as a `Date` — `typeof` is `"string"`, not `"object"`, and
 * `instanceof Date` is `false`) rather than as a `Date` instance. This is
 * core's documented design, not a bug in this package, and is not something
 * `@qspecs/http` fixes — see `executor.test.ts`'s test pinning the exact
 * post-JSON shape.
 */
export {
  parseExecuteRequest,
  type QSpecErrorBody,
  type QSpecExecuteRequest,
  type QSpecExecuteResponse,
} from "./internal/protocol.js";
export { createQSpecHandler, type QSpecHandlerOptions } from "./internal/handler.js";
export {
  createHttpExecutor,
  type HttpExecutorOptions,
  type QSpecExecutor,
} from "./internal/executor.js";
