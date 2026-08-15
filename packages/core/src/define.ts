import { LimitExceededError, ManifestValidationError, type PathSegment } from "./errors.js";
import { isUnsafeKey } from "./json.js";
import type { QSpecManifest, QSpecResourceSpec } from "./types/manifest.js";
import type { QSpecPlugin } from "./types/plugin.js";

/**
 * Identity function that preserves literal types and gives editors something to
 * autocomplete against. No runtime work. (SPEC.md §56)
 */
export function defineManifest<const T extends QSpecManifest<QSpecResourceSpec>>(manifest: T): T {
  return manifest;
}

export interface ParseManifestOptions {
  /**
   * Reject documents larger than this many UTF-8 bytes. (SPEC.md §72.5)
   *
   * **String input only.** A manifest handed in already parsed is not measured,
   * and this is deliberate. The limit exists to bound the cost of turning
   * untrusted text into objects; by the time a caller has an object, that cost
   * has already been paid on their side, so there is nothing left to refuse.
   * Measuring one would mean `JSON.stringify`-ing the whole document — an
   * allocation as large as the input, on every prepare(), which throws on
   * cycles and BigInt — to enforce a bound that no longer protects anything.
   * Counting nodes instead would be cheap but would not be a byte count, so
   * the option would no longer mean what it says. The limits that do govern
   * post-parse work (`maxTransforms`, `maxExpressionDepth`, `maxRows`) apply to
   * both input forms.
   */
  readonly maxBytes?: number;
}

function fail(message: string, path: readonly PathSegment[]): never {
  throw new ManifestValidationError(message, {
    issues: [{ code: "QSPEC_MANIFEST_INVALID", message, path }],
  });
}

/**
 * Walks a parsed document rejecting keys that can corrupt prototypes.
 * (SPEC.md §72.4)
 *
 * `seen` is required because `parseManifest` also accepts an already-parsed
 * object: JSON.parse can never produce a cycle, but a caller handing in a live
 * object can, and an unguarded walk would blow the stack.
 */
function assertNoUnsafeKeys(
  value: unknown,
  path: readonly PathSegment[],
  seen: WeakSet<object> = new WeakSet(),
): void {
  if (typeof value !== "object" || value === null) return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoUnsafeKeys(item, [...path, index], seen));
    return;
  }
  for (const key of Object.getOwnPropertyNames(value)) {
    if (isUnsafeKey(key)) {
      fail(`Manifest contains the disallowed key "${key}", which can corrupt object prototypes.`, [
        ...path,
        key,
      ]);
    }
    assertNoUnsafeKeys((value as Record<string, unknown>)[key], [...path, key], seen);
  }
}

/**
 * Parses and structurally admits a manifest document. This is the document
 * boundary only — semantic validation is a separate stage.
 */
export function parseManifest(
  input: string | unknown,
  options: ParseManifestOptions = {},
): QSpecManifest<QSpecResourceSpec> {
  let document: unknown;

  if (typeof input === "string") {
    if (options.maxBytes !== undefined) {
      const bytes = new TextEncoder().encode(input).byteLength;
      if (bytes > options.maxBytes) {
        throw new LimitExceededError(
          `Manifest is ${bytes} bytes, which exceeds the configured limit of ${options.maxBytes}.`,
          { limit: "maxManifestBytes", actual: bytes, allowed: options.maxBytes },
        );
      }
    }
    try {
      document = JSON.parse(input) as unknown;
    } catch (error) {
      throw new ManifestValidationError("Manifest is not valid JSON.", {
        issues: [
          {
            code: "QSPEC_MANIFEST_INVALID",
            message: error instanceof Error ? error.message : "Unparseable JSON.",
            path: [],
          },
        ],
        cause: error,
      });
    }
  } else {
    document = input;
  }

  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    fail("A QSpec manifest must be a JSON object.", []);
  }

  assertNoUnsafeKeys(document, []);
  return document as QSpecManifest<QSpecResourceSpec>;
}

/**
 * Identity helper that gives plugin authors autocomplete without requiring them
 * to understand any runtime internals. (SPEC.md §105)
 */
export function definePlugin(plugin: QSpecPlugin): QSpecPlugin {
  return plugin;
}
