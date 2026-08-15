# Introduction

## What QSpec is

QSpec is an extensible declarative specification and runtime for defining parameterized data
queries, validating their inputs and outputs, transforming returned datasets, and describing how
those datasets should be presented (SPEC.md §1). A QSpec **manifest** — a plain JSON document — is
enough to describe an analytical resource (a chart, a table, a metric, a dataset) without writing
application-specific execution or visualization code for that resource.

The problem this solves: every team that ships charts or tables backed by a database ends up
writing the same glue, over and over, in slightly incompatible ways — a query with parameters
baked in, ad hoc validation of what came back, one-off transform code sitting between the database
and the chart library, and a chart component whose props only that one chart's author understands.
None of that is reusable, none of it is portable to a different query language or a different
renderer, and none of it can be validated before it runs. QSpec factors that glue into a single
declarative shape and a pipeline that executes it:

```text
Parameters → Validation → Query → Data Source → Result → Dataset Validation
    → Transformations → Normalized Dataset → Presentation
```

(SPEC.md §1; see [`docs/architecture.md`](architecture.md) §1 for how this repository realizes
that conceptual pipeline as concrete modules, and §3 for the six static/runtime validation stages
that guard every step of it.)

A manifest is validated before it runs — badly-typed parameters, a misspelled dataset field in a
chart's series, an unregistered transform — and, where a plugin's shape allows it, before the
query is ever issued at all. See [`docs/manifest-specification.md`](manifest-specification.md) for
the full manifest shape, and [`docs/quick-start.md`](quick-start.md) for a runnable pipeline.

## The architectural principle

SPEC.md §1 states the principle this whole codebase is organized around:

> QSpec Core must remain small, stable, deterministic, and extensible. Domain-specific
> functionality belongs in plugins.

This is not a slogan checked only at review time — it is enforced structurally:

- **`@qspecs/core` has zero runtime dependencies.** Its `package.json` declares no
  `dependencies` at all (SPEC.md §12 forbids it depending on `pg`, `mysql`, `react`, `recharts`,
  `echarts`, `prom-client`, or an OpenSearch client). Nothing a manifest depends on pulls in a
  supply chain the plugin author didn't choose.
- **Core registers exactly one resource kind, `Dataset`, and nothing else.** Every other
  capability — `Chart` (`@qspecs/charts`), the `sql` query language (`@qspecs/sql`), any data
  source (`@qspecs/postgres`, `@qspecs/testing`'s in-memory source), every transform
  (`@qspecs/transforms`), every presentation type — is registered by a plugin the caller opts into
  with `.use()`. Nothing in that list requires a change to `@qspecs/core` to add (SPEC.md §6).
- **`Dataset` itself asks for the least a resource kind can ask for**: no query and no
  presentation are required (`requiresPresentation: false`), because a `Dataset` resource is just
  validated, transformed data — a `Chart`, by contrast, declares `requiresQuery: true` and
  `requiresPresentation: true` in the plugin (`@qspecs/charts`) that defines what a chart _is_, not
  in core.
- **The public/internal boundary is enforced mechanically, not by convention.** Every package's
  `src/internal/` is unreachable from outside that package (no wildcard re-export, no `exports`
  subpath), checked on every CI run. See [`docs/architecture.md`](architecture.md#6-the-publicinternal-boundary-specmd-104)
  for the detail.

The practical effect: adding a new query language, a new chart type, a new transform, or a new
resource kind (a `Table` or a `Metric`, both named in SPEC.md's pipeline but not yet shipped by any
package in this repository) is a new plugin, not a patch to core. See
[`docs/architecture.md`](architecture.md) for how the plugin registry, the six validation stages,
and the `prepare()`/`execute()` split implement this in code, and
[`docs/plugins.md`](plugins.md) and [`docs/plugin-authoring.md`](plugin-authoring.md) for the
plugin API and a worked walkthrough of writing one.

## What QSpec is not

Being precise about what QSpec does not try to be saves more of a reader's time than any list of
features would:

- **Not an ORM.** QSpec has no notion of writing data back — the pipeline above runs in one
  direction, from parameters to presentation, with no insert, update, or delete anywhere in it.
  `spec.query.statement` is a query the manifest author (or whatever generated the manifest)
  already wrote in full; a query-language plugin parses, validates, and binds it — it does not
  map a class or an object graph onto rows the way an ORM does.
- **Not a BI tool.** SPEC.md §3 lists "a BI platform" and "a dashboard SaaS" among QSpec's
  explicit non-goals. There is no workspace, no saved-dashboard library, no user-account model,
  and no notion of "explore this data interactively" built into the specification or the runtime.
  Applications built on QSpec may implement any of that; QSpec itself only "defines and executes
  specifications" (SPEC.md §3, verbatim).
- **Not a query builder.** `spec.query.statement` is a complete, literal query — a SQL string, or,
  for a non-SQL language, a generic structured payload (SPEC.md §35, e.g. an OpenSearch DSL
  object) — not something assembled by chaining `.where()`/`.orderBy()`-style calls. The only
  "building" QSpec does to a query is binding named parameters into it
  (`$parameters.<name>` → `:name`, SPEC.md §34), never string interpolation, never construction of
  the query's shape.
- **Not a chart rendering engine either**, worth restating even though "chart" appears throughout
  this documentation: SPEC.md §1 requires QSpec not be designed as a charting library, because
  charts are only one possible presentation of a QSpec dataset (`Table`, `Metric`, and `Dashboard`
  are named as future resource kinds). `@qspecs/charts` computes a presentation _model_ —
  `resolveSeries` turns a dataset plus a presentation definition into plottable series data — and
  draws nothing itself; `@qspecs/recharts` is the package that renders pixels, and it is one
  possible renderer among others a plugin author could write.

## Where to go next

Getting started:

- [`docs/quick-start.md`](quick-start.md) — a real, runnable pipeline, verified against the
  packages as shipped.
- [`docs/manifest-specification.md`](manifest-specification.md) — the full manifest shape.
- [`docs/architecture.md`](architecture.md) — how this repository implements SPEC.md: the
  pipeline, the validation stages, the plugin contract, the public/internal boundary.

The manifest pipeline, in execution order:

- [`docs/parameters.md`](parameters.md) — declaring and validating a manifest's typed inputs.
- [`docs/queries.md`](queries.md) — turning validated parameters into a request a data source
  can run.
- [`docs/data-sources.md`](data-sources.md) — the plugin-registered capability that turns a
  compiled query into rows.
- [`docs/datasets.md`](datasets.md) — the normalized, JSON-safe shape query execution produces.
- [`docs/transforms.md`](transforms.md) — the declarative reshaping steps that run after a
  dataset comes back and before it is presented.
- [`docs/presentations.md`](presentations.md) — describing how a dataset should be shown.

Extending and operating QSpec:

- [`docs/plugins.md`](plugins.md) — the plugin contract every non-core capability is registered
  through.
- [`docs/plugin-authoring.md`](plugin-authoring.md) — a worked walkthrough of writing a transform
  and a data source from scratch.
- [`docs/react-integration.md`](react-integration.md) — the Suspense-first React binding over a
  `QSpecExecutor`.
- [`docs/cli.md`](cli.md) — the `qspec` binary's `validate` and `inspect` commands.
- [`docs/security.md`](security.md) — SPEC.md §72's security requirements, gathered in one place.
- [`docs/specification-versioning.md`](specification-versioning.md) — `apiVersion`, how it
  differs from npm package versions, and what an unsupported version does.
- [`docs/public-api.md`](public-api.md) — the public/internal/experimental boundary (SPEC.md
  §104) for every package.

Reference:

- [`docs/known-gaps.md`](known-gaps.md) — deferred items and accepted limitations, recorded so a
  later phase does not rediscover them.
- [`README.md`](../README.md) — package table, install instructions, and the CLI.
