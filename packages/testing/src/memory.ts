import {
  QSpecAbortError,
  QueryExecutionError,
  definePlugin,
  type DataSource,
  type DataSourceContext,
  type JsonValue,
  type QSpecPlugin,
  type QueryLanguage,
  type RawColumn,
  type RawQueryResult,
} from "@qspecs/core";

export interface MemoryTable {
  /** Bare names, or full descriptors when a nativeType matters. */
  readonly columns: readonly (string | RawColumn)[];
  /** Positional rows, matching the RawQueryResult contract. */
  readonly rows: readonly (readonly unknown[])[];
  /**
   * Resolve after this many milliseconds instead of immediately, so tests can
   * abort while the source is genuinely in flight.
   */
  readonly delayMs?: number;
}

export interface MemoryOptions {
  readonly tables: Readonly<Record<string, MemoryTable>>;
}

/** One recorded execution, for assertions. */
export interface MemoryCall {
  readonly source: string;
  readonly statement: unknown;
  readonly bindings: Record<string, JsonValue>;
}

export interface MemoryPlugin extends QSpecPlugin {
  /** Executions so far, in order. */
  readonly calls: readonly MemoryCall[];
  /**
   * The data sources this plugin registers, by name. Exposed so contract
   * suites (SPEC.md §89) and direct-behavior tests can exercise a source
   * instance without going through the whole QSpec pipeline — the pipeline's
   * own dataset normalization builds fresh row objects regardless, so it
   * cannot observe what a source itself does or doesn't copy.
   */
  readonly sources: Readonly<Record<string, DataSource>>;
}

/** What the pass-through language hands to the source. */
interface CompiledMemoryQuery {
  readonly source: string;
  readonly statement: unknown;
  readonly bindings: Record<string, JsonValue>;
}

function toColumns(columns: readonly (string | RawColumn)[]): readonly RawColumn[] {
  return columns.map((column) => (typeof column === "string" ? { name: column } : column));
}

/**
 * An in-memory data source plus a pass-through query language, for exercising
 * the full pipeline without a database.
 *
 * The statement names which configured table to return. Bindings are recorded
 * but not applied — filtering belongs to the transform pipeline, and a source
 * that silently filtered would make transform tests prove nothing.
 */
export function memory(options: MemoryOptions): MemoryPlugin {
  const calls: MemoryCall[] = [];

  const language: QueryLanguage<unknown, CompiledMemoryQuery> = {
    compile: (query, context) => ({
      source: context.source,
      statement: query.statement,
      bindings: context.bindings,
    }),
  };

  const createSource = (sourceName: string): DataSource<CompiledMemoryQuery> => ({
    async execute(query, context: DataSourceContext): Promise<RawQueryResult> {
      calls.push({ source: sourceName, statement: query.statement, bindings: query.bindings });

      if (typeof query.statement !== "string") {
        throw new QueryExecutionError(
          `Memory source "${sourceName}" requires a string statement naming a table, ` +
            `received ${typeof query.statement}.`,
        );
      }

      const name = query.statement;
      const table = Object.hasOwn(options.tables, name) ? options.tables[name] : undefined;
      if (table === undefined) {
        throw new QueryExecutionError(
          `Memory source "${sourceName}" has no table named "${name}". ` +
            `Configured tables: ${Object.keys(options.tables).join(", ") || "(none)"}.`,
        );
      }

      if (table.delayMs !== undefined) {
        // Checked up front because `addEventListener("abort", ...)` never
        // fires for a signal that was already aborted before the listener
        // was attached — the abort event fired in the past. Without this,
        // an already-aborted signal would run the full delay before the
        // post-delay check below catches it, instead of rejecting promptly.
        if (context.signal?.aborted === true) {
          throw new QSpecAbortError("Memory source aborted.", { cause: context.signal.reason });
        }
        // The listener is captured so it can be removed on BOTH paths: `once`
        // only removes it when abort actually fires, so a caller that reuses
        // one signal across many executions would otherwise accumulate a
        // listener per completed call.
        let onAbort: (() => void) | undefined;
        try {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, table.delayMs);
            onAbort = () => {
              clearTimeout(timer);
              reject(
                new QSpecAbortError("Memory source aborted.", { cause: context.signal?.reason }),
              );
            };
            context.signal?.addEventListener("abort", onAbort, { once: true });
          });
        } finally {
          if (onAbort !== undefined) context.signal?.removeEventListener("abort", onAbort);
        }
      }

      if (context.signal?.aborted === true) {
        throw new QSpecAbortError("Memory source aborted.", { cause: context.signal.reason });
      }

      // Rows are deep-cloned so a downstream mutation — including a mutation
      // reaching into a composite (object/array) cell value — cannot corrupt
      // the fixture and silently change what a later assertion sees.
      return {
        columns: toColumns(table.columns),
        rows: table.rows.map((row) => structuredClone(row)),
      };
    },
  });

  const sourcesByName: Record<string, DataSource> = {};
  for (const sourceName of Object.keys(options.tables)) {
    sourcesByName[sourceName] = createSource(sourceName) as DataSource;
  }

  const plugin = definePlugin({
    name: "@qspecs/testing/memory",
    setup(api) {
      api.queryLanguages.register("memory", language as QueryLanguage);
      for (const [sourceName, source] of Object.entries(sourcesByName)) {
        api.sources.register(sourceName, source);
      }
    },
  });

  return { ...plugin, calls, sources: sourcesByName };
}
