# Plugin Authoring

This document walks through writing two new capabilities from scratch — a transform and a data
source — using the same interfaces `@qspecs/transforms`, `@qspecs/postgres`, and `@qspecs/testing`'s
`memory()` implement. [Plugins](plugins.md) covers the plugin shape and the registries in general;
this document is the "how do I actually write one" companion, with the contract suites shipped in
`@qspecs/testing` as the acceptance bar for each. Nothing here requires understanding any QSpec
internal module — every type used below is exported from `@qspecs/core`'s public entry point
(SPEC.md §105's explicit design goal).

## Writing a transform

A `Transform` has one required member and two optional ones (`packages/core/src/types/plugin.ts`):

```ts
interface Transform<TSpec = unknown> {
  execute(dataset: Dataset, spec: TSpec, context: TransformContext): Promise<Dataset> | Dataset;
  describe?(fields: readonly Field[], spec: TSpec): readonly Field[];
  validate?(spec: TSpec, fields: readonly Field[] | undefined): void | readonly QSpecIssue[];
}
```

Worked example: an `uppercase` transform that upper-cases the string value of one named field,
leaving every other field and row untouched.

```ts
import {
  definePlugin,
  type Dataset,
  type Field,
  type QSpecIssue,
  type Transform,
} from "@qspecs/core";

interface UppercaseSpec {
  readonly field: string;
}

const uppercaseTransform: Transform<UppercaseSpec> = {
  execute(dataset: Dataset, spec: UppercaseSpec): Dataset {
    const rows = dataset.rows.map((row) => {
      const value = row[spec.field];
      const out = Object.create(null) as Record<string, unknown>;
      for (const field of dataset.fields) {
        out[field.name] =
          field.name === spec.field && typeof value === "string"
            ? value.toUpperCase()
            : row[field.name];
      }
      return out;
    });
    return { ...dataset, rows };
  },

  describe(fields: readonly Field[]): readonly Field[] {
    // Upper-casing a string value changes no name, no type, no position.
    return fields;
  },

  validate(spec: UppercaseSpec, fields: readonly Field[] | undefined): readonly QSpecIssue[] {
    const issues: QSpecIssue[] = [];
    if (typeof spec?.field !== "string" || spec.field === "") {
      issues.push({
        code: "QSPEC_MANIFEST_INVALID",
        message: "`uppercase.field` must be a non-empty string.",
        path: ["field"],
      });
    } else if (fields !== undefined && !fields.some((f) => f.name === spec.field)) {
      issues.push({
        code: "QSPEC_MANIFEST_INVALID",
        message: `Unknown dataset field "${spec.field}".`,
        path: ["field"],
      });
    }
    return issues;
  },
};

export const myTransforms = definePlugin({
  name: "my-qspec-plugin",
  setup(api) {
    api.transforms.register("uppercase", uppercaseTransform as Transform);
  },
});
```

A few things this example is deliberately built to demonstrate, each grounded in a rule
[Transforms](transforms.md) documents in depth for the six built-in transforms:

- **Rows are built with `Object.create(null)`, never a plain object literal spread onto the
  original row.** A row keyed by a column literally named `constructor` must not resolve through
  `Object.prototype` — see [Datasets](datasets.md#positional-rawqueryresult-versus-row-objects) and
  [Security §72.4](security.md#724-prototype-pollution-resistance).
- **`execute` returns a fresh `Dataset`; it never mutates `dataset` in place.** Every built-in
  transform does the same, in line with SPEC.md §64 ("Transforms must not mutate their input
  dataset unless explicitly documented. Immutable behavior is preferred") — see
  [Transforms' ordering guarantee](transforms.md#ordering-strict-sequential-immutable).
- **`describe` and `execute` agree about the resulting fields**, because they must: `prepare()`
  folds `describe` across the pipeline to statically validate every downstream presentation field
  reference (SPEC.md §81), and if `execute`'s actual output ever disagreed with what `describe`
  projected, that static guarantee would be lying. `derive`'s `derivedField()` helper
  (`packages/transforms/src/internal/derive.ts`) is the pattern for keeping the two in lockstep
  when a transform is more than a pass-through — compute the resulting shape with one function
  both `execute` and `describe` call, rather than writing the projection twice by hand.
- **`validate` degrades gracefully when `fields` is `undefined`.** An earlier transform in the same
  pipeline may have omitted `describe`, leaving the schema opaque (see
  [Transforms' `describe()` section](transforms.md#describe-and-what-schema-opacity-costs-a-manifest-author));
  `validate` is still called every time and should check what it can — the spec's own shape — while
  skipping the field-name check it has no schema to check against, rather than throwing on a
  missing schema it was never guaranteed to have.
- **`validate` returns issues rather than throwing**, so several problems in one declaration can be
  reported together. Throwing instead — a plain `Error`, or a `QSpecError` subclass — is equally
  legal per the interface's own doc comment ("Return issues to report several problems at once, or
  throw to reject with one"), and caps the report at whichever problem is found first.

### Acceptance bar: `runTransformContractTests`

`@qspecs/testing`'s `runTransformContractTests` (`packages/testing/src/contracts/transform.ts`) runs
the same invariant checks against any `Transform`, so a new transform is held to exactly the
guarantees every built-in one already is:

```ts
import { runTransformContractTests } from "@qspecs/testing";

runTransformContractTests("uppercase", uppercaseTransform, {
  dataset: {
    fields: [{ name: "name", type: "string" }],
    rows: [Object.assign(Object.create(null), { name: "ada" })],
  },
  spec: { field: "name" },
});
```

The suite asserts, against the fixture supplied: `execute` never mutates the input dataset (rows,
field list, or row contents); every row it returns has a `null` prototype; every row's own keys
match the returned `fields` list exactly; `describe()` declares (a transform that omits it is
legal, but the suite fails loudly on that choice specifically, so it can never be accidental); when
`describe` is declared, its projection agrees with what `execute` actually produced; running
`execute` twice on the same input yields the same result (SPEC.md §8's determinism requirement);
and `validate()` accepts the fixture spec while rejecting a deliberately malformed one (by
returning issues or by throwing — either satisfies the suite). Every one of these failure modes is
a real bug a hand-rolled test suite could plausibly miss on a first pass; running against the
fixture above is what a new transform package's own test file should do before shipping.

## Writing a data source

A `DataSource` is smaller — one required method, one optional field, one optional cleanup hook
(`packages/core/src/types/plugin.ts`):

```ts
interface DataSource<TCompiledQuery = unknown> {
  execute(query: TCompiledQuery, context: DataSourceContext): Promise<RawQueryResult>;
  dispose?(): Promise<void> | void;
  readonly supportedLanguages?: readonly string[];
}
```

[Data Sources](data-sources.md) covers the interface, `supportedLanguages`, and
`@qspecs/postgres`'s cancellation design in full — this section is the abbreviated,
authoring-focused version. The reference shape to build toward is `createPostgresSource`
(`packages/postgres/src/internal/source.ts`) for a real network-backed adapter, and
`@qspecs/testing`'s `memory()` (`packages/testing/src/memory.ts`) for the simplest possible one with
no network calls at all — reading `memory()` end to end is the fastest way to see every required
piece in isolation, since it pairs an in-memory `DataSource` with a trivial pass-through
`QueryLanguage` and needs neither a real driver nor real credentials:

```ts
// `query.statement` names a configured table; `options.tables` is this source's own
// closed-over configuration — adapted from `memory()`'s own `execute`, simplified.
interface MemoryQuery {
  readonly statement: string;
}

async function execute(query: MemoryQuery, context: DataSourceContext): Promise<RawQueryResult> {
  // 1. Already-aborted callers should not cost any work.
  if (context.signal?.aborted === true) {
    throw new QSpecAbortError("Memory source aborted.", { cause: context.signal.reason });
  }
  // 2. Resolve the compiled query against this source's own state (here: a
  //    statement naming a configured table) using Object.hasOwn, never a bare
  //    bracket lookup — see Security §72.4.
  const name = query.statement;
  const table = Object.hasOwn(options.tables, name) ? options.tables[name] : undefined;
  if (table === undefined) {
    throw new QueryExecutionError(`No table named "${name}".`);
  }
  // 3. Return positional rows, never row objects — see Datasets.
  return { columns: toColumns(table.columns), rows: table.rows.map((row) => structuredClone(row)) };
}
```

The steps a new adapter package works through, in order:

1. **Define a source-specific compiled-query type** — whatever the paired `QueryLanguage.compile`
   produces. For a SQL adapter this is `@qspecs/sql`'s `CompiledSqlQuery`; a non-SQL language is
   free to compile to any shape (SPEC.md §35's generic `QueryDefinition<TStatement>`).
2. **Implement `execute(query, context)`.** Check `context.signal` before doing any work — an
   already-aborted caller should not cost a connection. Acquire whatever the backend needs, run the
   query, and return a `RawQueryResult`: **positional** rows plus a `columns` array, never row
   objects (see [Datasets](datasets.md#positional-rawqueryresult-versus-row-objects) for why —
   duplicate column names and prototype-unsafe column names both survive a positional shape and
   neither does a row-of-objects one).
3. **Register one `DataSource` per configured logical source name**, inside a `QSpecPlugin`'s
   `setup(api)`, via `api.sources.register(name, source)`.
4. **Propagate cancellation for real, and implement `dispose()` if there is a pool or connection to
   close.** [Data Sources' cancellation section](data-sources.md#reference-qspecpostgress-cancellation-design)
   records the two shortcuts a first attempt at this reaches for — cancelling on the connection
   already running the query, and destroying the socket instead of asking the server to stop — and
   why both are wrong for a connection-pooled backend.
5. **Declare `supportedLanguages`** if the source should reject a mismatched query language before
   ever compiling one, rather than accepting any language by omission (the compatible default for
   every source written before this field existed — see
   [Data Sources' `supportedLanguages` section](data-sources.md#supportedlanguages)).

```ts
export const myDataSource = definePlugin({
  name: "my-qspec-source",
  setup(api) {
    api.sources.register("my-source", {
      supportedLanguages: ["sql"],
      async execute(query, context) {
        /* ... */
      },
      async dispose() {
        /* close a pool, if there is one */
      },
    });
  },
});
```

### Acceptance bar: `runDataSourceContractTests`

`@qspecs/testing`'s `runDataSourceContractTests` (`packages/testing/src/contracts/data-source.ts`)
is the data-source equivalent — one function run against any `DataSource` implementation, so a new
adapter is checked against exactly the guarantees `@qspecs/postgres` and `@qspecs/testing`'s own
`memory()` are held to. A fixture supplies a `create()` factory, a `query` that succeeds and
returns at least one row (and must survive `structuredClone`, since the suite clones it to prove
`execute` didn't mutate it), the `expectedColumns` it returns, and, optionally, a `slowQuery` and
an `abortBoundMs` for exercising cancellation — omitting `slowQuery` skips the cancellation
assertions **visibly**, as a named, reported skip, never a silent pass. Full detail, including
exactly what the suite checks and why `abortBoundMs` defaults to 150ms, is in
[Data Sources' "The contract suite" section](data-sources.md#the-contract-suite); this document
does not repeat it. Both `@qspecs/postgres`'s and `@qspecs/testing`'s own test suites call
`runDataSourceContractTests` against their respective sources — a new adapter package should do
the same, alongside whatever backend-specific tests it needs (a real integration test against a
live server, for anything network-backed).

## A third contract suite exists for presentation types

`@qspecs/testing` also ships `runPresentationContractTests`
(`packages/testing/src/contracts/presentation.ts`), the equivalent acceptance bar for a
`PresentationType` — it checks `validate()` accepts a working fixture and rejects a malformed one,
and that `fieldReferences()` never throws, reports paths made only of string/number segments, and
reports every field the definition references (and no others — a presentation type that
under-reports is exactly what disables core's unknown-field detection for a field it silently
never mentions). This document does not walk through writing a new presentation type in the same
depth as a transform or a data source — [Presentations](presentations.md) covers the shape
`@qspecs/charts`' two `PresentationType` implementations follow — but the same "contract suite is
the acceptance bar" principle applies there too.

## See also

- [`docs/plugins.md`](plugins.md) — the plugin shape, the seven registries, and install/load order.
- [`docs/transforms.md`](transforms.md) — the six built-in transforms in full depth, the expression
  AST, and the `describe()`/`validate()` contracts this document's `uppercase` example follows.
- [`docs/data-sources.md`](data-sources.md) — the `DataSource` interface, `supportedLanguages`, the
  full contract-suite reference, and `@qspecs/postgres`'s cancellation design.
- [`docs/architecture.md` §5](architecture.md#5-plugin-authoring-specmd-105) — `definePlugin` and
  `QSpecPluginAPI`, in the context of how this repository implements SPEC.md end to end.
- [`docs/known-gaps.md`](known-gaps.md#charts-and-presentation--recorded-in-plan-2-for-plan-4-to-weigh) —
  under "`@qspecs/testing` is `\"private\": true`, so the contract suites are repo-internal": the
  contract suites keep this repository's own transforms and presentation types honest, but a
  third-party plugin author outside this repository cannot currently import them.
