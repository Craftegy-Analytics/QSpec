# React Integration

`@qspecs/react` (SPEC.md §18) is a Suspense-first binding over a `QSpecExecutor` — a provider, two
public hooks built on a shared promise cache, and a thin declarative wrapper. It does not itself
talk to a server, run a query, or render a chart; `@qspecs/http`'s `createHttpExecutor` (or
`@qspecs/react`'s own `createLocalExecutor`, for a host that runs its runtime and its UI in one
process) supplies the executor, and `@qspecs/recharts` (or any renderer) consumes the resulting
`QSpecResult`. This document covers the provider, the hooks, the `<Suspense>`/error-boundary
requirement, the executor seam, and — stated plainly, because it is easy to miss — exactly how far
this package's actual API departs from SPEC.md §66's own sketch, and why.

## SPEC.md §66's example versus what shipped

SPEC.md §66 sketches a lower-level hook shape:

```ts
const { data, presentation, loading, error, refetch } = useQSpecQuery({ manifest, parameters });
```

**`useQSpecQuery` does not return this, and never has.** Its real signature
(`packages/react/src/internal/use-qspec-query.ts`):

```ts
function useQSpecQuery(resource: string, parameters?: QueryParameters): QSpecResult;
```

Two differences, each deliberate:

- **It takes a resource `name`, not a `manifest` object.** The manifest lives server-side, resolved
  by name across the HTTP boundary — see [Security](security.md#why-the-http-boundary-carries-a-resource-name-not-a-query)
  for why a manifest, a query, or anything that determines one must never reach the browser.
- **It returns the resolved `QSpecResult` directly — no `loading`, no `error`, no `refetch`.**
  - _No `loading`._ A component calling this hook is in exactly one of two committed states: it
    suspended (whatever `<Suspense fallback>` wraps it is what's on screen), or it already has the
    data. There is no third "loading but still rendering this component" state for a boolean to
    represent.
  - _No `error`._ A rejected query rethrows out of `use()`, the same way a rejected promise
    rethrows out of `await` — the nearest error boundary is what has to know about that, not this
    hook's return value.
  - _No `refetch`._ `useQSpecInvalidate()` returns an imperative `invalidate` that drops the
    matching cache entry and forces every component reading that query to re-render and refetch —
    there is no per-query `refetch` closure to call instead.

This is a deliberate, Suspense-idiomatic design, not an incomplete implementation of the spec's
sketch — `use()`'s own contract requires it (see [Promise identity, not results](#promise-identity-not-results)
below). **`docs/known-gaps.md` records this explicitly and calls SPEC.md §66's example "stale,"**
to be read as the plan's original aspiration rather than this codebase's actual API; the code and
its doc comments (`use-qspec-query.ts`, `resource.tsx`) are authoritative. `README.md`'s own
browser-path example carries the same warning inline. If a future version of this package ever
wants to offer a `{ data, loading, error }`-shaped hook for a component tree that is not
Suspense-based, it would be a second, additional hook alongside `useQSpecQuery` — not a
replacement for it, since nothing about the Suspense-based hooks' promise-identity requirement
goes away.

## The provider

```tsx
<QSpecProvider executor={executor}>{children}</QSpecProvider>
```

`QSpecProvider` (`packages/react/src/internal/provider.tsx`) owns one `QueryCache` for its entire
lifetime, built once from the `executor` prop via a `useState` initializer (deliberately not
`useMemo`, which React is allowed to discard and recompute — see the file's own comment for the
orphaned-promise hang that would follow). **`executor` is captured on this provider instance's
first render and never re-read** — a host that writes `<QSpecProvider executor={createHttpExecutor({ url })}>`
constructs a new executor object on every render of its own, and rebuilding the cache to match
would lose the promise-identity guarantee every hook under it depends on. To swap executors
deliberately (re-authenticating with a new token, for example), give the `<QSpecProvider>` element
a new `key` — that unmounts and remounts a fresh provider instance with a fresh cache, the
React-idiomatic full reset. In development, a prop-identity change with no `key` change logs one
console warning per provider instance rather than silently ignoring it.

## The Suspense-first hooks

```ts
function useQSpecExecutor(): QSpecExecutor;
function useQSpecQuery(resource: string, parameters?: QueryParameters): QSpecResult;
function useQSpecInvalidate(): QueryCache["invalidate"];
```

(`packages/react/src/internal/use-qspec-query.ts`.) All three throw a clear, hook-named error —
"`useQSpecQuery() was called outside a QSpecProvider`," and so on — when called with no enclosing
`QSpecProvider`, rather than letting a caller destructure `undefined` and hit a confusing "cannot
read properties of undefined" a few lines later.

- **`useQSpecExecutor`** returns the bound executor directly, for a caller that needs to issue a
  one-off execution outside the cache entirely (a report, a mutation that shouldn't be memoized)
  while still living inside `QSpecProvider`'s tree.
- **`useQSpecQuery(resource, parameters)`** suspends on `(resource, parameters)` and returns the
  resolved `QSpecResult`. `parameters` is compared **by content, not by reference** — `cache.get`
  derives its cache key by serializing the object (`cacheKey`, `packages/react/src/internal/cache.ts`),
  so calling this hook with a fresh object literal on every render (`useQSpecQuery("orders", { id })`,
  the ordinary way to call it) does not start a new query as long as the serialized values are
  unchanged; only a change in _content_ re-suspends and refetches.
- **`useQSpecInvalidate()`** returns an imperative `invalidate`, arity-identical to
  `QueryCache["invalidate"]`: zero arguments clears every cached query, one argument
  (`invalidate("orders")`) clears every entry for that resource regardless of parameters, and two
  arguments (`invalidate("orders", { id })`) clears exactly the one matching entry. Calling it both
  drops the matching cache entry (or entries) and forces every component under the provider that
  calls `useQSpecQuery` to re-render — a component whose query was dropped misses the cache and
  suspends on a freshly started promise; a component whose query was untouched hits the same cached
  promise it already held and commits with no visible change. There is no separate "now go
  refetch" step to remember.

## `QSpecResource`: the declarative wrapper, and what it deliberately omits

```tsx
<Suspense fallback={<Spinner />}>
  <ErrorBoundary fallback={<ErrorMessage />}>
    <QSpecResource resource="monthly-revenue" parameters={{ from, to }}>
      {(result) => <MyChart result={result} />}
    </QSpecResource>
  </ErrorBoundary>
</Suspense>
```

`QSpecResource` (`packages/react/src/internal/resource.tsx`) is a thin `resource`/`parameters`/
render-prop shell over `useQSpecQuery` — nothing more. **It provides no `<Suspense>` fallback and
no error boundary of its own.** This is a deliberate omission stated plainly in the component's own
doc comment, because the opposite is what a reader expects from a component named `QSpecResource`:
only the host knows the fallback granularity it wants (one `<Suspense>` around a whole page, or one
around each individual widget) and only the host knows where an error should surface. A
`QSpecResource` (or a raw `useQSpecQuery` call) with no enclosing `<Suspense>` boundary will crash
the nearest ancestor Suspense boundary that _does_ exist, or, with none anywhere in the tree,
produce React's own "A component suspended while responding to synchronous input" failure; with no
enclosing error boundary, a rejected query's rethrow propagates uncaught up the render tree the
same way any other render-time throw does. Wrapping every `QSpecResource` (or Suspense-reading
hook call) in both is not optional ergonomics — it is what makes the "no `loading`, no `error`"
design in the section above actually safe to rely on.

## Promise identity, not results

`createQueryCache` (`packages/react/src/internal/cache.ts`) stores a `Map<string, { resource,
promise }>` — the in-flight or settled promise itself, keyed by a canonical serialization of
`(resource, parameters)`, never the resolved value re-wrapped into a fresh `Promise.resolve(...)`
per call. This is required by how React 19's `use()` decides whether to suspend: `use()` must
receive the _same promise object_ on every render of a component reading the same query, or React
sees a promise it has never seen, suspends, re-invokes the component, gets _another_ new promise,
and suspends again — with no error, no stack trace, just a component that never commits. A
rejection is cached too, and is not retried automatically by a later call with the same key; only
`invalidate` clears it. See [`docs/architecture.md` §10.2](architecture.md#102-why-querycache-holds-promises-not-results)
for the full reasoning; this document only summarizes it because every hook above is built
directly on `get`'s return value for exactly this reason.

## The executor seam

Every hook and `QSpecProvider` is written against one small interface, not a concrete transport:

```ts
export interface QSpecExecutor {
  execute(resource: string, context?: ExecutionContext): Promise<QSpecResult>;
}
```

(`packages/react/src/internal/cache.ts`.) This is deliberately **redeclared**, not imported, from
`@qspecs/http`'s structurally identical executor type — `@qspecs/react` depends on `@qspecs/core`
(both types and, in `createLocalExecutor`, the real `QSpecError` class at runtime) and `react`
(peer), and must never pull in a transport package, let alone a database driver, purely to
describe the shape it expects (`test/boundaries.test.ts` enforces `@qspecs/react`'s browser-safety
mechanically; see [Public API](public-api.md#the-structural-half-package-boundaries)).
Two implementations ship:

- **`createHttpExecutor`** (`@qspecs/http`) — sends a `resource`/`parameters` request across a real
  HTTP boundary to a server running `createQSpecHandler`. This is the shape for a browser talking
  to a separate server process; see [Security](security.md) for what does and does not cross that
  boundary, and why it is unauthenticated by design.
- **`createLocalExecutor(runtime, manifests)`** (`@qspecs/react`,
  `packages/react/src/internal/local-executor.ts`) — resolves a resource name against a fixed
  manifest registry and calls `runtime.execute(manifest, context)` directly, with no HTTP hop at
  all. For a host that runs its `QSpec` runtime and its UI in the same process (an Electron app, a
  Node script rendering to a string, a test), this is the whole adapter. It performs the identical
  `Object.hasOwn`-based, prototype-safe name resolution `createQSpecHandler` performs server-side
  (SPEC.md §72.4), and rejects an unregistered name with the same generic, non-enumerating message
  a browser-facing 404 would give — no list of what else is registered.

A test double implementing the same two-method interface works everywhere either of these does;
nothing in `@qspecs/react` distinguishes "real HTTP," "same-process," or "test fake."

## `"use client"` and server rendering

Every export from `@qspecs/react`'s and `@qspecs/recharts`' entry points is marked `"use client"` —
a signal to RSC-aware bundlers that this code needs a client boundary, not a guarantee that it
works correctly when rendered on the server. Neither package has been exercised outside a
browser-like (jsdom) environment: `use()` suspending during a server render, streaming a suspended
boundary to the client, and hydrating a server-rendered chart are all unverified.
`docs/known-gaps.md` records this and recommends treating both as client-only until a future plan
deliberately designs and tests an SSR/RSC story.

## See also

- [`docs/known-gaps.md`](known-gaps.md#useqspecquery-deliberately-departs-from-specmd-66s-example-shape) —
  the full, original recording of the SPEC.md §66 departure, including the reproduced-hang failure
  mode a naive result cache (rather than a promise cache) would hit.
- [`docs/architecture.md` §10](architecture.md#10-qspecshttp-qspecsreact-and-qspecsrecharts) — the
  design record behind the HTTP boundary shape, the promise-cache requirement, and why
  `@qspecs/recharts` registers no core `Renderer`.
- [`docs/security.md`](security.md) — what crosses the HTTP boundary (a resource name and
  parameter values, never a query or a credential) and why the handler has no auth of its own.
- [`README.md`'s "The browser path"](../README.md#the-browser-path) — a complete, verified
  server-plus-browser example using `createQSpecHandler`, `QSpecProvider`, `QSpecResource`, and
  `QSpecChart` together.
