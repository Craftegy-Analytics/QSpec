# QSpec — Implementation Design

**Date:** 2026-08-09
**Source specification:** [`SPEC.md`](../../../SPEC.md) (QSpec Technical Specification and Architecture Requirements)
**Scope of this document:** full QSpec v1 as defined by SPEC.md §116 — all nine publishable packages.

This document does not restate SPEC.md. It records the implementation decisions that
SPEC.md leaves open, and the sequencing used to build it. Where a decision resolves a
specific section of SPEC.md, that section is cited.

---

## 1. Purpose of this document

SPEC.md is an architecture specification, not an implementation plan. It is precise about
intent and deliberately vague in places where more than one implementation would satisfy
it. Those gaps are where an implementation silently makes decisions that are hard to
reverse later, so they are resolved here, up front, with reasons.

Everything in §2 is a decision that SPEC.md permits but does not require.

---

## 2. Resolved ambiguities

### 2.1 Binding model (SPEC.md §34, §35)

SPEC.md shows bindings as `{"from": "$parameters.from"}` and types them as
`Record<string, Binding>` without defining `Binding`.

**Decision.** A binding is one of:

```ts
type Binding =
  | `$parameters.${string}`     // string shorthand, must match the pattern below
  | { parameter: string }
  | { literal: JsonValue };
```

The string shorthand is valid **only** when it matches `^\$parameters\.[A-Za-z_]\w*$`.
Any other string is a manifest validation error (`QSPEC_MANIFEST_INVALID`).

**Why.** The tempting alternative — "if the string doesn't look like a reference, treat it
as a literal" — creates a silent failure mode where a typo such as `"$parameter.from"`
becomes the literal string `"$parameter.from"` and is bound into a query. Requiring
`{ "literal": "US" }` for literal strings costs three tokens of JSON and removes the
category entirely. This directly serves SPEC.md §34 ("implementations must never
interpolate untrusted values directly into SQL strings") by making the reference/literal
distinction structural rather than heuristic.

Bindings resolve against validated parameters, so an unresolvable binding is caught during
`prepare()` (SPEC.md §81) rather than at query time.

### 2.2 Expression AST (SPEC.md §42)

**Decision.** Four node types:

```ts
type Expression =
  | { field: string }
  | { literal: JsonValue }
  | { parameter: string }
  | { operator: string; arguments: Expression[] };
```

The operator set is **fixed in core and not registry-extensible**:

| Group | Operators |
|---|---|
| Comparison | `eq` `ne` `gt` `gte` `lt` `lte` |
| Logical | `and` `or` `not` |
| Membership | `in` |
| Null | `isNull` |
| Arithmetic | `add` `subtract` `multiply` `divide` |
| Other | `coalesce` |

**Why not extensible.** SPEC.md §42 says the expression language "must remain
intentionally limited" and "must not become JavaScript represented as JSON". A registry of
third-party operators is precisely the mechanism by which that would stop being true, and
it would also make an expression's meaning depend on which plugins are installed —
breaking the determinism requirement of SPEC.md §8 and the portability requirement of §5.
Extensibility for domain logic belongs at the transform level, where SPEC.md already
provides a registry.

Expressions are depth-limited per SPEC.md §72.5 (`limits.maxExpressionDepth`, default 32).
Evaluation is a plain recursive interpreter — no `eval`, no `new Function` (SPEC.md §72.3).

Arithmetic and comparison follow explicit, documented coercion rules rather than
JavaScript's. `null` propagates through arithmetic; comparisons involving `null` yield
`false` (never `true`), and `isNull` is the only way to test for it. This is SQL-like
three-valued logic collapsed to two values at the boundary, chosen because it matches what
users writing analytics filters expect.

### 2.3 Filter shorthand (SPEC.md §40 vs §94)

SPEC.md contains two different shapes for the same `filter` transform:

```json
{ "type": "filter", "where": { "field": "revenue", "operator": "gt", "value": 0 } }
```
```json
{ "type": "filter", "where": { "operator": "gt", "arguments": [{"field": "revenue"}, {"literal": 0}] } }
```

**Decision.** Both are valid. The shorthand form — an object carrying `operator` plus
`field`/`value` and no `arguments` — is normalized into the AST form during `prepare()`.
The canonical serialization (SPEC.md §83 hashing, §111 signing) always uses the AST form.

**Why.** Both appear in the specification as valid examples, so rejecting either would make
the specification self-contradictory. Normalizing at prepare time means exactly one shape
reaches the evaluator, and canonicalizing to the AST form means two manifests that differ
only in shorthand hash identically.

### 2.4 Raw query results and normalization (SPEC.md §36, §62)

SPEC.md defines `Dataset.rows` as `Record<string, unknown>[]` but does not define
`RawQueryResult`.

**Decision.** Data source adapters return **positional** rows:

```ts
interface RawQueryResult {
  columns: readonly RawColumn[];        // { name: string; nativeType?: string }
  rows: readonly (readonly unknown[])[];
  metadata?: { durationMs?: number; truncated?: boolean };
}
```

The result normalizer converts this to `Dataset`. Dataset rows are objects created with
`Object.create(null)`.

**Why positional.** Three problems dissolve at once:

1. **Duplicate column names.** `SELECT a.id, b.id FROM ...` returns two columns named `id`.
   A `Record` loses one silently. Positional rows preserve both, and the normalizer
   disambiguates rather than dropping data: the first occurrence keeps the bare name, and
   subsequent occurrences become `name_2`, `name_3`, and so on, with a
   `dataset:normalize:duplicate-column` lifecycle event emitted for each. If a generated
   name would itself collide with a real column, the suffix increments until it does not.
2. **Prototype-polluting column names** (SPEC.md §72.4). A column genuinely named
   `__proto__` or `constructor` is representable positionally. The alternative — rejecting
   such columns — would mean QSpec cannot query legitimate tables. Null-prototype dataset
   rows then make the pollution concern moot at the consumption end.
3. **Future columnar backends** (SPEC.md §113). A positional/column-oriented raw shape is a
   short step from Arrow or a columnar dataset; a row-of-objects shape is not.

Null-prototype rows are the reason SPEC.md §72.4 can be satisfied without restricting what
data QSpec can represent. This is a deliberate trade: `row.hasOwnProperty(...)` will not
work on dataset rows, which is documented, and `Object.hasOwn(row, ...)` is the supported
form.

### 2.5 Static presentation validation (SPEC.md §80 stage 6, §81, §86)

SPEC.md requires that `presentation.series[0].field` referencing a non-existent dataset
field fail statically, with a "did you mean" suggestion. But transforms rename and drop
fields, so presentation cannot be checked against `spec.dataset` directly.

**Decision.** The `Transform` interface gains an optional schema-inference method
alongside `execute`:

```ts
interface Transform<TSpec = unknown> {
  execute(dataset: Dataset, spec: TSpec, context: TransformContext): Promise<Dataset> | Dataset;
  describe?(fields: readonly Field[], spec: TSpec): readonly Field[];
}
```

`prepare()` folds `describe` across the declared transform pipeline, starting from
`spec.dataset.fields`, to compute the projected output schema. Presentation field
references are validated against that projection, with Levenshtein-based suggestions.

A transform without `describe` is treated as schema-opaque: static validation stops at that
point in the pipeline and the remaining checks defer to runtime. All built-in transforms
implement `describe`.

When `spec.dataset` is absent entirely, presentation validation runs after execution
instead of during `prepare()`.

**Why.** Without `describe`, a manifest that renames `revenue` to `total` and then charts
`total` would either fail static validation incorrectly, or force static validation to be
abandoned altogether. `describe` is a small addition to the plugin contract that makes
SPEC.md §81's promise ("prevents unnecessary database queries") actually achievable for
real pipelines.

### 2.6 Dynamic series (SPEC.md §47)

SPEC.md says "the renderer should derive series" from `{ field, groupBy }`.

**Decision.** Pivoting is renderer-side, as specified — but `@qspecs/charts` exports a
shared resolver:

```ts
function resolveSeries(dataset: Dataset, presentation: ChartPresentation): ResolvedSeries[];
```

It handles both the explicit array form and the `{ field, groupBy }` form, and every
official renderer uses it.

**Why.** Leaving each renderer to implement pivoting independently guarantees that
Recharts, ECharts, and a CLI renderer eventually disagree about ordering, null handling,
and missing-category behavior — which would make the same manifest render differently in
different hosts, contradicting SPEC.md §5. Putting the semantics in `@qspecs/charts` (which
SPEC.md §17 says "must NOT render charts", and this does not) keeps rendering separate
while making the meaning single-sourced.

### 2.7 Manifest validation lives in core, not in Ajv (SPEC.md §12, §13, §71, §86)

SPEC.md §12 requires `@qspecs/core` to have "as few runtime dependencies as reasonably
possible" while SPEC.md §115 requires core to perform manifest validation.

**Decision.**

- `@qspecs/core` has **zero runtime dependencies** and performs hand-written structural
  validation.
- `@qspecs/schema` ships the official JSON Schema documents plus an Ajv-based
  `validateWithJsonSchema()` for editors and CI.
- A conformance test asserts both validators agree — same accept/reject verdict — across
  every fixture in `fixtures/`.

**Why.** This is not primarily about dependency count. SPEC.md §71 requires errors carrying
paths like `spec.presentation.series[0].field`, and §86 requires
`Did you mean "revenue"?`. Ajv's error output is a list of keyword failures against schema
pointers; producing SPEC.md's required diagnostics from it means substantial translation
work on top of a substantial dependency. Hand-written validation produces those messages
directly. Zero-dependency core is the second benefit, not the first.

The conformance test is what makes two validators safe. Without it they drift, and a
manifest accepted by an editor but rejected at runtime is worse than having one validator.

### 2.8 Capability typing (SPEC.md §54)

**Decision.** `QSpec<Caps>` where `.use()` unions string-literal capability names for query
languages, presentation types, and transforms. Used for autocomplete and clearer errors —
not for deep structural validation of manifests at the type level.

**Why.** SPEC.md §54 explicitly warns against type-system cleverness that degrades error
readability and compiler performance, and states "developer experience takes priority".
Type-level manifest validation is achievable in TypeScript but produces errors that plugin
authors cannot read. Literal-union capability tracking gets most of the autocomplete
benefit at near-zero complexity cost.

### 2.9 Hooks, not middleware (SPEC.md §68, §69)

**Decision.** v1 ships a typed lifecycle event emitter. Handlers are observers: they
receive event payloads and cannot mutate the execution. No middleware chain.

**Why.** SPEC.md §69 states this preference outright ("a typed lifecycle/event model may be
preferable to unrestricted middleware for v1") and gives the reason ("must not permit
accidental corruption of runtime invariants"). Middleware can be added later without a
breaking change; removing it could not be.

### 2.10 Resource limits (SPEC.md §72.5)

Configured at runtime construction, enforced in core:

```ts
createQSpec({
  limits: {
    maxRows,            // rows retained from a query result
    maxTransforms,      // transform pipeline length
    maxManifestBytes,   // parsed manifest size
    maxExpressionDepth, // expression nesting
    queryTimeoutMs,     // wall-clock per query, enforced via AbortSignal
  },
});
```

Defaults are permissive but finite. `queryTimeoutMs` composes with a caller-supplied
`signal` (SPEC.md §60) rather than replacing it.

---

## 3. Package architecture

| Package | Runtime dependencies | Peer dependencies | Environment |
|---|---|---|---|
| `@qspecs/core` | **none** | — | browser + server |
| `@qspecs/schema` | `ajv`, `ajv-formats` | — | browser + server |
| `@qspecs/sql` | none | `@qspecs/core` | browser + server |
| `@qspecs/postgres` | `pg` | `@qspecs/core`, `@qspecs/sql` | **server only** |
| `@qspecs/transforms` | none | `@qspecs/core` | browser + server |
| `@qspecs/charts` | none | `@qspecs/core` | browser + server |
| `@qspecs/react` | none | `@qspecs/core`, `react` | browser |
| `@qspecs/recharts` | none | `@qspecs/charts`, `react`, `recharts` | browser |
| `@qspecs/cli` | `@qspecs/core`, `@qspecs/schema` | — | server only |
| `@qspecs/testing` | — | — | private, never published |

`@qspecs/testing` holds the SPEC.md §89 contract suites and a `memory()` data source. The
memory source is what allows the entire pipeline to be exercised without any database, which
in turn is what allows transforms and charts to be built and verified before Postgres exists.

As of Plan 2 the package ships exactly two suites — `runTransformContractTests` and
`runPresentationContractTests`. There is **no** `runDataSourceContractTests` and no
query-language suite: nothing existed to run them against, since `memory()` is the only data
source and it is itself the fixture. Building the data-source contract suite is Plan 3's
work, alongside the Postgres adapter that first makes a second implementation exist.

The package is `"private": true` and stays that way for now, so the suites keep **this
repository's** implementations honest — they are not a supported surface for third-party
plugin authors. Publishing them is a Plan 5 packaging decision (see
[`docs/known-gaps.md`](../../known-gaps.md)).

### 3.1 Public / internal boundary (SPEC.md §104)

Each package's `exports` map exposes only `.` and `./package.json`. Internal modules live
under `src/internal/` and are unreachable through the package entry point.

Two CI checks defend this:

1. **Entry-point check** — installs each built package into a clean temporary directory and
   imports its public entry, catching accidental leakage of internals and any
   `devDependency` that escaped into runtime code.
2. **Dependency-graph check** — asserts `@qspecs/core` resolves to zero transitive runtime
   dependencies, and that no browser-targeted package reaches `pg`.

The second check exists because npm workspaces hoist, and hoisting hides phantom
dependencies that pnpm would surface. Choosing npm (per SPEC.md §115's wording) means
buying that guarantee back explicitly in CI.

### 3.2 Module strategy (SPEC.md §74, §75)

ESM-only, TypeScript source, `tsc`-emitted declarations, `"sideEffects": false`, modern
Node LTS and modern browsers. No dual CJS build until a concrete ecosystem requirement
appears (SPEC.md §75).

---

## 4. Execution pipeline

`prepare(manifest)` performs all static work once (SPEC.md §58, §81, §112):

1. Parse and size-check the manifest; preserve unknown `x-<vendor>` fields (SPEC.md §48).
2. Structural validation against the QSpec v1 shape (validation stage 1).
3. Resolve `apiVersion` and `kind`; resolve required capabilities from registries — query
   language, source, transforms, presentation type (validation stage 2).
4. Compile the parameter model.
5. Normalize expressions and filter shorthand; enforce depth limits.
6. Fold transform `describe` to project the output schema; validate presentation field
   references against it (validation stage 6).

`execute(context)` then performs only per-call work:

1. Resolve and validate parameters (validation stage 3).
2. Resolve bindings against validated parameters.
3. Compile the query (validation stage 4) and execute it through the data source adapter,
   propagating `signal`.
4. Normalize the raw result into a `Dataset`.
5. Validate the dataset against `spec.dataset` if declared (validation stage 5).
6. Run the transform pipeline in order, immutably (SPEC.md §64).
7. Build the presentation model.
8. Return `QSpecResult` with `ExecutionMetadata`.

`execute(manifest, context)` is `prepare` followed by `execute`, without caching — callers
wanting the cache use `prepare()` explicitly.

Lifecycle events (SPEC.md §68) fire around stages 1–8. Bound parameter values and
connection details are never included in event payloads or logs by default (SPEC.md §72.6).

---

## 5. Error model (SPEC.md §70, §71)

`QSpecError` base class with `code`, `cause`, `details`, and `path`. Every error class from
SPEC.md §70 is implemented with a stable machine-readable code. Validation errors carry a
`path` array; the CLI and any editor integration render it as a dotted/indexed path.

Aggregate errors are used where multiple independent problems exist (for example, several
invalid parameters) so a user sees all of them in one pass rather than one per run.

---

## 6. Testing strategy (SPEC.md §88–§91)

- **Unit tests** in every package, with the heaviest coverage in core: registries, plugin
  loading, manifest validation, parameter validation, execution lifecycle, errors,
  cancellation, transform ordering.
- **Contract tests** in `@qspecs/testing`, run against every data source, transform, and
  query language implementation.
- **Conformance test** asserting `@qspecs/core` and `@qspecs/schema` agree on all fixtures.
- **Integration tests** for `@qspecs/postgres` using testcontainers; they skip with an
  explicit message when Docker is unavailable, and run unconditionally in CI. They cover
  SPEC.md §90's list: parameter binding, execution, normalization, dataset validation,
  cancellation, and database errors.
- **Fixtures** in `fixtures/valid/` and `fixtures/invalid/` per SPEC.md §91, shared across
  schema, core, and CLI tests.

---

## 7. Build sequence

Five plans, each independently reviewable.

1. **Foundation** — workspace, CI, build pipeline, `@qspecs/core`, `@qspecs/schema`,
   `qspec validate`. Completes SPEC.md §115.
2. **Data & presentation** — `@qspecs/transforms`, `@qspecs/charts`, `@qspecs/testing` with
   the memory source. Full pipeline runs end-to-end with no database.
3. **Query runtime** — `@qspecs/sql`, `@qspecs/postgres`, testcontainers integration tests.
4. **React** — `@qspecs/react`, `@qspecs/recharts`.
5. **Tooling & docs** — `qspec inspect`, examples, documentation set (SPEC.md §92), README,
   architecture document. Completes SPEC.md §116.

Plans 2 and 3 are deliberately reordered relative to SPEC.md §103's phases. Transforms and
charts are pure functions requiring no infrastructure; building them first means the
Postgres work lands against an already-verified pipeline, so a failure during plan 3 is
unambiguously a Postgres failure. The specification's phase ordering is a description of
dependency, not a required build order, and nothing in plan 2 depends on plan 3.

---

## 8. Acceptance

This design is complete when SPEC.md §117's criteria hold. The two that most constrain the
above decisions:

- *Extensibility* — a third party adds ClickHouse without changing `@qspecs/core`. Satisfied
  by the registry model plus the `DataSource` contract and its contract test suite.
- *Presentation independence* — a third party implements ECharts rendering without changing
  the Chart specification. Satisfied by `resolveSeries` living in `@qspecs/charts` and the
  `x-<vendor>` extension convention (SPEC.md §48).
