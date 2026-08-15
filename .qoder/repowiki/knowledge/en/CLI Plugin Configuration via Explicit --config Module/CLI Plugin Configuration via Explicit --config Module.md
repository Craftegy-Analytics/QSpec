---
kind: configuration_system
name: CLI Plugin Configuration via Explicit --config Module
category: configuration_system
scope:
  - "**"
source_files:
  - packages/cli/src/internal/config.ts
  - packages/cli/src/commands/validate.ts
  - packages/cli/src/bin.ts
  - packages/cli/src/internal/config.test.ts
  - examples/qspec.config.js
---

## What system/approach is used

QSpec's configuration system is intentionally minimal and opt-in: the CLI (`qspec`) loads a user-supplied Node.js ES module as a **plugin registry** for manifest validation. There is no global config file, no environment-variable-driven settings, no feature-flag framework, and no runtime configuration loader beyond this single mechanism. The only configuration surface is:

- A `--config <path>` flag on the `validate` command (not supported by `inspect`).
- An ES module at that path that must export either a named `plugins` array or a default export shaped `{ plugins: [...] }`.
- Each element of `plugins` is a `QSpecPlugin` from `@qspecs/core` (e.g. `sql()`, `transforms()`, `charts()`).

The design deliberately avoids any implicit discovery — a `qspec.config.js` sitting next to a manifest is never loaded unless explicitly passed on the command line. Loading arbitrary code is treated as a security boundary; omitting `--config` runs zero user code and performs structural-only validation.

## Key files and packages

- `packages/cli/src/internal/config.ts` — Core loader: `loadConfig(path)` resolves against `process.cwd()`, dynamically imports via `import(pathToFileURL(resolvedPath).href)`, validates the shape, and returns a `QSpecConfig { plugins: readonly QSpecPlugin[] }`. Throws a typed `ConfigError` for missing files and malformed shapes.
- `packages/cli/src/commands/validate.ts` — Consumes the config: when `options.configPath` is present it builds a plugin runtime with stub data sources so `prepare()` can run without executing queries.
- `packages/cli/src/bin.ts` — Parses `--config` via `node:util.parseArgs`, enforces that `inspect` rejects `--config`, and passes the path into `runValidate`.
- `examples/qspec.config.js` — Example config showing the expected shape: `export const plugins = [sql(), transforms(), charts()]`.
- `packages/cli/src/internal/config.test.ts` — Exhaustive tests covering both export forms, precedence (named `plugins` over default), error cases (missing file, thrown errors, non-array, non-object entries), and the explicit-discovery invariant.

## Architecture and conventions

1. **Explicit-path-only loading.** `loadConfig` resolves the given string against `process.cwd()` and calls `import()` on its `file:` URL. No fallback search, no walking up directories, no default filename resolution. This is enforced in code comments and tested by creating a `qspec.config.js` in cwd and asserting it is not loaded when an unrelated path is passed.

2. **Two accepted shapes, deterministic precedence.** The loader first checks for a named `plugins` export; if absent, falls back to `default.plugins`. If both are present, the named export wins — documented as intentional so authors who define both do not silently lose one.

3. **Strict shape validation before use.** After extracting `plugins`, the loader asserts it is an array and that every element is a non-null, non-array object. Errors are wrapped in `ConfigError` with a message naming the resolved path and the offending index (e.g. `plugins[1]`).

4. **User-code execution is gated behind a flag.** The help text and the `validate` command's `RunValidateOptions` document that `--config` executes arbitrary code and is omitted by default. Without it, `runValidate` performs only structural validation (`parseManifest` + `validateManifestStructure` + JSON Schema check) and never touches plugins.

5. **Stub data sources during validation.** When a config is loaded, `buildPluginRuntime` registers a per-source stub `DataSource` whose `execute()` always throws, ensuring manifests cannot trigger real I/O while still allowing `prepare()` to resolve `spec.query.source` names. Real sources provided by the config take priority over stubs.

6. **No other configuration mechanisms exist in this repo.** There are no `.env` files, no YAML/TOML/JSON config loaders, no environment variable parsing, and no feature flags. The monorepo uses standard tooling configs (`tsconfig.json`, `vitest.config.ts`, `.prettierrc.json`) but those are build/test tooling, not application configuration.

## Conventions and constraints

- **Config modules must be ES modules** (the example uses `.js` with ESM `import`/`export`; tests write `.mjs` files). The loader uses dynamic `import()`, so CommonJS-only configs will fail at import time.
- **Only the `validate` subcommand accepts `--config`.** Passing it to `inspect` produces an error and exit code 2, enforced in `bin.ts`.
- **Config is never auto-discovered.** A config file must be referenced explicitly on the CLI. This is a security constraint: "loading a config executes arbitrary code" and therefore must stay opt-in.
- **Plugins are the sole configuration primitive.** The config object has exactly one property, `plugins`, which is a read-only array of `QSpecPlugin` instances. There is no room for additional config keys — adding new ones would require changing `extractConfig` and the `QSpecConfig` interface.
- **Errors from the config module itself are surfaced unchanged.** Only missing-file errors are translated into `ConfigError`; top-level `throw`s inside the config module propagate verbatim, letting authoring mistakes produce clear stack traces.
