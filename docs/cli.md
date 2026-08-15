# CLI

`@qspecs/cli` (`node packages/cli/dist/bin.js`, published as the `qspec` binary) has two commands:
`validate` and `inspect`. Both read manifest files from disk and report diagnostics; neither
connects to a data source or runs a query. This document covers what each command checks, the two
output modes, `--config`'s plugin-aware validation — including the fact that **it executes the
config file you point it at** — and exit codes. Everything below was run directly against this
repository's own fixtures and `examples/`, not inferred from the source alone.

```text
qspec validate <manifest.json> [...] [--config <path>]
qspec inspect <manifest.json> [...] [--json]
```

## `validate`

```bash
qspec validate report.json
```

Runs two independent structural validators over the manifest — `@qspecs/core`'s
`validateManifestStructure` and `@qspecs/schema`'s Ajv-backed `validateWithJsonSchema` — and reports
core's result; see [Manifest Specification](manifest-specification.md#why-there-are-two-validators)
for why there are two and what it means if they ever disagree. A valid manifest prints:

```text
✓ Valid QSpec manifest
API version: qspec.dev/v1
Kind: Chart
Name: monthly-revenue
```

An invalid one prints every issue with its exact path and, where one applies, a "did you mean"
suggestion (SPEC.md §71, §86):

```text
✗ Invalid QSpec manifest

spec.presentation.series[0].field:
Unknown dataset field "reveneu".

Did you mean "revenue"?
```

With no `--config`, `validate` runs no plugins and executes no user code — it can only check
manifest _shape_: is `apiVersion` supported, is `metadata.name` present, does a parameter
declaration have a valid `type`, and so on. It structurally **cannot** know whether a `filter`
transform's `where` clause is well-formed, whether a SQL statement's `:name` binding actually has a
declared parameter behind it, or whether `"my-custom-transform"` names anything at all — those
checks live in each plugin's own `validate()` hook (SPEC.md §80's stages 2 and 4), which only runs
when something calls `prepare()` against a real runtime.

## Plugin-aware validation (`--config`)

```bash
qspec validate --config qspec.config.mjs report.json
```

**`--config` loads the named module with a dynamic `import()` and runs whatever top-level code it
contains — this is deliberate arbitrary code execution, not a data file.** `loadConfig`
(`packages/cli/src/internal/config.ts`) resolves the path against the current working directory
and imports it as a `file:` URL; there is no fallback search, no directory walking, and no default
`qspec.config.js` filename lookup — `validate` never discovers a config implicitly. Without the
flag, no config module is imported and no user code runs at all. This is why `--config` is opt-in
rather than default behavior: unlike structural validation, it is only as safe as the config file
itself.

A config module must export a `plugins` array, either as a named export or as
`export default { plugins: [...] }` (the shape tools like Vite/Vitest use); if both are present,
the named export wins. `examples/qspec.config.js`:

```js
import { sql } from "@qspecs/sql";
import { transforms } from "@qspecs/transforms";
import { charts } from "@qspecs/charts";

export const plugins = [sql(), transforms(), charts()];
```

`validate` builds a `QSpec` runtime, installs every plugin the config exports, then calls
`prepare()` — never `execute()` — against each manifest. A manifest's declared `spec.query.source`
still has to resolve to _something_, so `validate` registers a **stub** `DataSource` under each
source name it encounters (its `execute` always throws, naming itself if it is ever accidentally
called) — enough for `prepare()` to finish without a real connection string or credentials
anywhere in the process. An unregistered resource `kind`, by contrast, is never stubbed: that is a
genuine authoring error `prepare()` must still surface, unlike a source name, which is deployment
configuration a linter has no way to know in advance.

### What this catches that structural validation cannot

Verified directly against a manifest declaring `{ "type": "not-a-real-transform" }` in
`spec.transforms`: with no `--config`, `validate` reports the manifest as valid, because an unknown
transform _name_ is not a structural defect — `spec.transforms` is just an array of objects with a
string `type`, and any string is structurally legal there. With
`--config examples/qspec.config.js` (which installs `transforms()`), the same manifest fails:

```text
✗ Invalid QSpec manifest

spec.transforms[0].type:
  Unknown transform "not-a-real-transform". Registered transforms: derive, filter, limit, rename, select, sort.
```

The same gap applies to an expression nested past `maxExpressionDepth`, a `filter.where` clause
whose shape a transform's own `validate()` rejects, and a SQL statement binding a `:name` no
declared parameter backs — all Stage 2/4 territory (SPEC.md §80), resolved by whichever plugins a
caller installs, never by either manifest-shape validator alone. Try it against this repository's
own examples:

```bash
qspec validate --config examples/qspec.config.js examples/*.qspec.json
```

## `inspect`

```bash
qspec inspect report.json
```

Reads a manifest's static content and prints it — parameters, the query's source and language, the
dataset schema, and every field a presentation references — without loading any plugin and without
ever calling `prepare()`. This means `inspect` works whether or not the plugins a manifest's
`transforms` or `presentation` name are installed; it never resolves `spec.transforms` against a
registry at all, and `spec.transforms` itself is deliberately not part of the output (SPEC.md §87
shows no such section). Output, verified against `examples/01-complete-manifest.qspec.json`:

```text
✓ Valid QSpec manifest examples/01-complete-manifest.qspec.json

Resource
  Name: monthly-revenue
  Kind: Chart
  API: qspec.dev/v1

Parameters
  from       date      required
  to         date      required
  country    string    optional

Query
  Source: analytics
  Language: sql

Dataset
  month      datetime
  revenue    number/currency

Presentation
  Type: line
  X: month
  Series: revenue
```

Which dataset fields a presentation references is discovered **structurally**, not through the
presentation plugin's own `fieldReferences()` — `inspect` never loads `@qspecs/charts` or any other
presentation plugin, so it looks for the property names `@qspecs/charts`' own extractors happen to
use (`field` and `groupBy`) anywhere inside `spec.presentation`, generically. A third-party
presentation type using a different convention contributes no references to this output; that is
a structural limitation of `inspect`, not a bug in the manifest it is reading.

### `--json`

`--json` only applies to `inspect`. Passing it to `validate` is **silently accepted and has no
effect at all** — verified directly: `qspec validate report.json --json` produces byte-identical
output to the same command without the flag. `inspect --json` emits a single JSON array, one entry
per manifest that parsed and validated successfully, always an array even for one file — a fixed
shape means a script consuming the output needs one code path regardless of how many paths were
given:

```json
[
  {
    "path": "examples/01-complete-manifest.qspec.json",
    "resource": { "name": "monthly-revenue", "kind": "Chart", "apiVersion": "qspec.dev/v1" },
    "parameters": [{ "name": "from", "type": "date", "required": true }],
    "query": { "source": "analytics", "language": "sql" },
    "dataset": [{ "name": "month", "type": "datetime" }],
    "presentation": {
      "type": "line",
      "fieldReferences": [{ "path": ["x", "field"], "field": "month" }]
    }
  }
]
```

(Trimmed here to one entry per array for brevity. The real command reports every declared
parameter, dataset field, and field reference — this exact shape was captured directly from
`qspec inspect examples/01-complete-manifest.qspec.json --json`.)

A manifest that fails to read, parse, or structurally validate contributes no entry to the array —
its diagnostic still goes to stderr and the process still exits non-zero, so nothing is silently
dropped from the exit status even though it is absent from the JSON.

Passing `--config` to `inspect` is rejected outright (`"--config" is not supported by "inspect" —
it only applies to "validate".`, exit code 2) rather than silently ignored, since `inspect`
structurally never calls `prepare()` and a flag that would have no effect deserves an error, not
quiet acceptance — the opposite of how `validate` handles an unrecognized `--json`.

## Exit codes

Verified directly against real invocations:

| Code | Meaning                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | Every manifest given was read, parsed, and validated (and, under `--config`, prepared) successfully.                                                                                                                                                                                                                                                                                                       |
| `1`  | At least one manifest failed to read, failed to parse, or failed validation. `validate` also reports this for an internal-validator mismatch (core accepting a manifest the JSON Schema rejects) — a QSpec bug to report, not an ordinary validation failure; `docs/known-gaps.md` notes this branch is not currently reachable end to end, since the two validators are kept in lockstep by construction. |
| `2`  | Usage error: no paths given, an unknown command, `--config` passed to `inspect`, or an unrecognized flag (e.g. `validate --bogus x.json`).                                                                                                                                                                                                                                                                 |

`main()` (`packages/cli/src/bin.ts`) parses argv with Node's `parseArgs`, which throws
`ERR_PARSE_ARGS_UNKNOWN_OPTION` for a flag it does not recognize. That throw is caught around the
`parseArgs()` call and turned into the same exit-2 usage-error path as every other malformed
invocation, with the error's own message as the diagnostic — an unrecognized flag does not produce
a raw stack trace.

## See also

- [`docs/manifest-specification.md`](manifest-specification.md#why-there-are-two-validators) — why
  there are two structural validators and the two checks JSON Schema cannot express.
- [`docs/quick-start.md`](quick-start.md#validate-a-manifest-without-running-it) — validating the
  quick-start manifest both structurally and plugin-aware.
- [`README.md`'s CLI section](../README.md#cli) — the install-and-run version of this document.
- [`docs/plugins.md`](plugins.md) — what a plugin is and how `.use()`/`setup()` work, which is what
  a `--config` module's `plugins` array installs.
- [`examples/README.md`](../examples/README.md) — every example manifest, all validated in CI in
  plugin-aware mode against `examples/qspec.config.js`.
