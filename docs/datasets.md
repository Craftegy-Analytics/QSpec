# Datasets

A `Dataset` is what query execution produces: a normalized, JSON-safe shape every downstream
transform and presentation depends on, regardless of which data source or query language produced
it (SPEC.md §36).

```ts
interface Dataset {
  readonly fields: readonly Field[];
  readonly rows: readonly DatasetRow[];
  readonly metadata?: DatasetMetadata;
}
```

This document covers field types, semantic types, why a data source hands back positional rows
rather than row objects, and the `Date`-to-ISO normalization `normalizeResult`
(`packages/core/src/internal/normalize-result.ts`) performs on the way from a source's raw result
to a `Dataset`. The declarative `spec.dataset.fields` schema shape itself is covered in
[`docs/manifest-specification.md`](manifest-specification.md); this document is about what a
_materialized_ dataset looks like and how it gets that way.

## Field types

`FieldType` (`packages/core/src/types/dataset.ts`) is SPEC.md §38's list, exported as a runtime
value (`FIELD_TYPES`) so plugins constructing a `Field` — `@qspecs/transforms`' `derive` is the
first — validate against the same authoritative set core's own manifest validator uses, rather
than each maintaining its own copy that could drift:

```text
string
number
integer
boolean
date
datetime
object
array
```

Note this is a **different list than `ParameterType`** (see [Parameters](parameters.md#declared-types)):
a dataset field can never be declared `enum`, and can be `object`, which no parameter can. A
declared field (`FieldDefinition`) carries `type`, an optional `nullable`, an optional `label`,
an optional `semanticType`, and an optional `format` (a free-form `JsonObject`) — a materialized
`Field` is the same shape plus its own `name`, since field order is significant and a row is keyed
by name.

## Semantic types

`semanticType` annotates _meaning_ without ever changing the underlying storage type (SPEC.md
§39) — `type: "number", semanticType: "currency"` is still, structurally, a `number`; nothing
about validation, coercion, or the dataset schema treats a `currency`-tagged number differently
from an untagged one. SPEC.md §39 lists candidate values (`currency`, `percentage`, `duration`,
`bytes`, `timestamp`, `country`, `latitude`, `longitude`, `url`), and
`packages/core/src/types/plugin.ts`'s `SemanticType` interface (`baseTypes`, `description`) and
`QSpecPluginAPI.semanticTypes` registry exist for a plugin to formalize one — but as of this
writing, **no package in this repository registers any semantic type**. `semanticType` today is
purely a string a manifest author writes and a presentation or renderer may choose to read (as
`@qspecs/charts`' currency-formatted revenue field in
[`examples/01-complete-manifest.qspec.json`](../examples/01-complete-manifest.qspec.json) does,
via `format: { currency: "USD" }`), not something the runtime validates against a registered
catalog.

## Positional `RawQueryResult` versus row objects

A data source (see [Data Sources](data-sources.md)) never returns rows as objects. It returns
`RawQueryResult` (`packages/core/src/types/dataset.ts`):

```ts
interface RawColumn {
  readonly name: string;
  readonly nativeType?: string;
}

interface RawQueryResult {
  readonly columns: readonly RawColumn[];
  readonly rows: readonly (readonly unknown[])[];
  readonly metadata?: { readonly durationMs?: number; readonly truncated?: boolean };
}
```

— a `columns` array of names (with an optional adapter-supplied native type string) and `rows` as
plain arrays, each cell matched to its column **by index**, not by key. `normalizeResult`
converts this into a `Dataset` of named, keyed rows. This positional shape is a deliberate design
decision (design document
[§2.4](superpowers/specs/2026-08-09-qspec-design.md#24-raw-query-results-and-normalization-specmd-36-62),
SPEC.md §36, §62), made because a row-of-objects shape has two problems that a positional shape
simply does not have, plus one it forecloses on purpose:

1. **Duplicate column names survive.** `SELECT a.id, b.id FROM ...` is a legitimate query that
   returns two columns both named `id`. A JavaScript object can only hold one `id` key — the
   second silently overwrites the first. Positional rows lose nothing: `normalizeResult` keeps
   the first occurrence under its bare name and renames each subsequent collision to `id_2`,
   `id_3`, and so on, checking each candidate against both already-used names and the _original_
   column list so a generated name can never itself collide with a real column further along.
   Every rename is reported, not silent: `execute()` emits a `dataset:normalize:duplicate-column`
   lifecycle event for each one (`{ original, renamed }`), so a caller can observe that it
   happened.
2. **A column literally named `constructor` (or `__proto__`, `toString`, …) is representable.**
   `normalizeResult`'s field-lookup uses `Object.hasOwn(declared, name)` rather than `declared[name]`
   specifically because a plain property read on an object named after a column would silently
   resolve to an `Object.prototype` member instead of `undefined` for an undeclared field — a
   column named `constructor` would spread `Object.prototype.constructor` into a `Field` with no
   `type` and no `nullable`, not fail cleanly (SPEC.md §72.4, the prototype-pollution security
   requirement). A row-of-objects raw shape would face this same hazard on every row, not just
   once at the schema level; the positional shape sidesteps it entirely by never using a column
   name as an object key until normalization deliberately builds `Object.create(null)` rows
   (design §2.4) — a genuinely prototype-free object, where `hasOwnProperty` doesn't even exist
   as an inherited method, so `Object.hasOwn(row, ...)` is the only supported way to check a key.
3. **A columnar/positional shape is a short step from a future columnar backend** (SPEC.md
   §113) — an Arrow-style result, or any backend that is naturally column-oriented rather than
   row-oriented. A row-of-objects raw shape is not.

## `Date` normalization and its nested-value limit

`normalizeValue` (`packages/core/src/internal/normalize-result.ts`) converts every top-level
`Date` cell to an ISO 8601 string, so a `Dataset` survives `JSON.stringify` intact — this is what
lets a `datetime`-typed field round-trip correctly across, for instance, `@qspecs/http`'s HTTP
boundary. The function's own comment states the limit plainly:

> Dates nested inside array or object values are left alone — adapters are expected to hand back
> JSON-shaped values inside composite columns.

A `Date` sitting at the top level of a cell (a `datetime`-typed column's value) is normalized. A
`Date` nested _inside_ an `object`- or `array`-typed cell — a JSON blob column containing
`{ "createdAt": new Date(...) }` — is not touched by this function at all. This is documented,
deliberate behavior, not an oversight discovered later: `docs/known-gaps.md` records the
consequence for the HTTP path specifically — such a value round-trips through `JSON.stringify` as
whatever `JSON.stringify` itself does to a `Date` (an ISO string), but arrives typed as a plain
string (`typeof` `"string"`, `instanceof Date` is `false`), not as anything QSpec's normalization
guaranteed. A data source adapter whose composite (`object`/`array`) columns can contain a native
`Date` value is responsible for converting it itself before returning `RawQueryResult`, if a
string is not what it wants downstream to see.

## Row cap and truncation

`normalizeResult` accepts an optional `maxRows`; `execute()` passes `limits.maxRows` (default
1,000,000 — `DEFAULT_LIMITS` in `packages/core/src/types/runtime.ts`). Rows beyond that count are
dropped, and `dataset.metadata.truncated` is set to `true` — either because the cap was hit here,
or because the raw result itself already reported `metadata.truncated === true` (an adapter that
enforces its own limit, e.g. a `LIMIT`-clause safety net).

## Declared schema versus inferred fields

When `spec.dataset.fields` declares a field that a query result actually returns,
`normalizeResult` uses the **declared** definition wholesale (`{ name, ...definition }`) rather
than inferring one from the row data. When a returned column has no declaration, its `type` is
inferred from the first non-null value seen across the (possibly truncated) rows, `nullable` is
set from whether any row held `null`/`undefined` in that column, and the adapter's own
`nativeType` (if supplied) is carried through as `format: { nativeType }`.

Worth knowing before relying on `field.type` for a _declared_ field: because the declared
definition is used wholesale, `field.type` for a declared field is always exactly the declaration
— it is never checked against what the query actually returned and then corrected. Stage 5
dataset validation (`validateDataset`, [`docs/architecture.md`'s six validation
stages](architecture.md#3-the-six-validation-stages-specmd-80)) does compare `field.type` against
the schema's declared type, but because both values trace back to the same declaration, that
comparison can never actually disagree with itself through `qspec.execute()` — a declared
`type: "number"` field that a data source actually returns as a `string` is not caught by this
check today. `docs/known-gaps.md` records this as an open, pre-existing gap (filed under "Worth
fixing, not urgent") with two named resolutions for whoever next touches `normalizeResult`.
Non-nullable violations _are_ still caught, separately, by row-scanning the actual returned data
rather than reading field metadata — only the declared-versus-actual **type** check has this gap,
not the null check.

## See also

- [`docs/data-sources.md`](data-sources.md) — the `DataSource` interface that produces a
  `RawQueryResult`, and the contract suite that checks it returns rows in the required shape.
- [`docs/manifest-specification.md`](manifest-specification.md) — `spec.dataset`'s declarative
  schema shape.
- [`docs/architecture.md`](architecture.md#3-the-six-validation-stages-specmd-80) — Stage 5
  dataset validation, and where it sits in `prepare()`/`execute()`.
- [`docs/known-gaps.md`](known-gaps.md) — the declared-vs-actual type-mismatch gap, and the
  nested-`Date`/HTTP round-trip limitation, both in full.
- The (forthcoming) Transforms topic — `docs/transforms.md` — covers how a `Dataset` is
  immutably reshaped after normalization and dataset validation.
