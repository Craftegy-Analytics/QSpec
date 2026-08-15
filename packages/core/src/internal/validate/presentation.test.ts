import { describe, expect, it } from "vitest";
import { PresentationError, formatPath } from "../../errors.js";
import type { Field } from "../../types/dataset.js";
import type { PresentationDefinition, PresentationType } from "../../types/presentation.js";
import { validatePresentation } from "./presentation.js";

const lineChart: PresentationType = {
  fieldReferences: (definition) => {
    const references: { field: string; path: (string | number)[] }[] = [];
    const x = (definition as { x?: { field?: string } }).x;
    if (typeof x?.field === "string") references.push({ field: x.field, path: ["x", "field"] });
    const series = (definition as { series?: { field?: string }[] }).series ?? [];
    series.forEach((entry, index) => {
      if (typeof entry.field === "string") {
        references.push({ field: entry.field, path: ["series", index, "field"] });
      }
    });
    return references;
  },
};

const fields: Field[] = [
  { name: "month", type: "datetime" },
  { name: "revenue", type: "number" },
];

const definition: PresentationDefinition = {
  type: "line",
  x: { field: "month" },
  series: [{ field: "revenue" }],
};

describe("validatePresentation", () => {
  it("accepts references that all exist", () => {
    expect(validatePresentation(definition, lineChart, fields)).toEqual([]);
  });

  it("produces the SPEC.md 86 diagnostic for a misspelled field", () => {
    const bad = { ...definition, series: [{ field: "reveneu" }] };
    const issues = validatePresentation(bad, lineChart, fields);
    expect(issues).toHaveLength(1);
    expect(formatPath(issues[0]?.path ?? [])).toBe("spec.presentation.series[0].field");
    expect(issues[0]?.message).toMatch(/Unknown dataset field "reveneu"/);
    expect(issues[0]?.suggestion).toBe("revenue");
  });

  it("omits a suggestion when nothing is close", () => {
    const bad = { ...definition, series: [{ field: "zzzzzzzzzz" }] };
    expect(validatePresentation(bad, lineChart, fields)[0]?.suggestion).toBeUndefined();
  });

  it("skips validation when the projected schema is unknown", () => {
    const bad = { ...definition, series: [{ field: "reveneu" }] };
    expect(validatePresentation(bad, lineChart, undefined)).toEqual([]);
  });

  it("skips validation when the presentation type declares no references", () => {
    expect(validatePresentation(definition, {}, fields)).toEqual([]);
  });

  it("surfaces an error thrown by a presentation type's own validate hook", () => {
    const strict: PresentationType = {
      validate: () => {
        throw new Error("series must not be empty");
      },
    };
    const issues = validatePresentation(definition, strict, fields);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toBe("series must not be empty");
    expect(formatPath(issues[0]?.path ?? [])).toBe("spec.presentation");
  });

  it("reports every bad reference at once", () => {
    const bad = { type: "line", x: { field: "monht" }, series: [{ field: "reveneu" }] };
    expect(validatePresentation(bad, lineChart, fields)).toHaveLength(2);
  });

  it("collects several issues returned by a presentation type's validate hook", () => {
    const strict: PresentationType = {
      validate: () => [
        { code: "QSPEC_PRESENTATION_INVALID", message: "title is required", path: ["title"] },
        { code: "QSPEC_PRESENTATION_INVALID", message: "stack is unsupported", path: ["stack"] },
      ],
    };
    const issues = validatePresentation(definition, strict, fields);
    expect(issues).toHaveLength(2);
    // Plugin paths are relative to spec.presentation, as fieldReferences' are.
    expect(issues.map((issue) => formatPath(issue.path))).toEqual([
      "spec.presentation.title",
      "spec.presentation.stack",
    ]);
  });

  it("keeps every issue carried by a thrown aggregate error", () => {
    const strict: PresentationType = {
      validate: () => {
        throw new PresentationError("2 problems", {
          issues: [
            { code: "QSPEC_PRESENTATION_INVALID", message: "a", path: ["a"] },
            { code: "QSPEC_PRESENTATION_INVALID", message: "b", path: ["b"] },
          ],
        });
      },
    };
    const issues = validatePresentation(definition, strict, fields);
    // Before the widening this collapsed to one issue holding only "2 problems".
    expect(issues.map((issue) => issue.message)).toEqual(["a", "b"]);
    expect(formatPath(issues[1]?.path ?? [])).toBe("spec.presentation.b");
  });

  it("still reports plain thrown errors as one issue on the presentation node", () => {
    const strict: PresentationType = {
      validate: () => {
        throw new Error("nope");
      },
    };
    const issues = validatePresentation(definition, strict, fields);
    expect(issues).toHaveLength(1);
    expect(formatPath(issues[0]?.path ?? [])).toBe("spec.presentation");
  });
});
