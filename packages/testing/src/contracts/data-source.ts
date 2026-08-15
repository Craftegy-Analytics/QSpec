import { describe, expect, it } from "vitest";
import type { DataSource, DataSourceContext } from "@qspecs/core";

export interface DataSourceContractFixture {
  /** A fresh source per test — contract tests must not share connection state. */
  readonly create: () => DataSource | Promise<DataSource>;
  /**
   * A compiled query this source executes successfully, returning at least
   * one row. Must survive `structuredClone` — a compiled query carrying a
   * function, class instance, or driver handle makes the mutation-check
   * assertion below throw `DataCloneError` instead of reporting a normal
   * assertion failure.
   */
  readonly query: unknown;
  /** Column names `query` is expected to return, in order. */
  readonly expectedColumns: readonly string[];
  /**
   * A compiled query slow enough to abort mid-flight. Omit only if the source
   * genuinely cannot be slow; the cancellation assertions then skip, and the
   * suite reports that they did rather than passing silently.
   *
   * Must run for comfortably longer than `abortBoundMs` (see below) when
   * left to complete — the suite verifies this itself before trusting any
   * abort assertion built on top of it, and fails loudly, naming the gap,
   * if `slowQuery` turns out not to be slow enough.
   */
  readonly slowQuery?: unknown;
  /**
   * The rejection deadline the cancellation assertions hold the source to,
   * measured from the moment `abort()` is called. Defaults to
   * `DEFAULT_ABORT_BOUND_MS`, which is calibrated for an in-memory source.
   * An adapter whose abort path is a real round trip (a cancel request over
   * a new connection, on top of pool acquisition) should widen this rather
   * than let CI flakiness pass as a defect in the adapter.
   */
  readonly abortBoundMs?: number;
}

/**
 * How long to wait after issuing `slowQuery` before aborting, so the abort
 * lands while the source is genuinely mid-execution rather than racing its
 * own setup.
 */
const MID_FLIGHT_WAIT_MS = 20;

/** Default for `DataSourceContractFixture.abortBoundMs`; see its doc comment. */
const DEFAULT_ABORT_BOUND_MS = 150;

/**
 * How far past `abortBoundMs` a fixture's `slowQuery` must run, unaborted,
 * before the suite trusts it to give the timing-based cancellation
 * assertions real margin. Chosen so a `slowQuery` sitting right at the bound
 * — which would make every abort assertion pass whether or not the source
 * actually honors the signal — is caught before it can hide a real gap, the
 * way `memory()`'s original 300ms/150ms fixture accidentally had margin to
 * spare but a 100ms one would not have.
 */
const ABORT_BOUND_MARGIN = 1.5;

/**
 * A fresh `DataSourceContext` per call. `executionId` is random rather than
 * counter-based specifically so this module has no shared mutable state:
 * these functions are called both from the generated `it()` blocks below and
 * directly from adapter packages' own negative/regression tests, and a
 * counter would make `executionId` values depend on module-load order across
 * unrelated test files.
 */
function context(signal?: AbortSignal): DataSourceContext {
  return { executionId: `contract-${crypto.randomUUID()}`, logger: {}, signal };
}

function expectPositionalShape(result: {
  readonly columns: readonly { readonly name: string }[];
  readonly rows: readonly (readonly unknown[])[];
}): void {
  // An empty `rows` array satisfies "every row is an array" for zero rows,
  // which is exactly the vacuous case a broken fixture (or a source that
  // silently returns nothing) would otherwise slip through as. The shape
  // check only means something once there is at least one row to check it
  // against.
  expect(
    result.rows.length,
    "fixture's `query` (or `slowQuery`) returned no rows; the positional-shape check needs at " +
      "least one row to mean anything",
  ).toBeGreaterThan(0);
  for (const row of result.rows) {
    // Custom messages here (not just the generic `toBe`/`toHaveLength`
    // wording) so a negative test can pin `.rejects.toThrow(/pattern/)` to
    // this specific defect instead of merely "something in here threw".
    expect(
      Array.isArray(row),
      "row is not a positional array (got a non-array value, e.g. a row object)",
    ).toBe(true);
    expect(
      row,
      `row has ${row.length} cell(s) but columns.length is ${result.columns.length}`,
    ).toHaveLength(result.columns.length);
  }
}

// --- Individual assertions -------------------------------------------------
//
// Exported (a subset of them) so this package's own `data-source.test.ts` can
// pin negative regression tests directly against a known-wrong source without
// duplicating assertion logic. Not currently re-exported through `index.ts`
// or the package's `exports` map, so adapter packages outside `@qspecs/testing`
// cannot reach them yet — only `runDataSourceContractTests` and its fixture
// type are public. Each function throws (via `expect`) on failure and
// resolves cleanly on success, so a caller can invert it with
// `await expect(assertX(...)).rejects.toThrow()`.

/** This is the invariant core's normalizer depends on
 * (packages/core/src/internal/normalize-result.ts pairs each cell with
 * columns by index). A source returning row objects wouldn't error here — it
 * would produce a dataset of `undefined` cells further down the pipeline,
 * which is why this is checked directly against the source rather than
 * inferred from a downstream symptom. */
export async function assertPositionalRows(source: DataSource, query: unknown): Promise<void> {
  const result = await source.execute(query, context());
  expectPositionalShape(result);
}

async function assertColumnsMatch(
  source: DataSource,
  query: unknown,
  expectedColumns: readonly string[],
): Promise<void> {
  const result = await source.execute(query, context());
  expect(result.columns.map((column) => column.name)).toEqual(expectedColumns);
}

/** Passing a pre-aborted signal must reject rather than resolve. */
export async function assertAlreadyAbortedSignalRejects(
  source: DataSource,
  query: unknown,
): Promise<void> {
  const controller = new AbortController();
  controller.abort();
  await expect(source.execute(query, context(controller.signal))).rejects.toThrow();
}

/**
 * `slowQuery` must actually be slow, unaborted, or every timing-based
 * assertion below passes for the wrong reason: a source that ignores its
 * signal but happens to finish `slowQuery` quickly would still clear the
 * bound. This is the check the review found missing — the suite's teeth on
 * cancellation depended on a coupling between the bound and a specific
 * fixture's `delayMs` that existed only in a comment.
 */
async function assertSlowQueryIsSlowEnough(
  source: DataSource,
  slowQuery: unknown,
  boundMs: number,
): Promise<void> {
  const started = performance.now();
  await source.execute(slowQuery, context());
  const duration = performance.now() - started;
  const required = boundMs * ABORT_BOUND_MARGIN;
  expect(
    duration,
    `slowQuery resolved in ${duration.toFixed(1)}ms, which does not clear abortBoundMs ` +
      `(${boundMs}ms) with margin (needs > ${required.toFixed(1)}ms). slowQuery is not slow ` +
      "enough for the cancellation assertions below to have teeth.",
  ).toBeGreaterThan(required);
}

/**
 * A source that checks the signal only after running the query would still
 * reject here — just slowly, once `slowQuery` finished. The timing bound is
 * the only evidence the check happened before any work began, exactly as the
 * pre-execution-guard note in `memory.test.ts` explains.
 */
async function assertAlreadyAbortedSignalRejectsWithoutExecuting(
  source: DataSource,
  slowQuery: unknown,
  boundMs: number,
): Promise<void> {
  const controller = new AbortController();
  controller.abort();
  const started = performance.now();
  await expect(source.execute(slowQuery, context(controller.signal))).rejects.toThrow();
  expect(performance.now() - started).toBeLessThan(boundMs);
}

/**
 * Aborts only once `slowQuery` is genuinely in flight — confirmed by a
 * settled-flag, not just a delay, so a source that rejects `slowQuery`
 * immediately (unsupported query, connection error, anything) cannot pass
 * this by accident: if it had already settled before the wait finished, the
 * abort observed nothing.
 */
async function assertMidFlightAbortRejectsPromptly(
  source: DataSource,
  slowQuery: unknown,
  boundMs: number,
): Promise<void> {
  const controller = new AbortController();
  let settled = false;
  const promise = source.execute(slowQuery, context(controller.signal));
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  // Abort after the query is genuinely in flight, not before it starts —
  // aborting synchronously would be caught by a pre-execution guard and
  // would prove nothing about the source's own signal handling, per
  // memory.test.ts.
  await new Promise((resolve) => setTimeout(resolve, MID_FLIGHT_WAIT_MS));
  expect(
    settled,
    "slowQuery already settled before the abort was issued; it did not stay in flight long " +
      "enough for this assertion to say anything about mid-flight cancellation",
  ).toBe(false);
  const abortedAt = performance.now();
  controller.abort();
  await expect(promise).rejects.toThrow();
  // Without this bound, a source that ignores the signal and simply lets
  // `slowQuery` run to completion still "passes": it eventually rejects (or
  // resolves) once the delay elapses regardless. Rejecting well inside the
  // bound is the only evidence the source's own signal handling — not just
  // the query finishing — caused the rejection.
  expect(performance.now() - abortedAt).toBeLessThan(boundMs);
}

/**
 * Runs `query` and `slowQuery` concurrently and requires the fast one to
 * resolve, correctly, *while the slow one is still pending* — proven with a
 * settled-flag on the slow promise, not inferred from timing. A source
 * keeping per-query state on `this` (a shared cursor, a single reused row
 * buffer) can hand back the same in-flight object to both callers; even when
 * the two calls' data happens to be correct, sharing survives a naive
 * deep-equal check, so this also asserts the two results are not the same
 * object by reference.
 */
export async function assertConcurrencyIsolation(
  source: DataSource,
  fixture: Pick<DataSourceContractFixture, "query" | "slowQuery" | "expectedColumns">,
): Promise<void> {
  if (fixture.slowQuery === undefined) {
    throw new Error("assertConcurrencyIsolation requires fixture.slowQuery");
  }
  let slowSettled = false;
  const slowPromise = source.execute(fixture.slowQuery, context());
  slowPromise.then(
    () => {
      slowSettled = true;
    },
    () => {
      slowSettled = true;
    },
  );
  const fast = await source.execute(fixture.query, context());
  expect(
    slowSettled,
    "slowQuery resolved before query did; slowQuery must be slower than query for this " +
      "assertion to prove anything about shared per-query state",
  ).toBe(false);
  expect(fast.columns.map((column) => column.name)).toEqual(fixture.expectedColumns);
  expectPositionalShape(fast);
  const slow = await slowPromise;
  // Custom messages so a negative test can pin `.rejects.toThrow(/pattern/)`
  // to this specific defect (a shared object returned to both callers)
  // rather than any failure this function happens to produce.
  expect(
    fast.rows,
    "concurrent calls returned the same rows array by reference — results must be independent " +
      "objects, not a shared per-query buffer",
  ).not.toBe(slow.rows);
  expect(
    fast,
    "concurrent calls returned the same result object by reference — results must be independent " +
      "objects, not a shared per-query buffer",
  ).not.toBe(slow);
}

/**
 * Calls `dispose()` twice, bound as `source.dispose()` — never detached into
 * a bare local — because `dispose()` is a method
 * (packages/core/src/types/plugin.ts) and a class-based adapter's `dispose()`
 * plausibly reads `this` (e.g. `this.pool.end()`). Assumes the source
 * implements it; the `it()` wrapper in `runDataSourceContractTests` is what
 * decides whether to call this or skip visibly.
 */
export async function assertDisposeIdempotent(source: DataSource): Promise<void> {
  if (typeof source.dispose !== "function") {
    throw new Error("assertDisposeIdempotent requires source.dispose to be a function");
  }
  await source.dispose();
  await source.dispose();
}

/**
 * An adapter that rewrites its input breaks prepare()-once/execute-many: a
 * second execute() with the same compiled query would run whatever the
 * first call left behind instead of what was actually compiled.
 * `toStrictEqual`, not `toEqual`: the latter treats `{ a: undefined }` and
 * `{}` as equal, so a mutation that deletes a key entirely (rather than
 * changing its value) would slip past a looser comparison.
 */
export async function assertQueryNotMutated(source: DataSource, query: unknown): Promise<void> {
  const snapshot = structuredClone(query);
  await source.execute(query, context());
  expect(query).toStrictEqual(snapshot);
}

/**
 * Invariants every `DataSource` must satisfy, per SPEC.md §89. Call this from
 * an adapter package's own test file — against the in-memory source now, and
 * against every real adapter (Postgres, MySQL, DuckDB, ClickHouse, ...) as it
 * lands.
 */
export function runDataSourceContractTests(name: string, fixture: DataSourceContractFixture): void {
  const hasSlowQuery = fixture.slowQuery !== undefined;
  const abortBoundMs = fixture.abortBoundMs ?? DEFAULT_ABORT_BOUND_MS;

  describe(`${name} — DataSource contract`, () => {
    it("returns positional rows: every row is an array whose length equals columns.length", async () => {
      const source = await fixture.create();
      await assertPositionalRows(source, fixture.query);
    });

    it("returns columns matching the fixture's expected names, in order", async () => {
      const source = await fixture.create();
      await assertColumnsMatch(source, fixture.query, fixture.expectedColumns);
    });

    it("honors an already-aborted signal: execute() rejects rather than resolving", async () => {
      const source = await fixture.create();
      await assertAlreadyAbortedSignalRejects(source, fixture.query);
    });

    (hasSlowQuery ? it : it.skip)(
      hasSlowQuery
        ? "slowQuery is slow enough for the cancellation assertions to have teeth"
        : "slowQuery is slow enough for the cancellation assertions to have teeth (unverified: " +
            "no slowQuery fixture)",
      async () => {
        const source = await fixture.create();
        await assertSlowQueryIsSlowEnough(source, fixture.slowQuery, abortBoundMs);
      },
    );

    (hasSlowQuery ? it : it.skip)(
      hasSlowQuery
        ? "honors an already-aborted signal without executing, observed via timing"
        : "honors an already-aborted signal without executing (unverified: no slowQuery fixture — " +
            "cannot distinguish 'rejected before running' from 'ran to completion and then rejected')",
      async () => {
        const source = await fixture.create();
        await assertAlreadyAbortedSignalRejectsWithoutExecuting(
          source,
          fixture.slowQuery,
          abortBoundMs,
        );
      },
    );

    (hasSlowQuery ? it : it.skip)(
      hasSlowQuery
        ? "a mid-flight abort rejects promptly"
        : "a mid-flight abort rejects promptly (unverified: no slowQuery fixture — cannot get a " +
            "query genuinely in flight to abort)",
      async () => {
        const source = await fixture.create();
        await assertMidFlightAbortRejectsPromptly(source, fixture.slowQuery, abortBoundMs);
      },
    );

    (hasSlowQuery ? it : it.skip)(
      hasSlowQuery
        ? "does not let two concurrent executions share mutable state"
        : "does not let two concurrent executions share mutable state (unverified: no slowQuery " +
            "fixture — cannot keep one execution in flight while asserting the other)",
      async () => {
        const source = await fixture.create();
        await assertConcurrencyIsolation(source, fixture);
      },
    );

    it("dispose() does not throw when called twice, if the source implements it", async (ctx) => {
      const source = await fixture.create();
      if (typeof source.dispose !== "function") {
        // dispose() is optional on the DataSource interface itself (unlike
        // slowQuery, this is not a fixture gap to report) — a source with no
        // resources to release is not obligated to implement it. A dynamic
        // skip still reports visibly, rather than a silent early return
        // reporting the same green tick as an actual idempotency check.
        ctx.skip("source does not implement dispose(); two-call idempotency is unverified");
        return;
      }
      await assertDisposeIdempotent(source);
    });

    it("does not mutate the compiled query it is given", async () => {
      const source = await fixture.create();
      await assertQueryNotMutated(source, fixture.query);
    });
  });
}
