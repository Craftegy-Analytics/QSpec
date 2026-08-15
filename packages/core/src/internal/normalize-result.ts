import { createRow, setKey } from "../json.js";
import type { Dataset, DatasetSchema, Field, FieldType, RawQueryResult } from "../types/dataset.js";

export interface NormalizeOptions {
  /** Declared field metadata, applied in preference to inference. */
  readonly schema?: DatasetSchema | undefined;
  /** Hard row cap; excess rows are dropped and `metadata.truncated` is set. */
  readonly maxRows?: number | undefined;
}

export interface DuplicateColumn {
  readonly original: string;
  readonly renamed: string;
}

export interface NormalizeOutcome {
  readonly dataset: Dataset;
  readonly duplicates: readonly DuplicateColumn[];
}

function inferType(value: unknown): FieldType | undefined {
  if (value === null || value === undefined) return undefined;
  if (value instanceof Date) return "datetime";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "string":
      return "string";
    case "boolean":
      return "boolean";
    case "number":
      return Number.isInteger(value) ? "integer" : "number";
    case "object":
      return "object";
    default:
      return "string";
  }
}

/**
 * Converts a top-level Date to an ISO string so a Dataset survives JSON.
 * Dates nested inside array or object values are left alone — adapters are
 * expected to hand back JSON-shaped values inside composite columns.
 */
function normalizeValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
}

/**
 * Converts a positional adapter result into a keyed, prototype-safe Dataset.
 * (design §2.4; SPEC.md §36, §72.4, §72.5)
 */
export function normalizeResult(
  raw: RawQueryResult,
  options: NormalizeOptions = {},
): NormalizeOutcome {
  const duplicates: DuplicateColumn[] = [];
  const used = new Set<string>();
  const names: string[] = [];

  for (const column of raw.columns) {
    if (!used.has(column.name)) {
      used.add(column.name);
      names.push(column.name);
      continue;
    }
    let suffix = 2;
    let candidate = `${column.name}_${suffix}`;
    while (used.has(candidate) || raw.columns.some((other) => other.name === candidate)) {
      suffix += 1;
      candidate = `${column.name}_${suffix}`;
    }
    used.add(candidate);
    names.push(candidate);
    duplicates.push({ original: column.name, renamed: candidate });
  }

  const limit = options.maxRows;
  const truncated = limit !== undefined && raw.rows.length > limit;
  const sourceRows = truncated ? raw.rows.slice(0, limit) : raw.rows;

  const rows = sourceRows.map((cells) => {
    const row = createRow();
    names.forEach((name, index) => {
      setKey(row, name, normalizeValue(cells[index]));
    });
    return row;
  });

  const declared = options.schema?.fields;

  const fields: Field[] = names.map((name, index) => {
    // `name` comes from the adapter, and `declared` is an ordinary manifest
    // object: without hasOwn, a column named `toString` or `constructor`
    // resolves to an Object.prototype member and spreads into a Field with no
    // `type` and no `nullable`. (SPEC.md §72.4)
    const definition =
      declared !== undefined && Object.hasOwn(declared, name) ? declared[name] : undefined;
    if (definition !== undefined) {
      return { name, ...definition };
    }
    let inferred: FieldType | undefined;
    let sawNull = false;
    for (const cells of sourceRows) {
      const value = cells[index];
      if (value === null || value === undefined) {
        sawNull = true;
      } else if (inferred === undefined) {
        inferred = inferType(value);
      }
      // Breaking at the first non-null value would miss nulls in later rows and
      // report nullable: false for a column like [10, null]. Stop only once
      // both facts are known.
      if (inferred !== undefined && sawNull) break;
    }
    const nativeType = raw.columns[index]?.nativeType;
    return {
      name,
      type: inferred ?? "string",
      nullable: sawNull || inferred === undefined,
      ...(nativeType === undefined ? {} : { format: { nativeType } }),
    };
  });

  const dataset: Dataset = {
    fields,
    rows,
    ...(truncated || raw.metadata?.truncated === true ? { metadata: { truncated: true } } : {}),
  };

  return { dataset, duplicates };
}
