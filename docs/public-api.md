# Public API

SPEC.md §104 requires the project to explicitly distinguish Public, Internal, and Experimental
API, states that "anything exported from stable package entry points should be treated as
public," that internal code should use paths not exposed through a package's `exports`, and that
implementation details should never leak just because another QSpec package needs them. This
document covers how this repository draws that line today, what enforces it mechanically, and
where the line is a stated policy rather than something code can check.

## The rule, in practice

Every package's source is split at exactly one boundary: `src/index.ts` (a package's entry point)
versus `src/internal/`. Anything reachable by importing the package's name — `import { createQSpec }
from "@qspecs/core"` — is public API; anything under `internal/` is not, and nothing outside that
package's own source is meant to reach it. `@qspecs/core`'s own public surface is deliberately
narrow by this rule: it exports the manifest and plugin types, `createQSpec`, its full error-class
hierarchy (`QSpecError` and its fourteen subclasses, from `ManifestValidationError` through
`LimitExceededError` — `packages/core/src/errors.ts`), `definePlugin`/`defineManifest`/`parseManifest`, the expression subsystem
(`evaluateExpression`, `normalizeExpression` — needed outside core because `@qspecs/transforms`'
`filter` and `derive` compile through it), `suggest` (needed by `@qspecs/sql`'s own "did you mean"
diagnostics), and `isPlainObject`/`isUnsafeKey` (needed by `@qspecs/http`'s wire-protocol parser to
apply the identical prototype-pollution checks core's own manifest parsing uses — see
[Security §72.4](security.md#724-prototype-pollution-resistance)). Each of those three
exceptions — the expression subsystem, `suggest`, and `isPlainObject`/`isUnsafeKey` — exists
because a real second package needed the exact same logic core already has, and a hand-copied
second implementation would be a second place for the two to drift: the SPEC.md §104 rule "if
multiple packages need an abstraction, promote it intentionally into a documented public or
internal shared contract," applied literally, three separate times.

## The structural half: package boundaries

The Public/Internal split is enforced mechanically, not left to reviewer discipline, by
[`test/boundaries.test.ts`](../test/boundaries.test.ts) — verified directly as part of this task's
own gate run (`npm run test`, the "package boundaries" suite). It checks, for every workspace
package:

- **`exports` exposes exactly two paths, `"."` and `"./package.json"`, never a subpath.** There is
  no `@qspecs/postgres/internal/source` a caller could import even deliberately — Node's own module
  resolution rejects any subpath an `exports` map does not list, once a package declares one at
  all. This is the one part of "internal is unreachable" that is enforced for a real npm consumer
  of a published package, not just inside this monorepo's own source tree.
- **No `src/index.ts` re-exports `./internal/...` with a wildcard** (`export * from "./internal/…"`)
  — grepped directly across every package, so an entry point cannot accidentally widen its own
  public surface by forwarding everything from `internal/` in one line.
- **`@qspecs/core`'s `package.json` declares no `dependencies` at all** — the mechanical proof
  behind [Introduction's](introduction.md) "`@qspecs/core` has zero runtime dependencies" claim.
- **Browser-safe packages** (`@qspecs/core`, `@qspecs/schema`, `@qspecs/sql`, `@qspecs/transforms`,
  `@qspecs/charts`, `@qspecs/http`, `@qspecs/react`, `@qspecs/recharts`) **never depend on, or import
  in source, a database driver** (`pg`, `pg-promise`, `postgres`, `mysql2`) — checked against
  `dependencies`, `peerDependencies`, and `optionalDependencies` in each `package.json`, and
  against every non-test `.ts`/`.tsx` source file's `import`/`from`/`import()`/`require()`
  specifiers, including subpath imports like `"pg/lib/client"` (SPEC.md §73).
- **Every package declares `"type": "module"`, `"sideEffects": false`, `"license": "MIT"`, and
  `"engines": { "node": ">=22.19" }`.**
- **No published, non-test source file contains `eval(` or `new Function(`** — the mechanical proof
  behind [Security §72.3](security.md#723-no-eval-no-new-function).

A failure in this suite is a real architectural regression to fix, not a test to relax — its own
comment in `docs/architecture.md` §6 says so directly, and this document does not repeat that
reasoning, only the concrete assertions.

## What is not mechanically enforced

The structural half above proves a claim about **file layout and package metadata**: `internal/`
is unreachable, no forbidden dependency exists, no dangerous primitive is used. It proves nothing
about **API stability** — nothing checks that a function exported from a package's entry point
today still has the same signature tomorrow, and nothing tags any export as `Experimental` versus
`Public` in the sense SPEC.md §104's three-way vocabulary describes. Searched directly: no
`@experimental`, `@internal`, or `@public` JSDoc tag, and no comparable convention, appears
anywhere in this repository's published source. In practice every package here has exactly two
tiers — reachable from `src/index.ts`, or not — not the three SPEC.md §104 names; "Experimental
API" exists in the specification's vocabulary but not, today, as a marked category in the code.

There is also no automated API-diff or breaking-change-detection tooling in this repository — no
`api-extractor`-style report, no CI step comparing one build's exported surface against the last.
The root `package.json`'s `scripts` are `prebuild`, `build`, `clean`, `typecheck:tests`, `test`,
`test:watch`, `format`, and `format:check`; none of them compare public API shape across commits.
A change to an exported
function's parameters, an added required field on an exported type, or a renamed export is caught
by whatever downstream code (inside this monorepo, or a published package's own consumers) fails
to compile against it — the same way any TypeScript API change is caught — not by a dedicated
stability gate.

**This is the distinction worth keeping straight when reading SPEC.md §104: a stability _policy_ —
"anything exported is public, treat it as a promise" — is a statement of intent about how this
project _should_ be developed, not machinery that enforces the promise is kept.** The
public/internal _boundary_ (where code physically lives, whether it is reachable) is mechanically
guarded, on every CI run, by the suite above. Whether a given public export's _shape_ stays stable
release to release is a discipline this repository's maintainers and reviewers are expected to
hold themselves to, the same way most TypeScript projects at this stage of maturity do, not
something `test/boundaries.test.ts` — or anything else in this repository — currently checks for
them.

## See also

- [`docs/architecture.md` §6](architecture.md#6-the-publicinternal-boundary-specmd-104) — the same
  boundary, in the context of how this repository implements SPEC.md end to end, including why
  `isPlainObject`/`isUnsafeKey` are public and what `@qspecs/core`'s cross-realm caveat means once
  those two functions are treated as a public-API promise rather than an internal helper.
- [`docs/security.md`](security.md#724-prototype-pollution-resistance) — the prototype-pollution
  defenses `isPlainObject`/`isUnsafeKey` share across `@qspecs/core` and `@qspecs/http`.
- [`docs/specification-versioning.md`](specification-versioning.md) — `apiVersion` and
  `SUPPORTED_API_VERSIONS`, a different, orthogonal notion of "version" from an npm package's own.
- [`docs/plugins.md`](plugins.md) — `QSpecPluginAPI`, the one interface every third-party plugin's
  `setup()` is written against, and therefore the widest "public API" surface in this repository in
  practice.
