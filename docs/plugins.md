# Plugins

`@qspecs/core` registers exactly one capability itself — the `Dataset` resource kind
(`packages/core/src/internal/runtime.ts`) — and nothing else. Every query language, data source,
transform, semantic type, additional resource kind, presentation type, renderer, and execution
policy reaches a `QSpec` runtime through a **plugin** (SPEC.md §6, §50). This document covers the
plugin shape, the `QSpecPluginAPI` a plugin's `setup()` receives, the eight capability registries,
the order in which plugins are installed and can observe or override one another, and how
execution policies are evaluated.

```ts
import { definePlugin } from "@qspecs/core";

export const myPlugin = definePlugin({
  name: "my-qspec-plugin",
  setup(api) {
    api.transforms.register("normalize-score", {
      execute(dataset, spec) {
        return dataset;
      },
    });
  },
});
```

(SPEC.md §105's own target shape, reflowed slightly — a blank line and a `// implementation`
comment removed — but otherwise unchanged.) Installed with `.use()`:

```ts
const qspec = createQSpec().use(myPlugin);
```

For a worked walkthrough of writing a new transform or data source rather than just installing
one, see [Plugin Authoring](plugin-authoring.md).

## The `QSpecPlugin` shape

A plugin is a plain object (`packages/core/src/types/plugin.ts`):

```ts
export interface QSpecPlugin {
  readonly name: string;
  readonly version?: string;
  setup(api: QSpecPluginAPI): void | Promise<void>;
}
```

`definePlugin` (`packages/core/src/define.ts`) does no runtime work at all — it is the identity
function, present only so an editor can autocomplete against `QSpecPlugin`'s shape without a
plugin author needing to import or understand any runtime internals (SPEC.md §105's explicit
goal). A plugin object built by hand, with no `definePlugin` wrapper, works identically; nothing
downstream distinguishes the two.

`name` is more than documentation: it is the key `qspec.ready()` uses to detect a plugin
installed twice (see [Load order](#load-order-and-installation) below), and it appears in every
diagnostic a setup failure produces. `version` is declared on the type but, as of this writing,
never read anywhere in this repository — `docs/known-gaps.md` records it under "Plumbed but never
read." SPEC.md §79 recommends a plugin declare its compatible `@qspecs/core` range through its
package's own `peerDependencies` instead (see [Specification Versioning](specification-versioning.md#plugin-version-compatibility-specmd-79)
for what this repository's packages actually declare there); `QSpecPlugin.version` is not that
mechanism and today has no effect on `use()`, `ready()`, or capability resolution.

## `setup(api)` and the eight registries

`setup` receives a `QSpecPluginAPI` (`packages/core/src/types/plugin.ts`) — one `Registry<T>` per
capability, plus three cross-cutting handles:

```ts
export interface QSpecPluginAPI {
  readonly queryLanguages: Registry<QueryLanguage>;
  readonly sources: Registry<DataSource>;
  readonly transforms: Registry<Transform>;
  readonly semanticTypes: Registry<SemanticType>;
  readonly resources: Registry<ResourceKind>;
  readonly presentations: Registry<PresentationType>;
  readonly renderers: Registry<Renderer>;
  readonly policies: Registry<ExecutionPolicy>;
  readonly hooks: { readonly on: HookRegistry["on"] };
  readonly logger: QSpecLogger;
  readonly limits: Readonly<QSpecLimits>;
}
```

Every one of QSpec's registry-driven capabilities (SPEC.md §6) is one of these eight registries:
adding a new query language, data source, transform, semantic type, resource kind, presentation
type, renderer, or execution policy never requires a change to `@qspecs/core` itself, only a
plugin that registers into the matching one. `policies` is the eighth, added in 0.2.0: see
[Execution policies](#execution-policies) below.

`hooks` exposes only `.on`: plugins observe the runtime's lifecycle events
(`manifest:parse:start`, `validation:end`, and the rest — SPEC.md §68), they never emit one
themselves (design §2.9, cited in [`docs/architecture.md` §4](architecture.md#4-resolved-design-decisions)).
`logger` is the runtime's own configured `QSpecLogger` (SPEC.md §85) — the same object a data
source's `DataSourceContext.logger` is built from per execution — and `limits` is the runtime's
resolved `QSpecLimits` (SPEC.md §72.5), captured once here rather than read from a module-scope
global: `@qspecs/transforms`' `filter` and `derive` both close over `api.limits.maxExpressionDepth`
at `setup()` time for exactly this reason (see [Transforms](transforms.md#maxexpressiondepth)).

## The `Registry<T>` interface

Every one of the eight registry fields above is built by the same `createRegistry`
(`packages/core/src/internal/registry.ts`):

```ts
export interface Registry<T> {
  register(name: string, implementation: T): void;
  replace(name: string, implementation: T): void;
  get(name: string): T | undefined;
  has(name: string): boolean;
  list(): readonly string[];
}
```

- **`register`** throws `PluginRegistrationError` for an empty name, and throws the same error if
  `name` is already registered — "A `<label>` named `<name>` is already registered. Use replace()
  if overriding it is intentional." A capability name is never silently overwritten by `register`.
- **`replace`** takes the same two arguments and has no _duplicate_ check: an already-registered
  `name` is overwritten silently instead of throwing, whether or not `name` was previously
  registered. (It keeps `register`'s empty-name guard — `replace("", …)` still throws
  `PluginRegistrationError` — only the duplicate check is dropped.) `replace`'s overwrite behavior
  is unit-tested directly against the registry (`packages/core/src/internal/registry.test.ts`); the
  composite scenario — installing the first plugin's implementation with `register`, overriding it
  with a second plugin's `replace`, and confirming that the _second_ implementation is the one
  `prepare()` later resolves — follows from that unit-tested overwrite behavior plus
  `runtime.ts`'s registration-order guarantee, but is not itself exercised end to end by any test
  in this repository.
- **`get`**/**`has`**/**`list`** are straightforward lookups; `list()` returns names sorted
  alphabetically, which is what every "Registered kinds: …" / "Registered transforms: …" error
  message iterates over (`packages/core/src/internal/prepare.ts`). `list()` is alphabetical for
  `policies` too; the order policies are _evaluated_ in is registration order, which core reads
  from the registry's internal `Map`, not from `list()`.

Entries live in a `Map`, not a plain object, specifically so a capability legitimately named
`constructor` or `__proto__` behaves as an ordinary key rather than colliding with
`Object.prototype` (SPEC.md §72.4, `registry.ts`'s own comment) — the same prototype-pollution
discipline [Datasets](datasets.md#positional-rawqueryresult-versus-row-objects) and
[Transforms](transforms.md#rename)' `rename` document elsewhere in this pipeline.

## Load order and installation

`createQSpec().use(plugin)` **queues** a plugin; it does not run `setup()` synchronously
(`packages/core/src/internal/runtime.ts`). Nothing about a plugin's capabilities exists until
`qspec.ready()` — awaited automatically by the first `prepare()` or `execute()` call, or callable
directly — **drains** the queue, running each queued plugin's `setup(api)` in the exact order
`.use()` was called, one at a time, awaiting each before starting the next. This was verified
directly: two plugins queued via `.use(pluginA).use(pluginB)` run `pluginA`'s `setup` to
completion, then `pluginB`'s — never interleaved, never reordered.

That ordering is what makes `replace()` meaningful as an override mechanism: a plugin installed
later can call `api.transforms.replace("filter", myFilter)` to swap out an earlier plugin's
`filter` implementation, and every `prepare()` call afterward resolves the later plugin's version —
`.use()` order **is** override precedence. A plugin that wants to layer strictly additive
capability, with no risk of silently shadowing an earlier plugin, should use `register` and accept
the thrown `PluginRegistrationError` on a genuine name collision as a signal something is wrong,
rather than reaching for `replace` defensively.

A few properties worth knowing before relying on install order:

- **Re-queuing a plugin with an already-installed name throws**, even across two separate `.use()`
  calls with unrelated plugin objects — the collision is on `name`, checked once each queued
  plugin's `setup` actually runs, not on object identity.
- **A `setup()` failure poisons the runtime.** If any plugin's `setup` throws (or its returned
  promise rejects), that error is wrapped in `PluginRegistrationError` (unless it is already a
  `QSpecError`, which passes through unchanged) and every later `ready()` call — including ones
  from a `prepare()`/`execute()` invoked well after the failure — rethrows the same stored error
  rather than attempting to drain again. The capability registries are left in whatever half-built
  state the failed `setup()` left them in; there is no partial-install rollback.
- **Concurrent `ready()` calls share one in-flight drain.** Calling `prepare()` on two manifests at
  once before any plugin has finished installing does not run `setup()` twice or interleave two
  drains — both calls await the same in-progress pass, and a plugin queued via a `.use()` that
  lands mid-drain is picked up by that same pass rather than starting a second one.

## Execution policies

An `ExecutionPolicy` (`packages/core/src/types/policy.ts`) approves or rejects one execution after
its query is compiled and before its data source runs (SPEC.md §110):

```ts
import { definePlugin, type ExecutionPolicy } from "@qspecs/core";

const onlyKnownSources: ExecutionPolicy = {
  check({ query }) {
    if (query === undefined || query.source === "analytics") return { outcome: "allow" };
    return {
      outcome: "deny",
      issues: [{ code: "source", message: "Unknown source.", path: ["spec", "query", "source"] }],
    };
  },
};

export const governance = definePlugin({
  name: "my-governance",
  setup(api) {
    api.policies.register("only-known-sources", onlyKnownSources);
  },
});
```

**What a policy sees.** One frozen `ExecutionPolicyInput` per execution: the `executionId`, the
resource's `kind` and `name`, the prepared (deep-frozen) manifest, the frozen, null-prototype copy
of `ExecutionContext.metadata`, the caller's `signal`, and, when the resource declares `spec.query`,
its `language`, `source`, each binding resolved to what it reads (`{ kind: "parameter", parameter }`
or `{ kind: "literal" }`, never a value) and `view`: the query language's `policyView(compiled)`,
deep-frozen. A policy never sees a caller-supplied value: no parameter value, and nothing resolved
from one. What the manifest itself declares, binding literals and parameter defaults included, is
readable through `manifest`. `view` is `unknown` to core; narrow it with the
language package's guard (`isSqlPolicyView` from `@qspecs/sql`) and deny anything else. A language
that defines no `policyView` hands policies `view: undefined`.

**When it runs.** On every `execute()`, after `query:compile:end` and before the data source, so
the view a policy approves is derived from the very object the source receives. A resource without
`spec.query` runs its policies right after parameter validation, with `query: undefined`.
`prepare()` never runs policies: a policy decision depends on the host's configuration at that
moment and on the execution's metadata, neither of which a long-lived prepared plan can know. Core
caches no verdict; a policy caches what it can prove is pure (a parse tree keyed by the statement
text, for instance). Policy time is not covered by `limits.queryTimeoutMs`, which scopes the source
call only. Policies receive the caller's signal and should honor it, but core does not depend on
that: when the signal aborts while a `check` is pending, core stops waiting at once, rejects with
`QSpecAbortError`, and ignores whatever the check later returns or throws.

**Parameters are validated before policies run.** Stage 3 (parameter validation) runs before the
policy step, for queries and query-less resources alike. A caller whose parameters are invalid
therefore gets `ParameterValidationError` (a 400 over `@qspecs/http`, whose issues can name a
parameter's declared constraints, such as an enum's allowed values) without any policy being
consulted and without a `policy:decision` event. A policy decides whether an execution of
validated parameters may run; it is not the place to decide whether a caller may use a resource
at all. That resource-level authorization belongs in front of QSpec (around
`createQSpecHandler`, or before `execute()`), or in a future pre-validation phase the policy design
reserves; see `docs/known-gaps.md`.

**Plugin setup is settled first.** Every `PreparedResource.execute()` awaits the runtime's
`ready()` before it reads the policy list, so a policy plugin queued after `prepare()` still
guards a resource prepared earlier (`@qspecs/http` keeps one per resource for the handler's
lifetime), and a plugin whose `setup()` failed (a policy whose parser did not load, say) stops
every later execution with that setup error, before any source runs.

**Order.** Policies run one after another in registration order, which is `.use()` order across
plugins. The first denial stops evaluation: later policies do not run. `replace(name, policy)` on a
registered name keeps that policy's position; on a new name it appends. With no policy registered,
nothing about an execution changes, and `policyView` is never called.

**Fail closed.** Anything but a well-formed decision denies or fails, never allows:

| What the policy does                                                               | Result                                                                    |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| returns `{ outcome: "allow" }`                                                     | the next policy, then the source                                          |
| returns `{ outcome: "deny", issues }`                                              | `ExecutionDeniedError` (`QSPEC_EXECUTION_DENIED`) with those issues       |
| returns `{ outcome: "deny", issues: [] }`                                          | `ExecutionDeniedError` with one core issue, code `QSPEC_EXECUTION_DENIED` |
| throws `ExecutionDeniedError`                                                      | rebuilt with the **registered** policy name                               |
| anything, while the caller's signal is aborted (or never settles before it aborts) | `QSpecAbortError`                                                         |
| throws `AbortError`, `TimeoutError` or `QSpecAbortError` while the signal is live  | `ExecutionPolicyError`: the policy's own failure, not a client abort      |
| throws anything else, including another `QSpecError`                               | `ExecutionPolicyError` (`QSPEC_POLICY_FAILED`), the throw as `cause`      |
| returns anything else (`undefined`, an unknown outcome, a malformed issue)         | `ExecutionPolicyError`                                                    |

Issue `code`s are the policy's own (stable rule IDs) and issue paths are **absolute** manifest
paths, not rebased the way `validate` hooks' are: a policy sees the whole manifest and may point
anywhere. Core rebuilds every issue rather than copying it: it reads `code`, `message`, `path` and
`suggestion` once each, keeps nothing else, and requires every path segment to be a string or a
finite number; anything else fails closed as `ExecutionPolicyError`. The reported issues are
frozen. The error's message names the policy and the issue count only, never an issue message.
A policy that tries to write to its input, its view or its metadata throws (they are frozen) and
so fails closed.

**Audit.** Each policy evaluated emits one `policy:decision` event carrying `executionId`,
`resource`, `policy`, `outcome` (`"allow"`, `"deny"` or `"error"`), `codes` and `durationMs`: issue
codes for a denial, the error's code for a failure, nothing else. A failed execution still ends with
`execution:error`, whose `code` is `QSPEC_EXECUTION_DENIED` or `QSPEC_POLICY_FAILED`. Hooks stay
observers: a host that must refuse to run when its audit write fails writes the record from a
policy, which may be asynchronous and may deny.

**What a policy must never log.** Core never logs metadata or puts it (or its keys) in an event,
an error or `ExecutionMetadata`, and a policy must not either: metadata values are the host's own
references (a transaction, a viewer) and its issue messages must not echo them. The same applies
to anything a policy derives from the manifest's statement that should stay on the server: the
issues are on the thrown error for the host that catches it, and `@qspecs/http` keeps them off the
wire (403, no issues). `@qspecs/testing`'s `runExecutionPolicyContractTests` is the acceptance bar;
see [Plugin Authoring](plugin-authoring.md#writing-an-execution-policy).

## What ships as a plugin today

Every non-core capability in this repository is a plugin factory function returning a
`QSpecPlugin`, installed with `.use()`:

| Function            | Package              | Registers                                                             |
| ------------------- | -------------------- | --------------------------------------------------------------------- |
| `sql()`             | `@qspecs/sql`        | the `sql` query language                                              |
| `postgres(options)` | `@qspecs/postgres`   | one `DataSource` per configured logical source name                   |
| `transforms()`      | `@qspecs/transforms` | `filter`, `derive`, `sort`, `limit`, `select`, `rename`               |
| `charts()`          | `@qspecs/charts`     | the `Chart` resource kind, and `line`/`bar`/`area`/`scatter`/`pie`    |
| `memory(options)`   | `@qspecs/testing`    | an in-memory `DataSource` plus a pass-through `memory` query language |

`@qspecs/http`'s `createQSpecHandler` and `@qspecs/react`'s `QSpecProvider`/hooks are **not**
plugins — they consume an already-built `QSpec` runtime (or, for `@qspecs/react`, an executor built
on top of one) rather than registering capabilities into it. See [CLI](cli.md) for how
`qspec validate --config` loads a list of plugins from a config module, and
[Plugin Authoring](plugin-authoring.md) for how to write a new one.

## See also

- [`docs/plugin-authoring.md`](plugin-authoring.md) — a worked walkthrough of writing a transform
  and a data source, and the contract suites that are the acceptance bar for each.
- [`docs/architecture.md` §5](architecture.md#5-plugin-authoring-specmd-105) — `definePlugin`,
  `QSpecPluginAPI`, and the same "registration happens during `ready()`" guarantee, in the context
  of how this repository implements SPEC.md end to end.
- [`docs/transforms.md`](transforms.md) and [`docs/data-sources.md`](data-sources.md) — the two
  capability interfaces most third-party plugins implement.
- [`docs/specification-versioning.md`](specification-versioning.md#plugin-version-compatibility-specmd-79) —
  how a plugin declares which `@qspecs/core` versions it is compatible with.
- [`docs/cli.md`](cli.md#plugin-aware-validation---config) — loading a list of plugins from a
  `--config` module for static validation without a database.
