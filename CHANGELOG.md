# Changelog

Every package is released in lockstep (see [`RELEASING.md`](RELEASING.md)), so one entry covers all
of them.

## Unreleased (planned as 0.2.0)

Execution policies and metadata forwarding (QSpec issue #1; design:
[`docs/superpowers/specs/2026-11-01-qspec-execution-policy-design.md`](docs/superpowers/specs/2026-11-01-qspec-execution-policy-design.md)).

### Added

- **`@qspecs/core`: execution policies.** An eighth registry, `api.policies`, holds
  `ExecutionPolicy` implementations. Every registered policy runs on each `execute()`, in
  registration order, after the query is compiled and before the data source; the first denial
  wins and the data source is never called. A resource without `spec.query` runs its policies
  right after parameter validation. `prepare()` never runs policies. With no policy registered,
  nothing changes.
- **`@qspecs/core`: what a policy sees.** One frozen `ExecutionPolicyInput`: the execution id, the
  resource, the prepared manifest, the frozen metadata, the caller's signal and, for a query, its
  language, source, bindings described as `{ kind: "parameter", parameter }` or
  `{ kind: "literal" }`, and `view`, the language's new optional `QueryLanguage.policyView(compiled)`,
  deep-frozen by core. Never a caller-supplied value; what the manifest declares (binding literals,
  parameter defaults) is readable through the manifest.
- **`@qspecs/core`: errors and events.** `ExecutionDeniedError` (`QSPEC_EXECUTION_DENIED`, carries
  `policy` and `issues` with absolute manifest paths), `ExecutionPolicyError`
  (`QSPEC_POLICY_FAILED`, a policy that threw or returned a malformed decision: fail closed),
  `ExecutionContextError` (`QSPEC_EXECUTION_CONTEXT_INVALID`), and one `policy:decision` lifecycle
  event per policy evaluated (codes and duration only).
- **`@qspecs/core`: `ExecutionContext.metadata` reaches data sources** as
  `DataSourceContext.metadata`: one frozen, null-prototype shallow copy per execution, the same
  object every policy
  saw. Core never logs it or puts it in an event, an error or `ExecutionMetadata`.
- **`@qspecs/core`: `describeBinding(binding)`**, design §2.1's binding rule, now the single
  definition `prepare()`, `qspec validate` and the policy input all classify bindings through.
- **`@qspecs/sql`:** the `sql` language's `policyView`; `SqlPolicyView`, `isSqlPolicyView`,
  `sqlPolicyView(definition)` (the same view computed statically, for admission checks), and the
  scanner itself, `scanSql` and `ScanResult`.
- **`@qspecs/http`:** `createQSpecHandler` answers `ExecutionDeniedError` with 403 and a body of
  exactly `{ code: "QSPEC_EXECUTION_DENIED", message }`, a fixed message and no issues. A failing
  policy is the generic 500.
- **`@qspecs/testing` (private):** `runExecutionPolicyContractTests` (with an optional
  `metadataKeys` fixture field naming the metadata keys a policy reads), and a `policyView` on
  `memory()`'s pass-through language.
- **`@qspecs/core`: a prepared resource waits for plugin setup.** `PreparedResource.execute()` now
  awaits the runtime's `ready()` first, so a policy plugin queued after `prepare()` guards it, and
  a plugin setup failure stops it (with that setup error) before any data source runs. Before, only
  `prepare()` waited.
- **Policy failures are attributed precisely.** A pending `check` is abandoned the moment the
  caller's signal aborts (`QSpecAbortError`; a late result is ignored). An `AbortError`,
  `TimeoutError` or `QSpecAbortError` a policy throws while the signal is live is
  `ExecutionPolicyError`, not an abort. Issues are rebuilt field by field (path segments must be
  strings or finite numbers), and a `policyView` throw becomes a `QueryCompilationError` with no
  `cause`.

### Changed (breaking under 0.x semver)

- **`ExecutionContext.metadata` must be `undefined` or a plain object.** 0.1.0 accepted and ignored
  any value; now anything else (a class instance, a `Map`, an array, `null`) rejects the execution
  with `ExecutionContextError` before parameters are validated. Wrap the value instead:
  `metadata: { scope: instance }`.
- **`QSpecPluginAPI.policies` is a required member.** Code that builds a `QSpecPluginAPI` by hand,
  usually a test fake, must add it.
- **`"policy:decision"` joins `QSpecEventMap`**, and three error codes are new: exhaustive switches
  over event names or error codes must handle them.

### Not included

- `@qspecs/http` has no `metadata(request)` option yet, so executions served by
  `createQSpecHandler` carry no metadata. Recorded with its reopen trigger in
  [`docs/known-gaps.md`](docs/known-gaps.md).

### Migration

- **Plugins** declare a caret peer range on the core minor they are tested against; on 0.x a caret
  covers one minor, so move it to `^0.2.0` and re-run your contract suites. A query language
  should implement `policyView`: without it, a fail-closed policy denies every execution in that
  language. A data source may read `context.metadata` and must not log it.
- **Hosts** that register no policy see no behaviour change, apart from the `metadata` rule above.
  To adopt: install a policy plugin with `.use()`, pass per-execution context as
  `execute({ ..., metadata })`, and handle `QSPEC_EXECUTION_DENIED`.
