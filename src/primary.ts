import { type Reply, screenDiffReplyComplete } from "./codec.js";
import { NetherConnection } from "./connection.js";
import { parseScreenDiff, type ScreenDiff } from "./parse.js";
import type { SandboxInfo } from "./types.js";

export interface ExecResult {
  exitCode: number;
  output: string;
  body: Uint8Array;
}

/**
 * The primary (driving) client on a sandbox's control socket. The first
 * connector holds this role; it can run guest commands and use the
 * primary-only verbs (__put__/__get__/__shutdown__/__snapshot__, and the
 * per-client diff render verbs __screendiff__/__framediff__).
 */
export class PrimaryClient {
  readonly conn: NetherConnection;

  constructor(conn: NetherConnection) {
    this.conn = conn;
  }

  static async connect(socketPath: string): Promise<{ client: PrimaryClient; info: SandboxInfo }> {
    const conn = new NetherConnection(socketPath);
    const info = await conn.connect();
    return { client: new PrimaryClient(conn), info };
  }

  /** Run a shell command inside the guest. Framed reply carries its exit code. */
  async exec(command: string, opts: { hangMs?: number } = {}): Promise<ExecResult> {
    const reply = await this.conn.command(command, { shape: "framed", ...opts });
    return toExecResult(reply);
  }

  // __put__/__get__/__snapshot__/__shutdown__ answer with an OK/ERR ack: bare in
  // v1, framed in v2. "framed" shape reads either (v2 to the 0x1e trailer; v1 via
  // the settle guard), and controlError(reply) reports failure across both. As
  // "unframed" a v2 framed failure would decode as kind "unframed" and be
  // swallowed as success, so every ack verb uses "framed".
  async put(hostPath: string, guestPath: string): Promise<Reply> {
    return this.conn.command(`__put__ ${hostPath} ${guestPath}`, { shape: "framed" });
  }

  async get(guestPath: string, hostPath: string): Promise<Reply> {
    return this.conn.command(`__get__ ${guestPath} ${hostPath}`, { shape: "framed" });
  }

  async snapshot(path: string): Promise<Reply> {
    return this.conn.command(`__snapshot__ ${path}`, { shape: "framed" });
  }

  async shutdown(): Promise<Reply> {
    return this.conn.command("__shutdown__", { shape: "framed" });
  }

  /**
   * Per-client screen diff (primary-only). The first call on a connection
   * returns the full grid; later calls return only changed rows. The reply's
   * trailing blank line gives deterministic completion. Returns null when the
   * sandbox has no screen yet: before the first guest command runs there is no
   * current screen and the reply is completely empty (zero bytes), which is
   * also why `idleMs` defaults low, the empty case is idle-terminated.
   */
  async screenDiff(opts: { idleMs?: number } = {}): Promise<ScreenDiff | null> {
    const reply = await this.conn.command("__screendiff__", {
      shape: "unframed",
      complete: screenDiffReplyComplete,
      idleMs: opts.idleMs ?? 500,
    });
    const body = new TextDecoder().decode(
      reply.kind === "unframed" ? reply.body : new Uint8Array(),
    );
    if (body.length === 0) return null;
    if (body.startsWith("ERR ")) throw new Error(`__screendiff__: ${body.trim()}`);
    return parseScreenDiff(body);
  }

  close(): void {
    this.conn.destroy();
  }
}

export function toExecResult(reply: Reply): ExecResult {
  switch (reply.kind) {
    case "framed":
      return { exitCode: reply.exitCode, output: reply.text, body: reply.body };
    case "bare":
      return {
        exitCode: reply.ok ? 0 : 1,
        output: reply.line,
        body: new TextEncoder().encode(reply.line),
      };
    case "unframed":
      return { exitCode: 0, output: new TextDecoder().decode(reply.body), body: reply.body };
  }
}
