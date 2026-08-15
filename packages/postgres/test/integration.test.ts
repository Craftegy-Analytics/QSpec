import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { getContainerRuntimeClient } from "testcontainers";
import {
  DatasetValidationError,
  QSPEC_V1,
  QSpecAbortError,
  QueryExecutionError,
  createQSpec,
  type DataSource,
  type QSpec,
  type QSpecManifest,
  type QSpecResourceSpec,
} from "@qspecs/core";
import { sql, type CompiledSqlQuery } from "@qspecs/sql";
import { runDataSourceContractTests } from "@qspecs/testing";
import { postgres } from "../src/index.js";
import {
  createNodePostgresDriver,
  type PgClientOptions,
  type PgDriver,
  type PgPoolOptions,
} from "../src/internal/driver.js";
import { createPostgresSource } from "../src/internal/source.js";
import { OID_NAMES, postgresTypeName } from "../src/internal/types.js";

/**
 * SPEC.md §90: the adapter, the "sql" language, and core's normalization and
 * validation stages exercised against a real PostgreSQL server. Every other
 * test in this package runs against a fake `PgDriver`; this file is the only
 * place where the wire protocol, the real OIDs, and `pg_cancel_backend` are
 * actually involved.
 *
 * Vitest's 5s test timeout and 10s hook timeout are both far too short here:
 * one hook pulls and boots a container, and the contract suite deliberately
 * runs a multi-second `pg_sleep` to completion twice (once to calibrate, once
 * inside the concurrency assertion). These numbers are generous on purpose —
 * they are ceilings for a loaded CI runner, not expectations. Nothing in this
 * file waits for a timeout in the happy path, so raising them costs nothing
 * and lowering them buys nothing but flakiness.
 */
vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 });

/**
 * Pinned rather than floating: `PostgreSqlContainer` requires an explicit
 * image, and a test asserting exact `numeric`/`int8` text needs a server
 * version that cannot change underneath it.
 */
const POSTGRES_IMAGE = "postgres:16-alpine";

/**
 * The container's password. Distinctive so the SPEC.md §72.6 assertions —
 * "this string appears in no error message" — are searching for something
 * that could only have come from the connection string. The tests also assert
 * it really is present in the connection URI, so "not found" is never vacuous.
 *
 * This is host configuration handed to `postgres({ sources: … })`. No manifest
 * below carries a credential. (SPEC.md §9, §72.1)
 */
const DB_PASSWORD = "qspec-integration-pw-7f3a1c";
const DB_USER = "qspec";
const DB_NAME = "qspec_integration";

/** The logical source name every manifest here targets. */
const SOURCE = "analytics";

/**
 * The rejection deadline the contract suite holds this adapter to, measured
 * from `abort()`, and reused by the cancellation test below.
 *
 * The suite's 150ms default is calibrated for an in-memory source. This
 * adapter's abort path is a real round trip: open a *new* `pg.Client` to the
 * container (TCP connect, startup, authentication), issue
 * `SELECT pg_cancel_backend($1)`, wait for the server to answer, and only then
 * surface the `QSpecAbortError` — on top of whatever pool acquisition the
 * original query already paid for. Locally that lands in the low tens of
 * milliseconds; a CI runner sharing its CPU with the database container it is
 * talking to can stretch it by an order of magnitude.
 *
 * 2000ms is roughly 50x the observed local cost, so it will not flake, and it
 * is still 15x under the 30s sleep the cancellation test aborts — an adapter
 * that ignored the signal and simply waited for the query would miss this
 * bound by a factor of fifteen, so the bound keeps its teeth.
 */
const ABORT_BOUND_MS = 2_000;

/**
 * The contract suite requires `slowQuery`'s natural duration to exceed
 * `abortBoundMs` by 1.5x (3000ms here) and fails loudly if it does not, so 4s
 * leaves a full second of headroom. It is not larger because the suite runs
 * `slowQuery` to completion *twice* per run — once in its calibration check,
 * once awaited by the concurrency assertion — so every second here costs two.
 */
const SLOW_QUERY_SECONDS = 4;

/**
 * The contract suite's concurrency assertion requires `query` to resolve while
 * `slowQuery` is still in flight. A pool of 1 serializes them and the
 * assertion fails for a fixture defect that reads exactly like an adapter one,
 * so the pool must hold at least 2. 4 leaves room without opening connections
 * nothing uses.
 */
const CONTRACT_POOL_MAX = 4;

/** Marker embedded in the cancellation probe so `pg_stat_activity` lookups are unambiguous. */
const CANCEL_PROBE_MARKER = "qspec-cancel-probe";

/**
 * 30 seconds, per SPEC.md §90 — long enough that "the abort returned quickly"
 * cannot be confused with "the query happened to finish".
 */
const CANCEL_PROBE_SQL = `SELECT pg_sleep(30) AS slept /* ${CANCEL_PROBE_MARKER} */`;

/** How long to wait for the probe to show up as an active backend before giving up. */
const PROBE_VISIBLE_TIMEOUT_MS = 10_000;

/**
 * How long to wait for the cancelled backend to stop being active.
 * `pg_stat_activity` is sampled from shared memory and is not updated
 * synchronously with the cancel, so a single post-abort read can race it. 5s
 * is a ceiling for a stalled CI runner; the assertion reports how long it
 * actually took, and a run that needs anywhere near this long is reporting a
 * problem even though it passes.
 */
const BACKEND_SETTLE_TIMEOUT_MS = 5_000;

const BACKEND_POLL_INTERVAL_MS = 25;

// --- Docker detection ------------------------------------------------------

/**
 * Asked through testcontainers' own runtime discovery rather than by probing a
 * socket path directly, so this answer cannot disagree with what
 * `PostgreSqlContainer.start()` would find (it honors `DOCKER_HOST`, Colima
 * and Podman sockets, and testcontainers.properties identically).
 */
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

/**
 * Named individually rather than as "integration tests": a CI log line reading
 * "skipped" next to a green tick is indistinguishable from a pass unless it
 * says what stopped being checked.
 */
const UNVERIFIED = [
  "parameter binding (:from/:to, and an injection-shaped value bound as data)",
  "execution and normalization (timestamptz -> Date -> ISO; numeric/bigint as exact strings)",
  "duplicate column names surviving to the dataset",
  "dataset validation against a real query result",
  "server-side cancellation (QSpecAbortError plus pg_stat_activity proof)",
  "database errors (syntax error, missing table) not leaking the password",
  "the @qspecs/testing DataSource contract suite against the real adapter",
].join("; ");

const suiteName =
  runtimeUnavailable === undefined
    ? "@qspecs/postgres against a real PostgreSQL (testcontainers)"
    : `@qspecs/postgres against a real PostgreSQL — SKIPPED, no container runtime ` +
      `(${runtimeUnavailable}). UNVERIFIED: ${UNVERIFIED}`;

const describeIntegration = runtimeUnavailable === undefined ? describe : describe.skip;

// The suite name alone is not enough: vitest's default reporter prints
// "19 skipped" and never shows the describe it belongs to, which is exactly
// the "a skip looks like a pass" outcome this is meant to prevent. Printing at
// collection time puts the reason in the log under every reporter. Silent when
// a runtime is present, so a normal run stays clean.
if (runtimeUnavailable !== undefined) console.warn(suiteName);

// --- Shared state, all created in beforeAll --------------------------------

let container: StartedPostgreSqlContainer | undefined;
let admin: Client | undefined;
let runtime: QSpec | undefined;

/** Sources the contract fixture created, so their pools can be closed at the end. */
const contractSources: DataSource[] = [];

function connectionUri(): string {
  if (container === undefined) throw new Error("the PostgreSQL container has not been started");
  return container.getConnectionUri();
}

function adminClient(): Client {
  if (admin === undefined) throw new Error("the observation client has not been connected");
  return admin;
}

function qspec(): QSpec {
  if (runtime === undefined) throw new Error("the QSpec runtime has not been created");
  return runtime;
}

/**
 * The test's own observation channel, entirely separate from the adapter's
 * pools — it has to be, since the cancellation test inspects the adapter's
 * backend while the adapter's pool is busy running the query being inspected.
 *
 * `rowMode: "array"` with an explicit `unknown[]` row type: `@types/pg`
 * otherwise hands back `any`, and reading `any` out of a driver is exactly how
 * a test stops type-checking what it asserts.
 */
async function adminRows(
  text: string,
  values: readonly unknown[] = [],
): Promise<readonly (readonly unknown[])[]> {
  const result = await adminClient().query<unknown[], unknown[]>({
    text,
    values: [...values],
    rowMode: "array",
  });
  return result.rows;
}

/** The single cell of a single-row, single-column query. */
async function adminScalar(text: string, values: readonly unknown[] = []): Promise<unknown> {
  const rows = await adminRows(text, values);
  const row = rows[0];
  if (row === undefined) throw new Error(`query returned no rows: ${text}`);
  return row[0];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertInstanceOf<T>(
  value: unknown,
  constructor: new (...args: never[]) => T,
  what: string,
): asserts value is T {
  if (!(value instanceof constructor)) {
    throw new Error(
      `${what}: expected ${constructor.name}, got ${
        value instanceof Error ? `${value.name}: ${value.message}` : String(value)
      }`,
    );
  }
}

/**
 * Awaits a promise expected to reject and returns the rejection reason.
 * `expect(...).rejects` cannot be narrowed afterwards, and these tests need to
 * read `cause` and `issues` off the error they caught.
 */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

/** A `Dataset` row without its null prototype, so `toEqual` can compare it to a literal. */
function plainRows(rows: readonly Record<string, unknown>[]): readonly Record<string, unknown>[] {
  return rows.map((row) => ({ ...row }));
}

function datasetManifest(name: string, spec: QSpecResourceSpec): QSpecManifest<QSpecResourceSpec> {
  // "Dataset" is core's own built-in kind: no presentation plugin needed, and
  // nothing here carries a credential — the connection string lives in the
  // host's `postgres({ sources: … })` call. (SPEC.md §9, §72.1)
  return { apiVersion: QSPEC_V1, kind: "Dataset", metadata: { name }, spec };
}

// --- Contract-suite fixture ------------------------------------------------

const driver: PgDriver = createNodePostgresDriver({
  createPool: (options: PgPoolOptions) => new Pool(options),
  createClient: (options: PgClientOptions) => new Client(options),
});

/** Compiled by hand, exactly as `@qspecs/sql` would emit it: no `text`, only segments. */
const CONTRACT_QUERY: CompiledSqlQuery = {
  segments: ["SELECT id, region FROM events WHERE region = ", " ORDER BY id"],
  parameterNames: ["region"],
  values: ["north"],
  source: SOURCE,
};

/**
 * `SLOW_QUERY_SECONDS` is interpolated into a *segment*, which is literal SQL
 * this file authored — not a bound value. Nothing a caller supplies is ever
 * spliced into text; that is what `values`/`parameterNames` are for, and what
 * the injection test in the suite below proves. (SPEC.md §72.2)
 */
const CONTRACT_SLOW_QUERY: CompiledSqlQuery = {
  segments: [`SELECT pg_sleep(${SLOW_QUERY_SECONDS}) AS slept`],
  parameterNames: [],
  values: [],
  source: SOURCE,
};

function createContractSource(): DataSource {
  const source = createPostgresSource(
    SOURCE,
    { connectionString: connectionUri(), max: CONTRACT_POOL_MAX },
    driver,
  );
  // The suite builds a fresh source per test and never disposes them; without
  // this the file would leave a dozen pools open until the container dies.
  contractSources.push(source);
  return source;
}

// --- pg_stat_activity observation -----------------------------------------

interface BackendObservation {
  /** False once the session itself is gone from `pg_stat_activity`. */
  readonly present: boolean;
  readonly state: string | null;
  readonly query: string | null;
}

async function observeBackend(pid: number): Promise<BackendObservation> {
  const rows = await adminRows("SELECT state, query FROM pg_stat_activity WHERE pid = $1", [pid]);
  const row = rows[0];
  if (row === undefined) return { present: false, state: null, query: null };
  const state = row[0];
  const query = row[1];
  return {
    present: true,
    state: typeof state === "string" ? state : null,
    query: typeof query === "string" ? query : null,
  };
}

/**
 * Finds the backend running the cancellation probe.
 *
 * `pid <> pg_backend_pid()` excludes this observation connection: the marker
 * travels as a bound value rather than in this statement's text, so a
 * self-match should be impossible, but a lookup that could ever return its own
 * PID would silently make the whole cancellation assertion meaningless.
 */
async function waitForProbeBackendPid(): Promise<number> {
  const started = performance.now();
  while (performance.now() - started < PROBE_VISIBLE_TIMEOUT_MS) {
    // `adminRows`, not `adminScalar`: "no rows yet" is the normal case while
    // the query is still starting up, and it must not be indistinguishable
    // from the observation connection having failed.
    const rows = await adminRows(
      "SELECT pid FROM pg_stat_activity " +
        "WHERE pid <> pg_backend_pid() AND state = 'active' AND query LIKE $1",
      [`%${CANCEL_PROBE_MARKER}%`],
    );
    const pid = rows[0]?.[0];
    if (typeof pid === "number") return pid;
    await delay(BACKEND_POLL_INTERVAL_MS);
  }
  throw new Error(
    `the cancellation probe never appeared as an active backend within ` +
      `${PROBE_VISIBLE_TIMEOUT_MS}ms; there is no PID to prove anything about, so the ` +
      `cancellation assertion cannot run`,
  );
}

/**
 * Waits until the captured backend is no longer executing anything, and
 * reports how long that took.
 *
 * "No longer active" — not "the process exited" — is the right question:
 * `pg_cancel_backend` cancels the *statement*, leaving the session alive and
 * idle, which is precisely what lets the pool reuse the connection. A test
 * that demanded the session disappear would be asserting connection
 * destruction, the failure mode this adapter's cancel-on-a-second-connection
 * design exists to avoid.
 *
 * Throws rather than returning on timeout, with the last sample in the
 * message: a query still `active` here means the caller got its
 * `QSpecAbortError` while the server kept running the statement — abandonment,
 * holding locks and burning CPU, wearing cancellation's clothes.
 */
async function waitForBackendToStopRunning(pid: number): Promise<BackendObservation> {
  const started = performance.now();
  let samples = 0;
  let last: BackendObservation = { present: true, state: "active", query: null };
  while (performance.now() - started < BACKEND_SETTLE_TIMEOUT_MS) {
    last = await observeBackend(pid);
    samples += 1;
    if (!last.present || last.state !== "active") return last;
    await delay(BACKEND_POLL_INTERVAL_MS);
  }
  throw new Error(
    `backend PID ${pid} was STILL ACTIVE ${BACKEND_SETTLE_TIMEOUT_MS}ms after QSpecAbortError ` +
      `was raised (${samples} samples; last state=${last.state ?? "(none)"}, ` +
      `query=${last.query ?? "(none)"}). The abort was reported to the caller but the ` +
      `server-side query was abandoned, not cancelled.`,
  );
}

// --- The suite -------------------------------------------------------------

describeIntegration(suiteName, () => {
  beforeAll(async () => {
    container = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase(DB_NAME)
      .withUsername(DB_USER)
      .withPassword(DB_PASSWORD)
      .start();

    admin = new Client({ connectionString: connectionUri() });
    // `pg` emits 'error' on a dropped idle socket; an unhandled one would take
    // the test process down with it.
    admin.on("error", () => undefined);
    await admin.connect();

    await adminClient().query(`
      CREATE TABLE events (
        id          bigint PRIMARY KEY,
        region      text NOT NULL,
        occurred_on date NOT NULL,
        occurred_at timestamptz NOT NULL
      );
      INSERT INTO events (id, region, occurred_on, occurred_at) VALUES
        (1, 'north', DATE '2026-01-15', TIMESTAMPTZ '2026-01-15 10:30:00+00'),
        (2, 'north', DATE '2026-02-20', TIMESTAMPTZ '2026-02-20 08:00:00+00'),
        (3, 'south', DATE '2026-03-05', TIMESTAMPTZ '2026-03-05 12:00:00+00'),
        (4, 'north', DATE '2026-05-01', TIMESTAMPTZ '2026-05-01 23:59:00+00');

      CREATE TABLE injection_target (note text NOT NULL);
      INSERT INTO injection_target (note) VALUES ('still here');
    `);

    runtime = createQSpec()
      .use(sql())
      .use(postgres({ sources: { [SOURCE]: { connectionString: connectionUri() } } }));
    await runtime.ready();
  });

  afterAll(async () => {
    // Nested finallys, not a bare sequence: a dispose that throws must still
    // surface, and must still not leave a container running behind it.
    try {
      for (const source of contractSources) await source.dispose?.();
      await runtime?.dispose();
    } finally {
      try {
        await admin?.end();
      } finally {
        await container?.stop();
      }
    }
  });

  it("puts the password in the connection URI, so the leak assertions below are not vacuous", () => {
    expect(connectionUri()).toContain(DB_PASSWORD);
  });

  // --- Parameter binding (SPEC.md §90, §72.2) ------------------------------

  it("binds :from/:to and returns exactly the rows in range", async () => {
    // `from` sits strictly between rows 1 (01-15) and 2 (02-20), and `to`
    // sits strictly between rows 2 and 3 (03-05): both bounds do real work,
    // excluding one row apiece. `from: "2026-01-01"` would exclude nothing
    // (row 1 is already >= it) and let `:to` alone carry the whole
    // assertion — the defect this exact test shape has hidden before.
    const result = await qspec().execute(
      datasetManifest("binding-range", {
        parameters: {
          from: { type: "date", required: true },
          to: { type: "date", required: true },
        },
        query: {
          source: SOURCE,
          language: "sql",
          statement:
            "SELECT id, region FROM events WHERE occurred_on BETWEEN :from AND :to ORDER BY id",
          bindings: { from: "$parameters.from", to: "$parameters.to" },
        },
      }),
      { parameters: { from: "2026-02-01", to: "2026-02-28" } },
    );

    // `id` is `bigint`, which stays a string — see the precision test below.
    expect(plainRows(result.data.rows)).toEqual([{ id: "2", region: "north" }]);
    expect(result.meta.rowCount).toBe(1);
  });

  it("binds an injection-shaped value as data: the named table survives", async () => {
    const injection = "'; DROP TABLE injection_target; --";

    const result = await qspec().execute(
      datasetManifest("binding-injection", {
        parameters: { region: { type: "string", required: true } },
        query: {
          source: SOURCE,
          language: "sql",
          statement: "SELECT id FROM events WHERE region = :region",
          bindings: { region: "$parameters.region" },
        },
      }),
      { parameters: { region: injection } },
    );

    // Bound as a value, so it simply matches no region.
    expect(result.data.rows).toEqual([]);
    // The assertion that matters: had the value reached the server as SQL
    // text, this table would be gone. (SPEC.md §72.2)
    expect(await adminScalar("SELECT to_regclass('public.injection_target')::text")).toBe(
      "injection_target",
    );
    expect(await adminScalar("SELECT count(*)::int FROM injection_target")).toBe(1);

    // The above proves non-interpolation (the table survived), but
    // `toEqual([])` is equally consistent with "bound correctly, matched no
    // region" and "mangled or nulled en route" — an adapter that silently
    // truncated, re-escaped, or dropped the value before binding it would
    // pass the assertions above just as cleanly. Echo it back instead of
    // filtering with it, so the exact string that went in is the exact
    // string that comes out.
    const echoed = await qspec().execute(
      datasetManifest("binding-injection-echo", {
        parameters: { region: { type: "string", required: true } },
        query: {
          source: SOURCE,
          language: "sql",
          statement: "SELECT :region AS echoed",
          bindings: { region: "$parameters.region" },
        },
      }),
      { parameters: { region: injection } },
    );
    expect(plainRows(echoed.data.rows)).toEqual([{ echoed: injection }]);
  });

  // --- Execution and normalization (SPEC.md §90) ---------------------------

  it("keeps numeric and bigint as exact strings and turns timestamptz into an ISO string", async () => {
    // 20 significant digits before the point and 20 after: a double carries
    // ~15-17, so any value that had been through a JS number would come back
    // rounded. The bigint is 2^63-1, likewise unrepresentable exactly.
    const exactNumeric = "12345678901234567890.12345678901234567890";
    const exactBigint = "9223372036854775807";

    const result = await qspec().execute(
      datasetManifest("types-roundtrip", {
        query: {
          source: SOURCE,
          language: "sql",
          statement:
            `SELECT '${exactNumeric}'::numeric AS big_numeric, ` +
            `${exactBigint}::bigint AS big_int, ` +
            `TIMESTAMPTZ '2026-01-15 10:30:00+00' AS at`,
        },
      }),
    );

    expect(plainRows(result.data.rows)).toEqual([
      {
        big_numeric: exactNumeric,
        big_int: exactBigint,
        at: "2026-01-15T10:30:00.000Z",
      },
    ]);

    // Precision survived *because* nothing parsed these into doubles. No
    // `pg.types.setTypeParser` anywhere in this package.
    expect(String(Number(exactNumeric))).not.toBe(exactNumeric);
    expect(String(Number(exactBigint))).not.toBe(exactBigint);

    // Real OIDs through the type map, and the inferred field types that follow
    // from them. `at` is `datetime` only because core's inferType saw an actual
    // `Date` instance — a string would have inferred `string`.
    expect(result.data.fields).toEqual([
      { name: "big_numeric", type: "string", nullable: false, format: { nativeType: "numeric" } },
      { name: "big_int", type: "string", nullable: false, format: { nativeType: "int8" } },
      { name: "at", type: "datetime", nullable: false, format: { nativeType: "timestamptz" } },
    ]);
  });

  it("cross-checks every OID in the type map against the server's own pg_type", async () => {
    // `types.test.ts` restates the map verbatim, so it can catch an accidental
    // edit but never a wrong value: a wrong OID in the map is a wrong OID in
    // the test. Only a handful of these OIDs pass through a real result
    // anywhere else in this file. Ask the server instead.
    //
    // Derived from OID_NAMES itself, not hand-duplicated: a literal list here
    // would silently exclude a future 17th entry — the one most likely to
    // carry a wrong OID — while this test kept claiming to cross-check every
    // OID in the map. The numbers below come from pg_type; the names come
    // from the map. A mismatch in either direction fails: an OID mapped to
    // the wrong name, or a name the server does not know at all.
    const covered = [...OID_NAMES.values()];

    const rows = await adminRows(
      "SELECT oid::int, typname FROM pg_type WHERE typname = ANY($1) ORDER BY typname",
      [covered],
    );

    // Every name resolved to exactly one row: a typo here would otherwise
    // simply drop out of the comparison and leave it asserting less.
    expect(rows.map((row) => row[1]).sort()).toEqual([...covered].sort());

    for (const row of rows) {
      const oid = row[0];
      const typname = row[1];
      if (typeof oid !== "number" || typeof typname !== "string") {
        throw new Error(`pg_type returned an unexpected row shape: ${JSON.stringify(row)}`);
      }
      expect(postgresTypeName(oid), `pg_type says OID ${oid} is "${typname}"`).toBe(typname);
    }
  });

  it("hands core a real Date for timestamptz, before core turns it into an ISO string", async () => {
    // Asserted against the source directly: by the time a Dataset exists the
    // Date has already been converted, so this is the only place the adapter's
    // half of that contract is observable.
    const source = createContractSource();
    const raw = await source.execute(
      {
        segments: ["SELECT occurred_at FROM events WHERE id = ", ""],
        parameterNames: ["id"],
        values: [1],
        source: SOURCE,
      } satisfies CompiledSqlQuery,
      { executionId: "integration-timestamptz", logger: {} },
    );

    const cell = raw.rows[0]?.[0];
    assertInstanceOf(cell, Date, "timestamptz cell");
    expect(cell.toISOString()).toBe("2026-01-15T10:30:00.000Z");
  });

  it("preserves duplicate column names through to a renamed dataset field", async () => {
    // Positional rows are what make this possible: a row *object* keyed by
    // column name collapses the second `id` before core ever sees it.
    const source = createContractSource();
    const raw = await source.execute(
      {
        segments: ["SELECT 1 AS id, 2 AS id"],
        parameterNames: [],
        values: [],
        source: SOURCE,
      } satisfies CompiledSqlQuery,
      { executionId: "integration-duplicates", logger: {} },
    );
    expect(raw.columns.map((column) => column.name)).toEqual(["id", "id"]);
    expect(raw.rows).toEqual([[1, 2]]);

    const result = await qspec().execute(
      datasetManifest("duplicate-columns", {
        query: { source: SOURCE, language: "sql", statement: "SELECT 1 AS id, 2 AS id" },
      }),
    );
    expect(result.data.fields.map((field) => field.name)).toEqual(["id", "id_2"]);
    expect(plainRows(result.data.rows)).toEqual([{ id: 1, id_2: 2 }]);
  });

  // --- Dataset validation (SPEC.md §90, §80) -------------------------------

  it("rejects a real result that contradicts spec.dataset", async () => {
    const error = await rejection(
      qspec().execute(
        datasetManifest("dataset-mismatch", {
          // Two contradictions the server's real result produces: `headcount`
          // is never selected, and the one `region` returned is NULL despite
          // the declaration forbidding it.
          //
          // Not a declared-vs-actual *type* mismatch, deliberately: core's
          // `normalizeResult` stamps a declared field with its declared type
          // rather than the inferred one, so for a field that is present a
          // type contradiction cannot reach `validateDataset` through
          // `execute()` at all. Asserting one here would be asserting a
          // behavior the pipeline does not have.
          query: {
            source: SOURCE,
            language: "sql",
            statement: "SELECT NULL::text AS region",
          },
          dataset: {
            fields: {
              region: { type: "string", nullable: false },
              headcount: { type: "integer" },
            },
          },
        }),
      ),
    );

    assertInstanceOf(error, DatasetValidationError, "dataset validation");
    expect(error.issues.map((issue) => issue.code)).toEqual([
      "QSPEC_DATASET_INVALID",
      "QSPEC_DATASET_INVALID",
    ]);
    expect(error.issues.map((issue) => issue.path.join("."))).toEqual([
      "spec.dataset.fields.headcount",
      "rows.0.region",
    ]);
  });

  // --- Cancellation (SPEC.md §90) ------------------------------------------

  it("cancels the backend server-side: QSpecAbortError, and pg_stat_activity proves it stopped", async () => {
    const controller = new AbortController();
    const promise = qspec().execute(
      datasetManifest("cancellation", {
        query: { source: SOURCE, language: "sql", statement: CANCEL_PROBE_SQL },
      }),
      { signal: controller.signal },
    );
    // Attached immediately so the rejection is never unhandled while we wait
    // for the backend to show up.
    const settled = rejection(promise);

    // Capturing the PID *before* aborting is what makes the check afterwards
    // mean something: this proves a backend really was running the sleep.
    const pid = await waitForProbeBackendPid();
    const beforeAbort = await observeBackend(pid);
    expect(beforeAbort.present).toBe(true);
    expect(beforeAbort.state).toBe("active");
    expect(beforeAbort.query).toContain(CANCEL_PROBE_MARKER);

    const abortedAt = performance.now();
    controller.abort();
    const error = await settled;
    const rejectedAfterMs = performance.now() - abortedAt;

    assertInstanceOf(error, QSpecAbortError, "cancellation");
    // Well under the 30s sleep, and inside the same bound the contract suite
    // holds the adapter to.
    expect(rejectedAfterMs).toBeLessThan(ABORT_BOUND_MS);

    // A real transition, not a lucky timeout: the same PID was asserted
    // `active` on the probe above, and `waitForBackendToStopRunning` throws
    // rather than returning if it never stops being active.
    const after = await waitForBackendToStopRunning(pid);
    expect(after.state).not.toBe("active");
    // The session survived and went idle: the statement was cancelled, not the
    // connection destroyed. Destroying the socket would leave the backend
    // running — the exact failure `cancelBackend` exists to prevent.
    expect(after.present).toBe(true);
    expect(after.state).toBe("idle");
  });

  // --- Database errors (SPEC.md §90, §72.6) --------------------------------

  it("surfaces a syntax error as QueryExecutionError with a cause and no password", async () => {
    const error = await rejection(
      qspec().execute(
        datasetManifest("syntax-error", {
          query: { source: SOURCE, language: "sql", statement: "SELCT 1" },
        }),
      ),
    );

    assertInstanceOf(error, QueryExecutionError, "syntax error");
    assertInstanceOf(error.cause, Error, "syntax error cause");
    expect(error.cause.message).toContain("syntax error");
    expect(error.message).not.toContain(DB_PASSWORD);
    expect(error.cause.message).not.toContain(DB_PASSWORD);
  });

  it("surfaces a missing table as QueryExecutionError with a cause and no password", async () => {
    const error = await rejection(
      qspec().execute(
        datasetManifest("missing-table", {
          query: { source: SOURCE, language: "sql", statement: "SELECT * FROM no_such_table" },
        }),
      ),
    );

    assertInstanceOf(error, QueryExecutionError, "missing table");
    assertInstanceOf(error.cause, Error, "missing table cause");
    expect(error.cause.message).toContain("no_such_table");
    expect(error.message).not.toContain(DB_PASSWORD);
    expect(error.cause.message).not.toContain(DB_PASSWORD);
  });

  // --- The Task 4 contract suite, against the real adapter -----------------

  runDataSourceContractTests("@qspecs/postgres (real PostgreSQL)", {
    create: createContractSource,
    query: CONTRACT_QUERY,
    expectedColumns: ["id", "region"],
    slowQuery: CONTRACT_SLOW_QUERY,
    abortBoundMs: ABORT_BOUND_MS,
  });
});
