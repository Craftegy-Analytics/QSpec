import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The documentation drift guard.
 *
 * ## What this checks
 *
 * Two classes of documentation error are mechanically detectable, and both
 * have already shipped in this repository:
 *
 * 1. **README's package table matches every package's manifest.** Every row
 *    names a real package, every package has a row, and the row's "Peer
 *    dependencies" cell is exactly the set of keys in that package's
 *    `package.json` `peerDependencies` — no more, no fewer. (Plan 4's final
 *    review found the `@qspecs/recharts` row missing `@qspecs/core`, which the
 *    manifest listed; this test closes that specific gap mechanically.)
 * 2. **Every symbol a doc imports from a real `@qspecs/*` package in a `ts`/
 *    `tsx` code fence is actually exported by that package.** A doc naming
 *    `useQSpecQuery` or `createQSpecHandler` in an import fence fails here if
 *    that export is renamed or removed.
 *
 * ## What this does NOT check — read this before trusting a green run
 *
 * This is a drift guard for two narrow, syntactic facts, not a documentation
 * correctness checker. It proves nothing about:
 *
 * - **Prose accuracy.** Whether a sentence correctly describes what code
 *   does. This is where every real defect in this documentation set has
 *   been, and there have been many: more than a dozen false statements were
 *   committed across Tasks 5-8 and caught only by human review, including a
 *   compressed quote that dropped an argument, a false claim about a `date`
 *   parameter's length constraints, a wrong claim about an operator's arity,
 *   two claims that a validation did not exist when it did, a claim that an
 *   error escapes `prepare()` when both callers catch and downgrade it, and
 *   a claim that a bad presentation reference is caught at `execute()` when
 *   in fact nothing catches it at any stage. The wave that fixed those
 *   shipped another one. Not one of them touched a package table or an
 *   import fence, so not one would have tripped this guard.
 *
 *   Read that as the calibration it is: a green run here is evidence about
 *   two syntactic facts and evidence about nothing else. It is not a signal
 *   that the prose is true, and the error rate above is the reason to
 *   assume it is not.
 * - **Example correctness or runnability.** That a code sample actually
 *   compiles, runs, or produces the output shown near it. Only the
 *   `import { ... } from "@qspecs/x"` line is checked, and only against the
 *   package's export *names* — not their types, arity, or behavior.
 * - **Whether a described behavior is real.** A doc can accurately name a
 *   real export and then describe it doing something it does not do; this
 *   guard has no way to know.
 * - **Links, headings, cross-references, or anything in `docs/superpowers/`**
 *   — those are historical plan and spec documents, deliberately frozen, and
 *   are excluded from every scan below.
 *
 * A green run here means "the package table and the named imports haven't
 * silently drifted from the manifests and export lists." It is not, and must
 * not be read as, a documentation-correctness guarantee.
 */

const root = resolve(import.meta.dirname, "..");
const packagesDir = join(root, "packages");
const docsDir = join(root, "docs");
const readmePath = join(root, "README.md");

// ---------------------------------------------------------------------------
// Package manifests: name, peer dependencies, and (recursively) every name
// the package's public entry point exports.
// ---------------------------------------------------------------------------

interface PackageInfo {
  readonly name: string; // e.g. "@qspecs/core"
  readonly shortName: string; // directory name under packages/, e.g. "core"
  readonly peerDependencies: ReadonlySet<string>;
  readonly exportedNames: ReadonlySet<string>;
}

const EXPORT_BRACE_RE = /export\s+(?:type\s+)?\{([^}]*)\}\s*(?:from\s*["']([^"']+)["'])?\s*;/g;
const EXPORT_STAR_RE = /export\s+\*\s+from\s*["']([^"']+)["']\s*;/g;
const EXPORT_DECLARATION_RE =
  /export\s+(?:async\s+function|function|class|const|interface|type)\s+([A-Za-z_$][\w$]*)/g;

/** `X` -> `X`; `type X` -> `X`; `X as Y` -> `Y` (a re-export's public name). */
function reExportedNames(braceContent: string): string[] {
  return braceContent
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => entry.replace(/^type\s+/, "").trim())
    .map((entry) => {
      const asMatch = /^.+?\s+as\s+(.+)$/.exec(entry);
      return (asMatch?.[1] ?? entry).trim();
    });
}

/** Resolves a relative re-export specifier (`./errors.js`) to a source `.ts`/`.tsx` file on disk. */
async function readRelativeModule(
  fromFile: string,
  specifier: string,
): Promise<{ path: string; source: string } | undefined> {
  if (!specifier.startsWith(".")) return undefined; // only local barrels are followed
  const withoutExtension = specifier.replace(/\.jsx?$/, "");
  const base = resolve(dirname(fromFile), withoutExtension);
  for (const extension of [".ts", ".tsx"]) {
    const candidate = `${base}${extension}`;
    try {
      const source = await readFile(candidate, "utf8");
      return { path: candidate, source };
    } catch {
      // try the next extension
    }
  }
  return undefined;
}

/**
 * Every name a TypeScript source file exports, following `export * from
 * "./relative.js"` re-exports recursively (needed for `@qspecs/core`'s
 * `export * from "./errors.js"`, the only barrel indirection in this repo).
 * Named re-exports (`export { X } from "./file.js"`) are resolved from the
 * brace list itself, without opening `./file.js` — the alias in the brace is
 * the public name regardless of what the source module called it.
 */
async function extractExportedNames(
  filePath: string,
  seen: Set<string> = new Set(),
): Promise<Set<string>> {
  const names = new Set<string>();
  if (seen.has(filePath)) return names;
  seen.add(filePath);

  const source = await readFile(filePath, "utf8");

  for (const match of source.matchAll(EXPORT_BRACE_RE)) {
    const braceContent = match[1];
    if (braceContent === undefined) continue;
    for (const name of reExportedNames(braceContent)) names.add(name);
  }

  for (const match of source.matchAll(EXPORT_STAR_RE)) {
    const specifier = match[1];
    if (specifier === undefined) continue;
    const nestedModule = await readRelativeModule(filePath, specifier);
    if (nestedModule === undefined) continue;
    const nestedNames = await extractExportedNames(nestedModule.path, seen);
    for (const name of nestedNames) names.add(name);
  }

  for (const match of source.matchAll(EXPORT_DECLARATION_RE)) {
    const name = match[1];
    if (name !== undefined) names.add(name);
  }

  return names;
}

async function loadPackages(): Promise<PackageInfo[]> {
  const directories = await readdir(packagesDir);
  const infos: PackageInfo[] = [];
  for (const shortName of directories) {
    const manifestPath = join(packagesDir, shortName, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    const name = manifest["name"];
    if (typeof name !== "string") {
      throw new Error(`${manifestPath} has no string "name" field`);
    }
    const peerDeps = manifest["peerDependencies"];
    const peerDependencies = new Set<string>(
      peerDeps !== null && typeof peerDeps === "object" ? Object.keys(peerDeps) : [],
    );
    const indexPath = join(packagesDir, shortName, "src", "index.ts");
    const exportedNames = await extractExportedNames(indexPath);
    infos.push({ name, shortName, peerDependencies, exportedNames });
  }
  return infos;
}

// ---------------------------------------------------------------------------
// README's "## Packages" table.
// ---------------------------------------------------------------------------

/**
 * The only package/peer-dependency table in scope. `docs/plugins.md`,
 * `docs/public-api.md`, and `docs/specification-versioning.md` all discuss
 * `peerDependencies` in prose, but none of them render a second table of
 * package rows to drift out of sync — grep confirms no other `.md` file
 * (outside `docs/superpowers/`, which is frozen and excluded everywhere in
 * this file) contains a "Peer dependencies" table column.
 */
function extractPackagesSection(markdown: string): string {
  const heading = "## Packages";
  const lines = markdown.split("\n");
  const startIndex = lines.findIndex((line) => line.trim() === heading);
  if (startIndex === -1) {
    throw new Error(`README.md has no "${heading}" heading — nothing for this guard to check`);
  }
  const rest = lines.slice(startIndex + 1);
  const endOffset = rest.findIndex((line) => line.startsWith("## "));
  return (endOffset === -1 ? rest : rest.slice(0, endOffset)).join("\n");
}

interface TableRow {
  readonly packageName: string;
  readonly peerDependencies: ReadonlySet<string>;
}

function parsePackageTable(section: string): TableRow[] {
  const dataLines = section
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|"))
    .filter((line) => !/^\|[\s|:-]+\|$/.test(line)); // drop the "| --- | --- |" separator

  const rows: TableRow[] = [];
  for (const line of dataLines) {
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    const packageCell = cells[0];
    const peerDepsCell = cells[2];
    if (packageCell === undefined || peerDepsCell === undefined) {
      throw new Error(`README.md package table row has fewer than 3 columns: "${line}"`);
    }
    if (packageCell === "Package") continue; // header row
    const packageName = packageCell.replace(/`/g, "");
    const peerDependencies = new Set(
      [...peerDepsCell.matchAll(/`([^`]+)`/g)]
        .map((match) => match[1])
        .filter((n) => n !== undefined),
    );
    rows.push({ packageName, peerDependencies });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Documented imports: `import { X, type Y } from "@qspecs/<pkg>"` inside a
// `ts`/`tsx` fence in README.md or a top-level docs/*.md file.
// ---------------------------------------------------------------------------

interface DocumentedImport {
  readonly sourceFile: string;
  readonly packageShortName: string;
  readonly importedNames: readonly string[];
}

const CODE_FENCE_RE = /```([a-zA-Z]*)\n([\s\S]*?)```/g;
const QSPEC_IMPORT_RE = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']@qspecs\/([a-z]+)["']/g;

/** `X` -> `X`; `type X` -> `X`; `X as Y` -> `X` (the name being imported, not the local alias). */
function importedNames(braceContent: string): string[] {
  return braceContent
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => entry.replace(/^type\s+/, ""))
    .map((entry) => {
      const asIndex = entry.search(/\s+as\s+/);
      return (asIndex === -1 ? entry : entry.slice(0, asIndex)).trim();
    });
}

/**
 * Scoped to `ts`/`tsx`/`js`/`jsx` fences and to specifiers literally starting
 * with `@qspecs/` — this repository's own published scope.
 *
 * The language scoping is bounded by what was verified, not by a claim that
 * no other fence language could ever contain an import: a scan of every
 * fenced block across README.md and docs/*.md (excluding docs/superpowers/)
 * found `@qspecs/*` imports only inside `ts`, `tsx`, and `js` fences (e.g.
 * README.md's and docs/cli.md's `qspec.config.mjs` examples, both fenced as
 * `js`) — never inside a `bash`, `text`, `json`, or unlabeled fence. `jsx` is
 * included for symmetry even though no current fence uses it. A fence
 * labeled something else entirely (or left unlabeled) is not scanned by this
 * check — that is a real, stated gap, not a claim that no such fence exists
 * anywhere.
 *
 * The scoping to `@qspecs/` specifiers is the answer to the false-positive
 * risk a plugin-authoring example poses: every hypothetical or third-party
 * example in these docs (see `docs/plugin-authoring.md`'s
 * `"my-qspec-plugin"`, `"my-qspec-source"`) names its *own* plugin in a
 * string passed to `definePlugin({ name: ... })` — it is never the target of
 * an `import ... from "..."` specifier, so it never enters this scan. Only
 * real imports *from* this repo's own shipped packages are checked; nothing
 * about a third party's own package is ever asserted here.
 */
function documentedImports(sourceFile: string, markdown: string): DocumentedImport[] {
  const imports: DocumentedImport[] = [];
  for (const fenceMatch of markdown.matchAll(CODE_FENCE_RE)) {
    const lang = fenceMatch[1];
    const content = fenceMatch[2];
    if (lang === undefined || content === undefined) continue;
    if (lang !== "ts" && lang !== "tsx" && lang !== "js" && lang !== "jsx") continue;
    for (const importMatch of content.matchAll(QSPEC_IMPORT_RE)) {
      const braceContent = importMatch[1];
      const packageShortName = importMatch[2];
      if (braceContent === undefined || packageShortName === undefined) continue;
      imports.push({ sourceFile, packageShortName, importedNames: importedNames(braceContent) });
    }
  }
  return imports;
}

/**
 * Directory names, direct children of `docsDir`, that `walkMarkdownFiles`
 * prunes on sight rather than descending into. `docs/superpowers/` is the
 * only one: historical plan and spec documents, deliberately frozen and out
 * of scope for a drift guard that checks the current package surface.
 *
 * Named explicitly, not incidental: `walkMarkdownFiles` recurses into every
 * *other* subdirectory of `docs/`, so a legitimate new one (say
 * `docs/guides/`) is scanned by default the day it appears, rather than
 * silently dropped the way a non-recursive listing would drop it.
 */
const EXCLUDED_DOC_DIRECTORIES = new Set(["superpowers"]);

/** Every `.md` file under `directory`, recursively, skipping any directory named in `EXCLUDED_DOC_DIRECTORIES`. */
async function walkMarkdownFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DOC_DIRECTORIES.has(entry.name)) continue;
      files.push(...(await walkMarkdownFiles(join(directory, entry.name))));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(join(directory, entry.name));
    }
  }
  return files;
}

/** README.md plus every `.md` file anywhere under `docs/`, outside `EXCLUDED_DOC_DIRECTORIES`. */
async function scannedDocFiles(): Promise<string[]> {
  return [readmePath, ...(await walkMarkdownFiles(docsDir))];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("docs drift: README package table", () => {
  it("excludes docs/superpowers/ from every scan in this file", async () => {
    const entries = await readdir(docsDir, { withFileTypes: true });
    const superpowers = entries.find((entry) => entry.name === "superpowers");
    expect(
      superpowers?.isDirectory(),
      "docs/superpowers/ is expected to exist as a directory",
    ).toBe(true);

    // docs/superpowers/plans/ and docs/superpowers/specs/ hold real, nested
    // .md files — proving those never appear in the scanned list shows the
    // exclusion is a named prune in walkMarkdownFiles, not an accident of a
    // non-recursive listing that would happen to skip a directory two levels
    // deep for a completely different reason.
    const nestedSuperpowersFiles = await walkMarkdownFiles(join(docsDir, "superpowers"));
    expect(
      nestedSuperpowersFiles.length,
      "docs/superpowers/ has no nested .md files — this regression test is checking nothing",
    ).toBeGreaterThan(0);

    const scanned = await scannedDocFiles();
    expect(scanned.some((file) => file.includes("superpowers"))).toBe(false);
  });

  it("finds a non-empty table to check", async () => {
    const readme = await readFile(readmePath, "utf8");
    const rows = parsePackageTable(extractPackagesSection(readme));
    expect(
      rows.length,
      "README package table scan found no rows — this guard checked nothing",
    ).toBeGreaterThan(0);
  });

  it("every row names a real package, and every real package has a row", async () => {
    const packages = await loadPackages();
    const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
    const readme = await readFile(readmePath, "utf8");
    const rows = parsePackageTable(extractPackagesSection(readme));

    const rowNames = new Set(rows.map((row) => row.packageName));
    for (const row of rows) {
      expect(
        byName.has(row.packageName),
        `table row "${row.packageName}" is not a real package`,
      ).toBe(true);
    }
    const allPackageNames = new Set(packages.map((pkg) => pkg.name));
    expect(rowNames, "README's package table and the packages/ directory disagree").toEqual(
      allPackageNames,
    );
  });

  it("every row's peer-dependency cell matches that package's manifest exactly", async () => {
    const packages = await loadPackages();
    const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
    const readme = await readFile(readmePath, "utf8");
    const rows = parsePackageTable(extractPackagesSection(readme));

    for (const row of rows) {
      const pkg = byName.get(row.packageName);
      if (pkg === undefined) continue; // reported by the previous test
      expect(
        [...row.peerDependencies].sort(),
        `README's peer-dependency cell for ${row.packageName}`,
      ).toEqual([...pkg.peerDependencies].sort());
    }
  });
});

describe("docs drift: documented @qspecs/* imports exist", () => {
  it("finds documented imports to check", async () => {
    const files = await scannedDocFiles();
    const all: DocumentedImport[] = [];
    for (const file of files) {
      all.push(...documentedImports(file, await readFile(file, "utf8")));
    }
    expect(
      all.length,
      "doc import scan found nothing — this guard checked nothing",
    ).toBeGreaterThan(0);
  });

  it("every imported name is actually exported by the named @qspecs package", async () => {
    const packages = await loadPackages();
    const byShortName = new Map(packages.map((pkg) => [pkg.shortName, pkg]));
    const files = await scannedDocFiles();

    for (const file of files) {
      const markdown = await readFile(file, "utf8");
      for (const doc of documentedImports(file, markdown)) {
        const pkg = byShortName.get(doc.packageShortName);
        expect(
          pkg,
          `${file} imports from "@qspecs/${doc.packageShortName}", which is not a package in packages/`,
        ).toBeDefined();
        if (pkg === undefined) continue;
        for (const name of doc.importedNames) {
          expect(
            pkg.exportedNames.has(name),
            `${file} imports "${name}" from "@qspecs/${doc.packageShortName}", which does not export it`,
          ).toBe(true);
        }
      }
    }
  });
});
