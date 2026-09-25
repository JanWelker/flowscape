import type { Message } from "./protocol";
import type { ConnState, Transport } from "./ws-client";

// The Go demo source and graph compiled to WebAssembly; wasm_exec.js is
// Go's runtime shim and defines the Go class.
declare class Go {
  importObject: WebAssembly.Imports;
  run(instance: WebAssembly.Instance): Promise<void>;
}
declare global {
  interface Window {
    flowscapeDemoStart?: (cb: (json: string) => void, scale?: number, speed?: number) => void;
  }
}

const MAX_BUFFER = 600;

/** Runs the demo in the browser: no server, the same messages. */
export class DemoTransport implements Transport {
  paused = false;
  private buffer: Message[] = [];

  constructor(
    private readonly base: string,
    private readonly onMessage: (m: Message) => void,
    private readonly onState: (s: ConnState) => void,
    private readonly scale = 1,
    private readonly speed = 1,
  ) {}

  connect(): void {
    this.onState("connecting");
    void this.start().catch((err: unknown) => {
      console.error("demo failed to start", err);
      this.onState("closed");
    });
  }

  private async start(): Promise<void> {
    await loadScript(`${this.base}wasm_exec.js`);
    const go = new Go();
    const url = `${this.base}flowscape-demo.wasm`;
    let result: WebAssembly.WebAssemblyInstantiatedSource;
    try {
      result = await WebAssembly.instantiateStreaming(fetch(url), go.importObject);
    } catch {
      // A host that serves .wasm with the wrong content type.
      const bytes = await (await fetch(url)).arrayBuffer();
      result = await WebAssembly.instantiate(bytes, go.importObject);
    }
    void go.run(result.instance);
    if (!window.flowscapeDemoStart) throw new Error("wasm did not register flowscapeDemoStart");
    window.flowscapeDemoStart(
      (json) => {
        const m = JSON.parse(json) as Message;
        if (this.paused && m.t === "tick") {
          if (this.buffer.length < MAX_BUFFER) this.buffer.push(m);
          return;
        }
        this.onMessage(m);
      },
      this.scale,
      this.speed,
    );
    this.onState("open");
  }

  setPaused(p: boolean): void {
    if (this.paused === p) return;
    this.paused = p;
    if (p) return;
    const b = this.buffer;
    this.buffer = [];
    for (const m of b) this.onMessage(m);
  }

  close(): void {
    // The module lives as long as the page.
  }
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.appendChild(s);
  });
}
