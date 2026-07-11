/**
 * Wire-level value types the SDK produces from nether replies. These are
 * inlined (not imported from any host application) so the package stands alone.
 * They mirror the shape nether reports over the control protocol; unknown /
 * unmodeled fields are always preserved verbatim in `raw`.
 */

/** Parsed `__info__` report: static capabilities and limits of a sandbox. */
export interface SandboxInfo {
  /** Negotiated control-protocol version (1 or 2). 0 if an old nether omits it. */
  protoVersion: number;
  /** Backend identifier (`hvf`, `kvm`, `supervisor`, `stub`, ...). */
  backend?: string;
  /** Every `key=value` line from the report, verbatim (proto_version, caps, ...). */
  raw: Record<string, string>;
}

/** Parsed `__stats__` report: live usage counters. */
export interface SandboxStats {
  /** Wall-clock uptime in milliseconds (`uptime_ms`). */
  uptimeMs: number;
  cpuMs?: number;
  ramMb?: number;
  memPeakMb?: number;
  cpus?: number;
  commands?: number;
  bytesIn?: number;
  bytesOut?: number;
  /** `net_tx_bytes`. */
  netTx?: number;
  /** `net_rx_bytes`. */
  netRx?: number;
  netBlocked?: number;
  dataConns?: number;
  dataMs?: number;
  /** Fields not modeled above, kept verbatim. */
  raw: Record<string, string>;
}

/** One record from the unified `__events__` journal (CMD / NET / LIFE). */
export interface SandboxEvent {
  /** Lifetime-monotonic sequence; a jump between polls means ring-aged loss. */
  seq: number;
  /** Unix epoch milliseconds (guest-host wall clock). */
  ms: number;
  /** Record class: `CMD` / `NET` / `LIFE`, or an unknown kind passed through. */
  kind: "CMD" | "NET" | "LIFE" | string;
  text: string;
}
