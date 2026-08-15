# Presentations

`spec.presentation` describes _how_ a dataset should be shown — semantic intent, not a pixel of
rendered output (SPEC.md §44: "Presentation must describe semantic intent rather than a specific
rendering library"; "QSpec must not expose Recharts internals in the standard specification").
`@qspecs/charts` (SPEC.md §17) is the package that gives that intent concrete shape: it registers
five presentation types and the `Chart` resource kind, and it renders nothing at all — SPEC.md §17
states plainly "This package must NOT render charts. It only defines chart semantics." This
document covers the chart model `@qspecs/charts` defines, `resolveSeries`, the split between
cartesian types and `pie`, grouped series and `UNGROUPED_LABEL`, and `SeriesPoint.index`.

What validates a `field` reference inside `spec.presentation` against the dataset schema a
transform pipeline actually produces — Stage 6, `Transform.describe()`'s entire reason for existing
— is covered in [Transforms](transforms.md#describe-and-what-schema-opacity-costs-a-manifest-author)
and, in full, in [`docs/architecture.md` §7](architecture.md#7-the-transform-pipeline-and-the-transformdescribe-contract).
This document assumes that projection already happened and covers what a presentation _means_ once
its field references are known to be valid.

## The chart model

`@qspecs/core` knows almost nothing about presentation shape on purpose — only a `type`
discriminator and an implicit index signature for vendor extension keys
(`packages/core/src/types/presentation.ts`):

```ts
export interface PresentationDefinition {
  readonly type: string;
  readonly [key: string]: unknown;
}
```

Concrete shapes live in packages like `@qspecs/charts`. `@qspecs/charts` registers five presentation
types under `api.presentations` — `line`, `bar`, `area`, `scatter`, `pie` — and one resource kind,
`Chart`, with `requiresQuery: true` and `requiresPresentation: true`: a `Chart` with no data source
or no presentation has nothing to render, so `prepare()` rejects it up front rather than producing
an empty result later (`packages/charts/src/index.ts`; see also
[`docs/manifest-specification.md`'s `kind` section](manifest-specification.md#kind)).

Every presentation type plugs into core's registry-generic `PresentationType<TDefinition>`
interface (`packages/core/src/types/presentation.ts`):

```ts
export interface PresentationType<TDefinition = PresentationDefinition> {
  validate?(
    definition: TDefinition,
    context: PresentationValidationContext,
  ): void | readonly QSpecIssue[];
  fieldReferences?(definition: TDefinition): readonly FieldReference[];
}
```

`validate` checks the presentation's own shape (a required `x.field`, a non-empty `series`, and so
on). `fieldReferences` is what feeds Stage 6: it returns every dataset field name a definition
mentions, each tagged with its own path, and core's `validatePresentation`
(`packages/core/src/internal/validate/presentation.ts`) checks each one against the projected
schema, attaching a Levenshtein "did you mean" suggestion (`suggest()`) when a name is close to a
real field but not exact. Both methods are optional — but `@qspecs/charts`'s own two `PresentationType`
objects implement both, for the same reason the built-in transforms all implement `describe`: a
presentation type that skips `fieldReferences` gives up static validation of its own field
references, silently.

Note what `@qspecs/charts`'s validators do **not** check: `PresentationValidationContext` carries
`fields: readonly Field[] | undefined`, but neither `cartesianPresentationType.validate` nor
`piePresentationType.validate` reads it (both take it as an ignored `_context` parameter). Field
_names_ are still checked, by core's `fieldReferences`-driven pass described above — a `series`
entry naming a field that doesn't exist is still caught. Field _types_ are not: a `pie` whose
`value` points at a `string` column, or a `scatter` plotting a `boolean`, both pass `prepare()`
clean today. `docs/known-gaps.md` records this as deliberately left open until a renderer exists to
say which types it can actually accept — deciding now, with nothing consuming the answer, would be
a guess encoded as validation.

## Cartesian (`line`, `bar`, `area`, `scatter`) versus `pie`

`line`, `bar`, `area`, and `scatter` are registered under four distinct names — renderers treat
them differently — but they share one `PresentationType` implementation, `cartesianPresentationType`
(`packages/charts/src/internal/cartesian.ts`), because their _shape_ is identical: an x axis plus
one or more series.

```ts
export type CartesianPresentation = PresentationDefinition & {
  readonly type: "line" | "bar" | "area" | "scatter";
  readonly x: AxisSpec;
  readonly series: readonly SeriesSpec[] | GroupedSeriesSpec;
  readonly y?: { readonly label?: string };
  readonly legend?: LegendSpec;
  readonly tooltip?: TooltipSpec;
};
```

`pie` is structurally different enough that it gets its own type, `piePresentationType`
(`packages/charts/src/internal/pie.ts`) — **`pie` has no `x` axis and no series list at all**:

```ts
export type PiePresentation = PresentationDefinition & {
  readonly type: "pie";
  readonly category: AxisSpec; // the slice label
  readonly value: SeriesSpec; // the slice size
  readonly legend?: LegendSpec;
  readonly tooltip?: TooltipSpec;
};
```

One `category` field (the slice label) and one `value` field (the slice size) describe the whole
chart — there is no `y` because a pie chart has no y axis to have one, and no `groupBy` pivoting
because a pie chart has only ever one series' worth of slices. `docs/known-gaps.md` notes there is
also, as of this writing, no `resolvePie` equivalent to `resolveSeries` — every pie-consuming
renderer currently has to re-derive its own slice ordering and its own answer for a null category,
which is exactly the kind of divergence `resolveSeries` exists to prevent for the cartesian types.

[`examples/10-chart-grouped-series.qspec.json`](../examples/10-chart-grouped-series.qspec.json) is
a `line` chart; [`examples/11-chart-pie.qspec.json`](../examples/11-chart-pie.qspec.json) is a
`pie` chart — read them side by side to see the shape difference directly rather than in the
abstract. Both `legend` and `tooltip` are optional, and share one shape across all five types
(`LegendSpec`/`TooltipSpec`, validated by `validateDisplayBlock`): just `{ visible?: boolean }` —
nothing about legend position, formatting, or tooltip content is representable today.
`docs/known-gaps.md` records the related, larger gap this sits inside: SPEC.md §100 also lists
`formatting` as chart v1 support, and neither cartesian nor pie presentations declare any
representation for it at all — it is the one item on that list with no shape anywhere in this
repository, not merely an unvalidated one.

## `resolveSeries` and static series resolution

SPEC.md §47 ("Dynamic Series") says a chart's series "should" be derivable from a grouping field,
and leaves _where_ that derivation happens as an implementation choice. The choice made here:
pivoting stays renderer-side (SPEC.md §47's own suggestion), but `@qspecs/charts` exports one shared
resolver every renderer is expected to use rather than re-implementing:

```ts
function resolveSeries(
  dataset: Dataset,
  presentation: CartesianPresentation,
): readonly ResolvedSeries[];

interface ResolvedSeries {
  readonly key: string; // field name for explicit series, group value for grouped ones
  readonly label: string; // falls back to `key` when no label was declared
  readonly field: string; // the dataset field the y values came from
  readonly points: readonly SeriesPoint[];
}
```

`resolveSeries` (`packages/charts/src/internal/resolve-series.ts`) is only ever called with a
`CartesianPresentation` — `pie` has no series to resolve. It handles both shapes `series` can
take:

- **An explicit array of `{ field, label? }`.** Each entry becomes exactly one `ResolvedSeries`,
  `key`ed by its own `field` name, with one point per dataset row: `{ x: row[x.field], y:
row[spec.field], index }`.
- **A single `{ field, groupBy, label? }`** — see [Grouped series](#grouped-series-and-ungrouped_label)
  below.

**Why this lives in `@qspecs/charts` rather than in each renderer.** If dynamic-series pivoting were
renderer-side with no shared resolver, a Recharts adapter, an ECharts adapter, and a plain
CLI/terminal renderer could each legitimately produce a different series ordering, or a different
answer for "what happens when the grouping field is null," for the exact same manifest — three
different-looking charts from one QSpec document, which contradicts the portability guarantee
(SPEC.md §5) that a QSpec manifest is supposed to mean one thing regardless of what eventually
renders it. Putting the decision in one place, still without rendering a single pixel — SPEC.md §17
forbids that, and `resolveSeries` does not violate it — means every future renderer package shares
the same answer instead of re-deciding it. See
[`docs/architecture.md` §8](architecture.md#8-resolveseries-and-static-series-resolution) for the
full account.

**Ownership of the returned data.** The returned array, each `ResolvedSeries`, each `points`
array, and each `SeriesPoint` are all freshly allocated on every call, so a caller may reorder,
splice, or reassign them freely without touching the dataset or a different call's result. Point
_values_ are not cloned, though — `x` and `y` reference the row's cell directly, so mutating the
internals of an object- or array-valued cell reached through a point does reach back into the
dataset. This is a deliberate cost/safety tradeoff documented in the function's own comment:
cloning every cell would be a real cost on large results, for a hazard that only exists for
composite (`object`/`array`-typed) cells.

## Grouped series and `UNGROUPED_LABEL`

The `{ field, groupBy, label? }` form partitions dataset rows by the distinct values of `groupBy`,
at call time, into one `ResolvedSeries` per distinct value — this is what SPEC.md §47 means by
"the renderer should derive series" from a grouping field, and what
[`examples/10-chart-grouped-series.qspec.json`](../examples/10-chart-grouped-series.qspec.json)'s
one-line-per-`region` chart does.

```ts
export const UNGROUPED_LABEL = "(none)";
```

A few resolution rules worth knowing, all pinned by tests in
`packages/charts/src/internal/resolve-series.test.ts`:

- **Group order is first-appearance order in the dataset**, not sorted, and not the order values
  happen to be inserted into any intermediate structure. `resolveSeries` groups rows with a
  `Map<string, SeriesPoint[]>`, and a `Map`'s insertion order is exactly the dataset's own row
  order the first time each group value is seen — sorting would be a second, invisible policy
  decision `resolveSeries` deliberately does not make.
- **A `null`/`undefined` group value and a genuinely-empty-string group value merge into one
  series**, keyed `""` and labelled `UNGROUPED_LABEL` (`"(none)"`). This is deliberate, not an
  oversight: a distinct sentinel for "missing" would itself have to be a string key, and every
  string candidate is either visually ugly or just as collidable with a real group value as `""`
  is — there is no string key space wide enough to rule collisions out entirely
  (`docs/known-gaps.md` records the same reasoning, and the route out if the two cases ever need
  to be told apart: a non-string key such as a `Symbol`, at the cost of widening
  `ResolvedSeries.key` off `string`).
- **A declared `label` on a grouped spec becomes a prefix, not a replacement.** `{ field: "revenue",
groupBy: "region", label: "Revenue" }` produces series labelled `"Revenue: West"`, `"Revenue:
East"`, and so on — `${label}: ${groupLabel}` — rather than discarding the group value or
  discarding the declared label. A bare group value alone ("West", "East") is often ambiguous in a
  legend on its own; an author who bothered to declare a label is signalling they want it visible,
  and silently dropping it would discard information they explicitly provided.

Every point still carries its originating row's `index` (see below), so which rows landed in which
group remains recoverable even after grouping has partitioned them into separate arrays.

## `SeriesPoint.index` and why it exists

```ts
export interface SeriesPoint {
  readonly x: unknown;
  readonly y: unknown;
  /** The source dataset row's index (`dataset.rows[index]`). */
  readonly index: number;
}
```

Every `SeriesPoint` `resolveSeries` produces — for an explicit series or a grouped one — carries
the index of the dataset row it came from. This field is not used by `resolveSeries` itself; it
exists entirely for a downstream renderer, and the problem it solves only shows up once grouping
enters the picture.

**The problem.** A renderer that pivots several series into one shared, wide-row table — one row
per distinct x value, one column per series, which is what Recharts' `<Line>`/`<Bar>`/`<Area>`
each need (see [`docs/architecture.md` §10.4](architecture.md#104-why-linebararea-pivot-into-a-wide-row-table-while-scatter-does-not)
for the full renderer-side mechanics) — needs to know what order those pivoted rows belong in on
the shared x axis. `resolveSeries` guarantees each _individual_ series' own points stay in dataset
order (a grouped series' points are appended to its group's array in the order rows were visited).
What it does not, and structurally cannot, guarantee is the **interleaving** of one series against
another, once grouping has partitioned dataset rows into separate per-group arrays. Two series
covering different, overlapping-but-not-identical sets of x values is the documented, deliberate
contract of grouped series (`docs/known-gaps.md`'s "Grouped series produce sparse, non-aligned x
sets") — nothing says series A and series B visit x values in the same order, or share all of them.

**Why per-group order can't answer this.** Concretely: dataset rows `Jan/West, Feb/East, Mar/West`
(a `month` column and a `region` column, grouped by `region`) produce two series — `West` with
points `[Jan, Mar]`, `East` with points `[Feb]` — each internally in dataset order. A renderer that
pivots by iterating series in turn and taking first-seen order across all of them would see `West`
before `East`, and so encounter `Jan`, then `Mar`, then `Feb` — producing a category axis ordered
`Jan, Mar, Feb`. That is silently wrong (`Feb` belongs between `Jan` and `Mar`), and nothing about
the output signals a mistake happened; it looks like a legitimately-ordered chart. Per-group order
alone genuinely cannot supply the answer here, because the information that would fix it — which
row of the _original dataset_ each point came from — is exactly what gets lost the moment grouping
partitions rows into separate per-group arrays.

**What `SeriesPoint.index` recovers.** Because every point is stamped with its originating dataset
row's index regardless of which group it ended up in, a renderer merging points from multiple
series back into shared rows can sort those merged rows by the _lowest_ `index` contributing to
each one, recovering the dataset's own global row order regardless of how `resolveSeries`
partitioned rows into series. `@qspecs/recharts`'s `buildWideRows`
(`packages/recharts/src/internal/cartesian.tsx`) is exactly this renderer — it is the concrete
consumer this field was added for, and
[`docs/architecture.md` §10.4](architecture.md#104-why-linebararea-pivot-into-a-wide-row-table-while-scatter-does-not)
covers its `minIndex`-sort mechanics in full. `<Scatter>`, by contrast, takes each series' own
independent point cloud directly with no shared-row pivot at all, so it has no use for `index` and
`@qspecs/recharts` never reads it there.

**Why this is a `@qspecs/charts` concern and not a renderer-only one.** `index` is added in this
package, not computed after the fact by `@qspecs/recharts`, for the same reason `resolveSeries`
itself lives here rather than per-renderer: a renderer reconstructing "which dataset row did this
point come from" independently — say, by re-scanning the dataset for a matching `x` value — would
have to invent its own answer for what happens when two rows share an `x` value, or when `x` values
repeat across groups, exactly the kind of per-renderer disagreement `resolveSeries` exists to
prevent. Stamping `index` once, at the point where `resolveSeries` still has direct access to each
row's real position, means every renderer inherits the same, unambiguous answer instead of
re-deriving one.

## See also

- [`docs/transforms.md`](transforms.md#describe-and-what-schema-opacity-costs-a-manifest-author) —
  the `describe()` contract that produces the schema Stage 6 presentation validation checks a
  `field` reference against.
- [`docs/datasets.md`](datasets.md) — the `Dataset`/`Field` shapes `resolveSeries` and every
  presentation type's `fieldReferences` operate on.
- [`docs/architecture.md` §8](architecture.md#8-resolveseries-and-static-series-resolution) and
  [§10.4](architecture.md#104-why-linebararea-pivot-into-a-wide-row-table-while-scatter-does-not) —
  the full design reasoning behind `resolveSeries` and the Recharts-side wide-row pivot that
  consumes `SeriesPoint.index`.
- [`docs/known-gaps.md`](known-gaps.md) — `formatting`'s missing representation, the absent
  field-type checking in both presentation validators, the absent `resolvePie`, and the documented
  sparse/non-aligned-x contract of grouped series.
- [`examples/README.md`](../examples/README.md) — the grouped-`line` and `pie` example manifests,
  and every other example.
