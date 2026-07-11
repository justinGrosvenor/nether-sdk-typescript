import { eventsReplyComplete } from "./codec.js";
import { NetherConnection } from "./connection.js";
import { type EventsReply, parseEvents, parseStats } from "./parse.js";
import type { SandboxInfo, SandboxStats } from "./types.js";

/**
 * A read-only observer connection (any client after the first). Introspection
 * verbs only; a driving verb over this connection is refused with `ERR read-only
 * observer` (a v1 bare line, settled fast by the guard; a v2 framed negative-exit
 * reply). Either way controlError() reports it as a failure rather than hanging.
 */
export class ObserverClient {
  readonly conn: NetherConnection;

  constructor(conn: NetherConnection) {
    this.conn = conn;
  }

  static async connect(socketPath: string): Promise<{ client: ObserverClient; info: SandboxInfo }> {
    const conn = new NetherConnection(socketPath);
    const info = await conn.connect();
    return { client: new ObserverClient(conn), info };
  }

  async stats(): Promise<SandboxStats> {
    const reply = await this.conn.command("__stats__", { shape: "framed" });
    if (reply.kind === "bare") throw new Error(`__stats__: ${reply.line}`);
    const text = reply.kind === "framed" ? reply.text : new TextDecoder().decode(reply.body);
    return parseStats(text);
  }

  /**
   * Cursor-polled unified CMD/NET/LIFE journal. Pass the cursor from the
   * previous reply (0 for the full retained ring). Completion is detected
   * deterministically (no idle-gap wait), so this is safe in a tight loop.
   */
  async events(after = 0): Promise<EventsReply> {
    const reply = await this.conn.command(`__events__ ${after}`, {
      shape: "unframed",
      complete: eventsReplyComplete(after),
    });
    if (reply.kind === "bare") throw new Error(`__events__: ${reply.line}`);
    const body = new TextDecoder().decode(reply.kind === "unframed" ? reply.body : reply.body);
    if (body.startsWith("ERR ")) throw new Error(`__events__: ${body.trim()}`);
    return parseEvents(body);
  }

  /**
   * Full server-side VT screen snapshot (observer-safe; the diff verb is
   * primary-only). No in-band terminator, so this pays an idle-gap wait;
   * `idleMs` defaults low because the reply is written in one burst locally.
   */
  async screen(idleMs = 300): Promise<string> {
    const reply = await this.conn.command("__screen__", { shape: "unframed", idleMs });
    const body = new TextDecoder().decode(
      reply.kind === "unframed" ? reply.body : new Uint8Array(),
    );
    if (body.startsWith("ERR ")) throw new Error(`__screen__: ${body.trim()}`);
    return body;
  }

  close(): void {
    this.conn.destroy();
  }
}
