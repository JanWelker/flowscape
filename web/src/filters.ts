import type { ConnState } from "./ws-client";
import type { Status } from "./protocol";
import { machineColor, namespaceColor } from "./theme";

export type GroupBy = "namespace" | "machine";

export interface Filters {
  groupBy: GroupBy;
  machines: Set<string>; // hidden machines
  namespaces: Set<string>; // disabled namespaces
  verdicts: [boolean, boolean, boolean, boolean];
  protocols: Set<string>; // disabled protocols
  hideReserved: boolean;
  windowSec: number;
  paused: boolean;
}

const PROTOCOLS = ["TCP", "UDP", "ICMP"];
const VERDICTS = ["forwarded", "dropped", "audit", "error"];

/** Left-hand controls and the status pill. */
export class FiltersPanel {
  readonly filters: Filters;
  private readonly root: HTMLElement;
  private readonly chips = new Map<string, HTMLButtonElement>();
  private readonly machineChips = new Map<string, HTMLButtonElement>();
  private readonly nsBox: HTMLElement;
  private readonly machineBox: HTMLElement;
  private readonly pill: HTMLElement;
  private readonly pauseBtn: HTMLButtonElement;
  private readonly windowLabel: HTMLElement;
  private readonly help: HTMLElement;
  onChange: () => void = () => {};
  onFit: () => void = () => {};
  onMachineHover: (name: string | null) => void = () => {};

  constructor(root: HTMLElement, windowSec: number) {
    this.root = root;
    this.filters = {
      groupBy: "namespace",
      machines: new Set(),
      namespaces: new Set(),
      verdicts: [true, true, true, true],
      protocols: new Set(),
      hideReserved: false,
      windowSec,
      paused: false,
    };
    root.innerHTML = `
      <div class="brand">
        <span class="logo"></span><h1>Flowscape</h1>
        <button class="collapse" id="collapse" title="collapse (h)" aria-label="collapse controls">‹</button>
      </div>
      <div class="pill" id="pill"><span class="dot"></span><span class="text">connecting</span></div>
      <div class="body">
      <section>
        <h2>Group by</h2>
        <div class="segmented" id="groupby">
          <button data-mode="namespace" class="on">namespace</button>
          <button data-mode="machine">node</button>
        </div>
      </section>
      <section><h2>Namespaces</h2><div class="chips" id="ns"></div></section>
      <section><h2>Nodes</h2><div class="chips" id="machines"></div></section>
      <section><h2>Verdicts</h2><div class="chips" id="verdicts"></div></section>
      <section><h2>Protocols</h2><div class="chips" id="protocols"></div></section>
      <section class="row">
        <label><input type="checkbox" id="reserved"> hide world, host, apiserver</label>
      </section>
      <section>
        <h2>Window <span id="window-label"></span></h2>
        <input type="range" id="window" min="10" max="300" step="10">
      </section>
      <section class="row buttons">
        <button id="pause" title="space">pause</button>
        <button id="fit" title="f">fit view</button>
      </section>
      <div class="help" id="help">drag to orbit · scroll to zoom · click a node or arc</div>
      </div>
    `;
    const collapse = root.querySelector<HTMLButtonElement>("#collapse")!;
    collapse.onclick = () => this.setCollapsed(!root.classList.contains("collapsed"));
    let collapsed = window.innerWidth < 720;
    try {
      const saved = localStorage.getItem("flowscape.controls");
      if (saved !== null) collapsed = saved === "collapsed";
    } catch {
      // storage unavailable: keep the default
    }
    this.setCollapsed(collapsed, false);
    this.nsBox = root.querySelector("#ns")!;
    this.machineBox = root.querySelector("#machines")!;
    root.querySelectorAll<HTMLButtonElement>("#groupby button").forEach((b) => {
      b.onclick = () => {
        this.filters.groupBy = b.dataset.mode as GroupBy;
        root.querySelectorAll("#groupby button").forEach((o) => o.classList.toggle("on", o === b));
        this.onChange();
      };
    });
    this.pill = root.querySelector("#pill")!;
    this.pauseBtn = root.querySelector("#pause")!;
    this.windowLabel = root.querySelector("#window-label")!;
    this.help = root.querySelector("#help")!;
    const vBox = root.querySelector("#verdicts")!;
    VERDICTS.forEach((v, i) => {
      const b = document.createElement("button");
      b.className = `chip on verdict-${i}`;
      b.textContent = v;
      b.onclick = () => {
        this.filters.verdicts[i] = !this.filters.verdicts[i];
        b.classList.toggle("on", this.filters.verdicts[i]);
        this.onChange();
      };
      vBox.appendChild(b);
    });
    const pBox = root.querySelector("#protocols")!;
    for (const p of PROTOCOLS) {
      const b = document.createElement("button");
      b.className = "chip on";
      b.textContent = p;
      b.onclick = () => {
        if (this.filters.protocols.has(p)) this.filters.protocols.delete(p);
        else this.filters.protocols.add(p);
        b.classList.toggle("on", !this.filters.protocols.has(p));
        this.onChange();
      };
      pBox.appendChild(b);
    }
    const reserved = root.querySelector<HTMLInputElement>("#reserved")!;
    reserved.onchange = () => {
      this.filters.hideReserved = reserved.checked;
      this.onChange();
    };
    const win = root.querySelector<HTMLInputElement>("#window")!;
    win.value = String(windowSec);
    this.windowLabel.textContent = `${windowSec}s`;
    win.oninput = () => {
      this.filters.windowSec = Number(win.value);
      this.windowLabel.textContent = `${win.value}s`;
      this.onChange();
    };
    this.pauseBtn.onclick = () => this.togglePause();
    root.querySelector<HTMLButtonElement>("#fit")!.onclick = () => this.onFit();
    window.addEventListener("keydown", (ev) => {
      if (ev.target instanceof HTMLInputElement) return;
      if (ev.code === "Space") {
        ev.preventDefault();
        this.togglePause();
      } else if (ev.key === "f") this.onFit();
      else if (ev.key === "h") this.setCollapsed(!this.root.classList.contains("collapsed"));
    });
  }

  /** Fold the controls down to the brand and the status pill. */
  setCollapsed(collapsed: boolean, remember = true): void {
    this.root.classList.toggle("collapsed", collapsed);
    const b = this.root.querySelector<HTMLButtonElement>("#collapse")!;
    b.textContent = collapsed ? "›" : "‹";
    b.title = collapsed ? "expand (h)" : "collapse (h)";
    b.setAttribute("aria-label", collapsed ? "expand controls" : "collapse controls");
    if (!remember) return;
    try {
      localStorage.setItem("flowscape.controls", collapsed ? "collapsed" : "open");
    } catch {
      // storage unavailable: nothing to remember
    }
  }

  setMaxWindow(retention: number): void {
    const win = this.root.querySelector<HTMLInputElement>("#window")!;
    win.max = String(retention);
  }

  togglePause(): void {
    this.filters.paused = !this.filters.paused;
    this.pauseBtn.textContent = this.filters.paused ? "resume" : "pause";
    this.pauseBtn.classList.toggle("active", this.filters.paused);
    this.onChange();
  }

  /** Keep one chip per namespace currently in the graph. */
  syncNamespaces(names: Iterable<string>): void {
    const want = new Set(names);
    for (const [ns, chip] of this.chips) {
      if (!want.has(ns)) {
        chip.remove();
        this.chips.delete(ns);
      }
    }
    for (const ns of [...want].sort()) {
      if (this.chips.has(ns)) continue;
      const b = document.createElement("button");
      b.className = "chip on ns";
      b.textContent = ns;
      b.style.setProperty("--ns", `#${namespaceColor(ns).getHexString()}`);
      b.onclick = (ev) => {
        if (ev.altKey || ev.metaKey) {
          // Solo this namespace.
          const only =
            this.filters.namespaces.size === this.chips.size - 1 &&
            !this.filters.namespaces.has(ns);
          this.filters.namespaces.clear();
          if (!only)
            for (const other of this.chips.keys())
              if (other !== ns) this.filters.namespaces.add(other);
        } else if (this.filters.namespaces.has(ns)) this.filters.namespaces.delete(ns);
        else this.filters.namespaces.add(ns);
        for (const [k, c] of this.chips) c.classList.toggle("on", !this.filters.namespaces.has(k));
        this.onChange();
      };
      this.chips.set(ns, b);
      // Keep alphabetical order.
      const after = [...this.chips.keys()].sort().indexOf(ns);
      this.nsBox.insertBefore(b, this.nsBox.children[after] ?? null);
    }
  }

  /** One chip per machine seen; unavailable ones carry a red dot. */
  syncMachines(names: Iterable<string>, unavailable: string[]): void {
    const want = new Set(names);
    const down = new Set(unavailable);
    for (const [m, chip] of this.machineChips) {
      if (!want.has(m)) {
        chip.remove();
        this.machineChips.delete(m);
      }
    }
    for (const m of [...want].sort()) {
      let b = this.machineChips.get(m);
      if (!b) {
        b = document.createElement("button");
        b.className = "chip on machine";
        b.textContent = m;
        b.style.setProperty("--ns", `#${machineColor(m).getHexString()}`);
        const name = m;
        b.onclick = () => {
          if (this.filters.machines.has(name)) this.filters.machines.delete(name);
          else this.filters.machines.add(name);
          b!.classList.toggle("on", !this.filters.machines.has(name));
          this.onChange();
        };
        b.onpointerenter = () => this.onMachineHover(name);
        b.onpointerleave = () => this.onMachineHover(null);
        this.machineChips.set(m, b);
        const after = [...this.machineChips.keys()].sort().indexOf(m);
        this.machineBox.insertBefore(b, this.machineBox.children[after] ?? null);
      }
      b.classList.toggle("down", down.has(m));
      b.title = down.has(m)
        ? `${m}: Hubble Relay cannot reach this node`
        : `${m}: click to hide, hover to highlight`;
    }
  }

  setStatus(conn: ConnState, s: Status | null, particles: number): void {
    const dot = this.pill.querySelector(".dot")!;
    const text = this.pill.querySelector(".text")!;
    let cls = "ok";
    let msg: string;
    if (conn !== "open") {
      cls = "bad";
      msg = conn === "connecting" ? "connecting…" : "disconnected, retrying";
    } else if (!s) {
      cls = "warn";
      msg = "waiting for data";
    } else {
      const parts = [`${s.source}`];
      if (s.relay === "reconnecting") {
        cls = "bad";
        parts.push("relay down");
      } else if (s.unavailable && s.unavailable.length > 0) {
        cls = "warn";
        parts.push(
          `${s.unavailable.length} node${s.unavailable.length > 1 ? "s" : ""} unavailable`,
        );
      }
      parts.push(`${s.flows_s.toFixed(0)} flows/s`);
      if (this.filters.paused) parts.push("paused");
      msg = parts.join(" · ");
      this.pill.title = s.unavailable?.length
        ? `unavailable: ${s.unavailable.join(", ")}`
        : `${particles} sparks`;
    }
    dot.className = `dot ${cls}`;
    text.textContent = msg;
  }

  setHelp(text: string): void {
    this.help.textContent = text;
  }
}
