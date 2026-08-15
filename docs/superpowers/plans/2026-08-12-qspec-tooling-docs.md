# QSpec Developer Tooling and Documentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver `qspec inspect`, a plugin-aware `qspec validate`, example manifests that cannot rot, and the full documentation set SPEC.md §92 names — completing SPEC.md §102's "CLI v1" and Phase 6, and closing the last standing gap from Plan 1.

**Architecture:** `qspec inspect` reads a manifest statically and prints its shape. `qspec validate` gains an optional plugin-aware mode: it loads plugins from a config file, registers a **permissive stub data source** for every source the manifest names, and runs `prepare()` — so transform, SQL, and presentation validation all run without a database and without a credential. Example manifests live in `examples/` and are validated by the CLI in CI, so they cannot drift from the schema they demonstrate. Documentation is markdown under `docs/`, cross-linked, with a test that catches the drift classes this project has actually observed.

**Tech Stack:** TypeScript 5.8+, Node.js ≥22.19, npm workspaces, Vitest 3. No new runtime dependencies.

**Predecessors:** [`2026-08-09-qspec-foundation.md`](2026-08-09-qspec-foundation.md), [`2026-08-09-qspec-data-presentation.md`](2026-08-09-qspec-data-presentation.md), [`2026-08-10-qspec-query-runtime.md`](2026-08-10-qspec-query-runtime.md), [`2026-08-11-qspec-react.md`](2026-08-11-qspec-react.md) — all merged. 966 tests.
**Design document:** [`../specs/2026-08-09-qspec-design.md`](../specs/2026-08-09-qspec-design.md)
**Carried gaps:** [`../../known-gaps.md`](../../known-gaps.md)
**Source specification:** `SPEC.md` — §86, §87, §92, §93, §94, §102, §104, and Phase 6

---

## Decisions made for this plan

Six calls. Three came from the user; the rest follow from them or from the shape of the standing gap.

### 1. Plugin-aware validation registers stub data sources, so it needs no credentials

This is the decision that closes `docs/known-gaps.md`'s blocking item 1, and it is the only interesting engineering problem in this plan.

The gap: `qspec validate` uses core's `validateManifestStructure`, which is registry-free by design. It cannot diagnose a malformed `filter.where`, an unknown transform operator, or a typo'd SQL binding (`:form` for `:from`), because that validation lives in each plugin's `validate()` hook and runs during `prepare()`. The gap entry is explicit that this must **not** be fixed by teaching core about transforms — that would reintroduce the coupling the plugin architecture exists to avoid.

So the CLI runs `prepare()`. But `prepare()` resolves the manifest's `spec.query.source` against the source registry and fails if it is absent — which would mean the CLI needs real connection details to validate a file. That is unacceptable for a linter.

**The resolution:** the CLI registers a stub `DataSource` for every source name the manifest references. The stub's `execute` throws if ever called — validation never executes — and it **omits `supportedLanguages`**, so it stays permissive and accepts whatever language the manifest declares. That omission is exactly the backward-compatibility guarantee Plan 3 built into that field, now doing a second job.

The result: `qspec validate --config qspec.config.js report.json` runs the entire `prepare()` pipeline — structural validation, parameter compilation, query-language `validate()`, transform `validate()`, dataset projection, presentation validation — with no database, no credentials, and no network.

**Verified, not assumed:** `prepareResource` calls `registries.sources.get(sourceName)` at `packages/core/src/internal/prepare.ts:204` and throws `UnknownDataSourceError` when it returns `undefined`. Stub sources are therefore required, not a convenience.

**One thing the CLI must NOT stub: the resource kind.** `prepare.ts:169` resolves `manifest.kind` against the resource registry and throws `UnknownResourceKindError` if absent. That is a real authoring error and must surface — so the config has to include whichever plugin registers the manifest's kind (`charts()` registers `Chart`). Stubbing kinds too would hide a genuine problem in order to make validation succeed, which is the opposite of the point. The distinction is deliberate: a *source* is deployment configuration a linter has no business knowing, while a *kind* is part of what the manifest means.

### 2. Loading a config file is code execution, and the CLI says so

`--config` imports and runs a JavaScript module. That is how every comparable tool works (ESLint, Vite, Vitest), and it is still worth being explicit about: without `--config`, `qspec validate` behaves exactly as it does today — structural validation only, no code loaded. Plugin-aware mode is opt-in, never discovered silently from the working directory.

The `--config` flag's help text and the CLI documentation both state that the file is executed. A tool that runs code found near your manifest without saying so is a supply-chain footgun.

### 3. `qspec inspect` is static and never loads plugins

Inspect prints what a manifest *says* — resource identity, parameters, query source and language, dataset fields, presentation shape. It reads the manifest and nothing else. It does not resolve plugins, does not run `prepare()`, and therefore works on any manifest whether or not the reader has the plugins installed.

That keeps the two commands cleanly separated: `inspect` answers "what is in this file", `validate` answers "is this file correct". A `--json` flag emits the same information as structured data, because the human-readable form in SPEC.md §87 is for reading, not parsing.

### 4. Examples are manifest fixtures, validated by the CLI in CI

Per the user's choice, `examples/` contains manifests and no runnable host code. The value that makes this more than a folder of JSON: **CI validates every example with the CLI itself**, in plugin-aware mode. An example that drifts from the schema, or that uses a transform operator that no longer exists, fails the build.

This gives the examples the one property example code usually lacks — they cannot rot silently. It also exercises the CLI against real manifests on every push, which is a second job the same test does.

The trade, stated plainly: a reader still has to assemble a working host themselves. The README's quick start and `test/react-pipeline.test.tsx` are where the runnable path lives.

### 5. Documentation is markdown, and one test guards the drift this project has actually seen

All fifteen topics SPEC.md §92 names, plus Public API (SPEC.md §104) — sixteen documents in total — as markdown under `docs/`, cross-linked, no site generator and no new toolchain.

Prose cannot be type-checked, so most doc rot is undetectable. But two classes are mechanically checkable, and both have already bitten this repo:

- **Package tables that disagree with manifests.** The final review of Plan 4 found the README's `@qspecs/recharts` peer-dependency cell omitting `@qspecs/core`, which the manifest lists. A test that reads every `package.json` and asserts the docs' tables match closes it.
- **Documented exports that do not exist.** A doc naming `useQSpecQuery` or `createQSpecHandler` should fail if the export is renamed or removed.

Task 9 builds that test. It is narrow on purpose: it catches names and tables, not claims. A doc that describes behaviour incorrectly still passes, and that limit is stated in the test's own comment so nobody mistakes it for a correctness guarantee.

### 6. Public API stability (SPEC.md §104) is documented, not enforced

SPEC.md §104 asks the project to distinguish Public, Internal, and Experimental API. The distinction already exists structurally: each package's `exports` map exposes only `.`, so anything reachable from a package entry point is public and everything under `internal/` is not.

Plan 5 documents that rule rather than building machinery to enforce it. The `exports` maps and the boundary guard already enforce the structural half; a stability *policy* (what may change in a minor, what requires a major) is a statement of intent, and belongs in prose.

---

## Global Constraints

- **No new runtime dependencies anywhere.** `@qspecs/cli` currently depends on `@qspecs/core` and `@qspecs/schema` only; plugin loading uses dynamic `import()`, not a resolver library.
- **`qspec validate` without `--config` must behave exactly as it does today.** Its current tests must pass unchanged; if one needs editing, that is a finding to raise before editing it.
- **No credentials anywhere in CLI configuration** (SPEC.md §9, §72.1). The stub source design exists precisely so a connection string is never needed to validate.
- **The CLI must not execute a query.** Plugin-aware validation runs `prepare()`, never `execute()`. The stub source's `execute` throws, and a test asserts it is never reached.
- ESM only; `.js` on relative imports; `import type` for type-only. No `eval`, no `new Function`.
- No `any`, `@ts-ignore`, `@ts-expect-error`, non-null assertions, or casts that strip `undefined` from an indexed access — implementation OR tests. Registry-widening casts are permitted.
- Never bracket-access a caller-supplied object with a caller-supplied name without `Object.hasOwn`.
- **Tests must be able to fail.** For every case marked "falsify", break the code it guards, confirm the test fails, restore, and report. Roughly thirty-two tests that could not fail have been found across the previous four plans; several in every plan.
- **Run all four gates before every commit:** `npm run format:check`, `npm run build`, `npm run typecheck:tests`, and the full root suite.
- Local commits only — **never `git push`**, never add or modify a remote.

---

## Existing contracts you must build against

Copied verbatim from merged packages. Do not guess these.

```ts
// @qspecs/core
interface QSpec {
  use(plugin: QSpecPlugin): QSpec;
  ready(): Promise<void>;
  prepare(manifest: QSpecManifest<QSpecResourceSpec> | string | unknown): Promise<PreparedResource>;
  execute(manifest: ..., context?: ExecutionContext): Promise<QSpecResult>;
  dispose(): Promise<void>;
}

interface PreparedResource {
  readonly manifest: QSpecManifest<QSpecResourceSpec>;
  readonly kind: string;
  readonly name: string;
  readonly projectedFields: readonly string[] | undefined;
  execute(context?: ExecutionContext): Promise<QSpecResult>;
}

interface DataSource<TCompiledQuery = unknown> {
  execute(query: TCompiledQuery, context: DataSourceContext): Promise<RawQueryResult>;
  dispose?(): Promise<void> | void;
  readonly supportedLanguages?: readonly string[];   // OMIT on the stub — omission is permissive
}

interface QueryDefinition<TStatement = unknown> {
  readonly source: string;
  readonly language: string;
  readonly statement: TStatement;
  readonly bindings?: { readonly [name: string]: Binding };
}

export function validateManifestStructure(manifest: unknown): QSpecIssue[];   // what validate uses today
```

Four points that matter:

- **`prepare()` resolves the source from the registry** and fails if absent. That is why stub sources exist.
- **A source that omits `supportedLanguages` accepts any language.** Verified in Plan 3; the stub relies on it.
- **`ManifestValidationError` carries `issues`** with `code`, `message`, `path`, and optional `suggestion` — the CLI's existing diagnostic rendering already consumes that shape.
- **`@qspecs/schema` validates with Ajv** and is already a CLI dependency; the existing `validate` path uses core's hand-written validator, and the two are kept in lockstep by a 49-case parity table.

---

## File Structure

```
packages/cli/src/
├── bin.ts                        argument parsing (extend: inspect, --config, --json)
├── commands/
│   ├── validate.ts               extend with plugin-aware mode
│   ├── inspect.ts                NEW
│   └── inspect.test.ts           NEW
└── internal/
    ├── config.ts                 NEW — load a config module, validate its shape
    ├── stub-source.ts            NEW — the permissive stub DataSource
    └── *.test.ts

examples/
├── README.md                     what these are and how CI checks them
├── monthly-revenue.qspec.json    the SPEC.md §94 manifest
└── *.qspec.json                  one per documented concept

docs/
├── introduction.md               ┐
├── quick-start.md                │
├── manifest-specification.md     │
├── parameters.md                 │
├── queries.md                    │  the fifteen topics
├── data-sources.md               │  SPEC.md §92 names,
├── datasets.md                   │
├── transforms.md                 │
├── presentations.md              │
├── plugins.md                    │
├── react-integration.md          │
├── cli.md                        │
├── security.md                   │
├── plugin-authoring.md           │
├── specification-versioning.md   │
└── public-api.md                 ┘  (SPEC.md §104)

test/docs-drift.test.ts           NEW — the anti-rot guard
```

Plus modifications: `.github/workflows/ci.yml`, `README.md`, `docs/known-gaps.md`.

---

## How this plan specifies tests

Test cases are enumerated case-by-case with their expected behaviour; you write them following the patterns in `packages/cli/src/commands/validate.test.ts`.

Where a task says "falsify", break the code the test guards, confirm it fails, restore, and report. If a falsification does **not** produce a failure, that is information about the test, not proof the code is fine.

This plan is unusually prose-heavy. **Documentation tasks still get reviewed**, and the review question for them is not "is this well written" but "is this *true*, and does it explain reasoning a maintainer would otherwise have to rediscover". A doc that restates what the code does adds nothing; a doc that says why it does it that way is the deliverable.

---

### Task 1: `qspec inspect`

**Files:**
- Create: `packages/cli/src/commands/inspect.ts`, `packages/cli/src/commands/inspect.test.ts`
- Modify: `packages/cli/src/bin.ts`

**Interfaces:**
- Consumes: `parseManifest` from `@qspecs/core`.
- Produces: `runInspect(paths: readonly string[], io: CliIo): Promise<number>` — the same shape as the existing `runValidate(paths, io)` at `packages/cli/src/commands/validate.ts:82`. Read it first; match its argument order, its exit codes, and its `CliIo` usage.

- [ ] **Step 1: The human-readable output**

SPEC.md §87 gives the exact shape. Reproduce it:

```text
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

Column alignment is part of the spec's output — pad to the widest name in each section, not a fixed width.

- [ ] **Step 2: `--json`**

The same information as structured data. A stable shape a script can consume: resource identity, parameters with type and required-ness, query source and language, dataset fields with types, presentation type and its field references.

- [ ] **Step 3: Tests**

- a complete manifest renders every section, with alignment
- a manifest with no parameters omits the Parameters section rather than printing an empty heading
- a manifest with no presentation (a `Dataset` kind) omits that section
- an optional parameter renders `optional`; a required one renders `required`
- a field with a `semanticType` renders `number/currency`; one without renders `number`
- `--json` emits parseable JSON whose values match the human output for the same manifest
- a malformed manifest exits non-zero with a diagnostic, not a stack trace
- inspect **never** loads a plugin or calls `prepare()` — assert by inspecting a manifest whose transforms reference a plugin that is not installed, and confirming it still succeeds

**Falsify** the last one: make inspect call `prepare()` and confirm that test fails.

- [ ] **Step 4: Verify and commit**

---

### Task 2: Config loading and the stub data source

The mechanism that closes the standing gap. It gets its own task, before the command that uses it.

**Files:**
- Create: `packages/cli/src/internal/config.ts`, `packages/cli/src/internal/stub-source.ts`, and a test per module

**Interfaces:**
- Produces: `loadConfig(path): Promise<QSpecConfig>` where `QSpecConfig` is `{ plugins: readonly QSpecPlugin[] }`; `createStubSource(): DataSource`.

- [ ] **Step 1: The stub source**

```ts
/**
 * A DataSource that exists only so `prepare()` can resolve a manifest's source
 * without a database. Its `execute` throws: plugin-aware validation runs
 * `prepare()`, never `execute()`, and if that ever changes this throw is how
 * we find out.
 *
 * It deliberately OMITS `supportedLanguages`. A source that omits it accepts
 * any language (SPEC.md §62, and the compatibility guarantee in Plan 3's
 * decision 6), which is exactly what a stub needs — it must not reject `sql`,
 * or any language a third-party plugin registers.
 */
```

Tests: `execute` throws with a message naming why; the object has no `supportedLanguages` property (assert with `Object.hasOwn`, not `=== undefined` — the distinction is the whole point).

- [ ] **Step 2: Config loading**

`loadConfig` resolves the path, `import()`s it, and validates the module's shape: a `plugins` array of objects. A config that exports the wrong shape fails with a message naming what was expected and what was found — this is a developer-facing error and deserves the same diagnostic quality as manifest errors.

Tests:
- a valid config loads and returns its plugins
- a default export and a named `plugins` export are both accepted (or exactly one is — pick, document, and test the choice)
- a missing file fails with a clear message naming the path
- a module that throws on import surfaces the underlying error rather than swallowing it
- a module exporting no plugins, or a non-array, fails with a shape diagnostic
- a config path is **never** discovered implicitly — assert that a `qspec.config.js` sitting in the working directory is not loaded without `--config`

**Falsify** the last one: add implicit discovery and confirm the test fails.

- [ ] **Step 3: Verify and commit**

---

### Task 3: Plugin-aware `qspec validate` — closing the standing gap

**Files:**
- Modify: `packages/cli/src/commands/validate.ts`, `packages/cli/src/bin.ts`
- Test: `packages/cli/src/commands/validate.test.ts`

- [ ] **Step 1: Wire it**

With `--config`, `validate`:
1. loads the config's plugins,
2. builds a runtime with `createQSpec()` and `use()`s each,
3. registers a stub source for **every source name the manifest references**,
4. calls `prepare()`,
5. renders any `ManifestValidationError` issues through the existing diagnostic path.

Without `--config`, nothing changes. **The existing tests must pass unedited.**

- [ ] **Step 2: Tests — the gap-closing cases**

These are the point of the whole plan. Each is a manifest that passes `qspec validate` today and must now fail with `--config`:

- a `filter` transform with an **unknown operator**
- a `filter` transform whose expression is nested past `maxExpressionDepth`
- a SQL statement with a **typo'd binding** (`:form` where the manifest declares `from`) — the case `docs/known-gaps.md` names explicitly
- a `derive` transform referencing a dataset field that will not exist
- a chart presentation whose series names a field the transforms project away

And the negative controls, which matter just as much:

- each of those manifests **passes** `qspec validate` without `--config`, proving the gap was real and that the two modes genuinely differ
- a valid manifest passes in both modes
- `prepare()` failing for a *structural* reason produces the same diagnostic as the registry-free path, not a doubled one

- [ ] **Step 3: Prove no query runs**

Assert the stub's `execute` is never called across every plugin-aware test. **Falsify** by making `validate` call `execute()` and confirming the assertion fires.

- [ ] **Step 4: Close the gap entry**

Remove blocking item 1 from `docs/known-gaps.md` — genuinely remove it, not reword it. Note in the entry's place, or in the CLI docs, that plugin-aware validation is opt-in and why.

- [ ] **Step 5: Verify and commit**

---

### Task 4: Example manifests, validated in CI

**Files:**
- Create: `examples/README.md`, `examples/*.qspec.json`, `examples/qspec.config.js`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: The manifests**

Start with SPEC.md §94's complete example manifest — it is the spec's own reference and should be reproduced faithfully. Then one manifest per documented concept: a minimal manifest, a parameterised one, one per transform, a grouped chart, a pie chart.

Each file carries a comment-free JSON body (JSON has no comments) and a companion paragraph in `examples/README.md` explaining what it demonstrates.

- [ ] **Step 2: The config**

`examples/qspec.config.js` exports the plugins the examples need — `sql()`, `transforms()`, `charts()`. Not `postgres()`: the stub source means no adapter is required, and depending on one would put a database driver in the examples' dependency path for no reason.

- [ ] **Step 3: CI validates them**

A CI step runs `qspec validate --config examples/qspec.config.js examples/*.qspec.json`. Every example must pass in **plugin-aware** mode — that is what makes them un-rottable.

Confirm the step fails when an example is broken: introduce a typo'd binding in one, watch CI's logic reject it, restore.

- [ ] **Step 4: Verify and commit**

---

### Task 5: Documentation — Introduction, Quick Start, Manifest Specification

**Files:** `docs/introduction.md`, `docs/quick-start.md`, `docs/manifest-specification.md`

- [ ] **Introduction** — what QSpec is, the problem it solves, and the architectural principle from SPEC.md's opening: core stays small, stable, deterministic, extensible; domain functionality lives in plugins. Name what QSpec is *not* — not an ORM, not a BI tool, not a query builder.

- [ ] **Quick Start** — SPEC.md §93's target, which the project treats as an architectural requirement. It must be **copy-pasteable and correct**; verify every import path and symbol against the actual packages rather than the spec's illustrative snippet.

- [ ] **Manifest Specification** — the full manifest shape: `apiVersion`, `kind`, `metadata`, `spec`. Reference `@qspecs/schema`'s JSON Schema as the machine-readable source of truth and say that the hand-written validator in core is kept in lockstep with it by a parity table, so a reader knows why there are two.

---

### Task 6: Documentation — Parameters, Queries, Data Sources, Datasets

**Files:** `docs/parameters.md`, `docs/queries.md`, `docs/data-sources.md`, `docs/datasets.md`

- [ ] **Parameters** — types, required/optional, validation, and the `presentation` metadata SPEC.md §67 describes for future form generation (noting it is unbuilt).

- [ ] **Queries** — the binding model: `"$parameters.name"`, `{parameter}`, `{literal}`. State the rule from the design doc that a bare string is a parameter reference **only** if it matches the reference pattern, and that there is no literal fallback — a typo must not silently become a bound literal.

- [ ] **Data Sources** — the `DataSource` interface, `supportedLanguages`, the contract suite in `@qspecs/testing`, and how to write an adapter. Point at `@qspecs/postgres` as the reference implementation, including its cancellation design.

- [ ] **Datasets** — field types, semantic types, positional `RawQueryResult` versus row objects and why, and the `Date`-to-ISO normalisation with its documented nested-value limit.

---

### Task 7: Documentation — Transforms, Presentations

**Files:** `docs/transforms.md`, `docs/presentations.md`

- [ ] **Transforms** — the six built-ins, the expression AST and its fixed operator set, `describe()` and what schema-opacity costs a manifest author, and ordering semantics.

- [ ] **Presentations** — the chart model, `resolveSeries`, cartesian versus pie, grouped series, and `SeriesPoint.index` with the reason it exists (a renderer pivoting series into a shared table needs global row order, which per-group order cannot supply).

---

### Task 8: Documentation — Plugins, React, CLI, Security, Authoring, Versioning, Public API

**Files:** `docs/plugins.md`, `docs/react-integration.md`, `docs/cli.md`, `docs/security.md`, `docs/plugin-authoring.md`, `docs/specification-versioning.md`, `docs/public-api.md`

- [ ] **Plugins** — the plugin API, registries, `setup()`, and load order.

- [ ] **React Integration** — the provider, the Suspense-first hooks, and **plainly** that this departs from SPEC.md §66's `{loading, error, refetch}` shape and why. Include the `<Suspense>`/error-boundary requirement and the executor seam.

- [ ] **CLI** — `validate`, `inspect`, `--config`, `--json`. State that `--config` **executes** the file.

- [ ] **Security** — the whole §72 set in one place: no credentials in manifests, no interpolation into SQL, no credential logging, the HTTP boundary carrying a resource name rather than a query, and — prominently — that the HTTP handler is **unauthenticated by design** and the host must mount it behind its own auth.

- [ ] **Plugin Authoring** — a walkthrough of writing a transform and a data source, with the contract suites as the acceptance bar.

- [ ] **Specification Versioning** — `apiVersion`, `SUPPORTED_API_VERSIONS`, and the compatibility rules.

- [ ] **Public API** — SPEC.md §104's Public/Internal/Experimental distinction: anything reachable from a package entry point is public; `internal/` is not; the `exports` maps and the boundary guard enforce the structural half.

---

### Task 9: The documentation drift guard

**Files:** Create `test/docs-drift.test.ts`

- [ ] **Step 1: What it checks**

Two mechanically-checkable classes, both observed in this repo:

1. **Package tables match manifests.** Every package named in the README's table exists; every peer dependency listed matches that package's `peerDependencies` exactly. Plan 4's final review found the `@qspecs/recharts` row omitting `@qspecs/core`.
2. **Documented exports exist.** Every symbol the docs name in a code fence as an import from a `@qspecs/*` package is actually exported by it.

- [ ] **Step 2: State the limit in the test itself**

A comment saying plainly what this does **not** check: prose accuracy, example correctness, whether a described behaviour is real. A future reader must not mistake a green docs test for a documentation-correctness guarantee.

- [ ] **Step 3: Falsify both**

Remove a peer dependency from a manifest without updating the README; rename a documented export. Confirm each fails.

---

### Task 10: Known gaps, CI, and full clean verification

- [ ] **Step 1: `docs/known-gaps.md`**

- Confirm blocking item 1 was removed in Task 3.
- Record the **observed flaky test**: during Plan 4's merge verification, one full-suite run on `main` reported `1 failed | 965 passed` and four subsequent runs were clean. The failing test's identity was not captured. The run was under heavy load (128 s of test time versus ~49 s normally). Prime suspects are the timing-bounded assertions: the memory source's abort bounds, the data-source contract suite's calibration, the Postgres cancellation timing, and the React pipeline's `waitFor`. **Record it as an open item with those specifics** — a flake nobody wrote down is a flake nobody fixes.
- Record what Plan 5 leaves open.

- [ ] **Step 2: CI**

The examples-validation step from Task 4, and confirm the docs-drift test runs.

- [ ] **Step 3: Full clean verification**

```bash
npm run clean && rm -rf node_modules && npm ci
npm run format:check && npm run build && npm run typecheck:tests && npx vitest run
node packages/cli/dist/bin.js validate examples/*.qspec.json
node packages/cli/dist/bin.js validate --config examples/qspec.config.js examples/*.qspec.json
node packages/cli/dist/bin.js inspect examples/monthly-revenue.qspec.json
```

The last three prove the shipped binary works, not just the test harness.

- [ ] **Step 4: Commit**

---

## Definition of Done

1. `npm ci && npm run build && npm run typecheck:tests && npx vitest run` passes from a clean clone, with and without Docker.
2. `qspec inspect` produces SPEC.md §87's output, and a `--json` form, without loading plugins.
3. `qspec validate --config` catches an unknown transform operator, an over-deep expression, a typo'd SQL binding, a bad `derive` reference, and a presentation naming a projected-away field — each of which passes without `--config`.
4. **No credential appears anywhere in CLI configuration**, and the stub source's `execute` is never called.
5. Every example manifest validates in plugin-aware mode in CI.
6. All fifteen SPEC.md §92 topics exist as markdown, plus Public API (SPEC.md §104) — sixteen documents in total.
7. The docs-drift guard catches a manifest/README mismatch and a renamed export.
8. `docs/known-gaps.md` blocking item 1 is removed, and the observed flake is recorded with its specifics.

### SPEC.md coverage

| Requirement | Where |
|---|---|
| §86 CLI diagnostics | existing `validate`, extended in Task 3 |
| §87 `qspec inspect` | Task 1 |
| §92 documentation set | Tasks 5–8 |
| §93 quick start | Task 5 |
| §94 example manifest | Task 4 |
| §102 CLI v1 | Tasks 1–3 |
| §104 public API stability | Task 8 |
| Phase 6 developer tooling | all |

### Deliberately out of scope

- **`qspec run`** — SPEC.md §102 permits postponing it, and the user chose to. Adding it would put connection strings into CLI configuration, the one place this project has kept them out.
- **Runnable example applications** — examples are manifest fixtures by choice; the runnable path lives in the README's quick start and `test/react-pipeline.test.tsx`.
- **A documentation site generator** — markdown only, no new toolchain.
- **Fixing the flaky test** — it is recorded with its specifics, not chased. Reproducing it needs the load conditions, and guessing at which assertion to widen would be worse than leaving it documented.
- **Automatic parameter forms (SPEC.md §67)** — still unbuilt, still documented as future work.
