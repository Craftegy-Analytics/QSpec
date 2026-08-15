import { readFile } from "node:fs/promises";
import {
  QSpecError,
  createQSpec,
  formatPath,
  parseManifest,
  validateManifestStructure,
  type QSpecIssue,
  type QSpecManifest,
  type QSpecResourceSpec,
} from "@qspecs/core";
import { validateWithJsonSchema } from "@qspecs/schema";
import { bold, dim, green, red } from "../color.js";
import { loadConfig } from "../internal/config.js";
import { createStubSource } from "../internal/stub-source.js";

export interface CliIo {
  out(text: string): void;
  err(text: string): void;
  readonly color: boolean;
  /** Selects machine-readable output. Commands that have no JSON mode ignore it. */
  readonly json?: boolean;
}

function hasIssues(error: unknown): error is { issues: readonly QSpecIssue[] } {
  return (
    error !== null &&
    typeof error === "object" &&
    "issues" in error &&
    Array.isArray((error as { issues: unknown }).issues)
  );
}

/** The `details.suggestion` hint, for the errors that carry one there. */
function detailSuggestion(error: unknown): string | undefined {
  if (!(error instanceof QSpecError)) return undefined;
  const details: unknown = error.details;
  if (details === null || typeof details !== "object" || !("suggestion" in details)) {
    return undefined;
  }
  const suggestion: unknown = details.suggestion;
  return typeof suggestion === "string" ? suggestion : undefined;
}

/**
 * Renders any caught error as issues the printer can show.
 *
 * The non-aggregate QSpec errors — unknown resource kind, query language, and
 * data source — carry their "did you mean" hint in `details.suggestion` and
 * their location in `error.path` rather than in a `QSpecIssue`. Lifting both
 * across is what makes those three hints reachable; before this they were
 * computed and then never shown. (SPEC.md §71)
 */
export function toIssues(error: unknown): readonly QSpecIssue[] {
  if (hasIssues(error)) return error.issues;
  const suggestion = detailSuggestion(error);
  return [
    {
      code: error instanceof QSpecError ? error.code : "QSPEC_MANIFEST_INVALID",
      message: error instanceof Error ? error.message : String(error),
      path: error instanceof QSpecError ? (error.path ?? []) : [],
      ...(suggestion === undefined ? {} : { suggestion }),
    },
  ];
}

/**
 * Renders a manifest's diagnostics to `io.err`. Shared by `validate` and
 * `inspect`: both must fail on an unreadable/malformed manifest with a
 * diagnostic instead of a stack trace, and duplicating this formatting would
 * let the two commands' error output drift apart.
 */
export function printIssues(
  path: string,
  issues: readonly QSpecIssue[],
  io: CliIo,
  summary?: string,
): void {
  io.err(`${red("✗ Invalid QSpec manifest", io.color)} ${dim(path, io.color)}`);
  if (summary !== undefined) {
    io.err("");
    io.err(summary);
  }
  for (const issue of issues) {
    io.err("");
    io.err(`${bold(formatPath(issue.path), io.color)}:`);
    io.err(`  ${issue.message}`);
    if (issue.suggestion !== undefined) {
      io.err(`  ${dim(`Did you mean "${issue.suggestion}"?`, io.color)}`);
    }
  }
}

export interface RunValidateOptions {
  /**
   * Path to a `--config` module exporting `plugins`. When present, every
   * manifest that passes structural validation is additionally run through
   * `prepare()` with those plugins installed, which is the only way to catch
   * transform- and query-language-specific defects (an unknown transform
   * operator, an expression nested past `maxExpressionDepth`, a typo'd SQL
   * binding) that a registry-free validator cannot see, because that
   * validation lives in each plugin's own `validate()` hook rather than in
   * core.
   *
   * Omitted, `validate` behaves exactly as it always has: structural
   * validation only, no plugins loaded, no user code executed.
   */
  readonly configPath?: string;
}

/**
 * Builds the plugin-aware `prepare()` step for one `--config` run, shared
 * across every manifest path being validated.
 *
 * A manifest's declared data source is never a real one here: `prepare()`
 * needs *a* `DataSource` to resolve `spec.query.source` against (core throws
 * `UnknownDataSourceError` otherwise), but a linter has no business holding
 * credentials, and validation must never execute a query. A stub is
 * registered under each source name the first manifest that references it
 * declares (`createStubSource()`'s `execute` always throws), which is enough
 * for `prepare()` to finish without ever calling it.
 *
 * Deliberately does NOT stub resource kinds: an unregistered `kind` is a
 * genuine authoring error `prepare()` must still surface, unlike a source
 * name, which is deployment configuration a linter cannot know in advance.
 */
async function buildPluginRuntime(
  configPath: string,
): Promise<(manifest: QSpecManifest<QSpecResourceSpec>) => Promise<void>> {
  const config = await loadConfig(configPath);
  const runtime = createQSpec();
  for (const plugin of config.plugins) runtime.use(plugin);

  // Tracks which source names already have a queued stub plugin, so a source
  // referenced by several manifests in the same run is only registered once —
  // registering it twice would throw "already installed" on the second use().
  const stubbedSources = new Set<string>();

  return async (manifest) => {
    const sourceName = manifest.spec.query?.source;
    if (sourceName !== undefined && !stubbedSources.has(sourceName)) {
      stubbedSources.add(sourceName);
      runtime.use({
        name: `@qspecs/cli/stub-source:${sourceName}`,
        setup(api) {
          // A plugin loaded from --config may already provide a real source
          // under this name; a stub must never shadow it.
          if (!api.sources.has(sourceName)) {
            api.sources.register(sourceName, createStubSource());
          }
        },
      });
    }
    await runtime.prepare(manifest);
  };
}

/** Validates one or more manifest files. (SPEC.md §86) */
export async function runValidate(
  paths: readonly string[],
  io: CliIo,
  options?: RunValidateOptions,
): Promise<number> {
  if (paths.length === 0) {
    io.err("Usage: qspec validate <manifest.json> [...]");
    return 2;
  }

  let prepare: ((manifest: QSpecManifest<QSpecResourceSpec>) => Promise<void>) | undefined;
  if (options?.configPath !== undefined) {
    try {
      prepare = await buildPluginRuntime(options.configPath);
    } catch (error) {
      io.err(
        `${red("✗ Cannot load config", io.color)} ${options.configPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return 1;
    }
  }

  let failed = false;

  for (const path of paths) {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      failed = true;
      io.err(
        `${red("✗ Cannot read", io.color)} ${path}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      continue;
    }

    let manifest: unknown;
    try {
      manifest = parseManifest(text);
    } catch (error) {
      failed = true;
      printIssues(
        path,
        toIssues(error),
        io,
        // parseManifest's aggregate message (e.g. "Manifest is not valid
        // JSON.") is more informative than any single nested issue, so it is
        // surfaced as a summary line above the per-issue detail.
        error instanceof Error ? error.message : undefined,
      );
      continue;
    }

    const issues = validateManifestStructure(manifest);
    const schemaResult = validateWithJsonSchema(manifest);

    // The two validators are held in lockstep by the conformance test. A
    // disagreement means that guarantee has broken, and must be loud.
    if (issues.length === 0 && !schemaResult.valid) {
      failed = true;
      io.err(
        `${red("✗ Internal validator mismatch", io.color)} ${path}: the JSON Schema rejected ` +
          `a manifest the runtime accepted. Please report this. Schema errors: ${schemaResult.errors
            .map((error) => `${error.path}: ${error.message}`)
            .join("; ")}`,
      );
      continue;
    }

    if (issues.length > 0) {
      failed = true;
      printIssues(path, issues, io);
      continue;
    }

    // Safe: `issues.length === 0` above (in lockstep with the JSON Schema
    // check just above it) is exactly the guarantee that lets `assertValidManifest`
    // return this same shape internally — this is a registry-widening cast onto
    // an already-validated value, not a claim this validator itself established.
    const resource = manifest as QSpecManifest<QSpecResourceSpec>;

    if (prepare !== undefined) {
      try {
        await prepare(resource);
      } catch (error) {
        failed = true;
        printIssues(path, toIssues(error), io);
        continue;
      }
    }

    io.out(`${green("✓ Valid QSpec manifest", io.color)} ${dim(path, io.color)}`);
    io.out(`API version: ${resource.apiVersion}`);
    io.out(`Kind: ${resource.kind}`);
    io.out(`Name: ${resource.metadata.name}`);
  }

  return failed ? 1 : 0;
}
