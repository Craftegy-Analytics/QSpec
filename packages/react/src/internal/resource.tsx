import type { ReactNode } from "react";
import type { QSpecResult } from "@qspecs/core";
import { useQSpecQuery } from "./use-qspec-query.js";
import type { QueryParameters } from "./cache.js";

export interface QSpecResourceProps {
  /** Passed straight through to `useQSpecQuery` — see that hook's doc comment for the cache key it derives from `resource` and `parameters` together. */
  readonly resource: string;
  /**
   * Passed straight through to `useQSpecQuery`. Compared by *content*, not
   * identity — see `useQSpecQuery`'s doc comment. That is what makes the
   * ordinary way of calling this component safe:
   *
   * ```tsx
   * <QSpecResource resource="monthly-revenue" parameters={{ from, to }}>
   *   {(result) => <MyChart result={result} />}
   * </QSpecResource>
   * ```
   *
   * `{ from, to }` is a fresh object literal on every render of the host.
   * That does not start a new query on every render — only a change in the
   * serialized *values* does.
   */
  readonly parameters?: QueryParameters;
  /** Render prop, called with the resolved `QSpecResult` once this component commits. Never called with a fallback value — see this component's doc comment. */
  readonly children: (result: QSpecResult) => ReactNode;
}

/**
 * Declarative wrapper over `useQSpecQuery` (SPEC.md §66): a thin
 * `resource`/`parameters`/render-prop shell around the hook, nothing more.
 *
 * **This component does not provide its own `<Suspense>` fallback or error
 * boundary.** That is a deliberate omission, not an oversight, and it is
 * worth stating plainly because the opposite is what a reader expects from a
 * component named `QSpecResource`: only the host knows the fallback
 * granularity it wants — one `<Suspense>` around a whole page, or one around
 * each individual widget — and only the host knows where an error should
 * surface. Wrap it yourself:
 *
 * ```tsx
 * <Suspense fallback={<Spinner />}>
 *   <ErrorBoundary fallback={<ErrorMessage />}>
 *     <QSpecResource resource="monthly-revenue" parameters={{ from, to }}>
 *       {(result) => <MyChart result={result} />}
 *     </QSpecResource>
 *   </ErrorBoundary>
 * </Suspense>
 * ```
 *
 * Suspends while the query is in flight and rethrows a rejection, exactly as
 * `useQSpecQuery` does — see that hook's doc comment for why there is no
 * `loading`/`error` value for `children` to ever receive instead.
 */
export function QSpecResource({ resource, parameters, children }: QSpecResourceProps): ReactNode {
  const result = useQSpecQuery(resource, parameters);
  return children(result);
}
