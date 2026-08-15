import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

/**
 * Packages with no server-only runtime need (no Node built-ins, no database
 * driver) — safe to bundle for a browser. `@qspecs/postgres` is deliberately
 * not a member.
 */
const BROWSER_SAFE = new Set([
  "@qspecs/core",
  "@qspecs/schema",
  "@qspecs/sql",
  "@qspecs/transforms",
  "@qspecs/charts",
  "@qspecs/http",
  "@qspecs/react",
  "@qspecs/recharts",
]);

/**
 * Database driver package names a browser-safe package must depend on
 * neither in its manifest nor via a bare import in source.
 */
const DENIED_DB_DRIVERS = ["pg", "pg-promise", "postgres", "mysql2"] as const;

interface PackageEntry {
  readonly directory: string;
  readonly manifest: Record<string, unknown>;
}

async function packages(): Promise<PackageEntry[]> {
  const names = await readdir(join(root, "packages"));
  return Promise.all(
    names.map(async (directory) => ({
      directory,
      manifest: JSON.parse(
        await readFile(join(root, "packages", directory, "package.json"), "utf8"),
      ) as Record<string, unknown>,
    })),
  );
}

/** Yields every non-test `.ts`/`.tsx` source file under `directory`, recursively. */
async function* walkSourceFiles(directory: string): AsyncGenerator<string> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      yield* walkSourceFiles(path);
    } else if (
      (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) ||
      (entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx"))
    ) {
      yield path;
    }
  }
}

/**
 * Every non-test `.ts`/`.tsx` file under `directory`, collected — and
 * asserted non-empty.
 *
 * A source scan that walks nothing passes every assertion it makes: a renamed
 * `src`, a package published from a different directory, or a walk that stops
 * silently would turn these guards off without turning any of them red. The
 * count is the only thing that can tell "clean" from "never looked".
 */
async function scannedSourceFiles(directory: string, label: string): Promise<readonly string[]> {
  const files: string[] = [];
  for await (const file of walkSourceFiles(directory)) files.push(file);
  expect(
    files.length,
    `${label}: no source files were scanned, so this guard asserted nothing`,
  ).toBeGreaterThan(0);
  return files;
}

/**
 * Runs `assertion` for every package whose name is in `names`, then asserts
 * every name in `names` was actually matched against a real package. Without
 * that second check, a typo'd or renamed entry in `names` silently drops out
 * of the loop — the guard stops guarding but the test still reports green.
 */
async function forEachNamedPackage(
  names: ReadonlySet<string>,
  assertion: (entry: PackageEntry) => void | Promise<void>,
): Promise<void> {
  const seen = new Set<string>();
  for (const entry of await packages()) {
    const name = entry.manifest["name"] as string;
    if (!names.has(name)) continue;
    seen.add(name);
    await assertion(entry);
  }
  expect(seen, "some browser-safe package name never matched a real package").toEqual(names);
}

describe("package boundaries", () => {
  it("keeps @qspecs/core free of runtime dependencies", async () => {
    const core = (await packages()).find((entry) => entry.manifest["name"] === "@qspecs/core");
    expect(core, "@qspecs/core package.json not found").toBeDefined();
    expect(core?.manifest["dependencies"] ?? {}).toEqual({});
  });

  it("keeps browser-safe packages free of database-driver manifest dependencies", async () => {
    await forEachNamedPackage(BROWSER_SAFE, ({ manifest }) => {
      const name = manifest["name"] as string;
      for (const key of ["dependencies", "peerDependencies", "optionalDependencies"] as const) {
        const declared = Object.keys((manifest[key] as object) ?? {});
        for (const driver of DENIED_DB_DRIVERS) {
          expect(declared, `${name} ${key}`).not.toContain(driver);
        }
      }
    });
  });

  it("keeps browser-safe packages free of database-driver imports in source", async () => {
    await forEachNamedPackage(BROWSER_SAFE, async ({ directory, manifest }) => {
      const name = manifest["name"] as string;
      for (const file of await scannedSourceFiles(join(root, "packages", directory, "src"), name)) {
        const source = await readFile(file, "utf8");
        for (const driver of DENIED_DB_DRIVERS) {
          // The package itself, and any subpath of it: `import "pg/lib/client"`
          // pulls in exactly as much of the driver as `import "pg"` does, and
          // an entry point is not the only reachable module in a package.
          const specifier = `${driver}(?:/[^"']*)?`;
          // Side-effect import (no `from` at all), static import/export via
          // `from`, dynamic import(), and require() — the four ways a bare
          // specifier can pull in an undeclared package once it is anywhere in
          // the hoisted node_modules tree.
          const pattern = new RegExp(
            `\\bimport\\s+["']${specifier}["']` +
              `|\\bfrom\\s+["']${specifier}["']` +
              `|\\bimport\\(\\s*["']${specifier}["']\\s*\\)` +
              `|\\brequire\\(\\s*["']${specifier}["']\\s*\\)`,
          );
          expect(source, `${name}: ${file} imports "${driver}"`).not.toMatch(pattern);
        }
      }
    });
  });

  it("exposes only the documented export paths", async () => {
    for (const { manifest } of await packages()) {
      const exported = Object.keys((manifest["exports"] as object) ?? {}).sort();
      expect(exported, manifest["name"] as string).toEqual([".", "./package.json"]);
    }
  });

  it("declares ESM, sideEffects:false, MIT, and the Node engine floor everywhere", async () => {
    for (const { manifest } of await packages()) {
      const name = manifest["name"] as string;
      expect(manifest["type"], name).toBe("module");
      expect(manifest["sideEffects"], name).toBe(false);
      expect(manifest["engines"], name).toEqual({ node: ">=22.19" });
      expect(manifest["license"], name).toBe("MIT");
    }
  });

  it("never wildcard-re-exports an internal module from a public entry", async () => {
    for (const { directory } of await packages()) {
      const source = await readFile(
        join(root, "packages", directory, "src", "index.ts"),
        "utf8",
      ).catch(() => "");
      expect(source, `${directory} wildcard-exports internals`).not.toMatch(
        /export\s+\*\s+from\s+["']\.\/internal\//,
      );
    }
  });

  it("uses no eval or Function constructor anywhere in published source", async () => {
    for (const { directory } of await packages()) {
      for (const file of await scannedSourceFiles(
        join(root, "packages", directory, "src"),
        directory,
      )) {
        const source = await readFile(file, "utf8");
        expect(source, file).not.toMatch(/\beval\s*\(/);
        expect(source, file).not.toMatch(/\bnew\s+Function\s*\(/);
      }
    }
  });
});
