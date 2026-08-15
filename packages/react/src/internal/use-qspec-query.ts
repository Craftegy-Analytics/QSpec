import { use } from "react";
import type { QSpecResult } from "@qspecs/core";
import { useQSpecContext } from "./provider.js";
import type { QSpecExecutor, QueryCache, QueryParameters } from "./cache.js";

/**
 * Returns the `QSpecExecutor` the enclosing `QSpecProvider` was constructed
 * with — the same object `createLocalExecutor`, an HTTP-backed executor, or
 * a test double would produce. For a caller that needs to issue an
 * execution outside the cache entirely (a one-off report, a mutation that
 * shouldn't be memoized), while still living inside `QSpecProvider`'s tree.
 *
 * Throws, naming itself, when called outside a `QSpecProvider` — see
 * `useQSpecContext` in provider.ts.
 */
export function useQSpecExecutor(): QSpecExecutor {
  return useQSpecContext("useQSpecExecutor").executor;
}

/**
 * Suspends on `(resource, parameters)` and returns the resolved
 * `QSpecResult` directly. There is no `{ data, loading, error }` wrapper,
 * and that is deliberate, not an omission:
 *
 * - No `loading`: a component calling this hook either hasn't committed yet
 *   — it's suspended, and whatever `<Suspense fallback>` wraps it is on
 *   screen instead — or it already has the data. Those are the only two
 *   states a committed render of this component can ever be in.
 * - No `error`: a rejected query rethrows out of `use()`, exactly the way a
 *   rejected promise rethrows out of `await` in an async function. The
 *   nearest error boundary is what has to know about that, not this hook's
 *   return type.
 *
 * `parameters` is compared by *content*, not by reference: `cache.get`
 * (cache.ts) derives its cache key by serializing it (`cacheKey`), so
 * calling this hook with a fresh object literal on every render —
 * `useQSpecQuery("orders", { id })`, the ordinary way to call it — does not
 * start a new query as long as the serialized values are unchanged. Only a
 * change in content re-suspends and refetches; a change in object identity
 * alone does not.
 *
 * Throws, naming itself, when called outside a `QSpecProvider`.
 */
export function useQSpecQuery(resource: string, parameters?: QueryParameters): QSpecResult {
  const { cache } = useQSpecContext("useQSpecQuery");
  return use(cache.get(resource, parameters));
}

/**
 * Returns an imperative `invalidate`, arity-identical to
 * `QueryCache.invalidate` (see cache.ts: zero arguments clears everything,
 * one clears a resource, two clear one exact entry), bound to the enclosing
 * provider's cache.
 *
 * Calling it does two things: it drops the matching cache entr(y/ies), and
 * it forces every component under the provider that calls `useQSpecQuery`
 * to re-render (see `QSpecProvider`'s doc comment for how, since
 * `QueryCache` itself has no subscription mechanism). A component whose
 * query was dropped misses the cache on that re-render and suspends on a
 * freshly started promise; a component whose query was untouched hits the
 * same cached promise it already held and commits with no visible change.
 * There is no separate "now go refetch" step for a caller to remember —
 * invalidating already implies the next render refetches, for every
 * component reading that data, not only the one that called this hook.
 *
 * Throws, naming itself, when called outside a `QSpecProvider`.
 */
export function useQSpecInvalidate(): QueryCache["invalidate"] {
  return useQSpecContext("useQSpecInvalidate").invalidate;
}
