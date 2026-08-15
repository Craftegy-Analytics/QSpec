import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { getContainerRuntimeClient } from "testcontainers";
import { QSPEC_V1, createQSpec, type QSpec } from "@qspecs/core";
import { sql } from "@qspecs/sql";
import { postgres } from "@qspecs/postgres";
import { transforms } from "@qspecs/transforms";
import { charts, resolveSeries, type CartesianPresentation } from "@qspecs/charts";

/**
 * SPEC.md §116's complete production-readiness flow, proven end to end for
 * the first time, against a real PostgreSQL server rather than the in-memory
 * source `test/pipeline.test.ts` uses:
 *
 *   JSON manifest -> schema validation -> parameter validation ->
 *   SQL compilation -> PostgreSQL execution -> dataset normalization ->
 *   dataset validation -> transform pipeline -> chart presentation
 *
 * (React/Recharts rendering, the flow's final arrow, is Plan 4 and is not
 * exercised here.)
 *
 * Every stage below is real: the manifest arrives as a JSON *string*, so
 * `parseManifest`'s text path (stage 1, "schema validation") actually runs
 * instead of being skipped by handing `execute()` an object literal; `:from`/
 * `:to` are compiled by `@qspecs/sql` into a `CompiledSqlQuery` with no `text`
 * field and rendered to `$1`/`$2` placeholders only inside `@qspecs/postgres`;
 * the query genuinely executes against a container; normalization and
 * dataset validation run on a real `pg` result; and the transform pipeline
 * and chart presentation run on the dataset that came back.
 *
 * "Schema validation" here is `@qspecs/core`'s own structural validator
 * (`validateManifestStructure`), not `@qspecs/schema`'s Ajv-based one:
 * `@qspecs/core` has zero runtime dependencies, so Ajv structurally cannot run
 * inside `prepare()`. `@qspecs/schema` is exercised separately, by the CLI's
 * `validate` command against `fixtures/valid/*.qspec.json`.
 *
 * Container setup, skip detection, and timeouts follow
 * `packages/postgres/test/integration.test.ts` exactly — this file adds no
 * new conventions of its own.
 */
vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 });

/** Pinned for the same reason as the postgres package's own integration suite: reproducibility. */
const POSTGRES_IMAGE = "postgres:16-alpine";

const DB_PASSWORD = "qspec-e2e-pw-9d2b6a";
const DB_USER = "qspec";
const DB_NAME = "qspec_e2e";

const SOURCE = "analytics";

// --- Docker detection -------------------------------------------------------
// Identical approach to packages/postgres/test/integration.test.ts: ask
// testcontainers' own runtime discovery rather than probing a socket path, so
// this can never disagree with what `PostgreSqlContainer.start()` would find.

async function containerRuntimeUnavailableReason(): Promise<string | undefined> {
  try {
    await getContainerRuntimeClient();
    return undefined;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const firstLine = message.split("\n")[0] ?? message;
    return firstLine.slice(0, 200);
  }
}

const runtimeUnavailable = await containerRuntimeUnavailableReason();

const UNVERIFIED = [
  "the full JSON-manifest -> schema validation -> parameter validation -> SQL " +
    "compilation -> PostgreSQL execution -> normalization -> dataset validation -> " +
    "transform pipeline -> chart presentation flow (SPEC.md §116)",
  "resolveSeries against a dataset that actually came from PostgreSQL",
  "meta.query naming the source and language with no bound value attached",
].join("; ");

const suiteName =
  runtimeUnavailable === undefined
    ? "SPEC.md §116 end-to-end pipeline (testcontainers PostgreSQL)"
    : `SPEC.md §116 end-to-end pipeline — SKIPPED, no container runtime ` +
      `(${runtimeUnavailable}). UNVERIFIED: ${UNVERIFIED}`;

const describeIntegration = runtimeUnavailable === undefined ? describe : describe.skip;

if (runtimeUnavailable !== undefined) console.warn(suiteName);

// --- Shared state, all created in beforeAll --------------------------------

let container: StartedPostgreSqlContainer | undefined;
let admin: Client | undefined;
let runtime: QSpec | undefined;

function connectionUri(): string {
  if (container === undefined) throw new Error("the PostgreSQL container has not been started");
  return container.getConnectionUri();
}

function qspec(): QSpec {
  if (runtime === undefined) throw new Error("the QSpec runtime has not been created");
  return runtime;
}

/**
 * Rows 2-7 are the same shape as `test/pipeline.test.ts`'s in-memory
 * `ORDERS_TABLE`, so a reader who already trusts that test can trust the
 * numbers here: filter (revenue > 0) drops the zero-revenue January row,
 * derive adds a 10% bonus, sort orders by bonus descending, and limit keeps
 * the top three.
 *
 * Rows 1 and 8 exist for one reason: to make `:from`/`:to` binding
 * *falsifiable*, not just non-erroring. They sit just outside the manifest's
 * queried date range (2026-01-01..2026-03-31) and carry revenue values
 * (999, 777) large enough to dominate the derived `bonus` ranking and win a
 * `limit(3)` slot if they ever leaked in. An adapter that ignored the bound
 * range, swapped `:from`/`:to`, or substituted the wrong value would surface
 * one of them in the final three rows below (or, for a swap specifically,
 * empty the result — `occurred_on BETWEEN <to> AND <from>` matches nothing
 * when `from < to`) instead of quietly returning the same answer. Without
 * them, a WHERE clause that matched every row — the defect this exact test
 * shape has hidden before — would pass unnoticed, because every fixture row
 * already sits inside a wide enough range.
 *
 * `revenue` is `integer`, not `numeric`: this file is about proving the
 * pipeline runs end to end, not re-proving numeric/bigint-as-string, which
 * `packages/postgres/test/integration.test.ts` already covers directly. A
 * `numeric` column here would just make the derive step's arithmetic a
 * second, unrelated thing to reason about.
 */
const SALES_ROWS: readonly [id: number, month: string, occurredOn: string, revenue: number][] = [
  [1, "2025-12", "2025-12-15", 999], // before `from`: must not appear in the result
  [2, "2026-01", "2026-01-05", 100],
  [3, "2026-01", "2026-01-20", 0],
  [4, "2026-02", "2026-02-05", 50],
  [5, "2026-02", "2026-02-20", 30],
  [6, "2026-03", "2026-03-05", 20],
  [7, "2026-03", "2026-03-20", 200],
  [8, "2026-04", "2026-04-05", 777], // after `to`: must not appear in the result
];

/** A `Dataset` row without its null prototype, so `toEqual` can compare it to a literal. */
function plainRows(rows: readonly Record<string, unknown>[]): readonly Record<string, unknown>[] {
  return rows.map((row) => ({ ...row }));
}

function pipelineManifest(): string {
  return JSON.stringify({
    apiVersion: QSPEC_V1,
    kind: "Chart",
    metadata: { name: "postgres-pipeline-e2e" },
    spec: {
      parameters: {
        from: { type: "date", required: true },
        to: { type: "date", required: true },
      },
      query: {
        source: SOURCE,
        language: "sql",
        statement:
          "SELECT month, revenue FROM sales WHERE occurred_on BETWEEN :from AND :to ORDER BY id",
        bindings: { from: "$parameters.from", to: "$parameters.to" },
      },
      dataset: {
        fields: {
          month: { type: "string", nullable: false },
          revenue: { type: "number", nullable: false },
        },
      },
      transforms: [
        { type: "filter", where: { field: "revenue", operator: "gt", value: 0 } },
        {
          type: "derive",
          field: "bonus",
          fieldType: "number",
          expression: { operator: "multiply", arguments: [{ field: "revenue" }, { literal: 0.1 }] },
        },
        { type: "sort", field: "bonus", direction: "desc" },
        { type: "limit", count: 3 },
      ],
      presentation: {
        type: "line",
        x: { field: "month" },
        series: [{ field: "bonus", label: "Bonus" }],
      },
    },
  });
}

describeIntegration(suiteName, () => {
  beforeAll(async () => {
    container = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase(DB_NAME)
      .withUsername(DB_USER)
      .withPassword(DB_PASSWORD)
      .start();

    admin = new Client({ connectionString: connectionUri() });
    admin.on("error", () => undefined);
    await admin.connect();

    // Interpolated into SQL text -- ordinarily forbidden in this codebase
    // (SPEC.md §72.2), but acceptable here specifically because every value
    // is a fixed literal this file authored, not manifest- or caller-supplied
    // data; nothing here ever crosses the boundary `:from`/`:to` binding
    // exists to guard. Fixture setup, not the pipeline under test.
    const values = SALES_ROWS.map(
      ([id, month, occurredOn, revenue]) => `(${id}, '${month}', DATE '${occurredOn}', ${revenue})`,
    ).join(",\n        ");
    await admin.query(`
      CREATE TABLE sales (
        id          bigint PRIMARY KEY,
        month       text NOT NULL,
        occurred_on date NOT NULL,
        revenue     integer NOT NULL
      );
      INSERT INTO sales (id, month, occurred_on, revenue) VALUES
        ${values};
    `);

    // The four plugins named in the brief, wired exactly as the README's
    // quick start now shows: sql() for the query language, postgres() for
    // the adapter, transforms() and charts() for the rest of the pipeline.
    // The connection string is host configuration handed to postgres() here
    // -- it never appears in the manifest above. (SPEC.md §9, §72.1)
    runtime = createQSpec()
      .use(sql())
      .use(postgres({ sources: { [SOURCE]: { connectionString: connectionUri() } } }))
      .use(transforms())
      .use(charts());
    await runtime.ready();
  });

  afterAll(async () => {
    try {
      await runtime?.dispose();
    } finally {
      try {
        await admin?.end();
      } finally {
        await container?.stop();
      }
    }
  });

  it("runs the full SPEC.md §116 flow: JSON manifest to chart presentation", async () => {
    const manifestJson = pipelineManifest();
    // The manifest is a JSON *string* here, not an object literal: this is
    // what makes `parseManifest`'s text path -- and therefore stage 1
    // ("schema validation" in SPEC.md §116's terms) -- actually run.
    const prepared = await qspec().prepare(manifestJson);

    expect(prepared.kind).toBe("Chart");
    // Stage 6 (presentation), folded across filter -> derive -> sort -> limit,
    // computed with zero rows of real data and before any query has run.
    expect(prepared.projectedFields).toEqual(["month", "revenue", "bonus"]);

    const result = await prepared.execute({
      parameters: { from: "2026-01-01", to: "2026-03-31" },
    });

    // Same three rows, same order, `test/pipeline.test.ts` produces from the
    // in-memory source -- this time normalized from a real `pg` result. If
    // `:from`/`:to` bound the wrong values (swapped, ignored, or otherwise
    // wrong), row 1 (999) or row 8 (777) above would appear here instead, or
    // the range would match nothing at all -- see the SALES_ROWS comment.
    // This manifest's `spec.dataset` does run through `validateDataset`
    // (stage 5), but nothing in this result can violate it: for the
    // reachable failure cases -- a missing declared field, a non-nullable
    // column that came back null -- see
    // `packages/postgres/test/integration.test.ts`'s
    // "rejects a real result that contradicts spec.dataset" test instead.
    expect(plainRows(result.data.rows)).toEqual([
      { month: "2026-03", revenue: 200, bonus: 20 },
      { month: "2026-01", revenue: 100, bonus: 10 },
      { month: "2026-02", revenue: 50, bonus: 5 },
    ]);
    expect(result.meta.rowCount).toBe(3);

    // The presentation model is exactly the manifest's presentation object --
    // QSpec describes presentation, it does not render it.
    expect(result.presentation).toEqual({
      type: "line",
      x: { field: "month" },
      series: [{ field: "bonus", label: "Bonus" }],
    });

    const presentation = result.presentation;
    if (presentation === undefined) throw new Error("expected a presentation in the result");
    const series = resolveSeries(result.data, presentation as CartesianPresentation);
    expect(series).toEqual([
      {
        key: "bonus",
        label: "Bonus",
        field: "bonus",
        points: [
          { x: "2026-03", y: 20, index: 0 },
          { x: "2026-01", y: 10, index: 1 },
          { x: "2026-02", y: 5, index: 2 },
        ],
      },
    ]);

    // meta.query names the source and language, plus how long the query took
    // -- and nothing else. `ExecutionMetadata.query` has no room for a bound
    // value or a statement by construction (packages/core/src/types/
    // runtime.ts), and this proves it at runtime too: exactly these three
    // keys, and neither "2026-01-01" nor "2026-03-31" (the bound parameter
    // values) appears anywhere in it.
    //
    // `toEqual` alone would not catch an extra property whose value is
    // `undefined` -- it ignores those -- so the exact-three-keys check below
    // is what actually pins "nothing else", not the `toEqual` above it.
    expect(result.meta.query).toEqual({
      source: SOURCE,
      language: "sql",
      durationMs: expect.any(Number),
    });
    expect(Object.keys(result.meta.query ?? {}).sort()).toEqual([
      "durationMs",
      "language",
      "source",
    ]);
    const serializedQueryMeta = JSON.stringify(result.meta.query);
    expect(serializedQueryMeta).not.toContain("2026-01-01");
    expect(serializedQueryMeta).not.toContain("2026-03-31");
    expect(serializedQueryMeta).not.toContain(DB_PASSWORD);
  });
});
