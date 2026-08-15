# Parameters

`spec.parameters` declares the named, typed inputs a manifest accepts before anything else runs
(SPEC.md §27 — "Parameters are first-class QSpec entities"). Every value a query binds, and every
value a caller supplies to `qspec.execute()`, flows through the declarations in this section first;
see [`docs/queries.md`](queries.md) for how a declared parameter becomes a bound value inside a
query.

```json
{
  "parameters": {
    "from": { "type": "date", "required": true },
    "to": { "type": "date", "required": true },
    "country": { "type": "string", "required": false, "default": "US" }
  }
}
```

(SPEC.md §27's own example, reformatted onto single lines — values unchanged.)
[`examples/01-complete-manifest.qspec.json`](../examples/01-complete-manifest.qspec.json)
and [`examples/03-parameterized-query.qspec.json`](../examples/03-parameterized-query.qspec.json)
run this shape end to end — the latter adds an `enum`-free `integer` parameter with `min`/`max`
validation, worth reading alongside this document rather than retyped here.

## Declared types

SPEC.md §28 names eight standard parameter types; `PARAMETER_TYPES` in
[`packages/core/src/internal/validate/parameters.ts`](../packages/core/src/internal/validate/parameters.ts)
is the runtime's exact match for that list — a type outside it fails to compile with
`QSPEC_MANIFEST_INVALID` rather than being silently accepted:

```text
string
number
integer
boolean
date
datetime
enum
array
```

`enum` additionally requires a non-empty `values` array; `array` requires `items.type` naming one
of `string`, `number`, `integer`, `boolean`, `date`, or `datetime` — deliberately not `array` or
`enum` again. Nesting is excluded on purpose: `checkScalar`, the function that validates one array
element, has no branch for a composite type, and its `never`-exhaustiveness default would return
the type's own _name_ as the element's runtime value rather than fail loudly. A two-dimensional
array parameter, or an array of enums, is not representable in v1.

## Required, optional, and defaults

A parameter's runtime resolution (`validateParameters`, the same file) follows one rule per
declaration:

- **Supplied** means the caller's input object has an own key for that parameter, and its value is
  neither `undefined` nor `null`. **Passing `null` for a parameter is treated exactly like
  omitting it** — it does not count as "provided," so a `null` input falls through to the default
  or the required check below, not to a type error.
- If **not supplied** and a `default` is declared, the default is used.
- If **not supplied**, no `default` is declared, and `required: true`, validation fails with
  `Parameter "<name>" is required.`
- If **not supplied**, no `default`, and `required` is not `true` (the default), the parameter is
  simply **absent from the resolved parameter map** — not set to `null`, not set to any value.
  This matters downstream: [`docs/queries.md`](queries.md#runtime-resolution) covers what an
  absent parameter binds to in a query.
- If **supplied**, the value is coerced and checked against the declared `type` (and, for
  `array`, against each element's `items.type`), then against any `validation` rules.

Every parameter in the manifest's declared set is checked, and **every problem is collected before
throwing** — a caller with three invalid parameters sees three issues in one
`ParameterValidationError`, not one-at-a-time. A key present in the caller's input that names no
declared parameter is also an error (`Unknown parameter "<name>"`, listing the declared names), so
a typo'd parameter name in a caller's input is caught the same way a typo'd parameter name in a
binding is (see [Queries](queries.md)).

## Type validation

Each type applies its own check before any `validation` rule runs, all in
`packages/core/src/internal/validate/parameters.ts`:

- **`string`**, **`number`** (must be finite — `Infinity`/`NaN` are rejected), **`integer`**
  (finite and `Number.isInteger`), **`boolean`** — a plain `typeof` check.
- **`date`** — must match `^\d{4}-\d{2}-\d{2}$` **and** name a real calendar day. The second check
  exists because `new Date("2026-02-31T00:00:00Z")` does not throw in JavaScript; it silently
  rolls over to March 3rd. `isRealDate` catches that by round-tripping the parsed date back to an
  ISO string and comparing it against the original — a value that survives the round trip
  unchanged is real, one that doesn't (like `2026-02-31`) is rejected.
- **`datetime`** — a broader ISO 8601 pattern (date, `T` or space, time, optional seconds/fraction,
  optional zone) that must also parse to a valid `Date` and pass the same real-calendar-day check
  on its date portion, for the same rollover reason.
- **`enum`** — the supplied value must strictly equal (`===`) one of the declared `values`; there
  is no coercion between, say, the number `7` and the string `"7"`.
- **`array`** — every element is checked against `items.type` using the same scalar checks above;
  `validation.minLength`/`maxLength` then apply to the array's own length.

## Validation constraints

`validation` applies after type coercion succeeds (SPEC.md §29):

```json
{ "minRevenue": { "type": "number", "default": 0, "validation": { "min": 0, "max": 1000000 } } }
{ "search": { "type": "string", "validation": { "minLength": 2, "maxLength": 100 } } }
```

`min`/`max` apply only when the coerced value is a `number` (so `number` and `integer`
parameters); `minLength`/`maxLength` apply whenever the coerced value is a `string` or an `array`.
That includes `date` and `datetime`: `coerce()` routes every type other than `enum` and `array`
through the same generic branch, so a `date`/`datetime` parameter's coerced ISO string reaches
`applyScalarConstraints` exactly like a `string` parameter's value does, and `minLength`/
`maxLength` is enforced against its character count. A manifest declaring
`validation: { minLength, maxLength }` on a `date` parameter should expect it to be enforced, not
ignored. Only `boolean` and `enum` are genuinely exempt: `enum`'s branch in `coerce()` returns
before `applyScalarConstraints` is ever reached, and a coerced `boolean` value is neither a
`string`, a `number`, nor an `array`, so none of `applyScalarConstraints`'s branches match it.

## Defaults are validated too, at manifest-compile time

A declared `default` is checked against its own parameter's `type`, `values`/`items`, and
`validation` — not left to fail lazily the first time no caller supplies a value.
`collectDefaultIssues` runs the same `coerce()` function the runtime uses for a supplied value,
called both from `compileParameters` (during `prepare()`, so a manifest with a badly-typed default
fails immediately) and from structural validation (`qspec validate`, with no database or plugins
needed) — the two are explicitly the same function so they cannot drift apart. See
[`docs/manifest-specification.md`](manifest-specification.md#why-there-are-two-validators) for why
a default's validity is one of only two checks JSON Schema cannot express and core has to own.

## Presentation metadata (SPEC.md §30, §67) — advisory, and unbuilt

A parameter definition may carry an optional `presentation` block:

```json
{
  "country": {
    "type": "string",
    "presentation": { "control": "select", "label": "Country" }
  }
}
```

Its shape (`ParameterPresentation` in
[`packages/core/src/types/parameters.ts`](../packages/core/src/types/parameters.ts)) is four
optional strings — `control`, `label`, `placeholder`, `help` — and nothing in `@qspecs/core` reads
any of them to make a decision. SPEC.md §30 states plainly: "This metadata must be advisory. The
core runtime must not depend on it." That is enforced by omission — no code path in `@qspecs/core`
branches on `definition.presentation` at all — but the block's _shape_ is still checked structurally:
`packages/core/src/internal/validate/manifest.ts` rejects a non-object `presentation`, and rejects a
non-string `control`, `label`, `placeholder`, or `help`, under its own comment: "Advisory only: core
never reads this to make decisions, but a malformed value is still a mistake `qspec validate` should
catch." Advisory and unvalidated are not the same thing — `qspec validate` still catches a
`presentation` block with the wrong shape, even though nothing downstream in `@qspecs/core` ever
reads a well-formed one.

SPEC.md §67, "Automatic Parameter Forms," sketches what this metadata is _for_: a future React
package reading `spec.parameters`' declared types, `enum` values, and `presentation` hints to
generate an input form without a manifest author hand-writing one. Its own example (reformatted
onto single lines — values unchanged):

```json
{
  "period": {
    "type": "enum",
    "values": ["7d", "30d", "90d"],
    "presentation": { "control": "select", "label": "Period" }
  }
}
```

— which SPEC.md §67 says "[c]ould automatically produce" a `Period` label, a
`[ Last 30 days ▼ ]` select control, and an `[ Apply ]` button.

**Nothing in this repository builds that today.** `docs/known-gaps.md` records it explicitly:
`@qspecs/react`'s `useQSpecQuery` and
`QSpecResource` both take already-resolved parameter _values_, never a manifest's parameter
_declarations_ — the browser in the current React integration never even sees `spec.parameters`,
only a resource name and whatever values the caller already decided to pass. Until a package
inspects a manifest's parameter schema and turns it into controls, `presentation` metadata is
inert: safe to write into a manifest for whatever future or third-party tooling wants it, with no
effect on `qspec.execute()` or on anything shipped in this repository. See
[`docs/known-gaps.md`](known-gaps.md#automatic-parameter-forms-specmd-67-remain-unbuilt) for the
recorded reasoning.

## See also

- [`docs/queries.md`](queries.md) — how a declared parameter's _value_ becomes a query binding,
  and the rule that a bare string binding is a parameter reference or nothing at all.
- [`docs/manifest-specification.md`](manifest-specification.md) — the full manifest shape and why
  two independent validators check it.
- [`docs/architecture.md`](architecture.md#3-the-six-validation-stages-specmd-80) — parameter
  validation is Stage 3, run during `execute()`; declaration-shape checks are part of Stage 1.
- [`docs/known-gaps.md`](known-gaps.md) — the unbuilt automatic-parameter-forms capability, and
  other recorded, deliberate gaps.
- [`examples/README.md`](../examples/README.md) — every example manifest, including the two that
  exercise parameters most directly.
