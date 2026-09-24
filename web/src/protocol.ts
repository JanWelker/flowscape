// Mirrors internal/protocol/protocol.go. Change both together.

export const VERDICT_FORWARDED = 0;
export const VERDICT_DROPPED = 1;
export const VERDICT_AUDIT = 2;
export const VERDICT_ERROR = 3;
export type Verdict = 0 | 1 | 2 | 3;

export interface Hello {
  t: "hello";
  version: string;
  source: string;
  retention_s: number;
  window_s: number;
  tick_ms: number;
  server_time: number;
}

export interface WireNode {
  id: string;
  ns: string;
  kind: string;
  name: string;
  fqdn?: string;
  labels?: Record<string, string>;
  first: number;
  last: number;
}

/** [unixSec, forwarded, dropped, audit, error] */
export type Bucket = [number, number, number, number, number];

export interface L7 {
  http?: Record<string, number>;
  dns?: Record<string, number>;
  status?: number;
}

export interface WireEdge {
  id: string;
  src: string;
  dst: string;
  proto: string;
  port: number;
  f: number;
  d: number;
  a: number;
  e: number;
  last: number;
  latency_ms?: number;
  l7?: L7;
  drops?: Record<string, number>;
  buckets?: Bucket[];
}

export interface Snapshot {
  t: "snapshot";
  ts: number;
  nodes: WireNode[];
  edges: WireEdge[];
}

export interface Spark {
  e: string;
  v: Verdict;
}

export interface Status {
  source: string;
  relay: "connected" | "reconnecting" | "n/a";
  unavailable?: string[];
  flows_s: number;
  clients: number;
}

export interface Tick {
  t: "tick";
  ts: number;
  nodes?: WireNode[];
  edges?: WireEdge[];
  gone: { nodes?: string[]; edges?: string[] };
  sparks?: Spark[];
  status: Status;
}

export type Message = Hello | Snapshot | Tick;
