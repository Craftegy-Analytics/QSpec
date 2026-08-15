import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { QSpecPlugin } from "@qspecs/core";

/** The shape a `--config` module resolves to. */
export interface QSpecConfig {
  readonly plugins: readonly QSpecPlugin[];
}

/** Raised for every problem `loadConfig` diagnoses itself (as opposed to errors thrown by the config module, which are surfaced unchanged). */
export class ConfigError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ConfigError";
  }
}

/** A short, unambiguous label for an arbitrary value, for "expected X, found Y" diagnostics. */
function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  const type = typeof value;
  if (type === "object") return "an object";
  if (type === "undefined") return "undefined";
  return `a ${type} (${JSON.stringify(value)})`;
}

function isModuleNotFoundError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ERR_MODULE_NOT_FOUND";
}

/**
 * Extracts the plugin list from an imported config module's namespace object.
 *
 * A named `plugins` export is used if present. Otherwise, the `default`
 * export is used, and it must itself be an object with a `plugins` property —
 * this is the `export default { plugins: [...] }` shape used by tools like
 * Vite and Vitest. A module offering neither is a shape error naming both
 * possibilities, since either is legitimate.
 *
 * If a module happens to export both, the named `plugins` export wins: it is
 * the more explicit of the two, and choosing it deterministically means a
 * config author who defines both never gets a silently-ignored one.
 */
function extractConfig(moduleExports: object, resolvedPath: string): QSpecConfig {
  let plugins: unknown;
  if (Object.hasOwn(moduleExports, "plugins") && "plugins" in moduleExports) {
    plugins = moduleExports.plugins;
  } else if (Object.hasOwn(moduleExports, "default") && "default" in moduleExports) {
    const defaultExport: unknown = moduleExports.default;
    if (
      defaultExport === null ||
      typeof defaultExport !== "object" ||
      Array.isArray(defaultExport) ||
      !Object.hasOwn(defaultExport, "plugins") ||
      !("plugins" in defaultExport)
    ) {
      throw new ConfigError(
        `Config module "${resolvedPath}" has a default export, but it is not an object ` +
          `with a "plugins" property. Expected a default export shaped like ` +
          `{ plugins: [...] }, found ${describe(defaultExport)}.`,
      );
    }
    plugins = defaultExport.plugins;
  } else {
    throw new ConfigError(
      `Config module "${resolvedPath}" exports neither a named "plugins" array nor a ` +
        `default export with a "plugins" property. Expected one of the two.`,
    );
  }

  if (!Array.isArray(plugins)) {
    throw new ConfigError(
      `Config module "${resolvedPath}" exports "plugins", but it is not an array. ` +
        `Expected an array of plugin objects, found ${describe(plugins)}.`,
    );
  }

  plugins.forEach((plugin: unknown, index: number) => {
    if (plugin === null || typeof plugin !== "object" || Array.isArray(plugin)) {
      throw new ConfigError(
        `Config module "${resolvedPath}" exports "plugins[${index}]", but it is not a ` +
          `plugin object. Expected an object, found ${describe(plugin)}.`,
      );
    }
  });

  // Every element was checked above to be a non-null, non-array object, which
  // is all `loadConfig` validates — this is a registry-widening cast, not a
  // claim that each element already satisfies QSpecPlugin's full shape.
  return { plugins: plugins as readonly QSpecPlugin[] };
}

/**
 * Loads a `--config` module from an explicit path.
 *
 * The path is resolved against the current working directory, then imported
 * with a dynamic `import()` of its `file:` URL — no resolver library, no
 * extension guessing. There is deliberately no fallback search: a config is
 * never discovered implicitly (no walking up directories, no default
 * `qspec.config.js` lookup). Without an explicit path from the caller, this
 * function is never invoked at all, and no user code runs. Loading a config
 * executes arbitrary code, so that has to stay opt-in.
 *
 * An error thrown by the config module itself (during import, e.g. a
 * top-level `throw`) is rethrown unchanged: only a genuinely missing file is
 * translated into a `ConfigError` naming the resolved path.
 */
export async function loadConfig(path: string): Promise<QSpecConfig> {
  const resolvedPath = resolve(process.cwd(), path);

  let moduleExports: object;
  try {
    moduleExports = await import(pathToFileURL(resolvedPath).href);
  } catch (error) {
    if (isModuleNotFoundError(error)) {
      throw new ConfigError(`Config file not found: "${resolvedPath}".`, { cause: error });
    }
    throw error;
  }

  return extractConfig(moduleExports, resolvedPath);
}
