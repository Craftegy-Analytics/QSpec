# QSpec Architecture

This document explains how this repository implements [`SPEC.md`](../SPEC.md). It does not
restate the specification; it maps specification requirements onto the modules that satisfy
them. Where a decision was left open by SPEC.md, it links to the section of
[`docs/superpowers/specs/2026-08-09-qspec-design.md`](superpowers/specs/2026-08-09-qspec-design.md)
("the design document") that resolves it.

## 1. Pipeline

The conceptual pipeline (SPEC.md §1) is realized as the concrete runtime pipeline (SPEC.md §10):

```text
                     QSpec Manifest
                           │
                           ▼
                  Manifest Parser
                           │
                           ▼
                 Schema Validation
                           │
                           ▼
                 Resource Resolver
                           │
                           ▼
               Parameter Resolution
                           │
                           ▼
               Parameter Validation
                           │
                           ▼
                  Query Resolver
                           │
                           ▼
                  Query Compiler
                           │
                           ▼
                Data Source Adapter
                           │
                           ▼
                     Raw Result
                           │
                           ▼
                 Result Normalizer
                           │
                           ▼
                 Dataset Validator
                           │
                           ▼
                Transform Pipeline
                           │
                           ▼
                Normalized Dataset
                           │
                           ▼
               Presentation Model
                           │
                           ▼
                      Renderer
```

Every capability box below "Manifest Parser" is registry-driven and replaceable by a plugin;
core supplies only the pipeline shape and the `Dataset` resource kind.

## 2. `prepare()` versus `execute()`

`createQSpec().prepare(manifest)` performs all static work exactly once per manifest; the
returned `PreparedResource.execute(context)` performs only the per-call work that genuinely
depends on runtime parameters or a live data source (design §4).

| Phase       | Work                                                                                                               | Validation stage(s) |
| ----------- | ------------------------------------------------------------------------------------------------------------------ | ------------------- |
| `prepare()` | Parse manifest, size-check it                                                                                      | —                   |
| `prepare()` | Structural validation                                                                                              | Stage 1             |
| `prepare()` | Resolve `apiVersion`/`kind`; resolve query language, source, transforms, presentation type from registries         | Stage 2             |
| `prepare()` | Compile the parameter model, normalize expressions/filter shorthand                                                | —                   |
| `prepare()` | Fold `Transform.describe` across the pipeline; validate presentation field references against the projected schema | Stage 6             |
| `execute()` | Validate runtime parameter values                                                                                  | Stage 3             |
| `execute()` | Resolve bindings; compile the query against the data source                                                        | Stage 4             |
| `execute()` | Normalize the raw result into a `Dataset`                                                                          | —                   |
| `execute()` | Validate the returned dataset against `spec.dataset`, if declared                                                  | Stage 5             |
| `execute()` | Run the transform pipeline, immutably; build the presentation model; return `QSpecResult`                          | —                   |

`execute(manifest, context)` (the one-shot form on `QSpec`) is `prepare()` immediately followed
by `execute()`, with no caching — callers who want to reuse a prepared plan across many
parameter sets call `prepare()` themselves and keep the returned `PreparedResource`.

This split is why stage 6 (presentation) runs during `prepare()`, before any query has been
issued: SPEC.md §81 requires that an unrenderable manifest fail before the database is ever
touched, and stage 6 needs only the _shape_ of the eventual dataset, not its data.

## 3. The six validation stages (SPEC.md §80)

| Stage                   | Checks                                                                                                   | Implementing module                                                                                             |
| ----------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 1 — Manifest structure  | The document is a well-formed QSpec v1 manifest                                                          | [`packages/core/src/internal/validate/manifest.ts`](../packages/core/src/internal/validate/manifest.ts)         |
| 2 — Plugin capabilities | The declared resource kind, query language, source, transforms, and presentation type are all registered | capability resolution in [`packages/core/src/internal/prepare.ts`](../packages/core/src/internal/prepare.ts)    |
| 3 — Parameters          | Runtime parameter values satisfy their declarations                                                      | [`packages/core/src/internal/validate/parameters.ts`](../packages/core/src/internal/validate/parameters.ts)     |
| 4 — Query               | Query-specific requirements are satisfied at compile time                                                | the installed `QueryLanguage.validate` (SPEC.md §63); invoked from `prepare.ts` and `execute.ts`                |
| 5 — Dataset             | The data a source returns matches the declared `spec.dataset` schema                                     | [`packages/core/src/internal/validate/dataset.ts`](../packages/core/src/internal/validate/dataset.ts)           |
| 6 — Presentation        | Presentation field references resolve against the (possibly transform-projected) dataset schema          | [`packages/core/src/internal/validate/presentation.ts`](../packages/core/src/internal/validate/presentation.ts) |

Stages 1, 2, and 6 run during `prepare()`; stages 3, 4, and 5 run during `execute()` — see §2
above. `@qspecs/sql`'s `validateSqlQuery` (§9 below) is the concrete `QueryLanguage.validate`
implementation that exercises stage 4 against a real query language, not just the contract.

## 4. Resolved design decisions

SPEC.md is intentionally permissive in places where more than one implementation would
satisfy it. Each such gap is resolved in the design document, not silently in code:

- [Binding model](superpowers/specs/2026-08-09-qspec-design.md#21-binding-model-specmd-34-35) — why a bare string binding must match `$parameters.<name>` and literals require `{ "literal": ... }`.
- [Expression AST](superpowers/specs/2026-08-09-qspec-design.md#22-expression-ast-specmd-42) — the fixed, non-extensible operator set and why extensibility belongs at the transform layer instead.
- [Filter shorthand](superpowers/specs/2026-08-09-qspec-design.md#23-filter-shorthand-specmd-40-vs-94) — both shapes are accepted; both normalize to the AST form during `prepare()`.
- [Raw query results and normalization](superpowers/specs/2026-08-09-qspec-design.md#24-raw-query-results-and-normalization-specmd-36-62) — positional rows, and why (duplicate columns, prototype-polluting names, future columnar backends).
- [Static presentation validation](superpowers/specs/2026-08-09-qspec-design.md#25-static-presentation-validation-specmd-80-stage-6-81-86) — the `Transform.describe` contract; see §5 below.
- [Dynamic series](superpowers/specs/2026-08-09-qspec-design.md#26-dynamic-series-specmd-47) — pivoting stays renderer-side but shares one resolver, so hosts don't disagree.
- [Manifest validation lives in core, not in Ajv](superpowers/specs/2026-08-09-qspec-design.md#27-manifest-validation-lives-in-core-not-in-ajv-specmd-12-13-71-86) — why `@qspecs/core` hand-writes structural validation instead of depending on Ajv, and why the two validators are kept in lockstep by a conformance test.
- [Capability typing](superpowers/specs/2026-08-09-qspec-design.md#28-capability-typing-specmd-54) — literal-union capability tracking for autocomplete, not type-level manifest validation.
- [Hooks, not middleware](superpowers/specs/2026-08-09-qspec-design.md#29-hooks-not-middleware-specmd-68-69) — v1 ships an observer-only lifecycle event emitter.
- [Resource limits](superpowers/specs/2026-08-09-qspec-design.md#210-resource-limits-specmd-725) — `maxRows`, `maxTransforms`, `maxManifestBytes`, `maxExpressionDepth`, `queryTimeoutMs`, all enforced in core.

## 5. Plugin authoring (SPEC.md §105)

A plugin is a plain object built with `definePlugin` — an identity function that gives editors
autocomplete without requiring the author to understand any QSpec internals:

```ts
import { definePlugin } from "@qspecs/core";

export const myPlugin = definePlugin({
  name: "my-qspec-plugin",

  setup(api) {
    api.transforms.register("normalize-score", {
      execute(dataset, spec) {
        // implementation
        return dataset;
      },
    });
  },
});
```

Installed with:

```ts
const qspec = createQSpec().use(myPlugin);
```

`setup(api)` receives a `QSpecPluginAPI` (`packages/core/src/types/plugin.ts`) exposing one
registry per capability — `queryLanguages`, `sources`, `transforms`, `semanticTypes`,
`resources`, `presentations`, `renderers` — plus `hooks.on` (observation only; plugins never
emit lifecycle events, per design §2.9), `logger`, and the runtime's configured `limits`.
Registration happens during `qspec.ready()`, which every `prepare()` call awaits first, so a
plugin queued via `.use()` is guaranteed to be installed before its capabilities are resolved.

## 6. The public/internal boundary (SPEC.md §104)

SPEC.md §104 requires the project to distinguish public, internal, and experimental API, and
says internal code should use paths that are not exposed through a package's `exports` map, and
that implementation details should never leak just because another QSpec package needs them.

This repository enforces that structurally, not by convention:

- Every package's `src/internal/` directory holds implementation code. Nothing under
  `internal/` is re-exported, wildcard or otherwise, from that package's `src/index.ts`.
- Every package's `package.json#exports` map exposes exactly two paths: `.` and
  `./package.json`. There is no subpath through which `internal/` code is reachable from
  outside the package.
- If two packages need to share an abstraction, it is promoted intentionally into a documented
  public (or internal-but-shared, e.g. `@qspecs/testing`) contract — never accessed by reaching
  past another package's entry point.

[`test/boundaries.test.ts`](../test/boundaries.test.ts) enforces this mechanically for every
workspace package on every CI run:

- `@qspecs/core`'s `package.json` has no `dependencies` at all.
- Browser-safe packages (currently `@qspecs/core`, `@qspecs/schema`, `@qspecs/sql`,
  `@qspecs/transforms`, `@qspecs/charts`, `@qspecs/http`, `@qspecs/react`, and `@qspecs/recharts` — see
  `BROWSER_SAFE` in `test/boundaries.test.ts`) never depend on, nor import in source, a database
  driver (`pg`, `pg-promise`, `postgres`, or `mysql2`).
- Every package's `exports` keys are exactly `[".", "./package.json"]`.
- Every package declares `"type": "module"`, `"sideEffects": false`, `"license": "MIT"`, and
  `"engines": { "node": ">=22.19" }`.
- No `src/index.ts` contains `export * from "./internal/..."`.
- No published `.ts`/`.tsx` source (excluding `*.test.ts`/`*.test.tsx`) contains `eval(` or
  `new Function(`.

A failure in that suite means a real architectural regression, not a test to be relaxed.

`@qspecs/core`'s public surface also exports two trust-boundary primitives, `isPlainObject` and
`isUnsafeKey` (`packages/core/src/index.ts`, re-exported from `json.js`) — for the same reason
`suggest` is public: `@qspecs/http`'s wire-protocol parser (`packages/http/src/internal/protocol.ts`)
and its client executor (`packages/http/src/internal/executor.ts`) both need the exact same "is
this safely indexable, and is this key safe to write" checks core's own manifest and parameter
validation uses, and a second, drifting reimplementation in `@qspecs/http` would be worse than a
shared, public one. Because `isPlainObject` is public API, not an internal helper, its documented
cross-realm caveat (`docs/known-gaps.md`'s "Accepted permanently" section — it rejects a plain
object constructed in a different realm, e.g. across an iframe or a `vm` context, failing closed)
is now a public-API caveat too, not merely an internal implementation detail: any external caller
of `isPlainObject` inherits it.

## 7. The transform pipeline and the `Transform.describe` contract

`spec.transforms` (SPEC.md §40) is an ordered array; `execute()` runs it as a strict left-to-
right pipeline, reassigning `dataset` from each transform's return value rather than mutating it
in place — a transform's input must survive untouched (`packages/core/src/internal/execute.ts`).
`@qspecs/transforms` (SPEC.md §16) ships the six standard transforms: `filter`, `derive`, `sort`,
`limit`, `select`, and `rename`. Each is a plain `Dataset -> Dataset` function; `filter` and
`derive` additionally compile an expression through `@qspecs/core`'s `normalizeExpression`, capped
by `api.limits.maxExpressionDepth` (SPEC.md §72.5) captured once at plugin `setup()`. `aggregate`
is in SPEC.md §16's list but deliberately absent from this v1 set — grouping semantics deserve
their own design pass.

```ts
interface Transform<TSpec = unknown> {
  execute(dataset: Dataset, spec: TSpec, context: TransformContext): Promise<Dataset> | Dataset;
  describe?(fields: readonly Field[], spec: TSpec): readonly Field[];
  validate?(spec: TSpec, fields: readonly Field[] | undefined): void;
}
```

`execute` is the only required member: it runs the transform against a real dataset during
`execute()`. `describe` is a separate, optional, _static_ method: given the fields entering the
transform, it returns the fields leaving it, without touching any data.

`prepare()` folds `describe` across the declared transform pipeline, starting from
`spec.dataset.fields`, to compute the schema the pipeline will eventually produce. Stage 6
(presentation) validates every `field` reference in `spec.presentation` against that projected
schema — including Levenshtein-based "did you mean" suggestions — entirely before a query runs.

**Worked example: `rename` projecting through to presentation validation.** Given
`spec.dataset.fields` declaring `{ month, revenue }` and a transform chain
`[{ type: "rename", fields: { revenue: "amount" } }]`, `rename`'s `describe()` returns
`[{ name: "month" }, { name: "amount" }]` — the same field, renamed, in the same slot
(`packages/transforms/src/internal/rename.ts`). A presentation charting `series: [{ field:
"amount" }]` therefore passes stage 6, because `"amount"` is exactly what the projected schema
says will exist once the pipeline runs. A presentation charting the pre-rename `"revenue"` fails
`prepare()` with "Unknown dataset field \"revenue\"" — `revenue` genuinely will not exist by the
time this pipeline finishes, and stage 6 catches that before any query is issued. This is the
`describe()` contract's entire reason for existing: without it, `prepare()` could only validate
presentation fields against the _raw_ dataset schema, and every transform that adds, removes, or
renames a field would silently reopen the SPEC.md §81 gap `describe()` closes.
[`test/pipeline.test.ts`](../test/pipeline.test.ts) proves both directions — the rename passing
and the pre-rename name failing — as the two assertions that matter most in that suite.

**Omitting `describe` makes a transform schema-opaque.** The moment `prepare()` reaches a
transform with no `describe`, it can no longer know what fields exist afterward, so it stops
projecting: every transform later in the pipeline, and the presentation stage itself, loses
static validation for that manifest. The manifest still runs — a bad field reference just isn't
caught until `execute()` fails at runtime instead of `prepare()` failing up front — but SPEC.md
§81's promise ("prevents unnecessary database queries" for a manifest that can never render)
stops holding for anything downstream of an opaque transform. All built-in transforms are
expected to implement `describe` precisely so this static guarantee survives real pipelines
(design §2.5). When a manifest declares no `spec.dataset` at all, there is no schema to project
in the first place, and presentation validation is deferred to after execution unconditionally.

## 8. `resolveSeries` and static series resolution

`@qspecs/charts` (SPEC.md §17) registers five presentation types — `line`, `bar`, `area`,
`scatter`, and `pie` — plus the `Chart` resource kind. It renders nothing: SPEC.md §17 is
explicit that a QSpec presentation describes _how_ a dataset should be shown, not a pixel of it.
What it does provide is `resolveSeries(dataset, presentation)`
(`packages/charts/src/internal/resolve-series.ts`), which turns a cartesian presentation's
`series` declaration — either an explicit array of `{ field }` entries, or a single `{ field,
groupBy }` that pivots the dataset into one series per distinct `groupBy` value at call time
(SPEC.md §47) — into concrete, plottable `ResolvedSeries[]`: ordering, null/empty-string
grouping-key handling, and missing-category behavior are all decided once, here.

That logic lives in `@qspecs/charts` rather than in each renderer specifically so that a Recharts
adapter, an ECharts adapter, and a plain CLI/terminal renderer cannot disagree with each other
about what a grouped series means. If dynamic-series pivoting were renderer-side, three renderers
given the same `Chart` manifest could legitimately produce three different series orderings or
three different answers for "what happens when the grouping field is null" — a QSpec manifest is
supposed to mean one thing regardless of what eventually renders it. `resolveSeries` is the single
place that decision is made, shared by every future renderer package (`@qspecs/react`,
`@qspecs/recharts`, or otherwise) instead of re-decided by each.

## 9. `@qspecs/sql` and `@qspecs/postgres`

SPEC.md §14 requires the SQL query language to stay dialect-neutral rather than
Postgres-specific, and §15 requires the Postgres adapter to add pooling, cancellation, and type
conversion on top of it. This section records the reasoning behind the four decisions in that
split most likely to look arbitrary out of context.

### 9.1 Why `CompiledSqlQuery` has no `text` field

`@qspecs/sql`'s `compileSql` (`packages/sql/src/internal/compile.ts`) turns a `:name`-parameterized
statement into

```ts
interface CompiledSqlQuery {
  readonly segments: readonly string[]; // literal SQL between parameters
  readonly parameterNames: readonly string[]; // one name per gap
  readonly values: readonly JsonValue[]; // one resolved value per gap
  readonly source: string;
}
```

There is deliberately no `text: string` alongside it. If there were, nothing would stop an
adapter from building it with `segments.join(value)` — string concatenation, i.e. exactly the
interpolation SPEC.md §72.2 forbids — and that mistake would compile, type-check, and work
correctly for every value that contains no SQL metacharacters, which is most of them. It would
only fail on the one input an injection test sends. Leaving `text` out is what makes that bug
structurally impossible instead of merely tested against: an adapter has no string to concatenate
into, only `segments` (this package's literal SQL, authored by whoever wrote the manifest) and
`values` (the caller's data, kept in a parallel array). `@qspecs/postgres`'s `renderPostgres`
(`packages/postgres/src/internal/render.ts`) is the only place `CompiledSqlQuery` becomes text,
and what it produces is `$1`/`$2`/… placeholders plus a `values` array handed to `pg` as bind
parameters — never a spliced string. A MySQL or SQLite adapter would do the same with `?`
placeholders; the point of the missing `text` field is that every future adapter is forced through
the same shape.

### 9.2 The scanner's five skipped contexts

`scanSql` (`packages/sql/src/internal/scan.ts`) cannot just regex for `:name` — SQL has five kinds
of region where a `:` is not the start of a parameter, and a manifest hits the most common one
almost immediately:

1. **Line comments** (`-- ...` to end of line). Without this, `-- see :ticket-123` in a trailing
   comment would spawn a phantom parameter named `ticket`.
2. **Block comments** (`/* ... */`), tracked with a depth counter because Postgres nests them.
   The same failure mode as line comments, just multi-line — `/* TODO: handle :legacy_id */`.
3. **Postgres escape-string literals** (`E'...'`/`e'...'`), where `\'` does not close the string
   the way it would in an ordinary literal — reusing rule 4's doubled-quote logic here would
   misjudge where the string ends, not just misread a colon inside it.
4. **Ordinary single-quoted string literals, double-quoted identifiers, and Unicode-escape
   strings** (`'...'`, `"..."`, `U&'...'`), which double their quote character to escape it. A
   value like `'ratio 3:2'` or an identifier `"user:id"` carries a colon that must stay literal
   data.
5. **Dollar-quoted strings** (`$$...$$` or `$tag$...$tag$`), which close only on the identical
   tag. This is what makes an inline `plpgsql` function body — routinely full of `:=`
   assignment and `RAISE NOTICE 'x: %'`-style colons — pass through as one literal segment
   instead of being read as a run of phantom parameters.

Content inside any of the five is copied through verbatim; a `:` there is never treated as a
parameter start. Adjacent to that, the scanner also special-cases `::`, the cast operator,
before it ever reaches the parameter check — without that, `created_at::date` would scan as the
literal `created_at` followed by a parameter named `date`, which is the case a real manifest hits
first, not an edge case reserved for adversarial input. Unterminated constructs (an unclosed
string or comment) consume to end of input rather than throwing: the scanner's job is to find
parameters, not to validate SQL, and the database rejects malformed input with a far better
message than a hand-rolled scanner could produce.

### 9.3 Cancellation: a second connection, not socket destruction

`AbortSignal`-based cancellation (SPEC.md §60) has to reach the server, not just stop waiting for
it. `createPostgresSource`'s `cancelBackend` (`packages/postgres/src/internal/source.ts`) opens a
**new** `pg.Client`, issues `SELECT pg_cancel_backend($1)` with the running query's backend PID as
a bound parameter, and waits for the server to acknowledge it before surfacing `QSpecAbortError` to
the caller.

Three alternatives were rejected:

- **The connection running the query.** It is blocked waiting for the server to answer that exact
  query, so a cancel request sent on it would not be read until the query it is meant to stop has
  already finished — the one moment cancellation would do nothing.
- **A connection taken from the pool.** At `max` connections with every client busy, `connect()`
  would queue behind the very query being cancelled, again arriving too late to matter.
- **Destroying the socket.** This was the design's initial instinct and the one most likely to
  look sufficient: from the caller's side it looks identical to cancellation, since the caller's
  promise rejects either way. On the server, it is not. The backend keeps executing the statement
  — holding its locks, burning CPU — with nobody left connected to read the result. That is
  abandonment wearing cancellation's clothes, not cancellation, and it is strictly worse than doing
  nothing: a caller who saw `QSpecAbortError` would reasonably believe the query stopped.

`pg_cancel_backend` cancels the _statement_, not the session — a real distinction, not a technicality.
The session survives into `idle`, which is exactly what lets the pool reuse the connection instead of
opening a new one on the next query. (A stopped-existing session would need `pg_terminate_backend`,
which this adapter does not use.) `packages/postgres/test/integration.test.ts` proves both halves of
this against a real server: the backend stops being `active`, **and** it is still `present` afterward,
now `idle` — which rules out both abandonment (backend still `active`) and socket destruction
(backend gone from `pg_stat_activity` entirely).

### 9.4 Why `numeric` and `bigint` stay strings

`normalizePgResult` (`packages/postgres/src/internal/normalize.ts`) hands `pg`'s query result to
core unchanged, and `@qspecs/postgres` never calls `pg.types.setTypeParser` anywhere — a deliberate
absence, not an oversight. `pg`'s own default type parsers already return Postgres `numeric` (OID 1700) and `int8`/`bigint` (OID 20) columns as JavaScript strings rather than parsing them into
`number`, and this package leaves that behavior alone.

The reason is precision. A JavaScript `number` is an IEEE 754 double, which reliably represents
integers only up to 2^53 and decimal fractions not at all exactly. `int8` covers the full 64-bit
range (up to roughly 9.2 × 10^18), and `numeric` supports arbitrary precision — `numeric(40, 20)`
in the integration suite's schema needs 40 significant digits, 20 of them after the decimal point.
Parsing either into a `number` would silently round it on the way through; there is no scale at
which that stops being true. Keeping the driver's string is the only representation that survives
the round trip intact, and `packages/postgres/test/integration.test.ts` pins this with values
specifically chosen to be unrepresentable as a double (`12345678901234567890.12345678901234567890`
and `2^63 - 1`) and asserts the string form is exact while `Number(...)` of the same string is not.
The cost is pushed onto the caller: a manifest that needs arithmetic on a `numeric`/`bigint` column
must parse the string itself, with whatever precision its use case actually requires (a plain
`number`, a bigint, or a decimal library) — a choice this package cannot make on the caller's
behalf without picking a precision loss for them.

## 10. `@qspecs/http`, `@qspecs/react`, and `@qspecs/recharts`

SPEC.md §18 requires `@qspecs/react` to provide framework integration without requiring a
particular chart library, and §19 requires `@qspecs/recharts` to render chart models via
Recharts; §73 requires the server/browser boundary to be a real separation, not a convention.
This section records the reasoning behind the four decisions in that split most likely to be
"simplified" into a defect by a future contributor who has not seen why they are shaped this way.

### 10.1 Why the HTTP boundary carries a resource name, not a query

`QSpecExecuteRequest` (`packages/http/src/internal/protocol.ts`) has exactly two fields:
`resource` (a string the server looks up in its own registry) and `parameters` (a plain object of
`JsonValue`s). There is deliberately no field for a query, a statement, a source name, or
anything that names _what to run_ — only _which already-registered thing_ to run it with.

This is the one shape in this plan most likely to look like unnecessary rigidity worth relaxing.
A `DataSource`-level HTTP adapter — one where the browser sends something query-shaped and a
server-side `QSpec.execute` runs it — looks like it would work, and would even pass every test
that only checks "does the chart render." It would not survive a hostile client, for the same
reason `@qspecs/sql`'s `CompiledSqlQuery` has no `text` field (§9.1 above): once a compiled query
(or anything that determines one) crosses the trust boundary, no server-side validation recovers
safety, because a compiled query is by construction something the runtime will execute. Adding a
allowlist, a query-shape validator, or a "safe subset" of the query language does not change this
— the browser would still be choosing what runs, only through a narrower door. The `resource`
string is not a narrowed query; it is categorically not a query at all. `createQSpecHandler`
(`packages/http/src/internal/handler.ts`) resolves it with `Object.hasOwn` against the exact
`manifests` map the host constructed it with, and the manifest that eventually executes — its
`spec.query`, its bindings, its source — was authored server-side and never touched the network.
`test/react-pipeline.test.tsx`'s "carries no SQL, connection string, or password to the client"
test is the mechanical proof: it asserts the exact, closed set of keys the request body contains
(`{ resource, parameters }`, nothing else) and greps the request body, the response body, and the
rendered DOM for the statement text, the table name, and the credentials, none of which can appear
because none of them are reachable from what the browser is capable of sending.

### 10.2 Why `QueryCache` holds promises, not results

`createQueryCache` (`packages/react/src/internal/cache.ts`) stores a `Map<string, { resource,
promise }>` — the in-flight or settled `Promise<QSpecResult>` itself, not its resolved value, and
not a fresh promise re-wrapped around a cached value on every call.

This is not a style choice; it is required by how React 19's `use()` decides whether to suspend.
`use()` must be handed the _same promise object_ on every render of a component reading the same
query — if `useQSpecQuery` (or whatever backs it) constructs a new `Promise` each render, even one
that resolves to an identical value, React sees a promise it has never seen before, suspends,
re-invokes the component, gets _another_ new promise, and suspends again. There is no point at which this
terminates on its own: no error, no stack trace, no failed assertion — just a component that never
commits, which manifests as a test or a page that hangs rather than one that fails loudly. A cache
that stores results and re-wraps them into `Promise.resolve(result)` per call reintroduces exactly
this bug, because `Promise.resolve(result)` still allocates a new promise object every time it
runs. Keying the `Map` by `cacheKey`'s canonical string (stable across parameter key order — see
that function's doc comment) and returning the _stored_ promise by reference is what makes two
renders of the same query, or two components mounting the same query independently, converge on
one request and one identity `use()` can recognize as already-seen. `QSpecProvider` and
`useQSpecQuery` build directly on `get`'s return value for exactly this reason — they have nothing
to do to it but hand it to `use()`.

### 10.3 Why `@qspecs/recharts` registers no core `Renderer`

`@qspecs/core`'s plugin API exposes a `renderers` registry (§5 above) alongside
`queryLanguages`, `sources`, `transforms`, and `presentations`. `@qspecs/recharts` does not use it
— it registers nothing with `api.renderers`, and `QSpecChart` is a plain React component export,
not something reached through a `QSpec` runtime at all.

The `Renderer` interface exists for outputs that are _values a registry produces_: something that
takes a `QSpecResult` and returns a self-contained artifact — an SVG string, a PNG buffer, a
CLI table's text, a PDF's bytes — with no further framework involvement. A React chart is not that
shape. It is a _component tree_ that a host's own React application composes into its own render
output, subject to that host's own re-render, context, and Suspense behavior — `QSpecChart` needs
a `<Suspense>` boundary above it and a `QSpecProvider` above that, neither of which a
value-returning `Renderer.render(result)` call could express. Forcing React into the `Renderer`
contract would mean either inventing a component-returning variant of an interface designed
around plain values (weakening the guarantee every other renderer relies on: call this function,
get a finished artifact back), or accepting that the "artifact" a React `Renderer` returns is
itself something the host must still mount, hydrate, and re-render correctly outside the registry
— at which point the registration would have added a layer of indirection over what
`QSpecChart(props)` already does directly, without adding any capability. `@qspecs/react` and
`@qspecs/recharts` are consumed by importing and rendering them like any other React
package — `<QSpecChart dataset={result.data} presentation={result.presentation} .../>` inside a
tree the host already owns — not by asking a `QSpec` runtime to produce one for you.

### 10.4 Why line/bar/area pivot into a wide-row table while scatter does not

`resolveSeries` (§8 above) returns one independent `{x, y}[]` point list per `ResolvedSeries`, with
no promise that two series share x values, point counts, or ordering (documented as a deliberate
contract property in `docs/known-gaps.md`'s "Grouped series produce sparse, non-aligned x sets").
Recharts' `<Line>`, `<Bar>`, and `<Area>` do not consume that shape directly: each reads its data
from the _chart's_ shared `data` prop via a per-element `dataKey` accessor, not from a `data` prop
of its own — `<Bar>` in particular renders nothing at all if given per-series data, because there
is no chart-level row for it to find its slice of. `buildWideRows`
(`packages/recharts/src/internal/cartesian.tsx`) exists to bridge that gap: it pivots every
series' points into one row per distinct x value, with each series' y value (or a legitimate
`undefined`, tracked separately from "not yet set" via a `filled` index set) at its own fixed
slot, so `<Line>`/`<Bar>`/`<Area>` can each pull their column back out with a closed-over index
function instead of a caller-chosen field name that might collide with another series' name.
`<Scatter>`, by contrast, takes its own `data` prop directly and has no notion of "shared rows" at
all — each series is its own independent point cloud on the same axes, which is exactly what
`ResolvedSeries.points` already is. Pivoting it would throw away the shape Recharts wants there,
not provide one it's missing, so `ScatterChart` feeds `oneSeries.points` straight to each
`<Scatter>` and skips `buildWideRows` entirely.

The pivot keys each row on the x _value_ (deduplicated by `typeof` plus `String`, so a numeric `1`
and a string `"1"` never collide onto one row) rather than on position, because two series need not
visit x values in the same order or even share all of them. But keying on the value alone would
still leave row _order_ undefined — a `Map` provides no ordering guarantee tied to what a reader
would expect. That's what `SeriesPoint.index` is for: `resolveSeries` stamps every point with the
index of the dataset row it came from, and `buildWideRows` sorts the pivoted rows by the _lowest_
`index` folded into each one (`minIndex`), not by first-appearance order while iterating series in
turn. Iterating series-by-series and taking first-seen order would get this wrong for exactly the
case grouping creates: dataset rows `Jan/West, Feb/East, Mar/West` visited series-by-series would
see West's `Jan, Mar` before East's `Feb`, producing an x axis ordered `Jan, Mar, Feb` with no
error and nothing in the output to indicate the mistake. Sorting by each row's earliest
contributing dataset row recovers the dataset's own order regardless of how `resolveSeries`
partitioned rows into series — `SeriesPoint.index` is the one piece of information that survives
grouping and lets the pivot reconstruct it.

## 11. Package status

`@qspecs/transforms`, `@qspecs/charts`, and `@qspecs/testing` (the in-memory data source and shared
contract-test suites used throughout this repository's own test suite) are implemented alongside
`@qspecs/core`, `@qspecs/schema`, and `@qspecs/cli`, as are `@qspecs/sql` and `@qspecs/postgres` (§9
above). [`test/postgres-pipeline.test.ts`](../test/postgres-pipeline.test.ts) runs SPEC.md §116's
complete flow — JSON manifest through chart presentation, minus the React/Recharts rendering step
— against a real PostgreSQL server. "Schema validation" in that flow is `@qspecs/
core`'s own structural validator (§3 above), not `@qspecs/schema`'s Ajv-based one: `@qspecs/core`
has zero runtime dependencies, so Ajv structurally cannot run inside `prepare()`. `@qspecs/schema`
is exercised separately, by the CLI's `validate` command against `fixtures/valid/*.qspec.json`.
`@qspecs/transforms` and `@qspecs/charts` reach that same PostgreSQL data only through this one
test — neither has a dedicated PostgreSQL integration suite of its own.

`@qspecs/http`, `@qspecs/react`, and `@qspecs/recharts` (§10 above) close the rendering step that
`test/postgres-pipeline.test.ts` explicitly stops short of: every package in this repository is
now implemented, and [`test/react-pipeline.test.tsx`](../test/react-pipeline.test.tsx) exercises
all three together — a manifest on a server with a real PostgreSQL, across `@qspecs/http`'s wire
protocol, through a React 19 Suspense boundary in a jsdom "browser", into a Recharts SVG — with a
dedicated assertion that no SQL statement, table name, connection string, or password crosses the
HTTP boundary. `test/boundaries.test.ts` enforces the same server/browser separation for these
three packages mechanically (§6 above): none may declare or import a database driver, exactly like
`@qspecs/sql`, `@qspecs/transforms`, and `@qspecs/charts` before them. See the package table in
[`README.md`](../README.md) for runtime/peer dependencies and environments;
`docs/superpowers/specs/2026-08-09-qspec-design.md` §3 has the full target architecture, and
[`docs/known-gaps.md`](known-gaps.md) records what this plan deliberately leaves open (SSR/RSC,
automatic parameter forms, the SPEC.md §66 shape divergence, and the nested-`Date` HTTP round
trip).
