# QSpec Query Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver `@qspecs/sql` and `@qspecs/postgres`, so a QSpec manifest executes against a real database — parameters bound natively, cancellation propagated, results normalized — completing the SPEC.md §116 flow end to end for the first time.

**Architecture:** `@qspecs/sql` compiles a named-parameter SQL statement into a **dialect-neutral** form: literal segments plus an ordered parameter list. It never produces final SQL text and never interpolates a value. `@qspecs/postgres` renders that form into `$1…$n`, executes it on a pooled connection, propagates `AbortSignal` via real server-side cancellation, and normalizes results into positional `RawQueryResult`. A reusable data-source contract suite lands in `@qspecs/testing` and runs against both the in-memory source and Postgres.

**Tech Stack:** TypeScript 5.8+, Node.js ≥20.11, npm workspaces, Vitest 3, `pg` 8.x, `@testcontainers/postgresql` 12.x.

**Predecessors:** [`2026-08-09-qspec-foundation.md`](2026-08-09-qspec-foundation.md) and [`2026-08-09-qspec-data-presentation.md`](2026-08-09-qspec-data-presentation.md) — both merged. 668 tests.
**Design document:** [`../specs/2026-08-09-qspec-design.md`](../specs/2026-08-09-qspec-design.md)
**Carried gaps:** [`../../known-gaps.md`](../../known-gaps.md)
**Source specification:** `SPEC.md` — §9, §14, §15, §34, §60, §62, §63, §72.1, §72.2, §72.6, §89, §90, §97

---

## Decisions made for this plan

Six calls, stated up front because they are not obvious from the specification and several are hard to reverse.

### 1. `@qspecs/sql` compiles to a dialect-neutral form, never to final SQL text

SPEC.md §14 is explicit that `@qspecs/sql` "must NOT be tied specifically to PostgreSQL". But placeholder syntax is dialect-specific — `$1` in Postgres, `?` in MySQL and SQLite. So the compiled form cannot contain placeholders at all:

```ts
interface CompiledSqlQuery {
  /** Literal SQL between parameter references, in order. */
  readonly segments: readonly string[];
  /** The parameter name filling each gap. Length is segments.length - 1. */
  readonly parameterNames: readonly string[];
  /** The resolved value for each gap, in the same order. */
  readonly values: readonly JsonValue[];
  readonly source: string;
}
```

The adapter joins `segments` with placeholders in its own dialect. **The compiled form is structurally incapable of carrying an interpolated value**, which is how SPEC.md §72.2 ("never `WHERE id = ${value}`") is enforced by construction rather than by discipline.

### 2. A repeated parameter repeats its value; placeholders are not deduplicated

`WHERE a >= :from AND b >= :from` produces two gaps and two identical values. Postgres would allow reusing `$1` twice, but deduplication means tracking which name maps to which index and is a source of off-by-one bugs for a saving of one bound value. Correctness over cleverness. Document it.

### 3. The scanner is the highest-risk code in this plan, and it must skip five contexts

A naive `:name` regex corrupts real SQL. `:` appears legitimately inside:

- single-quoted strings, including the `''` escape — `'12:30'`
- double-quoted identifiers — `"my:column"`
- line comments — `-- see :from`
- block comments — `/* :from */`, **which nest in Postgres**
- dollar-quoted strings — `$$ … :from … $$` and `$tag$ … $tag$`
- the `::` cast operator — `created_at::date`, extremely common in Postgres

Missing any of these silently changes the query. `::date` in particular would otherwise be read as a parameter named `date`.

The scanner handles all of them as a **superset**: `::` and dollar-quoting do not exist in MySQL, so treating them as special is harmless there, and the result is dialect-neutral in effect. This is the one place in this plan where a subtle bug produces a wrong query rather than an error, so it gets its own task and adversarial tests.

### 4. `numeric` and `bigint` arrive as strings, and are left that way

`pg` returns `numeric`, `bigint`, and `int8` as strings deliberately, because they exceed IEEE-754 double precision. Coercing them to `number` in the adapter would silently corrupt values a financial manifest cares about most.

QSpec leaves them as strings and records the Postgres type in `RawColumn.nativeType`. A manifest that wants a JS number declares `type: "number"` in `spec.dataset.fields` and accepts the coercion consciously — or keeps `type: "string"` and formats downstream.

**Do not call `pg.types.setTypeParser`.** It mutates parsing globally for the whole process, including connections QSpec does not own.

### 5. Cancellation uses real server-side `pg_cancel_backend`

SPEC.md §60 says adapters "should propagate cancellation whenever their underlying client supports it". `pg` supports it: capture the connection's `processID`, and on abort open a second short-lived connection issuing `SELECT pg_cancel_backend($1)`.

The weaker alternative — destroying the client socket — leaves the query running server-side, holding locks and burning CPU until it completes. That is not cancellation, it is looking away. Since this is the first adapter, whatever it does becomes the reference every later adapter copies.

### 6. `DataSource.supportedLanguages` lands here, closing a carried gap

`docs/known-gaps.md` item 2 records that nothing pairs a query language with a compatible data source, so `language: "sql"` with a memory source prepares cleanly and fails deep inside the adapter. It says this is worth adding "when the second adapter lands and the mismatch becomes reachable."

It is now reachable, though not in the direction the original entry guessed. `memory()`
deliberately keeps **omitting** the field, so it stays permissive and every existing manifest
keeps working — that omission is the compatibility guarantee, and `sql` + a memory source
remains valid. What becomes catchable is the reverse: `@qspecs/postgres` declares
`supportedLanguages: ["sql"]`, so a manifest pointing `language: "memory"` (or any future
language) at a Postgres source now fails at `prepare()` with a clear message instead of
somewhere inside `pg`.

Task 3 adds the optional field and the `prepare()` check, and closes the gap entry.

---

## Global Constraints

- **`@qspecs/core` keeps ZERO runtime dependencies.** Task 3 modifies core; it must not add one.
- **`@qspecs/sql` has NO runtime dependencies** — `@qspecs/core` peer only. It must not import `pg` or anything Postgres-specific. A CI boundary test already asserts no browser-safe package depends on `pg`; `@qspecs/sql` must stay in that set.
- **`@qspecs/postgres` is server-only** and depends on `pg` — the project's first real runtime dependency.
- **No credentials in manifests, ever** (SPEC.md §9, §72.1). A manifest names a logical source; the runtime maps it to a connection. Nothing in this plan may read a connection string from manifest content.
- **Never interpolate a bound value into SQL text** (SPEC.md §72.2). Use driver parameterization.
- **Never log credentials or bound values** (SPEC.md §72.6). Connection strings must not appear in error messages, lifecycle events, or logger output — including inside a wrapped driver error, which often embeds them.
- ESM only; `"sideEffects": false`; `"license": "MIT"`; `"engines": { "node": ">=20.11" }`; version `0.1.0`; `"publishConfig": { "access": "public" }`; `exports` exposing only `.` and `./package.json`.
- No `eval`, no `new Function`. `.js` on relative imports; `import type` for type-only.
- No `any`, `@ts-ignore`, `@ts-expect-error`, non-null assertions, or casts that strip `undefined` from an indexed access — implementation OR tests. Registry-widening casts are permitted.
- Never bracket-access a caller-supplied object with a dataset field name without `Object.hasOwn`.
- **Tests must be able to fail.** For every case marked "falsify", break the code it guards, confirm the test fails, restore, and report. Thirteen tests across the previous two plans passed regardless of the behavior they named.
- Local commits only — **never `git push`**, never add or modify a remote.

---

## Existing contracts you must build against

Copied verbatim from merged `@qspecs/core`. Do not guess these.

```ts
interface QueryLanguage<TStatement = unknown, TCompiledQuery = unknown> {
  compile(query: QueryDefinition<TStatement>, context: QueryCompileContext): Promise<TCompiledQuery> | TCompiledQuery;
  validate?(query: QueryDefinition<TStatement>): void | readonly QSpecIssue[];
}

interface QueryCompileContext {
  readonly source: string;
  readonly bindings: Record<string, JsonValue>;   // already resolved against validated parameters
  readonly parameters: Record<string, JsonValue>;
}

interface DataSource<TCompiledQuery = unknown> {
  execute(query: TCompiledQuery, context: DataSourceContext): Promise<RawQueryResult>;
  dispose?(): Promise<void> | void;               // called by QSpec.dispose()
}

interface DataSourceContext {
  readonly executionId: string;
  readonly signal?: AbortSignal | undefined;
  readonly locale?: string | undefined;
  readonly timezone?: string | undefined;
  readonly logger: QSpecLogger;
}

interface RawColumn { readonly name: string; readonly nativeType?: string }

interface RawQueryResult {
  readonly columns: readonly RawColumn[];
  readonly rows: readonly (readonly unknown[])[];        // POSITIONAL, not row objects
  readonly metadata?: { readonly durationMs?: number; readonly truncated?: boolean };
}
```

Four points that matter:

- **`bindings` are already resolved.** By the time `compile` runs, `$parameters.from` has become a value, validated against its declared type. The query language binds values; it does not resolve references.
- **Rows are positional.** An array of cell arrays plus a separate `columns` array — not row objects. This is what lets duplicate column names survive and a column named `constructor` be representable.
- **Core wraps adapter failures.** A thrown `QSpecError` passes through; anything else becomes `QueryExecutionError` with `cause` attached; an abort becomes `QSpecAbortError`. Core also composes `limits.queryTimeoutMs` with the caller's signal, so the adapter receives one already-combined signal.
- **`validate` runs during `prepare()`**, before any connection is opened. Issue paths are relative to `spec.query`.

---

## File Structure

```
packages/
├── sql/                              NO runtime deps; browser-safe
│   ├── package.json
│   ├── tsconfig.build.json
│   └── src/
│       ├── index.ts                  sql() plugin + public types
│       └── internal/
│           ├── scan.ts               the parameter scanner (highest-risk file)
│           └── compile.ts            scan → CompiledSqlQuery
├── postgres/                         SERVER ONLY; depends on pg
│   ├── package.json
│   ├── tsconfig.build.json
│   └── src/
│       ├── index.ts                  postgres() plugin + public types
│       └── internal/
│           ├── render.ts             CompiledSqlQuery → { text, values }
│           ├── types.ts              pg dataTypeID → nativeType names
│           ├── normalize.ts          pg.Result → RawQueryResult
│           └── source.ts             pool, execute, cancellation, dispose
└── testing/
    └── src/contracts/
        └── data-source.ts            runDataSourceContractTests (new)
```

Plus modifications: `packages/core/src/types/plugin.ts` and `internal/prepare.ts` (Task 3), root `tsconfig.json`, `docs/known-gaps.md`, `README.md`, `docs/architecture.md`, `.github/workflows/ci.yml`.

---

## How this plan specifies tests

Implementation code is given verbatim where the exact bytes matter — the scanner, the renderer, the type map. Elsewhere, test cases are enumerated case-by-case with their exact expected behavior, and you write them following the patterns already in `packages/transforms/src/internal/*.test.ts`.

Where a task says "falsify", break the code the test guards, confirm it fails, restore, and report. If a falsification does **not** produce a failure, that is information about the test, not proof the code is fine — diagnose why the mutation was not exercised and strengthen the case. That protocol has caught a genuine hole in every plan so far.

---

### Task 1: `@qspecs/sql` scaffolding and the parameter scanner

The scanner decides which `:name` occurrences are parameters and which are ordinary SQL. Get
it wrong and QSpec silently runs a different query than the manifest describes — the only
place in this plan where a bug produces wrong results rather than an error.

**Files:**
- Create: `packages/sql/package.json`, `packages/sql/tsconfig.build.json`
- Create: `packages/sql/src/internal/scan.ts`
- Test: `packages/sql/src/internal/scan.test.ts`
- Modify: root `tsconfig.json`

**Interfaces:**
- Consumes: nothing — this file is pure string processing with no imports.
- Produces: `scanSql(statement: string): ScanResult`, where `ScanResult` is `{ segments: readonly string[]; parameterNames: readonly string[] }` and `segments.length === parameterNames.length + 1`.

- [ ] **Step 1: Create the package**

`packages/sql/package.json` — note there is no `dependencies` key at all:

```json
{
  "name": "@qspecs/sql",
  "version": "0.1.0",
  "description": "SQL query language and named-parameter binding for QSpec",
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

`tsconfig.build.json` mirrors `packages/transforms/`. Add the reference to root `tsconfig.json`.

- [ ] **Step 2: Write the failing test**

`scan.test.ts` must cover each case below as its own `it(...)`. These are adversarial by
design: every one of them is a real SQL construct that a naive `:name` regex corrupts.

**Parameters found correctly:**
- `SELECT * FROM t WHERE a = :from` → one parameter `from`, segments `["SELECT * FROM t WHERE a = ", ""]`
- two distinct parameters in order
- a parameter at the very start of the statement (empty leading segment)
- a parameter at the very end (empty trailing segment)
- adjacent parameters `:a:b` — assert what happens and pin it
- names may contain digits and underscores after the first character: `:from_1`
- a name may not start with a digit: `:1abc` is NOT a parameter

**Repeated parameters:**
- `:from` used twice yields two entries in `parameterNames`, both `"from"`, and three segments. Assert this explicitly — deduplication is the tempting "improvement" and it is wrong here.

**Contexts that must be skipped — the crux:**
- single-quoted string: `WHERE s = ':from'` → zero parameters
- `''` escape inside a single-quoted string: `':from '' :to'` → zero parameters
- double-quoted identifier: `SELECT "a:b" FROM t` → zero parameters
- line comment: `-- :from` and `SELECT 1 -- :from\nWHERE x = :real` → exactly one parameter, `real`
- block comment: `/* :from */` → zero parameters
- **nested block comment**: `/* outer /* :from */ still comment */ WHERE x = :real` → exactly one parameter, `real`. Postgres nests block comments; a non-nesting scanner ends the comment at the first `*/` and then treats `still comment */ WHERE` as SQL.
- dollar-quoted string: `$$ :from $$` → zero parameters
- tagged dollar quote: `$tag$ :from $tag$` → zero parameters
- a dollar quote containing what looks like a different tag: `$a$ :from $b$ more $a$` → zero parameters
- **cast operator**: `SELECT created_at::date FROM t` → zero parameters. This is the single most likely real-world corruption — `::date` read as a parameter named `date`.
- cast next to a real parameter: `WHERE created_at::date = :from::date` → exactly one parameter, `from`
- `:` alone, not followed by an identifier character: `SELECT a : b` → zero parameters

**Unterminated constructs — decide and pin:**
- an unterminated single quote, block comment, and dollar quote each consume to end of input and yield zero parameters. Assert it. The alternative (throwing) belongs to the database, which will reject the statement with a better message than a scanner can.

**Structural invariant:**
- for every input above, `segments.length === parameterNames.length + 1`. Assert this as a
  loop over a table of all the statements used in the file — it is the invariant the compiler
  depends on, and one test for it beats remembering to check it per case.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run packages/sql`
Expected: FAIL — cannot resolve `./scan.js`.

- [ ] **Step 4: Implement the scanner**

`packages/sql/src/internal/scan.ts`:

```ts
export interface ScanResult {
  /** Literal SQL between parameters. Always one longer than `parameterNames`. */
  readonly segments: readonly string[];
  /** The parameter name filling each gap, in order. */
  readonly parameterNames: readonly string[];
}

const IDENTIFIER_START = /[A-Za-z_]/;
const IDENTIFIER_PART = /[A-Za-z0-9_]/;
/** `$$` or `$tag$` opening a dollar-quoted string. */
const DOLLAR_TAG = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/;

/**
 * Splits a SQL statement into literal segments and the `:name` parameters
 * between them.
 *
 * Everything inside a string, an identifier, a comment, or a dollar-quoted
 * block is literal, and `::` is the cast operator rather than a parameter. A
 * naive regex over `:name` corrupts all five, and `created_at::date` — read as
 * a parameter called `date` — is the one a real manifest hits first.
 *
 * Unterminated constructs consume to end of input rather than throwing: the
 * database rejects a malformed statement with a far better message than a
 * scanner can, and guessing where the author meant a quote to close would be
 * worse than passing the text through.
 */
export function scanSql(statement: string): ScanResult {
  const segments: string[] = [];
  const parameterNames: string[] = [];
  let current = "";
  let index = 0;

  const rest = (): string => statement.slice(index);

  while (index < statement.length) {
    const char = statement[index];
    if (char === undefined) break;
    const next = statement[index + 1];

    // Line comment: to end of line, or end of input.
    if (char === "-" && next === "-") {
      const newline = statement.indexOf("\n", index);
      const stop = newline === -1 ? statement.length : newline;
      current += statement.slice(index, stop);
      index = stop;
      continue;
    }

    // Block comment. Postgres nests these, so track depth rather than
    // stopping at the first `*/`.
    if (char === "/" && next === "*") {
      const start = index;
      let depth = 0;
      while (index < statement.length) {
        if (statement[index] === "/" && statement[index + 1] === "*") {
          depth += 1;
          index += 2;
          continue;
        }
        if (statement[index] === "*" && statement[index + 1] === "/") {
          depth -= 1;
          index += 2;
          if (depth === 0) break;
          continue;
        }
        index += 1;
      }
      current += statement.slice(start, index);
      continue;
    }

    // Single-quoted string or double-quoted identifier. Both double the
    // quote character to escape it.
    if (char === "'" || char === '"') {
      const quote = char;
      const start = index;
      index += 1;
      while (index < statement.length) {
        if (statement[index] === quote) {
          if (statement[index + 1] === quote) {
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      current += statement.slice(start, index);
      continue;
    }

    // Dollar-quoted string: closes only on the identical tag.
    if (char === "$") {
      const opening = DOLLAR_TAG.exec(rest());
      if (opening !== null) {
        const tag = opening[0];
        const closing = statement.indexOf(tag, index + tag.length);
        const stop = closing === -1 ? statement.length : closing + tag.length;
        current += statement.slice(index, stop);
        index = stop;
        continue;
      }
    }

    // Cast operator, not a parameter.
    if (char === ":" && next === ":") {
      current += "::";
      index += 2;
      continue;
    }

    // A parameter reference.
    if (char === ":" && next !== undefined && IDENTIFIER_START.test(next)) {
      let end = index + 1;
      while (end < statement.length) {
        const candidate = statement[end];
        if (candidate === undefined || !IDENTIFIER_PART.test(candidate)) break;
        end += 1;
      }
      segments.push(current);
      current = "";
      parameterNames.push(statement.slice(index + 1, end));
      index = end;
      continue;
    }

    current += char;
    index += 1;
  }

  segments.push(current);
  return { segments, parameterNames };
}
```

- [ ] **Step 5: Run the tests and falsify**

Run: `npm install && npm run build && npx vitest run packages/sql`
Expected: PASS.

Then falsify the three highest-value guards, one at a time, restoring between each:
1. Remove the `::` branch — confirm the cast tests fail.
2. Change the block-comment loop to stop at the first `*/` (drop the depth tracking) — confirm
   the nested-comment test fails. **Note:** `/* outer /* :from */ still comment */ WHERE x = :real`
   does NOT discriminate — a naive scanner produces identical output. The discriminating shape
   puts a parameter reference *between* the two closing delimiters, where a naive scanner has
   already left comment state and reads it as a parameter.
3. Drop one text-emitting slice — e.g. stop appending the consumed text of the `::` branch or a
   block comment — and confirm the reconstruction invariant fails. Text preservation, not
   parameter extraction, is the property a mutation can silently break: dropping consumed text
   never changes the segment or parameter counts.

Do **not** attempt to falsify the `''`-escape lookahead. It cannot change `scanSql`'s output on
any input: quote content is copied verbatim, and closing then immediately reopening the string
leaves a zero-character gap, so an escape-naive scanner is observationally identical. Verified
over ~105,000 generated inputs with zero divergence. The branch is kept as documented defensive
code — it becomes load-bearing the moment anything decodes quote content — and is annotated as
such rather than guarded by a test that cannot fail.

Report all outcomes. If a mutation does not produce a failure, the test does not cover the
branch — diagnose and strengthen rather than moving on.

- [ ] **Step 6: Commit**

```bash
git add -A packages/sql tsconfig.json package-lock.json
git commit -m "feat(sql): add package scaffolding and the named-parameter scanner"
```

---

### Task 2: SQL compilation, validation, and the `sql()` plugin

**Files:**
- Create: `packages/sql/src/internal/compile.ts`, `packages/sql/src/index.ts`
- Test: `packages/sql/src/internal/compile.test.ts`, `packages/sql/src/index.test.ts`

**Interfaces:**
- Consumes: `scanSql` (Task 1); `definePlugin`, `QueryLanguage`, `QueryDefinition`, `QueryCompileContext`, `QSpecIssue`, `JsonValue` from `@qspecs/core`.
- Produces: `sql(): QSpecPlugin`; types `CompiledSqlQuery`, `SqlStatement`; `compileSql(query, context): CompiledSqlQuery`.

- [ ] **Step 1: Define the compiled form**

```ts
export interface CompiledSqlQuery {
  /** Literal SQL between parameters; join with dialect placeholders to get text. */
  readonly segments: readonly string[];
  /** Parameter name per gap, in order. Length is segments.length - 1. */
  readonly parameterNames: readonly string[];
  /** Resolved value per gap, in the same order. */
  readonly values: readonly JsonValue[];
  /** The logical source this query targets. */
  readonly source: string;
}
```

There is deliberately no `text` field. An adapter must join the segments itself, which makes
it structurally impossible for this package to hand a driver a string with a value already
inside it (SPEC.md §72.2).

- [ ] **Step 2: Write the failing tests**

`compile.test.ts`:
- a statement with no parameters compiles to one segment, empty `parameterNames` and `values`
- `:from` resolves from `context.bindings.from`
- two parameters resolve in statement order, not binding-declaration order — use a statement where the two orders differ, or the test proves nothing
- a repeated parameter yields the value twice
- `source` is carried from `context.source`
- a `:name` with no matching binding throws/returns an issue naming the parameter, with a did-you-mean suggestion drawn from the declared binding names
- a binding declared but never referenced is reported — it is almost always a typo in the statement
- a non-string `statement` is rejected: SQL requires text, even though `QueryDefinition.statement` is `unknown` to allow structured languages

`index.test.ts`:
- `sql()` registers exactly the language name `"sql"`
- installing it twice on one runtime throws
- a manifest with a `sql` query prepares successfully through `createQSpec().use(sql()).use(memory({...}))`. This stays valid after Task 3: `memory()` omits `supportedLanguages` and so accepts any language, which is exactly the backward-compatibility guarantee that task must preserve. If this test ever starts failing, Task 3 has broken it.
- `validate` reports several problems at once (an unknown `:name` and an unused binding together)

- [ ] **Step 3: Implement, verify, commit**

`compileSql` scans the statement, maps each name to `context.bindings[name]` via
`Object.hasOwn`, and assembles `CompiledSqlQuery`. `validate` performs the name-coverage
checks statically against `query.bindings` — it runs during `prepare()`, before a connection
exists, which is the whole point (SPEC.md §81).

Falsify the ordering test: make `compile` emit values in `Object.keys(bindings)` order
instead of statement order, and confirm the two-parameter test fails. That is the bug that
would bind arguments to the wrong placeholders.

```bash
npm run build && npx vitest run packages/sql
git add -A packages/sql
git commit -m "feat(sql): compile named parameters to a dialect-neutral form"
```

---

### Task 3: `DataSource.supportedLanguages` in core, closing a carried gap

`docs/known-gaps.md` item 2: nothing pairs a query language with a compatible data source, so
`language: "sql"` with a memory source prepares cleanly and fails deep inside the adapter.
The gap entry says to add this "when the second adapter lands and the mismatch becomes
reachable." It is now reachable.

**Files:**
- Modify: `packages/core/src/types/plugin.ts`, `packages/core/src/internal/prepare.ts`, `packages/core/src/index.ts` if needed
- Test: `packages/core/src/internal/prepare.test.ts`
- Modify: `docs/known-gaps.md`

**Interfaces:**
- Produces: optional `DataSource.supportedLanguages?: readonly string[]`, checked in `prepareResource`.

- [ ] **Step 1: Extend the contract**

```ts
export interface DataSource<TCompiledQuery = unknown> {
  execute(query: TCompiledQuery, context: DataSourceContext): Promise<RawQueryResult>;
  dispose?(): Promise<void> | void;
  /**
   * Query languages this source can execute. When present, `prepare()` rejects
   * a manifest pairing this source with any other language, so the mismatch
   * fails with a clear message instead of deep inside the adapter.
   *
   * Optional and additive: a source that omits it accepts any language, which
   * is the behavior every existing source had before this field existed.
   */
  readonly supportedLanguages?: readonly string[];
}
```

Optional is load-bearing: making it required would break every existing `DataSource`,
including the memory source and any third-party adapter.

- [ ] **Step 2: Check it during `prepare()`**

In `prepareResource`, after both the language and the source resolve, reject a mismatch with
a `ManifestValidationError` whose issue path is `["spec","query","language"]`, naming the
source, the requested language, and what the source does support. Include a `suggestion` when
the requested language is close to a supported one.

Report at the `language` path rather than `source`: the language is far more often the thing
the author got wrong.

- [ ] **Step 3: Tests**

- a source declaring `supportedLanguages: ["sql"]` prepares fine with `language: "sql"`
- the same source with `language: "memory"` fails at `prepare()`, with the path
  `spec.query.language` and a message naming both the source and its supported list
- a source that omits the field accepts any language — this is the compatibility guarantee,
  assert it explicitly
- the check happens during `prepare()`, before any `execute` — assert the source's execute
  was never called
- a near-miss language name yields a suggestion

Falsify: remove the check and confirm the mismatch test fails.

- [ ] **Step 4: Close the gap entry**

Remove item 2 from `docs/known-gaps.md`'s blocking section. Do not merely edit it — the gap
is genuinely closed once the check exists and is tested.

- [ ] **Step 5: Verify and commit**

`npm run build`, `npm run typecheck:tests`, `npx vitest run` — all green, all prior tests
passing. `@qspecs/core` still has zero runtime dependencies.

```bash
git add -A packages/core docs/known-gaps.md
git commit -m "feat(core): let a data source declare the query languages it supports"
```

---

### Task 4: The data-source contract suite

SPEC.md §89 requires that data source plugins pass common contract tests, so PostgreSQL,
MySQL, DuckDB, and ClickHouse behave consistently. `docs/known-gaps.md` records that no such
suite exists and names this plan as its owner.

**Files:**
- Create: `packages/testing/src/contracts/data-source.ts`
- Modify: `packages/testing/src/index.ts`
- Test: `packages/testing/src/contracts/data-source.test.ts` (running the suite against `memory()`)

**Interfaces:**
- Produces: `runDataSourceContractTests(name, fixture)`; type `DataSourceContractFixture`.

```ts
export interface DataSourceContractFixture {
  /** A fresh source per test — contract tests must not share connection state. */
  readonly create: () => DataSource | Promise<DataSource>;
  /** A compiled query this source executes successfully. */
  readonly query: unknown;
  /** Column names `query` is expected to return, in order. */
  readonly expectedColumns: readonly string[];
  /**
   * A compiled query slow enough to abort mid-flight. Omit only if the source
   * genuinely cannot be slow; the cancellation assertions then skip, and the
   * suite reports that they did rather than passing silently.
   */
  readonly slowQuery?: unknown;
}
```

- [ ] **Step 1: Write the suite**

Assertions every `DataSource` must satisfy:

- **Positional shape.** Every row is an array, and every row's length equals `columns.length`.
  This is the invariant core's normalizer depends on; a source returning row objects would
  produce a dataset of undefined cells rather than an error.
- **Column names match the fixture's expectation, in order.**
- **An already-aborted signal is honored.** Passing a pre-aborted signal rejects, and does so
  without executing — where observable.
- **A mid-flight abort rejects promptly.** Using `slowQuery`, abort after the query is
  genuinely in flight and assert the rejection arrives well inside the query's natural
  duration. **Use a timing bound**, exactly as `memory()`'s own test does: without one, a
  source that ignores the signal and simply finishes still "passes".
- **Two executions do not interfere.** Run `query` twice concurrently on one source and
  assert both resolve with the expected shape — a source with shared mutable per-query state
  fails here.
- **`dispose()` is idempotent** when present: calling it twice does not throw.
- **The compiled query is not mutated.** Snapshot it, execute, and compare — an adapter that
  rewrites its input breaks `prepare()`-once/execute-many.

When `slowQuery` is absent, use `it.skip` with a message naming what is unverified. A silently
omitted assertion is how a suite becomes decorative.

- [ ] **Step 2: Run it against `memory()`**

`memory()` exposes `MemoryPlugin.sources`, so the fixture's `create` can hand back a real
instance. Use a table with `delayMs` for `slowQuery`.

**If the memory source fails any assertion, that is a real finding — report it rather than
weakening the assertion.** The transform contract suite caught a genuine `derive` bug on its
first run; treat a failure here the same way.

- [ ] **Step 3: Prove the suite has teeth**

A suite that passes first time is indistinguishable from a vacuous one until you break
something. Construct a deliberately-wrong `DataSource` — one returning row objects instead of
arrays, and one ignoring its `AbortSignal` — run the suite against each, and confirm the
relevant assertions fail. Report both outcomes.

- [ ] **Step 4: Verify and commit**

```bash
npm run build && npm run typecheck:tests && npx vitest run
git add -A packages/testing
git commit -m "feat(testing): add the data-source contract suite"
```

---

### Task 5: `@qspecs/postgres` scaffolding, rendering, type mapping, and normalization

Everything in this task is pure functions over data — no connection, no Docker. The
connection work is Task 6 and the real database is Task 7, so a failure here is unambiguous.

**Files:**
- Create: `packages/postgres/package.json`, `tsconfig.build.json`
- Create: `src/internal/render.ts`, `src/internal/types.ts`, `src/internal/normalize.ts`
- Test: one `.test.ts` per module
- Modify: root `tsconfig.json`

**Interfaces:**
- Consumes: `CompiledSqlQuery` from `@qspecs/sql`; `RawQueryResult`, `RawColumn` from `@qspecs/core`.
- Produces: `renderPostgres(compiled): { text: string; values: readonly JsonValue[] }`; `postgresTypeName(dataTypeID): string | undefined`; `normalizePgResult(result): RawQueryResult`.

- [ ] **Step 1: Create the package**

`peerDependencies`: `@qspecs/core` and `@qspecs/sql`. `dependencies`: `pg` only.
`devDependencies`: `@qspecs/core`, `@qspecs/sql`, `@types/pg`.

This is the project's first real runtime dependency. The CI boundary test asserts no
browser-safe package depends on `pg`; `@qspecs/postgres` is server-only and is not in that
set — confirm the test's allowlist still passes.

- [ ] **Step 2: Rendering**

```ts
/**
 * Joins the dialect-neutral segments with Postgres placeholders.
 *
 * A repeated parameter gets a distinct placeholder and its value appears twice
 * — see the plan's decision 2. Reusing one placeholder would be valid Postgres
 * but requires mapping names to indices, and getting that wrong binds arguments
 * to the wrong slots.
 */
export function renderPostgres(compiled: CompiledSqlQuery): {
  readonly text: string;
  readonly values: readonly JsonValue[];
} {
  let text = "";
  compiled.segments.forEach((segment, index) => {
    text += segment;
    if (index < compiled.parameterNames.length) text += `$${index + 1}`;
  });
  return { text, values: compiled.values };
}
```

Tests: no parameters yields the statement unchanged; one parameter yields `$1`; three yield
`$1`, `$2`, `$3` in order; a repeated parameter yields two distinct placeholders and two
values; **the rendered text contains no bound value** — assert with a value like
`"'; DROP TABLE t; --"` that the text does not contain it. That last one is SPEC.md §72.2 as
an executable assertion.

- [ ] **Step 3: Type mapping**

`postgresTypeName(dataTypeID: number): string | undefined` — a small map from Postgres
`dataTypeID` (OID) to a readable name, covering the common types:
`bool`(16), `int8`(20), `int2`(21), `int4`(23), `text`(25), `json`(114), `float4`(700),
`float8`(701), `varchar`(1043), `date`(1082), `time`(1083), `timestamp`(1114),
`timestamptz`(1184), `numeric`(1700), `uuid`(2950), `jsonb`(3802).

Unknown OIDs return `undefined` rather than a guess — `RawColumn.nativeType` is optional, and
an absent value is honest where `"oid:12345"` pretends to mean something.

- [ ] **Step 4: Normalization**

Query with `rowMode: "array"` so `pg` returns rows as arrays already — this matches
`RawQueryResult` exactly, avoids an object-to-array conversion, and preserves duplicate column
names, which a row-object shape loses silently.

`normalizePgResult` maps `result.fields` to `RawColumn[]` (name plus `nativeType` from the
OID map) and passes rows through. Tests: column names and types map correctly; an unknown OID
omits `nativeType`; a zero-row result yields columns and no rows without throwing; **duplicate
column names both survive** — `SELECT 1 AS id, 2 AS id` is the case row objects lose.

- [ ] **Step 5: Verify and commit**

```bash
npm install && npm run build && npx vitest run packages/postgres
git add -A packages/postgres tsconfig.json package-lock.json
git commit -m "feat(postgres): add rendering, type mapping, and result normalization"
```

---

### Task 6: The Postgres data source — pooling, execution, cancellation, disposal

**Files:**
- Create: `packages/postgres/src/internal/source.ts`, `packages/postgres/src/index.ts`
- Test: `packages/postgres/src/internal/source.test.ts` (fake `pg` client — no real database)

**Interfaces:**
- Produces: `postgres(options: PostgresOptions): QSpecPlugin`; types `PostgresOptions`, `PostgresSourceConfig`.

```ts
export interface PostgresSourceConfig {
  /** Supplied by the host application, never by a manifest. (SPEC.md §9) */
  readonly connectionString: string;
  readonly max?: number;
  readonly statementTimeoutMs?: number;
}

export interface PostgresOptions {
  readonly sources: Readonly<Record<string, PostgresSourceConfig>>;
}
```

- [ ] **Step 1: The source**

Each configured name becomes a `DataSource` with `supportedLanguages: ["sql"]` (Task 3), a
lazily-created `pg.Pool`, and a `dispose()` that ends the pool.

`execute` must:
1. Reject immediately if the signal is already aborted, before acquiring a connection.
2. Acquire a client, capture `client.processID`.
3. Run `client.query({ text, values, rowMode: "array" })`.
4. On abort mid-flight, open a **separate** short-lived connection and run
   `SELECT pg_cancel_backend($1)` with the captured PID.
5. Always release the client, and remove the abort listener, in a `finally`.
6. Normalize and return, with `metadata.durationMs`.

**Errors must not leak the connection string.** `pg` errors frequently embed connection
details. Wrap driver failures in `QueryExecutionError` with a message you construct — never
the raw driver message verbatim — and attach the original as `cause` so a host that wants it
can still reach it deliberately. Test this with a connection string containing a password and
assert the password appears in neither `error.message` nor any logger call.

- [ ] **Step 2: Unit tests with a fake client**

Inject the pool factory so these run with no database:

- an already-aborted signal rejects without acquiring a client
- a successful query releases the client
- a failing query still releases the client
- a driver error becomes `QueryExecutionError` with `cause` set
- **the connection string's password appears nowhere** in the thrown error or the logger
- mid-flight abort issues `pg_cancel_backend` with the captured PID on a *different*
  connection — assert both, since cancelling on the same blocked connection cannot work
- `dispose()` ends the pool and is idempotent
- the pool is created lazily: constructing the plugin opens no connection

- [ ] **Step 3: Falsify the two that matter**

1. Remove the `finally` release and confirm the release tests fail.
2. Make the error wrapper pass the raw driver message through and confirm the password test
   fails.

Report both.

- [ ] **Step 4: Verify and commit**

```bash
npm run build && npx vitest run packages/postgres
git add -A packages/postgres
git commit -m "feat(postgres): add the pooled data source with real cancellation"
```

---

### Task 7: Integration tests against a real PostgreSQL

SPEC.md §90 requires integration tests against a real instance, covering parameter binding,
execution, normalization, dataset validation, cancellation, and database errors.

**Files:**
- Create: `packages/postgres/test/integration.test.ts`
- Modify: `packages/postgres/package.json` (add `@testcontainers/postgresql` as a devDependency)

- [ ] **Step 1: Container setup, skipping cleanly without Docker**

Start one container for the file and reuse it. Detect Docker availability up front and use
`describe.skip` with a message naming what is unverified when it is absent — a silent skip
looks identical to a pass in CI output.

Container startup is slow; set a generous per-hook timeout and say so in a comment, so a
future reader does not "optimize" it into flakiness.

- [ ] **Step 2: The cases SPEC.md §90 names**

- **Parameter binding**: a query with `:from`/`:to` returns exactly the expected rows, and a
  value containing `'; DROP TABLE …; --` is bound as data — assert the table still exists
  afterwards. This is §72.2 proven against a real server rather than by inspection.
- **Execution and normalization**: types round-trip as decided — `timestamptz` arrives as a
  `Date` (core converts to ISO), `numeric` and `bigint` as strings with precision intact.
  Assert a `numeric` value that a double could not represent exactly.
- **Duplicate column names** survive `SELECT 1 AS id, 2 AS id`.
- **Dataset validation** rejects a result that contradicts `spec.dataset`.
- **Cancellation**: abort a `SELECT pg_sleep(30)` mid-flight; assert `QSpecAbortError` arrives
  in well under the sleep duration, and — the part that proves real cancellation —
  assert the backend is gone by querying `pg_stat_activity` for the PID afterwards. Without
  that second check the test cannot distinguish cancellation from abandonment.
- **Database errors**: a syntax error and a missing table each surface as
  `QueryExecutionError` with `cause`, and neither message contains the password.
- **The contract suite from Task 4** runs against the real source.

- [ ] **Step 3: Verify and commit**

Run with Docker present, and once with Docker stopped to confirm the skip path reports
clearly rather than failing.

```bash
npx vitest run packages/postgres
git add -A packages/postgres package-lock.json
git commit -m "test(postgres): add integration tests against a real PostgreSQL"
```

---

### Task 8: End-to-end, documentation, and CI

**Files:**
- Create: `test/postgres-pipeline.test.ts`
- Modify: `README.md`, `docs/architecture.md`, `docs/known-gaps.md`, `.github/workflows/ci.yml`

- [ ] **Step 1: The full SPEC.md §116 flow**

One test proving the complete path for the first time: JSON manifest → schema validation →
parameter validation → SQL compilation → PostgreSQL execution → normalization → dataset
validation → transform pipeline → chart presentation.

```ts
const qspec = createQSpec()
  .use(sql())
  .use(postgres({ sources: { analytics: { connectionString } } }))
  .use(transforms())
  .use(charts());
```

Assert the resulting dataset, that `resolveSeries` produces the expected series, and that
`result.meta.query` names the source and language without carrying a bound value. Skip
cleanly without Docker.

- [ ] **Step 2: Documentation**

- **README**: add `@qspecs/sql` and `@qspecs/postgres`. The quick start from SPEC.md §93 is now
  genuinely runnable — replace the caveated version with the real one, and keep the remaining
  caveats honest (`@qspecs/react` and `@qspecs/recharts` are still unbuilt).
- **`docs/architecture.md`**: document the dialect-neutral compiled form and why it exists;
  the scanner's five skipped contexts; the cancellation design and why socket-destruction was
  rejected; and the `numeric`/`bigint`-as-string decision.
- **`docs/known-gaps.md`**: confirm item 2 was removed in Task 3. Add anything this plan
  leaves open — at minimum: `@qspecs/sql` has no dialect awareness beyond the shared scanner,
  so a MySQL adapter will need to confirm the superset assumption holds.

- [ ] **Step 3: CI**

Add a PostgreSQL service (or let testcontainers run) so the integration tests execute in CI
rather than skipping there permanently. Confirm the pack step still skips private packages and
packs the two new public ones.

- [ ] **Step 4: Full clean verification**

```bash
npm run clean && rm -rf node_modules && npm ci
npm run format:check && npm run build && npm run typecheck:tests && npx vitest run
node packages/cli/dist/bin.js validate fixtures/valid/*.qspec.json
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: prove the full manifest-to-chart pipeline against PostgreSQL"
```

---

## Definition of Done

1. `npm ci && npm run build && npm run typecheck:tests && npx vitest run` passes from a clean clone, with and without Docker.
2. `@qspecs/core` still has zero runtime dependencies; `@qspecs/sql` has none; only `@qspecs/postgres` depends on `pg`.
3. SPEC.md §116's full flow runs end to end against a real PostgreSQL.
4. A bound value containing SQL is proven inert against a real server, not just by inspection.
5. Cancellation is proven to reach the server — the backend stopped executing the statement and
   the session survived into `idle`, not merely abandoned. (Corrected during Task 7: an earlier
   wording asked for the backend to be "gone", but `pg_cancel_backend` cancels the *statement*,
   not the session. A vanished session would mean `pg_terminate_backend`, which is the sledgehammer
   this adapter deliberately avoids — and the surviving session is precisely what lets the pool
   reuse the connection. The pair asserted instead discriminates against both abandonment and
   socket destruction.)
6. No connection string or bound value appears in any error, event, or log.
7. The data-source contract suite exists, runs against both sources, and was shown to reject planted defects.
8. `docs/known-gaps.md` item 2 is closed.

### SPEC.md coverage

| Requirement | Where |
|---|---|
| §9, §72.1 credentials never in manifests | Task 6 |
| §14 SQL package not Postgres-specific | Tasks 1–2 |
| §15 Postgres adapter, pooling, cancellation, type conversion | Tasks 5–7 |
| §34 named bindings, parameterized | Tasks 2, 7 |
| §60 cancellation via AbortSignal | Tasks 6–7 |
| §62 data source interface | Tasks 5–6 |
| §63 query language interface | Task 2 |
| §72.2 no interpolation | Tasks 1, 5, 7 |
| §72.6 no sensitive logging | Tasks 6–7 |
| §89 data source contract tests | Task 4 |
| §90 integration tests with a real instance | Task 7 |
| §97 SQL, named bindings, PostgreSQL | all |

### Deliberately out of scope

- MySQL, SQLite, DuckDB, ClickHouse adapters. The contract suite exists so they can be added consistently later.
- Query result streaming and pagination (SPEC.md §113) — interfaces avoid precluding it; nothing here implements it.
- `@qspecs/react` and `@qspecs/recharts` — Plan 4.
- Making `qspec validate` plugin-aware — Plan 5, per the standing gap entry.
