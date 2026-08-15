# Transforms

`spec.transforms` (SPEC.md §40) is an ordered array of declarative reshaping steps that run after
a query result has been normalized into a `Dataset` and validated against `spec.dataset` (Stage 5
— see [`docs/architecture.md`'s six validation stages](architecture.md#3-the-six-validation-stages-specmd-80)).
This document covers the six transforms `@qspecs/transforms` ships, the expression AST `filter` and
`derive` compile through, the `describe()` contract and what a manifest author loses by skipping
it, and the ordering guarantee the pipeline makes.

```json
{
  "transforms": [
    { "type": "filter", "where": { "field": "revenue", "operator": "gt", "value": 0 } },
    { "type": "sort", "field": "month", "direction": "asc" },
    { "type": "limit", "count": 100 }
  ]
}
```

(SPEC.md §40's own example.) What a `Dataset` looks like before any transform touches it is
[Datasets](datasets.md); what a `Chart` presentation validates a transform's _output_ schema
against is covered below and in full in [Presentations](presentations.md).

## Ordering: strict, sequential, immutable

Transforms execute in declared order, and each one sees only the previous transform's output —
never the original query result, never a later transform's output (SPEC.md §40: "Transforms
execute sequentially"). `execute()` (`packages/core/src/internal/execute.ts`) implements this by
reassigning a local `dataset` binding from each transform's return value in a plain `for` loop:

```ts
for (const transform of plan.transforms) {
  dataset = await transform.implementation.execute(dataset, transform.spec, { ... });
}
```

Nothing here parallelizes or reorders independent-looking steps — declaration order is the only
order. This is also why every built-in transform returns a fresh `Dataset` (`{ ...dataset, rows,
fields }` or similar) instead of mutating its input in place: an earlier transform's input "must
survive untouched" (the executor's own comment, citing SPEC.md §64), which matters because a
transform is a plain function a plugin author writes — nothing stops one from holding a reference
to the dataset it was handed, and a shared-mutation bug there would be almost impossible to
localize once three or four transforms deep.

A transform's `spec.type` selects an implementation from the `transforms` registry (Stage 2 —
plugin capabilities), so a manifest naming a transform no installed plugin registers fails
`prepare()` before any query runs, the same as an unregistered query language or data source.

## The six built-in transforms

`@qspecs/transforms`' `transforms()` plugin (`packages/transforms/src/index.ts`) registers six
implementations of `@qspecs/core`'s `Transform` interface — `filter`, `derive`, `sort`, `limit`,
`select`, `rename`. SPEC.md §99's v1 list names five of these (`filter`, `sort`, `limit`, `select`,
`rename`) and explicitly permits the sixth, `derive`, as a later addition: "Derived expressions may
be implemented in v1.1 if necessary." SPEC.md §16, by contrast, also names `aggregate` —
deliberately absent here. `docs/architecture.md` records why: "grouping semantics deserve their own
design pass" ([§7](architecture.md#7-the-transform-pipeline-and-the-transformdescribe-contract));
this repository does not implement it.

Each transform is documented below with its spec shape, what `execute` does, and what `describe`
projects. [`examples/`](../examples/) has one manifest per transform
([`examples/README.md`](../examples/README.md)) — read those for a working end-to-end shape rather
than a hand-typed fragment here.

### `filter`

```ts
interface FilterSpec {
  readonly where: unknown; // an expression, or the comparison shorthand
}
```

`filter.execute` compiles `where` into the expression AST (once per execution, not once per row)
and keeps every row for which the compiled expression evaluates truthy
(`packages/transforms/src/internal/filter.ts`). `describe()` returns its input fields unchanged —
filtering removes rows, never columns. See [Comparison shorthand](#comparison-shorthand-vs-the-ast-form)
below for the two accepted shapes of `where`, and [`examples/04-transform-filter.qspec.json`](../examples/04-transform-filter.qspec.json)
for the shorthand form in a real manifest.

### `derive`

```ts
interface DeriveSpec {
  readonly field: string; // name of the new field; must not collide with an existing one
  readonly fieldType: FieldType; // required, not inferred — see below
  readonly expression: unknown;
}
```

`derive.execute` compiles `expression` once, then for every row appends a new cell computed from
it, and appends a matching `Field` — `{ name: field, type: fieldType, nullable: true }` — to
`dataset.fields` (`packages/transforms/src/internal/derive.ts`). The derived field is **always**
declared `nullable: true`, regardless of what `fieldType` names: any expression can evaluate to
`null` (arithmetic on a missing operand is one way — see [the expression AST](#the-expression-ast)
below), so declaring it non-nullable would be a promise this transform cannot keep. `fieldType` is
required and never inferred from the expression, because an expression can return a string, a
number, a boolean, or `null` depending on its actual inputs at runtime — guessing would hand core's
dataset-shaped validators a schema claim `derive` cannot honor. `describe()` appends the same
`Field` computed the same way, so `execute()`'s actual output and `prepare()`'s static projection
cannot drift apart (`derivedField()` is the one function both call). See
[`examples/07-transform-derive.qspec.json`](../examples/07-transform-derive.qspec.json).

**A note on SPEC.md §43.** SPEC.md §43 ("Derived Fields") sketches derivation as a property of a
field _declaration_ — a `"derive": { operator, arguments }` key sitting inside
`spec.dataset.fields.profit`, alongside `type`. That is not what shipped: `derive` here is a
pipeline transform with its own `type: "derive"` entry in `spec.transforms`, the same shape every
other transform uses. This is a resolved, deliberate divergence, not drift — recorded in the
implementation plan ([`docs/superpowers/plans/2026-08-09-qspec-data-presentation.md`](superpowers/plans/2026-08-09-qspec-data-presentation.md),
decision 2): SPEC.md §99 lists `derive` as optional v1.1 scope, but once `filter` has expression
evaluation wired up, a transform-shaped `derive` is "that same machinery plus one field," so it
shipped alongside the rest rather than being withheld. SPEC.md §43's field-level shape is not
implemented anywhere in this repository.

### `sort`

```ts
interface SortSpec {
  readonly field: string;
  readonly direction?: "asc" | "desc"; // default "asc"
}
```

`sort.execute` reorders rows by one field (`packages/transforms/src/internal/sort.ts`). Two rules
worth knowing before relying on the output order:

- **Nulls sort last, in both directions.** `isNullish` (`null` or `undefined`) rows are pushed to
  the end regardless of `direction`, because a null is absent data, not an extreme value —
  reversing them under `desc` would put "no data" first, ahead of every real value. Two null rows
  keep their original relative order.
- **The sort is a stable, indexed decorate-sort-undecorate.** Every row is paired with its original
  index before sorting; when two values compare equal (or are of different, incomparable types —
  `compare()` returns `undefined` for e.g. a `string` against a `number`), the tiebreak is that
  original index, not sort-implementation-defined behavior. This mirrors the expression evaluator's
  own comparison rules (`compare()` here matches `evaluateExpression`'s `compare()`) specifically so
  `sort` and `filter`'s `gt`/`lt`/etc. cannot disagree about what "greater than" means for the same
  two values.

`describe()` returns its input fields unchanged — sorting reorders rows, never columns. See
[`examples/08-transform-sort.qspec.json`](../examples/08-transform-sort.qspec.json).

### `limit`

```ts
interface LimitSpec {
  readonly count: number; // non-negative integer
  readonly offset?: number; // non-negative integer, default 0
}
```

`limit.execute` is `dataset.rows.slice(offset, offset + count)`
(`packages/transforms/src/internal/limit.ts`) — a plain slice offset, not a cursor: there is no
notion of "resume from where the last page left off" independent of the caller supplying the same
`offset` again. `describe()` returns its input fields unchanged. See
[`examples/09-transform-limit.qspec.json`](../examples/09-transform-limit.qspec.json), which uses
both `count` and `offset` together to take a second page rather than a bare top-N slice.

### `select`

```ts
interface SelectSpec {
  readonly fields: readonly string[];
}
```

`select.execute` projects the dataset down to exactly the named fields, **in the order `fields`
lists them** — not the order they appeared in the incoming dataset
(`packages/transforms/src/internal/select.ts`'s own comment: "Spec order wins: `select` is a
projection, and the caller listed the columns in the order they want them"). A name in `fields`
that does not exist in the incoming dataset is silently dropped from the output rather than erroring
at `execute()` time, though `validate()` catches an unknown field name statically whenever a schema
projection is available (see [`describe()`](#describe-and-what-schema-opacity-costs-a-manifest-author) below).
`describe()` performs the identical lookup-and-filter against the _projected_ input fields, so the
static schema and the runtime output agree on both membership and order. See
[`examples/05-transform-select.qspec.json`](../examples/05-transform-select.qspec.json), which
drops an internal-only column before it reaches a chart.

### `rename`

```ts
interface RenameSpec {
  readonly fields: Readonly<Record<string, string>>; // { oldName: newName }; unlisted fields untouched
}
```

`rename.execute` renames the listed fields and leaves every other field's name (and every field's
position) alone — "a rename is not a reorder" (`packages/transforms/src/internal/rename.ts`'s own
comment). Two behaviors worth knowing:

- **Collision detection runs twice, for different reasons.** `validate()` catches a collision
  whenever a schema projection is available — renaming `a` to `b` when `b` already exists in the
  known field set. But `validate()` only ever sees a schema when every _earlier_ transform in the
  pipeline declared `describe()`; if one didn't, `validate()` is handed `fields: undefined` and
  cannot know the collision is coming. `execute()` therefore re-checks (`assertDistinct`) against
  the dataset it actually has, every time, and throws a plain `Error` (not a `QSpecError`) so core's
  transform-execution boundary wraps it as a `TransformError` naming the transform and its pipeline
  index — a `QSpecError` thrown directly here would pass through with a path this file invents
  instead of that location.
- **Bracket access on the rename map is deliberately avoided.** Both `renamed()` (used by
  `execute` and `describe`) and `execute`'s row-copy loop use `Object.hasOwn(mapping, field.name)`
  rather than `mapping[field.name] ?? name`, because a field legitimately named `constructor` (or
  `toString`, `__proto__`, …) would otherwise read a function off `Object.prototype` through bare
  bracket access and treat an unrenamed field as if it had been renamed to that function. This is
  the same prototype-safety discipline [Datasets](datasets.md#positional-rawqueryresult-versus-row-objects)
  describes for `normalizeResult` (SPEC.md §72.4), applied again here because `rename` is a second
  place a column name crosses from data into a property lookup.

`describe()` calls the same `renamed()` helper `execute()` uses, so — as
[`docs/architecture.md`'s worked example](architecture.md#7-the-transform-pipeline-and-the-transformdescribe-contract)
shows in full — a presentation charting the _post-rename_ field name passes `prepare()`, and one
charting the pre-rename name fails statically with "Unknown dataset field," before any query runs.
See [`examples/06-transform-rename.qspec.json`](../examples/06-transform-rename.qspec.json).

## The expression AST

`filter`'s `where` and `derive`'s `expression` are not free-form JavaScript, or even a
JavaScript-like DSL — they are QSpec's expression AST (SPEC.md §42), exported from `@qspecs/core`
as `Expression` and compiled by `normalizeExpression`:

```ts
export type Expression =
  | { readonly field: string }
  | { readonly literal: JsonValue }
  | { readonly parameter: string }
  | { readonly operator: string; readonly arguments: readonly Expression[] };
```

`{ field }` reads a cell from the current row; `{ literal }` is a constant JSON value; `{ parameter
}` reads a resolved parameter value (see [Parameters](parameters.md)); `{ operator, arguments }` is
everything else. `evaluateExpression` interprets this tree directly — no `eval`, no `new
Function` (SPEC.md §72.3, enforced mechanically: `test/boundaries.test.ts` greps every published
source file for both and fails the build if either appears outside a test file).

`{ parameter }`'s `string` is the bare parameter name (`"from"`, not `"$parameters.from"`) — the
`$parameters.` prefix is [`spec.query`](queries.md)'s binding syntax, for substituting a value into
a query statement string, and is not part of the expression AST at all. A `{ parameter:
"$parameters.from" }` node looks for a parameter literally named `$parameters.from`, which no
manifest declares, not for the `from` parameter.

### Comparison shorthand vs. the AST form

Any expression, wherever it appears, additionally accepts a flatter shorthand SPEC.md §40 also
shows: `{ field, operator, value }` with no `arguments` key. `normalizeExpression`
(`packages/core/src/internal/expression/normalize.ts`) expands this at `prepare()` time into the
equivalent `{ operator, arguments: [{ field }, { literal: value }] }` AST form — both shapes are
valid input, and the canonical form used in anticipation of hashing/signing (SPEC.md §83, §111 —
both of which defer canonicalization itself to future work, so this is not yet a settled,
in-production use case) is always the expanded AST. The shorthand detection is purely structural
(an object with a string `operator`, no `arguments` key, a string `field`, and a `value` key), so
it is not specific to `filter` — `derive`'s `expression` is compiled through the exact same
`normalizeExpression` call and would accept it too. The shorthand always expands to exactly two
arguments (`{ field }, { literal: value }`), so — since arity checking still applies to the
expanded form — it only works with an operator whose arity _range_ includes exactly two arguments.
That excludes only `not` and `isNull`, both fixed at exactly one argument. The variadic operators
(`and`, `or`, `coalesce` — each `{ minArity: 1, maxArity: VARIADIC }`) technically accept it too,
since `1 ≤ 2 ≤ ∞`, though a two-argument `and`/`or`/`coalesce` built from the shorthand's `{
field }, { literal }` pair is rarely what an author actually wants.
[`examples/04-transform-filter.qspec.json`](../examples/04-transform-filter.qspec.json) uses the
shorthand for a comparison; [`examples/07-transform-derive.qspec.json`](../examples/07-transform-derive.qspec.json)
uses the full `{ operator, arguments }` form instead, referencing two fields (`quantity` and
`unit_price`) rather than one field and a literal, which the shorthand's `{ field, value }` shape
cannot express.

### A fixed, non-extensible operator set

`OPERATORS` (`packages/core/src/internal/expression/normalize.ts`) is the complete set an
expression can name — sixteen operators across six groups:

```text
Comparison:  eq  ne  gt  gte  lt  lte
Logical:     and  or  not
Membership:  in
Null:        isNull
Arithmetic:  add  subtract  multiply  divide
Other:       coalesce
```

This set is **fixed in `@qspecs/core` and deliberately not registry-extensible** — there is no
`api.operators.register(...)`, unlike every other QSpec capability (query languages, sources,
transforms, presentation types, semantic types, resources, renderers are all registries). The
design document states the reasoning directly
([§2.2](superpowers/specs/2026-08-09-qspec-design.md#22-expression-ast-specmd-42)): SPEC.md §42
requires the expression language to "remain intentionally limited" and to never "become JavaScript
represented as JSON," and a plugin-registered operator table is exactly the mechanism by which that
would stop being true. It would also make an expression's _meaning_ depend on which plugins happen
to be installed — the same manifest evaluating differently in two hosts, which breaks both the
determinism requirement (SPEC.md §8) and the portability requirement (SPEC.md §5) an expression
tree is supposed to guarantee. Domain-specific logic that doesn't fit these sixteen operators
belongs at the transform layer instead, where SPEC.md already provides a registry — write a new
transform, not a new operator.

Each operator has a fixed arity `normalizeExpression` enforces before an expression ever reaches
the evaluator: most are exactly 2 arguments (`eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, arithmetic),
`not` and `isNull` take exactly 1, and `and`, `or`, `coalesce` are variadic (at least 1). An unknown
operator name fails `prepare()` with a "did you mean" suggestion computed against the fixed set
(the same Levenshtein `suggest()` used throughout core's validators); a wrong argument count fails
with the expected count named explicitly.

### Null and comparison semantics

`null`/`undefined` propagate through arithmetic (`add`/`subtract`/`multiply`/`divide` on a missing
operand yields `null`, not `NaN` or a thrown error — `NaN`/`Infinity` do not survive JSON, per
`evaluateExpression`'s own comment on `divide`-by-zero); a comparison (`gt`/`gte`/`lt`/`lte`)
involving a `null` operand evaluates to `false`, never `true`; and `isNull` is the only operator
that tests for nullness directly. `eq`/`ne` are the one pair with a documented special case: two
`null`/`undefined` operands are considered equal to each other (`eq` → `true`, `ne` → `false`),
matching SQL's `IS NULL`-style expectation rather than JavaScript's own `null == undefined` quirk
carried further than intended. This is, in the design document's words, "SQL-like three-valued
logic collapsed to two values at the boundary, chosen because it matches what users writing
analytics filters expect"
([§2.2](superpowers/specs/2026-08-09-qspec-design.md#22-expression-ast-specmd-42)).

### `maxExpressionDepth`

Expression nesting is capped by `limits.maxExpressionDepth` (SPEC.md §72.5), part of the same
`QSpecLimits` that bounds row counts, transform counts, and manifest size —
[`docs/architecture.md`](architecture.md#4-resolved-design-decisions) lists the full set. The
default is 32 (`DEFAULT_LIMITS.maxExpressionDepth`, `packages/core/src/types/runtime.ts`). Because
the limit is runtime configuration rather than a constant, it cannot be read from a module-scope
global — `createFilterTransform` and `createDeriveTransform` are both **factory functions**, not
plain transform objects, taking `maxExpressionDepth` as a parameter that `@qspecs/transforms`'
`transforms()` plugin captures once from `api.limits.maxExpressionDepth` at `setup()` and closes
over. An expression nested deeper than the configured limit fails compilation with a
`LimitExceededError` naming the limit and the depth allowed — but that error never escapes
`prepare()`. Both `filter`'s and `derive`'s `validate()` catch it and downgrade it to a
`QSpecIssue` carrying the same message (`packages/transforms/src/internal/filter.ts`,
`.../derive.ts`), which core folds into the aggregate `ManifestValidationError` `prepare()` throws
for any structural or plugin-capability problem. A caller cannot
`catch (e) { if (e instanceof LimitExceededError) ... }` around `prepare()` for this case — only
around the transform-count check in `packages/core/src/internal/prepare.ts` and the manifest-size
check in `packages/core/src/define.ts` (reached from `prepare()`), both of which throw it directly.

The depth check does run a second time at execution: both transforms call the same `compile()`
inside `execute()`, before touching a row. But there it is _not_ downgraded. The
`LimitExceededError` propagates raw, and core's transform loop re-throws `QSpecError` subclasses
unwrapped rather than wrapping them in a `TransformError`
(`packages/core/src/internal/execute.ts`). So a transform invoked without `validate()` having run
first — calling the transform object directly, for instance — fails with a `LimitExceededError`,
not with an issue list. The downgrade is a property of `validate()`, not of the transform.

## `describe()` and what schema-opacity costs a manifest author

`Transform` has one required member and two optional ones:

```ts
interface Transform<TSpec = unknown> {
  execute(dataset: Dataset, spec: TSpec, context: TransformContext): Promise<Dataset> | Dataset;
  describe?(fields: readonly Field[], spec: TSpec): readonly Field[];
  validate?(spec: TSpec, fields: readonly Field[] | undefined): void | readonly QSpecIssue[];
}
```

(`packages/core/src/types/plugin.ts`.) `execute` is the only member that ever touches real data. `describe` is a separate, purely static
method: given the `Field[]` entering the transform, it returns the `Field[]` leaving it — no
dataset, no rows, nothing that requires a query to have run. `prepare()` folds `describe` across
the declared `spec.transforms` pipeline, starting from `spec.dataset.fields`, to compute the schema
the pipeline will eventually produce, _before_ `execute()` issues any query. Stage 6 (presentation)
then validates every `field` reference inside `spec.presentation` against that projected schema —
including "did you mean" suggestions — entirely statically. All six built-in transforms implement
`describe`, precisely so this guarantee survives real pipelines; see the worked
rename-then-chart example in
[`docs/architecture.md` §7](architecture.md#7-the-transform-pipeline-and-the-transformdescribe-contract),
which this document does not repeat.

**What omitting `describe` actually costs.** The moment `prepare()`'s fold reaches a transform with
no `describe`, it can no longer know what fields exist after that point — so it stops projecting
entirely. This is not "worse suggestions" or "a slightly weaker check": every transform _later_ in
the pipeline, and the presentation stage itself, loses static field-reference validation for that
manifest, for the rest of its life — and there is no runtime fallback that catches what static
validation skipped. `validatePresentation` (`packages/core/src/internal/validate/presentation.ts`)
returns early, without checking a single field reference, whenever `projectedFields` is
`undefined`; `execute()` (`packages/core/src/internal/execute.ts`) never calls it or anything like
it after a query runs. So the manifest still _runs_ — a chart referencing a field that was silently
renamed away, or one that never existed, is not caught by `qspec validate`, not caught by
`prepare()`, and not caught by `execute()` either. It surfaces only however the renderer downstream
happens to handle a missing field (`undefined`, a blank series, a thrown error inside chart code —
whichever that renderer does with an absent property), which is a worse outcome than a clean
validation failure would have been. SPEC.md §81's promise that static validation "prevents
unnecessary database queries" for a manifest that can never render stops holding for anything
downstream of the opaque transform, and nothing replaces the check it removes. A manifest author
writing a custom, third-party transform (this is the one place in the pipeline a manifest depends
on code outside `@qspecs/transforms`) who skips `describe` for expedience is trading away every
downstream static check silently, with no later stage that catches the mistake — nothing about the
manifest looks wrong until whatever renders it does something visibly wrong with a field that was
never there.

When a manifest declares no `spec.dataset` at all, there is no schema to project from in the first
place regardless of what any transform implements, so `projectedFields` is `undefined` for the same
reason and the same gap applies: presentation field references are never checked, by any stage, for
that manifest — not by `qspec validate`, not by `prepare()`, and not by `execute()` after the query
runs. This is not the opaque-transform case, it is the absence of a starting schema, but the
consequence is identical.

## `validate()` and the schema it may or may not have

`validate` is the third optional member, called during `prepare()` to check a transform's `spec`
statically — separately from whether `execute` would actually succeed. Every built-in transform's
`validate` follows the same shape: check the spec's own structure first (unrelated to any schema),
then, **only if a projected `fields` array is available**, check that every field name the spec
references actually exists in it. This is why `fields` is typed `readonly Field[] | undefined`
rather than always present — `validate` is called for every transform regardless of whether an
earlier transform in the _same_ pipeline left the schema opaque, and it degrades to "check what I
can" rather than throwing or skipping when the schema isn't there. `filter` and `derive` additionally
compile their expression during `validate`, so a malformed expression (bad operator, wrong arity,
depth exceeded) is reported with the expression's own precise path rather than a generic message.

## See also

- [`docs/datasets.md`](datasets.md) — the `Dataset` shape a transform pipeline consumes and
  produces, and normalization before any transform runs.
- [`docs/presentations.md`](presentations.md) — Stage 6 presentation validation, which is the
  direct consumer of `describe()`'s projected schema.
- [`docs/architecture.md`](architecture.md#7-the-transform-pipeline-and-the-transformdescribe-contract) —
  the `prepare()`/`execute()` split, the six validation stages, and the full rename-then-chart
  worked example this document only summarizes.
- [`docs/manifest-specification.md`](manifest-specification.md) — why `qspec validate` (with no
  `--config`) cannot catch a malformed `filter.where` or an unknown transform operator, and what
  plugin-aware validation adds.
- [`examples/README.md`](../examples/README.md) — one CI-validated manifest per transform.
