import { describe, expect, it } from "vitest";
import type { DataSource } from "@qspecs/core";
import { memory } from "../memory.js";
import {
  assertAlreadyAbortedSignalRejects,
  assertConcurrencyIsolation,
  assertDisposeIdempotent,
  assertPositionalRows,
  runDataSourceContractTests,
} from "./data-source.js";

/**
 * `memory()` registers one DataSource instance per table name, but any of
 * those instances can execute any table configured on the same plugin: the
 * lookup is keyed by the compiled statement, not by which instance was
 * called (see memory.ts). So a single fresh plugin — with both a fast table
 * and a slow one — gives the fixture everything it needs from one source.
 *
 * `slow`'s delay (400ms) is chosen to clear the suite's own
 * slowQuery-is-slow-enough calibration check (default bound 150ms × 1.5
 * margin = 225ms) with room to spare, not just to satisfy it exactly.
 */
function createSource() {
  const plugin = memory({
    tables: {
      widgets: {
        columns: ["id", "name"],
        rows: [
          [1, "wrench"],
          [2, "hammer"],
        ],
      },
      slow: {
        columns: ["id", "name"],
        rows: [[1, "wrench"]],
        delayMs: 400,
      },
    },
  });
  const source = plugin.sources["widgets"];
  if (source === undefined) throw new Error("expected a widgets source to be registered");
  return source;
}

runDataSourceContractTests("memory()", {
  create: createSource,
  query: { source: "widgets", statement: "widgets", bindings: {} },
  expectedColumns: ["id", "name"],
  slowQuery: { source: "widgets", statement: "slow", bindings: {} },
});

/**
 * Pins that the suite actually rejects known-wrong sources, rather than
 * merely passing against a well-behaved one. Each wrong source targets
 * exactly one defect so a failure here points at a specific broken
 * assertion, not just "something regressed".
 */
describe("DataSource contract assertions — regression against known-wrong sources", () => {
  it("rejects a source that returns row objects instead of positional arrays", async () => {
    const source: DataSource = {
      async execute() {
        return {
          columns: [{ name: "id" }, { name: "name" }],
          rows: [
            { id: 1, name: "wrench" },
            { id: 2, name: "hammer" },
            // Deliberately wrong: row objects instead of positional arrays.
            // The cast is intentional — this is exactly the runtime shape
            // `assertPositionalRows` exists to catch, not something that
            // should type-check as a real RawQueryResult.
          ] as unknown as readonly (readonly unknown[])[],
        };
      },
    };
    // A message matcher, not just `.toThrow()`: without it, this would also
    // pass if `assertPositionalRows` failed for an unrelated reason.
    await expect(assertPositionalRows(source, {})).rejects.toThrow(/not a positional array/);
  });

  it("rejects a source that ignores its AbortSignal", async () => {
    const source: DataSource = {
      // No `context` parameter at all: the signal is ignored on purpose,
      // not merely unread.
      async execute() {
        return {
          columns: [{ name: "id" }, { name: "name" }],
          rows: [
            [1, "wrench"],
            [2, "hammer"],
          ],
        };
      },
    };
    // "promise resolved ... instead of rejecting" is vitest's own wording
    // for exactly this case (the signal was ignored and execute() resolved);
    // any other failure inside the helper would produce different text.
    await expect(assertAlreadyAbortedSignalRejects(source, {})).rejects.toThrow(/promise resolved/);
  });

  it("rejects a source with a shared mutable per-query buffer", async () => {
    // A single object reused and returned by every call, in place of a
    // fresh result per execution — the "single reused buffer" defect the
    // concurrency-isolation assertion names.
    const buffer: { columns: { readonly name: string }[]; rows: unknown[][] } = {
      columns: [],
      rows: [],
    };
    const source: DataSource = {
      async execute(query) {
        const delayMs =
          typeof query === "object" && query !== null && "delayMs" in query
            ? (query as { delayMs: number }).delayMs
            : 0;
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
        buffer.columns = [{ name: "id" }, { name: "name" }];
        buffer.rows = [
          [1, "wrench"],
          [2, "hammer"],
        ];
        return buffer;
      },
    };
    await expect(
      assertConcurrencyIsolation(source, {
        query: { delayMs: 0 },
        slowQuery: { delayMs: 300 },
        expectedColumns: ["id", "name"],
      }),
    ).rejects.toThrow(/shared per-query buffer/);
  });

  it("does not break a class-based source whose dispose() reads `this`", async () => {
    // Pins a regression: pulling `dispose` into a bare local
    // (`const dispose = source.dispose; ...; dispose()`) and calling it
    // unbound would run this with `this === undefined`, throwing `TypeError`
    // against a source that is behaving correctly. Calling `source.dispose()`
    // bound (see assertDisposeIdempotent) must not throw here.
    class PoolBackedSource implements DataSource {
      readonly pool = { ended: false, end: (): void => {} };
      async execute() {
        return {
          columns: [{ name: "id" }, { name: "name" }],
          rows: [
            [1, "wrench"],
            [2, "hammer"],
          ],
        };
      }
      dispose(): void {
        // Reads `this` — the shape the review flagged as "overwhelmingly
        // likely" for a real adapter (e.g. `this.pool.end()`).
        if (this.pool === undefined) {
          throw new TypeError("Cannot read properties of undefined (reading 'pool')");
        }
        this.pool.end();
      }
    }
    const source = new PoolBackedSource();
    await expect(assertDisposeIdempotent(source)).resolves.toBeUndefined();
  });
});
