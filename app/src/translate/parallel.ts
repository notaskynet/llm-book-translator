// Port of iter_ordered_concurrent (src/core/common/parallel.py).
//
// Keeps up to `workers` requests in flight while handing results back strictly in
// input order, so the caller can commit them and advance a checkpoint contiguously.
// With one worker the next item only starts after the caller has processed the
// previous result, which is identical to a plain sequential loop (cross-chunk
// context chaining relies on that).

export type OrderedResult<T, R> = { item: T; value: R; error?: undefined } | { item: T; value?: undefined; error: unknown };

/**
 * @param worker receives a signal that fires when the consumer stops iterating
 *   early (`break`/`return`), so abandoned requests are cancelled instead of
 *   running — and being billed — in the background.
 * @param shouldInterrupt when true, no new work is launched; in-flight items
 *   still finish and are yielded.
 */
export async function* iterOrderedConcurrent<T, R>(
  items: readonly T[],
  workers: number,
  worker: (item: T, signal: AbortSignal) => Promise<R>,
  shouldInterrupt?: () => boolean,
): AsyncGenerator<OrderedResult<T, R>> {
  const limit = Math.max(1, Math.trunc(workers));
  const controller = new AbortController();
  const inFlight = new Map<number, Promise<number>>();
  const results = new Map<number, { value: R } | { error: unknown }>();
  let nextLaunch = 0;
  let nextYield = 0;

  const launch = (pos: number) => {
    inFlight.set(
      pos,
      worker(items[pos], controller.signal).then(
        (value) => { results.set(pos, { value }); return pos; },
        (error) => { results.set(pos, { error }); return pos; },
      ),
    );
  };

  try {
    while (nextYield < items.length) {
      while (nextLaunch < items.length && inFlight.size < limit && !shouldInterrupt?.()) {
        launch(nextLaunch++);
      }
      if (!inFlight.size) break; // interrupted or done: nothing left that can complete

      inFlight.delete(await Promise.race(inFlight.values()));

      while (results.has(nextYield)) {
        const r = results.get(nextYield)!;
        results.delete(nextYield);
        const item = items[nextYield++];
        yield 'error' in r ? { item, error: r.error } : { item, value: r.value };
      }
    }
  } finally {
    controller.abort();
    await Promise.allSettled(inFlight.values());
  }
}
