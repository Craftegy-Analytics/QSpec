---
kind: dependency_management
name: npm Workspaces Monorepo with Lockstep Versioned Publishing
category: dependency_management
scope:
  - "**"
source_files:
  - package.json
  - package-lock.json
  - scripts/release-check.mjs
  - scripts/publish-packages.mjs
  - scripts/copy-schemas.mjs
  - packages/core/package.json
  - packages/cli/package.json
  - packages/react/package.json
  - packages/recharts/package.json
  - packages/postgres/package.json
  - packages/http/package.json
  - packages/sql/package.json
  - packages/charts/package.json
  - packages/transforms/package.json
  - packages/schema/package.json
  - packages/testing/package.json
---

## System / Approach

QSpec is a Node.js monorepo managed entirely with **npm workspaces** and a single root `package.json`. All workspace packages live under `packages/*` and are resolved by npm's workspace feature; there is no pnpm, Yarn, or Lerna involvement. The lockfile (`package-lock.json`) pins every transitive dependency to an exact tarball URL on the public npm registry — no vendoring, no private registries, no `overrides`/`resolutions` maps.

The repository enforces a **lockstep release model**: every publishable package declares the same exact version string (`"0.1.0"` in this snapshot) and inter-package dependencies pin that exact version (e.g. `"@qspecs/core": "0.1.0"`, not `^0.1.0`). A custom `scripts/release-check.mjs` validator rejects any divergence at release time, and `scripts/publish-packages.mjs` publishes packages in topological order derived from the dependency graph so a dependency is always on the registry before anything that requires it.

## Key Files

- `package.json` — root workspace declaration (`workspaces: ["packages/*"]`), shared devDependencies (TypeScript, Vitest, Prettier, React, testcontainers), and global scripts (`build`, `test`, `release:check`, `release:dry-run`).
- `package-lock.json` — canonical lockfile for all third-party dependencies across the workspace.
- `packages/*/package.json` — per-package manifests declaring name, version, `files`, `exports`, `publishConfig.access: "public"`, and either runtime `dependencies`/`peerDependencies` or `devDependencies` against other `@qspecs/*` packages.
- `scripts/release-check.mjs` — pre-publish validator that enforces one version across packages, presence of `files`/`exports`/`repository`, correct `repository.directory`, and exact-version pins between packages.
- `scripts/publish-packages.mjs` — ordered publisher that runs `npm pack --dry-run` tarball inspection, skips already-published versions, and invokes `npm publish -w <pkg> --access public`.
- `scripts/copy-schemas.mjs` — build-time asset copy invoked via `prebuild`; used by `packages/schema` to ship JSON Schema files.
- `.github/workflows/release.yml` — CI entry point that triggers the release pipeline.

## Architecture & Conventions

### Workspace layout

Each package is independently publishable (except `@qspecs/testing`, which is marked `private: true` and documented as "never published"). Packages follow a uniform manifest shape:

- `type: "module"` (ESM)
- `sideEffects: false`
- `engines.node: ">=22.19"`
- `files: ["dist"]` — only compiled output ships
- `exports` map exposing `.` and `./package.json`
- `publishConfig.access: "public"`
- `repository.url` pointing at `git+https://github.com/Craftegy-Analytics/QSpec.git` with `repository.directory` set to `packages/<name>`

### Inter-package dependency model

- Core runtime packages (`core`, `sql`, `schema`, `transforms`, `charts`, `http`) depend on `@qspecs/core` as a **peerDependency**, keeping them lightweight consumers of the core API.
- Higher-level integrations (`postgres`, `react`, `recharts`) declare additional peer deps (`@qspecs/sql`, `react`, `recharts`) so consumers choose compatible versions.
- The CLI (`@qspecs/cli`) lists internal packages as runtime `dependencies` because it bundles the full toolchain.
- Test-only packages (`testing`) are kept out of the publish surface via `private: true`.

### Versioning policy

All publishable packages share one version number enforced by `release-check.mjs`: if any package has a different `version` field, the check fails with a message stating that inter-package dependencies pin exact versions and must move together. There is no per-package version bumping workflow visible in the repo.

### Third-party dependency strategy

- All external libraries are declared with caret ranges (`^x.y.z`) in `dependencies`/`devDependencies`/`peerDependencies` and locked by `package-lock.json`.
- No private registry configuration, no `npmrc`, no `--registry` overrides, no `yarn.lock`/`pnpm-lock.yaml`.
- No vendored node_modules; the workspace relies on npm hoisting and symlink resolution.
- Runtime vs dev boundaries are explicit: heavy tooling (React, Recharts, testcontainers, @types/*) lives in `devDependencies` of consumer packages or the root, while only minimal runtime deps (e.g. `pg`, `ajv`) appear in `dependencies`.

### Release-time constraints enforced by scripts

- Every publishable package must have a `files` array; otherwise publishing would ship whatever happens to be on disk.
- Every publishable package must have an `exports` map.
- `publishConfig.access` must be `"public"` (scoped packages default to restricted).
- `repository.url` must match the `GITHUB_REPOSITORY` environment variable when running in CI (case-insensitive comparison); mismatches cause failure because npm's `--provenance` attestation will reject the publish.
- `repository.directory` must equal `packages/<dir>`.
- Any `@qspecs/*` dependency in `dependencies` or `peerDependencies` must resolve to another publishable package in the repo and must be pinned to the exact release version.
- Tarballs are inspected before publish: they must contain `dist/index.js` and nothing outside `dist/` (plus `package.json`, `README.md`, `LICENSE`, `LICENSE.md`).
- Already-published versions are skipped idempotently using `npm view <pkg>@<version> version`.

## Conventions & Constraints

| Area              | Convention / Constraint                                                          | Enforced By                              |
| ----------------- | -------------------------------------------------------------------------------- | ---------------------------------------- |
| Package manager   | npm workspaces under `packages/*`                                                | Root `package.json`                      |
| Lockfile          | `package-lock.json` committed, no overrides/resolutions                          | Repo state                               |
| Versioning        | Single lockstep version across all publishable packages                          | `scripts/release-check.mjs`              |
| Internal deps     | Exact version pins between `@qspecs/*` packages                                  | `release-check.mjs` + manual convention  |
| Peer deps         | Optional runtime frameworks (React, Recharts, pg) declared as `peerDependencies` | Package manifests                        |
| Private packages  | Marked `private: true` (e.g. `@qspecs/testing`)                                  | Package manifests                        |
| Published surface | Only `dist/` shipped via `files` allowlist                                       | `release-check.mjs` + tarball inspection |
| Registry access   | All scoped packages published with `--access public`                             | `publish-packages.mjs`                   |
| Provenance        | `--provenance` flag supported; requires matching `repository.url`                | `release-check.mjs` + npm                |
| Build artifact    | Each package builds via `tsc -p tsconfig.build.json`                             | Per-package scripts                      |
| Node engine       | `>=22.19` declared in every package                                              | Package manifests                        |
