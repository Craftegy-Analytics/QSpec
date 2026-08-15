import {
  QSpecError,
  type ExecutionContext,
  type QSpec,
  type QSpecManifest,
  type QSpecResourceSpec,
  type QSpecResult,
} from "@qspecs/core";
import type { QSpecExecutor } from "./cache.js";

/**
 * The manifests a `createLocalExecutor` instance is willing to execute,
 * keyed by resource name — structurally identical to `@qspecs/http`'s
 * `QSpecHandlerOptions["manifests"]`, but redeclared here rather than
 * imported, for the same reason `QSpecExecutor` is redeclared in cache.ts:
 * `@qspecs/react` depends on `@qspecs/core` only, never on a transport
 * package.
 */
export type LocalExecutorManifests = Readonly<
  Record<string, QSpecManifest<QSpecResourceSpec> | string>
>;

/**
 * Resolves `resource` against `manifests` exactly the way
 * `packages/http/src/internal/handler.ts`'s `resolveManifest` resolves a
 * wire request's resource name against the server's own registry:
 * `Object.hasOwn` against a plain object, never a bare bracket lookup. A
 * bare `manifests[resource]` would, for `resource: "toString"`, resolve to
 * `Object.prototype.toString` — a function, and therefore not `undefined` —
 * treating an unregistered name as if it named a real resource. See
 * local-executor.test.ts, which asserts a genuinely-unregistered name and an
 * only-inherited name like `"toString"` are rejected identically.
 */
function resolveManifest(
  manifests: LocalExecutorManifests,
  resource: string,
): QSpecManifest<QSpecResourceSpec> | string | undefined {
  return Object.hasOwn(manifests, resource) ? manifests[resource] : undefined;
}

/**
 * Builds a `QSpecExecutor` — the seam every hook and `QSpecProvider` in this
 * package is written against — directly on top of a `QSpec` runtime and a
 * fixed registry of manifests, with no HTTP hop in between. For a host that
 * runs its runtime and its UI in one process (an Electron app, a Node
 * script rendering to a string, a test), this is the whole adapter: no
 * server, no fetch, no protocol.
 *
 * Core executes a *manifest*; this seam (like `@qspecs/http`'s handler)
 * addresses a *resource name*. `execute` performs the same indirection
 * `createQSpecHandler` performs server-side — resolve the name against the
 * registry this executor was built with, reject an unknown name generically
 * (no enumeration of what else is registered — see `resolveManifest`), and
 * only then call `runtime.execute` on the resolved manifest.
 */
export function createLocalExecutor(
  runtime: QSpec,
  manifests: LocalExecutorManifests,
): QSpecExecutor {
  return {
    async execute(resource: string, context?: ExecutionContext): Promise<QSpecResult> {
      const manifest = resolveManifest(manifests, resource);
      if (manifest === undefined) {
        // Deliberately generic, mirroring handler.ts's mapped 404: no list,
        // no count, no did-you-mean. A host embedding this executor in a UI
        // that itself has no business enumerating its own private registry
        // to whatever renders the resulting error.
        throw new QSpecError("No resource is registered under the requested name.", {
          code: "QSPEC_RESOURCE_NOT_FOUND",
        });
      }
      return runtime.execute(manifest, context);
    },
  };
}
