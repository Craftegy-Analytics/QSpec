// @vitest-environment jsdom
import { Component, Suspense, useState, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecutionContext, QSpecResult } from "@qspecs/core";
import { QSpecProvider } from "./provider.js";
import { useQSpecExecutor, useQSpecInvalidate, useQSpecQuery } from "./use-qspec-query.js";
import type { QSpecExecutor, QueryParameters } from "./cache.js";

// @testing-library/react does not auto-detect vitest's global `afterEach`
// the way it does Jest's (no vitest-specific entry point exists in this
// version — see this task's report) — without this, every test's rendered
// tree accumulates in `document.body` instead of being unmounted, and
// `screen` queries (which search the whole document, not a per-test
// container) start matching nodes left over from earlier tests.
afterEach(cleanup);

/**
 * `render()` itself, awaited inside `act()`. This is not stylistic
 * caution: React 19 warns — and the retry this task depends on silently
 * never fires — when a component suspends during a `render()` call that
 * was not itself awaited inside `act(async () => ...)`. Every render in
 * this file mounts a tree that suspends immediately (the executor never
 * resolves synchronously), so every render in this file goes through this
 * helper rather than a bare `render(...)` call. See this task's report for
 * the exact warning text and the hang this produces when skipped.
 */
async function renderSuspended(ui: ReactNode): Promise<ReturnType<typeof render>> {
  let utils: ReturnType<typeof render> | undefined;
  await act(async () => {
    utils = render(ui);
  });
  if (utils === undefined) {
    throw new Error("render() did not run inside act()");
  }
  return utils;
}

/** `rerender()`, awaited inside `act()` — the same requirement as `renderSuspended`, for updates. */
async function rerenderSuspended(rerender: (ui: ReactNode) => void, ui: ReactNode): Promise<void> {
  await act(async () => {
    rerender(ui);
  });
}

/** Builds a one-row `QSpecResult` carrying a single `value` field, for a minimal render target. */
function makeResult(value: string): QSpecResult {
  return {
    data: { fields: [{ name: "value", type: "string" }], rows: [{ value }] },
    meta: { executionId: "exec-1", durationMs: 0, rowCount: 1 },
  };
}

/**
 * A `QSpecExecutor` double whose promises the test settles by hand — the
 * render-layer counterpart of cache.test.ts's `makeControlledExecutor`.
 * Necessary here for the same reason: proving things about WHEN the
 * executor is called (once vs. twice) and about the render committing only
 * after the promise the component is suspended on actually settles, neither
 * of which a `vi.fn().mockResolvedValue(...)` executor (which settles on
 * its own schedule) can pin down.
 */
function makeControlledExecutor() {
  const calls: Array<{ resource: string; context: ExecutionContext | undefined }> = [];
  const resolvers: Array<(result: QSpecResult) => void> = [];
  const rejecters: Array<(error: unknown) => void> = [];

  const executor: QSpecExecutor = {
    execute(resource, context) {
      calls.push({ resource, context });
      return new Promise<QSpecResult>((resolve, reject) => {
        resolvers.push(resolve);
        rejecters.push(reject);
      });
    },
  };

  return {
    executor,
    calls,
    /** Resolves call `index`, awaited inside `act()` so the resulting retry commits before returning. */
    async resolveCall(index: number, result: QSpecResult): Promise<void> {
      const resolve = resolvers[index];
      if (resolve === undefined) throw new Error(`no call at index ${index}`);
      await act(async () => {
        resolve(result);
      });
    },
    /** Rejects call `index`, awaited inside `act()`. */
    async rejectCall(index: number, error: unknown): Promise<void> {
      const reject = rejecters[index];
      if (reject === undefined) throw new Error(`no call at index ${index}`);
      await act(async () => {
        reject(error);
      });
    },
  };
}

/** Reads the single `value` field back out of a `QSpecResult`, or "" if the row is missing it. */
function readValue(result: QSpecResult): string {
  const row = result.data.rows[0];
  const value = row?.value;
  return typeof value === "string" ? value : "";
}

/** Renders `useQSpecQuery(resource, parameters)` as a single text node, for assertions. */
function Value({
  resource,
  parameters,
}: {
  resource: string;
  parameters?: QueryParameters;
}): ReactNode {
  const result = useQSpecQuery(resource, parameters);
  return <div data-testid="value">{readValue(result)}</div>;
}

interface ErrorBoundaryState {
  readonly error: Error | undefined;
}

/**
 * The test's own error boundary — deliberately not a library helper. A
 * rejected `use()` call is exactly like a rejected `await`: something above
 * the suspending component has to catch it, and this package does not ship
 * that "something" itself (no `loading`/`error` wrapper — see
 * use-qspec-query.ts's doc comment). Each test that needs one builds it
 * fresh, proving the rethrow reaches ordinary React error-boundary
 * machinery with nothing special required of the host.
 */
class TestErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: undefined };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (error !== undefined) {
      return <div data-testid="error">{error.message}</div>;
    }
    return this.props.children;
  }
}

/**
 * Mocks `console.error`, recording every call instead of silencing them
 * indiscriminately — a blanket `mockImplementation(() => {})` across a whole
 * suspend-then-reject test would just as happily swallow a genuine React
 * `act()` warning, which is exactly the class of bug this file's
 * `renderSuspended`/`resolveCall` helpers exist to surface, not hide.
 * `assertOnlyExpected()` fails the test on any recorded call whose text
 * doesn't mention `expectedMessageFragment` — call it after the test's own
 * assertions, before restoring the spy.
 *
 * Deliberately does not throw from inside the `console.error` mock itself.
 * React invokes `console.error` from deep inside its own commit-phase
 * internals (`defaultOnCaughtError` → `logCaughtError` → a commit callback);
 * a throw from inside that call does not propagate back through the test's
 * own `await act(...)` the way a normal synchronous throw would — it
 * surfaces as vitest's own "Unhandled Errors" for the whole run instead,
 * detached from whichever `it(...)` was actually running (confirmed by
 * deliberately breaking `expectedMessageFragment` and observing the output;
 * see this task's fix report). Recording calls and asserting afterward
 * produces a normal, attributable `AssertionError` on the right test
 * instead.
 */
function mockConsoleError(expectedMessageFragment: string): {
  readonly spy: ReturnType<typeof vi.spyOn>;
  assertOnlyExpected(): void;
} {
  const calls: string[] = [];
  const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    calls.push(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(" "));
  });
  return {
    spy,
    assertOnlyExpected(): void {
      for (const call of calls) {
        expect(call, "unexpected console.error call").toContain(expectedMessageFragment);
      }
    },
  };
}

describe("useQSpecQuery", () => {
  it("suspends, then renders the resolved data (never asserted on the fallback alone)", async () => {
    const { executor, resolveCall } = makeControlledExecutor();

    await renderSuspended(
      <QSpecProvider executor={executor}>
        <Suspense fallback={<div data-testid="fallback" />}>
          <Value resource="orders" />
        </Suspense>
      </QSpecProvider>,
    );

    // `getByTestId` already throws if the fallback isn't there — the real
    // assertion is that the actual content isn't either, yet.
    screen.getByTestId("fallback");
    expect(screen.queryByTestId("value")).toBeNull();

    await resolveCall(0, makeResult("first"));

    // Settled DOM, not the fallback, is the assertion — a hang here (not a
    // failure) is exactly the signature a broken cache produces; see this
    // task's report.
    const value = await screen.findByTestId("value");
    expect(value.textContent).toBe("first");
  });

  it("changing parameters re-suspends and renders the new data, calling the executor twice", async () => {
    const { executor, calls, resolveCall } = makeControlledExecutor();

    function Tree({ id }: { id: number }): ReactNode {
      return (
        <QSpecProvider executor={executor}>
          <Suspense fallback={<div data-testid="fallback" />}>
            <Value resource="orders" parameters={{ id }} />
          </Suspense>
        </QSpecProvider>
      );
    }

    const { rerender } = await renderSuspended(<Tree id={1} />);
    await resolveCall(0, makeResult("first"));
    expect((await screen.findByTestId("value")).textContent).toBe("first");

    await rerenderSuspended(rerender, <Tree id={2} />);
    await resolveCall(1, makeResult("second"));
    expect((await screen.findByTestId("value")).textContent).toBe("second");

    expect(calls).toHaveLength(2);
    expect(calls[0]?.context).toEqual({ parameters: { id: 1 } });
    expect(calls[1]?.context).toEqual({ parameters: { id: 2 } });
  });

  it("re-rendering with the same parameters does not call the executor again", async () => {
    const { executor, calls, resolveCall } = makeControlledExecutor();

    // `parameters={{ id: 1 }}` is a fresh object literal on every render —
    // deliberately, to prove the cache dedupes by serialized content, not
    // by the object reference `useQSpecQuery` happens to be called with.
    function Tree({ label }: { label: string }): ReactNode {
      return (
        <QSpecProvider executor={executor}>
          <div data-testid="label">{label}</div>
          <Suspense fallback={<div data-testid="fallback" />}>
            <Value resource="orders" parameters={{ id: 1 }} />
          </Suspense>
        </QSpecProvider>
      );
    }

    const { rerender } = await renderSuspended(<Tree label="a" />);
    await resolveCall(0, makeResult("first"));
    expect((await screen.findByTestId("value")).textContent).toBe("first");

    await rerenderSuspended(rerender, <Tree label="b" />);

    expect(screen.getByTestId("label").textContent).toBe("b");
    expect((await screen.findByTestId("value")).textContent).toBe("first");
    expect(calls).toHaveLength(1);
  });

  it("a rejected query propagates to an error boundary, which renders its fallback", async () => {
    const { executor, rejectCall } = makeControlledExecutor();
    // React logs the caught render error to console.error even once the
    // boundary handles it; only that expected "boom" call is allowed
    // through unremarked — see mockConsoleError's doc comment for why this
    // isn't a blanket mock.
    const consoleError = mockConsoleError("boom");

    try {
      await renderSuspended(
        <QSpecProvider executor={executor}>
          <TestErrorBoundary>
            <Suspense fallback={<div data-testid="fallback" />}>
              <Value resource="orders" />
            </Suspense>
          </TestErrorBoundary>
        </QSpecProvider>,
      );

      await rejectCall(0, new Error("boom"));

      const errorNode = await screen.findByTestId("error");
      expect(errorNode.textContent).toBe("boom");
      consoleError.assertOnlyExpected();
    } finally {
      consoleError.spy.mockRestore();
    }
  });

  it("throws a clear error naming the missing provider when called outside QSpecProvider", async () => {
    function Bare(): ReactNode {
      useQSpecQuery("orders");
      return null;
    }
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(renderSuspended(<Bare />)).rejects.toThrow(/useQSpecQuery/);
      await expect(renderSuspended(<Bare />)).rejects.toThrow(/QSpecProvider/);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("useQSpecExecutor also throws a clear error naming the missing provider", async () => {
    function Bare(): ReactNode {
      useQSpecExecutor();
      return null;
    }
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(renderSuspended(<Bare />)).rejects.toThrow(/useQSpecExecutor/);
      await expect(renderSuspended(<Bare />)).rejects.toThrow(/QSpecProvider/);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("useQSpecInvalidate() followed by a re-render refetches", async () => {
    const { executor, calls, resolveCall } = makeControlledExecutor();

    function Consumer(): ReactNode {
      const result = useQSpecQuery("orders");
      const invalidate = useQSpecInvalidate();
      return (
        <div>
          <div data-testid="value">{readValue(result)}</div>
          <button onClick={() => invalidate("orders")}>refresh</button>
        </div>
      );
    }

    await renderSuspended(
      <QSpecProvider executor={executor}>
        <Suspense fallback={<div data-testid="fallback" />}>
          <Consumer />
        </Suspense>
      </QSpecProvider>,
    );

    await resolveCall(0, makeResult("first"));
    expect((await screen.findByTestId("value")).textContent).toBe("first");

    await act(async () => {
      fireEvent.click(screen.getByText("refresh"));
    });
    await resolveCall(1, makeResult("second"));

    expect((await screen.findByTestId("value")).textContent).toBe("second");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.resource).toBe("orders");
    expect(calls[1]?.resource).toBe("orders");
  });

  it("invalidating one query leaves an untouched sibling query's cached value alone", async () => {
    const { executor, calls, resolveCall } = makeControlledExecutor();

    function Consumer(): ReactNode {
      const orders = useQSpecQuery("orders");
      const customers = useQSpecQuery("customers");
      const invalidate = useQSpecInvalidate();
      return (
        <div>
          <div data-testid="orders">{readValue(orders)}</div>
          <div data-testid="customers">{readValue(customers)}</div>
          <button onClick={() => invalidate("orders")}>refresh orders</button>
        </div>
      );
    }

    await renderSuspended(
      <QSpecProvider executor={executor}>
        <Suspense fallback={<div data-testid="fallback" />}>
          <Consumer />
        </Suspense>
      </QSpecProvider>,
    );

    await resolveCall(0, makeResult("orders-1"));
    await resolveCall(1, makeResult("customers-1"));
    expect((await screen.findByTestId("orders")).textContent).toBe("orders-1");
    expect((await screen.findByTestId("customers")).textContent).toBe("customers-1");

    await act(async () => {
      fireEvent.click(screen.getByText("refresh orders"));
    });
    await resolveCall(2, makeResult("orders-2"));

    expect((await screen.findByTestId("orders")).textContent).toBe("orders-2");
    // Untouched by the invalidation: still the first committed value, no
    // third resolveCall needed for it — proof the customers query was never
    // re-fetched.
    expect((await screen.findByTestId("customers")).textContent).toBe("customers-1");
    expect(calls).toHaveLength(3);
  });

  it("two components using the same resource and parameters share one execution", async () => {
    const { executor, calls, resolveCall } = makeControlledExecutor();

    await renderSuspended(
      <QSpecProvider executor={executor}>
        <Suspense fallback={<div data-testid="fallback" />}>
          <Value resource="orders" parameters={{ id: 1 }} />
          <Value resource="orders" parameters={{ id: 1 }} />
        </Suspense>
      </QSpecProvider>,
    );

    await resolveCall(0, makeResult("shared"));

    const values = await screen.findAllByTestId("value");
    expect(values).toHaveLength(2);
    expect(values[0]?.textContent).toBe("shared");
    expect(values[1]?.textContent).toBe("shared");
    expect(calls).toHaveLength(1);
  });

  it("useQSpecExecutor returns the same executor QSpecProvider was constructed with", async () => {
    const { executor } = makeControlledExecutor();
    let observed: QSpecExecutor | undefined;

    function ReadExecutor(): null {
      observed = useQSpecExecutor();
      return null;
    }

    await renderSuspended(
      <QSpecProvider executor={executor}>
        <ReadExecutor />
      </QSpecProvider>,
    );

    expect(observed).toBe(executor);
  });
});

describe("QSpecProvider", () => {
  it("keeps one cache across a provider re-render triggered by unrelated state", async () => {
    const { executor, calls, resolveCall } = makeControlledExecutor();

    function App(): ReactNode {
      const [count, setCount] = useState(0);
      return (
        <QSpecProvider executor={executor}>
          <button onClick={() => setCount((c) => c + 1)}>increment</button>
          <div data-testid="count">{count}</div>
          <Suspense fallback={<div data-testid="fallback" />}>
            <Value resource="orders" parameters={{ id: 1 }} />
          </Suspense>
        </QSpecProvider>
      );
    }

    await renderSuspended(<App />);
    await resolveCall(0, makeResult("first"));
    expect((await screen.findByTestId("value")).textContent).toBe("first");

    await act(async () => {
      fireEvent.click(screen.getByText("increment"));
    });
    expect(screen.getByTestId("count").textContent).toBe("1");

    // Settled immediately — no second resolveCall needed. Under a cache
    // rebuilt on every QSpecProvider render (the useMemo-discarded failure
    // mode this task falsifies), the "increment" click above would rebuild
    // the cache and the still-mounted Value component would re-suspend on a
    // brand-new promise this test never resolves — but that does NOT time
    // out here, empirically: React 19 hides an already-committed suspended
    // subtree with `display: none` rather than unmounting it, so
    // `findByTestId` still resolves against the stale, pre-click node, and
    // execution reaches the `calls` assertion below — which is what
    // actually catches the bug, as a length mismatch rather than a hang.
    // See this task's fix report for the exact falsification output.
    expect((await screen.findByTestId("value")).textContent).toBe("first");
    expect(calls).toHaveLength(1);
  });

  describe("executor identity", () => {
    it("captures the executor once and ignores a later executor prop identity change", async () => {
      const a = makeControlledExecutor();
      const b = makeControlledExecutor();

      function Tree({ executor }: { executor: QSpecExecutor }): ReactNode {
        return (
          <QSpecProvider executor={executor}>
            <Suspense fallback={<div data-testid="fallback" />}>
              <Value resource="orders" />
            </Suspense>
          </QSpecProvider>
        );
      }

      const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const { rerender } = await renderSuspended(<Tree executor={a.executor} />);
        await a.resolveCall(0, makeResult("first"));
        expect((await screen.findByTestId("value")).textContent).toBe("first");

        await rerenderSuspended(rerender, <Tree executor={b.executor} />);

        // Still bound to `a`: the prop swap alone starts no new query
        // against `b`, and the value already committed via `a` is
        // untouched.
        expect(a.calls).toHaveLength(1);
        expect(b.calls).toHaveLength(0);
        expect(screen.getByTestId("value").textContent).toBe("first");
      } finally {
        consoleWarn.mockRestore();
      }
    });

    it("useQSpecExecutor still agrees with the executor the cache uses after the prop swaps", async () => {
      const a = makeControlledExecutor();
      const b = makeControlledExecutor();
      let observed: QSpecExecutor | undefined;

      function ReadExecutor(): null {
        observed = useQSpecExecutor();
        return null;
      }

      function Tree({ executor }: { executor: QSpecExecutor }): ReactNode {
        return (
          <QSpecProvider executor={executor}>
            <ReadExecutor />
            <Suspense fallback={<div data-testid="fallback" />}>
              <Value resource="orders" />
              <Value resource="customers" />
            </Suspense>
          </QSpecProvider>
        );
      }

      const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const { rerender } = await renderSuspended(<Tree executor={a.executor} />);
        await a.resolveCall(0, makeResult("orders-a"));

        await rerenderSuspended(rerender, <Tree executor={b.executor} />);
        // A genuinely new query (a different resource, not a cache hit) —
        // started after the swap, so it's real evidence of which executor
        // is still in effect, not just a leftover from before the swap.
        await a.resolveCall(1, makeResult("customers-a"));

        const values = await screen.findAllByTestId("value");
        expect(values.map((el) => el.textContent)).toEqual(["orders-a", "customers-a"]);
        // Both public hooks agree: useQSpecExecutor() still hands back
        // `a`, exactly the executor every query above actually ran
        // against.
        expect(observed).toBe(a.executor);
        expect(a.calls).toHaveLength(2);
        expect(b.calls).toHaveLength(0);
      } finally {
        consoleWarn.mockRestore();
      }
    });

    it("warns once in development when the executor prop changes identity, naming the key remedy", async () => {
      const a = makeControlledExecutor();
      const b = makeControlledExecutor();
      const c = makeControlledExecutor();

      function Tree({ executor }: { executor: QSpecExecutor }): ReactNode {
        return (
          <QSpecProvider executor={executor}>
            <Suspense fallback={<div data-testid="fallback" />}>
              <Value resource="orders" />
            </Suspense>
          </QSpecProvider>
        );
      }

      const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const { rerender } = await renderSuspended(<Tree executor={a.executor} />);
        await a.resolveCall(0, makeResult("first"));
        await screen.findByTestId("value");
        expect(consoleWarn).not.toHaveBeenCalled();

        await rerenderSuspended(rerender, <Tree executor={b.executor} />);
        expect(consoleWarn).toHaveBeenCalledTimes(1);
        expect(consoleWarn).toHaveBeenCalledWith(expect.stringMatching(/key/));

        // A second, later identity change — still only the one warning
        // from this provider instance's entire lifetime, not one per
        // change.
        await rerenderSuspended(rerender, <Tree executor={c.executor} />);
        expect(consoleWarn).toHaveBeenCalledTimes(1);
      } finally {
        consoleWarn.mockRestore();
      }
    });
  });
});
