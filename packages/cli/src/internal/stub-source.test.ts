import { describe, expect, it } from "vitest";
import { createStubSource, STUB_SOURCE_EXECUTE_MESSAGE } from "./stub-source.js";

describe("createStubSource", () => {
  it("execute() throws with a message naming why", () => {
    const source = createStubSource();
    expect(() => source.execute({}, { executionId: "exec-1", logger: {} })).toThrow(
      STUB_SOURCE_EXECUTE_MESSAGE,
    );
  });

  it("has no supportedLanguages property at all (not merely an undefined one)", () => {
    const source = createStubSource();
    expect(Object.hasOwn(source, "supportedLanguages")).toBe(false);
  });
});
