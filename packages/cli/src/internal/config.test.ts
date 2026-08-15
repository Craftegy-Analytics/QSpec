import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

async function moduleWith(source: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "qspec-cli-config-"));
  const path = join(directory, "qspec.config.mjs");
  await writeFile(path, source);
  return path;
}

const SENTINEL_PLUGIN = `{ name: "sentinel", setup() {} }`;

describe("loadConfig", () => {
  it("loads a valid config and returns its plugins (named `plugins` export)", async () => {
    const path = await moduleWith(`export const plugins = [${SENTINEL_PLUGIN}];`);
    const config = await loadConfig(path);
    expect(config.plugins).toHaveLength(1);
    expect(config.plugins[0]?.name).toBe("sentinel");
  });

  it("accepts a default export shaped { plugins: [...] }", async () => {
    const path = await moduleWith(`export default { plugins: [${SENTINEL_PLUGIN}] };`);
    const config = await loadConfig(path);
    expect(config.plugins).toHaveLength(1);
    expect(config.plugins[0]?.name).toBe("sentinel");
  });

  it("prefers the named `plugins` export over a default export when both are present", async () => {
    const path = await moduleWith(
      `export const plugins = [${SENTINEL_PLUGIN}];\n` +
        `export default { plugins: [{ name: "from-default", setup() {} }] };`,
    );
    const config = await loadConfig(path);
    expect(config.plugins).toHaveLength(1);
    expect(config.plugins[0]?.name).toBe("sentinel");
  });

  it("fails with a clear message naming the path when the file is missing", async () => {
    const missing = join(tmpdir(), "qspec-cli-config-does-not-exist", "qspec.config.mjs");
    await expect(loadConfig(missing)).rejects.toThrow(missing);
  });

  it("surfaces an error thrown by the config module itself, rather than swallowing it", async () => {
    const path = await moduleWith(`throw new Error("boom from config module");`);
    await expect(loadConfig(path)).rejects.toThrow("boom from config module");
  });

  it("fails with a shape diagnostic when the module exports no plugins", async () => {
    const path = await moduleWith(`export const notPlugins = [${SENTINEL_PLUGIN}];`);
    await expect(loadConfig(path)).rejects.toThrow(/plugins/);
  });

  it("fails with a shape diagnostic when `plugins` is not an array", async () => {
    const path = await moduleWith(`export const plugins = "not-an-array";`);
    await expect(loadConfig(path)).rejects.toThrow(/array/);
  });

  it("fails with a shape diagnostic when a plugin entry is not an object", async () => {
    const path = await moduleWith(`export const plugins = [${SENTINEL_PLUGIN}, "not-an-object"];`);
    await expect(loadConfig(path)).rejects.toThrow(/plugins\[1\]/);
  });

  it("never discovers a config implicitly: a qspec.config.js sitting in the working directory is not loaded without an explicit path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "qspec-cli-config-implicit-"));
    await writeFile(
      join(directory, "qspec.config.js"),
      `export const plugins = [{ name: "should-never-load", setup() {} }];`,
    );

    const originalCwd = process.cwd();
    process.chdir(directory);
    try {
      // Nothing about this path points at the qspec.config.js sitting right
      // next to it in the cwd — loadConfig must not go looking for it.
      await expect(loadConfig("unrelated-missing-config.mjs")).rejects.toThrow(
        /unrelated-missing-config\.mjs/,
      );
    } finally {
      process.chdir(originalCwd);
    }
  });
});
