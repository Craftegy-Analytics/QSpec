import { PluginRegistrationError } from "../errors.js";
import type { Registry } from "../types/registry.js";

/**
 * A Map is used rather than an object so that names like `constructor` and
 * `__proto__` behave as ordinary keys. (SPEC.md §72.4)
 */
export function createRegistry<T>(label: string): Registry<T> {
  const entries = new Map<string, T>();

  return {
    register(name, implementation) {
      if (name === "") {
        throw new PluginRegistrationError(`Cannot register a ${label} with an empty name.`);
      }
      if (entries.has(name)) {
        throw new PluginRegistrationError(
          `A ${label} named "${name}" is already registered. ` +
            `Use replace() if overriding it is intentional.`,
          { registry: label, name },
        );
      }
      entries.set(name, implementation);
    },

    replace(name, implementation) {
      if (name === "") {
        throw new PluginRegistrationError(`Cannot register a ${label} with an empty name.`);
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
  };
}
