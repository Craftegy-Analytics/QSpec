# QSpec
[![CI](https://github.com/Craftegy-Analytics/QSpec/actions/workflows/ci.yml/badge.svg)](https://github.com/Craftegy-Analytics/QSpec/actions/workflows/ci.yml)

QSpec is an extensible declarative specification and runtime for defining parameterized data
queries, validating their inputs and outputs, transforming returned datasets, and describing
how those datasets should be presented. A QSpec manifest makes it possible to describe an
analytical resource — a chart, a table, a metric, a dataset — without writing
application-specific execution or visualization code, and the architecture is deliberately not
a charting library: charts are just one possible presentation of a QSpec dataset. (SPEC.md §1)

> **`@qspecs/core` has zero runtime dependencies.** The manifest model, parameter validation,
> plugin system, and execution runtime are hand-written, dependency-free TypeScript. Nothing
> your manifests depend on pulls in a supply chain you didn't choose.

## Install

```bash
npm install \
  @qspecs/core \
  @qspecs/sql \
  @qspecs/postgres \
  @qspecs/transforms \
  @qspecs/charts
```

For a browser that renders a manifest's data as a chart, fed across an HTTP boundary by a
server holding the real query and credentials:

```bash
npm install @qspecs/http @qspecs/react @qspecs/recharts react recharts
```

`@qspecs/http`, `@qspecs/react`, and `@qspecs/recharts` are shipped — see the package table below.

> **The `@qspecs/http` handler is unauthenticated by design.** `createQSpecHandler` resolves a
> resource name against the registry the host supplied and executes on the host's own runtime —
> it has no auth hook, no session check, no rate limiter, exactly as `@qspecs/postgres` has no
> opinion on where a connection string comes from. A host mounts the handler behind its own
> authentication and authorization, the same way it supplies its own connection string. Exposing
> it unauthenticated on the open internet lets anyone execute the manifests it was constructed
> with, with the host's own credentials — that is a serious mistake to make by omission, not a
> limitation this package works around for you.

## Quick start

This is a real, runnable pipeline (SPEC.md §93): a SQL query language, a pooled PostgreSQL data
source, the standard transforms, and chart presentation. The connection string is host
configuration passed to `postgres()` — it never appears in a manifest (SPEC.md §9, §72.1).

```ts
import { createQSpec } from "@qspecs/core";
import { sql } from "@qspecs/sql";
import { postgres } from "@qspecs/postgres";
import { transforms } from "@qspecs/transforms";
import { charts, resolveSeries, type CartesianPresentation } from "@qspecs/charts";

const qspec = createQSpec()
  .use(sql())
  .use(
    postgres({
      sources: {
        analytics: {
          connectionString: process.env.DATABASE_URL!,
        },
      },
    }),
  )
  .use(transforms())
  .use(charts());

const manifest = {
  apiVersion: "qspec.dev/v1",
  kind: "Chart",
  metadata: { name: "monthly-revenue" },
  spec: {
    parameters: {
      from: { type: "date", required: true },
      to: { type: "date", required: true },
    },
    query: {
      source: "analytics",
      language: "sql",
      statement: "SELECT month, revenue FROM sales WHERE occurred_on BETWEEN :from AND :to",
      bindings: { from: "$parameters.from", to: "$parameters.to" },
    },
    dataset: { fields: { month: { type: "string" }, revenue: { type: "number" } } },
    transforms: [{ type: "filter", where: { field: "revenue", operator: "gt", value: 0 } }],
    presentation: { type: "line", x: { field: "month" }, series: [{ field: "revenue" }] },
  },
};

const result = await qspec.execute(manifest, {
  parameters: { from: "2026-01-01", to: "2026-12-31" },
});
const series = resolveSeries(result.data, result.presentation as CartesianPresentation);
console.log(series); // one plottable series, no renderer involved (SPEC.md §17)
```

`:from`/`:to` are named bindings, not string interpolation: `@qspecs/sql` compiles the statement
into a `CompiledSqlQuery` with no `text` field at all, and `@qspecs/postgres` is the only place
that ever turns it into text plus `$1`/`$2` placeholders and driver parameters — a bound value
can never reach the database as SQL, by construction (SPEC.md §72.2). See
[`test/postgres-pipeline.test.ts`](test/postgres-pipeline.test.ts) for this exact flow proven
end to end against a real PostgreSQL server, and
[`packages/postgres/test/integration.test.ts`](packages/postgres/test/integration.test.ts) for
an injection-shaped bound value proven inert against one.

## The browser path

The server-side pipeline above ends at a `QSpecResult` — a `Dataset` plus a presentation model,
with no rendering. To get that onto a screen, a server exposes its runtime over HTTP with
`@qspecs/http`, and a browser consumes it with `@qspecs/react` and `@qspecs/recharts`. The browser
never sees the query, the source name, or a credential — it knows a resource name and parameter
values, nothing else (SPEC.md §9, §72.1, §72.2).

```tsx
// server: mount behind your own auth — createQSpecHandler has none of its own.
import { createQSpec } from "@qspecs/core";
import { sql } from "@qspecs/sql";
import { postgres } from "@qspecs/postgres";
import { transforms } from "@qspecs/transforms";
import { charts } from "@qspecs/charts";
import { createQSpecHandler } from "@qspecs/http";

const runtime = createQSpec()
  .use(sql())
  .use(postgres({ sources: { analytics: { connectionString: process.env.DATABASE_URL! } } }))
  .use(transforms())
  .use(charts());

export const handler = createQSpecHandler({
  runtime,
  manifests: { "monthly-revenue": monthlyRevenueManifestJson },
});
// wire `handler` into your framework's route, behind whatever auth guards the rest of your API.
```

```tsx
// browser: knows a URL, a resource name, and two dates -- nothing executable.
import { createHttpExecutor } from "@qspecs/http";
import { QSpecProvider, QSpecResource } from "@qspecs/react";
import { QSpecChart } from "@qspecs/recharts";

const executor = createHttpExecutor({ url: "/api/qspec" });

function Dashboard() {
  return (
    <QSpecProvider executor={executor}>
      <Suspense fallback={<Spinner />}>
        <QSpecResource
          resource="monthly-revenue"
          parameters={{ from: "2026-01-01", to: "2026-12-31" }}
        >
          {(result) => {
            // A "Chart"-kind manifest always carries a presentation; this
            // narrows QSpecResult["presentation"] (PresentationDefinition |
            // undefined) without a cast.
            if (result.presentation === undefined) throw new Error("no presentation to render");
            return (
              <QSpecChart
                dataset={result.data}
                presentation={result.presentation}
                width={600}
                height={400}
              />
            );
          }}
        </QSpecResource>
      </Suspense>
    </QSpecProvider>
  );
}
```

`QSpecResource` suspends while the query is in flight and rethrows a failure to the nearest error
boundary — it never resolves to a `{ loading, error }` object (see
[`docs/known-gaps.md`](docs/known-gaps.md) for how this departs from SPEC.md §66's example). This
entire loop — a manifest, a real PostgreSQL server, an HTTP boundary, React suspending, Recharts
drawing SVG into a jsdom DOM, and an assertion that no SQL, table name, or password ever crosses
the wire — is proven end to end in
[`test/react-pipeline.test.tsx`](test/react-pipeline.test.tsx).

## What runs today

Every package in the install list above is implemented, plus `@qspecs/testing`'s in-memory data
source for exercising a full pipeline without a database. `@qspecs/sql` and `@qspecs/postgres` are
tested directly against a real PostgreSQL server; `@qspecs/transforms` and `@qspecs/charts` reach
that same server's data only transitively, through the one end-to-end pipeline test linked above
— each has its own dedicated unit-test suite, but no per-package PostgreSQL integration test of
its own. `@qspecs/react` and `@qspecs/recharts` are proven together, against the same real
PostgreSQL server, across the HTTP boundary `@qspecs/http` provides — see
[`test/react-pipeline.test.tsx`](test/react-pipeline.test.tsx) — so every package in the table
below is implemented and exercised, not just scaffolded. The example below needs no database at
all: it filters, derives a computed field, sorts, and limits a dataset, then resolves it into a
plottable line-chart series — the same pipeline proven end to end in
[`test/pipeline.test.ts`](test/pipeline.test.ts).

```ts
import { createQSpec } from "@qspecs/core";
import { memory } from "@qspecs/testing";
import { transforms } from "@qspecs/transforms";
import { charts, resolveSeries, type CartesianPresentation } from "@qspecs/charts";

const qspec = createQSpec()
  .use(
    memory({
      tables: {
        orders: {
          columns: ["month", "revenue"],
          rows: [
            ["2026-01", 100],
            ["2026-02", 50],
          ],
        },
      },
    }),
  )
  .use(transforms())
  .use(charts());

const manifest = {
  apiVersion: "qspec.dev/v1",
  kind: "Chart",
  metadata: { name: "monthly-revenue" },
  spec: {
    query: { source: "orders", language: "memory", statement: "orders" },
    dataset: { fields: { month: { type: "string" }, revenue: { type: "number" } } },
    transforms: [{ type: "filter", where: { field: "revenue", operator: "gt", value: 0 } }],
    presentation: { type: "line", x: { field: "month" }, series: [{ field: "revenue" }] },
  },
};

const result = await qspec.execute(manifest);
const series = resolveSeries(result.data, result.presentation as CartesianPresentation);
console.log(series); // one plottable series, no renderer involved (SPEC.md §17)
```

A misspelled `series[0].field` — say `"reveneu"` — fails inside `qspec.execute(manifest)`
before the in-memory source is ever queried, with a "did you mean" diagnostic. That is
`prepare()`'s static validation (SPEC.md §81) working before any data is fetched; see
[`docs/architecture.md`](docs/architecture.md) for exactly which stages run when.

## Packages

| Package              | Runtime dependencies             | Peer dependencies                                     | Environment              | Status  |
| -------------------- | -------------------------------- | ----------------------------------------------------- | ------------------------ | ------- |
| `@qspecs/core`       | **none**                         | —                                                     | browser + server         | shipped |
| `@qspecs/schema`     | `ajv`                            | —                                                     | browser + server         | shipped |
| `@qspecs/cli`        | `@qspecs/core`, `@qspecs/schema` | —                                                     | server only              | shipped |
| `@qspecs/transforms` | none                             | `@qspecs/core`                                        | browser + server         | shipped |
| `@qspecs/charts`     | none                             | `@qspecs/core`                                        | browser + server         | shipped |
| `@qspecs/testing`    | —                                | `@qspecs/core`, `vitest`                              | private, never published | shipped |
| `@qspecs/sql`        | none                             | `@qspecs/core`                                        | browser + server         | shipped |
| `@qspecs/postgres`   | `pg`                             | `@qspecs/core`, `@qspecs/sql`                         | **server only**          | shipped |
| `@qspecs/http`       | none                             | `@qspecs/core`                                        | browser + server         | shipped |
| `@qspecs/react`      | none                             | `@qspecs/core`, `react`                               | browser                  | shipped |
| `@qspecs/recharts`   | none                             | `@qspecs/core`, `@qspecs/charts`, `react`, `recharts` | browser                  | shipped |

(design §3)

## CLI

```bash
qspec validate report.json
```

Valid manifest:

```text
✓ Valid QSpec manifest
API version: qspec.dev/v1
Kind: Chart
Name: monthly-revenue
```

Invalid manifest:

```text
✗ Invalid QSpec manifest

spec.presentation.series[0].field:
Unknown dataset field "reveneu".

Did you mean "revenue"?
```

Developer-friendly diagnostics — a full path into the manifest plus a "did you mean"
suggestion where one applies — are treated as a product feature, not an afterthought.
(SPEC.md §86)

### Plugin-aware validation (`--config`)

By default, `qspec validate` runs core's structural validator only: it checks manifest shape,
but it is registry-free by design and cannot know what a `filter` transform's `where` clause
should look like, or that a SQL statement's `:name` binding has no declaration to match. That
validation lives in each plugin's own `validate()` hook and normally only runs when something
calls `prepare()`.

Passing `--config <path>` closes that gap: `validate` loads the plugins your config module
exports, builds a runtime, and calls `prepare()` against every manifest — the same static
checks a real caller gets, without a database. A stub data source stands in for each source
name a manifest declares (its `execute` always throws), so `prepare()` can resolve
`spec.query.source` without ever running a query or needing credentials.

```bash
qspec validate report.json --config qspec.config.mjs
```

```js
// qspec.config.mjs
import { sql } from "@qspecs/sql";
import { transforms } from "@qspecs/transforms";
import { charts } from "@qspecs/charts";

export const plugins = [sql(), transforms(), charts()];
```

This is opt-in, deliberately: loading a config module executes arbitrary code, so `validate`
never discovers one implicitly (no directory walking, no default filename lookup), and without
`--config` it runs no plugins and no user code at all.

Try it against the repository's own fixtures:

```bash
node packages/cli/dist/bin.js validate fixtures/valid/*.qspec.json
```

## Documentation

- [`SPEC.md`](SPEC.md) — the full technical specification and architecture requirements.
- [`docs/architecture.md`](docs/architecture.md) — how this repository implements that
  specification: the pipeline, the six validation stages, the plugin contract, and the
  public/internal boundary.
- [`docs/superpowers/specs/2026-08-09-qspec-design.md`](docs/superpowers/specs/2026-08-09-qspec-design.md) —
  the implementation design document, recording every ambiguity SPEC.md leaves open and how
  this codebase resolves it.
- [`docs/known-gaps.md`](docs/known-gaps.md) — deferred items and accepted limitations, judged
  deliberately and written down so a later phase does not rediscover them.

### Topic guides (SPEC.md §92, plus Public API from §104)

Getting started:

- [`docs/introduction.md`](docs/introduction.md) — what QSpec is, what it is not, and the
  architectural principle the rest of this documentation assumes.
- [`docs/quick-start.md`](docs/quick-start.md) — a real, runnable pipeline, verified against the
  packages as shipped.
- [`docs/manifest-specification.md`](docs/manifest-specification.md) — the full manifest shape,
  field by field.

The manifest pipeline, in execution order:

- [`docs/parameters.md`](docs/parameters.md) — declaring and validating a manifest's typed inputs.
- [`docs/queries.md`](docs/queries.md) — turning validated parameters into a request a data
  source can run.
- [`docs/data-sources.md`](docs/data-sources.md) — the plugin-registered capability that turns a
  compiled query into rows.
- [`docs/datasets.md`](docs/datasets.md) — the normalized, JSON-safe shape query execution
  produces.
- [`docs/transforms.md`](docs/transforms.md) — the declarative reshaping steps that run after a
  dataset comes back and before it is presented.
- [`docs/presentations.md`](docs/presentations.md) — describing how a dataset should be shown.

Extending and operating QSpec:

- [`docs/plugins.md`](docs/plugins.md) — the plugin contract every non-core capability is
  registered through.
- [`docs/plugin-authoring.md`](docs/plugin-authoring.md) — a worked walkthrough of writing a
  transform and a data source from scratch.
- [`docs/react-integration.md`](docs/react-integration.md) — the Suspense-first React binding
  over a `QSpecExecutor`.
- [`docs/cli.md`](docs/cli.md) — the `qspec` binary's `validate` and `inspect` commands.
- [`docs/security.md`](docs/security.md) — SPEC.md §72's security requirements, gathered in one
  place.
- [`docs/specification-versioning.md`](docs/specification-versioning.md) — `apiVersion`, how it
  differs from npm package versions, and what an unsupported version does.
- [`docs/public-api.md`](docs/public-api.md) — the public/internal/experimental boundary
  (SPEC.md §104) for every package.

## License

MIT
