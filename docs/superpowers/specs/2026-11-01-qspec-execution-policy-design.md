# QSpec Execution Policy: Implementation Design

**Date:** 2026-11-01
**Tracks:** QSpec issue #1 ("Execution policy seam: let a plugin approve or reject an execution,
and forward ExecutionContext.metadata to data sources")
**Source specification:** [`SPEC.md`](../../../SPEC.md) §110 (future policy layer), with §50, §51,
§58, §59, §61, §62, §63, §68, §69, §70, §71, §72.6, §79, §80, §81, §82, §104
**Builds on:** [`2026-08-09-qspec-design.md`](2026-08-09-qspec-design.md) ("the design document"),
§2.1 (binding model), §2.9 (hooks, not middleware), §4 (execution pipeline)
**Scope of this document:** two coupled changes released together as QSpec 0.2.0:

1. an **execution policy seam**: a plugin can approve or reject an execution after the query is
   compiled and before the data source runs, seeing the compiled query and the binding names but
   never a bound value;
2. **metadata forwarding**: `ExecutionContext.metadata` reaches `DataSourceContext.metadata`,
   read-only.

This document does not restate SPEC.md. It records the decisions SPEC.md §110 leaves open ("the
architecture should allow a policy plugin or execution interceptor to approve or reject
execution"), the public API that results, and how it is tested. The implementation plan is
[`../plans/2026-11-01-qspec-execution-policy.md`](../plans/2026-11-01-qspec-execution-policy.md).

---

## 1. Why now

Two gaps, both recorded:

- **Hooks only observe.** `docs/plugins.md` says plugins "observe the runtime's lifecycle events
  ... they never emit one themselves", and the design document §2.9 keeps them that way. So a host
  that must show an auditor "only admitted, read-only, parameterised statements run, each scoped to
  the viewer" enforces that outside QSpec. A production host does exactly this today: it runs a
  parser-based statement gate once when a manifest is admitted and again in its own code before
  every execution. One rule in two places is hard to audit and easy to bypass through a new code
  path, because nothing in QSpec stops a statement that skipped the host's call.
- **`ExecutionContext.metadata` is plumbed but never read** (`docs/known-gaps.md`, "Worth fixing,
  not urgent"). `DataSourceContext` carries `executionId`, `signal`, `locale`, `timezone` and
  `logger` only, so a source that needs per-execution context (a transaction, a tenant, a role)
  smuggles it through `AsyncLocalStorage`.

The first official consumer is a SQL statement guard (planned as the official `@qspecs/sql-guard`
plugin, maintained with the other official plugins outside this repository). Its needs fixed the
shape of every decision below: an asynchronous parser load, a per-execution relation registry
that arrives through metadata, and verdicts keyed by the compiled text.

---

## 2. The change in one picture

```text
 PreparedResource.execute(context)          context = { parameters, signal, locale,
        |                                               timezone, metadata }
        v                                                                |
 Stage 3: validate parameters                                            | metadata: plain object
        |                                                                | or undefined; copied
        v                                                                | once, shallow, frozen
 resolve bindings  (values exist from here on)                           |
        |                                                                |
        v                                                                |
 Stage 4: QueryLanguage.compile(definition, { bindings }) -> compiled    |
        |                                                                |
        +--> QueryLanguage.policyView(compiled) -> view                  |
        |      value-free by contract; deep-frozen by core               |
        |                                                                |
        v                                                                v
 [NEW] policy step: every registered ExecutionPolicy, in registration order
        policy.check({ executionId, resource: { kind, name }, manifest,
                       query: { language, source, bindings, view },
                       metadata, signal })
        |                                    |
        | every policy returns "allow"       | first "deny", a throw, or a malformed decision
        v                                    v
 abort check                           ExecutionDeniedError  (QSPEC_EXECUTION_DENIED)
        |                              ExecutionPolicyError  (QSPEC_POLICY_FAILED)
        |                              DataSource.execute is never called
        v
 DataSource.execute(compiled, { executionId, signal, locale, timezone, logger,
                                metadata })                      <- [NEW] the same frozen copy
        |
        v
 normalize -> Stage 5 (dataset) -> transforms -> presentation -> QSpecResult
```

A resource without `spec.query` reaches no data source. Policies still run for it, right after
stage 3, with `query: undefined`, so a policy that decides "which users may execute which
resources" (SPEC.md §110) covers every execution, not only the ones that query.

What each party can see:

```text
                          bound    compiled query     manifest     metadata
                          values
  ExecutionPolicy.check    no      view only           yes (frozen)  yes (frozen copy)
  DataSource.execute       yes     yes                 no            yes (same frozen copy)
  lifecycle events         no      no                  name only     no
  core's logger calls      no      no                  no            no
  QSpecResult.meta         no      no                  no            no
```

---

## 3. Decisions

Each decision lists the options considered, the choice, why, and what it costs. The order is the
order in which they constrain each other.

### 3.1 One `policies` registry, not a single interceptor (SPEC.md §50, §51, §69, §110)

| Option                                                                              | For                                                                                                                                         | Against                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. `api.policies: Registry<ExecutionPolicy>`, evaluated in registration order.**  | A plugin installs a policy through `.use()` like any other capability (SPEC.md §50). Duplicate names throw; override needs `replace` (§51). | An eighth registry on `QSpecPluginAPI`. Core must iterate in registration order, which `Registry.list()` (alphabetical) does not offer.                                                                                                    |
| B. `createQSpec({ beforeExecute })`, one interceptor the host composes.             | One function, no ordering question.                                                                                                         | Not installable by a plugin, so an official policy package would need host wiring. One slot: a second policy overwrites the first unless every host writes its own composer, and silent override of security behavior is what §51 forbids. |
| C. Middleware around `execute` (`(context, next) => ...`).                          | Most general.                                                                                                                               | Rejected by design §2.9 for the reason SPEC.md §69 gives: middleware can alter the compiled query or skip the source, which corrupts runtime invariants.                                                                                 |

**Decision: A.** A host that wants exactly one interceptor registers exactly one policy.

**Why.** Every other capability in QSpec is a registry entry with a name, and the name is what
makes a policy auditable: it appears on the error, in the `policy:decision` event, and in the
`PluginRegistrationError` a duplicate produces. Composition ("every policy must allow") is then
defined once, in core, instead of re-invented in every host's composer.

**Consequences.** `Registry<ExecutionPolicy>` uses the same `createRegistry` as the other seven.
`replace(name, policy)` on an existing name keeps that policy's position (a `Map` keeps insertion
order on overwrite); on a new name it appends. Core reads the internal `Map` in insertion order;
the public `Registry<T>` interface does not change.

### 3.2 Where it runs: after compile, before the source, once per execution (SPEC.md §10, §110)

| Option                                       | Against                                                                                                                       |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Before compile, on `spec.query` as declared  | Checks the declaration, not what runs. A language whose compiled form differs from its statement would pass unchecked.        |
| **After compile, before `DataSource.execute`** | The check is on the per-execution path, so its cost is paid per execution (3.9 explains where caching belongs).              |
| After the source returns                     | Too late: the statement already ran.                                                                                          |

**Decision:** after `query:compile:end` and before the pre-source abort check and
`query:execute:start`. Without a query: after stage 3, before the transform pipeline.

**Why.** The view a policy approves is derived from the very object the source receives (3.4), so
there is no window in which the checked query and the executed query can differ.

**Consequences.** Policy time is not covered by `limits.queryTimeoutMs`, which scopes the source
call only. Policies receive the caller's `signal`; core checks it before each policy and once
after the last one, so a cancellation during a policy surfaces as `QSpecAbortError` even if the
policy allowed. (Amended in review: core also races each pending `check` against the signal, so a
policy that never settles cannot hold an aborted execution; a late result is ignored.)

Parameter validation (stage 3) runs **before** the policy step. A caller whose parameters fail
stage 3 gets `ParameterValidationError`, which `@qspecs/http` answers with a 400 whose issues can
describe a parameter's declared constraints (an enum's allowed values, for instance), and no
`policy:decision` event fires. Policies therefore decide whether an execution of validated
parameters may run; they are not resource-level authorization. Deciding whether a caller may use
a resource at all belongs in front of QSpec (around `createQSpecHandler`, or before `execute()`),
or in a pre-validation phase this design reserves but does not build (section 9).

`PreparedResource.execute()` awaits the runtime's `ready()` before it reads the policy list
(added in review): a prepared resource outlives the moment it was prepared, so a policy plugin
queued later, or one whose `setup()` failed, must still guard it.

### 3.3 `prepare()` does not run policies (SPEC.md §58, §81)

QSpec issue #1 asks whether `prepare()` dry-runs policies.

| Option                                                                                   | For                                                                       | Against                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. `execute()` only.**                                                                 | One authoritative evaluation per execution, on exactly what runs.         | A manifest a host's policy will always deny still prepares cleanly.                                                                                                                                                                                                                           |
| B. `prepare()` also runs an advisory dry run on a static view (a new `QueryLanguage` hook). | Earlier feedback.                                                      | No compiled query exists at prepare time: `compile` needs bound values (`QueryCompileContext.bindings` are values). `prepare()` takes no `ExecutionContext`, so no metadata, so a policy sees a different input than at execute. A second language hook whose answer is advisory only. |
| C. `prepare()` runs policies and `execute()` reuses the verdict.                         | Policy cost paid once per plan.                                           | Prepared plans are long-lived: `@qspecs/http` caches a `PreparedResource` for the handler's lifetime. A verdict cached there outlives every change to the policy's configuration (a relation registry revision, a revoked grant), which is a stale allow: the failure a policy exists to prevent. |

**Decision: A.**

**Why.** SPEC.md §81's "should fail during `prepare()`" is about manifest validity (unknown
transform, invalid binding), which is a property of the manifest. A policy decision is a property
of the host, its configuration at that moment, and the execution's metadata; the same manifest can
be allowed in one host and denied in another. Early feedback is still available without a core
hook: a policy package can export a pure admission check that a host calls when it stores a
manifest, running the same rules with the same configuration. `@qspecs/sql` makes that exact for
SQL with a static `sqlPolicyView(definition)` that equals `policyView(compile(...))` for every set
of bindings (3.11), so admission and execution check the same view by construction.

**Reversible.** Adding a prepare-time phase later is additive (a `phase` field on the input, an
optional method on the policy). Removing one after release would not be.

### 3.4 What a policy receives, and why it never sees a value (SPEC.md §61, §63, §72.6)

The compiled query is typed `unknown` to core, and only its language knows where values live.
`CompiledSqlQuery`, for instance, keeps them in `values`, next to `segments`.

| Option                                                                                     | Against                                                                                                       |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| **A. The language supplies a value-free view: optional `QueryLanguage.policyView(compiled)`.** | Each language implements one small function. A language without it gives policies `view: undefined`.     |
| B. Pass the compiled object and document "do not read values".                             | Turns SPEC.md §72.6 into a convention. A policy that logs its input leaks every bound value.                 |
| C. Core deletes a well-known `values` field.                                               | Bakes SQL's compiled shape into a language-agnostic core.                                                     |
| D. Split `compile` into a value-free `plan` and a `bind` step.                             | Rewrites the `QueryLanguage` contract for every language to serve one consumer.                              |

**Decision: A.** The input is:

```text
ExecutionPolicyInput
  executionId          the same id the events and DataSourceContext carry
  resource             { kind, name }
  manifest             the prepared manifest, already deep-frozen by prepare()
  query                undefined when the resource declares no spec.query, else:
    language           spec.query.language
    source             spec.query.source
    bindings           binding name -> { kind: "parameter", parameter } | { kind: "literal" }
                       (a literal's value is omitted; it is in the manifest if a policy needs it)
    view               QueryLanguage.policyView(compiled), deep-frozen; undefined without one
  metadata             the frozen shallow copy of ExecutionContext.metadata, or undefined
  signal               the caller's AbortSignal, or undefined
```

Not included: parameter values, resolved bindings, the compiled object itself, connection
details, `ExecutionContext.locale`/`timezone` (no policy need yet; additive later).

**Why bindings are pre-resolved.** A policy relating a gap in the compiled query to a declared
parameter needs design §2.1's binding rule (`$parameters.<name>`, `{ parameter }`, `{ literal }`).
A production host re-implemented that rule's regular expression in its own gate; core already
has it, twice (`docs/known-gaps.md`, "Two copies of `PARAMETER_REFERENCE`"). Core resolves it once,
with the function it now also exports (3.11).

**Language-agnostic typing.** `view` is `unknown` in core, as `QueryDefinition.statement` is. A
language package exports a runtime guard for its own view (`isSqlPolicyView` in `@qspecs/sql`),
so a policy narrows it and fails closed on anything else. Generic parameters on the registry
cannot help: one policy sees every language registered on the runtime.

**Aliasing.** A view must not share mutable structure with the compiled query, and core
deep-freezes the view before the first policy sees it. If a language's view did alias the
compiled object's arrays, the freeze would then also protect what the source receives: no policy
can change the statement it approved.

### 3.5 Asynchronous, sequential, first denial wins

**Decision.** `check` returns a decision or a promise of one. Policies run one after another in
registration order. The first denial stops evaluation; later policies do not run.

**Why.** The first consumer loads PostgreSQL's parser as WebAssembly, asynchronously, on first use.
Sequential evaluation keeps the event stream and the reported denial deterministic, lets a host
put cheap policies first, and spends nothing after the outcome is decided. For deterministic
policies the outcome (allow only when all allow) does not depend on order; order changes only
which denial is reported and which `policy:decision` events fire. Parallel evaluation was
rejected for that nondeterminism.

### 3.6 Rejection: a distinct error and code that carries an issue list, not a stage 7 (SPEC.md §70, §71, §80)

QSpec issue #1 asks whether a rejection is a validation-style issue list (a stage 7) or a
distinct error code.

| Option                                                                                                 | Against                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Stage 7: a validation stage, reported like stages 1 to 6.                                           | SPEC.md §80's stages check the manifest, the parameters and the data against the manifest's own declarations; a policy checks against host rules that differ per host and per execution. And `@qspecs/http` forwards validation issues to the browser as a 400, which would ship relation and column names across the boundary that architecture §10.1 keeps them behind. |
| **B. `ExecutionDeniedError`, code `QSPEC_EXECUTION_DENIED`, carrying `QSpecIssue[]` and the policy name.** | One more error class and code.                                                                                                                                                                                                                                                                                              |
| C. A distinct error with a message only.                                                               | Loses the per-rule detail that admission tooling and audit need.                                                                                                                                                                                                                                                                |

**Decision: B.** The issue shape is the existing `QSpecIssue` (SPEC.md §71), so CLIs, logs and
editors render it unchanged. Each issue's `code` is chosen by the policy (the SQL guard uses
stable rule IDs such as `shape.select-only`) and is unique within the policy named on the error.
Issue paths are **absolute** manifest paths, not rebased the way `validate` hooks are: a policy
sees the whole manifest and may point anywhere, for example at `spec.parameters.<name>` for a
parameter declared without `required`.

`@qspecs/http` maps the error to **403** with a fixed message and no issues (3.12).

### 3.7 Fail closed

| What the policy does                                       | Result                                                                           | `policy:decision` outcome |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------- |
| returns `{ outcome: "allow" }`                             | next policy, then the source                                                     | `allow`                   |
| returns `{ outcome: "deny", issues }`, at least one issue  | `ExecutionDeniedError` with those issues                                         | `deny`                    |
| returns `{ outcome: "deny", issues: [] }`                  | `ExecutionDeniedError` with one core issue (`QSPEC_EXECUTION_DENIED`, path `[]`) | `deny`                    |
| throws `ExecutionDeniedError`                              | rebuilt by core with the **registered** policy name and the thrown issues        | `deny`                    |
| throws while the signal is aborted, or the signal aborts while `check` is pending | `QSpecAbortError`                                         | `error`                   |
| throws an abort-like error (`AbortError`, `TimeoutError`, `QSpecAbortError`) while the signal is live (amended in review) | `ExecutionPolicyError`: the policy's own failure | `error`                   |
| throws anything else, including another `QSpecError`       | `ExecutionPolicyError` (`QSPEC_POLICY_FAILED`) with the throw as `cause`         | `error`                   |
| returns anything else (`undefined`, an unknown outcome)    | `ExecutionPolicyError`                                                           | `error`                   |

Rebuilding a thrown `ExecutionDeniedError` stops a policy from attributing its denial to another
policy's name. Wrapping every other `QSpecError` is a deliberate departure from the pass-through
convention at the compile, source and transform boundaries: a policy that threw, say, a
`ParameterValidationError` would otherwise become a 400 whose issues `@qspecs/http` forwards. Every
policy failure is therefore a 403 or a 500 at the HTTP boundary, never anything else.

### 3.8 Audit: one `policy:decision` event, hooks stay observers (SPEC.md §68, §84)

**Decision.** One new event per policy evaluated:

```ts
"policy:decision": ExecutionEventBase & {
  readonly policy: string;
  readonly outcome: "allow" | "deny" | "error";
  /** Issue codes for a denial; the error's code for "error"; empty for "allow". */
  readonly codes: readonly string[];
  readonly durationMs: number;
};
```

No issue messages, no view, no bindings, no metadata: payloads stay within the rule `events.ts`
states ("deliberately exclude bound parameter values, statements, and connection details"). The
full issues are on the thrown error, for the host that catches it. A failed execution still ends
with `execution:error`, whose `code` is `QSPEC_EXECUTION_DENIED` or `QSPEC_POLICY_FAILED`.

**Why not start/end pairs.** One event carries the decision and its duration; tracing needs no
more. **Why hooks stay observe-only.** An auditing plugin subscribes to `policy:decision`. A host
that must refuse to run when its audit write fails writes the record from a policy (policies may
be asynchronous and may deny), because hook handler failures are contained by design
(`internal/hooks.ts`: "telemetry must never be able to break a query").

### 3.9 No verdict caching in core (SPEC.md §82)

| Option                                                         | Against                                                                                                                                                                                                         |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cache per prepared plan                                        | The stale-allow problem of 3.3 C.                                                                                                                                                                               |
| Cache per plan and metadata                                    | Metadata holds arbitrary objects (a transaction handle) with no canonical key; a correct key needs each policy to declare what it depends on.                                                                   |
| **No cache in core; a policy caches what it can prove is pure** | Each policy carries its own cache.                                                                                                                                                                              |

**Decision:** no cache in core. The expensive part of the first consumer is parsing, which is a
pure function of the compiled text and the grammar, so the policy caches parse trees by text. Only
the policy knows which parts of its verdict depend on configuration or metadata.

**Reopen when** `policy:decision.durationMs` shows a policy whose cost is not content-cacheable
taking a significant share of execution time.

### 3.10 Metadata forwarding (SPEC.md §59, §62, §72.6)

**Decision.**

- `ExecutionContext.metadata` must be `undefined` or a plain object (`isPlainObject`). Anything
  else rejects the execution with `ExecutionContextError` (`QSPEC_EXECUTION_CONTEXT_INVALID`)
  before stage 3, so a string or an array is never spread into a surprising record.
- Core makes one shallow copy per execution (into a null-prototype object, as amended in review,
  rejecting with `ExecutionContextError` and a fixed message an object whose getters throw) and
  hands **the same frozen object** to every policy and to `DataSourceContext.metadata`. A policy
  cannot add, remove or replace a key the source will read.
- Values are not cloned or frozen. A transaction handle must stay a live object; the host owns
  what it puts there.
- Core never logs metadata, never puts it (or its keys) in an event, an error, or
  `ExecutionMetadata`. Data source and policy authors are asked to do the same (documented in
  `docs/data-sources.md` and `docs/plugins.md`).
- `TransformContext` does not receive metadata in 0.2.0 (no consumer).

**Behavior change.** In 0.1.0 any `metadata` value was ignored. A host passing a class instance
(not a plain object) now gets `ExecutionContextError`; the fix is to wrap it,
`metadata: { scope: instance }`. Silently ignoring a value the caller meant to pass is the failure
this rejects.

### 3.11 What core and `@qspecs/sql` export

| Export                                                          | Package        | Why                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `describeBinding(binding): PolicyBinding \| undefined`          | `@qspecs/core` | Design §2.1's rule, the function core uses to build `query.bindings`. A policy's admission check (3.3) needs it outside a running runtime. Replaces both internal `PARAMETER_REFERENCE` copies, closing that known gap.                                       |
| `policyView` on the `sql` language                              | `@qspecs/sql`  | Returns `SqlPolicyView = { segments, parameterNames, source }`: `CompiledSqlQuery` without `values`, arrays copied.                                                                                                                                         |
| `SqlPolicyView`, `isSqlPolicyView(value)`                       | `@qspecs/sql`  | Lets a policy narrow `view: unknown` and fail closed on anything else.                                                                                                                                                                                      |
| `sqlPolicyView(definition): SqlPolicyView`                      | `@qspecs/sql`  | The same view, computed statically from `spec.query` for admission checks. Equal to `policyView(compileSql(definition, context))` for every `context`, by construction (both come from one `scanSql` call on the frozen statement) and by a property test. |
| `scanSql(statement): ScanResult`                                | `@qspecs/sql`  | A production host's editor tooling re-implemented it with regular-expression masking that misses `E'...'` strings, dollar quotes and nested comments. SPEC.md §104's rule for a second consumer: promote, do not copy.                                     |

`ScanResult.positionalPlaceholder` becomes public with it; its doc comment already explains it.
Nothing in `@qspecs/postgres` changes.

### 3.12 `@qspecs/http`: 403 without issues, metadata from the request

- `mapError` maps `ExecutionDeniedError` to **403** with body
  `{ code: "QSPEC_EXECUTION_DENIED", message: "The request was refused by an execution policy." }`
  and no `issues`: issue messages name relations and columns from the statement, which
  architecture §10.1 keeps on the server. `ExecutionPolicyError` and `ExecutionContextError` fall
  into the existing generic 500 branch (code forwarded, message fixed).
- `QSpecHandlerOptions` gains an optional
  `metadata?: (request: Request) => Readonly<Record<string, unknown>> | undefined | Promise<...>`,
  called per request after the resource resolves. Its result becomes `ExecutionContext.metadata`.
  A throw becomes the generic 500. Without the option, behavior is unchanged. This is how a host
  that authenticates the request in front of the handler hands the viewer or the tenant to its
  policies and sources.
- The browser-side executor already reconstructs an unknown 4xx code as a base `QSpecError`
  carrying that code; a 403 needs no new class there, only a test.

---

## 4. Public API additions

New file `packages/core/src/types/policy.ts`:

```ts
import type { QSpecIssue } from "../errors.js";
import type { QSpecManifest, QSpecResourceSpec } from "./manifest.js";

/** What one binding reads. A literal's value is omitted: policies never see values. */
export type PolicyBinding =
  | { readonly kind: "parameter"; readonly parameter: string }
  | { readonly kind: "literal" };

export interface PolicyQuery {
  readonly language: string;
  readonly source: string;
  /** Binding name to what it reads, from `spec.query.bindings`. (design §2.1) */
  readonly bindings: Readonly<Record<string, PolicyBinding>>;
  /**
   * `QueryLanguage.policyView(compiled)`, deep-frozen. `undefined` when the language defines no
   * view. Narrow it with the language package's guard, for example `isSqlPolicyView`.
   */
  readonly view: unknown;
}

/** Everything a policy may see. Never a bound value. (SPEC.md §61, §72.6) */
export interface ExecutionPolicyInput {
  readonly executionId: string;
  readonly resource: { readonly kind: string; readonly name: string };
  readonly manifest: QSpecManifest<QSpecResourceSpec>;
  /** `undefined` when the resource declares no `spec.query`. */
  readonly query: PolicyQuery | undefined;
  /** The frozen shallow copy of `ExecutionContext.metadata`, shared with the data source. */
  readonly metadata: Readonly<Record<string, unknown>> | undefined;
  readonly signal: AbortSignal | undefined;
}

export type ExecutionPolicyDecision =
  | { readonly outcome: "allow" }
  | { readonly outcome: "deny"; readonly issues: readonly QSpecIssue[] };

/** Approves or rejects one execution before its data source runs. (SPEC.md §110) */
export interface ExecutionPolicy {
  check(input: ExecutionPolicyInput): ExecutionPolicyDecision | Promise<ExecutionPolicyDecision>;
}
```

Changes to existing types (all in `packages/core/src/types/`):

```ts
// plugin.ts
export interface QSpecPluginAPI {
  // ...the seven existing registries...
  readonly policies: Registry<ExecutionPolicy>; // new, the eighth
  // hooks, logger, limits unchanged
}

export interface QueryLanguage<TStatement = unknown, TCompiledQuery = unknown> {
  compile(/* unchanged */): Promise<TCompiledQuery> | TCompiledQuery;
  validate?(/* unchanged */): void | readonly QSpecIssue[];
  /**
   * A value-free description of a compiled query for execution policies. Must not contain any
   * bound value and must not share mutable structure with `compiled`. Optional: without it,
   * policies receive `view: undefined`. (SPEC.md §72.6)
   */
  policyView?(compiled: TCompiledQuery): unknown;
}

export interface DataSourceContext {
  // executionId, signal, locale, timezone, logger unchanged
  /**
   * `ExecutionContext.metadata`, shallow-copied and frozen once per execution; the same object
   * the policies saw. Values are the host's own references. Never log it. (SPEC.md §59, §72.6)
   */
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}

// events.ts: QSpecEventMap gains "policy:decision" (section 3.8)
```

New exports from `packages/core/src/index.ts`: the five types above, `describeBinding`, and the
three error classes in section 5. `@qspecs/sql` adds the exports in 3.11. `@qspecs/http` adds the
`metadata` option. `@qspecs/testing` (private) adds `runExecutionPolicyContractTests` and a
`policyView` on `memory()`'s pass-through language (`{ source, statement }`, without bindings).

Usage, as a plugin author writes it:

```ts
import { definePlugin, type ExecutionPolicy } from "@qspecs/core";
import { isSqlPolicyView } from "@qspecs/sql";

const readOnlySources: ExecutionPolicy = {
  check({ query }) {
    if (query === undefined) return { outcome: "allow" };
    if (query.language !== "sql" || !isSqlPolicyView(query.view)) {
      return {
        outcome: "deny",
        issues: [{ code: "language", message: "Only SQL is allowed.", path: ["spec", "query"] }],
      };
    }
    return { outcome: "allow" };
  },
};

export const governance = definePlugin({
  name: "my-governance",
  setup(api) {
    api.policies.register("read-only-sources", readOnlySources);
  },
});
```

---

## 5. Errors

| Class                   | Code                              | Extends                      | Carries                                             | HTTP (`@qspecs/http`)       |
| ----------------------- | --------------------------------- | ---------------------------- | --------------------------------------------------- | --------------------------- |
| `ExecutionDeniedError`  | `QSPEC_EXECUTION_DENIED`          | the internal aggregate base  | `policy: string`, `issues: readonly QSpecIssue[]`   | 403, fixed message, no issues |
| `ExecutionPolicyError`  | `QSPEC_POLICY_FAILED`             | `QSpecError`                 | `policy: string`, `cause`                           | 500, generic                |
| `ExecutionContextError` | `QSPEC_EXECUTION_CONTEXT_INVALID` | `QSpecError`                 | `path: ["metadata"]`                                | 500, generic                |

Messages name the policy and the issue count, never an issue message, a view or a metadata value:
`Execution policy "sql-guard" denied the execution (2 problems).`

---

## 6. Versioning and migration (SPEC.md §79, `RELEASING.md`)

This lands as **0.2.0, lockstep**: every published package moves to 0.2.0 and every exact
inter-package pin moves from `"0.1.0"` to `"0.2.0"`, as `RELEASING.md` prescribes. `@qspecs/sql`
and `@qspecs/http` change in substance; the others change version only.

What is breaking under 0.x semver, and for whom:

| Change                                       | Breaks                                                                                                                  |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `QSpecPluginAPI.policies` (required member)  | code that builds a `QSpecPluginAPI` object by hand, usually a test fake                                                 |
| `"policy:decision"` in `QSpecEventMap`       | exhaustive `switch` statements over event names                                                                         |
| three new error codes                        | exhaustive handling of error codes                                                                                      |
| `metadata` must be a plain object            | hosts that passed something else, which 0.1.0 ignored (3.10)                                                             |
| everything else                              | nothing: `policyView`, `DataSourceContext.metadata` and the `@qspecs/http` option are optional and additive              |

**For plugin authors.** Plugins declare a caret peer range on the core minor they are tested
against, and on 0.x a caret covers one minor (`^0.1.0` is `>=0.1.0 <0.2.0`). Every official plugin
maintained outside this repository therefore moves its peer ranges to `^0.2.0` and re-runs its
contract suites before releasing again; no code change is needed unless it builds a
`QSpecPluginAPI` by hand. A query language author should implement `policyView`: without it, a
fail-closed policy denies every execution in that language. A data source author may read
`context.metadata` and must not log it.

**For hosts.** With no policy registered, an execution behaves exactly as in 0.1.0; the plan
proves this by running the whole existing suite unchanged. To adopt: install a policy plugin with
`.use()`, pass per-execution context as `execute({ ..., metadata })` (or through
`@qspecs/http`'s `metadata` option), and handle `QSPEC_EXECUTION_DENIED`. A host whose own gate
ran before every `execute()` can delete that call: the seam now runs it on the compiled query
itself, on every path into a data source.

---

## 7. Documentation that changes

| Document                         | Change                                                                                                                                                                                                                                         |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/architecture.md`           | §1 pipeline diagram gains the policy step; §2 table gains an `execute()` row "Run execution policies (not a validation stage)"; §3 notes why it is not stage 7; §4 links sections 3.1, 3.3, 3.6, 3.9 and 3.10 of this document; §5 lists `policies`; §10.1 notes that denials cross the HTTP boundary without issues; SPEC.md §110 conformance note (below). |
| `docs/plugins.md`                | "seven registries" becomes eight; the `QSpecPluginAPI` snippet; a section on policy order (registration order, first denial wins, `replace` keeps position), fail-closed behavior and what a policy must never log.                           |
| `docs/data-sources.md`           | `DataSourceContext.metadata`: what it is, that it is frozen and shared with policies, never logged.                                                                                                                                             |
| `docs/queries.md`                | `QueryLanguage.policyView` and `@qspecs/sql`'s `SqlPolicyView`, `sqlPolicyView`, `scanSql`.                                                                                                                                                     |
| `docs/plugin-authoring.md`       | "seven registries" link text; a short "Writing an execution policy" section; `runExecutionPolicyContractTests` as its acceptance bar.                                                                                                          |
| `docs/security.md`               | §72.6 gains the policy input rule (no values) and the metadata rule; the HTTP section gains the 403 mapping and why issues stay on the server.                                                                                                 |
| `docs/public-api.md`             | The new exports and why each is public (`describeBinding` and `scanSql` under the §104 second-consumer rule).                                                                                                                                  |
| `docs/known-gaps.md`             | Remove `ExecutionContext.metadata` from "Plumbed but never read"; remove "Two copies of `PARAMETER_REFERENCE`"; add the deferred items of section 9.                                                                                            |
| `docs/specification-versioning.md` | "every workspace package is at `0.1.0`" becomes `0.2.0`.                                                                                                                                                                                     |
| `docs/react-integration.md`      | One line: a 403 arrives as a `QSpecError` with code `QSPEC_EXECUTION_DENIED`.                                                                                                                                                                   |
| `README.md`                      | Package versions; one line on policies in the feature list.                                                                                                                                                                                    |
| `SPEC.md`                        | Unchanged. It is the input specification (and prettier-ignored for that reason); conformance is recorded in `docs/architecture.md`.                                                                                                          |
| `.qoder/repowiki/`               | Several generated pages say "seven registries". Regenerated or left to their generator; not hand-edited in this change.                                                                                                                       |

**SPEC.md §110 conformance note** (for `docs/architecture.md`): of §110's examples, "which sources
may be queried", "which tables are allowed", "allowed query languages", "allowed transforms" (read
from the frozen manifest) and "which users may execute which resources" (from metadata) are each
expressible as a policy. "Maximum result size" is not, because a policy runs before any row
exists; `limits.maxRows` (SPEC.md §72.5) already covers it.

---

## 8. Test plan

The protocol of the earlier plans applies: every case marked "falsify" is broken on purpose to
prove the test can fail.

**Core, unit (`packages/core/src/internal/policy.test.ts`, `execute.test.ts`, `runtime.test.ts`).**

- Registry: registration order is evaluation order; `replace` keeps position; a duplicate
  `register` throws `PluginRegistrationError`; `list()` stays alphabetical.
- No values reach a policy: execute with sentinel strings as parameter values and as a literal
  binding; deep-scan the captured input (including `view`) and assert no sentinel appears.
  Falsify: make `memory()`'s `policyView` return its `bindings`.
- Allow: the source is called once with the compiled query; the result is unchanged from 0.1.0.
- Deny: `ExecutionDeniedError` with the registered name and the issues verbatim (absolute paths);
  the source's call count stays 0. Falsify: move the policy step after the source call.
- Each row of the fail-closed table in 3.7, one test per row, each asserting the source was not
  called and the `policy:decision` outcome.
- Order and short-circuit: three policies, the second denies, the third is never called.
- Async policies are awaited; a policy that resolves after the caller aborts yields
  `QSpecAbortError` and no source call.
- Freezing: a policy that pushes onto `view.segments` or assigns to `metadata.x` fails (strict
  mode `TypeError`, so `ExecutionPolicyError`), and the source never sees the change.
- Metadata: the source receives the same frozen object the policy saw (identity), with the
  caller's value references intact; a non-plain-object `metadata` throws `ExecutionContextError`
  before stage 3; a sentinel metadata value appears in no event payload, no logger call and no
  error message (spy logger plus a handler on every event).
- A resource without `spec.query`: policies run with `query: undefined`; a denial stops the
  transforms.
- No policies registered: the entire existing test suite passes unchanged.
- Events: `policy:decision` payload keys are exactly `executionId`, `resource`, `policy`,
  `outcome`, `codes`, `durationMs`; `execution:error.code` matches the error. The `hooks.ts`
  listener map fails to compile without the new key (it is not `Partial`).
- `describeBinding`: the three binding forms, malformed bindings, and one test proving both former
  `PARAMETER_REFERENCE` call sites now use it.

**`@qspecs/sql`.** `policyView` output has exactly `segments`, `parameterNames`, `source`;
property test over generated statements and bindings that
`policyView(compileSql(def, ctx))` deep-equals `sqlPolicyView(def)`; `isSqlPolicyView` accepts that
shape and rejects missing fields, non-string items and a `segments.length` not equal to
`parameterNames.length + 1`; `scanSql` and `ScanResult` are exported (index test).

**`@qspecs/http`.** A denied execution answers 403 whose body has exactly `code` and `message` and
contains none of the issue messages; the `metadata` option's result reaches the policy and the
source; a throwing `metadata` callback answers the generic 500; without the option, nothing
changes. `test/react-pipeline.test.tsx`'s "carries no SQL ... to the client" assertion is extended
to a denied request.

**`@qspecs/testing`: `runExecutionPolicyContractTests`.** The fixture supplies the policy, the
plugins it needs (for example `sql()` and `memory()`), an allowed case and a denied case (manifest,
parameters, metadata) and a source call counter. The suite asserts, through a real runtime: the
allowed case reaches the source and returns data; the denied case throws `ExecutionDeniedError`
naming the policy, with at least one issue whose `code` and `message` are strings and whose `path`
is an array; the source call count does not move; the denied codes are identical on a second run
(determinism); a metadata sentinel never appears in issue messages; the policy settles within a
bound when started with an aborted signal. QSpec's own tests run it against a toy policy and prove
it can fail by planting each defect once.

**End to end against PostgreSQL (`test/policy-pipeline.test.ts`, testcontainers).** A toy SQL
policy denies `SELECT nextval('qspec_policy_probe')`; after the denied execution the sequence's
value is unchanged (`last_value` and `is_called` read directly), which proves the statement never
reached the server, not merely that an error was thrown. The same manifest under an allowing
policy advances the sequence.

**Boundaries.** `test/boundaries.test.ts` unchanged and green: core still has no dependencies,
`exports` maps unchanged.

---

## 9. Deferred, each with its reopen trigger

| Deferred                                                     | Reopen when                                                                                         |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| A prepare-time policy phase (3.3 B)                          | a host shows that a pure admission check exported by its policy package cannot serve its admission |
| A pre-validation policy phase (before stage 3; see 3.2)      | a host needs a policy to refuse a caller before parameter issues reach that caller, and authorizing in front of QSpec cannot serve it |
| Verdict caching in core (3.9)                                | `policy:decision.durationMs` shows uncacheable policy cost as a significant share of execution time |
| Metadata on `TransformContext`                               | a transform needs per-execution host context                                                        |
| A `policyTimeoutMs` limit                                    | a policy is observed to hang an execution despite the caller's signal                               |
| Parallel policy evaluation                                   | sequential latency of several independent policies is measured as a problem                         |
| Ordered iteration on the public `Registry<T>` interface      | a second registry needs registration order                                                          |
| `locale` and `timezone` on the policy input                  | a policy needs them                                                                                 |

---

## 10. Acceptance, against QSpec issue #1

| QSpec issue #1                                                                          | Met by                                                                            |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Forward `ExecutionContext.metadata` to `DataSourceContext.metadata`, read-only          | 3.10; the metadata tests in section 8                                             |
| A seam that sees the compiled query and parameter names, never bound values, and can reject before the source runs | 3.1, 3.2, 3.4; the sentinel and source-call-count tests; the PostgreSQL sequence test |
| Open question: registry or single interceptor                                           | 3.1: registry                                                                     |
| Open question: stage 7 issue list or distinct error code                                | 3.6: distinct code carrying an issue list                                         |
| Open question: does `prepare()` run policies                                            | 3.3: no                                                                           |
