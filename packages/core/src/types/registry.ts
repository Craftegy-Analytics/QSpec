/** Generic capability registry contract. (SPEC.md §51) */
export interface Registry<T> {
  /** Registers an implementation. Throws if `name` is already registered. */
  register(name: string, implementation: T): void;
  /** Replaces an implementation, whether or not one exists. Explicit by design. */
  replace(name: string, implementation: T): void;
  get(name: string): T | undefined;
  has(name: string): boolean;
  /** Registered names, sorted, for deterministic diagnostics. */
  list(): readonly string[];
}
