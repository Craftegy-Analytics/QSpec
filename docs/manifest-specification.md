# Manifest Specification

A QSpec manifest is a plain, fully serializable JSON document (SPEC.md §4.1 — no JavaScript
functions may exist inside it). This document covers the top-level shape every manifest follows;
the depth of each section (parameters, queries, datasets, transforms, presentations) belongs to
its own documentation topic, linked from each section below rather than repeated here.

For the machine-readable version of everything in this document, see
[JSON Schema as source of truth](#json-schema-as-source-of-truth); for worked, CI-validated
examples instead of hand-typed fragments, see [`examples/`](../examples/) and its
[`README.md`](../examples/README.md).

## Top-level shape

Every QSpec v1 manifest follows this structure (SPEC.md §21):

```json
{
  "$schema": "https://qspec.dev/schemas/v1/qspec.json",
  "apiVersion": "qspec.dev/v1",
  "kind": "Chart",
  "metadata": { "name": "monthly-revenue" },
  "spec": {}
}
```

[`examples/02-minimal-dataset.qspec.json`](../examples/02-minimal-dataset.qspec.json) is the
smallest manifest QSpec accepts — a `Dataset` with an entirely empty `spec` — and shows that every
one of `spec`'s five sections is optional at the structural level; what a given `kind` actually
requires is a separate, plugin-driven check (see [`kind`](#kind) below).

### `$schema`

Optional but recommended (SPEC.md §22). Points editors at the JSON Schema document for
autocomplete and inline validation; it plays no role in what the runtime does with the manifest.

### `apiVersion`

Required (SPEC.md §23). The one value this runtime accepts today is `"qspec.dev/v1"`
(`@qspecs/core`'s `QSPEC_V1`, `packages/core/src/version.ts`) — `SUPPORTED_API_VERSIONS` is
currently a single-element list, and an unrecognized value fails validation with
`QSPEC_API_VERSION_UNSUPPORTED` rather than being silently accepted.

### `kind`

Required (SPEC.md §24). `kind` selects the resource kind — what the manifest's `spec` is
required to contain, and what the runtime is required to produce. Resource kinds are
registry-driven, exactly like every other capability (SPEC.md §6):

- **`Dataset`** is the one kind `@qspecs/core` itself registers — `requiresPresentation: false`,
  no query required either. It is the least a resource kind can ask for: validated, optionally
  transformed data, nothing more (`packages/core/src/internal/runtime.ts`).
- **`Chart`** is registered by `@qspecs/charts`, with `requiresQuery: true` and
  `requiresPresentation: true` — a chart with no data source or no presentation has nothing to
  render, so `prepare()` rejects it up front rather than failing later with an empty result
  (`packages/charts/src/index.ts`).
- SPEC.md §1 and §24 name `Table`, `Metric`, and `Dashboard` as kinds the architecture must
  eventually support, but as of this writing no package in this repository registers any of the
  three — using one of those `kind` values today fails with an unregistered-resource-kind error,
  not a supported-but-unimplemented one.

A manifest naming a `kind` no installed plugin registers is a **Stage 2** (plugin capability)
failure, not a structural one — `qspec validate` with no `--config` cannot catch it; see
[Why there are two validators](#why-there-are-two-validators) and
[`docs/architecture.md`](architecture.md#3-the-six-validation-stages-specmd-80) for the full
six-stage breakdown.

### `metadata`

Required object; `metadata.name` is the one required field inside it — a stable,
machine-friendly identifier, required to be a non-empty string and to match
`^[a-z][a-z0-9-]*$` (SPEC.md §25, `METADATA_NAME_PATTERN` in
`packages/core/src/types/manifest.ts`). Both are enforced by structural validation: a name that
fails the pattern is rejected with an issue and a `slugify`-generated suggestion
(`packages/core/src/internal/validate/manifest.ts`). `title`, `description`, and `tags` are
optional and purely descriptive — the runtime never branches on them.

```json
{
  "metadata": {
    "name": "monthly-revenue",
    "title": "Monthly Revenue",
    "description": "Revenue grouped by month",
    "tags": ["finance", "sales"]
  }
}
```

### `spec`

Everything about what the resource actually does (SPEC.md §26). For a `Chart`, `spec` typically
contains all five sections:

```json
{
  "spec": {
    "parameters": {},
    "query": {},
    "dataset": {},
    "transforms": [],
    "presentation": {}
  }
}
```

Each is its own documentation topic and deliberately not repeated in depth here:

| Section        | Optional at the structural level | Topic                                                                                             |
| -------------- | -------------------------------- | ------------------------------------------------------------------------------------------------- |
| `parameters`   | yes                              | Parameters (forthcoming — `docs/parameters.md`)                                                   |
| `query`        | yes, unless `kind` requires it   | Queries (forthcoming — `docs/queries.md`) and Data Sources (forthcoming — `docs/data-sources.md`) |
| `dataset`      | yes                              | Datasets (forthcoming — `docs/datasets.md`)                                                       |
| `transforms`   | yes                              | Transforms (forthcoming — `docs/transforms.md`)                                                   |
| `presentation` | yes, unless `kind` requires it   | Presentations (forthcoming — `docs/presentations.md`)                                             |

`spec` also accepts unrecognized keys without failing — both validators treat that as forward
compatibility, not an error (see the parity table entries for "extra key" cases, §
[Why there are two validators](#why-there-are-two-validators)).

## A complete example

[`examples/01-complete-manifest.qspec.json`](../examples/01-complete-manifest.qspec.json) is
SPEC.md §94's own reference manifest, deep-equal to it with blank lines removed, and validated in
CI — the single manifest that shows every top-level section working together: required and
optional parameters, a parameterized SQL query, a typed dataset schema (including a
`currency`-formatted field), a `filter` transform, and a `line` presentation. It is the manifest
[`docs/quick-start.md`](quick-start.md) runs end to end. [`examples/`](../examples/) has ten more:
a minimal dataset, a parameterized query, one per transform, and grouped-series and pie-chart
presentations.

## JSON Schema as source of truth

`@qspecs/schema` publishes the official, machine-readable QSpec v1 JSON Schema (SPEC.md §13, §76):

```ts
import { qspecV1Schema, QSPEC_V1_SCHEMA_ID } from "@qspecs/schema";
```

`qspecV1Schema` is the frozen schema document, keyed at
`packages/schema/src/schemas/v1/qspec.json` and identified by
`QSPEC_V1_SCHEMA_ID` (`https://qspec.dev/schemas/v1/qspec.json`) — the same URL a manifest's
optional `$schema` field points editors at for autocomplete. Anything that needs to validate a
manifest without a TypeScript/JavaScript runtime — an editor extension, a CI check in another
language, a documentation generator — should validate against this document rather than
reimplementing QSpec's structural rules.

## Why there are two validators

QSpec ships two independent manifest validators, and a reader who finds both with no explanation
would reasonably assume one is dead code. Neither is:

- **`@qspecs/core`'s `validateManifestStructure`**
  (`packages/core/src/internal/validate/manifest.ts`) is hand-written TypeScript with no
  dependencies — SPEC.md §12 forbids `@qspecs/core` from depending on anything beyond what it needs
  to be lightweight, and `@qspecs/core`'s `package.json` declares no `dependencies` at all, so a
  library like Ajv structurally cannot run inside it. It returns a `QSpecIssue[]`: each issue
  carries a structured `path` (rendered as `spec.presentation.series[0].field`, not just a string
  someone has to parse) and, where one applies, a Levenshtein-based "did you mean" suggestion
  (`suggest`, exported from `@qspecs/core`). This is the validator `prepare()` runs on every
  manifest, and the one `qspec validate` runs by default.
- **`@qspecs/schema`'s `validateWithJsonSchema`** (`packages/schema/src/index.ts`) compiles the
  same JSON Schema document above with Ajv (`Ajv2020`, `strict: false`) and reports Ajv's own
  errors, translated to the same dotted-path convention. It exists because the JSON Schema is the
  portable distribution artifact SPEC.md §76 requires — usable by an editor, a non-TypeScript
  tool, or anything that just needs "does this conform" without linking against `@qspecs/core`.

They are not two independent opinions that happen to agree by luck. They are **kept in lockstep by
a parity table**: [`packages/schema/test/parity-table.test.ts`](../packages/schema/test/parity-table.test.ts)
runs 54 manifest fixtures — metadata edge cases, parameter defaults, query bindings, transform and
presentation shapes — through both validators and asserts each one's _correct_ answer, not just
that the two agree (a bug that made both validators wrong the same way would still be caught).
[`packages/schema/test/conformance.test.ts`](../packages/schema/test/conformance.test.ts) covers
the same ground with a second, independent set of cases. And `qspec validate` itself runs both on
every invocation (`packages/cli/src/commands/validate.ts`): core's result is what gets reported to
the user, but if core accepts a manifest the JSON Schema rejects, that is treated as an
**internal validator mismatch** — a QSpec bug to report, not an ordinary validation failure — the
mechanical proof that the two are meant to never disagree.

Two documented exceptions exist, both because the check is not expressible in JSON Schema at all,
not because the schema is out of date:

1. **A parameter's `default` must match its own declared type/values/items/validation.** The
   schema leaves `default` unconstrained (`"default": true`) because "must satisfy whatever the
   sibling `type` field says" isn't practically expressible in JSON Schema; core enforces it via
   `collectDefaultIssues`, shared with parameter compilation so `validate` and `prepare` cannot
   drift from each other either.
2. **A binding referencing a parameter name that isn't declared in `spec.parameters`.** This is a
   cross-reference between two different parts of the manifest — expressing it in JSON Schema
   would need a dynamic enum of "whatever keys exist under `spec.parameters`," which JSON Schema
   has no mechanism for. Core enforces it by threading `spec.parameters`'s keys into its binding
   validation.

Both are recorded as explicit per-case overrides in the parity table (`expectSchemaValid`) rather
than silently tolerated drift — the table's own comment calls this out as "a validate-vs-prepare
concern inside core, not a schema-vs-core one," so the distinction between "the schema can't check
this" and "the schema is wrong" stays honest.

### Plugin-aware validation goes further than either

Both validators above check _structure_ — is this a well-formed manifest — never whether a
`filter` transform's `where` clause is well-formed for `@qspecs/transforms`' implementation of
`filter`, or whether a SQL statement's `:name` binding actually has a declared parameter behind
it. That is Stage 2–6 territory (SPEC.md §80), resolved by whatever plugins a caller installs, not
by either manifest-shape validator. `qspec validate --config <path>` runs those checks too,
without a database — see [`docs/cli.md`](cli.md#plugin-aware-validation---config),
[`docs/quick-start.md`](quick-start.md#validate-a-manifest-without-running-it), and the README's
[CLI section](../README.md#plugin-aware-validation---config).

## See also

- [`docs/introduction.md`](introduction.md) — what QSpec is and the principle behind splitting
  core from plugins.
- [`docs/quick-start.md`](quick-start.md) — a runnable pipeline using
  `examples/01-complete-manifest.qspec.json`.
- [`docs/architecture.md`](architecture.md) — the six validation stages, the `prepare()`/
  `execute()` split, and how the plugin registry implements all of the above.
- [`examples/README.md`](../examples/README.md) — every example manifest explained.
