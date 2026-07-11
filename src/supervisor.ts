import { NetherConnection } from "./connection.js";
import type { SandboxInfo } from "./types.js";

export type EnsureResult = { ok: true; dataSocket: string } | { ok: false; reason: string };

/**
 * Thin client over the nether-supervisor control socket (default
 * /tmp/swc/nsup.ctl.sock). The supervisor speaks the same nether proto as a
 * VM's control socket: `__info__` handshakes (backend=supervisor), and
 * `ensure <tenant>` warms/cold-starts a tenant VM and answers with a framed
 * reply whose body is the data-socket path (exit 0) or a failure reason
 * (exit 1). This drives lifecycle; per-VM terminal/journal/stats go through the
 * bridge's SandboxRegistry attaching to each VM's own control socket.
 */
export class SupervisorControlClient {
  readonly conn: NetherConnection;

  constructor(conn: NetherConnection) {
    this.conn = conn;
  }

  static async connect(
    controlSocketPath: string,
  ): Promise<{ client: SupervisorControlClient; info: SandboxInfo }> {
    const conn = new NetherConnection(controlSocketPath);
    const info = await conn.connect();
    return { client: new SupervisorControlClient(conn), info };
  }

  /**
   * Warm the tenant's VM, forking from the base snapshot on a miss. The verb is
   * not `__`-prefixed, so codec.isFramed treats the reply as framed. Command
   * validation (newline/RS/ESC rejection) happens inside conn.command.
   */
  async ensure(tenant: string): Promise<EnsureResult> {
    const reply = await this.conn.command(`ensure ${tenant}`, { shape: "framed" });
    if (reply.kind === "framed") {
      return reply.exitCode === 0
        ? { ok: true, dataSocket: reply.text.trim() }
        : { ok: false, reason: reply.text.trim() };
    }
    if (reply.kind === "bare") return { ok: false, reason: reply.line };
    return { ok: false, reason: new TextDecoder().decode(reply.body).trim() };
  }

  close(): void {
    this.conn.destroy();
  }
}
