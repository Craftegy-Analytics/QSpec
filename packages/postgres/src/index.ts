import { Client, Pool } from "pg";
import {
  createNodePostgresDriver,
  type PgClientOptions,
  type PgDriver,
  type PgPoolOptions,
} from "./internal/driver.js";
import { createPostgresPlugin, type PostgresOptions } from "./internal/source.js";
import type { QSpecPlugin } from "@qspecs/core";

/**
 * The whole public surface: the plugin factory and what a host must type to
 * configure it. `renderPostgres`, `normalizePgResult`, `postgresTypeName`,
 * `createPostgresSource`, and the `PgDriver` seam are all deliberately
 * internal — see docs/known-gaps.md. Adding an export later is not a breaking
 * change; removing one after publish is.
 */
export type { PostgresOptions, PostgresSourceConfig } from "./internal/source.js";

/**
 * The only place in this package that imports `pg`. Everything the driver
 * does with it lives in `internal/driver.ts`, which takes these two
 * constructors as an argument so it can be exercised against fakes.
 */
const nodePostgresDriver: PgDriver = createNodePostgresDriver({
  createPool: (options: PgPoolOptions) => new Pool(options),
  createClient: (options: PgClientOptions) => new Client(options),
});

/**
 * Registers one Postgres-backed data source per configured name, each
 * executing the "sql" language.
 *
 * Connection strings come from the host application and are never read from a
 * manifest. (SPEC.md §9, §72.1)
 */
export function postgres(options: PostgresOptions): QSpecPlugin {
  return createPostgresPlugin(options, nodePostgresDriver);
}
