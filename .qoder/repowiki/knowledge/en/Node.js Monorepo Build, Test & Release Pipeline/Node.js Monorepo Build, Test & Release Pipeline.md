---
kind: build_system
name: Node.js Monorepo Build, Test & Release Pipeline
category: build_system
scope:
  - "**"
source_files:
  - package.json
  - tsconfig.base.json
  - vitest.config.ts
  - .github/workflows/ci.yml
  - .github/workflows/release.yml
  - RELEASING.md
  - scripts/copy-schemas.mjs
  - scripts/release-check.mjs
  - scripts/publish-packages.mjs
---

## System overview

QSpec is a Node.js monorepo built with **npm workspaces** (`packages/*`), **TypeScript project references** (`tsc --build`), and **Vitest** for testing. There are no Makefiles or Dockerfiles; the entire build surface is driven by `package.json` scripts and two GitHub Actions workflows (`ci.yml`, `release.yml`).

### Build

- `npm run build` runs `tsc --build` using the root `tsconfig.json`, which composes per-package configs that extend `tsconfig.base.json`. The base sets ES2022 target, `module: NodeNext`, strict mode, `declaration` + `declarationMap` + `sourceMap` output, and `composite` so packages can reference each other.
- `prebuild` executes `scripts/copy-schemas.mjs`, which copies the canonical JSON schemas from `schemas/` into `packages/schema/src/schemas/` so the schema package ships the latest version of the spec alongside its code.
- `npm run clean` runs `tsc --build --clean` to remove all generated artifacts across packages.

### Test

- `npm test` runs `vitest run`; `npm run test:watch` starts the watcher. `vitest.config.ts` configures an automatic JSX transform (matching the repo's `react-jsx` setting) and includes both per-package tests (`packages/*/src/**/*.test.{ts,tsx}`, `packages/*/test/**/*.test.ts`) and top-level integration suites under `test/`.
- Integration suites use **testcontainers** to spin up real PostgreSQL containers at runtime (`@testcontainers/postgresql`, `pg` as devDependencies). CI verifies those suites actually ran by grepping the verbose log and parsing the JSON reporter — a skipped container suite is treated as a failure because a skip looks identical to a pass in Vitest's summary.
- `npm run typecheck:tests` runs `tsc -p tsconfig.test.json` separately from the main build to catch test-only type errors.

### CI (`.github/workflows/ci.yml`)

- Matrix builds on **Node 22 and 24** (`actions/setup-node` with caching).
- Steps: `npm ci` → `format:check` → `build` → `typecheck:tests` → full test suite (with `--reporter=verbose --reporter=json --outputFile=/tmp/full-suite.json`) → post-run validation that the three container-backed suites (`packages/postgres/test/integration.test.ts`, `test/postgres-pipeline.test.ts`, `test/react-pipeline.test.tsx`) actually executed and had zero skips/failures → `npm pack --dry-run` on every non-private workspace → CLI validation of every fixture under `fixtures/valid/` and plugin-aware validation of every example under `examples/` via `packages/cli/dist/bin.js validate --config examples/qspec.config.js`.

### Release (`.github/workflows/release.yml` + `RELEASING.md`)

- Triggered on tags matching `v*` (publish) or `workflow_dispatch` (dry-run only). Uses `id-token: write` so npm can exchange a GitHub OIDC token for **provenance attestations** linking each tarball to the commit and workflow run.
- Version resolution: tag pushes derive the version from `GITHUB_REF_NAME#v`; manual runs read it from `packages/core/package.json`. A strict semver regex rejects malformed tags.
- Pre-publish checks (all before any irreversible publish):
  - `scripts/release-check.mjs --expect-version <version>` validates lockstep versions across all publishable packages, exact inter-package pins, presence of `license`/`files`/`exports`/`repository`, `publishConfig.access: public`, and that no package depends on a private one.
  - `format:check`, `build`, `typecheck:tests`, full test suite, container-suite presence check.
  - `scripts/release-check.mjs --require-dist` asserts every package has `dist/index.js`.
  - `scripts/publish-packages.mjs --dry-run` packs each workspace, inspects the tarball contents (must contain `dist/index.js` and nothing outside `dist/` plus README/LICENSE), and runs `npm publish --dry-run`.
- Publishing: `scripts/publish-packages.mjs --provenance` publishes in **dependency order** derived via a topological sort of the workspace graph (not a hardcoded list), skipping already-published versions (idempotent resume). Each package is published with `--access public`.
- Lockstep release policy: every package must share the same version because inter-package dependencies pin exact versions (e.g. `"@qspecs/core": "0.1.0"`, not `^0.1.0`). `@qspecs/testing` is `private` and never published.

### Key conventions

- All source is ESM (`"type": "module"` at the root); Node engine is pinned to `>=22.19`.
- Per-package `files` allowlists restrict what ends up in npm tarballs; the publish script enforces this pre-flight.
- Tests live both inside packages (`*.test.ts` next to sources) and at the repo root for cross-package boundary / end-to-end scenarios.
- Formatting is enforced via Prettier (`npm run format:check` in CI); no linter is configured at the root level.
