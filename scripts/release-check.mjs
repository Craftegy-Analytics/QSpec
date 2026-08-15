/**
 * Validates that this repository is in a releasable state, and prints the
 * order packages must be published in.
 *
 * Lives here rather than inline in the workflow for two reasons. A release
 * check that can only run in CI is one nobody runs before pushing a tag, and
 * a failed publish is not something you can undo — npm forbids reusing a
 * version number, so a half-finished release burns it. Everything below is
 * therefore checkable locally with `npm run release:check`.
 *
 * Usage:
 *   node scripts/release-check.mjs                     validate, print a summary
 *   node scripts/release-check.mjs --expect-version X  also assert the version
 *   node scripts/release-check.mjs --require-dist      also assert dist/ is built
 *   node scripts/release-check.mjs --json              machine-readable output
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES_DIR = path.join(REPO_ROOT, "packages");

const args = process.argv.slice(2);
const jsonOutput = args.includes("--json");
const requireDist = args.includes("--require-dist");
const expectVersionIndex = args.indexOf("--expect-version");
const expectVersion = expectVersionIndex === -1 ? undefined : args[expectVersionIndex + 1];

const problems = [];
const fail = (message) => problems.push(message);

function readPackage(dir) {
  const file = path.join(PACKAGES_DIR, dir, "package.json");
  return { dir, file, json: JSON.parse(readFileSync(file, "utf8")) };
}

const all = readdirSync(PACKAGES_DIR)
  .filter((dir) => existsSync(path.join(PACKAGES_DIR, dir, "package.json")))
  .map(readPackage);

const publishable = all.filter((pkg) => pkg.json.private !== true);
const privateOnes = all.filter((pkg) => pkg.json.private === true);

if (publishable.length === 0) fail("No publishable packages found under packages/.");

// --- One version across the release -----------------------------------------
//
// Lockstep is not a style preference here, it is forced by the dependency
// graph: every inter-package dependency pins an EXACT version ("0.1.0", not
// "^0.1.0"). Publishing one package at a new version while its siblings stay
// behind would ship a package whose peer requirement no longer resolves to
// anything that exists.
const versions = new Set(publishable.map((pkg) => pkg.json.version));
if (versions.size > 1) {
  fail(
    `Publishable packages disagree on version: ${[...versions].sort().join(", ")}. ` +
      `Inter-package dependencies pin exact versions, so a release must move them together.`,
  );
}
const version = publishable[0]?.json.version;

if (expectVersion !== undefined && version !== expectVersion) {
  fail(
    `Version mismatch: packages are at ${version}, but the release was asked for ${expectVersion}. ` +
      `A tag must name the version in package.json.`,
  );
}

// --- Which repository is this release coming from? ---------------------------
//
// In CI, GITHUB_REPOSITORY is authoritative: it is the same value npm uses to
// mint the provenance attestation, so matching against it is matching against
// the thing that will actually be checked.
//
// Locally there is no such authority. The git remote is a good hint but not a
// rule — a contributor's fork legitimately has a different origin, and failing
// their `release:check` over it would be wrong. So outside CI a mismatch is
// reported as a note, not a problem.
function ownerRepoFromUrl(url) {
  const match = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?(?:[/#].*)?$/.exec(url);
  return match === null ? undefined : `${match[1]}/${match[2]}`;
}

const ciRepository = process.env["GITHUB_REPOSITORY"];
const expectedOwnerRepo =
  ciRepository === undefined || ciRepository === "" ? undefined : ciRepository;

/** Only consulted for the advisory note below. */
function gitRemoteOwnerRepo() {
  try {
    return ownerRepoFromUrl(
      execFileSync("git", ["remote", "get-url", "origin"], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim(),
    );
  } catch {
    return undefined;
  }
}

// --- Per-package requirements ------------------------------------------------
const publishableNames = new Set(publishable.map((pkg) => pkg.json.name));
const privateNames = new Set(privateOnes.map((pkg) => pkg.json.name));

for (const { dir, json } of publishable) {
  const where = `${json.name} (packages/${dir})`;

  if (json.license === undefined) fail(`${where}: no license field.`);
  if (!Array.isArray(json.files) || json.files.length === 0) {
    fail(`${where}: no "files" allowlist — publishing would ship whatever happens to be on disk.`);
  }
  if (json.publishConfig?.access !== "public") {
    fail(
      `${where}: publishConfig.access must be "public" — a scoped package defaults to restricted.`,
    );
  }
  if (json.exports === undefined) fail(`${where}: no "exports" map.`);

  // Provenance attestation requires a repository URL, and npm rejects the
  // publish outright without one — a failure that would otherwise surface for
  // the first time mid-release, after earlier packages had already gone out.
  const repositoryUrl =
    typeof json.repository === "string" ? json.repository : json.repository?.url;
  if (repositoryUrl === undefined) {
    fail(`${where}: no "repository" field. npm publish --provenance requires it.`);
  }
  if (json.repository?.directory !== undefined && json.repository.directory !== `packages/${dir}`) {
    fail(
      `${where}: repository.directory is "${json.repository.directory}" but the package lives in packages/${dir}.`,
    );
  }

  // The URL must name the repository actually being released from. npm
  // verifies this when minting a provenance attestation and rejects the
  // publish if they disagree — so a repository that moved between orgs, or
  // was renamed, breaks the release at the one point where failure is
  // expensive. Checked here, before anything is published.
  if (repositoryUrl !== undefined && expectedOwnerRepo !== undefined) {
    const declared = ownerRepoFromUrl(repositoryUrl);
    if (declared === undefined) {
      fail(`${where}: could not read an owner/repo out of repository.url "${repositoryUrl}".`);
    } else if (declared.toLowerCase() !== expectedOwnerRepo.toLowerCase()) {
      // Compared case-insensitively: GitHub resolves either casing, so a
      // difference in case is not a real mismatch and failing on it would be
      // noise.
      fail(
        `${where}: repository.url names ${declared}, but this release is being cut from ` +
          `${expectedOwnerRepo}. npm --provenance will reject the publish.`,
      );
    }
  }

  for (const field of ["dependencies", "peerDependencies"]) {
    for (const [name, range] of Object.entries(json[field] ?? {})) {
      if (!name.startsWith("@qspecs/")) continue;

      // A published package cannot depend on one that is never published;
      // the install would 404 for everyone downstream.
      if (privateNames.has(name)) {
        fail(`${where}: ${field} on ${name}, which is private and will never be on the registry.`);
        continue;
      }
      if (!publishableNames.has(name)) {
        fail(`${where}: ${field} on ${name}, which is not a package in this repository.`);
        continue;
      }
      if (range !== version) {
        fail(
          `${where}: ${field}["${name}"] is "${range}" but the release version is ${version}. ` +
            `Exact pins must be bumped with the release.`,
        );
      }
    }
  }

  if (requireDist) {
    const dist = path.join(PACKAGES_DIR, dir, "dist");
    if (!existsSync(dist)) {
      fail(`${where}: dist/ is missing. Run \`npm run build\` before publishing.`);
    } else if (!existsSync(path.join(dist, "index.js"))) {
      fail(`${where}: dist/index.js is missing — the build did not produce an entry point.`);
    }
  }
}

// --- Publish order ------------------------------------------------------------
//
// Derived from the dependency graph rather than hardcoded, so adding a package
// does not mean remembering to edit a list. npm does not resolve dependencies
// at publish time, so a wrong order does not fail loudly — it leaves a window
// where a published package's dependency is not yet on the registry, and an
// install during that window breaks.
function topologicalOrder(packages) {
  const byName = new Map(packages.map((pkg) => [pkg.json.name, pkg]));
  const ordered = [];
  const state = new Map(); // name -> "visiting" | "done"

  const visit = (pkg, trail) => {
    const status = state.get(pkg.json.name);
    if (status === "done") return;
    if (status === "visiting") {
      fail(`Dependency cycle between packages: ${[...trail, pkg.json.name].join(" -> ")}`);
      return;
    }
    state.set(pkg.json.name, "visiting");

    const deps = [
      ...Object.keys(pkg.json.dependencies ?? {}),
      ...Object.keys(pkg.json.peerDependencies ?? {}),
    ].filter((name) => byName.has(name));

    for (const dep of deps) {
      const next = byName.get(dep);
      if (next !== undefined) visit(next, [...trail, pkg.json.name]);
    }

    state.set(pkg.json.name, "done");
    ordered.push(pkg);
  };

  // Sorted first so the order is deterministic between runs, not dependent on
  // readdir order.
  for (const pkg of [...packages].sort((a, b) => a.json.name.localeCompare(b.json.name))) {
    visit(pkg, []);
  }
  return ordered;
}

const order = topologicalOrder(publishable);

// --- Report -------------------------------------------------------------------
if (jsonOutput) {
  process.stdout.write(
    JSON.stringify(
      {
        ok: problems.length === 0,
        version,
        packages: order.map((pkg) => ({ name: pkg.json.name, dir: `packages/${pkg.dir}` })),
        problems,
      },
      null,
      2,
    ) + "\n",
  );
} else {
  console.log(`Release version: ${version}`);

  // Advisory only outside CI — see the note beside gitRemoteOwnerRepo.
  if (expectedOwnerRepo === undefined) {
    const remote = gitRemoteOwnerRepo();
    const declared = ownerRepoFromUrl(
      publishable[0]?.json.repository?.url ?? publishable[0]?.json.repository ?? "",
    );
    if (
      remote !== undefined &&
      declared !== undefined &&
      remote.toLowerCase() !== declared.toLowerCase()
    ) {
      console.log(
        `\nNote: package.json names ${declared}, but this checkout's origin is ${remote}.\n` +
          `      Harmless in a fork. If the repository moved, update the remote too —\n` +
          `      CI matches package.json against GITHUB_REPOSITORY and will fail on a mismatch.`,
      );
    }
  }
  console.log(`Publishable: ${publishable.length} package(s)`);
  console.log(
    `Private (never published): ${privateOnes.map((p) => p.json.name).join(", ") || "none"}`,
  );
  console.log("\nPublish order:");
  order.forEach((pkg, index) => console.log(`  ${index + 1}. ${pkg.json.name}`));

  if (problems.length > 0) {
    console.error(`\n${problems.length} problem(s):`);
    for (const problem of problems) console.error(`  - ${problem}`);
  } else {
    console.log("\nNo problems found.");
  }
}

process.exitCode = problems.length === 0 ? 0 : 1;
