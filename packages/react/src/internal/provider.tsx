import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import {
  createQueryCache,
  type QSpecExecutor,
  type QueryCache,
  type QueryParameters,
} from "./cache.js";

/**
 * What every hook in this package reads off context. `executor` is handed
 * back verbatim by `useQSpecExecutor`; `cache` and `invalidate` are the two
 * things `useQSpecQuery` and `useQSpecInvalidate` are built on. Not exported
 * from `index.ts` — this shape is an implementation detail shared only
 * between this module and `use-qspec-query.ts`.
 */
interface QSpecContextValue {
  readonly executor: QSpecExecutor;
  readonly cache: QueryCache;
  readonly invalidate: QueryCache["invalidate"];
}

/**
 * `undefined` by default so a hook called outside `QSpecProvider` can tell
 * "no provider" apart from "a provider whose executor happens to be
 * falsy" — the two are different failures, and only the first is what
 * `useQSpecContext` below reports.
 */
const QSpecContext = createContext<QSpecContextValue | undefined>(undefined);

export interface QSpecProviderProps {
  /**
   * The client half of a QSpec executor. Captured once, on this provider
   * instance's first render, and used for that instance's entire lifetime —
   * **not** re-read on every render. This is deliberate: a host that writes
   * `<QSpecProvider executor={createHttpExecutor({ url })}>` constructs a
   * brand-new executor object on every render of its own. Rebuilding the
   * cache to match a changing `executor` prop would rebuild the cache on
   * every render too, which loses the promise-identity guarantee `use()`
   * depends on (see `QSpecProvider`'s doc comment) and suspends every
   * consumer under it forever — the inline-object footgun, just relocated
   * from a query call to this prop and made fatal instead of merely
   * wasteful.
   *
   * To swap executors deliberately (re-authenticating with a new token, for
   * example), give this `<QSpecProvider>` element a new `key`. That
   * unmounts the old provider instance and mounts a fresh one, with a fresh
   * cache bound to the new executor — the React-idiomatic way to force a
   * full reset rather than an in-place update. Changing the `executor` prop
   * alone, with no `key` change, does not swap anything: `useQSpecExecutor`
   * keeps returning the original executor for as long as this instance
   * lives, and a development-only warning is logged once if the prop's
   * identity ever diverges from it.
   */
  readonly executor: QSpecExecutor;
  readonly children?: ReactNode;
}

/**
 * Reads `QSpecContext`, throwing a clear, hook-named error when there is no
 * enclosing `QSpecProvider` rather than letting the caller destructure
 * `undefined` and hit a confusing "cannot read properties of undefined"
 * a few lines later. `hookName` is the caller's own name (e.g.
 * `"useQSpecQuery"`), included in the message so the thrown error points
 * directly at which hook was misused, not just at this shared helper.
 */
export function useQSpecContext(hookName: string): QSpecContextValue {
  const context = useContext(QSpecContext);
  if (context === undefined) {
    throw new Error(
      `${hookName}() was called outside a QSpecProvider. Wrap your tree in <QSpecProvider executor={...}>.`,
    );
  }
  return context;
}

/**
 * Owns one `QueryCache` for its lifetime, built from `executor` with a
 * `useState` initializer rather than `useMemo`. `useMemo` is a performance
 * hint React is explicitly permitted to discard and recompute; if it did,
 * this provider would silently start handing out a fresh cache, and every
 * promise a `use()` call anywhere under it was already suspended on would be
 * orphaned — the component reading it would suspend again, call
 * `cache.get`, get yet another new promise from the new cache, and suspend
 * forever, with no error and no stack trace (see this task's report for the
 * reproduced hang). `useState`'s initializer function is guaranteed to run
 * exactly once per component instance, which is the only thing that keeps
 * the cache's promise-identity guarantee (see cache.ts's module doc
 * comment) alive across this provider's own re-renders.
 *
 * `QueryCache` has no subscription mechanism of its own (see cache.ts) — an
 * `invalidate` call there only ever removes `Map` entries, it never notifies
 * anything. The counter below is what closes that gap at the React layer:
 * bumping it forces `QSpecProvider` to re-render, which produces a brand
 * new `value` object (deliberately not memoized) for `QSpecContext.Provider`,
 * which in turn re-renders every descendant that calls `useContext` on this
 * context — including ones several components removed from whoever called
 * `useQSpecInvalidate`. A descendant whose query was just invalidated calls
 * `cache.get`, misses, and suspends on a freshly started promise; a
 * descendant whose query was untouched calls `cache.get`, hits the exact
 * same cached promise it already held, and `use()` returns synchronously —
 * no flicker, no re-fetch, just a render pass that changes nothing.
 */
export function QSpecProvider({ executor, children }: QSpecProviderProps): ReactNode {
  // Captured once — see QSpecProviderProps.executor's doc comment. Every
  // later read of "the executor" in this component (the cache's own
  // construction, and what `value.executor` below hands to
  // `useQSpecExecutor`) goes through `boundExecutor`, never the raw
  // `executor` prop, so the two public hooks can never disagree about which
  // executor is in effect.
  const [boundExecutor] = useState((): QSpecExecutor => executor);
  const [cache] = useState((): QueryCache => createQueryCache(boundExecutor));
  const [, forceRerender] = useState(0);
  const warnedAboutExecutorChange = useRef(false);

  // Development-only, fires at most once per provider instance: turns the
  // silent divergence described on QSpecProviderProps.executor into a
  // visible one, without changing behavior — `boundExecutor` still wins.
  // Written directly during render (not inside a useEffect) so it fires
  // exactly once even under StrictMode's double-invoked first render: the
  // second, throwaway invocation sees `warnedAboutExecutorChange.current`
  // already `true` and skips it.
  if (
    process.env.NODE_ENV !== "production" &&
    executor !== boundExecutor &&
    !warnedAboutExecutorChange.current
  ) {
    warnedAboutExecutorChange.current = true;
    console.warn(
      "QSpecProvider: the `executor` prop changed identity, but QSpecProvider binds " +
        "an executor once, on its first render, and keeps using that one for the " +
        "lifetime of this component instance — the new executor is being ignored. " +
        "To swap executors, give this <QSpecProvider> element a new `key` instead; " +
        "that mounts a fresh provider instance, with a fresh cache, bound to the new " +
        "executor.",
    );
  }

  const invalidate = useCallback(
    (resource?: string, ...parametersArg: [] | [QueryParameters | undefined]): void => {
      cache.invalidate(resource, ...parametersArg);
      forceRerender((count) => count + 1);
    },
    [cache, forceRerender],
  );

  const value: QSpecContextValue = { executor: boundExecutor, cache, invalidate };

  return <QSpecContext.Provider value={value}>{children}</QSpecContext.Provider>;
}
