import { describe, expect, it } from "vitest";
import {
  ExecutionDeniedError,
  ManifestValidationError,
  PluginRegistrationError,
  QSPEC_V1,
  createQSpec,
  definePlugin,
  type QueryLanguage,
} from "@qspecs/core";
import { memory } from "@qspecs/testing";
import * as entry from "./index.js";
import { isSqlPolicyView, scanSql, sql, sqlPolicyView } from "./index.js";

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

describe("@qspecs/sql exports for execution policies", () => {
  it("exports scanSql, sqlPolicyView and isSqlPolicyView", () => {
    expect(typeof entry.scanSql).toBe("function");
    expect(typeof entry.sqlPolicyView).toBe("function");
    expect(typeof entry.isSqlPolicyView).toBe("function");
    expect(scanSql("SELECT :a::date")).toEqual({
      segments: ["SELECT ", "::date"],
      parameterNames: ["a"],
      positionalPlaceholder: undefined,
    });
  });

  it("registers a language whose policyView is a function", async () => {
    let language: QueryLanguage | undefined;
    const qspec = createQSpec()
      .use(sql())
      .use(
        definePlugin({
          name: "inspect-sql-language",
          setup(api) {
            language = api.queryLanguages.get("sql");
          },
        }),
      );
    await qspec.ready();
    expect(typeof language?.policyView).toBe("function");
  });

  it("hands a policy the same view sqlPolicyView computes statically, and never a value", async () => {
    const views: unknown[] = [];
    const memorySource = memory({ tables: { widgets: { columns: ["id"], rows: [[1]] } } });
    const qspec = createQSpec()
      .use(sql())
      .use(memorySource)
      .use(
        definePlugin({
          name: "capture-view",
          setup(api) {
            api.policies.register("capture", {
              check(input) {
                views.push(input.query?.view);
                return { outcome: "deny", issues: [{ code: "stop", message: "stop", path: [] }] };
              },
            });
          },
        }),
      );
    const query = {
      source: "widgets",
      language: "sql",
      statement: "SELECT id FROM widgets WHERE id = :id AND tag = ':id' AND kind = :kind",
      bindings: { id: { literal: "SECRET_LITERAL" }, kind: "$parameters.kind" },
    };
    const manifest = {
      apiVersion: QSPEC_V1,
      kind: "Dataset",
      metadata: { name: "widgets-report" },
      spec: { parameters: { kind: { type: "string" } }, query },
    };
    await expect(
      qspec.execute(manifest, { parameters: { kind: "SECRET_PARAMETER" } }),
    ).rejects.toThrow(ExecutionDeniedError);
    expect(views).toHaveLength(1);
    const view = views[0];
    expect(isSqlPolicyView(view)).toBe(true);
    expect(view).toEqual(sqlPolicyView(query));
    expect(JSON.stringify(view)).not.toMatch(/SECRET_/);
    expect(memorySource.calls).toHaveLength(0);
  });
});
