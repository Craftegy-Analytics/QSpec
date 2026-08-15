import { describe, expect, it, vi } from "vitest";
import { PluginRegistrationError, UnknownResourceKindError } from "../errors.js";
import { definePlugin } from "../define.js";
import { createQSpec } from "./runtime.js";

const minimal = {
  apiVersion: "qspec.dev/v1",
  kind: "Dataset",
  metadata: { name: "example" },
  spec: { parameters: {} },
};

describe("createQSpec", () => {
  it("registers the built-in Dataset resource kind", async () => {
    const qspec = createQSpec();
    const prepared = await qspec.prepare(minimal);
    expect(prepared.kind).toBe("Dataset");
    expect(prepared.name).toBe("example");
  });

  it("rejects an unregistered kind and suggests a registered one", async () => {
    const qspec = createQSpec();
    await expect(qspec.prepare({ ...minimal, kind: "Datset" })).rejects.toThrow(
      UnknownResourceKindError,
    );
  });

  it("returns itself from use() so calls chain", () => {
    const qspec = createQSpec();
    const plugin = definePlugin({ name: "p", setup: () => {} });
    expect(qspec.use(plugin)).toBe(qspec);
  });

  it("runs plugin setup lazily, on ready()", async () => {
    const setup = vi.fn();
    const qspec = createQSpec().use(definePlugin({ name: "p", setup }));
    expect(setup).not.toHaveBeenCalled();
    await qspec.ready();
    expect(setup).toHaveBeenCalledOnce();
  });

  it("awaits an async setup before prepare resolves", async () => {
    let done = false;
    const qspec = createQSpec().use(
      definePlugin({
        name: "p",
        setup: async (api) => {
          await Promise.resolve();
          api.resources.register("Widget", {});
          done = true;
        },
      }),
    );
    await qspec.prepare({ ...minimal, kind: "Widget" });
    expect(done).toBe(true);
  });

  it("runs each setup exactly once across repeated calls", async () => {
    const setup = vi.fn();
    const qspec = createQSpec().use(definePlugin({ name: "p", setup }));
    await qspec.ready();
    await qspec.ready();
    await qspec.prepare(minimal);
    expect(setup).toHaveBeenCalledOnce();
  });

  it("runs setups in registration order", async () => {
    const order: string[] = [];
    const qspec = createQSpec()
      .use(definePlugin({ name: "a", setup: () => void order.push("a") }))
      .use(definePlugin({ name: "b", setup: () => void order.push("b") }));
    await qspec.ready();
    expect(order).toEqual(["a", "b"]);
  });

  it("rejects two plugins with the same name", async () => {
    const qspec = createQSpec()
      .use(definePlugin({ name: "dup", setup: () => {} }))
      .use(definePlugin({ name: "dup", setup: () => {} }));
    await expect(qspec.ready()).rejects.toThrow(PluginRegistrationError);
  });

  it("re-throws the same setup failure on every later call", async () => {
    const qspec = createQSpec().use(
      definePlugin({
        name: "dup",
        setup: () => {},
      }),
    );
    qspec.use(definePlugin({ name: "dup", setup: () => {} }));
    const first = await qspec.ready().catch((error: unknown) => error);
    const second = await qspec.ready().catch((error: unknown) => error);
    expect(first).toBeInstanceOf(PluginRegistrationError);
    expect(second).toBe(first);
  });

  it("wraps a setup failure with the plugin name", async () => {
    const qspec = createQSpec().use(
      definePlugin({
        name: "broken",
        setup: () => {
          throw new Error("nope");
        },
      }),
    );
    await expect(qspec.ready()).rejects.toThrow(/broken/);
  });

  it("exposes registries to plugins and shares them across plugins", async () => {
    // The observation is hoisted out of the callback: an expect() that only
    // runs inside a setup asserts nothing at all if the drain stops early.
    let sawNoop: boolean | undefined;
    const qspec = createQSpec()
      .use(
        definePlugin({
          name: "a",
          setup: (api) => api.transforms.register("noop", { execute: (d) => d }),
        }),
      )
      .use(
        definePlugin({
          name: "b",
          setup: (api) => {
            sawNoop = api.transforms.has("noop");
          },
        }),
      );
    await qspec.ready();
    expect(sawNoop).toBe(true);
  });

  it("serializes setups when use() lands during an in-flight ready()", async () => {
    const order: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const qspec = createQSpec().use(
      definePlugin({
        name: "slow",
        setup: async () => {
          order.push("slow:start");
          await gate;
          order.push("slow:end");
        },
      }),
    );

    const first = qspec.ready();
    // Let the drain get as far as awaiting the first setup.
    await Promise.resolve();
    qspec.use(definePlugin({ name: "late", setup: () => void order.push("late") }));
    const second = qspec.ready();

    release();
    await Promise.all([first, second]);
    // "late" must not interleave with the setup that was already running.
    expect(order).toEqual(["slow:start", "slow:end", "late"]);
  });

  it("merges partial limits over the defaults", () => {
    const qspec = createQSpec({ limits: { maxRows: 10 } });
    expect(qspec.limits.maxRows).toBe(10);
    expect(qspec.limits.maxTransforms).toBe(64);
  });

  it("forwards lifecycle events to subscribers", async () => {
    const qspec = createQSpec();
    const handler = vi.fn();
    qspec.on("manifest:parse:end", handler);
    await qspec.prepare(minimal);
    expect(handler).toHaveBeenCalledWith({ kind: "Dataset", name: "example" });
  });

  it("disposes data sources that declare dispose", async () => {
    const dispose = vi.fn();
    const qspec = createQSpec().use(
      definePlugin({
        name: "src",
        setup: (api) =>
          api.sources.register("s", {
            execute: async () => ({ columns: [], rows: [] }),
            dispose,
          }),
      }),
    );
    await qspec.ready();
    await qspec.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("accepts a JSON string manifest", async () => {
    const prepared = await createQSpec().prepare(JSON.stringify(minimal));
    expect(prepared.name).toBe("example");
  });
});
