# QSpec Execution Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a plugin approve or reject an execution after its query is compiled and before its data source runs, seeing a value-free view of the compiled query and never a bound value; forward `ExecutionContext.metadata` to `DataSourceContext.metadata`, read-only. Release both as QSpec 0.2.0, lockstep.

**Architecture:** An eighth registry, `api.policies: Registry<ExecutionPolicy>`, evaluated in registration order inside `executePrepared`, between `query:compile:end` and the source call. A query language contributes an optional `policyView(compiled)` that strips values; core deep-freezes it, pre-resolves bindings to `parameter | literal`, and hands each policy one input. The first denial, any throw, or any malformed decision stops the execution with `ExecutionDeniedError` or `ExecutionPolicyError`; the source is never called. One `policy:decision` event per policy evaluated. `prepare()` is unchanged.

**Tech Stack:** TypeScript 5.8+, Node.js >=22.19, npm workspaces, Vitest 3, `pg` 8.x and `@testcontainers/postgresql` 12.x (end-to-end task only).

**Tracks:** QSpec issue #1.
**Design document:** [`../specs/2026-11-01-qspec-execution-policy-design.md`](../specs/2026-11-01-qspec-execution-policy-design.md) ("the policy design"). Section numbers below (3.1 to 3.12) refer to it.
**Builds on:** [`../specs/2026-08-09-qspec-design.md`](../specs/2026-08-09-qspec-design.md) §2.1, §2.9, §4; the four earlier plans, all merged.
**Carried gaps:** [`../../known-gaps.md`](../../known-gaps.md): this plan closes "Plumbed but never read: `ExecutionContext.metadata`" and "Two copies of `PARAMETER_REFERENCE`".
**Source specification:** `SPEC.md` §50, §51, §59, §61, §62, §63, §68, §70, §71, §72.6, §79, §80, §81, §89, §104, §110

---

## Decisions made for this plan

The policy design argues each of these; they are restated here only so a task brief extracted from
this plan is self-contained.

1. **Registry, not interceptor** (3.1). `api.policies` is a plain `Registry<ExecutionPolicy>`.
   Evaluation order is registration order, read from the registry's internal `Map`; the public
   `Registry<T>` interface does not change.
2. **After compile, before the source; never in `prepare()`** (3.2, 3.3). A resource without
   `spec.query` runs its policies right after stage 3, with `query: undefined`.
3. **Value-free by construction** (3.4). Policies get `QueryLanguage.policyView(compiled)`,
   deep-frozen, plus bindings resolved to `{ kind: "parameter", parameter } | { kind: "literal" }`.
   With no policy registered, `policyView` is never called, so a runtime without policies behaves
   byte for byte as 0.1.0.
4. **Sequential, first denial wins, fail closed** (3.5, 3.7).
5. **Distinct error, issue list inside** (3.6): `ExecutionDeniedError` (`QSPEC_EXECUTION_DENIED`),
   absolute issue paths, policy-chosen issue codes. Not a validation stage.
6. **One event**, `policy:decision`, with codes and duration only (3.8).
7. **No verdict cache in core** (3.9).
8. **Metadata**: plain object or `undefined`, else `ExecutionContextError`; one frozen shallow copy
   shared by policies and the source; never logged (3.10).
9. **Exports** (3.11): core `describeBinding`; `@qspecs/sql` `policyView`, `SqlPolicyView`,
   `isSqlPolicyView`, `sqlPolicyView`, `scanSql`, `ScanResult`.
10. **HTTP** (3.12): 403 without issues; optional `metadata(request)` option.

---

## Global Constraints

- **`@qspecs/core` keeps ZERO runtime dependencies.** `test/boundaries.test.ts` must stay green
  untouched.
- **No bound value reaches a policy, an event, a log line or an error message** (SPEC.md §61,
  §72.6). Neither does any metadata value, nor any metadata key.
- **No policy registered means no behavior change.** Every test that exists before Task 1 passes
  unmodified after Task 8, except tests that construct a `QSpecPluginAPI` by hand (they gain
  `policies`) and the version pins in Task 10.
- ESM only; `"sideEffects": false`; `"license": "MIT"`; `"engines": { "node": ">=22.19" }`;
  `exports` exposing only `.` and `./package.json`.
- No `eval`, no `new Function`. `.js` on relative imports; `import type` for type-only.
- No `any`, `@ts-ignore`, `@ts-expect-error`, non-null assertions, or casts that strip
  `undefined` from an indexed access, in implementation or tests. Registry-widening casts are
  permitted, as before.
- Never bracket-access a caller-supplied object without `Object.hasOwn`.
- **Tests must be able to fail.** For every case marked "falsify", break the code it guards,
  confirm the test fails, restore, and report. A falsification that does not fail is information
  about the test.
- Local commits only. Never `git push`, never add or modify a remote.

---

## Existing contracts you must build against

Copied verbatim from `@qspecs/core` 0.1.0 (commit `2ba47d6`). Do not guess these.

```ts
// types/runtime.ts
export interface ExecutionContext {
  readonly parameters?: Record<string, unknown>;
  readonly signal?: AbortSignal;
  readonly locale?: string;
  readonly timezone?: string;
  readonly metadata?: Record<string, unknown>;
}

// types/plugin.ts
export interface DataSourceContext {
  readonly executionId: string;
  readonly signal?: AbortSignal | undefined;
  readonly locale?: string | undefined;
  readonly timezone?: string | undefined;
  readonly logger: QSpecLogger;
}

export interface QueryLanguage<TStatement = unknown, TCompiledQuery = unknown> {
  compile(
    query: QueryDefinition<TStatement>,
    context: QueryCompileContext,
  ): Promise<TCompiledQuery> | TCompiledQuery;
  validate?(query: QueryDefinition<TStatement>): void | readonly QSpecIssue[];
}

export interface QSpecPluginAPI {
  readonly queryLanguages: Registry<QueryLanguage>;
  readonly sources: Registry<DataSource>;
  readonly transforms: Registry<Transform>;
  readonly semanticTypes: Registry<SemanticType>;
  readonly resources: Registry<ResourceKind>;
  readonly presentations: Registry<PresentationType>;
  readonly renderers: Registry<Renderer>;
  readonly hooks: { readonly on: HookRegistry["on"] };
  readonly logger: QSpecLogger;
  readonly limits: Readonly<QSpecLimits>;
}

// internal/prepare.ts
export interface PreparedQuery {
  readonly definition: QueryDefinition;
  readonly language: QueryLanguage;
  readonly languageName: string;
  readonly source: DataSource;
  readonly sourceName: string;
  readonly bindings: readonly CompiledBinding[];
}

export interface PreparedPlan {
  readonly kind: string;
  readonly name: string;
  readonly parameters: CompiledParameters;
  readonly query: PreparedQuery | undefined;
  readonly datasetSchema: DatasetSchema | undefined;
  readonly transforms: readonly PreparedTransform[];
  readonly presentation: PresentationDefinition | undefined;
}

// internal/bindings.ts
export const PARAMETER_REFERENCE = /^\$parameters\.([A-Za-z_][A-Za-z0-9_]*)$/;
export type CompiledBinding =
  | { readonly name: string; readonly kind: "parameter"; readonly parameter: string }
  | { readonly name: string; readonly kind: "literal"; readonly value: JsonValue };
```

Five points that matter:

- **`executePrepared` compiles, emits `query:compile:end`, calls `throwIfAborted`, then builds a
  `withTimeout` signal and calls `query.source.execute`.** The policy step goes between
  `query:compile:end` and that `throwIfAborted`.
- **`PreparedPlan` deliberately omits the manifest** today ("execute() needs neither"). Policies
  need it; Task 5 adds it and rewrites that comment.
- **The manifest is already deep-frozen** by `prepareResource`, so handing it to a policy needs no
  copy.
- **`createHooks` takes a non-`Partial` listener map**, so adding `"policy:decision"` to
  `QSpecEventMap` without adding its `Set` is a compile error. That is the drift guard; keep it.
- **Every error class lives in `errors.ts`**, and `AggregateQSpecError` (internal) is the base of
  every class that carries `issues`.

---

## File Structure

```text
packages/
  core/src/
    types/policy.ts                 NEW  PolicyBinding, PolicyQuery, ExecutionPolicyInput,
                                         ExecutionPolicyDecision, ExecutionPolicy
    types/plugin.ts                 MOD  QSpecPluginAPI.policies, QueryLanguage.policyView,
                                         DataSourceContext.metadata
    types/events.ts                 MOD  "policy:decision"
    errors.ts                       MOD  ExecutionDeniedError, ExecutionPolicyError,
                                         ExecutionContextError
    internal/abort.ts               NEW  throwIfAborted, isAbortLike (moved from execute.ts)
    internal/bindings.ts            MOD  describeBinding; the one binding pattern
    internal/validate/manifest.ts   MOD  uses describeBinding's pattern, not its own copy
    internal/policy.ts              NEW  runPolicies, freezeMetadata
    internal/registry.ts            MOD  createOrderedRegistry (insertion-order entries)
    internal/runtime.ts             MOD  the policies registry, pluginApi.policies
    internal/prepare.ts             MOD  PreparedPlan.manifest, PreparedQuery.policyBindings
    internal/execute.ts             MOD  metadata copy, policy step, DataSourceContext.metadata
    internal/hooks.ts               MOD  the new listener Set
    index.ts                        MOD  new exports
  sql/src/
    internal/policy-view.ts         NEW  policyView, sqlPolicyView, isSqlPolicyView
    index.ts                        MOD  exports, language.policyView
  testing/src/
    memory.ts                       MOD  policyView on the pass-through language
    contracts/execution-policy.ts   NEW  runExecutionPolicyContractTests
    index.ts                        MOD  export it
  http/src/internal/handler.ts      MOD  403 mapping, metadata option
test/
  policy-pipeline.test.ts           NEW  end to end against PostgreSQL
  contract-suites.test.ts           MOD  (or the existing equivalent) runs the new suite on a toy policy
docs/                               MOD  per the policy design, section 7
```

---

## How this plan specifies tests

As before: implementation code is given verbatim where the exact bytes matter (the policy step and
its fail-closed handling); elsewhere test cases are enumerated with their expected behavior, to be
written in the style of the existing `*.test.ts` files beside them. "Falsify" means: break the
guarded code, watch the test fail, restore, report.

---

### Task 1: Policy types, error classes, and the `policy:decision` event

Types and errors first, because every later task imports them and the compiler then guards the
hooks map for free.

**Files:**

- Create: `packages/core/src/types/policy.ts`
- Modify: `packages/core/src/errors.ts`, `packages/core/src/types/events.ts`,
  `packages/core/src/internal/hooks.ts`, `packages/core/src/index.ts`
- Test: `packages/core/src/errors.test.ts`, `packages/core/src/internal/hooks.test.ts`

**Interfaces:**

- Produces: the five policy types (policy design section 4); three error classes; the
  `"policy:decision"` event type.

- [ ] **Step 1: Write the failing tests**

`errors.test.ts` already runs a table over every error class (name, code, `instanceof
QSpecError`). Add three rows:

| Class                   | `code`                            | extra                                           |
| ----------------------- | --------------------------------- | ----------------------------------------------- |
| `ExecutionDeniedError`  | `QSPEC_EXECUTION_DENIED`          | `.policy`, `.issues`, `.details` equals issues  |
| `ExecutionPolicyError`  | `QSPEC_POLICY_FAILED`             | `.policy`, `.cause`                             |
| `ExecutionContextError` | `QSPEC_EXECUTION_CONTEXT_INVALID` | `.path` equals `["metadata"]`                   |

Plus: `ExecutionDeniedError`'s message is exactly
`Execution policy "<policy>" denied the execution (<n> problem|problems).` and contains none of
its issues' messages. `hooks.test.ts`: a handler on `"policy:decision"` receives the payload.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run packages/core/src/errors.test.ts packages/core/src/internal/hooks.test.ts`
Expected: FAIL, the classes do not exist.

- [ ] **Step 3: Implement**

`types/policy.ts` is the block in the policy design, section 4, verbatim. In `errors.ts`:

```ts
interface DeniedErrorOptions extends IssueErrorOptions {
  readonly policy: string;
}

/** A policy denied the execution; the data source was not called. (SPEC.md §110) */
export class ExecutionDeniedError extends AggregateQSpecError {
  readonly policy: string;

  constructor(options: DeniedErrorOptions) {
    const count = options.issues.length;
    super(
      `Execution policy "${options.policy}" denied the execution ` +
        `(${count} problem${count === 1 ? "" : "s"}).`,
      "QSPEC_EXECUTION_DENIED",
      options,
    );
    this.name = "ExecutionDeniedError";
    this.policy = options.policy;
  }
}

/** A policy threw or returned something that is not a decision. Fails closed. */
export class ExecutionPolicyError extends QSpecError {
  readonly policy: string;

  constructor(message: string, options: { readonly policy: string; readonly cause?: unknown }) {
    super(message, { code: "QSPEC_POLICY_FAILED", cause: options.cause });
    this.name = "ExecutionPolicyError";
    this.policy = options.policy;
  }
}

/** `ExecutionContext` holds a value core cannot accept, for example a non-object `metadata`. */
export class ExecutionContextError extends QSpecError {
  constructor(message: string, path: readonly PathSegment[]) {
    super(message, { code: "QSPEC_EXECUTION_CONTEXT_INVALID", path });
    this.name = "ExecutionContextError";
  }
}
```

In `events.ts`, add `"policy:decision"` exactly as the policy design 3.8 shows; in `hooks.ts`, its
`Set`. Export the types and classes from `index.ts` (errors already re-export with
`export * from "./errors.js"`).

- [ ] **Step 4: Run, typecheck, falsify**

`npm run build && npm run typecheck:tests && npx vitest run packages/core`. Falsify: delete the
`"policy:decision"` entry from `hooks.ts` and confirm `npm run build` fails to compile, naming it.

- [ ] **Step 5: Commit**

```bash
git add -A packages/core
git commit -m "feat(core): add execution policy types, errors and the policy:decision event"
```

---

### Task 2: `describeBinding`, one binding rule instead of two

Closes the known gap "Two copies of `PARAMETER_REFERENCE`", and gives policies' admission checks
the rule core itself uses (policy design 3.11).

**Files:**

- Modify: `packages/core/src/internal/bindings.ts`, `packages/core/src/internal/validate/manifest.ts`,
  `packages/core/src/index.ts`, `docs/known-gaps.md`
- Test: `packages/core/src/internal/bindings.test.ts`

**Interfaces:**

- Produces: `describeBinding(binding: unknown): PolicyBinding | undefined`, public.

- [ ] **Step 1: Failing tests**

- `"$parameters.from"` gives `{ kind: "parameter", parameter: "from" }`
- `{ parameter: "to" }` gives `{ kind: "parameter", parameter: "to" }`
- `{ literal: "US" }` and `{ literal: null }` give `{ kind: "literal" }`, with no `value` key
- `"from"`, `"$parameter.from"`, `"$parameters.1x"`, `{}`, `{ parameter: 1 }`,
  `{ parameter: "x", literal: 1 }` (two keys), `null`, `42` give `undefined`
- a manifest-validation test and a binding-compilation test that were green before stay green:
  run `validate/manifest.test.ts` and `bindings.test.ts` unchanged
- `grep -rn "PARAMETER_REFERENCE" packages/core/src` finds exactly one definition (assert it in a
  test that reads the two source files, the way `test/boundaries.test.ts` reads sources)

Falsify: make `describeBinding` accept `"$parameter.from"` and confirm the manifest-validation
suite now fails too, which proves both call sites share the rule.

- [ ] **Step 2: Implement**

Keep the single `PARAMETER_REFERENCE` in `bindings.ts`; import it in `validate/manifest.ts` and
delete that file's copy. `describeBinding` reuses the exact-one-key logic `compileBindings` already
applies to the object forms (design §2.1: "exactly one key, not whichever parses").

- [ ] **Step 3: Close the gap entry and commit**

Delete the "Two copies of `PARAMETER_REFERENCE`" bullet from `docs/known-gaps.md`.

```bash
git add -A packages/core docs/known-gaps.md
git commit -m "refactor(core): one binding rule, exported as describeBinding"
```

---

### Task 3: The `policies` registry

**Files:**

- Modify: `packages/core/src/internal/registry.ts`, `packages/core/src/internal/runtime.ts`,
  `packages/core/src/types/plugin.ts`
- Test: `packages/core/src/internal/registry.test.ts`, `packages/core/src/internal/runtime.test.ts`

**Interfaces:**

- Consumes: `createRegistry<T>(label)`.
- Produces: `QSpecPluginAPI.policies: Registry<ExecutionPolicy>`;
  `RuntimeInternals.policies: { entries(): readonly { name: string; policy: ExecutionPolicy }[] }`
  in insertion order.

- [ ] **Step 1: Failing tests**

- `register("b")`, `register("a")`, `register("c")`: `entries()` yields `b, a, c`; `list()` still
  yields `a, b, c`
- `replace("a", other)` keeps `a` second and returns `other` from `entries()`
- `replace("d", p)` on a new name appends `d` last
- duplicate `register` throws `PluginRegistrationError` whose message names "execution policy"
- two plugins installed with `.use(first).use(second)`, each registering one policy: `entries()`
  lists the first plugin's policy first
- `api.policies` exists on the object `setup` receives; test fakes in this repository that build
  a `QSpecPluginAPI` by hand gain the field (find them with `grep -rn "renderers:" packages test`)

- [ ] **Step 2: Implement**

Add `entries()` to the object `createRegistry` returns, typed on an internal
`OrderedRegistry<T> extends Registry<T>` that is never exported from `index.ts`. `Map` iteration is
insertion order and `Map.set` on an existing key keeps its position, which is exactly the
`replace` semantics the policy design 3.1 promises; write that down in the doc comment.

- [ ] **Step 3: Verify and commit**

```bash
git add -A packages/core
git commit -m "feat(core): add the policies registry, evaluated in registration order"
```

---

### Task 4: Metadata, validated, copied once, forwarded to the source

Useful on its own: it closes "Plumbed but never read: `ExecutionContext.metadata`".

**Files:**

- Create: `packages/core/src/internal/policy.ts` (only `freezeMetadata` in this task)
- Modify: `packages/core/src/internal/execute.ts`, `packages/core/src/types/plugin.ts`,
  `docs/known-gaps.md`
- Test: `packages/core/src/internal/execute.test.ts`

**Interfaces:**

- Produces: `freezeMetadata(value: unknown): Readonly<Record<string, unknown>> | undefined`;
  `DataSourceContext.metadata`.

- [ ] **Step 1: Failing tests**

- `execute({ metadata: { tx, tenant: "t1" } })`: the source's `context.metadata` has exactly
  those keys, `context.metadata.tx === tx` (identity: values are not cloned), and
  `Object.isFrozen(context.metadata)` is true
- the source receives a copy: `context.metadata !== callerObject`, and a later mutation of the
  caller's object does not change it
- `metadata` omitted: `context.metadata` is `undefined`, and the context object has no
  `metadata` key at all (deep-equality with the 0.1.0 context shape, so existing source tests that
  assert exact context objects stay green)
- `metadata: "x"`, `[]`, `new Map()`, `new (class Scope {})()`: rejects with
  `ExecutionContextError`, path `["metadata"]`, before stage 3 (a parameter that would fail stage
  3 is present and the error is still `ExecutionContextError`), and the source is not called
- `metadata: Object.create(null)` with keys: accepted (it is a plain object to `isPlainObject`;
  confirm against `json.ts` and pin whichever answer it gives)
- a `__proto__` own key in metadata (created with `JSON.parse`) survives as an own data property
  of the copy and does not change the copy's prototype
- **never logged:** with a spy logger, a handler on every event name, and a failing source (so
  `execution:error` fires), a sentinel string in a metadata value appears in no logger argument,
  no event payload and no error message; the same holds for a sentinel metadata key. Falsify: add
  `metadata` to the `execution:error` payload and confirm the test fails.

- [ ] **Step 2: Implement**

```ts
/**
 * One shallow, frozen copy per execution, shared by every policy and the data source, so a policy
 * cannot add, remove or replace a key the source reads. Values are the host's own references
 * (a transaction handle must stay live), so they are neither cloned nor frozen. (SPEC.md §59)
 */
export function freezeMetadata(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    throw new ExecutionContextError(
      "`metadata` must be a plain object. Wrap other values, for example `{ scope: value }`.",
      ["metadata"],
    );
  }
  return Object.freeze({ ...value });
}
```

Call it first thing in `executePrepared`'s `try` block, before `throwIfAborted`, and spread
`...(metadata === undefined ? {} : { metadata })` into the `DataSourceContext` literal.

- [ ] **Step 3: Close the gap and commit**

Remove `ExecutionContext.metadata` from the "Plumbed but never read" list in
`docs/known-gaps.md`; the other three entries in that list stay.

```bash
git add -A packages/core docs/known-gaps.md
git commit -m "feat(core): forward ExecutionContext.metadata to data sources, frozen"
```

---

### Task 5: `QueryLanguage.policyView` and the policy step

The heart of the change. Exact bytes matter here, so the step is given in full.

**Files:**

- Create: `packages/core/src/internal/abort.ts` (move `throwIfAborted` and `isAbortLike` out of
  `execute.ts` unchanged)
- Modify: `packages/core/src/internal/policy.ts`, `packages/core/src/internal/execute.ts`,
  `packages/core/src/internal/prepare.ts`, `packages/core/src/types/plugin.ts`
- Test: `packages/core/src/internal/policy.test.ts` (new), `packages/core/src/internal/execute.test.ts`

**Interfaces:**

- Consumes: `RuntimeInternals.policies.entries()` (Task 3), `freezeMetadata` (Task 4),
  `describeBinding` (Task 2), the error classes (Task 1).
- Produces: `runPolicies(entries, input, hooks): Promise<void>`; `PreparedPlan.manifest`;
  `PreparedQuery.policyBindings: Readonly<Record<string, PolicyBinding>>` (computed and frozen in
  `prepareResource` from `bindings`).

- [ ] **Step 1: Write the failing tests**

Use `memory()` with a `policyView` (Task 7 adds it to `@qspecs/testing`; until then, register a
local test language in the test file whose compiled form is `{ statement, bindings }` and whose
`policyView` returns `{ statement }`).

**Allow and deny:**

- one policy returning `{ outcome: "allow" }`: the source is called once; the result deep-equals
  the result with no policy registered
- one policy denying with two issues: rejects with `ExecutionDeniedError`, `policy` equal to the
  registered name, `issues` deep-equal to the returned ones, paths not rebased; the source's call
  count is 0. Falsify: move the call to `runPolicies` below `query.source.execute`.

**What the policy sees** (capture the input in the policy):

- `resource` is `{ kind, name }` from the manifest; `executionId` equals the one on
  `query:compile:start`
- `manifest` is the prepared manifest object and is frozen
- `query.language`, `query.source` from `spec.query`; `query.bindings` maps
  `$parameters.from` and `{ parameter: "to" }` to `{ kind: "parameter", ... }` and
  `{ literal: "SENTINEL_LITERAL" }` to `{ kind: "literal" }`
- `query.view` is what `policyView` returned, deep-frozen; it is `undefined` for a language with
  no `policyView`
- **no value reaches the policy:** with parameter values `SENTINEL_A`, `SENTINEL_B` and the
  literal above, `JSON.stringify` of every input field except `manifest` contains no sentinel (the
  literal legitimately sits in the manifest). Falsify: return `bindings` from the test language's
  `policyView` and confirm the test fails.
- `metadata` is the same object (identity) the source later receives
- `signal` is the caller's signal

**Fail closed** (one test per row of the policy design 3.7; each also asserts the source call
count is 0 and the `policy:decision` outcome):

- `{ outcome: "deny", issues: [] }` gives `ExecutionDeniedError` with exactly one issue,
  `code: "QSPEC_EXECUTION_DENIED"`, `path: []`
- a thrown `ExecutionDeniedError` whose `policy` is `"someone-else"` surfaces with the registered
  name instead
- a thrown `ParameterValidationError` surfaces as `ExecutionPolicyError` with it as `cause`
- a thrown plain `Error` surfaces as `ExecutionPolicyError`, message naming the policy and not
  containing the thrown message (it could contain anything)
- returning `undefined`, `{ outcome: "maybe" }`, or `{ outcome: "deny", issues: [{ code: 1 }] }`
  surfaces as `ExecutionPolicyError`
- a policy that throws after the caller aborted surfaces as `QSpecAbortError`

**Order:** policies `p1` (allow), `p2` (deny), `p3` (spy): `p3` is never called; events show `p1
allow`, `p2 deny`, in that order.

**Async and abort:** an async policy is awaited; a policy that allows after the caller aborts
mid-check yields `QSpecAbortError` and no source call; an already-aborted signal yields
`QSpecAbortError` before the first policy runs (spy not called).

**Immutability:** a policy that does `(input.query.view as { statement: string }).statement = "x"`
or `(input.metadata as Record<string, unknown>).x = 1` fails with `ExecutionPolicyError` (strict
mode `TypeError`), and the source never runs.

**No query:** a `Dataset` manifest without `spec.query` runs policies with `query: undefined`
after stage 3; a denial stops the transform pipeline (a spy transform is not called).

**No policies:** `policyView` is never called (spy) and no `policy:decision` fires.

**Events:** the `policy:decision` payload has exactly the keys `executionId`, `resource`,
`policy`, `outcome`, `codes`, `durationMs`; on a denial, `codes` equals the issue codes; on an
`ExecutionPolicyError`, `codes` is `["QSPEC_POLICY_FAILED"]`; `execution:error.code` matches the
thrown error.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run packages/core/src/internal/policy.test.ts`
Expected: FAIL, `runPolicies` does not exist.

- [ ] **Step 3: Implement `runPolicies`**

`packages/core/src/internal/policy.ts`:

```ts
import {
  ExecutionDeniedError,
  ExecutionPolicyError,
  QSpecAbortError,
  type QSpecIssue,
} from "../errors.js";
import { isPlainObject } from "../json.js";
import type { HookRegistry } from "../types/events.js";
import type { ExecutionPolicy, ExecutionPolicyInput } from "../types/policy.js";
import { isAbortLike, throwIfAborted } from "./abort.js";

export interface PolicyEntry {
  readonly name: string;
  readonly policy: ExecutionPolicy;
}

function isIssue(value: unknown): value is QSpecIssue {
  return (
    isPlainObject(value) &&
    typeof value["code"] === "string" &&
    typeof value["message"] === "string" &&
    Array.isArray(value["path"])
  );
}

type Verdict =
  | { readonly kind: "allow" }
  | { readonly kind: "deny"; readonly error: ExecutionDeniedError }
  | { readonly kind: "error"; readonly error: QSpecAbortError | ExecutionPolicyError };

/** Anything but a well-formed decision denies or fails: never allows. (policy design 3.7) */
function readDecision(name: string, decision: unknown): Verdict {
  if (isPlainObject(decision) && decision["outcome"] === "allow") return { kind: "allow" };
  if (isPlainObject(decision) && decision["outcome"] === "deny") {
    const issues = decision["issues"];
    if (Array.isArray(issues) && issues.every(isIssue)) {
      // Copied, so a policy that keeps and later mutates its array cannot rewrite the error.
      const reported: readonly QSpecIssue[] =
        issues.length > 0
          ? issues.map((issue) => ({ ...issue, path: [...issue.path] }))
          : [
              {
                code: "QSPEC_EXECUTION_DENIED",
                message: `Policy "${name}" denied the execution without reporting a reason.`,
                path: [],
              },
            ];
      return { kind: "deny", error: new ExecutionDeniedError({ policy: name, issues: reported }) };
    }
  }
  return {
    kind: "error",
    error: new ExecutionPolicyError(`Policy "${name}" returned something that is not a decision.`, {
      policy: name,
    }),
  };
}

/**
 * A thrown denial is rebuilt under the registered name, so a policy cannot attribute its denial
 * to another. Every other throw fails closed as ExecutionPolicyError, including other QSpecErrors:
 * a policy must not surface as a validation error whose issues @qspecs/http would forward.
 */
function readThrow(name: string, error: unknown, signal: AbortSignal | undefined): Verdict {
  if (error instanceof ExecutionDeniedError) {
    return { kind: "deny", error: new ExecutionDeniedError({ policy: name, issues: error.issues }) };
  }
  if (error instanceof QSpecAbortError || isAbortLike(error, signal)) {
    return {
      kind: "error",
      error:
        error instanceof QSpecAbortError
          ? error
          : new QSpecAbortError("QSpec execution was aborted.", { cause: error }),
    };
  }
  return {
    kind: "error",
    error: new ExecutionPolicyError(`Policy "${name}" failed while checking the execution.`, {
      policy: name,
      cause: error,
    }),
  };
}

/**
 * Runs every policy in registration order. The first denial or failure throws; nothing after it
 * runs, and the caller never reaches the data source. (SPEC.md §110; policy design 3.5)
 */
export async function runPolicies(
  entries: readonly PolicyEntry[],
  input: ExecutionPolicyInput,
  hooks: HookRegistry,
): Promise<void> {
  const base = { executionId: input.executionId, resource: input.resource.name } as const;
  for (const { name, policy } of entries) {
    throwIfAborted(input.signal);
    const startedAt = performance.now();
    let verdict: Verdict;
    try {
      verdict = readDecision(name, await policy.check(input));
    } catch (error) {
      verdict = readThrow(name, error, input.signal);
    }
    hooks.emit("policy:decision", {
      ...base,
      policy: name,
      outcome: verdict.kind,
      codes:
        verdict.kind === "allow"
          ? []
          : verdict.kind === "deny"
            ? verdict.error.issues.map((issue) => issue.code)
            : [verdict.error.code],
      durationMs: performance.now() - startedAt,
    });
    if (verdict.kind !== "allow") throw verdict.error;
  }
  throwIfAborted(input.signal);
}
```

- [ ] **Step 4: Wire it into `executePrepared`**

In `prepare.ts`, add `manifest` to `PreparedPlan` (rewrite its doc comment: execute now reads the
manifest, for policies only) and `policyBindings` to `PreparedQuery`, built from `bindings` with
`describeBinding`'s output shape and frozen. In `execute.ts`:

```ts
const policies = internals.policies.entries();

// ...after stage 3, when plan.query is undefined:
if (policies.length > 0) {
  await runPolicies(policies, policyInput(plan, executionId, metadata, context, undefined), hooks);
}

// ...after hooks.emit("query:compile:end", ...), before throwIfAborted(context.signal):
if (policies.length > 0) {
  // Called only when a policy exists, so a runtime without policies never calls policyView.
  const view = query.language.policyView === undefined
    ? undefined
    : deepFreeze(query.language.policyView(compiled));
  await runPolicies(
    policies,
    policyInput(plan, executionId, metadata, context, {
      language: languageName,
      source: sourceName,
      bindings: query.policyBindings,
      view,
    }),
    hooks,
  );
}
```

`policyInput` builds and freezes the `ExecutionPolicyInput` record. A throw from `policyView`
itself is a language defect at the compile boundary: wrap it exactly as a `compile` throw is
wrapped (`QueryCompilationError`, `cause` attached).

- [ ] **Step 5: Run, falsify, commit**

`npm run build && npm run typecheck:tests && npx vitest run`: every pre-existing test green,
unchanged.

```bash
git add -A packages/core
git commit -m "feat(core): run execution policies between compile and the data source"
```

---

### Task 6: `@qspecs/sql`: the SQL policy view, and `scanSql` made public

**Files:**

- Create: `packages/sql/src/internal/policy-view.ts`
- Modify: `packages/sql/src/index.ts`
- Test: `packages/sql/src/internal/policy-view.test.ts`, `packages/sql/src/index.test.ts`

**Interfaces:**

- Consumes: `scanSql`, `compileSql`.
- Produces: `SqlPolicyView`, `policyView` (on the registered language), `sqlPolicyView`,
  `isSqlPolicyView`, and the public `scanSql`/`ScanResult`.

```ts
/** `CompiledSqlQuery` without `values`: what an execution policy may see. (SPEC.md §72.6) */
export interface SqlPolicyView {
  readonly segments: readonly string[];
  readonly parameterNames: readonly string[];
  readonly source: string;
}
```

- [ ] **Step 1: Failing tests**

- `policyView(compiled)` has exactly the keys `segments`, `parameterNames`, `source`; its arrays
  are copies (`!==` the compiled arrays)
- **property test** (a fixed-seed generator, no new dependency) over 500 statements built from
  the scanner's own adversarial fragments (`::date`, `'a:b'`, `$$ :x $$`, nested comments,
  repeated parameters) with random bindings: `policyView(compileSql(def, ctx))` deep-equals
  `sqlPolicyView(def)`; and for two different binding value sets the views are equal. Falsify:
  make `sqlPolicyView` trim the last segment.
- `isSqlPolicyView` accepts the view; rejects `undefined`, a view with `values`, non-string
  segments, and `segments.length !== parameterNames.length + 1`. A view with an extra `values`
  key is rejected, not ignored: a policy must never be handed one by mistake.
- `sqlPolicyView` with a non-string statement throws `QueryCompilationError` (same message as
  `compileSql`)
- `index.test.ts`: `scanSql`, `sqlPolicyView`, `isSqlPolicyView` are exported; registering
  `sql()` registers a language whose `policyView` is a function

- [ ] **Step 2: Implement, verify, commit**

`sqlPolicyView(definition)` calls `scanSql(definition.statement)` and returns
`{ segments, parameterNames, source: definition.source }`. `policyView(compiled)` copies.
`scanSql`'s doc comment gains one paragraph: it is public because a second consumer needed exactly
this logic (SPEC.md §104).

```bash
git add -A packages/sql
git commit -m "feat(sql): add the SQL policy view and export scanSql"
```

---

### Task 7: `@qspecs/testing`: `memory()`'s view and `runExecutionPolicyContractTests`

SPEC.md §89: every capability gets a contract suite. Plugins maintained outside this repository
vendor `@qspecs/testing`, so this suite is their acceptance bar too.

**Files:**

- Modify: `packages/testing/src/memory.ts`, `packages/testing/src/index.ts`
- Create: `packages/testing/src/contracts/execution-policy.ts`
- Test: `packages/testing/src/contracts/execution-policy.test.ts`

**Interfaces:**

```ts
export interface ExecutionPolicyCase {
  readonly manifest: unknown;
  readonly parameters?: Record<string, unknown>;
  readonly metadata?: Record<string, unknown>;
}

export interface ExecutionPolicyContractFixture {
  /** A fresh policy per test. */
  readonly create: () => ExecutionPolicy | Promise<ExecutionPolicy>;
  /** Plugins the cases need besides the policy, for example sql() and memory(). Fresh per test. */
  readonly plugins: () => readonly QSpecPlugin[];
  /** How many times the data source ran, read from the plugins created for the current test. */
  readonly sourceCalls: () => number;
  readonly allowed: ExecutionPolicyCase;
  readonly denied: ExecutionPolicyCase;
  /** Rejection deadline for a check started with an aborted signal. Default 150 ms. */
  readonly abortBoundMs?: number;
}
```

- [ ] **Step 1: The suite asserts, through a real runtime:**

1. `allowed` resolves with a `QSpecResult` and `sourceCalls()` moved by exactly 1.
2. `denied` rejects with `ExecutionDeniedError` whose `policy` is the name the suite registered,
   with at least one issue; every issue has a string `code`, a string `message` and an array `path`.
3. After `denied`, `sourceCalls()` has not moved.
4. Running `denied` twice yields the same list of issue codes (determinism).
5. With `metadata: { ...denied.metadata, contractSentinel: "<random>" }`, the sentinel appears in
   no issue message.
6. A check started with an already-aborted signal settles (either way) within `abortBoundMs`.

`memory()`'s language gains `policyView: (compiled) => ({ source: compiled.source, statement:
compiled.statement })`.

- [ ] **Step 2: Prove the suite can fail**

Run it against four planted defects, each in its own `describe` that expects the suite to fail:
a policy that always allows (2 fails), a policy whose denial issues have numeric codes (2 fails),
a policy that echoes `metadata` into its message (5 fails), a policy whose codes depend on a
counter (4 fails). Then run it green against a toy "statement must name table `t`" policy.

- [ ] **Step 3: Commit**

```bash
git add -A packages/testing
git commit -m "test(testing): add runExecutionPolicyContractTests and memory()'s policy view"
```

---

### Task 8: `@qspecs/http`: 403 for a denial, metadata from the request

**Files:**

- Modify: `packages/http/src/internal/handler.ts`, `packages/http/src/index.ts`
- Test: `packages/http/src/internal/handler.test.ts`, `packages/http/src/internal/executor.test.ts`,
  `test/react-pipeline.test.tsx`

- [ ] **Step 1: Failing tests**

- a runtime whose policy denies: the handler answers 403; the body's `error` has exactly the keys
  `code` and `message`; `code` is `QSPEC_EXECUTION_DENIED`; the body text contains none of the
  issue messages (plant a distinctive table name in one)
- a policy that throws: 500, generic message, `code: "QSPEC_POLICY_FAILED"`
- `metadata: (request) => ({ viewer: request.headers.get("x-viewer") })`: the policy and the source
  both see `viewer`; an async callback works; a throwing callback answers the generic 500 and the
  runtime is never called
- no `metadata` option: requests behave exactly as before (existing tests unchanged)
- the browser executor turns a 403 into a `QSpecError` with code `QSPEC_EXECUTION_DENIED`
- `react-pipeline.test.tsx`: a denied request's response body and the rendered error contain no
  SQL, table name or credential (extend the existing leak assertion)

- [ ] **Step 2: Implement and commit**

In `mapError`, before the generic branch:

```ts
if (error instanceof ExecutionDeniedError) {
  // Issue messages name relations and columns from the statement; they stay on the server
  // (architecture §10.1). Only the fixed code crosses.
  return errorResponse(403, {
    code: error.code,
    message: "The request was refused by an execution policy.",
  });
}
```

```bash
git add -A packages/http test/react-pipeline.test.tsx
git commit -m "feat(http): answer policy denials with 403 and pass request metadata"
```

---

### Task 9: End to end against PostgreSQL

The unit tests prove the source's `execute` was not called. This proves the database never saw the
statement, which is the claim a host's auditor cares about.

**Files:**

- Create: `test/policy-pipeline.test.ts`

- [ ] **Step 1: Write it**

Same container setup as `test/postgres-pipeline.test.ts` (`postgres:16-alpine`, skip with an
explicit message without Docker, required in CI). Create `CREATE SEQUENCE qspec_policy_probe`.
Manifest: `SELECT nextval('qspec_policy_probe') AS n`, `sql()` plus `postgres()`.

- a policy that denies when the view's segments mention `nextval`: the execution rejects with
  `ExecutionDeniedError`; afterwards `SELECT last_value, is_called FROM qspec_policy_probe` reads
  `1, false`, unchanged
- the same manifest with that policy replaced by an allowing one advances the sequence to
  `1, true`
- a policy reading `metadata.tenant` and a source wrapper asserting it received the same object

Falsify: move `runPolicies` after the source call; the sequence assertion fails.

- [ ] **Step 2: Commit**

```bash
git add test/policy-pipeline.test.ts
git commit -m "test: prove a denied statement never reaches PostgreSQL"
```

---

### Task 10: Documentation

Every change in the policy design, section 7, including the SPEC.md §110 conformance note in
`docs/architecture.md`. Add to `docs/known-gaps.md` the deferred items of the policy design,
section 9, each with its reopen trigger. `npm run format:check` must pass (this plan and the
policy design sit under `docs/superpowers/`, which `.prettierignore` excludes on purpose).

```bash
git add -A docs README.md
git commit -m "docs: document execution policies and metadata forwarding"
```

---

### Task 11: Release 0.2.0, lockstep

Per `RELEASING.md`:

- [ ] `npm version 0.2.0 --workspaces --no-git-tag-version`, then move every exact inter-package
      pin from `"0.1.0"` to `"0.2.0"`
- [ ] `npm run release:check` (it names any stale pin), `npm run build`,
      `npm run release:dry-run`
- [ ] commit `release: 0.2.0`; tagging and pushing are the maintainer's step, not this plan's

---

## Definition of Done

1. `npm ci && npm run build && npm run typecheck:tests && npx vitest run` passes from a clean
   clone, with and without Docker; with Docker, the PostgreSQL sequence test ran.
2. Every test that existed at `2ba47d6` passes unmodified, except hand-built `QSpecPluginAPI`
   fakes and version pins.
3. `@qspecs/core` still has zero runtime dependencies; `test/boundaries.test.ts` untouched and
   green.
4. No bound value, metadata value or metadata key appears in a policy input (values), an event, a
   log line or an error message, proven by sentinel tests that were each falsified once.
5. A denied execution provably never reaches PostgreSQL.
6. `runExecutionPolicyContractTests` exists and was shown to reject four planted defects.
7. The two known-gap entries named at the top are closed; the deferred items are recorded.
8. All packages are at 0.2.0 with exact pins, and `npm run release:dry-run` passes.

### SPEC.md coverage

| Requirement                                     | Where      |
| ----------------------------------------------- | ---------- |
| §50 capability registries                       | Task 3     |
| §51 duplicate registration throws, `replace`    | Task 3     |
| §59 execution context metadata                  | Task 4     |
| §61, §72.6 no sensitive values exposed          | Tasks 4, 5 |
| §62 data source context                         | Task 4     |
| §63 query language interface (`policyView`)     | Tasks 5, 6 |
| §68 lifecycle events                            | Tasks 1, 5 |
| §70, §71 structured errors with paths           | Tasks 1, 5 |
| §89 contract tests                              | Task 7     |
| §104 public API promoted for a second consumer  | Tasks 2, 6 |
| §110 policy layer                               | Tasks 3, 5, 9 |

### Deliberately out of scope

- A prepare-time policy phase, verdict caching in core, metadata on `TransformContext`, a policy
  timeout limit, parallel evaluation (the policy design, section 9, with reopen triggers).
- Any policy implementation beyond test fixtures. The first real one, a SQL statement guard, is an
  official plugin maintained outside this repository and built against the published 0.2.0.
