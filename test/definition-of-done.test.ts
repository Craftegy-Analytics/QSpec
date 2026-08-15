import { describe, expect, it } from "vitest";
import { createQSpec, defineManifest, definePlugin } from "@qspecs/core";

describe("SPEC.md §115 definition of done", () => {
  it("runs the documented acceptance snippet", async () => {
    const examplePlugin = () => definePlugin({ name: "example", setup: () => {} });

    const qspec = createQSpec().use(examplePlugin());

    const manifest = defineManifest({
      apiVersion: "qspec.dev/v1",
      kind: "Dataset",
      metadata: { name: "example" },
      spec: { parameters: {} },
    });

    const prepared = await qspec.prepare(manifest);
    expect(prepared.name).toBe("example");
    expect(prepared.kind).toBe("Dataset");
  });
});
