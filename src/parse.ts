import { NetherProtocolError } from "./errors.js";
import type { SandboxEvent, SandboxInfo, SandboxStats } from "./types.js";

/** Parse `key=value` report lines (__info__, __stats__ bodies). */
export function parseKeyValues(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

export function parseInfo(text: string): SandboxInfo {
  const raw = parseKeyValues(text);
  const pv = Number.parseInt(raw.proto_version ?? "", 10);
  const info: SandboxInfo = {
    protoVersion: Number.isNaN(pv) ? 0 : pv,
    raw,
  };
  if (raw.backend !== undefined) info.backend = raw.backend;
  return info;
}

function num(raw: Record<string, string>, key: string): number | undefined {
  const v = raw[key];
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Map a __stats__ body onto SandboxStats, keeping unknown fields in raw. */
export function parseStats(text: string): SandboxStats {
  const raw = parseKeyValues(text);
  const stats: SandboxStats = {
    uptimeMs: num(raw, "uptime_ms") ?? 0,
    raw,
  };
  const map: Array<[keyof SandboxStats, string]> = [
    ["cpuMs", "cpu_ms"],
    ["ramMb", "ram_mb"],
    ["memPeakMb", "mem_peak_mb"],
    ["cpus", "cpus"],
    ["commands", "commands"],
    ["bytesIn", "bytes_in"],
    ["bytesOut", "bytes_out"],
    ["netTx", "net_tx_bytes"],
    ["netRx", "net_rx_bytes"],
    ["netBlocked", "net_blocked"],
    ["dataConns", "data_conns"],
    ["dataMs", "data_ms"],
  ];
  for (const [field, key] of map) {
    const v = num(raw, key);
    if (v !== undefined) (stats as unknown as Record<string, unknown>)[field] = v;
  }
  return stats;
}

/**
 * Split an __cmdlog__/__netlog__ reply into its record lines (header first).
 */
export function parseLogLines(body: string): string[] {
  return body.split("\n").filter((l) => l.length > 0);
}

export interface EventsReply {
  /** The journal's current lifetime seq; pass it back as the next poll's cursor. */
  cursor: number;
  records: SandboxEvent[];
}

/**
 * Parse an `__events__ [seq]` reply: `EVENTS <cur>\n` then zero or more
 * `<seq> <ms> <KIND> <text>\n` records, oldest first (audit.zig:76,83). A seq
 * jump between consecutive records means ring-aged records were lost (CAP 512).
 */
export function parseEvents(body: string): EventsReply {
  const lines = body.split("\n");
  const header = lines[0] ?? "";
  if (!header.startsWith("EVENTS ")) {
    throw new NetherProtocolError(
      `__events__: unexpected header ${JSON.stringify(header.slice(0, 40))}`,
    );
  }
  const cursor = Number.parseInt(header.slice("EVENTS ".length), 10);
  if (Number.isNaN(cursor)) throw new NetherProtocolError("__events__: unparseable header cursor");
  const records: SandboxEvent[] = [];
  for (const line of lines.slice(1)) {
    if (line.length === 0) continue;
    const m = line.match(/^(\d+) (\d+) (\S+) ?(.*)$/);
    if (m === null) continue; // tolerate unknown record shapes rather than dropping the batch
    records.push({
      seq: Number(m[1]),
      ms: Number(m[2]),
      kind: m[3] as SandboxEvent["kind"],
      text: m[4] ?? "",
    });
  }
  return { cursor, records };
}

export interface ScreenDiff {
  rows: number;
  cols: number;
  /** [rowIndex, text] for each CHANGED live row; empty text = cleared row. */
  changed: Array<[number, string]>;
}

/**
 * Parse a `__screendiff__` reply: `SCREEN <rows>x<cols>\n` then `<idx> <text>\n`
 * per changed row (text may be empty), terminated by a blank line
 * (render.zig:88,97,102). The first reply on a connection is a full screen.
 */
export function parseScreenDiff(body: string): ScreenDiff {
  const lines = body.split("\n");
  const header = lines[0] ?? "";
  const hm = header.match(/^SCREEN (\d+)x(\d+)$/);
  if (hm === null) {
    throw new NetherProtocolError(
      `__screendiff__: unexpected header ${JSON.stringify(header.slice(0, 40))}`,
    );
  }
  const changed: Array<[number, string]> = [];
  for (const line of lines.slice(1)) {
    if (line.length === 0) break; // blank line terminates the reply
    const sp = line.indexOf(" ");
    if (sp < 0) {
      const idx = Number.parseInt(line, 10);
      if (!Number.isNaN(idx)) changed.push([idx, ""]);
      continue;
    }
    const idx = Number.parseInt(line.slice(0, sp), 10);
    if (!Number.isNaN(idx)) changed.push([idx, line.slice(sp + 1)]);
  }
  return { rows: Number(hm[1]), cols: Number(hm[2]), changed };
}
