import { describe, expect, it, vi } from "vitest";
import { createHooks } from "./hooks.js";

describe("createHooks", () => {
  it("delivers a payload to a subscriber", () => {
    const hooks = createHooks();
    const handler = vi.fn();
    hooks.on("manifest:parse:end", handler);
    hooks.emit("manifest:parse:end", { kind: "Chart", name: "x" });
    expect(handler).toHaveBeenCalledWith({ kind: "Chart", name: "x" });
  });

  it("supports multiple subscribers in registration order", () => {
    const hooks = createHooks();
    const calls: number[] = [];
    hooks.on("validation:start", () => calls.push(1));
    hooks.on("validation:start", () => calls.push(2));
    hooks.emit("validation:start", { stage: "manifest" });
    expect(calls).toEqual([1, 2]);
  });

  it("unsubscribes via the returned function", () => {
    const hooks = createHooks();
    const handler = vi.fn();
    const off = hooks.on("validation:start", handler);
    off();
    hooks.emit("validation:start", { stage: "manifest" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("is a no-op for events with no subscribers", () => {
    const hooks = createHooks();
    expect(() => hooks.emit("validation:start", { stage: "manifest" })).not.toThrow();
  });

  it("isolates a throwing handler so execution is never broken by observability", () => {
    const onHandlerError = vi.fn();
    const hooks = createHooks(onHandlerError);
    const second = vi.fn();
    hooks.on("validation:start", () => {
      throw new Error("handler exploded");
    });
    hooks.on("validation:start", second);
    expect(() => hooks.emit("validation:start", { stage: "manifest" })).not.toThrow();
    expect(second).toHaveBeenCalled();
    expect(onHandlerError).toHaveBeenCalledOnce();
  });

  it("still calls a handler that an earlier handler unsubscribed mid-emit", () => {
    // This is what the [...set] snapshot actually buys. Self-unsubscription
    // alone would pass without the copy, because JS Set iteration already
    // tolerates deleting the current entry — so a self-unsubscribe test proves
    // nothing about the copy.
    const hooks = createHooks();
    const second = vi.fn();
    let off: () => void = () => {};
    hooks.on("validation:start", () => off());
    off = hooks.on("validation:start", second);
    hooks.emit("validation:start", { stage: "manifest" });
    expect(second).toHaveBeenCalledOnce();
  });

  it("keeps running later handlers when the error reporter itself throws", () => {
    const second = vi.fn();
    const hooks = createHooks(() => {
      throw new Error("reporter exploded");
    });
    hooks.on("validation:start", () => {
      throw new Error("handler exploded");
    });
    hooks.on("validation:start", second);
    expect(() => hooks.emit("validation:start", { stage: "manifest" })).not.toThrow();
    expect(second).toHaveBeenCalledOnce();
  });
});
