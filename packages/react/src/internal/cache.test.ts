import { describe, expect, it, vi } from "vitest";
import type { ExecutionContext, JsonValue, QSpecResult } from "@qspecs/core";
import { cacheKey, createQueryCache, type QSpecExecutor, type QueryParameters } from "./cache.js";

/** A minimal, otherwise-uninteresting `QSpecResult` — its shape is never asserted on below. */
function makeResult(): QSpecResult {
  return {
    data: { fields: [], rows: [] },
    meta: { executionId: "exec-1", durationMs: 0, rowCount: 0 },
  };
}

/**
 * A `QSpecExecutor` double that records every call and lets the test control
 * exactly when each call's promise resolves or rejects, so tests can prove
 * things about promise *identity* and about *when* the executor was invoked
 * relative to concurrent `get` calls — properties a simple
 * `vi.fn().mockResolvedValue(...)` executor cannot exercise, since it settles
 * synchronously-ish on microtask 1 regardless of how the test wants to
 * sequence things.
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
    resolveCall(index: number, result: QSpecResult = makeResult()): void {
      const resolve = resolvers[index];
      if (resolve === undefined) throw new Error(`no call at index ${index}`);
      resolve(result);
    },
    rejectCall(index: number, error: unknown): void {
      const reject = rejecters[index];
      if (reject === undefined) throw new Error(`no call at index ${index}`);
      reject(error);
    },
  };
}

/** A `QSpecExecutor` double that resolves immediately, for tests that don't care about timing. */
function makeImmediateExecutor() {
  const calls: Array<{ resource: string; context: ExecutionContext | undefined }> = [];
  const executor: QSpecExecutor = {
    execute(resource, context) {
      calls.push({ resource, context });
      return Promise.resolve(makeResult());
    },
  };
  return { executor, calls };
}

describe("cacheKey", () => {
  it("produces the same key for reordered top-level parameter keys", () => {
    expect(cacheKey("orders", { a: 1, b: 2 })).toBe(cacheKey("orders", { b: 2, a: 1 }));
  });

  it("produces the same key for reordered keys nested inside an object parameter", () => {
    const left: QueryParameters = { filter: { x: 1, y: 2 } };
    const right: QueryParameters = { filter: { y: 2, x: 1 } };
    expect(cacheKey("orders", left)).toBe(cacheKey("orders", right));
  });

  it("produces different keys for different values", () => {
    expect(cacheKey("orders", { id: 1 })).not.toBe(cacheKey("orders", { id: 2 }));
  });

  it("treats an explicit undefined value and a missing key as the same key", () => {
    const withUndefined: QueryParameters = { a: 1, b: undefined };
    const missing: QueryParameters = { a: 1 };
    expect(cacheKey("orders", withUndefined)).toBe(cacheKey("orders", missing));
  });

  it("treats no parameters argument and an empty parameters object as the same key", () => {
    expect(cacheKey("orders")).toBe(cacheKey("orders", {}));
  });

  it("treats null and undefined as different values", () => {
    const withNull: QueryParameters = { a: null };
    const withUndefined: QueryParameters = { a: undefined };
    expect(cacheKey("orders", withNull)).not.toBe(cacheKey("orders", withUndefined));
  });

  it("does not corrupt the key when a parameter is named __proto__", () => {
    // Built via JSON.parse, not an object literal: `{ __proto__: 1 }` as a
    // literal sets the prototype rather than creating an own property, which
    // would make this test pass for the wrong reason. JSON.parse always
    // creates a genuine own property, exactly the shape an attacker-supplied
    // request body would have on the wire.
    const parsed = JSON.parse('{"__proto__": 1, "safe": 2}') as Record<string, JsonValue>;
    expect(Object.hasOwn(parsed, "__proto__")).toBe(true);

    const key = cacheKey("orders", parsed);
    // The prototype of the plain object literal below must be untouched —
    // both by cacheKey's internals and by JSON.parse itself.
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
    expect(key).toContain("__proto__");
    expect(key).toContain("safe");
  });
});

describe("createQueryCache", () => {
  it("returns the identical promise by reference for the same key across repeated get calls", () => {
    const { executor } = makeImmediateExecutor();
    const cache = createQueryCache(executor);

    const first = cache.get("orders", { id: 1 });
    const second = cache.get("orders", { id: 1 });

    // Reference identity, not deep equality — this is precisely the
    // property React 19's `use()` requires to avoid an infinite suspend
    // loop. See this task's report for what breaks this looks like when it
    // fails.
    expect(second).toBe(first);
  });

  it("returns a different promise for a different key", () => {
    const { executor } = makeImmediateExecutor();
    const cache = createQueryCache(executor);

    const orders = cache.get("orders", { id: 1 });
    const customers = cache.get("customers", { id: 1 });

    expect(customers).not.toBe(orders);
  });

  it("does not retry a rejected entry automatically", async () => {
    const { executor, calls, rejectCall } = makeControlledExecutor();
    const cache = createQueryCache(executor);

    const first = cache.get("orders", { id: 1 });
    rejectCall(0, new Error("boom"));
    await expect(first).rejects.toThrow("boom");

    // Two more `get` calls for the same key, after the rejection has
    // settled — a retrying implementation would call the executor again
    // here, once per call.
    const second = cache.get("orders", { id: 1 });
    const third = cache.get("orders", { id: 1 });

    expect(calls).toHaveLength(1);
    expect(second).toBe(first);
    expect(third).toBe(first);
    await expect(second).rejects.toThrow("boom");
  });

  it("drops exactly the invalidated entry and starts a new promise on the next get", async () => {
    const { executor, calls } = makeImmediateExecutor();
    const cache = createQueryCache(executor);

    const first = cache.get("orders", { id: 1 });
    await first;

    cache.invalidate("orders", { id: 1 });
    const second = cache.get("orders", { id: 1 });

    expect(second).not.toBe(first);
    expect(calls).toHaveLength(2);
  });

  it("invalidate(resource, parameters) leaves other parameter sets for that resource cached", async () => {
    const { executor, calls } = makeImmediateExecutor();
    const cache = createQueryCache(executor);

    const targeted = cache.get("orders", { id: 1 });
    const other = cache.get("orders", { id: 2 });
    await Promise.all([targeted, other]);

    cache.invalidate("orders", { id: 1 });

    expect(cache.get("orders", { id: 2 })).toBe(other);
    expect(cache.get("orders", { id: 1 })).not.toBe(targeted);
    expect(calls).toHaveLength(3);
  });

  it("invalidate(resource) drops every entry for that resource regardless of parameters", async () => {
    const { executor, calls } = makeImmediateExecutor();
    const cache = createQueryCache(executor);

    const ordersA = cache.get("orders", { id: 1 });
    const ordersB = cache.get("orders", { id: 2 });
    const customers = cache.get("customers", { id: 1 });
    await Promise.all([ordersA, ordersB, customers]);

    cache.invalidate("orders");

    expect(cache.get("orders", { id: 1 })).not.toBe(ordersA);
    expect(cache.get("orders", { id: 2 })).not.toBe(ordersB);
    expect(cache.get("customers", { id: 1 })).toBe(customers);
    expect(calls).toHaveLength(5);
  });

  it("invalidate() with no arguments drops everything", async () => {
    const { executor, calls } = makeImmediateExecutor();
    const cache = createQueryCache(executor);

    const orders = cache.get("orders", { id: 1 });
    const customers = cache.get("customers", { id: 1 });
    await Promise.all([orders, customers]);

    cache.invalidate();

    expect(cache.get("orders", { id: 1 })).not.toBe(orders);
    expect(cache.get("customers", { id: 1 })).not.toBe(customers);
    expect(calls).toHaveLength(4);
  });

  it("calls the executor exactly once for two concurrent gets of the same key", () => {
    const { executor, calls } = makeControlledExecutor();
    const cache = createQueryCache(executor);

    // Both calls happen synchronously, back to back, before either promise
    // has any chance to settle — the definition of "concurrent" here.
    const first = cache.get("orders", { id: 1 });
    const second = cache.get("orders", { id: 1 });

    expect(calls).toHaveLength(1);
    expect(second).toBe(first);
  });

  it("passes parameters through to the executor as an ExecutionContext", () => {
    const { executor, calls } = makeImmediateExecutor();
    const cache = createQueryCache(executor);

    cache.get("orders", { id: 1 });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.resource).toBe("orders");
    expect(calls[0]?.context).toEqual({ parameters: { id: 1 } });
  });

  it("calls the executor with no context when no parameters are given", () => {
    const { executor, calls } = makeImmediateExecutor();
    const cache = createQueryCache(executor);

    cache.get("orders");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.context).toBeUndefined();
  });

  it("produces no unhandled rejection warning for a cached, un-awaited rejection", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const { executor, rejectCall } = makeControlledExecutor();
      const cache = createQueryCache(executor);

      // Deliberately not awaited or `.catch`ed by the test itself — this is
      // exactly the shape of a suspended render that abandons the promise
      // without observing it.
      cache.get("orders", { id: 1 });
      rejectCall(0, new Error("boom"));

      // Give the rejection's microtasks (and Node's unhandledRejection check,
      // which runs after the current microtask queue drains) a full turn.
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});
