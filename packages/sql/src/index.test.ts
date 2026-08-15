import { describe, expect, it } from "vitest";
import {
  ManifestValidationError,
  PluginRegistrationError,
  QSPEC_V1,
  createQSpec,
  definePlugin,
} from "@qspecs/core";
import { memory } from "@qspecs/testing";
import { sql } from "./index.js";

describe("sql()", () => {
  it('registers exactly the language name "sql"', async () => {
    let names: readonly string[] = [];
    const qspec = createQSpec()
      .use(sql())
      .use(
        definePlugin({
          name: "inspect-sql",
          setup(api) {
            names = api.queryLanguages.list();
          },
        }),
      );
    await qspec.ready();
    expect(names).toEqual(["sql"]);
  });

  it("rejects installing sql() twice on one runtime", async () => {
    const qspec = createQSpec().use(sql()).use(sql());
    await expect(qspec.ready()).rejects.toThrow(PluginRegistrationError);
  });

  it("prepares a manifest with a sql query through sql() and memory() together", async () => {
    // memory() omits supportedLanguages, so it accepts a query compiled by
    // any language — the backward-compatibility guarantee Task 3 must
    // preserve. If this test starts failing after Task 3 lands, that
    // guarantee has been broken.
    const qspec = createQSpec()
      .use(sql())
      .use(memory({ tables: { widgets: { columns: ["id"], rows: [[1]] } } }));

    const manifest = {
      apiVersion: QSPEC_V1,
      kind: "Dataset",
      metadata: { name: "widgets-report" },
      spec: {
        query: {
          source: "widgets",
          language: "sql",
          statement: "SELECT id FROM widgets WHERE id = :id",
          bindings: { id: { literal: 1 } },
        },
      },
    };

    const prepared = await qspec.prepare(manifest);
    expect(prepared.name).toBe("widgets-report");
  });

  it("fails prepare() when the statement writes its own positional placeholder", async () => {
    // Copy-pasted from application code that already used `$1` is the
    // realistic way this arrives. `@qspecs/postgres` appends its own `$1` for
    // `:id`, so the server would see two `$1` references and one value and
    // silently bind it to both — a wrong result, not an error. prepare() has
    // to be where that stops.
    const qspec = createQSpec()
      .use(sql())
      .use(memory({ tables: { widgets: { columns: ["id"], rows: [] } } }));

    const manifest = {
      apiVersion: QSPEC_V1,
      kind: "Dataset",
      metadata: { name: "widgets-report" },
      spec: {
        query: {
          source: "widgets",
          language: "sql",
          statement: "SELECT * FROM widgets WHERE id = $1 AND kind = :id",
          bindings: { id: { literal: 1 } },
        },
      },
    };

    const error: unknown = await qspec.prepare(manifest).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    if (!(error instanceof ManifestValidationError)) {
      throw new Error(`expected a ManifestValidationError, got ${String(error)}`);
    }
    expect(error.issues).toHaveLength(1);
    expect(error.issues[0]?.path).toEqual(["spec", "query", "statement"]);
    expect(error.issues[0]?.message).toContain('"$1"');
  });

  it("reports several validate problems at once: an unknown parameter and an unused binding", async () => {
    const qspec = createQSpec()
      .use(sql())
      .use(memory({ tables: { widgets: { columns: ["id"], rows: [] } } }));

    const manifest = {
      apiVersion: QSPEC_V1,
      kind: "Dataset",
      metadata: { name: "widgets-report" },
      spec: {
        query: {
          source: "widgets",
          language: "sql",
          statement: "SELECT * FROM widgets WHERE id = :from",
          bindings: { to: { literal: 1 } },
        },
      },
    };

    try {
      await qspec.prepare(manifest);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ManifestValidationError);
      const issues = (error as ManifestValidationError).issues;
      expect(issues).toEqual([
        {
          code: "QSPEC_MANIFEST_INVALID",
          message: 'Statement references parameter ":from", which has no matching binding.',
          path: ["spec", "query", "statement"],
        },
        {
          code: "QSPEC_MANIFEST_INVALID",
          message: 'Binding "to" is declared but never referenced by the statement.',
          path: ["spec", "query", "bindings", "to"],
        },
      ]);
    }
  });
});
