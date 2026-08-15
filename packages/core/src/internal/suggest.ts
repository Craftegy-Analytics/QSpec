/** Standard Levenshtein distance, two-row implementation. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  let current = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1);
      const deletion = (previous[j] as number) + 1;
      const insertion = (current[j - 1] as number) + 1;
      current[j] = Math.min(substitution, deletion, insertion);
    }
    [previous, current] = [current, previous];
  }

  return previous[b.length] as number;
}

/**
 * Returns the closest candidate, or undefined when none is close enough to be
 * a helpful guess. The threshold scales with input length so short names do not
 * produce nonsense suggestions. (SPEC.md §86)
 */
export function suggest(input: string, candidates: readonly string[]): string | undefined {
  if (candidates.length === 0) return undefined;
  const needle = input.toLowerCase();
  const threshold = Math.max(1, Math.floor(needle.length / 3) + 1);

  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;

  // Sorted so ties resolve identically regardless of candidate order.
  for (const candidate of [...candidates].sort()) {
    const distance = editDistance(needle, candidate.toLowerCase());
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }

  return bestDistance <= threshold ? best : undefined;
}
