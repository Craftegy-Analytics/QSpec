# Data Sources

A data source is what turns a compiled query into rows. It is a plugin-registered capability, not
part of `@qspecs/core` (SPEC.md §6) — `@qspecs/core` ships no data source at all, and a manifest's
`spec.query.source` names one a host has configured, never infrastructure the manifest carries
itself (SPEC.md §9, §72.1). This document covers the `DataSource` interface, what
`supportedLanguages` means and why omitting it is the compatible default, the contract suite every
adapter is checked against, and how to write one, using `@qspecs/postgres` as the shipped
reference.

## The interface

SPEC.md §62 states it conceptually as `execute(query, context): Promise<RawQueryResult>` and adds
one line of scope that matters as much as the method signature: data sources are responsible for
"connectivity; native query execution; cancellation propagation; raw result acquisition," and
explicitly **not** for deciding how results are visualized. The real TypeScript type
(`packages/core/src/types/plugin.ts`):

```ts
export interface DataSource<TCompiledQuery = unknown> {
  execute(query: TCompiledQuery, context: DataSourceContext): Promise<RawQueryResult>;
  dispose?(): Promise<void> | void;
  readonly supportedLanguages?: readonly string[];
}

export interface DataSourceContext {
  readonly executionId: string;
  readonly signal?: AbortSignal | undefined;
  readonly locale?: string | undefined;
  readonly timezone?: string | undefined;
  readonly logger: QSpecLogger;
}
```

- **`execute`** takes whatever `TCompiledQuery` the paired `QueryLanguage.compile` produced (a
  `CompiledSqlQuery` for `@qspecs/sql`, or whatever shape a different query-language plugin
  defines) and a `DataSourceContext` — an execution id for correlating logs/events, an optional
  `AbortSignal`, optional locale/timezone hints, and a logger. It must resolve to a
  `RawQueryResult`: see [Datasets](datasets.md#positional-rawqueryresult-versus-row-objects) for
  why that shape is positional rather than an array of row objects, and how it becomes a
  `Dataset`.
- **`dispose`** is optional cleanup — `QSpec.dispose()` calls it, for example to close a
  connection pool. A source with nothing to release is not obligated to implement it.
- **`supportedLanguages`** is covered next.

## `supportedLanguages`

`supportedLanguages` is how a data source declares which query languages it can actually run.
When present, `prepare()` cross-checks it against the manifest's `spec.query.language` and rejects
a mismatch immediately — before any query is compiled or a connection touched — with a manifest
error at `spec.query.language` naming the source's supported languages and a "did you mean"
suggestion (`packages/core/src/internal/prepare.ts`).

**Omitting the field is permissive: the source accepts every language.** This is not an
arbitrary default — it is the _only_ value that keeps every data source written before this field
existed working unchanged. `supportedLanguages` was added to `DataSource` after sources already
existed with no such declaration; if omission meant "supports nothing" or "supports only some
inferred default," every one of those pre-existing implementations would start failing the moment
the field shipped, with no code of their own having changed. Treating omission as "any language"
means the field is purely additive: a source opts into the stricter, fail-fast check by declaring
`supportedLanguages` explicitly, and nothing is forced to declare it just to keep working. That is
the compatibility guarantee — new capability, zero migration cost for what already worked. An
**empty array** is deliberately not equivalent to omitting the field: `supportedLanguages: []`
means the source executes no language at all, so every request against it is rejected. Only
`@qspecs/postgres` declares `supportedLanguages` today, as `["sql"]`
(`packages/postgres/src/internal/source.ts`); `@qspecs/testing`'s in-memory source omits it.

## The contract suite

`@qspecs/testing`'s `runDataSourceContractTests`
(`packages/testing/src/contracts/data-source.ts`) is a single function that runs the same
invariant checks against any `DataSource` implementation, so a new adapter is checked against
exactly the guarantees every other adapter is held to rather than whatever its author thought to
test. A fixture supplies:

- **`create()`** — a factory for a fresh source per test; the suite never shares connection state
  across assertions.
- **`query`** — a compiled query that succeeds and returns at least one row. It must survive
  `structuredClone` (no function, class instance, or driver handle inside it), because the
  suite's mutation check clones it to compare before/after.
- **`expectedColumns`** — the column names `query` is expected to return, in order.
- **`slowQuery`** (optional) — a query slow enough to abort mid-flight. Omitting it is allowed
  when a source genuinely cannot be made slow; the suite then **skips the cancellation
  assertions visibly** (a named, reported skip, not a silent pass) rather than pretending they
  ran.
- **`abortBoundMs`** (optional) — how long, from the moment `abort()` is called, the suite gives
  the source to actually reject. Defaults to 150ms, calibrated for an in-memory source; an
  adapter whose abort path is a real network round trip (a cancel request over a fresh
  connection, on top of pool-acquisition latency) should widen this rather than let CI
  flakiness masquerade as a defect.

What it checks, run against every configured source: rows are positional and match
`columns.length`; columns come back in the fixture's expected order; an already-aborted signal
rejects `execute()` without running the query (verified by timing, not inferred); a signal
aborted mid-flight rejects promptly, within `abortBoundMs`; two concurrent `execute()` calls
don't share mutable per-query state (proven with an in-flight settled-flag and a not-same-object
assertion on the results, not just "both eventually resolved correctly"); `dispose()`, if
implemented, is idempotent when called twice; and the source does not mutate the compiled query
object it was given (`toStrictEqual` against a `structuredClone`'d snapshot, so even a mutation
that _deletes_ a key rather than changing its value is caught). The suite also verifies its own
premise before trusting any timing assertion built on it: `slowQuery` must actually run
comfortably longer than `abortBoundMs` when left unaborted, or every cancellation assertion built
on it would pass "successfully" for the wrong reason. `@qspecs/postgres`'s and `@qspecs/testing`'s
own test suites both call `runDataSourceContractTests` against their respective sources; a new
adapter package should do the same.

## Writing an adapter

The shape to build toward is `createPostgresSource`
(`packages/postgres/src/internal/source.ts`) — the shipped reference implementation — and, for
the simplest possible example with no network calls at all, `@qspecs/testing`'s `memory()`
(`packages/testing/src/memory.ts`), which pairs an in-memory `DataSource` with a pass-through
`QueryLanguage` for exercising the pipeline in tests. In outline, an adapter package:

1. Defines a source-specific compiled-query type (`CompiledSqlQuery` for a SQL adapter, or
   whatever a paired `QueryLanguage.compile` produces).
2. Implements `execute(query, context)`: check `context.signal` before doing any work (an
   already-aborted caller should not cost a connection), acquire whatever connection/session the
   backend needs, run the query, and return a `RawQueryResult` — positional rows, `columns` with
   optional `nativeType` — never row objects.
3. Registers one `DataSource` per configured logical source name inside a `QSpecPlugin`'s
   `setup(api)`, via `api.sources.register(name, source)`, built with `definePlugin` for the
   identity-function ergonomics documented in
   [`docs/architecture.md` §5](architecture.md#5-plugin-authoring-specmd-105).
4. Propagates cancellation for real — see below — and implements `dispose()` if there is a pool
   or connection to close.
5. Runs `runDataSourceContractTests` from `@qspecs/testing` against it, alongside whatever
   adapter-specific tests (a real integration test against a live backend, for `@qspecs/postgres`)
   the backend needs.

### Reference: `@qspecs/postgres`'s cancellation design

`@qspecs/postgres`'s `createPostgresSource` (`packages/postgres/src/internal/source.ts`) is the
one shipped adapter that has to solve real-world cancellation, and its answer is worth reading
before writing a second adapter against a connection-pooled backend. When a query's `AbortSignal`
fires while a query is in flight, `cancelBackend` opens a **second, brand-new `pg.Client`** —
not the connection running the query, and not one taken from the pool — and issues
`SELECT pg_cancel_backend($1)` on it, parameterized with the running query's backend PID, then
waits for that to be acknowledged before surfacing `QSpecAbortError` to the caller.

Two alternatives were considered and rejected, both worth naming because they are the two things
a first attempt at this reaches for:

- **Cancelling on the connection running the query.** That connection is blocked waiting for the
  server to answer the exact query being cancelled — a cancel request sent on it would not be
  read until the query it's meant to stop has already finished. This is the one moment
  cancellation would do nothing.
- **Destroying the socket instead of asking the server to stop.** From the caller's side this
  looks identical to real cancellation — the promise rejects either way. On the server, it is
  not: the backend keeps executing the statement, holding its locks and burning CPU, with no one
  left connected to read the result. A caller who saw a rejected promise would reasonably believe
  the query stopped; it didn't. `pg_cancel_backend` genuinely stops the _statement_, while
  leaving the _session_ alive and reusable (it survives into `idle`, which is exactly what lets
  the connection pool reuse it for the next query rather than reconnecting) — a distinction
  `packages/postgres/test/integration.test.ts` proves against a real server by checking the
  backend is no longer `active` and is still `present`, now `idle`.

The full three-way comparison, including why a connection taken from the pool has the same
too-late problem as the query's own connection, is recorded in
[`docs/architecture.md` §9.3](architecture.md#93-cancellation-a-second-connection-not-socket-destruction);
this document summarizes it because a second connection-pooled adapter (MySQL, ClickHouse, or
similar) will very likely need the same shape and should not have to rediscover why the two
obvious shortcuts don't work.

## See also

- [`docs/queries.md`](queries.md) — what a data source is handed: the binding model and how a
  compiled query is produced.
- [`docs/datasets.md`](datasets.md) — the `RawQueryResult` shape a data source must return, and
  how it becomes a `Dataset`.
- [`docs/architecture.md` §9](architecture.md#9-qspecssql-and-qspecspostgres) — the full
  `@qspecs/sql`/`@qspecs/postgres` design record, including the SQL scanner and why `numeric`/
  `bigint` columns stay strings.
- [`docs/known-gaps.md`](known-gaps.md) — recorded, deliberate gaps in `@qspecs/postgres`
  (its internal seam is not exported; one `pg-pool` `'error'` window remains open).
