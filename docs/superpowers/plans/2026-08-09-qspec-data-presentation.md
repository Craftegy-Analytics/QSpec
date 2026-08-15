# QSpec Data & Presentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver `@qspecs/transforms`, `@qspecs/charts`, and the private `@qspecs/testing` package, so a QSpec manifest runs end-to-end — parameters through query, transforms, and chart presentation — with no database.

**Architecture:** Two publishable peer-dependency-only packages plus one private test-support package. `@qspecs/transforms` registers six declarative transforms, each implementing `execute`, `describe` (static schema inference), and `validate`. `@qspecs/charts` registers five presentation types and the `Chart` resource kind, and owns `resolveSeries` so every renderer agrees on how series are derived. `@qspecs/testing` provides an in-memory data source and the reusable contract suites SPEC.md §89 requires.

**Tech Stack:** TypeScript 5.8+, Node.js ≥20.11, npm workspaces, Vitest 3.

**Predecessor:** [`2026-08-09-qspec-foundation.md`](2026-08-09-qspec-foundation.md) — merged, 388 tests.
**Design document:** [`../specs/2026-08-09-qspec-design.md`](../specs/2026-08-09-qspec-design.md)
**Carried-forward gaps:** [`../../known-gaps.md`](../../known-gaps.md)
**Source specification:** `SPEC.md`

---

## Decisions made for this plan

Four judgment calls, stated up front because they are not obvious from the specification.

### 1. The expression subsystem becomes public API of `@qspecs/core`

The foundation plan deliberately left `internal/expression/` unexported, on the reasoning that "shipping a public operator table with no entry point commits v1 to a shape whose consumer does not exist." **That consumer now exists.** `@qspecs/transforms` is a separate package and cannot reach `packages/core/src/internal/` — the `exports` map exposes only `.`, and a boundary test enforces it.

So Task 2 exports `normalizeExpression`, `evaluateExpression`, and the `Expression` type. The public signature drops `normalizeExpression`'s fourth parameter (`depth`), which is recursion state and not a caller's concern.

The alternative — moving the subsystem into `@qspecs/transforms` — was rejected: expressions are referenced by SPEC.md §42 as part of the specification, not as one plugin's private concern, and `derive` plus a future `having`/policy layer would all need them.

### 2. `derive` is in scope, despite SPEC.md §99 listing it as v1.1

§99's v1 transform list is `filter sort limit select rename`, with "Derived expressions may be implemented in v1.1 if necessary." But §43 specifies derived fields concretely, and once `filter` has wired up expression evaluation, `derive` is that same machinery plus one field. Deferring it would mean shipping the hard half and withholding the easy half.

If this is unwanted, drop Task 6 — nothing else depends on it.

### 3. `qspec validate` still cannot catch transform-spec errors, and that is not a bug

Task 18 of the foundation plan established that `validateManifestStructure` must reject whatever `prepare()` rejects, because `qspec validate` never calls `prepare()`. That principle does **not** extend here.

Core's structural validator is registry-free by design: it cannot know what a `filter` transform's `where` clause should look like, because `filter` lives in a package core does not depend on. Transform-specific validation therefore happens in each transform's `validate()` hook, which runs during `prepare()`.

The consequence — `qspec validate` cannot diagnose a malformed `where` clause — is a real limitation of a registry-free validator, not an oversight. Plan 5's CLI work should address it by letting `qspec validate` optionally load plugins and call `prepare()`. **Do not** try to close it by teaching core about transforms.

### 4. `@qspecs/charts` owns the `Chart` resource kind

Core registers only `Dataset`. A `Chart` requires a presentation, and the package that defines what a chart *is* is the one that should declare that requirement.

---

## Global Constraints

- **`@qspecs/core` keeps ZERO runtime dependencies.** Neither new published package may add one either: `@qspecs/transforms` and `@qspecs/charts` declare `@qspecs/core` as a **peer** dependency and nothing else.
- **ESM only.** `"type": "module"` everywhere. No CommonJS build.
- **No `eval`, no `new Function`**, anywhere. This is the whole reason the expression interpreter exists.
- **Every package:** `"sideEffects": false`, `"license": "MIT"`, `"engines": { "node": ">=20.11" }`, version `0.1.0`, `"publishConfig": { "access": "public" }`, and an `exports` map exposing ONLY `.` and `./package.json`. `@qspecs/testing` is `"private": true` and therefore omits `publishConfig`.
- **Internal modules live in `src/internal/`** and must be unreachable through `exports`. No `export * from "./internal/..."`.
- **No `any`, `@ts-ignore`, `@ts-expect-error`, non-null assertions, or casts that strip `undefined` from an indexed access** — in implementation OR test files. Use `.entries()`, an explicit guard, or a helper that throws. This was corrected nine times in the foundation plan; do not reintroduce it.
- **Relative imports carry the `.js` extension**; type-only imports use `import type`.
- **Transforms must not mutate their input dataset.** Return a new `Dataset`; the pipeline reassigns from the return value.
- **Dataset rows are null-prototype objects.** Build new rows with the same discipline — never `{}`, never spread into a plain object literal. `@qspecs/core` does not export `createRow`, so each package needs its own two-line equivalent using `Object.create(null)` and `Object.defineProperty`.
- **Tests must be able to fail.** Before claiming a regression guard works, break the code it guards and confirm the test fails. Nine tests in the foundation plan passed regardless of the behavior they named.
- **Commit after every task.** Conventional Commits. Local commits only — **never `git push`**, and never add or modify a remote. One now exists and the user pushes manually.

---

## Existing contracts you must build against

Copied verbatim from the merged `@qspecs/core`. Do not guess these.

```ts
interface Transform<TSpec = unknown> {
  execute(dataset: Dataset, spec: TSpec, context: TransformContext): Promise<Dataset> | Dataset;
  describe?(fields: readonly Field[], spec: TSpec): readonly Field[];
  validate?(spec: TSpec, fields: readonly Field[] | undefined): void | readonly QSpecIssue[];
}

interface TransformContext {
  readonly executionId: string;
  readonly parameters: Record<string, JsonValue>;
  readonly signal?: AbortSignal | undefined;
}

interface PresentationType<TDefinition = PresentationDefinition> {
  validate?(definition: TDefinition, context: PresentationValidationContext): void | readonly QSpecIssue[];
  fieldReferences?(definition: TDefinition): readonly FieldReference[];
}

interface FieldReference {
  readonly field: string;
  readonly path: readonly PathSegment[];   // relative to spec.presentation
}

interface ResourceKind {
  readonly requiresQuery?: boolean;
  readonly requiresPresentation?: boolean;
  validate?(spec: QSpecResourceSpec, context: ResourceKindContext): void | readonly QSpecIssue[];
}

interface DataSource<TCompiledQuery = unknown> {
  execute(query: TCompiledQuery, context: DataSourceContext): Promise<RawQueryResult>;
  dispose?(): Promise<void> | void;
}

interface QueryLanguage<TStatement = unknown, TCompiledQuery = unknown> {
  compile(query: QueryDefinition<TStatement>, context: QueryCompileContext): Promise<TCompiledQuery> | TCompiledQuery;
  validate?(query: QueryDefinition<TStatement>): void | readonly QSpecIssue[];
}

interface RawQueryResult {
  readonly columns: readonly { name: string; nativeType?: string }[];
  readonly rows: readonly (readonly unknown[])[];        // POSITIONAL, not objects
  readonly metadata?: { durationMs?: number; truncated?: boolean };
}

interface Field { name: string; type: FieldType; nullable?: boolean; label?: string; semanticType?: string; format?: JsonObject }
type FieldType = "string" | "number" | "integer" | "boolean" | "date" | "datetime" | "object" | "array";
```

Three points that trip people up:

- **`validate` hooks return issues OR throw.** Returning `readonly QSpecIssue[]` reports several problems at once and is preferred. Issue `path`s are **relative** — to `spec.transforms[i]` for a transform, to `spec.presentation` for a presentation type.
- **`describe` omission is meaningful.** A transform without `describe` is schema-opaque: `prepare()` stops projecting fields there, `projectedFields` becomes `undefined`, and static presentation validation is skipped from that point on. Every transform in this plan implements `describe`.
- **`limits` reaches plugins via `api.limits`** at setup time. That is how `maxExpressionDepth` gets to the `filter` transform — capture it in the closure during `setup`.

---

## File Structure

```
packages/
├── testing/                        PRIVATE — never published
│   ├── package.json
│   ├── tsconfig.build.json
│   └── src/
│       ├── index.ts                public surface for the other packages' tests
│       ├── memory.ts               memory() plugin: pass-through language + tables
│       └── contracts/
│           ├── transform.ts        runTransformContractTests
│           └── presentation.ts     runPresentationContractTests
├── transforms/
│   ├── package.json
│   ├── tsconfig.build.json
│   └── src/
│       ├── index.ts                transforms() plugin + public types
│       ├── internal/
│       │   ├── rows.ts             null-prototype row helpers
│       │   ├── issues.ts           shared issue-building helpers
│       │   ├── filter.ts
│       │   ├── sort.ts
│       │   ├── limit.ts
│       │   ├── select.ts
│       │   ├── rename.ts
│       │   └── derive.ts
└── charts/
    ├── package.json
    ├── tsconfig.build.json
    └── src/
        ├── index.ts                charts() plugin + public types
        ├── types.ts                ChartPresentation, AxisSpec, SeriesSpec, ResolvedSeries
        └── internal/
            ├── cartesian.ts        shared line/bar/area/scatter shape
            ├── pie.ts
            └── resolve-series.ts   resolveSeries — the shared semantics
```

Plus modifications: `packages/core/src/index.ts` (Task 2), root `tsconfig.json` references, and `docs/known-gaps.md`.

---

## How this plan specifies tests

Implementation code is given verbatim — use it as written. **Test code is given verbatim for
the first instance of each pattern (Tasks 1, 2, 3, 7) and enumerated case-by-case thereafter**,
because five near-identical transform suites written out in full would be 1500 lines of
copy-paste that nobody reads carefully.

Where a task enumerates cases in prose, each bullet is one `it(...)` with its exact expected
behavior stated. Write them following the patterns established in Tasks 1–3.

**This convention has a known failure mode, and it is this project's chronic one:** an
enumerated case is easy to write in a way that passes regardless of the behavior it names.
Nine tests in the foundation plan did exactly that. So for every case a task marks with
"assert this explicitly" or "falsify", break the code it guards, confirm the test fails, restore,
and report the outcome. If a test cannot be made to fail, say so rather than leaving it in
place looking like coverage.

---

### Task 1: `@qspecs/testing` — private test support and the in-memory data source

Everything else in this plan needs a way to run a pipeline without a database. This package
provides it, plus the reusable contract suites SPEC.md §89 requires.

**Files:**
- Create: `packages/testing/package.json`, `packages/testing/tsconfig.build.json`
- Create: `packages/testing/src/index.ts`, `packages/testing/src/memory.ts`
- Test: `packages/testing/src/memory.test.ts`
- Modify: root `tsconfig.json` (add the reference)

**Interfaces:**
- Consumes: `definePlugin`, `QSpecPlugin`, `QSpecPluginAPI`, `DataSource`, `DataSourceContext`, `QueryLanguage`, `RawQueryResult`, `QSpecAbortError` from `@qspecs/core`.
- Produces: `memory(options): MemoryPlugin`, types `MemoryTable`, `MemoryOptions`, `MemoryPlugin`, `MemoryCall`.

- [ ] **Step 1: Create the package**

`packages/testing/package.json` — note `"private": true`, so no `publishConfig`:

```json
{
  "name": "@qspecs/testing",
  "version": "0.1.0",
  "description": "Internal test support for the QSpec monorepo. Never published.",
  "private": true,
  "type": "module",
  "license": "MIT",
  "sideEffects": false,
  "engines": { "node": ">=20.11" },
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
    "./package.json": "./package.json"
  },
  "peerDependencies": { "@qspecs/core": "0.1.0", "vitest": "^3.0.0" },
  "scripts": { "build": "tsc -p tsconfig.build.json" }
}
```

`packages/testing/tsconfig.build.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.test.ts"],
  "references": [{ "path": "../core/tsconfig.build.json" }]
}
```

Add `{ "path": "./packages/testing/tsconfig.build.json" }` to the root `tsconfig.json` references.

- [ ] **Step 2: Write the failing test**

`packages/testing/src/memory.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { QSpecAbortError, createQSpec } from "@qspecs/core";
import { memory } from "./memory.js";

const manifest = {
  apiVersion: "qspec.dev/v1",
  kind: "Dataset",
  metadata: { name: "example" },
  spec: {
    parameters: { from: { type: "date", required: true } },
    query: {
      source: "analytics",
      language: "memory",
      statement: "analytics",
      bindings: { from: "$parameters.from" },
    },
  },
};

function build(delayMs?: number) {
  const plugin = memory({
    tables: {
      analytics: {
        columns: ["month", "revenue"],
        rows: [
          ["2026-01-01T00:00:00Z", 10],
          ["2026-02-01T00:00:00Z", 0],
        ],
        ...(delayMs === undefined ? {} : { delayMs }),
      },
    },
  });
  return { plugin, qspec: createQSpec().use(plugin) };
}

describe("memory", () => {
  it("registers a data source per table and a pass-through query language", async () => {
    const { qspec } = build();
    const result = await qspec.execute(manifest, { parameters: { from: "2026-01-01" } });
    expect(result.data.fields.map((f) => f.name)).toEqual(["month", "revenue"]);
    expect(result.data.rows).toHaveLength(2);
    expect(result.data.rows[0]?.["revenue"]).toBe(10);
  });

  it("records each call with the compiled statement and resolved bindings", async () => {
    const { plugin, qspec } = build();
    await qspec.execute(manifest, { parameters: { from: "2026-01-01" } });
    expect(plugin.calls).toHaveLength(1);
    expect(plugin.calls[0]?.source).toBe("analytics");
    expect(plugin.calls[0]?.statement).toBe("analytics");
    expect(plugin.calls[0]?.bindings).toEqual({ from: "2026-01-01" });
  });

  it("accepts explicit column descriptors alongside bare names", async () => {
    const plugin = memory({
      tables: {
        analytics: {
          columns: [{ name: "month" }, { name: "revenue", nativeType: "numeric" }],
          rows: [["2026-01-01T00:00:00Z", 10]],
        },
      },
    });
    const result = await createQSpec()
      .use(plugin)
      .execute(manifest, { parameters: { from: "2026-01-01" } });
    expect(result.data.fields[1]?.format).toMatchObject({ nativeType: "numeric" });
  });

  it("propagates cancellation from the caller's signal", async () => {
    const { qspec } = build(50);
    const controller = new AbortController();
    const promise = qspec.execute(manifest, {
      parameters: { from: "2026-01-01" },
      signal: controller.signal,
    });
    // Abort after the adapter is genuinely in flight, not before it starts —
    // aborting synchronously would be caught by the pre-execution guard and
    // would prove nothing about the source's own signal handling.
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    await expect(promise).rejects.toThrow(QSpecAbortError);
  });

  it("rejects a statement naming no configured table", async () => {
    const { qspec } = build();
    const bad = { ...manifest, spec: { ...manifest.spec, query: { ...manifest.spec.query, statement: "nope" } } };
    await expect(qspec.execute(bad, { parameters: { from: "2026-01-01" } })).rejects.toThrow(/nope/);
  });

  it("returns an independent row array on each call, so a transform cannot corrupt the fixture", async () => {
    const { qspec } = build();
    const first = await qspec.execute(manifest, { parameters: { from: "2026-01-01" } });
    expect(first.data.rows).toHaveLength(2);
    const second = await qspec.execute(manifest, { parameters: { from: "2026-01-01" } });
    expect(second.data.rows).toHaveLength(2);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run packages/testing`
Expected: FAIL — cannot resolve `./memory.js`.

- [ ] **Step 4: Implement the memory source**

`packages/testing/src/memory.ts`:

```ts
import {
  QSpecAbortError,
  QueryExecutionError,
  definePlugin,
  type DataSource,
  type DataSourceContext,
  type JsonValue,
  type QSpecPlugin,
  type QueryLanguage,
  type RawColumn,
  type RawQueryResult,
} from "@qspecs/core";

export interface MemoryTable {
  /** Bare names, or full descriptors when a nativeType matters. */
  readonly columns: readonly (string | RawColumn)[];
  /** Positional rows, matching the RawQueryResult contract. */
  readonly rows: readonly (readonly unknown[])[];
  /**
   * Resolve after this many milliseconds instead of immediately, so tests can
   * abort while the source is genuinely in flight.
   */
  readonly delayMs?: number;
}

export interface MemoryOptions {
  readonly tables: Readonly<Record<string, MemoryTable>>;
}

/** One recorded execution, for assertions. */
export interface MemoryCall {
  readonly source: string;
  readonly statement: unknown;
  readonly bindings: Record<string, JsonValue>;
}

export interface MemoryPlugin extends QSpecPlugin {
  /** Executions so far, in order. */
  readonly calls: readonly MemoryCall[];
}

/** What the pass-through language hands to the source. */
interface CompiledMemoryQuery {
  readonly source: string;
  readonly statement: unknown;
  readonly bindings: Record<string, JsonValue>;
}

function toColumns(columns: readonly (string | RawColumn)[]): readonly RawColumn[] {
  return columns.map((column) => (typeof column === "string" ? { name: column } : column));
}

/**
 * An in-memory data source plus a pass-through query language, for exercising
 * the full pipeline without a database.
 *
 * Each entry in `tables` is registered BOTH as a data source of that name and
 * as a table the statement can select, so a manifest's `query.source` and
 * `query.statement` are the same string. That is a deliberate simplification
 * for a test double: a real adapter separates connection from table, but a
 * nested `{ sources: { analytics: { tables: { orders } } } }` shape would add a
 * level of indirection every test fixture then has to carry.
 *
 * Bindings are recorded but not applied — filtering belongs to the transform
 * pipeline, and a source that silently filtered would make the transform tests
 * in later tasks prove nothing about the transforms.
 */
export function memory(options: MemoryOptions): MemoryPlugin {
  const calls: MemoryCall[] = [];

  const language: QueryLanguage<unknown, CompiledMemoryQuery> = {
    compile: (query, context) => ({
      source: context.source,
      statement: query.statement,
      bindings: context.bindings,
    }),
  };

  const createSource = (sourceName: string): DataSource<CompiledMemoryQuery> => ({
    async execute(query, context: DataSourceContext): Promise<RawQueryResult> {
      calls.push({ source: sourceName, statement: query.statement, bindings: query.bindings });

      const name = typeof query.statement === "string" ? query.statement : "";
      const table = Object.hasOwn(options.tables, name) ? options.tables[name] : undefined;
      if (table === undefined) {
        throw new QueryExecutionError(
          `Memory source "${sourceName}" has no table named "${name}". ` +
            `Configured tables: ${Object.keys(options.tables).join(", ") || "(none)"}.`,
        );
      }

      if (table.delayMs !== undefined) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, table.delayMs);
          context.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(new QSpecAbortError("Memory source aborted.", { cause: context.signal?.reason }));
            },
            { once: true },
          );
        });
      }

      if (context.signal?.aborted === true) {
        throw new QSpecAbortError("Memory source aborted.", { cause: context.signal.reason });
      }

      // Rows are copied so a downstream mutation cannot corrupt the fixture and
      // silently change what a later assertion sees.
      return { columns: toColumns(table.columns), rows: table.rows.map((row) => [...row]) };
    },
  });

  const plugin = definePlugin({
    name: "@qspecs/testing/memory",
    setup(api) {
      api.queryLanguages.register("memory", language as QueryLanguage);
      for (const sourceName of Object.keys(options.tables)) {
        api.sources.register(sourceName, createSource(sourceName) as DataSource);
      }
    },
  });

  return { ...plugin, calls };
}
```

Note the two `as` casts on registration: the registries are `Registry<QueryLanguage>` and
`Registry<DataSource>` with their default `unknown` type arguments, so a concretely-typed
implementation needs widening. These narrow a specific type to its general form, which is
sound — they are not stripping `undefined` from an indexed access. If you can register
without them, do.

`packages/testing/src/index.ts`:

```ts
export {
  memory,
  type MemoryCall,
  type MemoryOptions,
  type MemoryPlugin,
  type MemoryTable,
} from "./memory.js";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm install && npm run build && npx vitest run packages/testing`
Expected: PASS, 6 tests.

- [ ] **Step 6: Verify the whole repo is still green**

Run: `npm run build && npm run typecheck:tests && npx vitest run`
Expected: all green, all 388 prior tests passing.

- [ ] **Step 7: Commit**

```bash
git add -A packages/testing tsconfig.json package-lock.json
git commit -m "feat(testing): add private test-support package with in-memory data source"
```

---

### Task 2: Export the expression subsystem from `@qspecs/core`

`@qspecs/transforms` cannot reach `packages/core/src/internal/`. This task promotes the
expression API to core's public surface — the step the foundation plan deliberately deferred
until a consumer existed.

**Files:**
- Create: `packages/core/src/expressions.ts` (the public wrapper)
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/expressions.test.ts`

**Interfaces:**
- Consumes: `normalizeExpression`, `evaluateExpression`, `EvaluationScope` from `internal/expression/`.
- Produces: public `normalizeExpression(input, options)`, `evaluateExpression(expression, scope)`, types `Expression`, `ComparisonShorthand`, `EvaluationScope`, `NormalizeExpressionOptions`.

- [ ] **Step 1: Write the failing test**

`packages/core/src/expressions.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { LimitExceededError, ManifestValidationError } from "./errors.js";
import { evaluateExpression, normalizeExpression } from "./expressions.js";

describe("public expression API", () => {
  it("normalizes the AST form", () => {
    expect(
      normalizeExpression({ operator: "gt", arguments: [{ field: "r" }, { literal: 0 }] }, {
        maxDepth: 32,
      }),
    ).toEqual({ operator: "gt", arguments: [{ field: "r" }, { literal: 0 }] });
  });

  it("expands the comparison shorthand", () => {
    expect(normalizeExpression({ field: "r", operator: "gt", value: 0 }, { maxDepth: 32 })).toEqual({
      operator: "gt",
      arguments: [{ field: "r" }, { literal: 0 }],
    });
  });

  it("reports issue paths relative to the supplied path", () => {
    try {
      normalizeExpression({ operator: "nope", arguments: [] }, { maxDepth: 32, path: ["where"] });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ManifestValidationError);
      expect((error as ManifestValidationError).issues[0]?.path).toEqual(["where", "operator"]);
    }
  });

  it("defaults the path to empty when none is given", () => {
    try {
      normalizeExpression({ operator: "nope", arguments: [] }, { maxDepth: 32 });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as ManifestValidationError).issues[0]?.path).toEqual(["operator"]);
    }
  });

  it("enforces maxDepth", () => {
    let nested: unknown = { field: "a" };
    for (let i = 0; i < 6; i += 1) nested = { operator: "not", arguments: [nested] };
    expect(() => normalizeExpression(nested, { maxDepth: 3 })).toThrow(LimitExceededError);
    // The same structure must SUCCEED at a higher limit. Without this half, the
    // test cannot distinguish "forwards options.maxDepth" from "ignores it and
    // hardcodes a small constant".
    expect(() => normalizeExpression(nested, { maxDepth: 32 })).not.toThrow();
  });

  it("evaluates against a row and parameters", () => {
    const row: Record<string, unknown> = Object.create(null);
    Object.defineProperty(row, "revenue", { value: 10, enumerable: true });
    const expression = normalizeExpression(
      { operator: "gt", arguments: [{ field: "revenue" }, { parameter: "floor" }] },
      { maxDepth: 32 },
    );
    expect(evaluateExpression(expression, { row, parameters: { floor: 5 } })).toBe(true);
    expect(evaluateExpression(expression, { row, parameters: { floor: 50 } })).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/core/src/expressions.test.ts`
Expected: FAIL — cannot resolve `./expressions.js`.

- [ ] **Step 3: Implement the public wrapper**

`packages/core/src/expressions.ts`:

```ts
import type { PathSegment } from "./errors.js";
import { normalizeExpression as normalizeInternal } from "./internal/expression/normalize.js";
import type { Expression } from "./types/expression.js";

export type { ComparisonShorthand, Expression } from "./types/expression.js";
export { evaluateExpression, type EvaluationScope } from "./internal/expression/evaluate.js";

export interface NormalizeExpressionOptions {
  /**
   * Maximum nesting depth. Plugins should pass `api.limits.maxExpressionDepth`,
   * captured at setup — that is how SPEC.md §72.5's limit reaches the code that
   * can enforce it.
   */
  readonly maxDepth: number;
  /**
   * Prefix for issue paths, so a transform can report against its own location
   * in the manifest. Defaults to empty.
   */
  readonly path?: readonly PathSegment[];
}

/**
 * Validates and canonicalizes an expression: expands the comparison shorthand,
 * rejects unknown operators and wrong arity, and enforces the depth limit.
 *
 * The internal implementation carries a fourth `depth` recursion parameter;
 * it is deliberately not part of this signature.
 */
export function normalizeExpression(
  input: unknown,
  options: NormalizeExpressionOptions,
): Expression {
  return normalizeInternal(input, options.path ?? [], options.maxDepth);
}
```

- [ ] **Step 4: Export from the public surface**

In `packages/core/src/index.ts`, replace the block explaining why expressions are not
exported with the export itself, keeping a note about why it exists:

```ts
// The expression subsystem is public because plugins outside this package need
// it: @qspecs/transforms' `filter` and `derive` both compile and evaluate
// expressions, and cannot reach src/internal/. `maxDepth` is a required option
// rather than a default so a caller cannot silently bypass SPEC.md §72.5's
// limit — plugins pass `api.limits.maxExpressionDepth`.
export {
  evaluateExpression,
  normalizeExpression,
  type ComparisonShorthand,
  type EvaluationScope,
  type Expression,
  type NormalizeExpressionOptions,
} from "./expressions.js";
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run packages/core && npm run build`
Expected: PASS — 6 new tests plus all prior core tests.

- [ ] **Step 6: Update the known-gaps document**

`docs/known-gaps.md`'s blocking item 1 said `maxExpressionDepth` was unenforceable because
the subsystem had no caller. Half of that is now resolved: the API is public and takes a
required `maxDepth`. Amend the entry to state that the remaining work is for the `filter`
and `derive` transforms to pass `api.limits.maxExpressionDepth`, and that Task 3 of this plan
does it. Do not delete the entry until Task 8 lands.

- [ ] **Step 7: Commit**

```bash
git add -A packages/core docs/known-gaps.md
git commit -m "feat(core): expose the expression API now that a consumer exists"
```

---

### Task 3: `@qspecs/transforms` scaffolding and the `filter` transform

Delivers the package plus the hardest transform. `filter` is first because it wires up the
expression subsystem, which `derive` reuses.

**Files:**
- Create: `packages/transforms/package.json`, `packages/transforms/tsconfig.build.json`
- Create: `packages/transforms/src/index.ts`, `src/internal/rows.ts`, `src/internal/issues.ts`, `src/internal/filter.ts`
- Test: `packages/transforms/src/internal/filter.test.ts`
- Modify: root `tsconfig.json`

**Interfaces:**
- Consumes: `normalizeExpression`, `evaluateExpression`, `Expression`, `Dataset`, `DatasetRow`, `Field`, `Transform`, `TransformContext`, `QSpecIssue`, `PathSegment` from `@qspecs/core`.
- Produces: `createFilterTransform(maxExpressionDepth: number): Transform<FilterSpec>`, type `FilterSpec`; helpers `emptyRow()`, `setCell()`, `issue()`.

- [ ] **Step 1: Create the package**

`packages/transforms/package.json`:

```json
{
  "name": "@qspecs/transforms",
  "version": "0.1.0",
  "description": "Standard declarative transformations for QSpec datasets",
  "type": "module",
  "license": "MIT",
  "sideEffects": false,
  "engines": { "node": ">=20.11" },
  "files": ["dist"],
  "publishConfig": { "access": "public" },
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
    "./package.json": "./package.json"
  },
  "peerDependencies": { "@qspecs/core": "0.1.0" },
  "devDependencies": { "@qspecs/core": "0.1.0" },
  "scripts": { "build": "tsc -p tsconfig.build.json" }
}
```

`@qspecs/core` is a **peer** dependency (the consumer supplies it, and two copies of the
registry would be a disaster) and also a devDependency so the workspace links it for
building and testing. Add the tsconfig reference to the root `tsconfig.json`.

`packages/transforms/tsconfig.build.json` mirrors `packages/testing/tsconfig.build.json`.

- [ ] **Step 2: Write the shared internals**

`packages/transforms/src/internal/rows.ts`:

```ts
import type { DatasetRow } from "@qspecs/core";

/**
 * Dataset rows are null-prototype objects so a column named `constructor` or
 * `__proto__` is safe to hold. Every row this package creates must follow that
 * discipline — a plain `{}` would reintroduce the prototype hazard core went to
 * some trouble to remove.
 */
export function emptyRow(): DatasetRow {
  return Object.create(null) as DatasetRow;
}

export function setCell(row: DatasetRow, key: string, value: unknown): void {
  Object.defineProperty(row, key, { value, writable: true, enumerable: true, configurable: true });
}
```

`packages/transforms/src/internal/issues.ts`:

```ts
import type { PathSegment, QSpecIssue } from "@qspecs/core";

/**
 * Transform validation issues use the code core uses for manifest defects, and
 * paths RELATIVE to this transform's entry in `spec.transforms` — core prefixes
 * the absolute location.
 */
export function issue(message: string, path: readonly PathSegment[], suggestion?: string): QSpecIssue {
  return {
    code: "QSPEC_MANIFEST_INVALID",
    message,
    path,
    ...(suggestion === undefined ? {} : { suggestion }),
  };
}

/** Nearest match among `candidates`, for did-you-mean hints on field names. */
export function closest(input: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const candidate of [...candidates].sort()) {
    const score = distance(input.toLowerCase(), candidate.toLowerCase());
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  const threshold = Math.max(1, Math.floor(input.length / 3) + 1);
  return bestScore <= threshold ? best : undefined;
}

function distance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  let current = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(substitution, (previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1);
    }
    [previous, current] = [current, previous];
  }
  return previous[b.length] ?? 0;
}
```

Note: `closest` duplicates core's internal `suggest`. That is deliberate — core does not
export it, and adding a public export purely for this would widen core's surface for a
helper. Record it in `docs/known-gaps.md` at Task 11 as a candidate for promotion if a third
consumer appears.

- [ ] **Step 3: Write the failing test**

`packages/transforms/src/internal/filter.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { Dataset, Field } from "@qspecs/core";
import { createFilterTransform } from "./filter.js";
import { emptyRow, setCell } from "./rows.js";

const fields: Field[] = [
  { name: "month", type: "datetime" },
  { name: "revenue", type: "number" },
];

function dataset(rows: Record<string, unknown>[]): Dataset {
  return {
    fields,
    rows: rows.map((source) => {
      const row = emptyRow();
      for (const [key, value] of Object.entries(source)) setCell(row, key, value);
      return row;
    }),
  };
}

const context = { executionId: "test", parameters: {} as Record<string, never> };
const filter = createFilterTransform(32);

const data = dataset([
  { month: "2026-01", revenue: 10 },
  { month: "2026-02", revenue: 0 },
  { month: "2026-03", revenue: 25 },
]);

describe("filter.execute", () => {
  it("keeps rows the expression accepts", async () => {
    const out = await filter.execute(
      data,
      { where: { operator: "gt", arguments: [{ field: "revenue" }, { literal: 0 }] } },
      context,
    );
    expect(out.rows.map((r) => r["revenue"])).toEqual([10, 25]);
  });

  it("accepts the comparison shorthand", async () => {
    const out = await filter.execute(data, { where: { field: "revenue", operator: "gt", value: 0 } }, context);
    expect(out.rows).toHaveLength(2);
  });

  it("resolves parameters inside the expression", async () => {
    const out = await filter.execute(
      data,
      { where: { operator: "gte", arguments: [{ field: "revenue" }, { parameter: "floor" }] } },
      { ...context, parameters: { floor: 25 } },
    );
    expect(out.rows).toHaveLength(1);
  });

  it("does not mutate the input dataset", async () => {
    const before = data.rows.length;
    await filter.execute(data, { where: { field: "revenue", operator: "gt", value: 0 } }, context);
    expect(data.rows).toHaveLength(before);
  });

  it("preserves fields unchanged", async () => {
    const out = await filter.execute(data, { where: { literal: true } }, context);
    expect(out.fields).toEqual(fields);
  });

  it("keeps rows null-prototype", async () => {
    const out = await filter.execute(data, { where: { literal: true } }, context);
    expect(Object.getPrototypeOf(out.rows[0])).toBeNull();
  });
});

describe("filter.describe", () => {
  it("passes fields through unchanged — filtering changes rows, not schema", () => {
    expect(filter.describe?.(fields, { where: { literal: true } })).toEqual(fields);
  });
});

describe("filter.validate", () => {
  it("accepts a well-formed expression", () => {
    expect(filter.validate?.({ where: { field: "revenue", operator: "gt", value: 0 } }, fields)).toEqual([]);
  });

  it("rejects a missing where clause", () => {
    const issues = filter.validate?.({} as never, fields) ?? [];
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toEqual(["where"]);
  });

  it("rejects an unknown operator, with the path relative to the transform", () => {
    const issues = filter.validate?.({ where: { operator: "gte_", arguments: [{ field: "revenue" }, { literal: 0 }] } }, fields) ?? [];
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toEqual(["where", "operator"]);
    expect(issues[0]?.suggestion).toBe("gte");
  });

  it("rejects a reference to a field that will not exist, with a suggestion", () => {
    const issues = filter.validate?.({ where: { field: "reveneu", operator: "gt", value: 0 } }, fields) ?? [];
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toMatch(/reveneu/);
    expect(issues[0]?.suggestion).toBe("revenue");
  });

  it("skips the field check when the projected schema is unknown", () => {
    expect(filter.validate?.({ where: { field: "anything", operator: "gt", value: 0 } }, undefined)).toEqual([]);
  });

  it("enforces the expression depth limit it was constructed with", () => {
    const shallow = createFilterTransform(2);
    let nested: unknown = { field: "revenue" };
    for (let i = 0; i < 5; i += 1) nested = { operator: "not", arguments: [nested] };
    const issues = shallow.validate?.({ where: nested }, fields) ?? [];
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toMatch(/depth/i);
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx vitest run packages/transforms`
Expected: FAIL — cannot resolve `./filter.js`.

- [ ] **Step 5: Implement `filter`**

`packages/transforms/src/internal/filter.ts`:

```ts
import {
  LimitExceededError,
  ManifestValidationError,
  evaluateExpression,
  normalizeExpression,
  type Dataset,
  type Expression,
  type Field,
  type QSpecIssue,
  type Transform,
} from "@qspecs/core";
import { closest, issue } from "./issues.js";

export interface FilterSpec {
  /** An expression, or the `{ field, operator, value }` comparison shorthand. */
  readonly where: unknown;
}

/** Every `{ field: "..." }` node reachable in a normalized expression. */
function referencedFields(expression: Expression, into: Set<string>): void {
  if ("field" in expression) {
    into.add(expression.field);
    return;
  }
  if ("operator" in expression) {
    for (const argument of expression.arguments) referencedFields(argument, into);
  }
}

/**
 * `maxExpressionDepth` is injected rather than read from a global, because it is
 * runtime configuration: the plugin captures `api.limits.maxExpressionDepth` at
 * setup and passes it here. That is how SPEC.md §72.5's limit reaches the only
 * code that can enforce it.
 */
export function createFilterTransform(maxExpressionDepth: number): Transform<FilterSpec> {
  const compile = (spec: FilterSpec): Expression =>
    normalizeExpression(spec.where, { maxDepth: maxExpressionDepth, path: ["where"] });

  return {
    execute(dataset: Dataset, spec: FilterSpec, context): Dataset {
      // Compiled once per execution, not per row.
      const expression = compile(spec);
      const rows = dataset.rows.filter((row) =>
        Boolean(evaluateExpression(expression, { row, parameters: context.parameters })),
      );
      return { ...dataset, rows };
    },

    describe(fields: readonly Field[]): readonly Field[] {
      // Filtering removes rows, never columns.
      return fields;
    },

    validate(spec: FilterSpec, fields: readonly Field[] | undefined): readonly QSpecIssue[] {
      if (spec === null || typeof spec !== "object" || !("where" in spec) || spec.where === undefined) {
        return [issue("`filter` requires a `where` expression.", ["where"])];
      }

      let expression: Expression;
      try {
        expression = compile(spec);
      } catch (error) {
        // normalizeExpression reports precise paths already; surface them
        // rather than flattening to a single message.
        if (error instanceof LimitExceededError) {
          return [issue(error.message, ["where"])];
        }
        // ManifestValidationError already types `issues` as readonly QSpecIssue[],
        // so narrowing on the class avoids the double cast an ad-hoc structural
        // check would need.
        if (error instanceof ManifestValidationError) {
          return error.issues;
        }
        return [issue(error instanceof Error ? error.message : String(error), ["where"])];
      }

      if (fields === undefined) return [];

      const known = fields.map((field) => field.name);
      const knownSet = new Set(known);
      const referenced = new Set<string>();
      referencedFields(expression, referenced);

      return [...referenced]
        .filter((name) => !knownSet.has(name))
        .map((name) =>
          issue(
            `Unknown dataset field "${name}". Available fields: ${known.join(", ") || "(none)"}.`,
            ["where"],
            closest(name, known),
          ),
        );
    },
  };
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm install && npm run build && npx vitest run packages/transforms`
Expected: PASS, 14 tests.

- [ ] **Step 7: Falsify the depth-limit test**

The depth test is the only proof that `maxExpressionDepth` is enforced — the gap
`docs/known-gaps.md` records as blocking. Temporarily change `createFilterTransform` to pass
a hardcoded `32` instead of its parameter, confirm the test FAILS, then restore it. Report
the outcome.

- [ ] **Step 8: Commit**

```bash
git add -A packages/transforms tsconfig.json package-lock.json
git commit -m "feat(transforms): add package scaffolding and the filter transform"
```

---

### Task 4: `sort` and `limit`

Two row-ordering/row-count transforms. Both are schema-preserving, so their `describe` is the
identity — but they must still declare it, or they become schema-opaque and silently disable
static presentation validation for everything downstream.

**Files:**
- Create: `packages/transforms/src/internal/sort.ts`, `src/internal/limit.ts`
- Test: `packages/transforms/src/internal/sort.test.ts`, `src/internal/limit.test.ts`

**Interfaces:**
- Produces: `sortTransform: Transform<SortSpec>`, `limitTransform: Transform<LimitSpec>`; types `SortSpec` (`{ field: string; direction?: "asc" | "desc" }`), `LimitSpec` (`{ count: number; offset?: number }`).

Single-key sort only. SPEC.md §40 shows exactly that shape, and a later `by: [...]` array
would be an additive change. Do not add multi-key now.

- [ ] **Step 1: Write the failing tests**

`sort.test.ts` must cover: ascending by default; explicit `desc`; numbers, strings, and
booleans each ordered within their own type; **nulls sort last in both directions** (they are
absent data, not a smallest value — assert this explicitly, it is the decision most likely to
be silently changed). The comparator has TWO null branches (`isNullish(a)` and `isNullish(b)`),
and a single input ordering exercises only one of them: test the null in **first, middle, and
last** position under each direction, or a mutation of the untested branch survives. This was
found the hard way — the first two formulations each left one branch unguarded; stability for equal keys (assert two rows with the same key keep their
relative order); input dataset unmutated; rows stay null-prototype; `describe` returns fields
unchanged. Validation: non-string `field`; `direction` other than `asc`/`desc`; a field that
will not exist, with a suggestion; skip the field check when `fields` is `undefined`.

`limit.test.ts` must cover: `count` truncates; `count` larger than the row set is a no-op;
`count: 0` yields no rows; `offset` skips from the start; `offset` beyond the end yields no
rows; `offset` without `count` is rejected at validation (it is a slice, not a cursor);
`describe` unchanged. Validation: `count` must be a non-negative integer — reject `-1`,
`1.5`, `"10"`, and `NaN`; same for `offset` when present.

- [ ] **Step 2: Implement `sort`**

`packages/transforms/src/internal/sort.ts`:

```ts
import type { Dataset, Field, QSpecIssue, Transform } from "@qspecs/core";
import { closest, issue } from "./issues.js";

export interface SortSpec {
  readonly field: string;
  readonly direction?: "asc" | "desc";
}

function isNullish(value: unknown): boolean {
  return value === null || value === undefined;
}

/**
 * Returns a comparison for two same-typed values, or undefined when they are
 * not comparable. Mirrors the expression evaluator's rules so `sort` and
 * `filter` cannot disagree about ordering.
 */
function compare(a: unknown, b: unknown): number | undefined {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  return undefined;
}

export const sortTransform: Transform<SortSpec> = {
  execute(dataset: Dataset, spec: SortSpec): Dataset {
    const descending = spec.direction === "desc";
    // Indexed decorate-sort-undecorate keeps equal keys in their original
    // order. Array.prototype.sort is specified as stable, but the index
    // tiebreak also keeps nulls-last stable, which the null branch below needs.
    const decorated = dataset.rows.map((row, index) => ({ row, index }));

    decorated.sort((left, right) => {
      const a = left.row[spec.field];
      const b = right.row[spec.field];

      // Nulls sort last in BOTH directions: they are absent data, not an
      // extreme value. Reversing them under `desc` would put "no data" first.
      if (isNullish(a) && isNullish(b)) return left.index - right.index;
      if (isNullish(a)) return 1;
      if (isNullish(b)) return -1;

      const result = compare(a, b);
      if (result === undefined || result === 0) return left.index - right.index;
      return descending ? -result : result;
    });

    return { ...dataset, rows: decorated.map((entry) => entry.row) };
  },

  describe(fields: readonly Field[]): readonly Field[] {
    return fields;
  },

  validate(spec: SortSpec, fields: readonly Field[] | undefined): readonly QSpecIssue[] {
    const issues: QSpecIssue[] = [];
    if (typeof spec?.field !== "string" || spec.field === "") {
      issues.push(issue("`sort` requires a non-empty `field`.", ["field"]));
    }
    if (spec?.direction !== undefined && spec.direction !== "asc" && spec.direction !== "desc") {
      issues.push(issue('`sort.direction` must be "asc" or "desc".', ["direction"]));
    }
    if (issues.length === 0 && fields !== undefined) {
      const known = fields.map((field) => field.name);
      if (!known.includes(spec.field)) {
        issues.push(
          issue(
            `Unknown dataset field "${spec.field}". Available fields: ${known.join(", ") || "(none)"}.`,
            ["field"],
            closest(spec.field, known),
          ),
        );
      }
    }
    return issues;
  },
};
```

- [ ] **Step 3: Implement `limit`**

`packages/transforms/src/internal/limit.ts`:

```ts
import type { Dataset, Field, QSpecIssue, Transform } from "@qspecs/core";
import { issue } from "./issues.js";

export interface LimitSpec {
  readonly count: number;
  /** Rows to skip first. A slice offset, not a cursor. */
  readonly offset?: number;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export const limitTransform: Transform<LimitSpec> = {
  execute(dataset: Dataset, spec: LimitSpec): Dataset {
    const offset = spec.offset ?? 0;
    return { ...dataset, rows: dataset.rows.slice(offset, offset + spec.count) };
  },

  describe(fields: readonly Field[]): readonly Field[] {
    return fields;
  },

  validate(spec: LimitSpec): readonly QSpecIssue[] {
    const issues: QSpecIssue[] = [];
    if (!isNonNegativeInteger(spec?.count)) {
      issues.push(issue("`limit.count` must be a non-negative integer.", ["count"]));
    }
    if (spec?.offset !== undefined && !isNonNegativeInteger(spec.offset)) {
      issues.push(issue("`limit.offset` must be a non-negative integer.", ["offset"]));
    }
    return issues;
  },
};
```

- [ ] **Step 4: Verify and commit**

```bash
npm run build && npx vitest run packages/transforms
git add -A packages/transforms
git commit -m "feat(transforms): add sort and limit"
```

Before committing, falsify the nulls-last test: change `if (isNullish(a)) return 1;` to
`return descending ? -1 : 1;` and confirm the descending null test fails. Report the outcome.

---

### Task 5: `select` and `rename`

The two schema-changing transforms. Their `describe` implementations are what make static
presentation validation work across a rename — the case the foundation plan's design document
uses to justify `describe` existing at all.

**Files:**
- Create: `packages/transforms/src/internal/select.ts`, `src/internal/rename.ts`
- Test: `packages/transforms/src/internal/select.test.ts`, `src/internal/rename.test.ts`

**Interfaces:**
- Produces: `selectTransform: Transform<SelectSpec>`, `renameTransform: Transform<RenameSpec>`; types `SelectSpec` (`{ fields: readonly string[] }`), `RenameSpec` (`{ fields: Readonly<Record<string, string>> }`).

`rename` takes a map so several columns can be renamed in one step; a single rename is
`{ "old": "new" }`.

- [ ] **Step 1: Write the failing tests**

`select.test.ts`: keeps only the named fields; **preserves the order given in the spec, not
the dataset's order** (assert with a spec that reverses them); drops unlisted fields from both
`fields` and every row; rows stay null-prototype; input unmutated; `describe` returns the
projected fields in spec order. Validation: `fields` must be a non-empty array of strings;
each must exist when `fields` is known, with a suggestion; duplicates in the list are
rejected; skip the existence check when the schema is unknown.

`rename.test.ts`: renames one field; renames several at once; leaves unlisted fields alone;
**a field named `constructor` that is NOT in the mapping keeps its name** (bare bracket
access would read `Object.prototype.constructor` and rename it to a function — this codebase
supports prototype-shaped column names everywhere else, so it must here too);
**preserves the original field order** (a rename is not a reorder — assert it); `describe`
maps names identically to what `execute` produces (assert both against the same fixture, since
a divergence here is exactly the bug `describe` exists to prevent). Validation: `fields` must
be an object of string→string; a source that will not exist is rejected with a suggestion; a
target colliding with an existing un-renamed field is rejected; two sources renaming to the
same target is rejected; skip existence checks when the schema is unknown.

- [ ] **Step 2: Implement `select`**

```ts
import type { Dataset, Field, QSpecIssue, Transform } from "@qspecs/core";
import { closest, issue } from "./issues.js";
import { emptyRow, setCell } from "./rows.js";

export interface SelectSpec {
  readonly fields: readonly string[];
}

export const selectTransform: Transform<SelectSpec> = {
  execute(dataset: Dataset, spec: SelectSpec): Dataset {
    const byName = new Map(dataset.fields.map((field) => [field.name, field]));
    // Spec order wins: `select` is a projection, and the caller listed the
    // columns in the order they want them.
    const fields = spec.fields
      .map((name) => byName.get(name))
      .filter((field): field is Field => field !== undefined);

    const rows = dataset.rows.map((row) => {
      const next = emptyRow();
      for (const field of fields) setCell(next, field.name, row[field.name]);
      return next;
    });

    return { ...dataset, fields, rows };
  },

  describe(fields: readonly Field[], spec: SelectSpec): readonly Field[] {
    const byName = new Map(fields.map((field) => [field.name, field]));
    return spec.fields
      .map((name) => byName.get(name))
      .filter((field): field is Field => field !== undefined);
  },

  validate(spec: SelectSpec, fields: readonly Field[] | undefined): readonly QSpecIssue[] {
    if (!Array.isArray(spec?.fields) || spec.fields.length === 0) {
      return [issue("`select.fields` must be a non-empty array of field names.", ["fields"])];
    }

    const issues: QSpecIssue[] = [];
    const seen = new Set<string>();
    spec.fields.forEach((name, index) => {
      if (typeof name !== "string" || name === "") {
        issues.push(issue("Each entry in `select.fields` must be a non-empty string.", ["fields", index]));
        return;
      }
      if (seen.has(name)) {
        issues.push(issue(`Field "${name}" is selected more than once.`, ["fields", index]));
      }
      seen.add(name);
    });

    if (issues.length === 0 && fields !== undefined) {
      const known = fields.map((field) => field.name);
      const knownSet = new Set(known);
      spec.fields.forEach((name, index) => {
        if (!knownSet.has(name)) {
          issues.push(
            issue(
              `Unknown dataset field "${name}". Available fields: ${known.join(", ") || "(none)"}.`,
              ["fields", index],
              closest(name, known),
            ),
          );
        }
      });
    }

    return issues;
  },
};
```

- [ ] **Step 3: Implement `rename`**

```ts
import type { Dataset, Field, QSpecIssue, Transform } from "@qspecs/core";
import { closest, issue } from "./issues.js";
import { emptyRow, setCell } from "./rows.js";

export interface RenameSpec {
  /** `{ oldName: newName }`. Unlisted fields are left alone. */
  readonly fields: Readonly<Record<string, string>>;
}

function renamed(fields: readonly Field[], mapping: Readonly<Record<string, string>>): readonly Field[] {
  // Original order preserved: a rename is not a reorder.
  return fields.map((field) => {
    // Object.hasOwn is load-bearing, not ceremony: a field legitimately named
    // `constructor` or `toString` reads a FUNCTION off Object.prototype through
    // bare bracket access, so `mapping[name] ?? name` would treat an unrenamed
    // field as renamed and set its name to a function. Binding after the
    // hasOwn check also avoids casting away the `undefined` that
    // noUncheckedIndexedAccess correctly surfaces.
    const target = Object.hasOwn(mapping, field.name) ? mapping[field.name] : undefined;
    return target === undefined ? field : { ...field, name: target };
  });
}

export const renameTransform: Transform<RenameSpec> = {
  execute(dataset: Dataset, spec: RenameSpec): Dataset {
    const fields = renamed(dataset.fields, spec.fields);
    const rows = dataset.rows.map((row) => {
      const next = emptyRow();
      for (const field of dataset.fields) {
        // Same hazard as renamed(): bare bracket access on a field named
        // `constructor` returns Object.prototype.constructor, not undefined.
        const mapped = Object.hasOwn(spec.fields, field.name)
          ? spec.fields[field.name]
          : undefined;
        setCell(next, mapped ?? field.name, row[field.name]);
      }
      return next;
    });
    return { ...dataset, fields, rows };
  },

  describe(fields: readonly Field[], spec: RenameSpec): readonly Field[] {
    return renamed(fields, spec.fields);
  },

  validate(spec: RenameSpec, fields: readonly Field[] | undefined): readonly QSpecIssue[] {
    if (spec?.fields === null || typeof spec?.fields !== "object" || Array.isArray(spec.fields)) {
      return [issue("`rename.fields` must be an object mapping old names to new names.", ["fields"])];
    }

    const issues: QSpecIssue[] = [];
    const entries = Object.entries(spec.fields);

    for (const [from, to] of entries) {
      if (typeof to !== "string" || to === "") {
        issues.push(issue(`Rename target for "${from}" must be a non-empty string.`, ["fields", from]));
      }
    }

    const targets = new Map<string, string>();
    for (const [from, to] of entries) {
      const existing = targets.get(to);
      if (existing !== undefined) {
        issues.push(
          issue(`"${existing}" and "${from}" both rename to "${to}".`, ["fields", from]),
        );
      }
      targets.set(to, from);
    }

    if (fields !== undefined) {
      const known = fields.map((field) => field.name);
      const knownSet = new Set(known);
      const renamedAway = new Set(entries.map(([from]) => from));

      for (const [from, to] of entries) {
        if (!knownSet.has(from)) {
          issues.push(
            issue(
              `Unknown dataset field "${from}". Available fields: ${known.join(", ") || "(none)"}.`,
              ["fields", from],
              closest(from, known),
            ),
          );
        }
        // Colliding with a field that is itself being renamed away is fine.
        if (knownSet.has(to) && !renamedAway.has(to)) {
          issues.push(
            issue(`Renaming "${from}" to "${to}" would collide with an existing field.`, ["fields", from]),
          );
        }
      }
    }

    return issues;
  },
};
```

- [ ] **Step 4: Verify, falsify, commit**

Falsify the `describe`/`execute` agreement test: change `describe` to return `fields`
unchanged, and confirm the rename test fails. That agreement is the entire contract.

```bash
npm run build && npx vitest run packages/transforms
git add -A packages/transforms
git commit -m "feat(transforms): add select and rename with schema projection"
```

---

### Task 6: `derive`

Adds a computed field from an expression. Reuses Task 3's expression wiring; drop this task
entirely if derived fields are deferred to v1.1 per SPEC.md §99.

**Files:**
- Create: `packages/transforms/src/internal/derive.ts`
- Test: `packages/transforms/src/internal/derive.test.ts`

**Interfaces:**
- Produces: `createDeriveTransform(maxExpressionDepth: number): Transform<DeriveSpec>`; type `DeriveSpec` (`{ field: string; fieldType?: FieldType; expression: unknown }`).

Note `fieldType`, not `type` — `type` is already the transform discriminator in
`spec.transforms[]`, so a field-type key called `type` would collide.

- [ ] **Step 1: Write the failing test**

Cover: appends a computed field with the declared `fieldType`; defaults `fieldType` to
`"number"` when omitted **only if** you decide that is right — otherwise require it and test
the rejection (make the call, state it in a comment, and test whichever you chose); the new
field appears last in `describe` output and in every row; existing fields are untouched;
arithmetic on a null operand yields null and the field is marked `nullable`; overwriting an
existing field name is rejected at validation; rows stay null-prototype; input unmutated.

Validation must also cover: missing `field`; missing `expression`; an expression referencing a
field that will not exist; the depth limit, using a `createDeriveTransform(2)` instance.

**`fieldType` must be validated for enum membership, and against core's authoritative list.**
Nothing downstream catches an invalid one: `assertValidManifest` enforces `FIELD_TYPES` only
for `spec.dataset.fields` (the raw query result), `validatePresentation` checks names not
types, and `validateDataset` only visits fields declared in `spec.dataset` — which a derived
field need not appear in. So `fieldType: "uuid"` would flow into `projectedFields` and into
the executed `Dataset` unchecked.

Do NOT hand-write the eight names here. Export `FIELD_TYPES: readonly FieldType[]` from
`@qspecs/core`, have core's internal validator derive its lookup Set from that same constant,
and import it. A second copy would drift the moment core adds a type — core accepting it and
`derive` rejecting it, with a baffling error.

- [ ] **Step 2: Implement**

Follow `filter`'s structure: a `createDeriveTransform(maxExpressionDepth)` factory that
compiles once per execution and evaluates per row via `evaluateExpression`, writing the result
with `setCell`. `describe` appends `{ name: spec.field, type: spec.fieldType ?? <your default>, nullable: true }`
— `nullable: true` because any expression can evaluate to null, and claiming otherwise would
feed core's dataset validator a promise this transform cannot keep.

Reuse `filter`'s `referencedFields` helper rather than copying it; move it into
`internal/issues.ts` or a new `internal/expressions.ts` shared by both.

- [ ] **Step 3: Verify and commit**

```bash
npm run build && npx vitest run packages/transforms
git add -A packages/transforms
git commit -m "feat(transforms): add derive"
```

---

### Task 7: The `transforms()` plugin and the transform contract suite

Wires the six transforms into a plugin and delivers the reusable contract suite SPEC.md §89
requires — the thing that keeps this repository's transforms honest. (`@qspecs/testing` is
`"private": true`, so the suite is not importable from outside this repo; publishing it is a
Plan 5 packaging decision, recorded in `docs/known-gaps.md`.)

**Files:**
- Create: `packages/transforms/src/index.ts`
- Create: `packages/testing/src/contracts/transform.ts`; modify `packages/testing/src/index.ts`
- Test: `packages/transforms/src/index.test.ts`

**Interfaces:**
- Produces: `transforms(): QSpecPlugin`; re-exported spec types (`FilterSpec`, `SortSpec`, `LimitSpec`, `SelectSpec`, `RenameSpec`, `DeriveSpec`); `runTransformContractTests(name, transform, fixture)`.

- [ ] **Step 1: Implement the plugin**

```ts
import { definePlugin, type QSpecPlugin, type Transform } from "@qspecs/core";
import { createFilterTransform } from "./internal/filter.js";
import { createDeriveTransform } from "./internal/derive.js";
import { limitTransform } from "./internal/limit.js";
import { renameTransform } from "./internal/rename.js";
import { selectTransform } from "./internal/select.js";
import { sortTransform } from "./internal/sort.js";

export type { FilterSpec } from "./internal/filter.js";
export type { SortSpec } from "./internal/sort.js";
export type { LimitSpec } from "./internal/limit.js";
export type { SelectSpec } from "./internal/select.js";
export type { RenameSpec } from "./internal/rename.js";
export type { DeriveSpec } from "./internal/derive.js";

/**
 * Registers the standard transforms. Expression-based transforms are built here
 * rather than at module scope because they need `api.limits.maxExpressionDepth`,
 * which is per-runtime configuration.
 */
export function transforms(): QSpecPlugin {
  return definePlugin({
    name: "@qspecs/transforms",
    setup(api) {
      api.transforms.register("filter", createFilterTransform(api.limits.maxExpressionDepth) as Transform);
      api.transforms.register("derive", createDeriveTransform(api.limits.maxExpressionDepth) as Transform);
      api.transforms.register("sort", sortTransform as Transform);
      api.transforms.register("limit", limitTransform as Transform);
      api.transforms.register("select", selectTransform as Transform);
      api.transforms.register("rename", renameTransform as Transform);
    },
  });
}
```

- [ ] **Step 2: Write the contract suite**

`packages/testing/src/contracts/transform.ts`. This runs against ANY transform in this
repository and asserts the invariants every implementation must hold, so each one is checked
with a single call:

```ts
import { describe, expect, it } from "vitest";
import type { Dataset, Transform, TransformContext } from "@qspecs/core";

export interface TransformContractFixture {
  /** A dataset the transform accepts. */
  readonly dataset: Dataset;
  /** A spec the transform accepts. */
  readonly spec: unknown;
}

const context: TransformContext = { executionId: "contract", parameters: {} };

/**
 * Invariants every Transform must satisfy, per SPEC.md §64 and the pipeline's
 * assumptions. Call this from a transform package's own test file.
 */
export function runTransformContractTests(
  name: string,
  transform: Transform<never>,
  fixture: TransformContractFixture,
): void {
  describe(`${name} — Transform contract`, () => {
    it("does not mutate the input dataset", async () => {
      const rowCount = fixture.dataset.rows.length;
      const fieldNames = fixture.dataset.fields.map((field) => field.name);
      const snapshot = fixture.dataset.rows.map((row) => ({ ...row }));

      await transform.execute(fixture.dataset, fixture.spec as never, context);

      expect(fixture.dataset.rows).toHaveLength(rowCount);
      expect(fixture.dataset.fields.map((field) => field.name)).toEqual(fieldNames);
      fixture.dataset.rows.forEach((row, index) => {
        expect({ ...row }).toEqual(snapshot[index]);
      });
    });

    it("returns rows with a null prototype", async () => {
      const result = await transform.execute(fixture.dataset, fixture.spec as never, context);
      for (const row of result.rows) {
        expect(Object.getPrototypeOf(row)).toBeNull();
      }
    });

    it("returns rows whose keys match the returned fields exactly", async () => {
      const result = await transform.execute(fixture.dataset, fixture.spec as never, context);
      const expected = [...result.fields.map((field) => field.name)].sort();
      for (const row of result.rows) {
        expect(Object.keys(row).sort()).toEqual(expected);
      }
    });

    it("declares describe(), so it does not silently disable static validation", () => {
      // A transform without describe() is schema-opaque: prepare() stops
      // projecting fields there and presentation validation is skipped for
      // everything downstream. That is legal but must be a deliberate choice.
      expect(typeof transform.describe).toBe("function");
    });

    it("describe() agrees with execute() about the resulting field names", async () => {
      const projected = transform.describe?.(fixture.dataset.fields, fixture.spec as never) ?? [];
      const result = await transform.execute(fixture.dataset, fixture.spec as never, context);
      expect(projected.map((field) => field.name)).toEqual(result.fields.map((field) => field.name));
    });

    it("validate() accepts the fixture spec", () => {
      const issues = transform.validate?.(fixture.spec as never, fixture.dataset.fields) ?? [];
      expect(issues).toEqual([]);
    });

    it("validate() reports issues rather than throwing for a malformed spec", () => {
      // Returning issues lets several problems surface at once; throwing caps
      // the report at one. Both are permitted by the interface, so this asserts
      // only that a garbage spec does not escape as an unhandled non-QSpec error.
      let threw: unknown;
      let issues: readonly unknown[] = [];
      try {
        issues = transform.validate?.({} as never, fixture.dataset.fields) ?? [];
      } catch (error) {
        threw = error;
      }
      expect(threw !== undefined || issues.length > 0).toBe(true);
    });
  });
}
```

The `describe()/execute()` agreement test is the important one: a divergence there is exactly
the bug `describe` exists to prevent, and it is invisible until a manifest renames a field and
the chart silently stops validating.

Export it from `packages/testing/src/index.ts`.

- [ ] **Step 3: Write the plugin test**

`packages/transforms/src/index.test.ts`: registers all six names; a second `transforms()` on
the same runtime throws (registry duplicate protection); the filter and derive instances
actually received the runtime's `maxExpressionDepth` — construct a `createQSpec({ limits: { maxExpressionDepth: 2 } })`,
prepare a manifest with a deeply nested filter expression, and assert it fails. That is the
end-to-end proof that SPEC.md §72.5's limit is finally enforced.

Then call `runTransformContractTests` once per transform with a suitable fixture.

- [ ] **Step 4: Verify, falsify, commit**

Falsify the limit test: change the plugin to pass a literal `32` instead of
`api.limits.maxExpressionDepth`, confirm the test fails, restore. This closes the blocking gap
recorded in `docs/known-gaps.md`.

```bash
npm run build && npm run typecheck:tests && npx vitest run
git add -A packages/transforms packages/testing
git commit -m "feat(transforms): add the transforms() plugin and transform contract suite"
```

---

### Task 8: `@qspecs/charts` scaffolding and the cartesian presentation types

`line`, `bar`, `area`, and `scatter` share one shape: an x axis plus one or more series. They
are registered as four distinct types because renderers treat them differently, but they share
a validator and a field-reference extractor.

**Files:**
- Create: `packages/charts/package.json`, `tsconfig.build.json`
- Create: `packages/charts/src/types.ts`, `src/internal/cartesian.ts`
- Test: `packages/charts/src/internal/cartesian.test.ts`
- Modify: root `tsconfig.json`

**Interfaces:**
- Produces: types `AxisSpec`, `SeriesSpec`, `GroupedSeriesSpec`, `CartesianPresentation`, `LegendSpec`, `TooltipSpec`; `cartesianPresentationType: PresentationType<CartesianPresentation>`.

- [ ] **Step 1: Define the types**

`packages/charts/src/types.ts`:

```ts
import type { PresentationDefinition } from "@qspecs/core";

export interface AxisSpec {
  readonly field: string;
  readonly label?: string;
}

export interface SeriesSpec {
  readonly field: string;
  readonly label?: string;
}

/** Series derived at render time by partitioning rows on `groupBy`. (SPEC.md §47) */
export interface GroupedSeriesSpec {
  readonly field: string;
  readonly groupBy: string;
  readonly label?: string;
}

export interface LegendSpec {
  readonly visible?: boolean;
}

export interface TooltipSpec {
  readonly visible?: boolean;
}

/**
 * Shared shape for line, bar, area, and scatter.
 *
 * Declared as a `type` alias, not an `interface`: `PresentationType<T>`
 * assignability requires `T` to carry `PresentationDefinition`'s implicit index
 * signature, and only aliases get one. An interface fails under
 * `exactOptionalPropertyTypes` with TS2375. (See docs/known-gaps.md.)
 */
export type CartesianPresentation = PresentationDefinition & {
  readonly type: "line" | "bar" | "area" | "scatter";
  readonly x: AxisSpec;
  readonly series: readonly SeriesSpec[] | GroupedSeriesSpec;
  readonly y?: { readonly label?: string };
  readonly legend?: LegendSpec;
  readonly tooltip?: TooltipSpec;
};

export function isGroupedSeries(
  series: CartesianPresentation["series"],
): series is GroupedSeriesSpec {
  return !Array.isArray(series);
}
```

The `type`-alias requirement is not cosmetic — it was found during the foundation plan's final
review and is recorded in `docs/known-gaps.md`. Writing `interface CartesianPresentation`
compiles until you try to register it, then fails with an error that does not name the cause.

- [ ] **Step 2: Write the failing test**

`cartesian.test.ts` must cover, for `validate`: a well-formed definition passes; missing `x`;
`x.field` not a string; `series` neither an array nor a grouped object; an empty series array;
a series entry missing `field`; a grouped series missing `groupBy`; issues are returned (not
thrown) and carry paths **relative to `spec.presentation`** — assert `["x", "field"]` and
`["series", 0, "field"]` exactly; several problems are reported in one call, not just the
first.

For `fieldReferences`: the x field is reported at `["x","field"]`; each array series entry at
`["series", i, "field"]`; a grouped series reports BOTH its `field` at `["series","field"]`
and its `groupBy` at `["series","groupBy"]` — the groupBy column must exist too, and forgetting
it is the likeliest bug here.

- [ ] **Step 3: Implement**

`packages/charts/src/internal/cartesian.ts` exporting `cartesianPresentationType`, using the
same `issue()` helper pattern as the transforms package (duplicate the two-line helper; do not
add a dependency between the two packages).

- [ ] **Step 4: Verify and commit**

```bash
npm install && npm run build && npx vitest run packages/charts
git add -A packages/charts tsconfig.json package-lock.json
git commit -m "feat(charts): add package scaffolding and cartesian presentation types"
```

---

### Task 9: `pie` and `resolveSeries`

`resolveSeries` is the most consequential piece of this package. SPEC.md §47 says the
*renderer* derives dynamic series — but if each renderer implemented that independently,
Recharts, ECharts, and a CLI renderer would eventually disagree about ordering, null handling,
and missing categories, and the same manifest would render differently in different hosts.
Putting the semantics here makes that impossible while keeping `@qspecs/charts` render-free.

**Files:**
- Create: `packages/charts/src/internal/pie.ts`, `src/internal/resolve-series.ts`
- Test: `packages/charts/src/internal/pie.test.ts`, `src/internal/resolve-series.test.ts`

**Interfaces:**
- Produces: `piePresentationType: PresentationType<PiePresentation>`, type `PiePresentation`; `resolveSeries(dataset, presentation): readonly ResolvedSeries[]`, types `ResolvedSeries`, `SeriesPoint`.

- [ ] **Step 1: Define the resolved shape**

Add to `packages/charts/src/types.ts`:

```ts
export interface SeriesPoint {
  readonly x: unknown;
  readonly y: unknown;
}

/** One plottable series, after any grouping has been resolved. */
export interface ResolvedSeries {
  /** Stable identity. The field name for explicit series, the group value for grouped ones. */
  readonly key: string;
  /** Display name. Falls back to `key` when no label was declared. */
  readonly label: string;
  /** The dataset field the y values came from. */
  readonly field: string;
  readonly points: readonly SeriesPoint[];
}

export type PiePresentation = PresentationDefinition & {
  readonly type: "pie";
  readonly category: AxisSpec;
  readonly value: SeriesSpec;
  readonly legend?: LegendSpec;
  readonly tooltip?: TooltipSpec;
};
```

- [ ] **Step 2: Write the failing test for `resolveSeries`**

These decisions are the contract. Test each explicitly, because a renderer author will rely on
them and a silent change would alter output everywhere:

- **Explicit array series:** one `ResolvedSeries` per entry, in spec order. `key` is the field
  name; `label` falls back to the field name when absent; every series shares the dataset's row
  order for x values.
- **Grouped series:** one series per distinct value of `groupBy`, **in first-appearance order
  in the dataset** — not sorted, not insertion-order-of-anything-else. Assert with a dataset
  whose groups appear out of alphabetical order.
- **Grouped series points** contain only the rows belonging to that group, in dataset order.
- **A nullish group value** produces a series with `key: ""` and `label: "(none)"` rather than
  being dropped. Assert this: silently discarding rows is worse than an ugly label.
- **`label` on a grouped spec** is used as a prefix or ignored — make the call, comment it, and
  test whichever you chose.
- **An empty dataset** yields an empty array for grouped series, and one empty-pointed series
  per entry for explicit series. These differ, and both are defensible; the test pins them.
- **Missing x or y values** yield `undefined` in the point rather than the row being dropped.
- The returned arrays are new objects — mutating them must not affect the dataset.

- [ ] **Step 3: Implement `resolveSeries`**

```ts
import type { Dataset } from "@qspecs/core";
import {
  isGroupedSeries,
  type CartesianPresentation,
  type ResolvedSeries,
  type SeriesPoint,
} from "../types.js";

/** Label used for rows whose grouping value is null or absent. */
export const UNGROUPED_LABEL = "(none)";

/**
 * Turns a presentation's series declaration into concrete, plottable series.
 *
 * This lives in @qspecs/charts rather than in each renderer so that Recharts,
 * ECharts, a CLI renderer, and anything else cannot disagree about ordering,
 * null handling, or missing categories. The package still renders nothing.
 * (SPEC.md §47)
 */
export function resolveSeries(
  dataset: Dataset,
  presentation: CartesianPresentation,
): readonly ResolvedSeries[] {
  const xField = presentation.x.field;

  if (!isGroupedSeries(presentation.series)) {
    return presentation.series.map((spec) => ({
      key: spec.field,
      label: spec.label ?? spec.field,
      field: spec.field,
      points: dataset.rows.map(
        (row): SeriesPoint => ({ x: row[xField], y: row[spec.field] }),
      ),
    }));
  }

  const { field, groupBy } = presentation.series;
  // Insertion order of a Map is first-appearance order in the dataset, which is
  // deterministic and matches what the data actually looks like. Sorting would
  // be a second, invisible policy decision.
  const groups = new Map<string, SeriesPoint[]>();

  for (const row of dataset.rows) {
    const raw = row[groupBy];
    const key = raw === null || raw === undefined ? "" : String(raw);
    const points = groups.get(key);
    const point: SeriesPoint = { x: row[xField], y: row[field] };
    if (points === undefined) groups.set(key, [point]);
    else points.push(point);
  }

  return [...groups.entries()].map(([key, points]) => ({
    key,
    label: key === "" ? UNGROUPED_LABEL : key,
    field,
    points,
  }));
}
```

- [ ] **Step 4: Implement `pie`**

`piePresentationType` with `validate` (require `category.field` and `value.field` as non-empty
strings; report both problems at once) and `fieldReferences` (report `["category","field"]` and
`["value","field"]`).

Test that a pie definition missing both fields yields **two** issues, not one — the
report-everything-at-once property is easy to lose.

- [ ] **Step 5: Verify and commit**

```bash
npm run build && npx vitest run packages/charts
git add -A packages/charts
git commit -m "feat(charts): add pie presentation and the shared series resolver"
```

---

### Task 10: The `Chart` resource kind and the `charts()` plugin

**Files:**
- Create: `packages/charts/src/index.ts`
- Create: `packages/testing/src/contracts/presentation.ts`; modify `packages/testing/src/index.ts`
- Test: `packages/charts/src/index.test.ts`

**Interfaces:**
- Produces: `charts(): QSpecPlugin`; `runPresentationContractTests(name, presentationType, fixture)`; re-exported chart types and `resolveSeries`.

- [ ] **Step 1: Implement the plugin**

Register five presentation types (`line`, `bar`, `area`, `scatter` all backed by
`cartesianPresentationType`; `pie` by `piePresentationType`) and the `Chart` resource kind:

```ts
      api.resources.register("Chart", {
        requiresQuery: true,
        requiresPresentation: true,
      });
```

`requiresQuery: true` because a chart with no data source cannot render anything, and failing
at `prepare()` with a clear message beats failing at execution with an empty dataset.

Re-export the public types, `resolveSeries`, and `UNGROUPED_LABEL` from `index.ts` — a
renderer needs the constant to recognise the ungrouped series rather than string-matching
"(none)". Do NOT export the internal
presentation-type objects — a consumer registers them via the plugin.

- [ ] **Step 2: Write the presentation contract suite**

`packages/testing/src/contracts/presentation.ts` — `runPresentationContractTests(name, type, fixture)`
asserting: `fieldReferences` returns paths that are arrays of string/number segments;
`validate` accepts the fixture; `validate` on a malformed definition returns issues or throws
rather than passing silently; every path returned by `fieldReferences` is relative (does not
start with `"spec"` or `"presentation"` — a common mistake that produces
`spec.presentation.spec.presentation.x.field` once core prefixes it).

That last assertion is worth its weight: the doubled path is easy to write and hard to notice.

- [ ] **Step 3: Write the plugin test**

Registers all five presentation names and the `Chart` kind; a `Chart` manifest with no
`presentation` fails `prepare()`; a `Chart` manifest with no `query` fails `prepare()`; a
misspelled series field fails `prepare()` with the SPEC.md §86 diagnostic including the
suggestion. Then call `runPresentationContractTests` for each of the five.

- [ ] **Step 4: Verify and commit**

```bash
npm run build && npm run typecheck:tests && npx vitest run
git add -A packages/charts packages/testing
git commit -m "feat(charts): add the charts() plugin, Chart resource kind, and contract suite"
```

---

### Task 11: End-to-end pipeline, documentation, and gap closure

The task that proves the three packages compose. Everything before this tested a piece.

**Files:**
- Create: `test/pipeline.test.ts`
- Create: `fixtures/valid/grouped-series-chart.qspec.json`
- Modify: `README.md`, `docs/architecture.md`, `docs/known-gaps.md`, `.github/workflows/ci.yml`

- [ ] **Step 1: Write the end-to-end test**

`test/pipeline.test.ts` builds a runtime with all three plugins:

```ts
const qspec = createQSpec().use(memory({ tables: { ... } })).use(transforms()).use(charts());
```

and executes a `Chart` manifest exercising the whole pipeline: two required parameters, a
`memory` query with bindings, a declared `dataset` schema, a transform chain of
`filter → derive → sort → limit`, and a `line` presentation. Assert:

- the returned dataset has the expected rows, in the expected order, with the derived field;
- `result.presentation` is the manifest's presentation object;
- `resolveSeries(result.data, result.presentation)` yields the expected series and points;
- `result.meta.rowCount` matches the post-transform row count, not the raw one;
- **a misspelled presentation field fails at `prepare()`, before the memory source is called** —
  assert the source's `calls` array is empty. That is the single clearest demonstration that
  static validation prevents useless queries (SPEC.md §81), and it only became testable now
  that transforms and charts exist.
- **a rename in the transform chain projects through to presentation validation**: chart the
  renamed field and confirm `prepare()` succeeds; chart the pre-rename name and confirm it
  fails. This is the `describe()` contract working end to end.

- [ ] **Step 2: Add the grouped-series fixture**

`fixtures/valid/grouped-series-chart.qspec.json` — a `Chart` using `series: { field, groupBy }`.
The conformance test picks up new fixtures automatically, so this also proves both validators
accept the grouped form.

Note: `Chart` is not a kind `@qspecs/core` knows, but `validateManifestStructure` and the JSON
Schema both accept any non-empty `kind` string, so the fixture is valid to both validators
without either learning about charts. Confirm that is true rather than assuming it — if the
conformance test fails, report it before changing anything.

- [ ] **Step 3: Update the documentation**

- **README**: add `@qspecs/transforms`, `@qspecs/charts`, and `@qspecs/testing` to the package
  table with their environments. Replace the "runs today" example with the full pipeline from
  Step 1 — it is now genuinely runnable. Keep the future-package caveats accurate: `@qspecs/sql`,
  `@qspecs/postgres`, `@qspecs/react`, and `@qspecs/recharts` are still unbuilt.
- **`docs/architecture.md`**: document the transform pipeline and the `describe()` projection
  with the rename example; document `resolveSeries` and why it lives in `@qspecs/charts` rather
  than in renderers; add the three new packages to any package listing.
- **`docs/known-gaps.md`**: **close blocking items 1 and 2** — `maxExpressionDepth` is now
  enforced by the `filter` and `derive` transforms, and unknown operators are rejected at
  `prepare()`. Replace them with the narrower, still-true statement from decision 3 of this
  plan: `qspec validate` cannot diagnose transform-specific specs because it is registry-free,
  and Plan 5 should address it by letting the CLI load plugins. Add the duplicated `closest`
  helper as a new "worth fixing" entry.

- [ ] **Step 4: Add the new packages to CI's pack check**

The workflow's pack step iterates `packages/*/`. Confirm it skips `@qspecs/testing`
(`"private": true`) and packs the two new public packages. Run the loop locally to be sure.

- [ ] **Step 5: Full verification from a clean state**

```bash
npm run clean && rm -rf node_modules && npm ci
npm run format:check && npm run build && npm run typecheck:tests && npx vitest run
node packages/cli/dist/bin.js validate fixtures/valid/*.qspec.json
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: prove the transform and chart pipeline end to end, and refresh docs"
```

---

## Definition of Done

1. `npm ci && npm run build && npm run typecheck:tests && npx vitest run` passes from a clean clone.
2. `@qspecs/core` still has zero runtime dependencies; `@qspecs/transforms` and `@qspecs/charts` declare only a peer dependency on it.
3. `qspec validate` accepts every `fixtures/valid/*` including the new grouped-series chart.
4. The end-to-end pipeline test passes, including the two assertions that matter most: a bad presentation field prevents the query from running at all, and a rename projects through to presentation validation.
5. `maxExpressionDepth` is enforced — proven by a test using a runtime configured with a low limit, and by the falsification in Task 7.
6. `docs/known-gaps.md` blocking items 1 and 2 are closed.

### SPEC.md coverage

| Requirement | Where |
|---|---|
| §16 standard transforms (filter, sort, limit, rename, select, derive) | Tasks 3–6 |
| §17 chart semantics without rendering | Tasks 8–10 |
| §40 transform pipeline, sequential | Task 11 |
| §42 expression AST, limited | Task 2 (exposed), Task 3 (enforced) |
| §43 derived fields | Task 6 |
| §44–§46 presentation model, multiple series | Task 8 |
| §47 dynamic series from a grouping field | Task 9 |
| §72.5 maximum expression depth | Task 7 |
| §81 static validation prevents needless queries | Task 11 |
| §89 contract tests for transforms and presentations | Tasks 7, 10 |
| §100 chart v1 types (line, bar, area, pie, scatter) | Tasks 8–10 |

### Deliberately out of scope

- `aggregate` (SPEC.md §16 lists it, but §99's v1 transform set omits it, and grouping semantics deserve their own design pass).
- Any renderer. `@qspecs/charts` renders nothing by design (SPEC.md §17); React and Recharts are Plan 4.
- `@qspecs/sql` and `@qspecs/postgres` — Plan 3. The memory source exists so this plan does not need them.
- Making `qspec validate` plugin-aware — Plan 5, per decision 3.
