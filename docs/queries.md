# Queries

`spec.query` is what turns validated parameters into a request a data source can run (SPEC.md
§31):

```json
{
  "query": {
    "source": "analytics",
    "language": "sql",
    "statement": "...",
    "bindings": {}
  }
}
```

This document covers the part of a query declaration that is the same regardless of language or
adapter — `source`, `language`, and, in depth, the **binding model**. What a `source` actually is
and how to write one is [Data Sources](data-sources.md); the SQL-specific compilation this
document only summarizes (`CompiledSqlQuery`, the scanner, why it has no `text` field) is recorded
in [`docs/architecture.md`](architecture.md#9-qspecssql-and-qspecspostgres).

## `source` and `language`

`source` names a logical, runtime-configured data source — never a connection string, never
infrastructure detail (SPEC.md §32; see
[`docs/manifest-specification.md`](manifest-specification.md) and
[`docs/data-sources.md`](data-sources.md) for how a host wires a name to an actual
`DataSource`). `language` is resolved **independently** of `source` (SPEC.md §33): a manifest
names `"sql"`, `"promql"`, `"opensearch-dsl"`, or any language a query-language plugin registers,
and a data source separately declares (or doesn't) which languages it can execute — see
[Data Sources' `supportedLanguages`](data-sources.md#supportedlanguages) for how a mismatch
between the two is caught before any query runs. Keeping the two independent is what lets a
query-language plugin and a data-source plugin be written, and combined, without either knowing
the other exists.

`statement` is deliberately not typed as a string. SPEC.md §35 shows a structured OpenSearch DSL
object as a `statement`, and `QueryDefinition<TStatement>`
(`packages/core/src/types/query.ts`) carries `TStatement` as a generic precisely so a query
language plugin can pick whatever shape it needs — a SQL string for `@qspecs/sql`, a JSON payload
for anything else.

## The binding model

`bindings` maps a name a query's statement references (`:from` in SQL, or whatever a structured
language's own convention is) to where its value comes from. A binding
(`packages/core/src/types/query.ts`) is exactly one of three forms:

```json
{
  "bindings": {
    "from": "$parameters.from",
    "to": { "parameter": "to" },
    "country": { "literal": "US" }
  }
}
```

1. **String shorthand** — `"$parameters.<name>"`. The only string accepted here; every other
   string is a manifest error (see below).
2. **`{ "parameter": "<name>" }`** — the explicit, non-shorthand equivalent of the string form.
3. **`{ "literal": <any JSON value> }`** — binds a constant, not a parameter. The value still
   reaches the data source as a bound value (a `$1`/`:name`-style placeholder plus a parameter
   array for SQL), never spliced into the statement text — see
   [Data Sources](data-sources.md) and SPEC.md §34 ("Implementations must never interpolate
   untrusted values directly into SQL strings").

### A bare string is a parameter reference or nothing — no literal fallback

The pattern a string binding must match, verbatim from
[`packages/core/src/internal/bindings.ts`](../packages/core/src/internal/bindings.ts):

```ts
export const PARAMETER_REFERENCE = /^\$parameters\.([A-Za-z_][A-Za-z0-9_]*)$/;
```

If a string binding doesn't match this pattern, it is **not** treated as a literal string value —
it is a manifest validation error, in full:

```text
Binding "<name>" must be a parameter reference of the form "$parameters.<name>". To bind the
constant value <value>, write { "literal": <value> } instead.
```

This is a resolved design decision, not an oversight — from the design document
([`docs/superpowers/specs/2026-08-09-qspec-design.md`](superpowers/specs/2026-08-09-qspec-design.md#21-binding-model-specmd-34-35)),
quoted directly:

> The tempting alternative — "if the string doesn't look like a reference, treat it as a literal"
> — creates a silent failure mode where a typo such as `"$parameter.from"` becomes the literal
> string `"$parameter.from"` and is bound into a query. Requiring `{ "literal": "US" }` for
> literal strings costs three tokens of JSON and removes the category entirely.

**Why this matters in practice:** under the rejected alternative, a manifest author who
mistypes `"$parameters.from"` as `"$parameter.from"` (missing the `s`) would get no error at
all. The query would compile, the data source would execute it, and it would return a result —
filtered against (or comparing to) the literal fifteen-character string `"$parameter.from"` instead
of the caller's actual `from` value. Nothing about that failure is visible: no exception, no
empty result necessarily, just a query that ran successfully against the wrong value, silently,
every time it runs. Rejecting the malformed string instead turns that into a `prepare()`-time
error — before any database is ever touched (`bindings.ts`'s own comment: this is "Static work…
so a typo fails during prepare() rather than producing a silently wrong query").

### The object forms: exactly one key, not "whichever parses"

`{ parameter, literal }` bindings check **presence** of `parameter`/`literal` before checking
their **type**, deliberately in that order. If type were checked first, a malformed binding like
`{ "parameter": 5, "literal": "x" }` would see its wrongly-typed `parameter` (a number, not a
string) treated as absent, and `"literal": "x"` would look like the only field present — "both
keys given" would be misread as "exactly one key given, and it's `literal`." Checking
`Object.hasOwn` for both keys first, before looking at either value, catches "both present" (or
"neither present") as its own error: `Binding "<name>" must have exactly one of "parameter" or
"literal".`

### Undeclared parameter references fail the same way as a missing one

`{ "parameter": "typo_name" }` (or the string-shorthand equivalent) referencing a name absent
from `spec.parameters` is a manifest error with a "did you mean" suggestion computed against the
declared parameter names — the same `suggest()` Levenshtein-based hint used throughout core's
validators. This is one of the two checks [`docs/manifest-specification.md`'s "Why there are two
validators"](manifest-specification.md#why-there-are-two-validators) names as inexpressible in
JSON Schema (a dynamic cross-reference into whatever keys `spec.parameters` happens to declare);
core enforces it by threading the declared parameter names into `compileBindings`.

### Runtime resolution

Bindings are compiled once, during `prepare()` — proving every referenced parameter exists — and
resolved once per `execute()` call, against that call's validated parameter values
(`resolveBindings`, same file). A `literal` binding's value passes straight through. A `parameter`
binding looks up its name in the resolved parameter map; if the parameter is **absent** there —
which, per [Parameters](parameters.md#required-optional-and-defaults), is exactly the case of an
optional parameter with no default that the caller didn't supply — the binding resolves to
`null`, not to `undefined` and not to an error. A query's `:country` binding referencing an
unsupplied, default-less optional `country` parameter therefore receives a bound SQL `NULL`, the
same as if the caller had passed `null` explicitly.

## Where a compiled binding ends up

For SQL, `@qspecs/sql` turns the statement's `:name` placeholders and the resolved binding values
into a `CompiledSqlQuery` with no `text` field at all — only parallel `segments` (literal SQL)
and `values` (the caller's data) arrays, so an adapter has no string to concatenate a value into
even by mistake. `@qspecs/postgres`'s `renderPostgres` is the only place that becomes text plus
`$1`/`$2`/… placeholders. The full reasoning — including why the missing `text` field is what
makes SQL injection structurally impossible here rather than merely tested against — is recorded
in [`docs/architecture.md` §9.1](architecture.md#91-why-compiledsqlquery-has-no-text-field); this
document does not repeat it. A non-SQL query language plugin is free to compile `statement` plus
`bindings` into whatever shape its data source needs (SPEC.md §35's generic
`QueryDefinition<TStatement>`).

## Examples

[`examples/03-parameterized-query.qspec.json`](../examples/03-parameterized-query.qspec.json)
binds four parameters of different shapes into one SQL statement using the string shorthand
throughout. [`examples/01-complete-manifest.qspec.json`](../examples/01-complete-manifest.qspec.json)
does the same for three bindings inside SPEC.md §94's reference manifest.

## See also

- [`docs/parameters.md`](parameters.md) — what a query's bindings ultimately reference: declared
  types, required/optional, defaults.
- [`docs/data-sources.md`](data-sources.md) — what `source` names, the `DataSource` interface a
  compiled query is handed to, and `supportedLanguages`.
- [`docs/manifest-specification.md`](manifest-specification.md) — the full manifest shape and the
  two validators that check it.
- [`docs/architecture.md`](architecture.md#9-qspecssql-and-qspecspostgres) — `@qspecs/sql`'s
  compilation model and scanner, in depth.
