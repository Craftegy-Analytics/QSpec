"use client";

/**
 * React bindings for QSpec: the Suspense-safe query cache
 * (`internal/cache.ts`, Task 4), the provider and hooks built on it
 * (`internal/provider.tsx`, `internal/use-qspec-query.ts`, Task 5),
 * `createLocalExecutor` for a host that runs its runtime and its UI in one
 * process, and `QSpecResource` (`internal/resource.tsx`, Task 6), a thin
 * declarative wrapper over `useQSpecQuery` for a render-prop child.
 * `"use client"` at the top of this file marks every export below
 * as client-only for bundlers that understand React Server Components —
 * `QSpecProvider` and the hooks all use client-only React APIs (`useState`,
 * `use`, context), so a server component tree must cross a client boundary
 * before rendering anything from this package.
 */
export {
  createQueryCache,
  type QSpecExecutor,
  type QueryCache,
  type QueryParameters,
} from "./internal/cache.js";
export { QSpecProvider, type QSpecProviderProps } from "./internal/provider.js";
export { useQSpecExecutor, useQSpecQuery, useQSpecInvalidate } from "./internal/use-qspec-query.js";
export { createLocalExecutor, type LocalExecutorManifests } from "./internal/local-executor.js";
export { QSpecResource, type QSpecResourceProps } from "./internal/resource.js";
