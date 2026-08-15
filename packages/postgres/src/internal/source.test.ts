import { getEventListeners } from "node:events";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIMITS,
  QSpecAbortError,
  QueryExecutionError,
  type DataSource,
  type DataSourceContext,
  type QSpecLogger,
  type QSpecPluginAPI,
  type Registry,
} from "@qspecs/core";
import type { CompiledSqlQuery } from "@qspecs/sql";
import { postgres } from "../index.js";
import type {
  ConnectionErrorHandler,
  PgClientOptions,
  PgDriver,
  PgPoolOptions,
  PgQueryConfig,
} from "./driver.js";
import type { PgArrayModeQueryResult } from "./normalize.js";
import { createPostgresPlugin, createPostgresSource, type PostgresSourceConfig } from "./source.js";

const CANCEL_STATEMENT = "SELECT pg_cancel_backend($1)";

/** A compiled query with one parameter, so the rendered text is non-trivial. */
const QUERY: CompiledSqlQuery = {
  segments: ["SELECT id, name FROM widgets WHERE id = ", ""],
  parameterNames: ["id"],
  values: [7],
  source: "analytics",
};

const RENDERED_TEXT = "SELECT id, name FROM widgets WHERE id = $1";

const RESULT: PgArrayModeQueryResult = {
  fields: [
    { name: "id", dataTypeID: 23 },
    { name: "name", dataTypeID: 25 },
  ],
  rows: [
    [1, "wrench"],
    [2, "hammer"],
  ],
};

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve: (value) => resolve(value) };
}

/**
 * Reads an element without a cast that would strip `undefined` from the
 * indexed access, and fails with a message naming what was missing rather
 * than a downstream "cannot read properties of undefined".
 */
function at<T>(items: readonly T[], index: number, what: string): T {
  const item = items[index];
  if (item === undefined) throw new Error(`expected ${what} at index ${index}, found none`);
  return item;
}

/**
 * One statement, tagged with the connection that issued it.
 *
 * `connectionId` is what makes "the cancel went out on a *different*
 * connection" observable: every connection the fake hands out — pooled or
 * short-lived — draws from one counter, so two statements share an id only
 * when they genuinely shared a connection. `rowMode` is recorded as it
 * arrived, so a call site that dropped it is visible here as `undefined`
 * rather than being silently normalized away.
 */
interface RecordedStatement {
  readonly connectionId: number;
  readonly kind: "pool" | "cancel";
  readonly text: string;
  readonly values: readonly unknown[];
  readonly rowMode: unknown;
}

interface FakeBehavior {
  /** Rejects `pool.connect()`. */
  readonly connectError?: Error;
  /** Rejects the pooled query. */
  readonly queryError?: Error;
  /**
   * Pooled queries stay pending until a `pg_cancel_backend` arrives naming
   * their PID — the fake's stand-in for a server that only stops working when
   * it is actually told to. A cancel carrying the wrong PID therefore leaves
   * the query hanging, so the PID assertion cannot pass by coincidence.
   */
  readonly hangUntilCancelled?: boolean;
  /** Awaited inside `pool.connect()`, so a test can abort mid-acquire. */
  readonly connectGate?: Promise<void>;
  /** Real elapsed time inside the pooled query, so durationMs cannot be 0. */
  readonly queryDelayMs?: number;
}

interface FakeState {
  readonly poolOptions: PgPoolOptions[];
  readonly clientOptions: PgClientOptions[];
  readonly statements: RecordedStatement[];
  /** Backend PIDs of the pooled clients handed out, in order. */
  readonly poolProcessIds: number[];
  connectCount: number;
  releaseCount: number;
  poolEndCount: number;
  cancelClientEndCount: number;
  /** Resolves once a pooled query has actually been issued. */
  readonly queryIssued: Promise<void>;
  /**
   * Fires the `'error'` handler the source registered on its pool — what
   * `pg-pool` does when a checked-in idle client's socket fails. Throws if no
   * handler was registered, so a source that never attached one fails here
   * rather than passing an assertion about a log nobody wrote.
   */
  emitPoolError(): void;
  /** The same, for the short-lived cancel connection. */
  emitCancelClientError(): void;
}

function cancelledStatementError(): Error {
  return Object.assign(new Error("canceling statement due to user request"), { code: "57014" });
}

function createFakeDriver(behavior: FakeBehavior = {}): {
  readonly driver: PgDriver;
  readonly state: FakeState;
} {
  const issued = deferred<void>();
  const poolErrorHandlers: ConnectionErrorHandler[] = [];
  const clientErrorHandlers: ConnectionErrorHandler[] = [];

  const fire = (handlers: readonly ConnectionErrorHandler[], what: string): void => {
    if (handlers.length === 0) throw new Error(`no 'error' handler was registered on ${what}`);
    for (const handler of handlers) handler();
  };

  const state: FakeState = {
    poolOptions: [],
    clientOptions: [],
    statements: [],
    poolProcessIds: [],
    connectCount: 0,
    releaseCount: 0,
    poolEndCount: 0,
    cancelClientEndCount: 0,
    queryIssued: issued.promise,
    emitPoolError: () => fire(poolErrorHandlers, "the pool"),
    emitCancelClientError: () => fire(clientErrorHandlers, "the cancel client"),
  };

  /** Reject callbacks for pooled queries still waiting on a cancel, by PID. */
  const pending = new Map<number, (error: Error) => void>();
  let nextConnectionId = 0;

  const record = (connectionId: number, kind: "pool" | "cancel", config: PgQueryConfig): void => {
    state.statements.push({
      connectionId,
      kind,
      text: config.text,
      values: config.values,
      rowMode: config.rowMode,
    });
  };

  const driver: PgDriver = {
    createPool(options, onError) {
      state.poolOptions.push(options);
      poolErrorHandlers.push(onError);
      return {
        async connect() {
          if (behavior.connectGate !== undefined) await behavior.connectGate;
          if (behavior.connectError !== undefined) throw behavior.connectError;
          state.connectCount += 1;
          const connectionId = (nextConnectionId += 1);
          const processID = 4000 + connectionId;
          state.poolProcessIds.push(processID);
          return {
            processID,
            async query(config) {
              record(connectionId, "pool", config);
              issued.resolve();
              if (behavior.queryDelayMs !== undefined) {
                await new Promise((resolve) => setTimeout(resolve, behavior.queryDelayMs));
              }
              if (behavior.queryError !== undefined) throw behavior.queryError;
              if (behavior.hangUntilCancelled === true) {
                return await new Promise<PgArrayModeQueryResult>((_resolve, reject) => {
                  pending.set(processID, reject);
                });
              }
              return RESULT;
            },
            release() {
              state.releaseCount += 1;
            },
          };
        },
        async end() {
          state.poolEndCount += 1;
        },
      };
    },

    createClient(options, onError) {
      state.clientOptions.push(options);
      clientErrorHandlers.push(onError);
      const connectionId = (nextConnectionId += 1);
      return {
        async connect() {
          // Nothing to do: a cancel connection exists only to carry one
          // statement, and this fake has no handshake.
        },
        async query(config) {
          record(connectionId, "cancel", config);
          const pid = config.values[0];
          if (config.text === CANCEL_STATEMENT && typeof pid === "number") {
            const reject = pending.get(pid);
            if (reject !== undefined) {
              pending.delete(pid);
              reject(cancelledStatementError());
            }
          }
          return { fields: [{ name: "pg_cancel_backend", dataTypeID: 16 }], rows: [[true]] };
        },
        async end() {
          state.cancelClientEndCount += 1;
        },
      };
    },
  };

  return { driver, state };
}

interface RecordedLog {
  readonly logger: QSpecLogger;
  readonly calls: unknown[][];
}

function recordingLogger(): RecordedLog {
  const calls: unknown[][] = [];
  const level =
    (name: string) =>
    (message: string, context?: unknown): void => {
      calls.push([name, message, context]);
    };
  return {
    calls,
    logger: {
      debug: level("debug"),
      info: level("info"),
      warn: level("warn"),
      error: level("error"),
    },
  };
}

/** Everything the logger saw, flattened — Errors included, since JSON drops them. */
function loggedText(calls: readonly unknown[][]): string {
  return JSON.stringify(calls, (_key, value: unknown) =>
    value instanceof Error ? `${value.name}: ${value.message}\n${value.stack ?? ""}` : value,
  );
}

function createContext(logger: QSpecLogger, signal?: AbortSignal): DataSourceContext {
  return {
    executionId: "exec-1",
    logger,
    ...(signal === undefined ? {} : { signal }),
  };
}

const CONFIG: PostgresSourceConfig = { connectionString: "postgres://qspec@localhost/analytics" };

function createSource(
  behavior: FakeBehavior = {},
  config: PostgresSourceConfig = CONFIG,
  runtimeLogger: QSpecLogger = {},
): { source: DataSource<CompiledSqlQuery>; state: FakeState } {
  const { driver, state } = createFakeDriver(behavior);
  return { source: createPostgresSource("analytics", config, driver, runtimeLogger), state };
}

/** A Map-backed `Registry` so plugin setup can run without the whole runtime. */
function stubRegistry<T>(): Registry<T> {
  const entries = new Map<string, T>();
  return {
    register(name, implementation) {
      if (entries.has(name)) throw new Error(`"${name}" is already registered`);
      entries.set(name, implementation);
    },
    replace(name, implementation) {
      entries.set(name, implementation);
    },
    get: (name) => entries.get(name),
    has: (name) => entries.has(name),
    list: () => [...entries.keys()].sort(),
  };
}

function stubApi(): QSpecPluginAPI {
  return {
    queryLanguages: stubRegistry(),
    sources: stubRegistry(),
    transforms: stubRegistry(),
    semanticTypes: stubRegistry(),
    resources: stubRegistry(),
    presentations: stubRegistry(),
    renderers: stubRegistry(),
    hooks: { on: () => () => undefined },
    logger: {},
    limits: DEFAULT_LIMITS,
  };
}

describe("createPostgresSource", () => {
  it("rejects an already-aborted signal without acquiring a connection", async () => {
    const { source, state } = createSource();
    const { logger } = recordingLogger();
    const controller = new AbortController();
    controller.abort();

    await expect(source.execute(QUERY, createContext(logger, controller.signal))).rejects.toThrow(
      QSpecAbortError,
    );
    expect(state.poolOptions).toEqual([]);
    expect(state.connectCount).toBe(0);
    expect(state.statements).toEqual([]);
  });

  it("returns positional rows, mapped columns, and a measured durationMs", async () => {
    // The query takes real time, so a hard-coded 0 — or a duration measured
    // across nothing — fails rather than passing a `>= 0` check.
    const { source } = createSource({ queryDelayMs: 5 });
    const { logger } = recordingLogger();

    const result = await source.execute(QUERY, createContext(logger));

    expect(result.columns).toEqual([
      { name: "id", nativeType: "int4" },
      { name: "name", nativeType: "text" },
    ]);
    expect(result.rows).toEqual([
      [1, "wrench"],
      [2, "hammer"],
    ]);
    expect(result.metadata?.durationMs).toBeGreaterThan(0);
  });

  it('issues the rendered statement with rowMode: "array"', async () => {
    // `@types/pg` types `QueryResult.rows` as `any[]`, which is assignable to
    // what `normalizePgResult` accepts, so dropping `rowMode` from the query
    // config yields row *objects* that misalign with `columns` by position
    // with no type error and no throw against the real driver. This assertion
    // is the enforcement.
    const { source, state } = createSource();
    const { logger } = recordingLogger();

    await source.execute(QUERY, createContext(logger));

    const statement = at(state.statements, 0, "the pooled statement");
    expect(statement.rowMode).toBe("array");
    expect(statement.text).toBe(RENDERED_TEXT);
    expect(statement.values).toEqual([7]);
  });

  it("releases the client after a successful query", async () => {
    const { source, state } = createSource();
    const { logger } = recordingLogger();

    await source.execute(QUERY, createContext(logger));

    expect(state.connectCount).toBe(1);
    expect(state.releaseCount).toBe(1);
  });

  it("releases the client when the query fails", async () => {
    const { source, state } = createSource({ queryError: new Error("syntax error at or near") });
    const { logger } = recordingLogger();

    await expect(source.execute(QUERY, createContext(logger))).rejects.toThrow(QueryExecutionError);

    expect(state.connectCount).toBe(1);
    expect(state.releaseCount).toBe(1);
  });

  it("wraps a driver error in QueryExecutionError with the driver error as cause", async () => {
    const driverError = new Error('relation "widgets" does not exist');
    const { source } = createSource({ queryError: driverError });
    const { logger } = recordingLogger();

    const error = await source
      .execute(QUERY, createContext(logger))
      .then(() => undefined)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(QueryExecutionError);
    expect(error).toMatchObject({ code: "QSPEC_QUERY_FAILED", cause: driverError });
    expect(error).not.toMatchObject({ message: expect.stringContaining("does not exist") });
  });

  it("keeps the connection string's password out of the error and the logger", async () => {
    const password = "sup3r-s3cret";
    const connectionString = `postgres://qspec:${password}@db.internal:5432/analytics`;
    const config: PostgresSourceConfig = { connectionString };
    // A driver error shaped like pg's own, which routinely embeds the whole
    // connection target — the reason the wrapper never reuses its message.
    const driverError = new Error(
      `connection to server failed for "${connectionString}": password authentication failed`,
    );
    const { logger, calls } = recordingLogger();

    const failures = [
      createSource({ connectError: driverError }, config),
      createSource({ queryError: driverError }, config),
    ];
    for (const { source } of failures) {
      const error = await source
        .execute(QUERY, createContext(logger))
        .then(() => undefined)
        .catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(QueryExecutionError);
      expect(error).toMatchObject({ cause: driverError, details: undefined });
      const wrapped = error instanceof Error ? error : new Error("not an Error");
      expect(wrapped.message).not.toContain(password);
      expect(String(wrapped)).not.toContain(password);
      expect(wrapped.stack ?? "").not.toContain(password);
    }

    // A third path, so the logger assertion below is not vacuous: cancelling
    // mid-flight is the one thing this source logs about.
    const { source, state } = createSource({ hangUntilCancelled: true }, config);
    const controller = new AbortController();
    const running = source.execute(QUERY, createContext(logger, controller.signal));
    const settled = running.catch((thrown: unknown) => thrown);
    await state.queryIssued;
    controller.abort();
    expect(await settled).toBeInstanceOf(QSpecAbortError);

    expect(calls.length).toBeGreaterThan(0);
    expect(loggedText(calls)).not.toContain(password);
  });

  it("cancels the captured backend PID on a different connection when aborted mid-flight", async () => {
    const { source, state } = createSource({ hangUntilCancelled: true });
    const { logger, calls } = recordingLogger();
    const controller = new AbortController();

    const running = source.execute(QUERY, createContext(logger, controller.signal));
    const settled = running.catch((thrown: unknown) => thrown);
    await state.queryIssued;
    controller.abort();

    expect(await settled).toBeInstanceOf(QSpecAbortError);

    const query = at(state.statements, 0, "the pooled statement");
    const cancel = at(state.statements, 1, "the cancel statement");
    const pid = at(state.poolProcessIds, 0, "a pooled backend PID");

    expect(query.kind).toBe("pool");
    expect(cancel.kind).toBe("cancel");
    // The PID that was captured from the client running the query...
    expect(cancel.text).toBe(CANCEL_STATEMENT);
    expect(cancel.values).toEqual([pid]);
    // ...sent over a connection that is not the one blocked on that query.
    expect(cancel.connectionId).not.toBe(query.connectionId);
    // A short-lived connection: opened for the cancel, then closed.
    expect(state.clientOptions).toEqual([{ connectionString: CONFIG.connectionString }]);
    expect(state.cancelClientEndCount).toBe(1);
    expect(state.releaseCount).toBe(1);
    expect(loggedText(calls)).toContain(`PID ${pid}`);
  });

  it("rejects without querying when the signal aborts while a connection is acquired", async () => {
    const gate = deferred<void>();
    const { source, state } = createSource({ connectGate: gate.promise });
    const { logger } = recordingLogger();
    const controller = new AbortController();

    const running = source.execute(QUERY, createContext(logger, controller.signal));
    const settled = running.catch((thrown: unknown) => thrown);
    // The abort lands while `pool.connect()` is still pending, so the abort
    // listener attached around the query never fires — only a re-read of
    // `signal.aborted` after the connection arrives can catch this.
    controller.abort();
    gate.resolve();

    expect(await settled).toBeInstanceOf(QSpecAbortError);
    expect(state.statements).toEqual([]);
    expect(state.releaseCount).toBe(1);
  });

  it("passes the configured connection options through to the pool", async () => {
    const config: PostgresSourceConfig = {
      connectionString: "postgres://qspec@localhost/analytics",
      max: 3,
      statementTimeoutMs: 250,
    };
    const { source, state } = createSource({}, config);
    const { logger } = recordingLogger();

    await source.execute(QUERY, createContext(logger));

    expect(state.poolOptions).toEqual([
      {
        connectionString: "postgres://qspec@localhost/analytics",
        max: 3,
        statement_timeout: 250,
      },
    ]);
  });

  it("omits unset connection options rather than passing undefined", async () => {
    const { source, state } = createSource();
    const { logger } = recordingLogger();

    await source.execute(QUERY, createContext(logger));

    expect(state.poolOptions).toEqual([{ connectionString: CONFIG.connectionString }]);
    expect(Object.keys(at(state.poolOptions, 0, "the pool options"))).toEqual(["connectionString"]);
  });

  it("ends the pool on dispose(), and is idempotent", async () => {
    const { source, state } = createSource();
    const { logger } = recordingLogger();
    await source.execute(QUERY, createContext(logger));

    await source.dispose?.();
    await source.dispose?.();

    expect(state.poolEndCount).toBe(1);
  });

  it("ends nothing on dispose() when no query ever created a pool", async () => {
    const { source, state } = createSource();

    await source.dispose?.();

    expect(state.poolOptions).toEqual([]);
    expect(state.poolEndCount).toBe(0);
  });

  it("refuses to execute after dispose() rather than reopening the pool", async () => {
    const { source, state } = createSource();
    const { logger } = recordingLogger();
    await source.execute(QUERY, createContext(logger));
    await source.dispose?.();

    await expect(source.execute(QUERY, createContext(logger))).rejects.toThrow(QueryExecutionError);
    expect(state.poolOptions).toHaveLength(1);
  });

  it("leaves no abort listener behind after a successful execution", async () => {
    // `{ once: true }` only removes a listener that actually fired, so a
    // caller reusing one signal accumulates one listener per completed query.
    // Ten is past Node's default EventTarget warning threshold, which is
    // where this would otherwise first surface — in production, as a
    // MaxListenersExceededWarning, not in a test.
    const { source } = createSource();
    const { logger } = recordingLogger();
    const controller = new AbortController();

    for (let index = 0; index < 10; index += 1) {
      await source.execute(QUERY, createContext(logger, controller.signal));
    }

    expect(getEventListeners(controller.signal, "abort")).toEqual([]);
  });

  it("reports a pool connection error without the connection string", async () => {
    // `pg.Pool` is an EventEmitter that emits 'error' for a checked-in idle
    // client whose socket fails — a database restart. Node throws an
    // unhandled 'error', so an unhandled one takes the host process down and
    // prints a driver error embedding the connection string on the way out.
    const password = "sup3r-s3cret";
    const config: PostgresSourceConfig = {
      connectionString: `postgres://qspec:${password}@db.internal:5432/analytics`,
    };
    const { logger, calls } = recordingLogger();
    const { source, state } = createSource({ hangUntilCancelled: true }, config, logger);
    // An aborted execution, so both a pool and a cancel connection exist.
    const controller = new AbortController();
    const settled = source
      .execute(QUERY, createContext({}, controller.signal))
      .catch((thrown: unknown) => thrown);
    await state.queryIssued;
    controller.abort();
    await settled;
    const before = calls.length;

    state.emitPoolError();
    state.emitCancelClientError();

    expect(calls).toHaveLength(before + 2);
    expect(loggedText(calls)).not.toContain(password);
    expect(loggedText(calls.slice(before))).toContain("connection error");
  });

  it("survives a host logger that throws from inside the connection-error handler", async () => {
    // The handler runs synchronously inside `pg`'s 'error' emit, and an
    // EventEmitter gives a throwing listener nowhere to go: it propagates out
    // of `emit` and takes the host process down — the very crash this handler
    // was added to prevent, with `logger.warn` as the cause instead of an
    // unhandled event. A host logger is third-party code; it may throw.
    let attempts = 0;
    const throwingLogger: QSpecLogger = {
      warn: () => {
        attempts += 1;
        throw new Error("the host logger is broken");
      },
    };
    const { source, state } = createSource({ hangUntilCancelled: true }, CONFIG, throwingLogger);
    const controller = new AbortController();
    const settled = source
      .execute(QUERY, createContext({}, controller.signal))
      .catch((thrown: unknown) => thrown);
    await state.queryIssued;
    controller.abort();
    await settled;

    expect(() => state.emitPoolError()).not.toThrow();
    expect(() => state.emitCancelClientError()).not.toThrow();
    // Both handlers really did reach the logger: without this, a handler that
    // stopped logging altogether would satisfy the two assertions above.
    expect(attempts).toBe(2);
  });

  it("declares sql as its only supported language", () => {
    const { source } = createSource();

    expect(source.supportedLanguages).toEqual(["sql"]);
  });
});

describe("createPostgresPlugin", () => {
  it("registers one data source per configured name", async () => {
    const { driver } = createFakeDriver();
    const plugin = createPostgresPlugin(
      {
        sources: {
          analytics: { connectionString: "postgres://qspec@localhost/analytics" },
          reporting: { connectionString: "postgres://qspec@localhost/reporting" },
        },
      },
      driver,
    );
    const api = stubApi();

    await plugin.setup(api);

    expect(plugin.name).toBe("@qspecs/postgres");
    expect(api.sources.list()).toEqual(["analytics", "reporting"]);
    expect(api.sources.get("analytics")?.supportedLanguages).toEqual(["sql"]);
  });

  it("creates its pools lazily: constructing and registering opens no connection", async () => {
    const { driver, state } = createFakeDriver();

    const plugin = createPostgresPlugin(
      { sources: { analytics: { connectionString: "postgres://qspec@localhost/analytics" } } },
      driver,
    );
    await plugin.setup(stubApi());

    expect(state.poolOptions).toEqual([]);
    expect(state.connectCount).toBe(0);
  });
});

/**
 * The public entry point, which is `createPostgresPlugin` with the real `pg`
 * driver attached. Registering it opens nothing — pools are created on first
 * execute — so this runs with no database. Everything the driver adapter does
 * once a connection exists needs a real server, and is Task 7's integration
 * suite.
 */
describe("postgres()", () => {
  it("registers a sql-only source per configured name without connecting", async () => {
    const plugin = postgres({
      sources: {
        analytics: { connectionString: "postgres://qspec@localhost:1/analytics" },
        reporting: { connectionString: "postgres://qspec@localhost:1/reporting", max: 4 },
      },
    });
    const api = stubApi();

    await plugin.setup(api);

    expect(plugin.name).toBe("@qspecs/postgres");
    expect(api.sources.list()).toEqual(["analytics", "reporting"]);
    expect(api.sources.get("reporting")?.supportedLanguages).toEqual(["sql"]);
  });
});
