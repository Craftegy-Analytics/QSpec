# Known gaps and deferred items

Carried forward from the foundation plan
([`superpowers/plans/2026-08-09-qspec-foundation.md`](superpowers/plans/2026-08-09-qspec-foundation.md)).
Everything here was found by review, judged deliberately, and left open on purpose. Nothing
in this file is a surprise; it exists so the next phase does not rediscover it.

---

## API notes that will bite consumers

### `QSpecError.details` is always an own property

`details` is a class field, so with `target: ES2022` TypeScript emits a bare `details;`
declaration and **every** `QSpecError` has an own `details` property, set to `undefined`
when unused. Consumers must test `error.details !== undefined` — `"details" in error` is
always true. Same applies to `path`.

### Typed presentation plugins need a `type` alias, not an `interface`

`PresentationType<T>` assignability requires `T` to carry `PresentationDefinition`'s
implicit index signature. Only `type` aliases get one; an `interface` does not, and fails
under `exactOptionalPropertyTypes` with TS2375.

Settled, not pending: both shipped typed presentations follow the rule.
`CartesianPresentation` and `PiePresentation` (`packages/charts/src/types.ts`) are declared
as `type` aliases, and each of `cartesian.ts` / `pie.ts` ends with a `const _typeAliasCheck:
PresentationType = …` line whose only job is to fail the build if someone converts either to
an `interface` — the failure otherwise appears far from its cause and does not name it.

### `maxManifestBytes` is string-input only

Enforced when `parseManifest` receives text; bypassed when it receives an already-parsed
object. Deliberate: the limit bounds the cost of turning untrusted text into objects, and a
caller holding a parsed object has already paid it. Enforcing it honestly would require
`JSON.stringify` on every `prepare()`. `maxTransforms`, `maxRows`, and `maxExpressionDepth`
cover post-parse work on both paths.

---

## Accepted permanently

- `isPlainObject` rejects cross-realm plain objects. Fails closed; no known consumer.
- The `"N to M"` arity branch in expression normalization is unreachable — no operator has a
  finite max distinct from its min. Harmless.
- The CLI's "internal validator mismatch" branch cannot be exercised end-to-end now that the
  two validators agree by construction. Testing it would require a stubbed validator, which
  would assert the stub rather than the guarantee. It stays as a field tripwire.
- `resolveSeries` merges a `null`/`undefined` group value and a genuinely-empty-string group
  value into one series keyed `""`, labelled `"(none)"`
  (`packages/charts/src/internal/resolve-series.ts`). Deliberate, pinned by a test, not an
  oversight: a distinct sentinel for "missing" would itself have to be a string, and every
  string candidate is either ugly or just as collidable with a real group value as `""` is —
  there is no string key space wide enough to rule collisions out entirely. If separation
  between the two cases is ever needed, the route is a non-string key (a `Symbol`, or a
  structured `{ present: boolean; value: string }`) — provably uncollidable, since
  `String(raw)` always yields a plain string — at the cost of every consumer of
  `ResolvedSeries.key` widening from `key: string`.

---

## Charts and presentation — recorded in Plan 2, for Plan 4 to weigh

Everything below was found while reviewing `@qspecs/charts`. None of it is implemented, and
none of it should be until renderers exist; the point of writing it down now is that the
reasoning is fresh and Plan 4 should not have to rediscover it.

- **`formatting` has no representation.** SPEC.md §100 lists `formatting` among the chart v1
  support, but neither `CartesianPresentation` nor `PiePresentation` declares it and neither
  validator looks for it. The only formatting concept that exists anywhere is dataset-level
  (`FieldDefinition.format`, `packages/core/src/types/dataset.ts`), which is a property of
  the column and not of how a particular chart draws it. A chart-level `formatting` block is
  therefore genuinely absent, not merely unvalidated. It is the only item on that §100 list
  in that position: `x field`, `series`, `labels`, `legend`, and `tooltip` all have declared
  shapes and are validated.

- **Neither presentation validator reads its `PresentationValidationContext`.**
  `validateCartesian` and `validatePie` both take `_context` and ignore it, so `@qspecs/charts`
  does no field-_type_ checking at all: a `pie` whose `value` points at a `string` column
  validates clean, as does a `scatter` on a `boolean`. Core still catches unknown field
  _names_ through `fieldReferences`, so the failure mode is a chart that plots nonsense rather
  than one that references nothing. Worth revisiting when renderers land and it becomes clear
  which types each renderer can actually accept — deciding that now, with no renderer to
  answer to, would just be a guess encoded as validation.

- **Grouped series produce sparse, non-aligned x sets.** `resolveSeries` partitions rows by
  `groupBy`, and each resulting series carries only the rows that had that group value. Two
  series therefore need not share x values, nor have the same point count, nor be sorted the
  same way. This is a **contract property renderers must handle**, not a defect: Recharts (and
  most charting libraries) want one row per x with a column per series, so a renderer is
  responsible for pivoting and gap-filling to whatever its library expects. Doing that inside
  `resolveSeries` would bake one library's data shape — and one answer to "what does a missing
  point mean?" — into the shared layer. Do not change the behaviour; document it wherever
  `ResolvedSeries` is consumed.

- **There is no pie equivalent of `resolveSeries`.** `resolveSeries` exists precisely so that
  renderers cannot disagree about ordering, null handling, and the `"(none)"` label. Pie has
  no such function, so every pie renderer will re-derive slice ordering and its own answer for
  a null category — the exact divergence `resolveSeries` was written to prevent, one chart
  type over. Recommend adding `resolvePie` early in Plan 4, while the `"(none)"` policy above
  is still fresh, rather than after two renderers have each picked something different.

- **`@qspecs/testing` is `"private": true`, so the contract suites are repo-internal.** They
  keep _this repository's_ transforms and presentation types honest; a third party cannot
  import them. That is deliberate for now — publishing a test-support package is a real
  compatibility commitment, and the suites are still changing shape. If third-party plugin
  authors ever become a goal, publishing them is a Plan 5 packaging decision, and it should
  be taken as one (versioning, peer range on `vitest`, stability promise) rather than by
  flipping the `private` flag.

---

## `@qspecs/http`, `@qspecs/react`, and `@qspecs/recharts` — recorded in this plan

### `useQSpecQuery` deliberately departs from SPEC.md §66's example shape

SPEC.md §66 sketches

```ts
const { data, presentation, loading, error, refetch } = useQSpecQuery({ manifest, parameters });
```

`useQSpecQuery` (`packages/react/src/internal/use-qspec-query.ts`) does not return this. Its
actual signature is `useQSpecQuery(resource: string, parameters?: QueryParameters): QSpecResult`
— it takes a resource _name_, not a `manifest` object (the manifest lives server-side, resolved by
name across the HTTP boundary — §10.1 in `docs/architecture.md`), and it returns the resolved
`QSpecResult` directly, with **no** `loading`, no `error`, and no `refetch` field:

- **No `loading`.** A component calling this hook is in exactly one of two committed states: it
  suspended (and whatever `<Suspense fallback>` wraps it is what's on screen) or it already has
  the data. There is no third, "loading but still rendering this component" state for a boolean
  to represent.
- **No `error`.** A rejected query rethrows out of `use()`, the same way a rejected promise
  rethrows out of `await` — the nearest error boundary is what has to know about that, not this
  hook's return value. `QSpecResource` (`packages/react/src/internal/resource.tsx`) is the
  declarative wrapper: it suspends, then hands the render-prop child a `QSpecResult`, never a
  `{ data, error }` union.
- **No `refetch`.** `useQSpecInvalidate()` returns an imperative `invalidate` that drops the
  matching cache entry and forces every component reading that query to re-render and refetch —
  there is no per-query `refetch` closure to call instead.

This is a deliberate, Suspense-idiomatic design (`use()` requires it — see `docs/architecture.md`
§10.2 for why the cache holds promises, not results), not an incomplete implementation of the
spec's sketch. **SPEC.md §66's example is now stale** and should be read as the plan's original
aspiration rather than this codebase's actual API; the code and its doc comments
(`use-qspec-query.ts`, `resource.tsx`) are authoritative.

### Dates nested inside `object`/`array` cells do not survive the HTTP round trip

`normalizeResult` (`packages/core/src/internal/normalize-result.ts`) converts a _top-level_ `Date`
cell to an ISO string specifically so a `Dataset` survives `JSON.stringify` — a `datetime`-typed
field round-trips through `@qspecs/http` correctly. A `Date` nested inside a composite
(`object`- or `array`-typed) cell is deliberately left alone by that function, on the theory that
an adapter hands back JSON-shaped values inside composite columns. `createQSpecHandler`
JSON-serializes the whole `QSpecResult` to send it, so a `Date` in that nested position
round-trips as whatever `JSON.stringify` turns it into (an ISO string) but arrives at the browser
as a plain string — `typeof` is `"string"`, not `"object"`, and `instanceof Date` is `false`. This
is core's pre-existing, documented design (see `normalize-result.ts`'s own comment), not a defect
`@qspecs/http` introduces or could fix on its own; `packages/http/src/index.ts`'s module doc
comment and `executor.test.ts` both record it, the latter pinning the exact post-JSON shape.

### A `scatter` presentation with a `date`/`datetime` x gets a category axis, not a real time scale

`scatterAxisType` (`packages/recharts/src/internal/cartesian.tsx`) picks Recharts' axis `type`
from the dataset's declared field type: `"number"` only when every field checked is `number` or
`integer`, `"category"` otherwise — including for `date` and `datetime` fields. This is
deliberately the safe default and a real improvement over a hardcoded `type="number"` axis (which
would render an empty plot for any non-numeric field, the "silently empty chart" this package
exists to avoid), but it is not the eventually-right answer for a temporal x: Recharts supports a
genuine time scale, which `scatterAxisType` does not attempt to select. A scatter plot against a
`date`/`datetime` x axis today spaces points evenly by category (input order / uniqueness), not
proportionally by elapsed time — dates six days apart and six months apart render the same
distance apart on the axis. Worth a dedicated `"date"`-aware axis type in a later pass, once a
renderer needs it.

### No SSR or React Server Component support

`@qspecs/react` and `@qspecs/recharts` both mark every entry-point export `"use client"`
(`packages/react/src/index.ts`, `packages/recharts/src/index.ts`) — a signal to RSC-aware
bundlers that this code needs a client boundary, not a guarantee that it works correctly when
rendered on the server. Nothing in either package's `QSpecProvider`, `useQSpecQuery`, or
`QSpecChart` has been exercised outside a browser-like (jsdom) environment: `use()` suspending
during a server render, streaming a suspended boundary to the client, or hydrating a
server-rendered chart are all unverified. Recharts itself renders SVG via DOM measurement, which
has no meaning during a pure server render. Treat both packages as client-only until a future
plan deliberately designs and tests an SSR/RSC story.

### Automatic parameter forms (SPEC.md §67) remain unbuilt

SPEC.md §67 describes a future capability: generating a parameter input form from a manifest's
declared `spec.parameters` metadata (type, enum values, required-ness). Nothing in this plan
builds it — `QSpecResource` and `useQSpecQuery` both take already-resolved parameter _values_,
never parameter _declarations_, and neither package inspects a manifest's parameter schema at
all (the browser never even sees the manifest — only a resource name). SPEC.md itself calls this
future work belonging outside core; it stays that way.

### The HTTP handler is unauthenticated by design

`createQSpecHandler` (`packages/http/src/internal/handler.ts`) has no auth hook, no session check,
and no rate limiter — its `QSpecHandlerOptions` accepts only a `runtime` and a `manifests` map. It
resolves whatever resource name a request names against that map and executes it on the host's own
runtime, with the host's own credentials, for _any_ caller that can reach the endpoint. This is the
same posture `@qspecs/postgres` takes toward connection strings (host-supplied configuration, not
this package's concern) applied to the network boundary instead: the host is expected to mount the
handler behind its own authentication and authorization, exactly as it supplies its own
`DATABASE_URL`. **This is stated plainly in the README's install section, not only here** — an
unauthenticated endpoint that executes server-side queries against a real database is a serious
mistake to make by omission, and a reader who only skims the install instructions must still see
the warning.

---

## SQL and PostgreSQL — recorded in this plan, for a future dialect adapter to weigh

- **`@qspecs/sql` has no dialect awareness beyond the shared scanner.** `scanSql`
  (`packages/sql/src/internal/scan.ts`) was written and tested against Postgres syntax: its
  quoting rules (`E'...'` escape strings, doubled-quote escaping, `$$...$$`/`$tag$...$tag$`
  dollar-quoting, nested `/* */` comments) and its `::` cast-operator exception are all
  Postgres-specific behavior, even though nothing in the package's types or public surface says
  so. `@qspecs/postgres` is the only adapter that exists, so nothing has yet exercised this
  package against a second dialect's quoting rules.

  Most SQL dialects are a reasonable superset or near-match of what the scanner already handles
  — line comments, block comments, and single-quoted strings with doubled-quote escaping are
  close to universal — but that is an assumption, not something this plan verified against a
  second engine. A MySQL adapter, in particular, would need to confirm it before trusting
  `@qspecs/sql` as-is: MySQL's backtick-quoted identifiers are not one of the scanner's five
  contexts at all, and its default single-quote escaping accepts a backslash the way Postgres's
  _only_ does inside `E'...'` — the scanner would need to learn a MySQL-specific string-literal
  branch, not just reuse the Postgres one. Whether that becomes a MySQL-specific scan mode, a
  second package, or a parameterized scanner is a design decision for whoever builds that
  adapter, deliberately left open here rather than guessed at without a second dialect to test
  against.

---

## `@qspecs/postgres` — the injection seam and connection-error handling

- **`createPostgresSource` and `PgDriver` are deliberately not exported.**
  `packages/postgres/src/index.ts` exports only `postgres()` and its option types.
  `createPostgresSource`, `PgDriver`, `renderPostgres`, `normalizePgResult`, and
  `postgresTypeName` all stay internal on purpose, not by oversight:
  `packages/postgres/test/integration.test.ts` reaches them through a relative import into
  `internal/`, so the test suite needs no export to exercise them, and there is no external
  use case yet that needs to inject a non-`pg` driver — exposing `PgDriver` would commit the
  package's public surface to a `pg`-shaped seam (its `PgPool`/`PgPoolClient`/`PgCancelClient`
  interfaces) speculatively. The asymmetry that drives keeping it closed for now: adding an
  export later, once a real second driver or a host that wants to inject its own pool shows
  up, is non-breaking; removing one after publish is a breaking change for anyone who took a
  dependency on it. Reopen this once a concrete consumer needs to supply its own `PgDriver`.

- **One `pg-pool` `'error'` window remains open after the idle-client fix.**
  `createNodePostgresDriver` (`packages/postgres/src/internal/driver.ts`) attaches an
  `'error'` listener to the `pg.Pool` and to the out-of-band cancel `pg.Client` at
  construction, which closes the crash where an _idle, checked-in_ client's socket fails
  between queries — verified against `node_modules/pg-pool/index.js`: `newClient` attaches a
  per-client `idleListener` to `'error'` right after connect (`client.on('error',
idleListener)`), and `_release` re-attaches the same listener every time a client comes
  back to the pool (`_release`'s `client.on('error', idleListener)`), so a failure on a
  pooled-but-unused client always reaches `idleListener`, which forwards it to
  `pool.emit('error', ...)` — exactly what `pool.on("error", onError)` in `driver.ts`
  catches.

  What that does not cover: `_acquireClient` — run on every checkout, i.e. every
  `pool.connect()` — calls `client.removeListener('error', idleListener)` before handing the
  client back to the caller, and `_release` does not re-attach it until the client comes back
  from `release()`. So for the entire window a client is checked out (including while it sits
  idle _between_ the caller's queries, not just mid-query), it carries no `'error'` listener
  at all: neither `idleListener` (removed at checkout) nor anything of ours (the `PgPool`/
  `PgPoolClient` seam in `driver.ts` never calls `.on()` on the per-connection client, only
  on the pool itself at construction). A socket failure on that client in that window is an
  `'error'` emit with zero listeners, which is an uncaught exception in Node and crashes the
  process — the same failure mode the idle-client fix closed, just on the other side of
  checkout.

  Closing it needs a listener attached to the _checked-out_ client itself, scoped to its
  checkout lifetime, which the current `PgDriver`/`PgPool`/`PgPoolClient` interfaces in
  `driver.ts` do not model — `PgPoolClient` exposes only `processID`, `query`, and `release`,
  not the underlying `pg` client's `EventEmitter` surface. Left open rather than patched
  narrowly here because the right fix touches the seam's shape (what `connect()` returns and
  what it lets a caller attach), not just `createNodePostgresDriver`'s body.

---

## Worth fixing, not urgent

- **`validateDataset`'s type-mismatch branch is unreachable through `execute()`.** (Referenced
  by this title, not by number — do not call it "item 2"; that ordinal names a different,
  already-closed gap in this file's history, and reusing it here would read as reopening it.)

  `validateDataset` (`packages/core/src/internal/validate/dataset.ts:49`) has three branches: a
  declared field missing from the result, a declared field whose `type` disagrees with the
  result's inferred type, and a non-nullable declared field that is `null` in some row. Only
  the first and third are reachable end to end through `qspec.execute()`. The type-mismatch
  branch is not, and it is not a corner case — it cannot fire for **any** manifest that
  declares `spec.dataset`, for any data a source returns. This is a latent defect in an
  existing branch, not something that blocks a later phase from starting: nothing currently
  planned depends on this branch firing.

  The cause is `normalizeResult` (`packages/core/src/internal/normalize-result.ts:98-101`): for
  a field present in both the query result and the declared schema, it returns `{ name,
...definition }` — the declared field definition, copied onto the field wholesale — and
  discards the type it would otherwise have inferred from the actual row data. By the time
  `validateDataset` runs, `field.type` (copied from the declaration) and `definition.type` (the
  declaration itself) are the same value, and `typeSatisfies` is reflexive
  (`packages/core/src/internal/validate/dataset.ts:13`), so the comparison can never disagree
  with itself. The same copy also stamps the declared `nullable` onto the field, so
  `result.data.fields` reports **declared** nullability, not the nullability actually observed
  in the rows — a source that promised `nullable: false` and returned nulls anyway is still
  caught (by the separate row-scanning branch, which reads row data rather than field
  metadata), but a consumer reading `result.data.fields[i].nullable` after the fact sees the
  manifest's claim, not what came back.

  This is why `packages/postgres/test/integration.test.ts`'s dataset-validation test asserts a
  missing-field issue and a non-nullable-NULL issue, and explicitly does not attempt a
  declared-vs-actual type mismatch through `execute()` — there is no way to produce one; the
  test's own comment says so. `packages/core/src/internal/validate/dataset.test.ts`'s "reports
  a declared type mismatch" test is real but calls `validateDataset` directly with a hand-built
  `Dataset`, bypassing `normalizeResult` — it exercises the branch as a unit, not as something
  `execute()` can ever reach.

  **This is a pre-existing behavior from Plan 1**, not introduced by the plan that found it
  (query-runtime), and it is not fixed here: `normalizeResult` is exercised by two plans' worth
  of tests, and changing what it returns for a declared-and-present field this late would
  ripple through both. It is recorded so a future `@qspecs/core` change can pick between two
  resolutions, both of which are real fixes rather than workarounds:
  - **Make `normalizeResult` keep the inferred type** for a present field, alongside (or
    instead of) the declared one, so `validateDataset` compares an actual inference against a
    declaration instead of a declaration against itself. This also fixes the `nullable` side
    effect above, and is the change that makes the branch mean what its message says.
  - **Or decide the branch is dead on purpose and act accordingly**: remove it and the
    `dataset.ts:49` code path it can never take, and reconsider (rather than delete outright)
    its direct unit test in `dataset.test.ts`, since a unit test asserting a function's
    internal correctness is legitimate even when nothing production-reachable currently drives
    that path.

  Either is a deliberate call for whoever owns `@qspecs/core` next; the plan that found it takes
  neither, because it is not that plan's defect to fix.

- **Registry duplication.** The empty-name guard is byte-identical in `register` and
  `replace`; `replace`'s guard is untested; the empty-name error omits `details` while the
  duplicate error includes it. All three collapse into one `assertName()` extraction.
- **Diagnostics are inconsistent across five "unknown capability" paths.** Unknown
  kind/language/source throw dedicated classes carrying the hint in `details.suggestion`;
  unknown transform/presentation throw `ManifestValidationError` with the hint in a proper
  `QSpecIssue.suggestion`. Codes disagree for the identical situation
  (`_RESOURCE_KIND_UNKNOWN` vs `_SOURCE_NOT_FOUND`). Unify before the surface grows.
- **`validate/dataset.ts` mixes coordinate systems** inside one error list: some paths are
  manifest-rooted (`spec.dataset.fields.amount`), others dataset-rooted (`rows[3].amount`).
  Both render identically through `formatPath`. Add a root discriminator.
- **`SchemaIssue` diverges from `QSpecIssue`**: a dotted string path with no `code`, versus a
  segment array with one, and they disagree on the root representation. The CLI cannot put a
  `SchemaIssue` through `printIssues`, so its one unreachable "internal validator mismatch"
  branch formats them with an inline `.map()` instead
  (`packages/cli/src/commands/validate.ts:131`) — a second formatting expression, not a
  second renderer. Align before other packages consume `@qspecs/schema`.
- **`validation:end` carries a hardcoded empty `issues` array** at three of four emit sites,
  because those stages throw instead of collecting. Observers see a `validation:start` with
  no matching `end` on failure.
- **Dead exports:** `assertValidPresentation` (zero callers — `prepare.ts` re-implements it
  inline) and `ownKeys` (`packages/core/src/json.ts`, referenced only by its own test).
  `editDistance` is **not** dead — `suggest()` calls it at
  `packages/core/src/internal/suggest.ts:39`; it was listed here in error. **Plumbed but
  never read:** `ExecutionContext.metadata`, `QSpecPlugin.version`,
  `RawQueryResult.metadata.durationMs`, and `manifest:parse:start.bytes` — declared optional
  on the payload type (`packages/core/src/types/events.ts:15`) but never _emitted_:
  `prepare.ts:150` emits `{}`. (The byte count in `define.ts` is a different value, computed
  for the `maxManifestBytes` check and used there.)
- **`UnsupportedApiVersionError` is exported but never constructed by application code**
  (`packages/core/src/errors.test.ts` constructs one inside a generic error-class table test) —
  the condition is emitted as an issue inside a `ManifestValidationError`, so no consumer can
  catch the class.
- **`maxRows` is applied at normalize time and never re-checked**, so a transform can grow a
  dataset back past the cap.
- **Two copies of `PARAMETER_REFERENCE`** exist — `packages/core/src/internal/bindings.ts:8`
  and `packages/core/src/internal/validate/manifest.ts:14`. They accept exactly the same
  strings; only the capture group differs (bindings reads `match?.[1]`, the validator slices
  the prefix). One pattern, two places to edit.

  The comment claim previously recorded here was wrong in both directions and is withdrawn.
  The comment exists (`validate/manifest.ts:111`: "Matches compileBindings's message exactly
  … so `validate` and `prepare` agree") and it is **true** — the undeclared-parameter message
  is byte-identical at `validate/manifest.ts:122`, `bindings.ts:58`, and `bindings.ts:90`,
  and `manifest.test.ts` pins the exact string and suggestion rather than trusting the
  comment.

  What actually diverges is the pair of messages the comment does _not_ cover: for a
  malformed string binding, `validate/manifest.ts:144` says "A string binding must be a
  parameter reference…" while `bindings.ts:50` says `Binding "x" must be a parameter
reference…`; the "exactly one of" object-shape message differs the same way
  (`validate/manifest.ts:164` vs `bindings.ts:78`). So `qspec validate` and `prepare()` word
  the same defect differently on those paths, which is the gap the comment was trying to
  close.

- **The CLI prints a duplicate line** for "must be a JSON object" and unsafe-key errors,
  where the aggregate message and the sole issue message are identical.
- **`closest()` in `packages/transforms/src/internal/issues.ts` duplicates
  `@qspecs/core`'s internal `suggest()`/`editDistance()`** (`packages/core/src/internal/suggest.ts`)
  — same Levenshtein distance, same length-scaled threshold, copied rather than shared because
  `@qspecs/transforms` cannot reach `@qspecs/core`'s `src/internal/`. `@qspecs/charts` does not
  need its own copy: presentation "did you mean" suggestions are computed centrally by core's
  `validatePresentation`, which calls the real `suggest()` once a `PresentationType` reports
  its field references — only a transform's own `validate()` has to produce the suggestion
  itself, because core has no equivalent central pass for transform issues. One duplicate
  today; candidate for promotion to a small public core export (e.g. re-exporting `suggest`
  alongside the expression subsystem) if a third consumer needs the same "did you mean" logic.
- **The presentation contract suite partially no-ops on omitted optional methods.**
  `PresentationType.validate` and `fieldReferences` are both optional. A type that
  omits them still FAILS three of the suite's six assertions — the
  validate-reports-or-throws check evaluates `expect(false).toBe(true)`, and both
  field-reference checks (completeness against `expectedReferences`, and
  paths-relative-to-the-presentation-node) assert a non-empty result. The other
  three (accepts-fixture, no-throw-on-malformed, paths-are-string-or-number) pass
  trivially. So an omitting type is caught, just for less specific reasons than the
  suite's names suggest. Mirroring the transform suite's explicit "declares
  describe()" assertion would make the intent clearer, but the risk is smaller than
  a naive reading of the suite implies.

---

## Plan 5 — CLI, examples validation, and documentation

Plan 5 shipped `qspec inspect`, plugin-aware `qspec validate` (which closed this file's
former "Blocking a later phase" section — that whole section was deleted, not reworded, by
the commit that added `--config`; verified against `git log -p -- docs/known-gaps.md`),
eleven validated example manifests, all fifteen SPEC.md §92 documentation topics plus a
sixteenth (`docs/public-api.md`, SPEC.md §104), and a documentation drift guard. This is the
last planned phase, so this section is where any remaining loose ends have to live rather than
being handed to a next plan.

### Observed flaky test — identity not captured, not chased

During Plan 4's merge verification, one full-suite run on `main` reported
`1 failed | 965 passed`; four subsequent runs of the same suite were clean. **The failing
test's identity was never captured** — the run's output was grepped after the fact for a
pass/fail summary rather than teed to a file, so there is no artifact to go back to. The run
was under heavy load: roughly 128 s of test time, against a normal run's ~49 s.

Prime suspects, by elimination, are this codebase's timing-bounded assertions — none proven,
all plausible under load-inflated scheduling:

- the in-memory data source's abort-timing bounds
- `@qspecs/testing`'s data-source contract suite's own timing calibration
- `@qspecs/postgres`'s query-cancellation timing test
- `test/react-pipeline.test.tsx`'s `waitFor` calls

Reproducing this needs the load conditions that produced it, not just a re-run — four clean
re-runs (and every run since) did not reproduce it. **This is deliberately not chased**:
guessing which assertion to widen without the failing test's identity would risk masking a
real bug behind a loosened bound. It is recorded here, with these specifics, so that if it
recurs, whoever sees it next runs with output captured (`... | tee`, not `... | grep` after
the fact) and has a starting list of suspects instead of starting from zero. A flake nobody
writes down is a flake nobody fixes.

### `bin.ts`'s `inspect --config` rejection — now covered

Task 3's review left this open: `qspec inspect --config` is rejected with exit code 2, but
that behavior had no automated test, only a one-time manual check against the built CLI.
`bin.ts` ran `process.exitCode = await main()` as a module-level side effect against the real
`process.argv`, so importing it from a test would have run the real CLI against the test
runner's own argv.

**Closed in this task**, via the no-behavior-change refactor the review sketched:
`main` is now `export async function main(argv = process.argv.slice(2), baseIo = defaultIo())`,
parses via `parseArgs({ args: argv, ... })` instead of relying on `parseArgs`'s implicit
`process.argv.slice(2)` default, and the module-level auto-run is guarded by
`import.meta.url === pathToFileURL(entryPoint).href` (`entryPoint` being `process.argv[1]`,
checked for `undefined` first — `noUncheckedIndexedAccess` is on and a non-null assertion is
off the table). Running as `node dist/bin.js ...` still auto-runs `main()` against the real
argv and real streams exactly as before; importing `main` from `bin.test.ts` no longer does.
`packages/cli/src/bin.test.ts` now asserts the exit-2 rejection directly, plus `--version`,
`--help`, no-command, and unknown-command routing that had the same "verified by hand only"
status. Verified manually against the built binary too
(`node packages/cli/dist/bin.js inspect --config examples/qspec.config.js …` still exits 2
with the same message) as part of this task's clean-verification pass, since a CLI's argv
handling and exit codes are user-facing and worth checking twice.

### `qspec run` remains unbuilt, by SPEC.md's own permission

SPEC.md §102 lists only `qspec validate` and `qspec inspect` for CLI v1, and explicitly
permits postponing execution through the CLI "because configuring credentials and runtime
plugins introduces additional complexity." Plan 5 takes that permission: there is no
`qspec run`. The reason is sharper than "not yet built" — every other place this project
keeps connection strings and credentials is host-supplied configuration
(`@qspecs/postgres`'s connection options, `createQSpecHandler`'s `runtime`), never CLI
configuration. A `qspec run` would need a manifest's data source to actually connect, which
means a credential would have to reach the CLI somehow — the one place this project has
deliberately kept them out of. If `qspec run` is ever built, that boundary is the design
problem to solve first, not an afterthought.
