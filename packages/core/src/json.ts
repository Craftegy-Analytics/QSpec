export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

/**
 * Keys that can corrupt an object's prototype chain when assigned onto an
 * ordinary object. Manifest parsing rejects these; dataset rows use
 * null-prototype objects instead, so a real column named `constructor` still
 * works. (SPEC.md §72.4)
 */
export const UNSAFE_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

export function isUnsafeKey(key: string): boolean {
  return UNSAFE_KEYS.has(key);
}

/** True for object literals and null-prototype objects; false for arrays and class instances. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

/** Creates a null-prototype object, the storage used for every dataset row. */
export function createRow<T = unknown>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

/**
 * Assigns a key on a null-prototype target. `defineProperty` is used because
 * plain assignment to `__proto__` is intercepted by the engine even on some
 * host objects; `defineProperty` always creates an own data property.
 */
export function setKey<T>(target: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

/** Own enumerable string keys in insertion order; empty for non-objects. */
export function ownKeys(value: unknown): string[] {
  if (typeof value !== "object" || value === null) return [];
  return Object.keys(value);
}

/** Recursively freezes a value. Used on prepared, cacheable structures. */
export function deepFreeze<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if (typeof value !== "object" || value === null) return value;
  // A `seen` set, not Object.isFrozen: a caller who shallow-freezes their own
  // object would otherwise skip the deep freeze entirely, voiding the
  // post-prepare immutability guarantee.
  if (seen.has(value)) return value;
  seen.add(value);
  Object.freeze(value);
  for (const key of Object.getOwnPropertyNames(value)) {
    deepFreeze((value as Record<string, unknown>)[key], seen);
  }
  return value;
}
