# QSpec React Ecosystem Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver `@qspecs/http`, `@qspecs/react`, and `@qspecs/recharts`, so a QSpec manifest renders as a chart in a browser — parameters bound, execution delegated across a trust boundary, results suspended and drawn — completing SPEC.md §101's "Renderer v1" and Phase 5.

**Architecture:** `@qspecs/http` carries execution across the browser/server boundary: the client sends a **resource name and parameters**, never a query; the server holds the manifests and runs its own runtime. `@qspecs/react` provides a Suspense-first provider and hooks over any `QSpec`-shaped executor, local or remote. `@qspecs/recharts` turns a resolved chart model into Recharts components. None of the three may import a database driver.

**Tech Stack:** TypeScript 5.8+, Node.js ≥22.19, npm workspaces, Vitest 3, React 19, Recharts 3.x (peer range `^3.0.0`; 3.10.1 installed — see line 521's note on why 2.x, the original assumption, was not what shipped), `@testing-library/react` 16, jsdom.

**Predecessors:** [`2026-08-09-qspec-foundation.md`](2026-08-09-qspec-foundation.md), [`2026-08-09-qspec-data-presentation.md`](2026-08-09-qspec-data-presentation.md), [`2026-08-10-qspec-query-runtime.md`](2026-08-10-qspec-query-runtime.md) — all merged. 831 tests.
**Design document:** [`../specs/2026-08-09-qspec-design.md`](../specs/2026-08-09-qspec-design.md)
**Carried gaps:** [`../../known-gaps.md`](../../known-gaps.md)
**Source specification:** `SPEC.md` — §18, §19, §48, §65, §66, §67, §73, §74, §101, §104

**Depends on:** the `fix/node-22-floor` change must land first. `test/boundaries.test.ts` asserts every published manifest declares an identical `engines` value, so three new packages created against the old floor would collide with that guard.

---

## Decisions made for this plan

Seven calls. Three came from the user directly; the rest follow from them or from the security shape of the problem.

### 1. Suspense-first hooks, deliberately departing from SPEC.md §66

SPEC.md §66 documents this shape:

```ts
const { data, presentation, loading, error, refetch } = useQSpecQuery({ manifest, parameters });
```

**We are not building that.** `useQSpecQuery` will call React 19's `use()` on a cached promise, so a pending query suspends and a failed one throws to the nearest error boundary. `loading` and `error` cease to exist as values.

This was chosen knowingly. What it costs: the spec's example becomes wrong and must be corrected in SPEC.md's wake (this plan does not edit SPEC.md — it records the divergence in `docs/known-gaps.md`), every consumer needs a `<Suspense>` boundary and an error boundary, and React 19 becomes a hard floor for the React packages. What it buys: no loading-state plumbing in user code, correct behavior under concurrent rendering, and a single code path rather than a state machine.

`refetch` survives, as an imperative invalidate-and-refresh on the cache (Task 5).

### 2. The HTTP boundary never carries a query — this is the most important decision here

The obvious reading of "an HTTP data source" is a `DataSource` implementation that POSTs its compiled query to a server. **That design is unsafe and this plan does not build it.**

A `DataSource` receives an already-compiled query. For `@qspecs/sql` that is SQL text plus values. Putting it on the wire from a browser means the browser dictates the SQL and the server executes what arrives — remote SQL execution offered as a feature. No amount of validation on the receiving end recovers this: the client is untrusted, and a compiled query is by construction executable.

So `@qspecs/http` is **not a `DataSource`**. The wire carries:

```ts
interface QSpecExecuteRequest {
  readonly resource: string;                          // a name the SERVER resolves
  readonly parameters?: Record<string, JsonValue>;
}
```

The server owns a registry of manifests, resolves `resource` against it, and runs its own runtime with its own credentials. Parameters are validated by core against the manifest's declarations exactly as they are locally — that machinery already exists and is the reason this is safe. An unknown `resource` is rejected without disclosing what else is registered.

This means the browser never holds a connection string, never composes a query, and cannot reach a table the manifest does not name. It also means `@qspecs/http`'s client is not interchangeable with a local runtime at the `DataSource` seam — it substitutes at the *resource execution* seam, which is what `@qspecs/react` consumes anyway (decision 4).

### 3. One package, one entry point, both halves

`@qspecs/http` exports both `createQSpecHandler` (server) and `createHttpExecutor` (client) from a single entry. It stays browser-safe because the handler has **no server-only dependencies** — it takes a `QSpec` runtime the host already built, and speaks Web-standard `Request`/`Response`, which Node ≥22.19 provides natively. With ESM and `"sideEffects": false`, a browser bundle that imports only the client drops the handler.

This preserves the standing constraint that `exports` expose only `.` and `./package.json`, and avoids splitting into two packages that would always be versioned together. The Node 22 floor from `fix/node-22-floor` is what makes the no-polyfill Web-standard handler viable — a happy consequence of an unrelated change.

### 4. `@qspecs/react` depends on an executor interface, not on `QSpec`

The provider accepts anything satisfying:

```ts
interface QSpecExecutor {
  execute(resource: string, context?: ExecutionContext): Promise<QSpecResult>;
}
```

`createHttpExecutor` implements it directly. A local `QSpec` runtime does **not** satisfy it as-is — core executes a *manifest*, while this seam addresses a *resource name* — so `@qspecs/react` also ships `createLocalExecutor(runtime, manifests)`, the same name→manifest indirection the server handler performs, for hosts running everything in one process. Both sides of the seam therefore resolve names identically, which is what lets a test swap a local executor for a remote one and prove the React layer is transport-agnostic.

Without this seam the React package would depend on `@qspecs/core`'s full runtime surface and could not talk to a server at all, and every test would need a real runtime.

`@qspecs/react` therefore has **no dependency on `@qspecs/postgres`, `@qspecs/sql`, or `@qspecs/http`** — only on `@qspecs/core` for types.

### 5. Stable promise identity is the central technical risk

`use()` requires the *same promise object* across renders. Return a fresh promise each render and React suspends forever, re-invoking the component in a loop that never settles — and it fails as a hang, not an error, which is the worst failure shape to debug.

So the provider owns a cache keyed by `(resource, serialized parameters)` holding the promise itself, not the result. The cache is the load-bearing component of `@qspecs/react` and gets its own task (Task 4) before any hook is written on top of it. Its tests must include: the same key returning an identical promise by reference across renders, a changed key producing a different one, and a rejected entry not being retried on every render.

Parameter serialization must be **order-independent** — `{a:1,b:2}` and `{b:2,a:1}` are the same query and must hit the same cache entry.

### 6. `@qspecs/recharts` ships React components, not a core `Renderer`

SPEC.md §65's `Renderer` interface exists so rendering can happen outside query execution — for SVG, PNG, CLI, and PDF outputs. A React chart is not naturally that shape: it is a component tree the host composes, not a value a registry produces.

So `@qspecs/recharts` exports components (`<QSpecChart>` and per-type variants) built on `@qspecs/charts`' `resolveSeries`, and registers no `Renderer`. The `Renderer` interface stays for the non-React outputs it was designed for. This is recorded so a later reader does not read the absence as an oversight.

### 7. Client components only; jsdom per-file, not globally

The React packages are client-side. Entry points carry the `"use client"` directive so they work as islands in a Next.js app router, and no SSR, hydration, or RSC serialization work is in scope.

Vitest's global `environment` stays `"node"`. React test files opt in per file with a `// @vitest-environment jsdom` docblock. Flipping the whole suite to jsdom would slow 831 existing tests and change the environment under code that has been verified in Node.

---

## Global Constraints

- **`@qspecs/core` keeps ZERO runtime dependencies.** This plan should not need to modify core at all; if a task believes it must, that is a finding to raise before writing code.
- **No new package may import a database driver.** All three are browser-safe and must be enrolled in `test/boundaries.test.ts`'s `BROWSER_SAFE` set, which already scans both manifests and source imports.
- **The browser never sends a query, a connection string, or SQL** (SPEC.md §9, §72.1, §72.2). The only client-supplied values on the wire are a resource name and parameter values.
- **Never log or serialize credentials or bound values** (SPEC.md §72.6). Server error responses must not echo the driver's message; map to a code and a safe message, exactly as `@qspecs/postgres` does with `QueryExecutionError`.
- **A `Dataset` must survive JSON round-trip.** Core converts top-level `Date` cells to ISO strings for this reason (`normalize-result.ts`), but explicitly leaves Dates nested inside `object`/`array` values alone. That nested case is a real hazard for this transport and must be tested, not assumed.
- ESM only; `"sideEffects": false`; `"license": "MIT"`; `"engines": { "node": ">=22.19" }`; version `0.1.0`; `"publishConfig": { "access": "public" }`; `exports` exposing only `.` and `./package.json`.
- React and Recharts are `peerDependencies`, never `dependencies`. React 19 is the floor.
- No `eval`, no `new Function`. `.js` on relative imports; `import type` for type-only.
- No `any`, `@ts-ignore`, `@ts-expect-error`, non-null assertions, or casts that strip `undefined` from an indexed access — implementation OR tests. Registry-widening casts are permitted.
- Never bracket-access a caller-supplied object with a caller-supplied name without `Object.hasOwn`. This applies directly to the parameter maps crossing the wire.
- **Tests must be able to fail.** For every case marked "falsify", break the code it guards, confirm the test fails, restore, and report. Roughly twenty-five tests that could not fail have been found across the previous three plans; every task of the last one contained at least one.
- Local commits only — **never `git push`**, never add or modify a remote.

---

## Existing contracts you must build against

Copied verbatim from merged packages. Do not guess these.

```ts
// @qspecs/core
interface QSpec {
  use(plugin: QSpecPlugin): QSpec;
  ready(): Promise<void>;
  prepare(manifest: QSpecManifest<QSpecResourceSpec> | string | unknown): Promise<PreparedResource>;
  execute(manifest: ..., context?: ExecutionContext): Promise<QSpecResult>;
  on: HookRegistry["on"];
  dispose(): Promise<void>;
  readonly limits: QSpecLimits;
}

interface PreparedResource {
  readonly manifest: QSpecManifest<QSpecResourceSpec>;
  readonly kind: string;
  readonly name: string;
  readonly projectedFields: readonly string[] | undefined;
  execute(context?: ExecutionContext): Promise<QSpecResult>;
}

interface QSpecResult {
  readonly data: Dataset;
  readonly presentation?: PresentationDefinition;
  readonly meta: ExecutionMetadata;
}

interface ExecutionContext {
  readonly parameters?: Record<string, unknown>;
  readonly signal?: AbortSignal;
  readonly locale?: string;
  readonly timezone?: string;
  readonly metadata?: Record<string, unknown>;
}

interface Dataset {
  readonly fields: readonly Field[];
  readonly rows: readonly DatasetRow[];   // DatasetRow = Record<string, unknown>
  readonly metadata?: DatasetMetadata;
}
```

Four points that matter:

- **`prepare()` is the expensive half and it is cacheable.** A server handler should prepare once per resource and execute many times — that split is the whole reason it exists (SPEC.md §81).
- **Core validates parameters against the manifest's declarations.** The server does not need to re-invent parameter validation; handing untrusted parameters to `execute()` is safe *because* of it. Do not bypass it.
- **`QSpecResult.meta` carries `durationMs`, source, and language** and no bound values — verified during Plan 3. It is safe to serialize as-is, but a test should pin that rather than trust it.
- **`resolveSeries`** in `@qspecs/charts` turns a `Dataset` plus a chart presentation into series; `@qspecs/recharts` consumes it and must not re-derive series itself.

---

## File Structure

```
packages/
├── http/                             browser + server; NO db drivers
│   ├── package.json
│   ├── tsconfig.build.json
│   └── src/
│       ├── index.ts                  createQSpecHandler + createHttpExecutor + wire types
│       └── internal/
│           ├── protocol.ts           request/response types, codes, parse + guard
│           ├── handler.ts            Request -> Response, manifest registry, error mapping
│           └── executor.ts           fetch client, abort, error reconstruction
├── react/                            browser/React; peer react
│   ├── package.json
│   ├── tsconfig.build.json
│   └── src/
│       ├── index.ts                  "use client"; provider, hooks, component
│       └── internal/
│           ├── cache.ts              promise cache, stable identity, key derivation
│           ├── provider.tsx          QSpecProvider + context
│           ├── use-qspec-query.ts    Suspense hook over the cache
│           └── resource.tsx          QSpecResource component
└── recharts/                         browser/React; peer react + recharts
    ├── package.json
    ├── tsconfig.build.json
    └── src/
        ├── index.ts                  "use client"; QSpecChart + variants
        └── internal/
            ├── cartesian.tsx         line / bar / area
            └── pie.tsx               pie
```

Plus modifications: root `tsconfig.json`, `test/boundaries.test.ts`, `README.md`, `docs/architecture.md`, `docs/known-gaps.md`, `.github/workflows/ci.yml`, root `package.json` (devDependencies for React testing).

---

## How this plan specifies tests

Test cases are enumerated case-by-case with their exact expected behavior; you write them following the patterns in `packages/transforms/src/internal/*.test.ts` and `packages/postgres/src/internal/*.test.ts`.

Where a task says "falsify", break the code the test guards, confirm it fails, restore, and report. If a falsification does **not** produce a failure, that is information about the test, not proof the code is fine — diagnose why the mutation was not exercised and strengthen the case.

React adds a failure mode the previous plans did not have: **a test that hangs rather than fails.** A Suspense boundary that never resolves produces a timeout, not an assertion failure, and a timeout reads like a slow machine. Any test that awaits a suspended render must assert on settled output, and any task touching the cache must include a case that would hang under a broken implementation — run it once deliberately broken to see what the failure looks like, and report that.

---

### Task 1: `@qspecs/http` scaffolding and the wire protocol

The protocol is the trust boundary. Everything else in this plan assumes it holds.

**Files:**
- Create: `packages/http/package.json`, `packages/http/tsconfig.build.json`
- Create: `packages/http/src/internal/protocol.ts`
- Test: `packages/http/src/internal/protocol.test.ts`
- Modify: root `tsconfig.json`

**Interfaces:**
- Consumes: `JsonValue`, `QSpecResult`, `Dataset` from `@qspecs/core` (types only).
- Produces: `QSpecExecuteRequest`, `QSpecExecuteResponse`, `QSpecErrorBody`, `parseExecuteRequest(value): QSpecExecuteRequest`.

- [ ] **Step 1: Create the package**

`peerDependencies`: `@qspecs/core`. No `dependencies` key at all. `devDependencies`: `@qspecs/core`.

`tsconfig.build.json` mirrors `packages/sql/`. Add the reference to root `tsconfig.json`.

- [ ] **Step 2: Define the wire types**

```ts
export interface QSpecExecuteRequest {
  /** A name the SERVER resolves against its own manifest registry. */
  readonly resource: string;
  readonly parameters?: Record<string, JsonValue>;
}

export interface QSpecErrorBody {
  readonly code: string;      // a QSpec error code, never a driver message
  readonly message: string;
  readonly issues?: readonly { path: readonly (string | number)[]; message: string }[];
}

export type QSpecExecuteResponse =
  | { readonly ok: true; readonly result: QSpecResult }
  | { readonly ok: false; readonly error: QSpecErrorBody };
```

There is deliberately no field for a query, a statement, a source name, or a connection string. A reviewer should be able to confirm the trust property by reading this type alone.

- [ ] **Step 3: Write `parseExecuteRequest` and its tests**

It takes `unknown` (whatever `JSON.parse` produced) and either returns a valid request or throws with a precise message. It is the only thing standing between the network and `execute()`.

Cases:
- a minimal valid request (`{resource: "x"}`) parses, with `parameters` absent
- a valid request with parameters parses and preserves values
- a non-object, `null`, and an array are each rejected
- a missing or non-string `resource` is rejected
- an empty-string `resource` is rejected
- `parameters` present but not a plain object is rejected
- **a `parameters` key of `__proto__`, `constructor`, or `prototype` is rejected** — parameters cross a trust boundary and are later used to index objects; core's manifest validation rejects these names, and this must too
- a parameter value that is not JSON (a function is impossible post-`JSON.parse`, but `undefined` nested in an array is) — pin what happens
- extra unknown top-level keys are ignored rather than rejected, so a newer client can talk to an older server

**Falsify:** remove the prototype-key rejection and confirm that test fails.

- [ ] **Step 4: Verify and commit**

```bash
npm run build && npx vitest run packages/http
git add -A packages/http tsconfig.json
git commit -m "feat(http): add the QSpec execution wire protocol"
```

---

### Task 2: The server handler

**Files:**
- Create: `packages/http/src/internal/handler.ts`
- Test: `packages/http/src/internal/handler.test.ts`

**Interfaces:**
- Produces: `createQSpecHandler(options): (request: Request) => Promise<Response>`

```ts
export interface QSpecHandlerOptions {
  /** The server's own runtime, with its own credentials. */
  readonly runtime: QSpec;
  /** The only manifests this endpoint will execute, by resource name. */
  readonly manifests: Readonly<Record<string, QSpecManifest<QSpecResourceSpec> | string>>;
}
```

- [ ] **Step 1: Implement**

The handler:
1. Accepts only `POST`; anything else is `405`.
2. Parses the body as JSON, then through `parseExecuteRequest`. A parse failure is `400` with `code: "QSPEC_BAD_REQUEST"`.
3. Resolves `resource` against `manifests` **using `Object.hasOwn`**. An unknown resource is `404` with a message that does **not** enumerate the registered names.
4. Prepares the manifest **once per resource** and caches the `PreparedResource` — `prepare()` is the expensive half (SPEC.md §81).
5. Executes with the request's parameters and the request's `AbortSignal`, so a disconnected client cancels the query.
6. Maps the outcome: success to `200 {ok:true,result}`; a `ManifestValidationError` to `400` with its issues; a `QSpecAbortError` to `499`; anything else to `500` with a **generated** message and the QSpec error code, never the driver's text.

- [ ] **Step 2: Tests**

Build the runtime from `@qspecs/testing`'s `memory()` — no database.

- a valid request returns `200` and a body whose `result.data` matches the source
- a `GET` returns `405`
- a malformed body returns `400` and does not reach the runtime (assert `memory()`'s call recorder is empty)
- an unknown resource returns `404`, **and the body does not contain any registered resource name** — falsify by echoing the registry and confirming the test fails
- a parameter violating the manifest's declared type returns `400` with issues carrying paths
- **the same resource requested twice prepares once** — assert via a spy or the runtime's hook events; this is the prepare-once property and nothing else tests it
- an adapter failure returns `500` whose body contains neither the connection string nor the driver's message — build the failing source with a driver-shaped error containing a password and assert on the response text
- aborting the request's signal mid-flight propagates: the runtime sees an aborted signal
- concurrent requests for two different resources do not interfere

**Falsify:** remove the `Object.hasOwn` guard on the registry lookup and confirm a request for `resource: "constructor"` is caught by a test.

- [ ] **Step 3: Verify and commit**

```bash
npm run build && npx vitest run packages/http
git commit -m "feat(http): add the server execution handler"
```

---

### Task 3: The client executor

**Files:**
- Create: `packages/http/src/internal/executor.ts`, `packages/http/src/index.ts`
- Test: `packages/http/src/internal/executor.test.ts`, `packages/http/src/index.test.ts`

**Interfaces:**
- Produces: `createHttpExecutor(options): QSpecExecutor`

```ts
export interface HttpExecutorOptions {
  readonly url: string;
  /** Injected for tests and for hosts with their own fetch. */
  readonly fetch?: typeof globalThis.fetch;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface QSpecExecutor {
  execute(resource: string, context?: ExecutionContext): Promise<QSpecResult>;
}
```

- [ ] **Step 1: Implement**

POSTs `{resource, parameters}`, forwards `context.signal`, and on a non-OK response reconstructs a `QSpecError` of the right class from `error.code` so callers can `instanceof` it the same way they would locally. An abort surfaces as `QSpecAbortError`.

- [ ] **Step 2: Tests**

Drive it against the real handler from Task 2, in process, by passing a `fetch` that calls the handler directly. This is the highest-value shape available without a network: the protocol is exercised end to end, both halves, with no mock of either side.

- a successful round trip returns a `QSpecResult` deep-equal to what the server produced
- **a `Dataset` survives the round trip** — including a `datetime` field, a `null`, a `number` that is not an integer, and a `numeric`-style precision string
- **a Date nested inside an `object`-typed cell does not survive as a Date** — core converts only top-level cells (`normalize-result.ts` says so). Assert the actual post-JSON shape and pin it, and record the limitation in the package's doc comment. Do not "fix" it here; that would be a core change.
- a `400` becomes a `ManifestValidationError` with its issues intact
- a `500` becomes a `QueryExecutionError` whose message is the server's safe text
- an aborted signal rejects with `QSpecAbortError` and the request is actually cancelled
- a non-JSON response body fails with a clear error rather than a `SyntaxError`
- `headers` are sent

**Falsify:** make the client ignore `context.signal` and confirm the abort test fails.

- [ ] **Step 3: Verify and commit**

```bash
npm run build && npm run typecheck:tests && npx vitest run packages/http
git commit -m "feat(http): add the client executor"
```

---

### Task 4: `@qspecs/react` scaffolding and the promise cache

The cache is where Suspense is won or lost. It gets its own task, and it is written and tested **before** any hook consumes it.

**Files:**
- Create: `packages/react/package.json`, `packages/react/tsconfig.build.json`
- Create: `packages/react/src/internal/cache.ts`
- Test: `packages/react/src/internal/cache.test.ts`
- Modify: root `tsconfig.json`, root `package.json` (add `react`, `react-dom`, `@testing-library/react`, `jsdom` as devDependencies)

**Interfaces:**
- Produces: `createQueryCache(executor): QueryCache` with `get(resource, parameters): Promise<QSpecResult>` and `invalidate(resource?, parameters?): void`.

- [ ] **Step 1: Create the package**

`peerDependencies`: `@qspecs/core`, `react` (`>=19`). No `dependencies`. `devDependencies`: `@qspecs/core`, `@qspecs/testing`, `react`, `react-dom`, `@testing-library/react`.

- [ ] **Step 2: Key derivation**

The cache key is `(resource, parameters)`. Serialization must be **order-independent**: `{a:1,b:2}` and `{b:2,a:1}` are the same query.

Write `cacheKey(resource, parameters): string` with sorted keys, recursively. Tests:
- reordered top-level keys produce the same key
- reordered keys **nested inside an object parameter** produce the same key
- different values produce different keys
- `undefined` and a missing key produce the same key (they mean the same thing to `execute`)
- `null` and `undefined` produce *different* keys — `null` is a value
- a parameter named `__proto__` does not corrupt the key or the cache map (use a `Map`, not an object)

- [ ] **Step 3: The cache itself**

Tests — these are the ones that matter:
- **the same key returns the identical promise by reference** across repeated `get` calls. This is what makes `use()` work; falsify by returning a fresh promise each call and confirm this fails.
- a different key returns a different promise
- **a rejected entry is not retried automatically** — call `get` twice after a rejection and assert the executor ran once. An implementation that retries on every render turns one failure into an infinite request loop behind an error boundary.
- `invalidate(resource, parameters)` drops exactly that entry; the next `get` calls the executor again and returns a *new* promise
- `invalidate(resource)` drops every entry for that resource regardless of parameters
- `invalidate()` drops everything
- the executor is called exactly once for two concurrent `get`s of the same key

- [ ] **Step 4: Falsify and commit**

Run all three falsifications named above. Report what the stable-identity failure looks like — under a broken cache the *hook* tests in Task 5 would hang rather than fail, and knowing that signature in advance is worth a paragraph in the report.

```bash
git commit -m "feat(react): add the suspense-safe query cache"
```

---

### Task 5: `QSpecProvider` and `useQSpecQuery`

**Files:**
- Create: `packages/react/src/internal/provider.tsx`, `packages/react/src/internal/use-qspec-query.ts`, `packages/react/src/index.ts`
- Test: `packages/react/src/internal/use-qspec-query.test.tsx`

Test files that render need `// @vitest-environment jsdom` at the top.

**Interfaces:**
- Produces: `QSpecProvider`, `useQSpecExecutor`, `useQSpecQuery(resource, parameters?)`, `useQSpecInvalidate()`, `createLocalExecutor(runtime, manifests)`.

- [ ] **Step 1: Implement**

`QSpecProvider` takes `executor` and owns one `createQueryCache` for its lifetime (`useState` initializer, not `useMemo` — `useMemo` is a performance hint and may be discarded, which would silently reset the cache).

`useQSpecQuery` derives the key, calls `cache.get`, and returns `use(promise)`. It returns `QSpecResult` directly — no `loading`, no `error`, per decision 1.

`index.ts` begins with `"use client"`.

`createLocalExecutor(runtime, manifests)` performs the same name→manifest resolution the server handler does — `Object.hasOwn` against the map, unknown name rejected without enumerating the registry — and calls `runtime.execute(manifest, context)`. It exists so a single-process host can use the React layer without an HTTP hop, and so the hook tests can run against a real runtime with no transport. Its resolution behavior must match the handler's; a test asserting both reject an unknown name the same way is worth more than two separate tests.

- [ ] **Step 2: Tests**

- a component suspends, then renders the resolved data — assert on the settled DOM, never on a spinner alone
- **changing parameters re-suspends and renders the new data**, and the executor was called twice
- **re-rendering with the same parameters does not call the executor again**
- a rejected query propagates to an error boundary, and the boundary renders its fallback
- `useQSpecQuery` outside a provider throws a clear error naming the missing provider
- `useQSpecInvalidate()` followed by a re-render refetches
- two components using the same resource and parameters share one execution

**Falsify:** make the provider build its cache with `useMemo(() => createQueryCache(executor), [])` and a deliberately dropped memo, confirming the shared-execution test fails. If that proves awkward to simulate, instead falsify by keying the cache on object identity rather than serialized parameters, and confirm the "same parameters do not refetch" test fails.

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(react): add the provider and the suspense query hook"
```

---

### Task 6: `QSpecResource`

**Files:**
- Create: `packages/react/src/internal/resource.tsx`
- Test: `packages/react/src/internal/resource.test.tsx`

SPEC.md §66's declarative form:

```tsx
<QSpecResource resource="monthly-revenue" parameters={{ from, to }}>
  {(result) => <MyChart result={result} />}
</QSpecResource>
```

- [ ] **Step 1: Implement**

A thin component over `useQSpecQuery` taking a render-prop child. It does **not** provide its own `<Suspense>` or error boundary — the host places those, because only the host knows the right fallback granularity. Say so in the doc comment; a reader will expect the opposite.

- [ ] **Step 2: Tests**

- renders its child with the result
- suspends until resolved
- an inline `parameters` object literal (a new object every render) does **not** cause a refetch loop — this is the single most likely real-world misuse, and the order-independent key from Task 4 is what saves it. Falsify by keying on object identity and confirm this test fails.
- an error reaches the host's boundary

- [ ] **Step 3: Commit**

---

### Task 7: `@qspecs/recharts` scaffolding and cartesian charts

**Files:**
- Create: `packages/recharts/package.json`, `packages/recharts/tsconfig.build.json`
- Create: `packages/recharts/src/internal/cartesian.tsx`, `packages/recharts/src/index.ts`
- Test: `packages/recharts/src/internal/cartesian.test.tsx`
- Modify: root `tsconfig.json`

`peerDependencies`: `@qspecs/core`, `@qspecs/charts`, `react` (`>=19`), `recharts`. No `dependencies`.

**Verify the Recharts/React 19 pairing before writing components, not after.** Recharts' React 19 support landed across a version boundary, and the plan's "Recharts 2.x" is an assumption, not a checked fact. Install it, render one trivial chart under React 19 in jsdom, and confirm it works before building on it. If 2.x does not support React 19 cleanly, use 3.x and say so — and if neither does, stop and report rather than pinning React back, since React 19 is load-bearing for the Suspense decision.

- [ ] **Step 1: Implement line, bar, and area**

Each consumes `resolveSeries` from `@qspecs/charts` — do **not** re-derive series from the dataset. Map the resolved model onto `<LineChart>`/`<BarChart>`/`<AreaChart>` with `<XAxis>`, `<YAxis>`, and one `<Line>`/`<Bar>`/`<Area>` per series.

- [ ] **Step 2: Tests**

Recharts renders SVG and requires a sized container in jsdom; use an explicit `width`/`height` rather than `<ResponsiveContainer>` in tests, and say why in a comment.

- a two-series line chart renders one `<Line>` per series with the resolved data
- axis labels come from the presentation, not from field names, when the presentation supplies them
- a series whose field is absent from the dataset is a loud error, not a silently empty chart
- an empty dataset renders an empty chart rather than throwing
- the component does not mutate the dataset it is given

- [ ] **Step 3: Falsify and commit**

Falsify the "one `<Line>` per series" assertion by rendering only the first series.

---

### Task 8: Pie charts and the presentation-type sweep

**Files:**
- Create: `packages/recharts/src/internal/pie.tsx`
- Test: `packages/recharts/src/internal/pie.test.tsx`

- [ ] **Step 1: Implement pie**

Pie has no `y` axis — a fact already established in `@qspecs/charts` during Plan 2. Do not synthesize one.

- [ ] **Step 2: Tests**

- a pie renders one `<Cell>` per category
- the value field drives the slice values
- a pie presentation missing its category field is a loud error

- [ ] **Step 3: Cover every presentation type `@qspecs/charts` registers**

Enumerate the presentation types the charts package registers and assert that `<QSpecChart>` handles each. **An unknown or unhandled type must throw a named error, not render nothing.** A chart that silently renders blank is the failure users report as "it doesn't work" with nothing to go on.

Falsify: add a presentation type to the registry without a component and confirm the sweep fails.

---

### Task 9: The full browser loop against a real database

One test proving the whole path for the first time: a manifest on a server with a real PostgreSQL, an HTTP handler, an HTTP executor in a jsdom "browser", React suspending, and a Recharts chart in the DOM.

**Files:**
- Create: `test/react-pipeline.test.tsx`

- [ ] **Step 1: Wire it**

Server side: `createQSpec().use(sql()).use(postgres({...})).use(transforms()).use(charts())` against a testcontainer, wrapped in `createQSpecHandler`.
Client side: `createHttpExecutor` with a `fetch` that calls the handler, inside `QSpecProvider`, rendering `<QSpecResource>` around a `<QSpecChart>`.

Follow the container setup, skip detection, and timeout conventions in `packages/postgres/test/integration.test.ts`. Skip cleanly without Docker, with a message naming what is unverified.

- [ ] **Step 2: Assert**

- the chart's SVG contains a point per row returned by PostgreSQL
- the values in the DOM match the database's values after the transform chain
- **no SQL, connection string, or password appears anywhere in the client-side code path** — assert on the serialized request body and on the rendered DOM
- changing a parameter re-executes and updates the DOM

- [ ] **Step 3: Commit**

---

### Task 10: Documentation, CI, and gap closure

- [ ] **Step 1: Enroll the new packages in the boundary guard**

Add `@qspecs/http`, `@qspecs/react`, and `@qspecs/recharts` to `BROWSER_SAFE` in `test/boundaries.test.ts`. The guard asserts every named package matched a real package, so a typo fails loudly. Falsify by adding `pg` to one of them.

- [ ] **Step 2: Documentation**

- **README**: add the three packages; mark `@qspecs/react`/`@qspecs/recharts` shipped. The quick start should now show the browser path end to end.
- **`docs/architecture.md`**: record *why* the HTTP boundary carries a resource name rather than a query (decision 2 — this is the one a future contributor is most likely to "simplify" into a vulnerability), why the cache holds promises rather than results, and why `@qspecs/recharts` registers no `Renderer`.
- **`docs/known-gaps.md`**: record that `useQSpecQuery` deliberately departs from SPEC.md §66's `{loading, error, refetch}` shape and that SPEC.md's example is now stale; that Dates nested inside `object`/`array` cells do not survive the HTTP round trip; that no SSR/RSC support exists; and that automatic parameter forms (SPEC.md §67) remain unbuilt.

- [ ] **Step 3: CI**

React tests need jsdom, which is a per-file docblock rather than a config change — confirm they actually run in CI rather than being silently skipped by a glob. Confirm the pack step still skips private packages and packs the three new public ones.

- [ ] **Step 4: Full clean verification**

```bash
npm run clean && rm -rf node_modules && npm ci
npm run format:check && npm run build && npm run typecheck:tests && npx vitest run
```

- [ ] **Step 5: Commit**

---

## Definition of Done

1. `npm ci && npm run build && npm run typecheck:tests && npx vitest run` passes from a clean clone, with and without Docker.
2. `@qspecs/core` still has zero runtime dependencies; none of the three new packages depends on a database driver, and all three are enrolled in the boundary guard.
3. A manifest renders as a chart in a jsdom browser, fed by a real PostgreSQL across an HTTP boundary.
4. **The browser never transmits a query, a source name, or a credential** — proven by asserting on the serialized request body, not by inspection.
5. A suspended query resolves to settled DOM; a failed one reaches an error boundary; neither hangs.
6. The same parameters, passed as a fresh object literal on every render, do not cause a refetch.
7. An unknown or unhandled presentation type throws a named error rather than rendering blank.
8. `docs/known-gaps.md` records the SPEC.md §66 divergence.

### SPEC.md coverage

| Requirement | Where |
|---|---|
| §18 `@qspecs/react` provides framework integration | Tasks 4–6 |
| §18 must not require a particular chart library | Task 4 (react depends on neither charts nor recharts) |
| §19 `@qspecs/recharts` renders chart models via Recharts | Tasks 7–8 |
| §65 rendering stays outside query execution | Tasks 7–8 |
| §66 React integration, provider + hook | Tasks 5–6 (with decision 1's divergence) |
| §73 server/browser separation | Tasks 1–3, 10 |
| §74 tree shaking (`sideEffects: false`, ESM, exports) | all |
| §101 Renderer v1: React + Recharts | Tasks 7–9 |

### Deliberately out of scope

- **Automatic parameter forms (SPEC.md §67).** The spec calls them future work and says they belong outside core.
- **SSR and React Server Components** — decision 7.
- **A `Renderer` registration for React** — decision 6; the interface remains for SVG/PNG/CLI/PDF.
- **Authentication on the HTTP endpoint.** The handler is unauthenticated by design; the host mounts it behind its own auth, exactly as it supplies its own connection string. This must be stated plainly in the README, because an unauthenticated endpoint that executes server-side queries is a serious mistake to make by omission.
- **Caching policy beyond identity** — no TTL, no stale-while-revalidate, no background refresh. `invalidate` is the whole API.
