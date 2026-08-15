---
kind: error_handling
name: Structured QSpecError Hierarchy with Issue Aggregation and CLI Diagnostics
category: error_handling
scope:
  - "**"
source_files:
  - packages/core/src/errors.ts
  - packages/core/src/errors.test.ts
  - packages/core/src/define.ts
  - packages/cli/src/commands/validate.ts
  - packages/cli/src/internal/config.ts
---

## Overview

QSpec uses a dedicated, typed error hierarchy centered on `QSpecError` (defined in `packages/core/src/errors.ts`) rather than ad-hoc `throw new Error(...)` calls. Every domain error is a subclass of `QSpecError`, carries a stable machine-readable `code` string, an optional JSON-Path-like `path`, and optional `details`/`cause`. Validation errors that have multiple independent problems are aggregated into a single throw via the `AggregateQSpecError` base class and its concrete subclasses (`ManifestValidationError`, `ParameterValidationError`, `DatasetValidationError`, `PresentationError`), which expose a structured `issues: readonly QSpecIssue[]` array.

The CLI layer (`packages/cli/src/commands/validate.ts`) is the sole consumer-facing renderer: it catches errors from core, normalizes them through `toIssues()` (which lifts both aggregate `issues` arrays and single-issue `QSpecError`s carrying `details.suggestion` + `error.path`), and prints them via `printIssues()`, which formats paths with `formatPath()` (e.g. `spec.presentation.series[0].field`) and optionally shows "Did you mean ...?" hints.

## Core error types and codes

All errors live in `packages/core/src/errors.ts`:

| Class                        | Stable code                        | Purpose                                                                                                        |
| ---------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `QSpecError`                 | user-supplied                      | Base for every QSpec error; sets `name = "QSpecError"` and forwards `cause` to the native `Error` constructor. |
| `ManifestValidationError`    | `QSPEC_MANIFEST_INVALID`           | Aggregate validation failure for manifest structure.                                                           |
| `ParameterValidationError`   | `QSPEC_PARAMETER_INVALID`          | Aggregate parameter validation failure.                                                                        |
| `DatasetValidationError`     | `QSPEC_DATASET_INVALID`            | Aggregate dataset field/type validation failure.                                                               |
| `PresentationError`          | `QSPEC_PRESENTATION_INVALID`       | Aggregate presentation/chart spec validation failure.                                                          |
| `UnsupportedApiVersionError` | `QSPEC_API_VERSION_UNSUPPORTED`    | Single issue at path `["apiVersion"]`.                                                                         |
| `UnknownResourceKindError`   | `QSPEC_RESOURCE_KIND_UNKNOWN`      | Single issue at path `["kind"]`.                                                                               |
| `UnknownQueryLanguageError`  | `QSPEC_QUERY_LANGUAGE_UNKNOWN`     | Single issue at path `["spec", "query", "language"]`.                                                          |
| `UnknownDataSourceError`     | `QSPEC_SOURCE_NOT_FOUND`           | Single issue at path `["spec", "query", "source"]`.                                                            |
| `QueryCompilationError`      | `QSPEC_QUERY_COMPILATION_FAILED`   | Query compilation failure.                                                                                     |
| `QueryExecutionError`        | `QSPEC_QUERY_FAILED`               | Runtime query execution failure.                                                                               |
| `TransformError`             | `QSPEC_TRANSFORM_FAILED`           | Transform step failure.                                                                                        |
| `PluginRegistrationError`    | `QSPEC_PLUGIN_REGISTRATION_FAILED` | Plugin registration failure.                                                                                   |
| `QSpecAbortError`            | `QSPEC_EXECUTION_ABORTED`          | Execution cancelled via `AbortSignal` (SPEC §60).                                                              |
| `LimitExceededError`         | `QSPEC_LIMIT_EXCEEDED`             | Resource limit exceeded (SPEC §72.5); used by `parseManifest` when `maxBytes` is breached.                     |

Each subclass hard-codes its `name` and `code` so callers can do `error instanceof QSpecError` checks and switch on `error.code` without fragile string matching against class names.

## Path representation and diagnostics

Paths are `readonly PathSegment[]` where each segment is a string key or numeric array index. `formatPath(path)` renders them as dotted/indexed notation per SPEC §71 — e.g. `spec.presentation.series[0].field` — and bracket-quotes non-identifier keys like `from-date`. The CLI's `printIssues()` uses this formatter to produce human-readable location lines.

## Where errors are thrown

- **Manifest parsing** (`packages/core/src/define.ts`): `parseManifest` throws `LimitExceededError` when the input exceeds `maxBytes`, wraps `JSON.parse` failures into `ManifestValidationError` with a single `QSpecIssue`, and rejects unsafe prototype-polluting keys via a recursive `assertNoUnsafeKeys` walk that also tracks cycles using a `WeakSet`.
- **CLI config loading** (`packages/cli/src/internal/config.ts`): defines a separate `ConfigError extends Error` (not a `QSpecError`) for configuration-module shape errors. It re-throws import-time errors from the user's config module unchanged, only translating `ERR_MODULE_NOT_FOUND` into a `ConfigError` naming the resolved path. A helper `describe(value)` produces consistent "expected X, found Y" messages.
- **CLI validation command** (`packages/cli/src/commands/validate.ts`): catches file-read and parse errors, runs structural + JSON Schema validation in lockstep (a mismatch triggers an internal error message), then conditionally runs plugin-aware `prepare()` with stubbed data sources so validation never executes queries.

## Conventions enforced by tests

`packages/core/src/errors.test.ts` asserts, for every concrete error class, that:

1. `error.code` equals the documented constant.
2. `error.name` equals the class name.
3. `error instanceof QSpecError` and `instanceof Error`.
4. Any error that should carry a fixed path does so (e.g. `UnsupportedApiVersionError.path === ["apiVersion"]`).

This test suite acts as a contract: adding a new error class requires registering it in the `errorCases` table so the same assertions run against it.

## Architecture decisions

- **Single base class**: All QSpec errors derive from `QSpecError`; there is no mixed use of plain `Error` outside the CLI's own `ConfigError` (which is intentionally scoped to config loading and not surfaced to users as a QSpec diagnostic).
- **Aggregation over early return**: Validation collects all issues into `QSpecIssue[]` and throws one `AggregateQSpecError`, letting callers report the full set of problems instead of failing fast on the first one.
- **Stable codes**: Every error has a `QSPEC_*`-prefixed code string that is independent of the class name, enabling programmatic handling across package boundaries.
- **Cause chaining**: Errors preserve underlying causes via the standard `Error.cause` option, so stack traces remain inspectable while still exposing the structured surface.
- **CLI isolation**: User-facing formatting lives exclusively in the CLI package; core packages throw pure errors and leave rendering to consumers.
- **No panics / no try-recover**: The codebase uses structured exceptions throughout; there are no `try { ... } catch (e) { process.exit(...) }` patterns inside core logic, and no `process.exit` calls in library code.

## Key files

- `packages/core/src/errors.ts` — error base class, aggregate base, all concrete error classes, `QSpecIssue` type, `formatPath`.
- `packages/core/src/errors.test.ts` — invariant tests asserting every error's `code`, `name`, inheritance, and fixed `path`.
- `packages/core/src/define.ts` — manifest parsing boundary that throws `LimitExceededError` and `ManifestValidationError`.
- `packages/cli/src/commands/validate.ts` — CLI error-to-diagnostics pipeline (`toIssues`, `printIssues`, `runValidate`).
- `packages/cli/src/internal/config.ts` — `ConfigError` and config-module loading with explicit shape validation.
