---
kind: logging_system
name: Pluggable QSpecLogger Contract with No Built-In Logger
category: logging_system
scope:
  - "**"
source_files:
  - packages/core/src/types/events.ts
  - packages/core/src/internal/runtime.ts
  - packages/core/src/types/plugin.ts
  - packages/postgres/src/internal/source.ts
  - SPEC.md
---

## What system/approach is used

QSpec does **not** ship a logging framework. Instead, it defines a minimal, library-agnostic `QSpecLogger` interface and injects it through the runtime into every plugin and execution context. The host application supplies its own logger (e.g. Pino, Winston, Bunyan, or a custom object) when constructing the QSpec runtime via `createQSpec({ logger })`. This keeps the core framework free of I/O dependencies and portable across Node.js and browser environments.

The contract is defined in `packages/core/src/types/events.ts` as:

```ts
export interface QSpecLogger {
  debug?(message: string, context?: unknown): void;
  info?(message: string, context?: unknown): void;
  warn?(message: string, context?: unknown): void;
  error?(message: string, context?: unknown): void;
}
```

All methods are optional — passing `{}` is valid and silently no-ops. Every call site uses the optional chaining form (`logger.warn?.(...)`, `logger.debug?.(...)`) so a missing method never throws.

## Key files and packages

- `packages/core/src/types/events.ts` — declares `QSpecLogger` alongside the event map and hook registry.
- `packages/core/src/internal/runtime.ts` — constructs the runtime internals, defaulting `options.logger ?? {}`, and exposes it to plugins via `pluginApi.logger` and to lifecycle hooks where they throw.
- `packages/core/src/types/plugin.ts` — types `DataSourceContext` and `QSpecPluginAPI` with a `logger: QSpecLogger` field, so every plugin receives one.
- `packages/postgres/src/internal/source.ts` — the only package that actively emits log calls today; uses both the per-execution `context.logger` (for query-scoped events) and the setup-time `api.logger` (for connection errors that occur outside any execution).
- `SPEC.md §85` — explicitly states "Core imposes no logging library".

## Architecture and conventions

1. **Two logger lifetimes.**
   - _Runtime/logger_ — created once by `createQSpec(options)` and passed into each plugin's `setup(api)`. Used for infrastructure-level events that can happen before any execution exists (e.g. Postgres pool connection errors, cancel-backend failures). See `packages/postgres/src/internal/source.ts` lines 72–76 and 300–304.
   - _Execution/context logger_ — attached to `DataSourceContext` and consumed inside `execute()` calls. Used for per-query events such as cancellation notices and backend PID logging.

2. **Log levels used in practice.**
   - `warn` — non-fatal operational problems: lifecycle handler exceptions, connection errors, failed backend cancellation, aborted queries whose PID was unknown.
   - `debug` — diagnostic tracing such as cancelling a backend PID on a separate connection.
   - `info` / `error` — not currently emitted by the codebase, but available on the contract for hosts to use.

3. **No structured fields beyond `context?: unknown`.** Messages are plain strings; structured data is passed as an opaque second argument. The Postgres source consistently passes plain message strings rather than objects, keeping downstream consumers free to interpret the shape.

4. **Security-by-design logging.** Driver errors from `pg` routinely embed connection strings. The code deliberately strips those details from log messages and attaches them only to the thrown error's `cause` property, documented at `SPEC.md §72.6`. Connection-error handlers wrap driver errors via `wrapDriverError` and log sanitized messages instead.

5. **Defensive against broken host loggers.** Every log call is guarded with optional chaining (`logger.warn?.(...)`), and several places wrap logger calls in try/catch blocks so a throwing host logger cannot crash the runtime (see Postgres connection error handler at lines 102–112 and the abort path comment at line 227–229).

## Conventions and constraints

- **Host-supplied only.** Core never instantiates a logger; `createQSpec` defaults to `{}`. Consumers must provide a logger if they want output.
- **Optional methods.** All four level methods are optional; a host may implement only `warn` and `error` without breaking callers.
- **No sensitive data in messages.** Per `SPEC.md §72.6`, connection strings and driver errors are never interpolated into log messages; they are attached to error `cause` properties instead.
- **Per-execution vs per-plugin scope.** Plugins receive two logger sources: `api.logger` (stable for the lifetime of the plugin instance) and `context.logger` (per execution). Use `api.logger` for events that can fire outside an execution (connection setup/teardown); use `context.logger` for events tied to a specific query execution.
- **Level discipline observed in this repo.** Operational warnings go to `warn`; detailed tracing goes to `debug`. There is no automatic log-level filtering — the host decides what to do with each level.
