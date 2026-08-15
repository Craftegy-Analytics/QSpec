// @vitest-environment jsdom
import { Component, Suspense, useState, type ReactNode } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecutionContext, QSpecResult } from "@qspecs/core";
import { QSpecProvider } from "./provider.js";
import { QSpecResource } from "./resource.js";
import type { QSpecExecutor } from "./cache.js";

// See use-qspec-query.test.tsx for why this is required: without it,
// rendered trees from earlier tests accumulate in `document.body` and
// `screen` queries start matching stale nodes.
afterEach(cleanup);

/** `render()`, awaited inside `act()` — see use-qspec-query.test.tsx for why every render in this file goes through this rather than a bare `render(...)` call. */
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
 * A `QSpecExecutor` double whose promises the test settles by hand — see
 * use-qspec-query.test.tsx's copy of this helper for why a
 * `vi.fn().mockResolvedValue(...)` executor can't stand in for it.
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
    async resolveCall(index: number, result: QSpecResult): Promise<void> {
      const resolve = resolvers[index];
      if (resolve === undefined) throw new Error(`no call at index ${index}`);
      await act(async () => {
        resolve(result);
      });
    },
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

interface ErrorBoundaryState {
  readonly error: Error | undefined;
}

/** The test's own error boundary — see use-qspec-query.test.tsx's copy for why this package does not ship one itself. */
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
 * indiscriminately. See use-qspec-query.test.tsx's copy of this helper for
 * why it deliberately does not throw from inside the mock itself.
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

describe("QSpecResource", () => {
  it("suspends until resolved, then renders its child with the result", async () => {
    const { executor, resolveCall } = makeControlledExecutor();

    await renderSuspended(
      <QSpecProvider executor={executor}>
        <Suspense fallback={<div data-testid="fallback" />}>
          <QSpecResource resource="orders">
            {(result) => <div data-testid="value">{readValue(result)}</div>}
          </QSpecResource>
        </Suspense>
      </QSpecProvider>,
    );

    // Assert the fallback is on screen and the child hasn't rendered yet —
    // not just that the eventual value is correct.
    screen.getByTestId("fallback");
    expect(screen.queryByTestId("value")).toBeNull();

    await resolveCall(0, makeResult("first"));

    const value = await screen.findByTestId("value");
    expect(value.textContent).toBe("first");
  });

  it("an inline parameters object literal does not cause a refetch loop", async () => {
    const { executor, calls, resolveCall } = makeControlledExecutor();

    // `parameters={{ from, to }}` is built fresh on every render of `Tree` —
    // deliberately, since this is the ordinary and expected way to call
    // `QSpecResource` (see SPEC.md §66 and this component's doc comment).
    // The order-independent, content-keyed cache from Task 4 is what keeps
    // a fresh object literal here from starting a new query on every
    // render.
    function Tree({ label }: { label: string }): ReactNode {
      return (
        <QSpecProvider executor={executor}>
          <div data-testid="label">{label}</div>
          <Suspense fallback={<div data-testid="fallback" />}>
            <QSpecResource
              resource="monthly-revenue"
              parameters={{ from: "2026-01-01", to: "2026-02-01" }}
            >
              {(result) => <div data-testid="value">{readValue(result)}</div>}
            </QSpecResource>
          </Suspense>
        </QSpecProvider>
      );
    }

    const { rerender } = await renderSuspended(<Tree label="a" />);
    await resolveCall(0, makeResult("revenue-1"));
    expect((await screen.findByTestId("value")).textContent).toBe("revenue-1");

    // Re-render several times with a new `parameters` object literal each
    // time (via `label` forcing `Tree` to re-run) and confirm the cached
    // value survives and the executor is never called again.
    await rerenderSuspended(rerender, <Tree label="b" />);
    await rerenderSuspended(rerender, <Tree label="c" />);

    expect(screen.getByTestId("label").textContent).toBe("c");
    expect((await screen.findByTestId("value")).textContent).toBe("revenue-1");
    expect(calls).toHaveLength(1);
  });

  it("a rejected query reaches the host's own error boundary, not one QSpecResource provides", async () => {
    const { executor, rejectCall } = makeControlledExecutor();
    const consoleError = mockConsoleError("boom");

    try {
      await renderSuspended(
        <QSpecProvider executor={executor}>
          <TestErrorBoundary>
            <Suspense fallback={<div data-testid="fallback" />}>
              <QSpecResource resource="orders">
                {(result) => <div data-testid="value">{readValue(result)}</div>}
              </QSpecResource>
            </Suspense>
          </TestErrorBoundary>
        </QSpecProvider>,
      );

      await rejectCall(0, new Error("boom"));

      const errorNode = await screen.findByTestId("error");
      expect(errorNode.textContent).toBe("boom");
      expect(screen.queryByTestId("value")).toBeNull();
      consoleError.assertOnlyExpected();
    } finally {
      consoleError.spy.mockRestore();
    }
  });

  it("re-renders triggered by unrelated state do not call the executor again", async () => {
    const { executor, calls, resolveCall } = makeControlledExecutor();

    function App(): ReactNode {
      const [count, setCount] = useState(0);
      return (
        <QSpecProvider executor={executor}>
          <button onClick={() => setCount((c) => c + 1)}>increment</button>
          <div data-testid="count">{count}</div>
          <Suspense fallback={<div data-testid="fallback" />}>
            <QSpecResource resource="orders" parameters={{ id: 1 }}>
              {(result) => <div data-testid="value">{readValue(result)}</div>}
            </QSpecResource>
          </Suspense>
        </QSpecProvider>
      );
    }

    await renderSuspended(<App />);
    await resolveCall(0, makeResult("first"));
    expect((await screen.findByTestId("value")).textContent).toBe("first");

    await act(async () => {
      screen.getByText("increment").click();
    });
    expect(screen.getByTestId("count").textContent).toBe("1");
    expect((await screen.findByTestId("value")).textContent).toBe("first");
    expect(calls).toHaveLength(1);
  });
});
