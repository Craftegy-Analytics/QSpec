import type { DatasetRow } from "@qspecs/core";

/**
 * Dataset rows are null-prototype objects so a column named `constructor` or
 * `__proto__` is safe to hold. Every row this package creates must follow that
 * discipline — a plain `{}` would reintroduce the prototype hazard core went to
 * some trouble to remove.
 */
export function emptyRow(): DatasetRow {
  return Object.create(null) as DatasetRow;
}

export function setCell(row: DatasetRow, key: string, value: unknown): void {
  Object.defineProperty(row, key, { value, writable: true, enumerable: true, configurable: true });
}
