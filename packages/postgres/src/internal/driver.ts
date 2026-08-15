import type { PgArrayModeQueryResult } from "./normalize.js";

/**
 * The driver boundary: what `createPostgresSource` needs from `pg`, declared
 * structurally, plus the adapter that satisfies it with the real driver.
 *
 * `pg` is never imported here either — the adapter takes the two constructors
 * it needs as `NodePostgresRuntime`, which is what lets every line below run
 * against fakes with no database. `index.ts` is the only module in the package
 * that imports `pg`.
 */

/** Connection settings, spelled the way `pg` spells them. */
export interface PgClientOptions {
  readonly connectionString: string;
}

export interface PgPoolOptions extends PgClientOptions {
  readonly max?: number;
  /** `pg`'s own name for the server-side per-statement cap, in milliseconds. */
  readonly statement_timeout?: number;
}

export interface PgQueryConfig {
  readonly text: string;
  readonly values: readonly unknown[];
  /**
   * Required, not optional, and deliberately so.
   *
   * `normalizePgResult` assumes rows arrive as positional arrays. `@types/pg`
   * types `QueryResult.rows` as `any[]`, so a call site that forgets
   * `rowMode: "array"` type-checks cleanly against the real driver and hands
   * the normalizer row *objects* that misalign with `columns` by position —
   * no type error, no throw, silently wrong data. Requiring it here makes that
   * a compile error at this package's own boundary, and the test
   * `issues the query with rowMode: "array"` enforces it at the call site
   * regardless of what this type says.
   */
  readonly rowMode: "array";
}

/** The subset of `pg.PoolClient` this adapter uses. */
export interface PgPoolClient {
  /** The server-side backend PID; null when the driver did not report one. */
  readonly processID: number | null;
  query(config: PgQueryConfig): Promise<PgArrayModeQueryResult>;
  release(): void;
}

/** The subset of `pg.Pool` this adapter uses. */
export interface PgPool {
  connect(): Promise<PgPoolClient>;
  end(): Promise<void>;
}

/** The subset of `pg.Client` used for the out-of-band cancel connection. */
export interface PgCancelClient {
  connect(): Promise<void>;
  query(config: PgQueryConfig): Promise<PgArrayModeQueryResult>;
  end(): Promise<void>;
}

/**
 * Called when a connection reports an error outside any query — an idle
 * socket dropped by a database restart, most often.
 *
 * It takes no argument on purpose. There is no `cause` channel here (nothing
 * is being thrown to anyone) so the only place a driver error could go is the
 * logger, and `pg` connection errors routinely embed
 * `postgres://user:password@host/db`. A handler that cannot see the error
 * cannot leak it. (SPEC.md §72.6)
 */
export type ConnectionErrorHandler = () => void;

/** The seam that keeps `pg` out of the source; `createNodePostgresDriver` is the real one. */
export interface PgDriver {
  createPool(options: PgPoolOptions, onError: ConnectionErrorHandler): PgPool;
  createClient(options: PgClientOptions, onError: ConnectionErrorHandler): PgCancelClient;
}

/** What `pg`'s own `Pool`/`Client` provide, reduced to what the adapter touches. */
export interface RawQueryConfig {
  readonly text: string;
  readonly values: unknown[];
  readonly rowMode: "array";
}

export interface RawPoolClient {
  query(config: RawQueryConfig): Promise<PgArrayModeQueryResult>;
  release(): void;
}

export interface RawPool {
  on(event: "error", listener: () => void): unknown;
  connect(): Promise<RawPoolClient>;
  end(): Promise<void>;
}

export interface RawClient {
  on(event: "error", listener: () => void): unknown;
  connect(): Promise<unknown>;
  query(config: RawQueryConfig): Promise<PgArrayModeQueryResult>;
  end(): Promise<unknown>;
}

export interface NodePostgresRuntime {
  createPool(options: PgPoolOptions): RawPool;
  createClient(options: PgClientOptions): RawClient;
}

/**
 * Reads the backend PID `pg` sets on every client from the server's
 * BackendKeyData message during connect. `@types/pg` does not declare it, so
 * it is read reflectively — with a key this module owns, not a caller-supplied
 * one — rather than by casting the client, which would also silence real type
 * errors.
 *
 * Backend PIDs are positive integers. Anything else (absent, non-numeric, 0,
 * negative, fractional, NaN) becomes `null`, because the alternative is
 * `pg_cancel_backend(0)` quietly returning false while the source logs that it
 * cancelled something: a silent no-op is worse than a reported inability.
 */
export function backendPid(client: object): number | null {
  const value: unknown = Reflect.get(client, "processID");
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * `rowMode` is hard-coded rather than forwarded from `config`. Forwarding
 * would be strictly weaker: `PgQueryConfig.rowMode` is the literal `"array"`,
 * so a typed caller can never send anything else, while an untyped one
 * reaching this function could forward `undefined` and get row objects that
 * misalign with `columns` by position. `values` is copied because `pg` types
 * it as a mutable array.
 */
export function driverQuery(config: PgQueryConfig): RawQueryConfig {
  return { text: config.text, values: [...config.values], rowMode: "array" };
}

/**
 * Adapts `pg` to `PgDriver`.
 *
 * Both constructors are wired with an `error` listener at construction.
 * `pg.Pool` and `pg.Client` are EventEmitters, and both emit `'error'` for
 * failures that belong to no query — `pg-pool` emits one whenever a *checked-in
 * idle* client's socket fails, which a database restart or a network blip
 * produces routinely. Node throws an unhandled `'error'`, so without these
 * listeners such an event takes down the host process, printing a driver error
 * that embeds the connection string on the way out. (SPEC.md §72.6)
 */
export function createNodePostgresDriver(runtime: NodePostgresRuntime): PgDriver {
  return {
    createPool(options, onError) {
      const pool = runtime.createPool(options);
      pool.on("error", onError);
      return {
        async connect() {
          const client = await pool.connect();
          return {
            processID: backendPid(client),
            async query(config: PgQueryConfig): Promise<PgArrayModeQueryResult> {
              return await client.query(driverQuery(config));
            },
            release() {
              client.release();
            },
          };
        },
        async end() {
          await pool.end();
        },
      };
    },

    createClient(options, onError) {
      const client = runtime.createClient(options);
      client.on("error", onError);
      return {
        async connect() {
          await client.connect();
        },
        async query(config: PgQueryConfig): Promise<PgArrayModeQueryResult> {
          return await client.query(driverQuery(config));
        },
        async end() {
          await client.end();
        },
      };
    },
  };
}
