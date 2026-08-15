# Security

This document collects SPEC.md §72's six security requirements in one place, with the concrete
mechanism this repository uses to satisfy each, plus the one design decision — the shape of the
`@qspecs/http` boundary — most likely to look like unnecessary rigidity worth relaxing. Every claim
below is either quoted from source (with the file it lives in) or was verified directly against
the shipped packages.

> **The `@qspecs/http` handler is unauthenticated by design.** It has no auth hook, no session
> check, and no rate limiter. A host that mounts it on the open internet with no authentication of
> its own lets any caller who can reach the endpoint execute the manifests it was constructed
> with, using the host's own database credentials. `README.md`'s install section opens with the
> same bolded sentence, because a reader who only skims one of the two documents must still see it
> — see [The HTTP handler has no auth of its own](#the-http-handler-has-no-auth-of-its-own) below
> for the full reasoning.

## 72.1 No credentials in manifests

A manifest's `spec.query.source` names a logical data source; it never carries a connection
string, an API key, or any other credential (SPEC.md §9, §32). Connection details are host
configuration passed to a data source plugin's factory function at `.use()` time:

```ts
createQSpec().use(
  postgres({ sources: { analytics: { connectionString: process.env.DATABASE_URL! } } }),
);
```

`PostgresSourceConfig.connectionString`'s own doc comment (`packages/postgres/src/internal/source.ts`)
states it directly: "Supplied by the host application, never by a manifest." A manifest is plain,
fully serializable JSON (SPEC.md §4.1) with no field anywhere in its schema for a credential to
occupy — there is structurally nowhere in a QSpec manifest to put one.

## 72.2 Parameterized queries, never string interpolation

SQL adapters must use native database parameterization, never `` `WHERE id = ${value}` `` (SPEC.md
§72.2, quoted verbatim). This repository makes the unsafe form not merely discouraged but
**unrepresentable** in the type that crosses from `@qspecs/sql` to `@qspecs/postgres`:

```ts
export interface CompiledSqlQuery {
  readonly segments: readonly string[]; // literal SQL between parameters
  readonly parameterNames: readonly string[];
  readonly values: readonly JsonValue[]; // the caller's data, kept separate
  readonly source: string;
}
```

(`packages/sql/src/internal/compile.ts`.) There is deliberately no `text: string` field alongside
`segments`. If there were, nothing would stop an adapter from building one with
`segments.join(value)` — exactly the interpolation SPEC.md §72.2 forbids — and that mistake would
compile, type-check, and work correctly for every value with no SQL metacharacters in it, failing
only on the one input an injection test sends. With no `text` field, an adapter has no string to
concatenate a value into even by accident: only `segments` (literal SQL the manifest author wrote)
and `values` (the caller's data, in a parallel array). `@qspecs/postgres`'s `renderPostgres`
(`packages/postgres/src/internal/render.ts`) is the only place a `CompiledSqlQuery` becomes text,
and what it produces is `$1`/`$2`/… placeholders plus a `values` array handed to `pg` as bind
parameters — never a spliced string. See
[`docs/architecture.md` §9.1](architecture.md#91-why-compiledsqlquery-has-no-text-field) for the
full account, and [Queries](queries.md#the-binding-model) for the binding model this compiles
from — including why a bare string binding is rejected outright rather than silently treated as a
literal value, which closes a second, distinct silent-failure mode at the manifest layer.

## 72.3 No `eval`, no `new Function`

Core and official plugins must not use `eval()`, `new Function()`, or any dynamic arbitrary
JavaScript execution to evaluate manifest expressions (SPEC.md §72.3). `filter`'s `where` and
`derive`'s `expression` compile through `@qspecs/core`'s fixed, sixteen-operator expression AST
(`normalizeExpression`/`evaluateExpression`, see [Transforms](transforms.md#the-expression-ast)) —
a tree interpreter, not a code generator. This is enforced mechanically, not by convention:
[`test/boundaries.test.ts`](../test/boundaries.test.ts) greps every published, non-test `.ts`/
`.tsx` source file across every package for `eval(` and `new Function(` and fails the build if
either appears — verified as part of this task's own gate run
(`npm run test`, the "package boundaries" suite).

## 72.4 Prototype pollution resistance

Manifest parsing and every downstream lookup keyed by a caller- or manifest-supplied string must
resist `__proto__`, `constructor`, and `prototype` as key names (SPEC.md §72.4). This shows up in
several independent places, each verified against its own source:

- **Manifest parsing.** `parseManifest`'s `assertNoUnsafeKeys` (`packages/core/src/define.ts`)
  walks the parsed document recursively and rejects any of the three names anywhere in it, before
  any other validation runs.
- **Row storage.** A `Dataset`'s rows are built with `Object.create(null)` — genuinely
  prototype-free objects, where `hasOwnProperty` does not even exist as an inherited method — so a
  column literally named `constructor` is representable without colliding with
  `Object.prototype.constructor` (see [Datasets](datasets.md#positional-rawqueryresult-versus-row-objects)).
- **Registries.** `createRegistry` (`packages/core/src/internal/registry.ts`) stores capability
  names in a `Map`, not a plain object, so a plugin can register a transform or presentation type
  literally named `constructor` without it resolving to a function off `Object.prototype` instead
  of `undefined`.
- **The HTTP wire protocol.** `parseExecuteRequest` (`packages/http/src/internal/protocol.ts`)
  rejects `resource` and any `parameters` key matching `isUnsafeKey`, at every depth of a nested
  parameter value — the same check core's own manifest parsing uses, exported from `@qspecs/core`
  specifically so `@qspecs/http` never needs a second, potentially drifting reimplementation (see
  [`docs/architecture.md` §6](architecture.md#6-the-publicinternal-boundary-specmd-104)).
- **Every lookup by a caller-supplied name uses `Object.hasOwn`, never a bare bracket read.**
  `createQSpecHandler`'s `resolveManifest`, `createLocalExecutor`'s `resolveManifest`, and
  `@qspecs/sql`'s statement-binding resolution all do this specifically because a bare
  `manifests[resource]` for `resource: "toString"` would resolve to `Object.prototype.toString` —
  a function, and therefore not `undefined` — treating an unregistered name as if it named a real
  resource. `handler.test.ts` falsifies exactly this case.

`isPlainObject` and `isUnsafeKey` are public exports of `@qspecs/core` (re-exported from `json.ts`)
for this reason — the same trust-boundary primitives core's own manifest validation uses are what
`@qspecs/http`'s wire-protocol parser needs, and a second hand-copied implementation in `@qspecs/http`
would be a second place to drift.

## 72.5 Resource limits

Execution APIs allow a host to bound maximum rows, maximum query duration, maximum transform
count, maximum manifest size, and maximum expression depth (SPEC.md §72.5). All five are
`QSpecLimits` fields, defaulted and overridable at `createQSpec({ limits })`
(`packages/core/src/types/runtime.ts`) — `maxRows`, `queryTimeoutMs`, `maxTransforms`,
`maxManifestBytes`, and `maxExpressionDepth`. See
[`docs/architecture.md` §4](architecture.md#4-resolved-design-decisions) for where each is
enforced, and `docs/known-gaps.md` for two recorded, deliberate edge cases: `maxManifestBytes` is
string-input only (bypassed when `prepare()` receives an already-parsed object, since the limit
exists to bound the cost of _parsing_ untrusted text), and `maxRows` is applied once at normalize
time and not re-checked after a transform runs, so a transform that grows row count back past the
cap is not caught by this limit specifically.

## 72.6 No credential logging

Database credentials and sensitive bound parameter values must not be logged by default (SPEC.md
§72.6). `@qspecs/postgres` treats this as load-bearing, not aspirational, in two places verified
directly in `packages/postgres/src/internal/source.ts`:

- **A `pg` driver error is never passed to the logger, and its message is never copied into a
  QSpec error's own message.** `wrapDriverError`'s own comment: "A `pg` error routinely embeds the
  connection string, so its message is never copied into ours; it is attached as `cause` instead,
  which a host can reach for deliberately." The composed message names only the source and what
  failed — never the driver's own text.
- **A failed cancellation is reported the same way.** `cancelBackend`'s catch block logs a message
  this module composes itself (`"...could not cancel backend PID <pid>; the server may still be
running the cancelled query."`) — never the caught driver error, for the identical reason.

`@qspecs/http`'s `mapError` (`packages/http/src/internal/handler.ts`) applies the same discipline at
the HTTP boundary: only `error.code` — a fixed, known-safe string this package never composes from
caller or driver input — is trusted from an arbitrary `QSpecError` that isn't a validation error.
Its own comment explains why `error.message` is not: core's `execute()` fallback embeds an
adapter's raw thrown message into `QueryExecutionError.message` when the adapter throws a plain
`Error`, so a driver's connection string can arrive on `error.message` even once wrapped in a
QSpecError — every non-validation failure becomes a fixed, generic 500 message instead of
forwarding whatever the driver said.

## Why the HTTP boundary carries a resource name, not a query

`QSpecExecuteRequest` (`packages/http/src/internal/protocol.ts`) has exactly two fields:

```ts
export interface QSpecExecuteRequest {
  readonly resource: string; // resolved against the SERVER's own registry
  readonly parameters?: Record<string, JsonValue>;
}
```

There is deliberately no field for a query, a statement, a source name, or anything that names
_what to run_ — only _which already-registered thing_ to run it with. This is the shape most
likely to look like unnecessary rigidity worth relaxing: a `DataSource`-level HTTP adapter, where
the browser sends something query-shaped and a server-side `QSpec.execute` runs it, looks like it
would work and would pass every test that only checks "does the chart render."

It would not survive a hostile client, for the same reason `CompiledSqlQuery` has no `text` field
(above): once a compiled query — or anything that determines one — crosses the trust boundary, no
server-side validation recovers safety, because a compiled query is by construction something the
runtime will execute. An allowlist, a query-shape validator, or a "safe subset" of the query
language does not change this; the browser would still be choosing what runs, only through a
narrower door. A `resource` string is not a narrowed query; it is categorically not a query at
all. `createQSpecHandler` resolves it with `Object.hasOwn` against the exact `manifests` map the
host constructed it with, and the manifest that eventually executes — its `spec.query`, its
bindings, its source — was authored server-side and never touched the network.
`test/react-pipeline.test.tsx`'s "carries no SQL, connection string, or password to the client"
test is the mechanical proof: it asserts the exact, closed set of keys the request body contains
(`{ resource, parameters }`, nothing else) and greps the request body, the response body, and the
rendered DOM for the statement text, the table name, and the credentials — none of which can
appear, because none of them are reachable from what the browser is capable of sending. See
[`docs/architecture.md` §10.1](architecture.md#101-why-the-http-boundary-carries-a-resource-name-not-a-query)
for the complete account.

## The HTTP handler has no auth of its own

`QSpecHandlerOptions` (`packages/http/src/internal/handler.ts`) accepts exactly two fields: a
`runtime` and a `manifests` map. There is no auth hook, no session check, and no rate limiter
anywhere in `createQSpecHandler`'s implementation — verified by reading the full option type and
the full request-handling function. This is the same posture `@qspecs/postgres` takes toward
connection strings (host-supplied configuration, not this package's concern) applied to the
network boundary instead: the handler resolves whatever resource name a request names against the
registry the host supplied, and executes it on the host's own runtime, with the host's own
credentials, for **any caller that can reach the endpoint**.

The host is expected to mount the handler behind its own authentication and authorization, exactly
as it supplies its own `DATABASE_URL` — `README.md`'s install section opens with the same bolded
sentence this document opened with, deliberately, because an unauthenticated endpoint that
executes server-side queries against a real database is a serious mistake to make by omission, and
a reader skimming either document alone should still see it. `docs/known-gaps.md` records the same
warning under "The HTTP handler is unauthenticated by design," with the same emphasis.

## See also

- [`docs/architecture.md` §9–10](architecture.md#9-qspecssql-and-qspecspostgres) — the full design
  record behind the SQL scanner, the missing `text` field, and the HTTP/React/Recharts split.
- [`docs/react-integration.md`](react-integration.md#the-executor-seam) — the browser-side half of
  the HTTP boundary: what a React hook ever sees, and what it never does.
- [`docs/data-sources.md`](data-sources.md) — the `DataSource` interface every adapter implements,
  including `@qspecs/postgres`'s connection and cancellation design.
- [`docs/known-gaps.md`](known-gaps.md#the-http-handler-is-unauthenticated-by-design) — the
  unauthenticated-handler warning in its original wording, plus every other recorded, deliberate
  limitation in full.
- [`README.md`](../README.md) — the install-section warning this document's opening quote matches.
