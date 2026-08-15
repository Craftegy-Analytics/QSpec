# Quick Start

SPEC.md §93 sets a target for how little code it should take to get from a manifest to a
rendered result, and treats that simplicity "as an architectural requirement," not an aspiration.
§93 has three code blocks — `bash` install, `ts` runtime setup, `ts` `execute()` call. The two
`ts` blocks are joined below, values unchanged; the install block appears separately, in
[Install](#install), with `@qspecs/transforms` added to it (see why below), and its `parameters`
object reflowed onto one line:

```ts
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
  .use(charts());

const result = await qspec.execute(manifest, {
  parameters: { from: "2026-01-01", to: "2026-12-31" },
});
```

That sketch predates five plans of implementation, so before trusting it, every import and symbol
below was checked against the packages as shipped rather than transcribed from the spec. One thing
changed on the way from sketch to real API, worth calling out rather than papering over:

- **§93 does not install or `.use()` `@qspecs/transforms`.** That's consistent for a manifest with
  no `spec.transforms` — but the moment a manifest uses one of the standard transforms (SPEC.md
  §94's own reference manifest, deep-equal to the one run below, uses `filter`),
  `@qspecs/transforms` has to be installed and `.use(transforms())` has to run, or `prepare()`
  fails to resolve that transform. This doc's example needs it for exactly that reason.

§93 also shows no `import` statements and no manifest — those are filled in below, with every
import path checked against each package's actual exports (`packages/*/src/index.ts`), not
assumed.

## Install

```bash
npm install \
  @qspecs/core \
  @qspecs/sql \
  @qspecs/postgres \
  @qspecs/transforms \
  @qspecs/charts
```

## The pipeline

This wires a SQL query language, a pooled PostgreSQL data source, the standard transforms, and
chart presentation, then runs [`examples/01-complete-manifest.qspec.json`](../examples/01-complete-manifest.qspec.json)
— SPEC.md §94's own reference manifest, deep-equal to it with blank lines removed, and validated
in CI (see [`examples/README.md`](../examples/README.md)) — through it. Pointing at that file instead of
retyping the manifest here means this example can't drift from the one already checked against
the schema and the CLI.

```ts
import { readFileSync } from "node:fs";
import { createQSpec } from "@qspecs/core";
import { sql } from "@qspecs/sql";
import { postgres } from "@qspecs/postgres";
import { transforms } from "@qspecs/transforms";
import { charts, resolveSeries, type CartesianPresentation } from "@qspecs/charts";

// The connection string is host configuration passed to postgres() — it
// never appears in a manifest (SPEC.md §9, §72.1).
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

const manifest = JSON.parse(
  readFileSync(new URL("../examples/01-complete-manifest.qspec.json", import.meta.url), "utf8"),
);

const result = await qspec.execute(manifest, {
  parameters: { from: "2026-01-01", to: "2026-12-31", country: "US" },
});

const series = resolveSeries(result.data, result.presentation as CartesianPresentation);
console.log(series); // one plottable series, no renderer involved (SPEC.md §17)
```

Adjust the `readFileSync` path if you paste this outside a file living next to `examples/`, and
point `analytics` at a real PostgreSQL server with an `orders` table shaped like the manifest's
query expects (`month`, `revenue`, `created_at`, `country`, `amount`) — the manifest is real and
runnable, but it still needs real data behind it. `:from`/`:to`/`:country` are named bindings, not
string interpolation: `@qspecs/sql` compiles the statement into a `CompiledSqlQuery` with no `text`
field at all, and `@qspecs/postgres` is the only place that ever turns it into text plus
`$1`/`$2`/`$3` placeholders and driver parameters — a bound value can never reach the database as
SQL, by construction (SPEC.md §72.2). This exact flow — manifest, real PostgreSQL server, chart
presentation — is proven end to end in
[`test/postgres-pipeline.test.ts`](../test/postgres-pipeline.test.ts).

## Without a database

If you don't have a PostgreSQL server handy, the same pipeline shape runs against an in-memory
data source with no network call at all — see the second example in
[`README.md`](../README.md#what-runs-today) and
[`test/pipeline.test.ts`](../test/pipeline.test.ts). That in-memory source (`@qspecs/testing`'s
`memory()`) is this repository's own test tooling, not a published package (see the package table
in [`README.md`](../README.md#packages)) — reach for `@qspecs/postgres` or a data-source plugin of
your own for anything beyond exercising a pipeline locally.

## Validate a manifest without running it

Structural validation catches a malformed manifest before any of the above runs:

```bash
node packages/cli/dist/bin.js validate examples/01-complete-manifest.qspec.json
```

Passing `--config` runs the same static checks a real caller gets — including whether a
transform, a query binding, or a presentation field actually resolves — without a database:

```bash
node packages/cli/dist/bin.js validate --config examples/qspec.config.js examples/*.qspec.json
```

See [`docs/manifest-specification.md`](manifest-specification.md) for the full manifest shape,
[`examples/`](../examples/) for ten more worked manifests (a minimal dataset, a parameterized
query, one per transform, and grouped-series and pie charts), and the README's
[CLI section](../README.md#cli) for what each validator reports and why there are two of them.

## The browser path

The pipeline above ends at a `QSpecResult` — a dataset plus a presentation model, with no
rendering. Getting that onto a screen crosses an HTTP boundary and a Suspense-driven React
component tree; see [`README.md`'s "The browser path"](../README.md#the-browser-path) for a
complete, verified example, and [`docs/react-integration.md`](react-integration.md) — this
material's real home — for the provider, the hooks, and the Suspense/error-boundary requirement in
full.
