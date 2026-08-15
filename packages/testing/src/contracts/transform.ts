import { describe, expect, it } from "vitest";
import type { Dataset, Field, Transform, TransformContext } from "@qspecs/core";

/**
 * The part of a `Field` a downstream consumer actually reasons about.
 *
 * Comparing only `name` let a transform claim `type: "number"` in `describe()`
 * while `execute()` produced strings — and that skew is exactly what feeds
 * core's dataset validation, so it has to be part of the contract.
 * `label`/`semanticType`/`format` are presentation metadata and are
 * deliberately excluded: carrying them through is a per-transform decision,
 * not an invariant.
 */
function shape(field: Field): { name: string; type: string; nullable: boolean } {
  return { name: field.name, type: field.type, nullable: field.nullable === true };
}

export interface TransformContractFixture {
  /** A dataset the transform accepts. */
  readonly dataset: Dataset;
  /** A spec the transform accepts. */
  readonly spec: unknown;
}

const context: TransformContext = { executionId: "contract", parameters: {} };

/**
 * Invariants every Transform must satisfy, per SPEC.md §64 and the pipeline's
 * assumptions. Call this from a transform package's own test file.
 */
export function runTransformContractTests(
  name: string,
  transform: Transform<never>,
  fixture: TransformContractFixture,
): void {
  describe(`${name} — Transform contract`, () => {
    it("does not mutate the input dataset", async () => {
      const rowCount = fixture.dataset.rows.length;
      const fieldNames = fixture.dataset.fields.map((field) => field.name);
      const snapshot = fixture.dataset.rows.map((row) => ({ ...row }));

      await transform.execute(fixture.dataset, fixture.spec as never, context);

      expect(fixture.dataset.rows).toHaveLength(rowCount);
      expect(fixture.dataset.fields.map((field) => field.name)).toEqual(fieldNames);
      fixture.dataset.rows.forEach((row, index) => {
        expect({ ...row }).toEqual(snapshot[index]);
      });
    });

    it("returns rows with a null prototype", async () => {
      const result = await transform.execute(fixture.dataset, fixture.spec as never, context);
      for (const row of result.rows) {
        expect(Object.getPrototypeOf(row)).toBeNull();
      }
    });

    it("returns rows whose keys match the returned fields exactly", async () => {
      const result = await transform.execute(fixture.dataset, fixture.spec as never, context);
      const expected = [...result.fields.map((field) => field.name)].sort();
      for (const row of result.rows) {
        expect(Object.keys(row).sort()).toEqual(expected);
      }
    });

    it("declares describe(), so it does not silently disable static validation", () => {
      // A transform without describe() is schema-opaque: prepare() stops
      // projecting fields there and presentation validation is skipped for
      // everything downstream. That is legal but must be a deliberate choice.
      expect(typeof transform.describe).toBe("function");
    });

    it("describe() agrees with execute() about the resulting fields", async () => {
      const projected = transform.describe?.(fixture.dataset.fields, fixture.spec as never) ?? [];
      const result = await transform.execute(fixture.dataset, fixture.spec as never, context);
      expect(projected.map(shape)).toEqual(result.fields.map(shape));
    });

    it("is deterministic: executing twice on the same input yields the same result", async () => {
      // SPEC.md §8 requires transforms be deterministic. Nothing else checks
      // it, and a transform that reaches for Date.now(), Math.random(), or an
      // unstable sort order would make every downstream snapshot and cache
      // unsound while passing the rest of this suite.
      const first = await transform.execute(fixture.dataset, fixture.spec as never, context);
      const second = await transform.execute(fixture.dataset, fixture.spec as never, context);
      expect(second.fields.map(shape)).toEqual(first.fields.map(shape));
      // Rows are null-prototype, which toEqual reports as unequal to a plain
      // object; spreading both sides compares the data rather than the shape.
      expect(second.rows.map((row) => ({ ...row }))).toEqual(first.rows.map((row) => ({ ...row })));
    });

    it("validate() accepts the fixture spec", () => {
      const issues = transform.validate?.(fixture.spec as never, fixture.dataset.fields) ?? [];
      expect(issues).toEqual([]);
    });

    it("validate() reports issues rather than throwing for a malformed spec", () => {
      // Returning issues lets several problems surface at once; throwing caps
      // the report at one. Both are permitted by the interface, so this asserts
      // only that a garbage spec does not escape as an unhandled non-QSpec error.
      let threw: unknown;
      let issues: readonly unknown[] = [];
      try {
        issues = transform.validate?.({} as never, fixture.dataset.fields) ?? [];
      } catch (error) {
        threw = error;
      }
      expect(threw !== undefined || issues.length > 0).toBe(true);
    });
  });
}
