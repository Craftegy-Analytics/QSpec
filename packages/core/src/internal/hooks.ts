import type {
  HookRegistry,
  QSpecEventHandler,
  QSpecEventMap,
  QSpecEventName,
} from "../types/events.js";

/**
 * Observers only: handlers receive payloads and cannot alter execution.
 * A handler that throws is contained, because telemetry must never be able to
 * break a query. (SPEC.md §68, §69)
 *
 * Pre-populated so `on`/`emit` only ever READ at a generic key, which is
 * sound. Writing at a generic key is not (TS2322: E could be instantiated
 * with any subtype of the constraint, collapsing the target to an
 * intersection of every value type) — that is why a lazily-filled
 * `Partial<>` cannot work here. See task-14-report.md for the exact
 * compiler output from that attempt.
 *
 * Because this type is not `Partial`, omitting any event is a COMPILE ERROR
 * — adding a new entry to `QSpecEventMap` forces adding its `Set` here, so
 * the two cannot drift apart.
 */
export function createHooks(onHandlerError?: (error: unknown) => void): HookRegistry {
  const listeners: { [K in QSpecEventName]: Set<QSpecEventHandler<K>> } = {
    "manifest:parse:start": new Set(),
    "manifest:parse:end": new Set(),
    "validation:start": new Set(),
    "validation:end": new Set(),
    "query:compile:start": new Set(),
    "query:compile:end": new Set(),
    "query:execute:start": new Set(),
    "query:execute:end": new Set(),
    "dataset:normalize:duplicate-column": new Set(),
    "transform:start": new Set(),
    "transform:end": new Set(),
    "execution:complete": new Set(),
    "execution:error": new Set(),
  };

  return {
    on(event, handler) {
      const set = listeners[event];
      set.add(handler);
      return () => {
        set.delete(handler);
      };
    },

    emit<E extends QSpecEventName>(event: E, payload: QSpecEventMap[E]) {
      const set = listeners[event];
      if (set.size === 0) return;
      // Snapshot: a handler may unsubscribe itself — or another pending
      // handler — mid-emit. Everyone registered when the event fired still runs.
      for (const handler of [...set]) {
        try {
          handler(payload);
        } catch (error) {
          try {
            onHandlerError?.(error);
          } catch {
            // The error reporter failed too. There is nowhere left to report
            // this, and telemetry must never break a query, so it is dropped.
          }
        }
      }
    },
  };
}
