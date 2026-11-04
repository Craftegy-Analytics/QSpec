import { QSpecAbortError } from "../errors.js";

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new QSpecAbortError("QSpec execution was aborted before it began.", {
      cause: signal.reason,
    });
  }
}

/**
 * True when a rejection represents cancellation rather than a genuine failure.
 * Shared by every plugin boundary: an abort surfacing through a transform is
 * still a cancellation, not a transform defect.
 */
export function isAbortLike(error: unknown, signal: AbortSignal | undefined): boolean {
  return (
    signal?.aborted === true ||
    (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))
  );
}
