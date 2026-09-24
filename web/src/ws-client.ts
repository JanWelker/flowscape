import type { Message } from "./protocol";

export type ConnState = "connecting" | "open" | "closed";

const MAX_BUFFER = 600; // ~60 s of ticks while paused

/** Reconnecting WebSocket with a pause buffer. */
export class WSClient {
  private ws: WebSocket | null = null;
  private backoff = 1000;
  private buffer: Message[] = [];
  private overflowed = false;
  private closed = false;
  paused = false;

  constructor(
    private readonly url: string,
    private readonly onMessage: (m: Message) => void,
    private readonly onState: (s: ConnState) => void,
  ) {}

  connect(): void {
    this.closed = false;
    this.onState("connecting");
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 1000;
      this.onState("open");
    };
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data as string) as Message;
      if (this.paused && m.t === "tick") {
        if (this.buffer.length >= MAX_BUFFER) {
          this.overflowed = true;
          return;
        }
        this.buffer.push(m);
        return;
      }
      this.onMessage(m);
    };
    ws.onclose = () => {
      this.ws = null;
      this.onState("closed");
      if (this.closed) return;
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 10_000);
    };
    ws.onerror = () => ws.close();
  }

  setPaused(p: boolean): void {
    if (this.paused === p) return;
    this.paused = p;
    if (p) return;
    if (this.overflowed) {
      // Too far behind: a fresh snapshot is cheaper than replaying.
      this.buffer = [];
      this.overflowed = false;
      this.ws?.close();
      return;
    }
    const b = this.buffer;
    this.buffer = [];
    for (const m of b) this.onMessage(m);
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }
}
