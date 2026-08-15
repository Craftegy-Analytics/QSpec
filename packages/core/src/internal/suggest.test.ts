import { describe, expect, it } from "vitest";
import { editDistance, suggest } from "./suggest.js";

describe("editDistance", () => {
  it("is zero for identical strings", () => {
    expect(editDistance("revenue", "revenue")).toBe(0);
  });

  it("counts a transposition as two edits", () => {
    expect(editDistance("reveneu", "revenue")).toBe(2);
  });

  it("counts insertions and deletions", () => {
    expect(editDistance("revenu", "revenue")).toBe(1);
    expect(editDistance("revenuee", "revenue")).toBe(1);
  });
});

describe("suggest", () => {
  it("finds the SPEC.md 86 example", () => {
    expect(suggest("reveneu", ["month", "revenue", "cost"])).toBe("revenue");
  });

  it("returns undefined when nothing is close enough", () => {
    expect(suggest("timestamp", ["month", "revenue"])).toBeUndefined();
  });

  it("returns undefined for an empty candidate list", () => {
    expect(suggest("x", [])).toBeUndefined();
  });

  it("is case-insensitive", () => {
    expect(suggest("Revenue", ["revenue"])).toBe("revenue");
  });

  it("prefers the closest candidate", () => {
    expect(suggest("gte_", ["gt", "gte", "lte"])).toBe("gte");
  });

  it("is deterministic when two candidates tie", () => {
    const candidates = ["aaa", "bbb"];
    expect(suggest("ccc", candidates)).toBe(suggest("ccc", [...candidates].reverse()));
  });
});
