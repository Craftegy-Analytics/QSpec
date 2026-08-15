/**
 * Publishes every publishable workspace package, in dependency order.
 *
 * Usage:
 *   node scripts/publish-packages.mjs --dry-run     pack and check, publish nothing
 *   node scripts/publish-packages.mjs               publish for real
 *   node scripts/publish-packages.mjs --provenance  attach a provenance attestation (CI only)
 *
 * Three properties this has that a `for pkg in ...; do npm publish; done` loop
 * does not:
 *
 * 1. **Idempotent.** A version already on the registry is skipped, not
 *    retried. npm refuses to republish a version, so without this a release
 *    that failed on package 7 of 10 could never be resumed — the only way
 *    forward would be burning a version number.
 * 2. **Pre-flight on the tarball.** `npm pack --dry-run` is inspected before
 *    anything is published, so a package that would ship its sources, or ship
 *    no `dist/` at all, fails before the first irreversible step rather than
 *    after it.
 * 3. **Ordered.** The order comes from the dependency graph, so a dependency
 *    is on the registry before anything that requires it.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const withProvenance = args.includes("--provenance");

function npm(argv, options = {}) {
  return execFileSync("npm", argv, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: options.capture === true ? ["ignore", "pipe", "pipe"] : "inherit",
    env: process.env,
  });
}

/** The plan, straight from the validator — one source of truth for order. */
const plan = JSON.parse(
  execFileSync("node", [path.join(REPO_ROOT, "scripts", "release-check.mjs"), "--json"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  }),
);

if (!plan.ok) {
  console.error("Release checks failed; refusing to publish:");
  for (const problem of plan.problems) console.error(`  - ${problem}`);
  process.exit(1);
}

const { version, packages } = plan;
console.log(
  `Releasing version ${version} — ${packages.length} package(s)${dryRun ? " (dry run)" : ""}\n`,
);

/** True when this exact version is already on the registry. */
function alreadyPublished(name) {
  try {
    // `npm view <pkg>@<version> version` exits non-zero when the version does
    // not exist, which is the signal — the printed value is incidental.
    const out = npm(["view", `${name}@${version}`, "version"], { capture: true }).trim();
    return out === version;
  } catch {
    return false;
  }
}

/**
 * What the tarball would contain. `files: ["dist"]` should already restrict
 * this, but "should" is why the check exists: a typo'd `files` entry silently
 * publishes the whole package directory, sources and all.
 */
function checkTarball(name) {
  const raw = npm(["pack", "--dry-run", "--json", "-w", name], { capture: true });
  const parsed = JSON.parse(raw);
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  const files = (entry?.files ?? []).map((file) => file.path);

  if (files.length === 0) throw new Error(`${name}: the tarball would be empty.`);

  const ALWAYS_ALLOWED = new Set(["package.json", "README.md", "LICENSE", "LICENSE.md"]);
  const strays = files.filter((file) => !file.startsWith("dist/") && !ALWAYS_ALLOWED.has(file));
  if (strays.length > 0) {
    throw new Error(
      `${name}: tarball would include files outside dist/: ${strays.slice(0, 8).join(", ")}` +
        (strays.length > 8 ? ` (+${strays.length - 8} more)` : ""),
    );
  }
  if (!files.includes("dist/index.js")) {
    throw new Error(
      `${name}: tarball has no dist/index.js — the build did not run, or files is wrong.`,
    );
  }
  return files.length;
}

let published = 0;
let skipped = 0;

for (const { name } of packages) {
  const fileCount = checkTarball(name);

  if (alreadyPublished(name)) {
    console.log(`= ${name}@${version} already on the registry — skipping`);
    skipped += 1;
    continue;
  }

  const publishArgs = ["publish", "-w", name, "--access", "public"];
  if (withProvenance) publishArgs.push("--provenance");
  if (dryRun) publishArgs.push("--dry-run");

  console.log(`${dryRun ? "~" : "+"} ${name}@${version} (${fileCount} files)`);
  npm(publishArgs);
  published += 1;
}

console.log(
  `\n${dryRun ? "Dry run complete" : "Published"}: ${published} package(s)` +
    (skipped > 0 ? `, ${skipped} already present` : ""),
);
