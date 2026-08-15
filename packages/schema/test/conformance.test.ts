import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { validateManifestStructure } from "@qspecs/core";
import { validateWithJsonSchema } from "../src/index.js";

const root = resolve(import.meta.dirname, "../../..");

async function load(kind: "valid" | "invalid") {
  const directory = join(root, "fixtures", kind);
  const names = await readdir(directory);
  return Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => ({
        name,
        manifest: JSON.parse(await readFile(join(directory, name), "utf8")) as unknown,
      })),
  );
}

describe("validator conformance", () => {
  it("finds fixtures to test", async () => {
    expect((await load("valid")).length).toBeGreaterThanOrEqual(3);
    expect((await load("invalid")).length).toBeGreaterThanOrEqual(3);
  });

  it("both validators accept every valid fixture", async () => {
    for (const { name, manifest } of await load("valid")) {
      expect(validateManifestStructure(manifest), `core rejected ${name}`).toEqual([]);
      expect(validateWithJsonSchema(manifest).valid, `schema rejected ${name}`).toBe(true);
    }
  });

  it("both validators reject every invalid fixture", async () => {
    for (const { name, manifest } of await load("invalid")) {
      expect(validateManifestStructure(manifest).length, `core accepted ${name}`).toBeGreaterThan(
        0,
      );
      expect(validateWithJsonSchema(manifest).valid, `schema accepted ${name}`).toBe(false);
    }
  });
});
