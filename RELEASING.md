# Releasing

Ten of the eleven packages publish to npm under the `@qspecs` scope.
`@qspecs/testing` is `private` and is not published.

Releases are **lockstep**: every package moves to the same version together.
That is not a preference — inter-package dependencies pin _exact_ versions
(`"@qspecs/core": "0.1.0"`, not `"^0.1.0"`), so publishing one package at a new
version while its siblings stayed behind would ship a package whose peer
requirement resolves to nothing that exists.

## One-time setup

1. **`NPM_TOKEN` repository secret.** Create an **automation** token on npm
   (Access Tokens → Generate → Automation). A granular or classic token with
   2FA required cannot publish from CI, and the failure arrives mid-release.
2. **The `@qspecs` scope must exist** and the token's account must be able to
   publish to it.

Provenance needs nothing further: the workflow requests an OIDC token from
GitHub and npm exchanges it for a signed attestation linking each tarball to
the commit and workflow run that produced it.

## Cutting a release

```bash
# 1. Bump every package, including the exact pins between them.
npm version 0.2.0 --workspaces --no-git-tag-version
#    ...then update the inter-package pins by hand, or the check below fails
#    and tells you exactly which ones are stale.

# 2. Verify locally. This is the same validation CI runs.
npm run release:check

# 3. Build and rehearse the whole publish, including the tarball contents.
npm run build
npm run release:dry-run

# 4. Commit, tag, push.
git commit -am "release: 0.2.0"
git tag v0.2.0
git push && git push --tags
```

Pushing the tag runs `.github/workflows/release.yml`, which publishes.

To rehearse in CI without spending a version number, run the workflow manually
from the Actions tab: a `workflow_dispatch` run never publishes — it validates,
builds, tests, and runs `npm publish --dry-run`.

## What the pipeline checks before it publishes anything

npm refuses to republish a version. A release that fails on package 7 of 10
leaves the first six on the registry and burns the version number. Every check
below therefore runs _before_ the first irreversible step.

| Check                                                       | Catches                                                                                    |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Tag is strict semver                                        | `v0.1` typos, and any crafted tag name                                                     |
| Tag matches `package.json`                                  | a tag and a version that disagree                                                          |
| One version across all packages                             | a partial bump                                                                             |
| Exact pins equal that version                               | `@qspecs/recharts` still requiring an old `@qspecs/core`                                   |
| No dependency on a private package                          | shipping something that 404s for every consumer                                            |
| `publishConfig.access: public`                              | a scoped package silently published as restricted                                          |
| `repository` present                                        | `--provenance` failing partway through                                                     |
| `files` allowlist present                                   | publishing whatever happens to be on disk                                                  |
| `format:check`, `build`, `typecheck:tests`, full test suite | shipping untested code                                                                     |
| Container suites actually ran                               | the PostgreSQL and browser-loop suites skipping silently, which looks identical to passing |
| `dist/index.js` exists per package                          | a build that produced no entry point                                                       |
| Tarball contains only `dist/`                               | shipping sources, or shipping nothing                                                      |

The publish itself is **idempotent**: a version already on the registry is
skipped rather than retried, so a release interrupted partway can simply be
re-run.

Packages publish in dependency order, derived from the graph rather than a
hardcoded list — npm does not resolve dependencies at publish time, so a wrong
order fails silently, leaving a window where an installed package's dependency
is not yet on the registry.

## Running the checks yourself

```bash
npm run release:check                                  # metadata only, no build needed
node scripts/release-check.mjs --require-dist          # also assert dist/ is built
node scripts/release-check.mjs --expect-version 0.2.0  # assert a specific version
node scripts/release-check.mjs --json                  # machine-readable, incl. publish order
node scripts/publish-packages.mjs --dry-run            # pack, verify tarballs, publish nothing
```

## Optional hardening

Not configured, because both need a decision that is yours:

- **Required approval.** Add `environment: npm` to the `release` job and
  configure that environment with required reviewers, so a tag push waits for
  a human before publishing.
- **A GitHub Release.** The workflow publishes to npm and stops. Creating a
  GitHub Release with notes would need `contents: write`.
