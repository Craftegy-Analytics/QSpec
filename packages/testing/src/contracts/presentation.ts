import { describe, expect, it } from "vitest";
import type {
  Field,
  PresentationDefinition,
  PresentationType,
  PresentationValidationContext,
} from "@qspecs/core";

export interface PresentationContractFixture {
  /** A presentation definition the type accepts. */
  readonly definition: PresentationDefinition;
  /** Dataset fields under which `definition` is valid. */
  readonly fields: readonly Field[];
  /**
   * Every dataset field name `definition` references, as the fixture author
   * knows them to be — not as `fieldReferences()` reports them.
   *
   * The suite cannot infer what a presentation type reads, so without this it
   * could only check that references were well-FORMED. A `pie` reporting
   * `category` and silently omitting `value` passed every other assertion here,
   * and under-reporting is precisely what disables core's unknown-field
   * detection: a field nobody declares is a field nobody checks.
   */
  readonly expectedReferences: readonly string[];
}

/**
 * Path segments core reserves for rebasing: `validatePresentation` prefixes
 * every plugin-reported path with `["spec", "presentation", ...path]`
 * (packages/core/src/internal/validate/presentation.ts). A `fieldReferences`
 * path that itself starts with either segment produces a doubled path like
 * `spec.presentation.spec.presentation.x.field` in the user-facing error.
 */
const RESERVED_PATH_ROOTS = new Set(["spec", "presentation"]);

/**
 * Invariants every `PresentationType` must satisfy, per SPEC.md §50 and §86
 * and validatePresentation's assumptions. Call this from a presentation
 * package's own test file, once per registered presentation type.
 */
export function runPresentationContractTests(
  name: string,
  presentationType: PresentationType,
  fixture: PresentationContractFixture,
): void {
  const context: PresentationValidationContext = { fields: fixture.fields };
  // A definition missing everything but the discriminator. `validate` is
  // expected to reject it; `fieldReferences` is expected to survive it —
  // core calls fieldReferences() unconditionally, even against a definition
  // validate() has already rejected.
  const malformed: PresentationDefinition = { type: fixture.definition.type };

  describe(`${name} — PresentationType contract`, () => {
    it("validate() accepts the fixture definition", () => {
      const issues = presentationType.validate?.(fixture.definition, context) ?? [];
      expect(issues).toEqual([]);
    });

    it("validate() reports issues or throws for a malformed definition, rather than passing silently", () => {
      // Returning issues lets several problems surface at once; throwing caps
      // the report at one. Both are permitted by the interface, so this only
      // asserts that a garbage definition does not sail through as valid.
      let threw = false;
      let issues: readonly unknown[] = [];
      try {
        issues = presentationType.validate?.(malformed, context) ?? [];
      } catch {
        threw = true;
      }
      expect(threw || issues.length > 0).toBe(true);
    });

    it("fieldReferences() does not throw on a malformed definition", () => {
      // Core calls fieldReferences() unconditionally during validation stage
      // 6, even for a definition validate() just rejected. A presentation
      // type that throws here replaces the collected validation issues with
      // a raw TypeError instead of reporting them.
      expect(() => presentationType.fieldReferences?.(malformed)).not.toThrow();
    });

    it("fieldReferences() returns paths made only of string/number segments", () => {
      const references = presentationType.fieldReferences?.(fixture.definition) ?? [];
      for (const reference of references) {
        expect(Array.isArray(reference.path)).toBe(true);
        for (const segment of reference.path) {
          expect(typeof segment === "string" || typeof segment === "number").toBe(true);
        }
      }
    });

    it("fieldReferences() reports every field the definition references, and no others", () => {
      const references = presentationType.fieldReferences?.(fixture.definition) ?? [];
      const reported = [...new Set(references.map((reference) => reference.field))].sort();
      expect(reported).toEqual([...new Set(fixture.expectedReferences)].sort());
    });

    it("fieldReferences() returns paths relative to the presentation node", () => {
      const references = presentationType.fieldReferences?.(fixture.definition) ?? [];
      // A fixture producing zero references would let this pass without
      // checking anything; the fixture must exercise at least one reference
      // for the assertion below to mean something.
      expect(references.length).toBeGreaterThan(0);
      for (const reference of references) {
        const first = reference.path[0];
        expect(RESERVED_PATH_ROOTS.has(String(first))).toBe(false);
      }
    });
  });
}
