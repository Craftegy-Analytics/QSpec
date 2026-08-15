import {
  QSpecAbortError,
  QueryExecutionError,
  definePlugin,
  type DataSource,
  type DataSourceContext,
  type QSpecLogger,
  type QSpecPlugin,
  type RawQueryResult,
} from "@qspecs/core";
import type { CompiledSqlQuery } from "@qspecs/sql";
import type {
  PgCancelClient,
  PgDriver,
  PgPool,
  PgPoolClient,
  PgPoolOptions,
  PgQueryConfig,
} from "./driver.js";
import { normalizePgResult, type PgArrayModeQueryResult } from "./normalize.js";
import { renderPostgres } from "./render.js";

/** Connection settings for one logical source. */
export interface PostgresSourceConfig {
  /** Supplied by the host application, never by a manifest. (SPEC.md §9, §72.1) */
  readonly connectionString: string;
  readonly max?: number;
  readonly statementTimeoutMs?: number;
}

export interface PostgresOptions {
  readonly sources: Readonly<Record<string, PostgresSourceConfig>>;
}

/**
 * Parameterized, not interpolated, even though the PID is a number this
 * module captured itself. (SPEC.md §72.2)
 */
const CANCEL_STATEMENT = "SELECT pg_cancel_backend($1)";

/**
 * Explains where the driver error went without repeating it. A `pg` error
 * routinely embeds the connection string, so its message is never copied into
 * ours; it is attached as `cause` instead, which a host can reach for
 * deliberately. (SPEC.md §72.6)
 */
function wrapDriverError(sourceName: string, what: string, cause: unknown): QueryExecutionError {
  return new QueryExecutionError(
    `Postgres source "${sourceName}" ${what}. The underlying driver error is attached as ` +
      `this error's \`cause\`; it is deliberately not repeated in this message, because ` +
      `pg errors can embed connection details. (SPEC.md §72.6)`,
    { cause },
  );
}

function poolOptions(config: PostgresSourceConfig): PgPoolOptions {
  return {
    connectionString: config.connectionString,
    ...(config.max === undefined ? {} : { max: config.max }),
    ...(config.statementTimeoutMs === undefined
      ? {}
      : { statement_timeout: config.statementTimeoutMs }),
  };
}

/**
 * A `DataSource` backed by one lazily-created `pg.Pool`.
 *
 * Exported for tests, which inject a fake `driver`; hosts get here through
 * `postgres()`.
 *
 * `runtimeLogger` is the source's own logger, distinct from the per-execution
 * `context.logger` used everywhere inside `execute`. A connection can fail
 * while no query is running at all — an idle socket dropped by a database
 * restart — and there is no execution to attribute that to, so it goes to the
 * logger the runtime handed the plugin at setup.
 */
export function createPostgresSource(
  sourceName: string,
  config: PostgresSourceConfig,
  driver: PgDriver,
  runtimeLogger: QSpecLogger = {},
): DataSource<CompiledSqlQuery> {
  let pool: PgPool | undefined;
  let disposed = false;

  /**
   * What both connection-error handlers report. The driver error is not
   * available here by design — see `ConnectionErrorHandler` — so there is
   * nothing to leak and nothing to forget to strip. (SPEC.md §72.6)
   *
   * The `try`/`catch` is the point of the handler, not housekeeping. This runs
   * synchronously inside `pg`'s `'error'` emit, and an EventEmitter gives a
   * throwing listener nowhere to go: it propagates out of `emit`, out of the
   * socket callback that raised it, and takes the host process down — exactly
   * the crash this handler exists to prevent, just with a host `logger.warn`
   * as the cause instead of an unhandled event. There is nobody to report the
   * failure to either: the only reporting channel available here is the logger
   * that just threw. The abort path already defends against the same throwing
   * logger (see `run`'s `finally`).
   */
  const onConnectionError = (what: string) => (): void => {
    try {
      runtimeLogger.warn?.(
        `Postgres source "${sourceName}" reported a connection error on ${what}, outside any ` +
          `query. The driver error is not included: pg connection errors embed the connection ` +
          `string. (SPEC.md §72.6)`,
      );
    } catch {
      // Intentionally silent: see above.
    }
  };

  const aborted = (signal: AbortSignal): QSpecAbortError =>
    new QSpecAbortError(`Postgres source "${sourceName}" was aborted.`, { cause: signal.reason });

  /**
   * A function rather than an inline check, called at three points across two
   * `await`s. TypeScript keeps a property narrowing alive across `await`, so
   * an inline `signal?.aborted === true` after the first one narrows to
   * `false` and the later checks become "unintentional comparisons" — the
   * compiler assuming a value that only ever changes asynchronously cannot
   * have changed. Each call re-reads it in a fresh scope.
   */
  const throwIfAborted = (signal: AbortSignal | undefined): void => {
    if (signal?.aborted === true) throw aborted(signal);
  };

  /**
   * Cancels a running backend from a connection of its own.
   *
   * It cannot be the connection running the query: that one is blocked
   * waiting for the server to answer, so a cancel issued on it would not be
   * read until the query it is meant to stop has already finished. Nor is it
   * taken from the pool — a pool at `max` with every client busy would make
   * `connect()` queue behind the very query being cancelled. Destroying the
   * socket instead is not an option either: the backend keeps running the
   * statement, holding its locks and burning CPU, with nobody left to read
   * the result.
   *
   * A failed cancel is reported through the logger as a message this module
   * composes — the driver error is not passed to the logger either, since it
   * can embed the connection string. (SPEC.md §72.6)
   */
  const cancelBackend = async (pid: number, logger: QSpecLogger): Promise<void> => {
    let client: PgCancelClient | undefined;
    try {
      client = driver.createClient(
        { connectionString: config.connectionString },
        onConnectionError("its cancel connection"),
      );
      await client.connect();
      await client.query({ text: CANCEL_STATEMENT, values: [pid], rowMode: "array" });
    } catch {
      logger.warn?.(
        `Postgres source "${sourceName}" could not cancel backend PID ${pid}; the server may ` +
          `still be running the cancelled query.`,
      );
    } finally {
      // Best-effort, and a `try`/`catch` rather than `.catch()` on the result:
      // a driver whose `end()` throws *synchronously* never returns a promise
      // to attach a handler to. Whatever happens here, the caller is owed the
      // cancellation error, not a teardown error — the cancel request has
      // already been sent or already failed, and a failure closing carries
      // nothing actionable, only connection details we must not surface.
      try {
        await client?.end();
      } catch {
        // Intentionally silent: see above.
      }
    }
  };

  const acquire = async (): Promise<PgPoolClient> => {
    try {
      pool ??= driver.createPool(poolOptions(config), onConnectionError("a pooled connection"));
      return await pool.connect();
    } catch (error) {
      throw wrapDriverError(sourceName, "could not acquire a connection", error);
    }
  };

  const run = async (
    client: PgPoolClient,
    queryConfig: PgQueryConfig,
    signal: AbortSignal | undefined,
    logger: QSpecLogger,
  ): Promise<PgArrayModeQueryResult> => {
    // Assigned by the abort listener and awaited in `finally` so no cancel
    // request is still in flight once execute() settles — a host that
    // disposes on the rejection would otherwise race a connection this
    // module opened.
    let cancel: Promise<void> | undefined;

    const onAbort = (): void => {
      const pid = client.processID;
      if (pid === null) {
        logger.warn?.(
          `Postgres source "${sourceName}" was aborted before its backend PID was known; the ` +
            `server-side query cannot be cancelled.`,
        );
        return;
      }
      logger.debug?.(
        `Postgres source "${sourceName}" is cancelling backend PID ${pid} on a separate ` +
          `connection.`,
      );
      cancel = cancelBackend(pid, logger);
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      return await client.query(queryConfig);
    } catch (error) {
      // A cancelled query fails as an ordinary driver error ("canceling
      // statement due to user request"), so the signal — not the error — is
      // what says whether this was a cancellation.
      throwIfAborted(signal);
      throw wrapDriverError(sourceName, "failed to execute the query", error);
    } finally {
      // `once` only removes the listener when abort actually fires, so a
      // caller reusing one signal across many executions would otherwise
      // accumulate a listener per completed query.
      signal?.removeEventListener("abort", onAbort);
      // `.catch` because a rejection here would replace the caller's
      // QSpecAbortError with whatever went wrong during cancellation —
      // including a host `logger.warn` that throws. `cancelBackend` reports
      // its own failures; nothing it produces should outrank the abort.
      if (cancel !== undefined) await cancel.catch(() => undefined);
    }
  };

  return {
    supportedLanguages: ["sql"],

    async execute(query: CompiledSqlQuery, context: DataSourceContext): Promise<RawQueryResult> {
      const { signal, logger } = context;

      if (disposed) {
        throw new QueryExecutionError(
          `Postgres source "${sourceName}" has been disposed and cannot execute queries. ` +
            `Recreating its pool here would open connections nothing will ever close.`,
        );
      }
      // Before acquiring anything: a caller who has already cancelled should
      // not cost a connection, and a client acquired here would have to be
      // released again on a path that did no work.
      throwIfAborted(signal);

      const startedAt = performance.now();
      const { text, values } = renderPostgres(query);
      const client = await acquire();
      try {
        // `addEventListener("abort", ...)` never fires for a signal that was
        // already aborted, so an abort that landed while we waited for a
        // connection has to be caught by re-reading the flag.
        throwIfAborted(signal);

        const result = await run(client, { text, values, rowMode: "array" }, signal, logger);

        // The cancel may have lost its race with the server. Callers that go
        // through core get a second check there, but a source is also called
        // directly, and resolving with data after cancellation is exactly
        // what the abort contract forbids.
        throwIfAborted(signal);

        return {
          ...normalizePgResult(result),
          metadata: { durationMs: performance.now() - startedAt },
        };
      } finally {
        client.release();
      }
    },

    async dispose(): Promise<void> {
      disposed = true;
      // Cleared before awaiting so a second call — or one that races the
      // first — has nothing left to end.
      const current = pool;
      pool = undefined;
      if (current === undefined) return;
      try {
        await current.end();
      } catch (error) {
        throw wrapDriverError(sourceName, "failed to close its connection pool", error);
      }
    },
  };
}

/**
 * Registers one `DataSource` per configured name. Constructing the plugin
 * opens nothing: each source creates its pool on first execute.
 */
export function createPostgresPlugin(options: PostgresOptions, driver: PgDriver): QSpecPlugin {
  return definePlugin({
    name: "@qspecs/postgres",
    // Sources are built here rather than at plugin construction so each one
    // gets `api.logger`: connection errors arrive outside any execution, so
    // the per-execution logger cannot report them.
    setup(api) {
      for (const [name, config] of Object.entries(options.sources)) {
        api.sources.register(name, createPostgresSource(name, config, driver, api.logger));
      }
    },
  });
}
