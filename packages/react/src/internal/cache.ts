import type { ExecutionContext, JsonValue, QSpecResult } from "@qspecs/core";

/**
 * The client half of a QSpec executor, structurally identical to
 * `@qspecs/http`'s `createHttpExecutor` return type — but redeclared here
 * rather than imported. `@qspecs/react` depends only on `@qspecs/core` (types)
 * and `react` (peer); it must never pull in a transport package, let alone a
 * database driver, so a host can plug in `@qspecs/http`'s executor, a direct
 * `QSpec.execute` wrapper, or a test double, all without this package caring
 * which.
 */
export interface QSpecExecutor {
  execute(resource: string, context?: ExecutionContext): Promise<QSpecResult>;
}

/**
 * A parameter bag for `get`/`invalidate`/`cacheKey`. Deliberately
 * `JsonValue | undefined` at the value position — wider than
 * `ExecutionContext.parameters`'s `Record<string, unknown>` is not the point;
 * allowing `undefined` as an explicit per-key value is. A caller building
 * parameters conditionally (`{ id, filter: maybeFilter }`) routinely ends up
 * with a key whose value is `undefined` rather than the key being absent, and
 * `cacheKey` treats the two identically (see its doc comment) because
 * `execute` does too.
 */
export type QueryParameters = Record<string, JsonValue | undefined>;

/**
 * Produces a canonical string key for `(resource, parameters)`, stable
 * across key order at every nesting level. Two calls that describe the same
 * query — same resource, same parameter values, differently ordered object
 * keys anywhere in the tree — must produce the same string, because that
 * string is the `Map` key `createQueryCache` uses to decide "have I already
 * started this query" and, more importantly, to hand back the *same promise
 * object* for it (see `cache.ts`'s module doc comment for why that identity
 * matters).
 *
 * Deliberately hand-rolled rather than `JSON.stringify` with a sorted-keys
 * replacer: building the canonical form by direct string concatenation means
 * this function never once writes a caller-supplied key onto an object it
 * owns. `Object.keys` and a plain indexed *read* are the only operations
 * performed on the caller's `parameters`, both of which are safe even when a
 * key is named `__proto__`, `constructor`, or `prototype` — unlike
 * `target[key] = value`, which for `key === "__proto__"` reassigns `target`'s
 * prototype instead of creating an own property, silently corrupting the
 * object being built. A key is read only after `Object.hasOwn` confirms it
 * is the object's own property, never inherited.
 */
export function cacheKey(resource: string, parameters?: QueryParameters): string {
  return `${JSON.stringify(resource)}:${serializeObject(parameters ?? {})}`;
}

/**
 * `Array.isArray` alone does not narrow `JsonValue` the way it looks like it
 * should: `JsonValue`'s array member is `readonly JsonValue[]`, and a
 * `readonly` array is not assignable to the mutable `any[]` that
 * `Array.isArray`'s built-in signature narrows to — so in the *negative*
 * branch (the `else`, or here, whatever falls through an early return),
 * TypeScript does not exclude it from the union, and `serializeValue`'s
 * object branch below would still see `readonly JsonValue[] | {...}` instead
 * of just `{...}`. A locally declared predicate sidesteps this: its `value
 * is readonly JsonValue[]` return type is exactly `JsonValue`'s own array
 * member, so both the positive and negative branches narrow correctly.
 */
function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function serializeValue(value: JsonValue): string {
  if (value === null) return "null";
  if (isJsonArray(value)) return `[${value.map(serializeValue).join(",")}]`;
  if (typeof value === "object") return serializeObject(value);
  // string | number | boolean: JSON.stringify already produces the exact
  // canonical token (a quoted, escaped string; a bare number; true/false).
  return JSON.stringify(value);
}

/**
 * Serializes a plain object's own enumerable keys in sorted order. Used both
 * for the top-level `parameters` bag (whose values may be `undefined`, a
 * key's `execute`-equivalent of being absent — see `cacheKey`'s doc comment)
 * and, recursively via `serializeValue`, for any plain object nested inside a
 * parameter value (whose values are `JsonValue` and so can never actually be
 * `undefined` — the `undefined` branch below is defensive, not reachable
 * through the public, statically-typed surface).
 *
 * A key with an `undefined` value is a genuine narrowing (`v === undefined`
 * on a local `const`), never a cast — `noUncheckedIndexedAccess` already
 * types `obj[key]` as `JsonValue | undefined`, and asserting that away with
 * `as JsonValue` is exactly the kind of cast this package's conventions
 * forbid.
 */
function serializeObject(obj: Record<string, JsonValue | undefined>): string {
  const parts: string[] = [];
  for (const key of Object.keys(obj).sort()) {
    if (!Object.hasOwn(obj, key)) continue;
    const v = obj[key];
    if (v === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${serializeValue(v)}`);
  }
  return `{${parts.join(",")}}`;
}

interface CacheEntry {
  readonly resource: string;
  readonly promise: Promise<QSpecResult>;
}

/**
 * Holds in-flight and settled *promises*, not their results. That is the
 * whole design: React 19's `use()` requires the same promise object back on
 * every render of a component reading the same query, or React suspends,
 * re-invokes the component, gets a *new* promise, suspends again — forever,
 * with no error and no stack trace, just a component that never commits. A
 * cache of results (or one that recomputes a fresh promise around a cached
 * result before returning) does not provide that guarantee; a cache of
 * promises, returned by reference, does. Tasks 5 and 6 build the provider
 * and hooks directly on `get`'s return value for exactly this reason — they
 * have nothing to do but hand it to `use()`.
 */
export interface QueryCache {
  /**
   * Returns the promise for `(resource, parameters)`, starting the query via
   * `executor` on a cache miss and reusing the same promise object on every
   * subsequent call with an equivalent key — "equivalent" per `cacheKey`,
   * including through a rejection (see below).
   *
   * Two synchronous calls with the same key never invoke `executor` twice:
   * the miss path calls `executor.execute` and stores the resulting promise
   * in the `Map` in the same synchronous step, before returning it, so a
   * second `get` for the same key — even one issued microtasks later, before
   * the first has settled — always finds the stored entry rather than racing
   * it. (Storing the entry only *after* `await`ing the executor would lose
   * this guarantee; the third falsification in this package's report
   * confirms it.)
   *
   * A rejection is cached too, and is **not** retried by a later `get` for
   * the same key — the entry simply stays in the `Map`, rejected promise and
   * all, until something calls `invalidate`. Retrying automatically would
   * turn one failed query into a request sent on every render of every
   * component reading it, an infinite loop hidden behind whatever error
   * boundary catches the rethrow from `use()`.
   */
  get(resource: string, parameters?: QueryParameters): Promise<QSpecResult>;

  /**
   * Forgets cached entries so the next matching `get` starts a fresh query.
   *
   * - `invalidate()` — no arguments at all — drops every entry.
   * - `invalidate(resource)` — one argument — drops every entry for that
   *   resource, regardless of parameters.
   * - `invalidate(resource, parameters)` — two arguments — drops exactly the
   *   one entry matching both, even if `parameters` is itself `undefined`
   *   (the entry for "that resource, called with no parameters").
   *
   * The one- vs. two-argument distinction is real arity, not "is the second
   * value `undefined`" — `invalidate("orders", undefined)` and
   * `invalidate("orders")` are different requests. The rest-tuple parameter
   * below exists so that distinction is captured by the type checker via
   * `parametersArg.length`, rather than by reading the ambient `arguments`
   * object.
   *
   * `invalidate` only ever removes `Map` entries; it never touches an
   * in-flight promise. This cache has no `AbortController` of its own to
   * cancel with — `get`'s signature carries no `AbortSignal` — so an
   * in-flight request already running when `invalidate` is called keeps
   * running to completion. A caller already holding that promise (from an
   * earlier `get`) still sees it settle normally; a `get` issued *after* the
   * `invalidate` finds no entry and starts a new, independent request. The
   * two requests briefly overlap in flight; this cache does not deduplicate
   * across an invalidation boundary, only within one.
   */
  invalidate(resource?: string, ...parametersArg: [] | [QueryParameters | undefined]): void;
}

/**
 * Builds a `QueryCache` backed by `executor`. Entries live in a `Map` keyed
 * by `cacheKey`'s output — never a plain object keyed directly by a
 * caller-supplied string — so a resource or parameter value that happens to
 * be `__proto__` (or any other prototype-chain name) cannot collide with, or
 * be swallowed by, the cache's own storage the way `cache[key]` could.
 */
export function createQueryCache(executor: QSpecExecutor): QueryCache {
  const entries = new Map<string, CacheEntry>();

  function get(resource: string, parameters?: QueryParameters): Promise<QSpecResult> {
    const key = cacheKey(resource, parameters);
    const existing = entries.get(key);
    if (existing !== undefined) return existing.promise;

    const context: ExecutionContext | undefined =
      parameters === undefined ? undefined : { parameters };
    const promise = executor.execute(resource, context);
    entries.set(key, { resource, promise });

    // Attaches a handler to `promise` itself (not to a derived promise) so
    // Node/the browser considers it "handled" and never reports an
    // unhandledRejection — without that, a query that fails and is never
    // awaited by a caller in the same tick (e.g. a render that suspends and
    // is abandoned before the rejection is observed) would produce warning
    // noise on every rejection this cache ever stores. The original
    // `promise` reference is still what's stored above and returned below,
    // so a real caller's own `await`/`.catch`/`.then` on it still observes
    // the rejection exactly as it would with no cache in front of it at all.
    promise.catch(() => {});

    return promise;
  }

  function invalidate(
    resource?: string,
    ...parametersArg: [] | [QueryParameters | undefined]
  ): void {
    if (resource === undefined) {
      entries.clear();
      return;
    }
    if (parametersArg.length === 0) {
      for (const [key, entry] of entries) {
        if (entry.resource === resource) entries.delete(key);
      }
      return;
    }
    const [parameters] = parametersArg;
    entries.delete(cacheKey(resource, parameters));
  }

  return { get, invalidate };
}
