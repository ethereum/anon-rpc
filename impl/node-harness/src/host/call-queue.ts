// The §8 inbound-call discipline as a standalone structure: FIFO order, no
// drop, backpressure via one-at-a-time take(). Aborted takers are withdrawn
// without consuming an item; withdrawn items are never delivered.

type Waiter<T> = { resolve: (t: T) => void; reject: (e: unknown) => void };

export class CallQueue<T> {
  #items: T[] = [];
  #waiters: Waiter<T>[] = [];

  /** Resolve with the next item; an abort withdraws this taker (§8: it must not consume an item). */
  take(signal?: AbortSignal): Promise<T> {
    const next = this.#items.shift();
    if (next !== undefined) return Promise.resolve(next);
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

  /** Deliver to the oldest pending take(), else queue in arrival order. */
  push(item: T): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve(item);
    else this.#items.push(item);
  }

  /** Return an item to the FRONT of the queue (it was taken but not delivered). */
  pushFront(item: T): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve(item);
    else this.#items.unshift(item);
  }

  /** Withdraw a not-yet-delivered item. Returns false if it was already taken (or never queued). */
  remove(item: T): boolean {
    const i = this.#items.indexOf(item);
    if (i < 0) return false;
    this.#items.splice(i, 1);
    return true;
  }

  /** Drop all queued items and reject every pending take(). */
  rejectAll(err: unknown): void {
    this.#items.length = 0;
    for (const w of this.#waiters.splice(0)) w.reject(err);
  }
}
