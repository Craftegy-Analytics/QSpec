/**
 * Postgres `dataTypeID` (OID) to a readable type name, covering the common
 * built-in types. Not exhaustive — Postgres has hundreds of OIDs, including
 * every array, range, domain, and extension type a schema might introduce.
 *
 * Exported for `packages/postgres/test/integration.test.ts`, which derives
 * its OID cross-check from this map rather than hand-duplicating the name
 * list — internal-only, this must not be re-exported from `src/index.ts`.
 */
export const OID_NAMES: ReadonlyMap<number, string> = new Map([
  [16, "bool"],
  [20, "int8"],
  [21, "int2"],
  [23, "int4"],
  [25, "text"],
  [114, "json"],
  [700, "float4"],
  [701, "float8"],
  [1043, "varchar"],
  [1082, "date"],
  [1083, "time"],
  [1114, "timestamp"],
  [1184, "timestamptz"],
  [1700, "numeric"],
  [2950, "uuid"],
  [3802, "jsonb"],
]);

/**
 * Maps a Postgres `dataTypeID` to a readable type name. Returns `undefined`
 * for an OID this map does not cover, rather than a guess like `"oid:12345"`
 * — `RawColumn.nativeType` is optional, and an absent value is honest where a
 * fabricated one is not.
 */
export function postgresTypeName(dataTypeID: number): string | undefined {
  return OID_NAMES.get(dataTypeID);
}
