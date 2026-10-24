// §13.1 log retention: the buffer `acceptLog()` pulls from.
//
// Deliberately NOT CallQueue. That queue implements §8's call discipline,
// whose whole point is that nothing is ever dropped — a dropped call is a
// caller waiting forever. This one is the opposite by design: logs are
// best-effort diagnostics, a host may never collect them at all, and a buffer
// that grew without bound to hold them would turn a chatty worker into a
// memory leak. So it has a cap, and the cap means loss.
//
// Old entries go first. A worker that has produced 10,000 lines since anyone
// looked is nearly always more interesting at the end than at the start, and
// the start is what a host that was reading all along has already seen.

export type Waiter<T> = { resolve: (t: T) => void; reject: (e: unknown) => void };

export class LogQueue<T> {
  #items: T[] = [];
  #waiters: Waiter<T>[] = [];
  #closed?: { err: unknown };
  readonly #max: number;

  constructor(max: number) {
    this.#max = max;
  }

  /** How many entries have been dropped for want of room. */
  dropped = 0;

  /**
   * Resolve with the next entry, waiting if there is none.
   *
   * §13.1: an abort withdraws the caller without consuming an entry, and a
   * closed queue still yields whatever it retained before rejecting — the
   * entries explaining a failure are the ones most worth reading.
   */
  take(signal?: AbortSignal): Promise<T> {
    const next = this.#items.shift();
    if (next !== undefined) return Promise.resolve(next);
    if (this.#closed) return Promise.reject(this.#closed.err);
    return new Promise<T>((resolve, reject) => {
      const waiter: Waiter<T> = {
        resolve: (item) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(item);
        },
        reject: (e) => {
          signal?.removeEventListener("abort", onAbort);
          reject(e);
        },
      };
      const onAbort = () => {
        const i = this.#waiters.indexOf(waiter);
        if (i >= 0) this.#waiters.splice(i, 1);
        reject(signal?.reason ?? new DOMException("aborted", "AbortError"));
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#waiters.push(waiter);
    });
  }

  /** Deliver to the oldest waiter, else retain — dropping the oldest if full. */
  push(item: T): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) return waiter.resolve(item);
    this.#items.push(item);
    while (this.#items.length > this.#max) {
      this.#items.shift();
      this.dropped++;
    }
  }

  /**
   * Stop accepting entries; retained ones stay readable, and `take()` rejects
   * once they run out.
   *
   * Pending waiters reject immediately: there is nothing left to wait for, and
   * a host looping on `acceptLog()` would otherwise hang on a dead worker.
   */
  close(err: unknown): void {
    if (this.#closed) return;
    this.#closed = { err };
    for (const w of this.#waiters.splice(0)) w.reject(err);
  }

  /** Retained, undelivered entries. */
  get size(): number {
    return this.#items.length;
  }
}
