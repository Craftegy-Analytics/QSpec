import { PluginRegistrationError } from "../errors.js";
import type { Registry } from "../types/registry.js";

/** One registered name and its implementation, as `OrderedRegistry.entries()` yields it. */
export interface RegistryEntry<T> {
  readonly name: string;
  readonly implementation: T;
}

/**
 * A `Registry<T>` that can also be read in registration order. Internal: the public `Registry<T>`
 * interface does not change, so `entries()` is not part of any type a plugin is handed. The object
 * a plugin receives as `api.policies` does carry it at runtime, though, so a plugin that casts its
 * way to it gets a frozen snapshot: it can read the order, never change it. Execution policies are
 * the one capability whose order matters (policy design 3.1).
 */
export interface OrderedRegistry<T> extends Registry<T> {
  /**
   * Every entry in registration order, as a frozen snapshot. `Map` iterates in insertion order
   * and `Map.set` on an existing key keeps that key's position, so `replace()` on a registered
   * name swaps the implementation in place, and `replace()` on a new name appends it last.
   */
  entries(): readonly RegistryEntry<T>[];
}

/** "an execution policy", "a transform": the article the label needs. */
function article(label: string): string {
  return /^[aeiou]/i.test(label) ? "an" : "a";
}

/**
 * A Map is used rather than an object so that names like `constructor` and
 * `__proto__` behave as ordinary keys. (SPEC.md §72.4)
 */
export function createRegistry<T>(label: string): OrderedRegistry<T> {
  const entries = new Map<string, T>();
  const a = article(label);

  return {
    register(name, implementation) {
      if (name === "") {
        throw new PluginRegistrationError(`Cannot register ${a} ${label} with an empty name.`);
      }
      if (entries.has(name)) {
        throw new PluginRegistrationError(
          `${a === "an" ? "An" : "A"} ${label} named "${name}" is already registered. ` +
            `Use replace() if overriding it is intentional.`,
          { registry: label, name },
        );
      }
      entries.set(name, implementation);
    },

    replace(name, implementation) {
      if (name === "") {
        throw new PluginRegistrationError(`Cannot register ${a} ${label} with an empty name.`);
      }
      entries.set(name, implementation);
    },

    get(name) {
      return entries.get(name);
    },

    has(name) {
      return entries.has(name);
    },

    list() {
      return [...entries.keys()].sort();
    },

    entries() {
      return Object.freeze(
        [...entries].map(([name, implementation]) => Object.freeze({ name, implementation })),
      );
    },
  };
}
