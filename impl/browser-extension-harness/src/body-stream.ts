// §9 bodies as streams across the service-worker ↔ offscreen hop.
//
// Extension messaging cannot carry a ReadableStream (wire.ts), so a body
// crosses as chunks on the existing port, and is rebuilt as a ReadableStream
// on the far side. Both contexts run both halves: the service worker sends
// request bodies and receives responses, the offscreen document the reverse.
//
// The receiver drives. Its stream's pull() asks for exactly one chunk and
// waits for it, so the sender never reads ahead of the consumer: a slow reader
// in the service worker holds the worker's stream back, rather than chunks
// piling up in a context Chrome may kill for using too much memory. That is
// the whole point of streaming here — a buffered body already worked.
//
// Either end can stop early: the receiver's cancel() cancels the sender's
// source, and a source error errors the receiver's stream.

import { RpcError } from "@anon-rpc/harness-core";
import { fromB64, toB64, toWireError, type BodyChannel, type BodyMessage } from "./wire.js";

/**
 * Largest chunk put in one message. A worker can answer with one big
 * Uint8Array, which its stream yields whole; split here, so no single message
 * nears extension messaging's size limit and backpressure stays meaningful.
 */
export const MAX_CHUNK = 256 * 1024;

type Send = (msg: BodyMessage) => void;

/** The receiving half: a stream fed by "body.chunk" messages it asked for. */
export class BodyReceiver {
  readonly stream: ReadableStream<Uint8Array>;
  #controller!: ReadableStreamDefaultController<Uint8Array>;
  #waiting?: { resolve: () => void };
  #done = false;
  #onDone: () => void;

  constructor(ch: BodyChannel, callId: number, send: Send, onDone: () => void) {
    this.#onDone = onDone;
    this.stream = new ReadableStream<Uint8Array>(
      {
        start: (c) => {
          this.#controller = c;
        },
        // One request per pull, resolved when the answer arrives: the stream
        // will not pull again until then, so at most one chunk is in flight.
        pull: () =>
          new Promise<void>((resolve) => {
            this.#waiting = { resolve };
            send({ t: "body.pull", ch, callId });
          }),
        cancel: (reason) => {
          if (this.#finish()) send({ t: "body.cancel", ch, callId, reason: describe(reason) });
        },
      },
      // Read one chunk ahead, no more.
      { highWaterMark: 1 },
    );
  }

  /** A message the sender sent for this body. */
  deliver(msg: BodyMessage): void {
    if (this.#done) return;
    switch (msg.t) {
      case "body.chunk":
        this.#controller.enqueue(fromB64(msg.data) ?? new Uint8Array(0));
        break;
      case "body.end":
        this.#finish();
        this.#controller.close();
        break;
      case "body.error":
        this.fail(new RpcError(msg.error));
        return;
      default:
        return;
    }
    this.#release();
  }

  /** Error the stream from this side: an abort, or the port going away. */
  fail(err: unknown): void {
    if (!this.#finish()) return;
    this.#controller.error(err);
    this.#release();
  }

  #release(): void {
    const w = this.#waiting;
    this.#waiting = undefined;
    w?.resolve();
  }

  /** True the first time; the body is settled from then on. */
  #finish(): boolean {
    if (this.#done) return false;
    this.#done = true;
    this.#onDone();
    return true;
  }
}

/** The sending half: reads its source one chunk per "body.pull". */
export class BodySender {
  #reader: ReadableStreamDefaultReader<Uint8Array>;
  #ch: BodyChannel;
  #callId: number;
  #send: Send;
  #onDone: () => void;
  #rest?: Uint8Array; // the unsent tail of a chunk larger than MAX_CHUNK
  #done = false;

  constructor(ch: BodyChannel, callId: number, source: ReadableStream<Uint8Array>, send: Send, onDone: () => void) {
    this.#reader = source.getReader();
    this.#ch = ch;
    this.#callId = callId;
    this.#send = send;
    this.#onDone = onDone;
  }

  /** The receiver wants one more chunk. */
  async pull(): Promise<void> {
    if (this.#done) return;
    const id = { ch: this.#ch, callId: this.#callId };
    try {
      let bytes = this.#rest;
      this.#rest = undefined;
      while (!bytes) {
        const { done, value } = await this.#reader.read();
        if (done) {
          this.#finish();
          this.#send({ t: "body.end", ...id });
          return;
        }
        // Empty chunks carry nothing and would cost a round trip each.
        if (value.byteLength) bytes = value;
      }
      if (bytes.byteLength > MAX_CHUNK) {
        this.#rest = bytes.subarray(MAX_CHUNK);
        bytes = bytes.subarray(0, MAX_CHUNK);
      }
      if (this.#done) return; // cancelled while the read was pending
      this.#send({ t: "body.chunk", ...id, data: toB64(bytes)! });
    } catch (e) {
      if (!this.#finish()) return;
      this.#send({ t: "body.error", ...id, error: toWireError(e) });
    }
  }

  /** Stop: the receiver cancelled, or this side is going away. */
  cancel(reason?: unknown): void {
    if (!this.#finish()) return;
    void this.#reader.cancel(reason).catch(() => {});
  }

  #finish(): boolean {
    if (this.#done) return false;
    this.#done = true;
    this.#onDone();
    return true;
  }
}

/**
 * Both halves of every body this context is party to, keyed by direction and
 * call, with the message routing that goes with them.
 */
export class BodyStreams {
  #receivers = new Map<string, BodyReceiver>();
  #senders = new Map<string, BodySender>();
  #send: Send;

  constructor(send: Send) {
    this.#send = send;
  }

  receive(ch: BodyChannel, callId: number): BodyReceiver {
    const key = `${ch}:${callId}`;
    const r = new BodyReceiver(ch, callId, this.#send, () => this.#receivers.delete(key));
    this.#receivers.set(key, r);
    return r;
  }

  /** `onDone` runs once the body has ended, errored or been cancelled. */
  send(ch: BodyChannel, callId: number, source: ReadableStream<Uint8Array>, onDone?: () => void): BodySender {
    const key = `${ch}:${callId}`;
    const s = new BodySender(ch, callId, source, this.#send, () => {
      this.#senders.delete(key);
      onDone?.();
    });
    this.#senders.set(key, s);
    return s;
  }

  /** Route a body message; false if it is not one. */
  route(msg: { t?: string }): boolean {
    if (!msg?.t?.startsWith("body.")) return false;
    const m = msg as BodyMessage;
    const key = `${m.ch}:${m.callId}`;
    if (m.t === "body.pull") void this.#senders.get(key)?.pull();
    else if (m.t === "body.cancel") this.#senders.get(key)?.cancel(m.reason);
    else this.#receivers.get(key)?.deliver(m);
    return true;
  }

  /** Error one call's incoming body and stop its outgoing one (an abort). */
  abort(callId: number, err: unknown): void {
    for (const ch of ["request", "response"] as const) {
      this.#receivers.get(`${ch}:${callId}`)?.fail(err);
      this.#senders.get(`${ch}:${callId}`)?.cancel(err);
    }
  }

  /** Everything stops: the port is gone. */
  closeAll(err: unknown): void {
    for (const r of [...this.#receivers.values()]) r.fail(err);
    for (const s of [...this.#senders.values()]) s.cancel(err);
  }
}

function describe(reason: unknown): string | undefined {
  if (reason === undefined) return undefined;
  return reason instanceof Error ? reason.message : String(reason);
}
