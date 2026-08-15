# QSpec example manifests

Every manifest in this directory is validated in CI by the CLI itself, in
**plugin-aware** mode:

```
qspec validate --config examples/qspec.config.js examples/*.qspec.json
```

That is what keeps these examples from rotting. Structural validation alone
(`qspec validate` with no `--config`) only checks that a manifest has the
right shape — it cannot see an unknown transform operator, a filter
expression nested too deep, a SQL statement binding a parameter that does not
exist, or a chart series naming a field an earlier transform projected away.
`--config` loads `sql()`, `transforms()`, and `charts()` (see
`qspec.config.js`) and runs each manifest through `prepare()` against those
plugins, against a stub data source that satisfies `spec.query.source`
without ever executing a query or requiring credentials. If any example here
uses an operator that gets renamed, a field that gets dropped, or drifts from
the schema in any other way the CLI can detect, the build fails.

JSON has no comments, so this file carries the explanation each manifest
would otherwise need inline.

## Manifests

### `01-complete-manifest.qspec.json`

SPEC.md §94's own reference example, deep-equal to it with blank lines removed. A `Chart` with
required and optional parameters, a parameterized SQL query, a typed dataset
schema (including a `currency`-formatted field), a `filter` transform, and a
`line` presentation — the single manifest that shows every top-level section
working together. It validates as-is against the current schema and CLI, in
both structural and plugin-aware mode.

### `02-minimal-dataset.qspec.json`

The smallest manifest QSpec accepts: a `Dataset` with an empty `spec`. Every
section under `spec` — `parameters`, `query`, `dataset`, `transforms`,
`presentation` — is optional, and `Dataset` (unlike `Chart`) does not require
a query or a presentation. This is the floor everything else builds on.

### `03-parameterized-query.qspec.json`

A `Dataset` with four parameters of different shapes: two required dates, an
optional string with a default, and an optional integer constrained by
`validation.min`/`validation.max`. Its SQL query binds all four with
`$parameters.<name>` references, demonstrating how a manifest turns caller
input into query bindings without ever embedding a literal value in the
statement.

### `04-transform-filter.qspec.json`

A `Dataset` that narrows rows with the `filter` transform, using its
`{ field, operator, value }` comparison shorthand rather than the more
verbose `{ operator, arguments }` form — both compile to the same expression,
but the shorthand is the common case for a single comparison.

### `05-transform-select.qspec.json`

A `Dataset` that projects its query's columns down to a named subset with
`select`, dropping an internal-only field (`internal_notes`) before it ever
reaches a chart or a consumer.

### `06-transform-rename.qspec.json`

A `Dataset` that renames the query's raw `snake_case` column names to the
names the rest of the pipeline (and any downstream presentation) uses, via
`rename`'s `{ oldName: newName }` mapping.

### `07-transform-derive.qspec.json`

A `Dataset` that computes a new field, `totalPrice`, as `quantity *
unit_price` using `derive` and a `multiply` expression. Demonstrates that a
transform can add a field the query never returned, and that the added
field's type is declared explicitly (`fieldType`) rather than inferred.

### `08-transform-sort.qspec.json`

A `Dataset` that orders its rows by `revenue`, descending, with `sort`.

### `09-transform-limit.qspec.json`

A `Dataset` that takes one page of an already-ordered result with `limit`,
using both `count` and `offset` to demonstrate the transform's pagination
shape rather than just a bare top-N slice.

### `10-chart-grouped-series.qspec.json`

A `Chart` whose `line` presentation uses `series` in its **grouped** form —
`{ field, groupBy, label }` — instead of an explicit array of series. One
line is drawn per distinct value of `region`, derived at render time, rather
than one series definition per region having to be listed by hand.

### `11-chart-pie.qspec.json`

A `Chart` using the `pie` presentation type, which has no `x` axis and no
series list — only a `category` field (the slice label) and a `value` field
(the slice size). Included because `pie`'s shape is structurally different
enough from the cartesian types (`line`, `bar`, `area`, `scatter`) that an
example built only from those would leave it untested.

## `qspec.config.js`

Exports the three plugins every example above needs to clear `prepare()`:
`sql()` (query language and binding validation), `transforms()` (the six
transform operators used above), and `charts()` (the `line` and `pie`
presentation types, and the `Chart` resource kind itself). It deliberately
does **not** load `@qspecs/postgres` — plugin-aware `qspec validate` runs
manifests against a stub data source, never a real one, so no example here
needs, or should need, a database adapter or credentials.
