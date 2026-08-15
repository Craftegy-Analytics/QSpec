import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

/**
 * Spawns the built `bin.js` the way a user actually gets it, and asserts it
 * does something.
 *
 * This file exists because `packages/cli/src/bin.test.ts` cannot catch the
 * bug it guards, by construction. That suite imports `main` and calls it
 * directly, which deliberately bypasses the entry-point guard at the bottom
 * of `bin.ts` — so every assertion in it passed while the shipped binary was
 * a silent no-op.
 *
 * The bug: the guard compared `process.argv[1]` against `import.meta.url`
 * without resolving symlinks. `import.meta.url` is always fully resolved;
 * `process.argv[1]` is the path as invoked. npm installs a package's binary
 * as a symlink at `node_modules/.bin/<name>`, so for every npm install of
 * `@qspecs/cli` the two disagreed, `main()` never ran, and `qspec validate`
 * exited 0 having validated nothing. It was found by installing this repo's
 * packages into a separate demo project via `file:` and noticing that a
 * deliberately malformed manifest — and then a nonexistent file — both
 * "passed".
 *
 * Two invocation paths matter, and only the second was ever exercised:
 *
 *   node packages/cli/dist/bin.js ...   (CI, and every manual check)
 *   node node_modules/.bin/qspec ...    (every real installation)
 *
 * So the symlink case below is the load-bearing one. The direct case is kept
 * beside it to prove the fix did not trade one broken path for another.
 */
const execFileAsync = promisify(execFile);

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = path.join(REPO_ROOT, "packages", "cli", "dist", "bin.js");

/**
 * The suite needs the compiled binary, which `npm run build` produces before
 * `npm test` in CI. Locally, a fresh clone that runs vitest without building
 * first would otherwise fail here for a reason that has nothing to do with
 * the CLI — so skip, and name what goes unverified, following the same
 * convention as the container-dependent suites.
 */
const built = existsSync(BIN);
const UNVERIFIED =
  "that the built CLI actually executes when invoked through a bin symlink " +
  "(the way npm installs it) rather than exiting 0 having done nothing";
const describeBin = built ? describe : describe.skip;
if (!built) {
  console.warn(`test/cli-bin.test.ts SKIPPED — ${BIN} not built. UNVERIFIED: ${UNVERIFIED}`);
}

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function run(binPath: string, args: readonly string[]): Promise<Run> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [binPath, ...args]);
    return { code: 0, stdout, stderr };
  } catch (error: unknown) {
    // execFile rejects on a non-zero exit, carrying the streams and code on
    // the error. A non-zero exit is an expected outcome for half these
    // assertions, not a test failure.
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof failure.code === "number" ? failure.code : 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

describeBin("the built qspec binary", () => {
  /** A `node_modules/.bin/qspec`-shaped symlink to the real file. */
  async function symlinkedBin(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "qspec-bin-"));
    const link = path.join(dir, "qspec");
    await symlink(BIN, link);
    return link;
  }

  it("runs when invoked through a bin symlink, as npm installs it", async () => {
    const link = await symlinkedBin();

    // `--version` is the smallest command that proves main() ran at all: it
    // writes to stdout and exits 0. Before the fix this produced empty
    // output with exit 0 — indistinguishable from success to any caller
    // that only checks the exit code, which is exactly why it went unnoticed.
    const { code, stdout } = await run(link, ["--version"]);

    expect(code).toBe(0);
    expect(stdout.trim()).not.toBe("");
    expect(stdout).toMatch(/\d+\.\d+\.\d+/);
  });

  it("reports a nonexistent manifest through a bin symlink instead of exiting 0", async () => {
    const link = await symlinkedBin();
    const missing = path.join(REPO_ROOT, "this-manifest-does-not-exist.qspec.json");

    // The regression in its most damning form. A validator that accepts a
    // file that is not there accepts anything, and a CI pipeline gating on
    // `qspec validate` would have been green for every possible input.
    const { code, stdout, stderr } = await run(link, ["validate", missing]);

    expect(code).not.toBe(0);
    expect(`${stdout}${stderr}`.trim()).not.toBe("");
  });

  it("still runs when invoked directly, by its real path", async () => {
    const { code, stdout } = await run(BIN, ["--version"]);

    expect(code).toBe(0);
    expect(stdout).toMatch(/\d+\.\d+\.\d+/);
  });

  it("validates a real fixture through a bin symlink", async () => {
    const link = await symlinkedBin();
    const fixture = path.join(REPO_ROOT, "examples", "02-minimal-dataset.qspec.json");

    // Companion to the two assertions above: they would also be satisfied by
    // a binary that rejects everything, and this rules that out.
    //
    // Vacuous on its own, though, and deliberately kept anyway. Verified by
    // reverting the fix: this test PASSES against the broken binary, because
    // a no-op exits 0 and that is all it checks. It is meaningful only in
    // combination with the symlink tests above — never cite it as evidence
    // the CLI works.
    const { code } = await run(link, ["validate", fixture]);

    expect(code).toBe(0);
  });
});
