import * as net from "node:net";
import {
  HANG_MS,
  IDLE_MS,
  type Reply,
  ReplyDecoder,
  type ReplyShape,
  SETTLE_MS,
  isFramed,
  validateCommand,
} from "./codec.js";
import { NetherProtocolError, NetherTimeout } from "./errors.js";
import { parseInfo } from "./parse.js";
import type { SandboxInfo } from "./types.js";

export interface ConnectionOptions {
  /** Inactivity ceiling for a framed reply (a slow command may pause; only a
   * gap with no data at all means a dead guest). Default nether-ctl HANG_MS. */
  hangMs?: number;
  /** Idle gap that terminates an unframed reply. Default nether-ctl IDLE_MS. */
  idleMs?: number;
  /** Settle window for a bare ERR/OK line seen where a frame was expected. */
  settleMs?: number;
  connectTimeoutMs?: number;
}

interface Pending {
  decoder: ReplyDecoder;
  resolve: (r: Reply) => void;
  reject: (e: Error) => void;
  inactivity?: NodeJS.Timeout;
  settle: NodeJS.Timeout | undefined;
  settled: boolean;
  /** Per-command inactivity window override (framed: hang, unframed: idle). */
  windowMs: number;
  /** Deterministic unframed completion check, run after every chunk. */
  complete: ((buf: Uint8Array) => boolean) | undefined;
}

/**
 * One Unix-socket control connection with the protocol's serial discipline:
 * exactly one in-flight command, enforced by a promise queue. The FIRST client
 * on a sandbox's socket is primary, later ones are read-only observers; this
 * class is role-agnostic (see primary.ts / observer.ts).
 *
 * Failure semantics: any decode error, cap overflow, or EOF mid-frame rejects
 * the in-flight command AND destroys the socket. The owner decides whether to
 * reconnect (disconnect is protocol-safe: the primary slot is released).
 */
export class NetherConnection {
  readonly socketPath: string;
  private socket: net.Socket | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private pending: Pending | null = null;
  private opts: Required<ConnectionOptions>;
  private closedByUs = false;
  /** Negotiated at handshake. v2 frames every ack, so the bare-line settle
   * guard is unnecessary (and never fires); v1 still needs it. */
  private protoVersion = 1;

  constructor(socketPath: string, opts: ConnectionOptions = {}) {
    this.socketPath = socketPath;
    this.opts = {
      hangMs: opts.hangMs ?? HANG_MS,
      idleMs: opts.idleMs ?? IDLE_MS,
      settleMs: opts.settleMs ?? SETTLE_MS,
      connectTimeoutMs: opts.connectTimeoutMs ?? 5_000,
    };
  }

  get connected(): boolean {
    return this.socket !== null && !this.socket.destroyed;
  }

  /** The negotiated protocol version (1 or 2), valid after connect(). */
  get version(): number {
    return this.protoVersion;
  }

  /**
   * Connect and handshake. __info__ is framed in both v1 and v2, so it parses
   * identically; we accept either version and adapt reply handling. v2 frames
   * every command/ack reply (OK -> exit 0, ERR -> negative exit), removing the
   * v1 bare/framed ambiguity and its settle guard.
   */
  async connect(): Promise<SandboxInfo> {
    await this.connectSocket();
    const reply = await this.command("__info__", { shape: "framed" });
    if (reply.kind !== "framed") {
      this.destroy(new NetherProtocolError(`nether handshake: unexpected ${reply.kind} reply to __info__`));
      throw new NetherProtocolError(`nether handshake failed: ${JSON.stringify(reply)}`);
    }
    const info = parseInfo(reply.text);
    if (info.protoVersion !== 1 && info.protoVersion !== 2) {
      this.destroy(new NetherProtocolError(`proto_version=${info.protoVersion}`));
      throw new NetherProtocolError(
        `nether handshake: proto_version=${info.protoVersion}, expected 1 or 2`,
      );
    }
    this.protoVersion = info.protoVersion;
    return info;
  }

  private connectSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = net.connect(this.socketPath);
      const to = setTimeout(() => {
        sock.destroy();
        reject(new NetherTimeout(`nether connect timeout: ${this.socketPath}`));
      }, this.opts.connectTimeoutMs);
      sock.once("connect", () => {
        clearTimeout(to);
        this.socket = sock;
        sock.on("data", (chunk: Buffer) => this.onData(chunk));
        sock.on("error", (err: Error) => this.failPending(err));
        sock.on("close", () => this.onClose());
        resolve();
      });
      sock.once("error", (err) => {
        clearTimeout(to);
        reject(err);
      });
    });
  }

  /**
   * Send one command and await its reply. Serialized: callers may fire
   * concurrently, commands go out one at a time. Shape defaults from the verb
   * (codec.isFramed); pass an explicit shape for verbs the heuristic cannot
   * know (e.g. binary `__frame__` readers wanting "unframed").
   */
  command(
    cmd: string,
    opts: {
      shape?: ReplyShape;
      hangMs?: number;
      idleMs?: number;
      /** Deterministic completion for unframed replies (see codec predicates). */
      complete?: (buf: Uint8Array) => boolean;
    } = {},
  ): Promise<Reply> {
    validateCommand(cmd);
    const shape: ReplyShape = opts.shape ?? (isFramed(cmd) ? "framed" : "unframed");
    const run = this.queue.then(() => this.execute(cmd, shape, opts));
    // Keep the queue alive past failures; the caller still sees the rejection.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private execute(
    cmd: string,
    shape: ReplyShape,
    opts: { hangMs?: number; idleMs?: number; complete?: (buf: Uint8Array) => boolean },
  ): Promise<Reply> {
    const sock = this.socket;
    if (!sock || sock.destroyed) {
      return Promise.reject(new NetherProtocolError("nether connection: not connected"));
    }
    return new Promise<Reply>((resolve, reject) => {
      const pending: Pending = {
        decoder: new ReplyDecoder(shape),
        resolve,
        reject,
        settle: undefined,
        settled: false,
        windowMs:
          shape === "framed"
            ? (opts.hangMs ?? this.opts.hangMs)
            : (opts.idleMs ?? this.opts.idleMs),
        complete: opts.complete,
      };
      this.pending = pending;
      this.armInactivity(pending);
      sock.write(`${cmd}\n`, (err) => {
        if (err) this.failPending(err);
      });
    }).finally(() => {
      if (this.pending?.settled) this.pending = null;
    });
  }

  private armInactivity(p: Pending): void {
    if (p.inactivity) clearTimeout(p.inactivity);
    p.inactivity = setTimeout(() => {
      if (p.settled) return;
      if (p.decoder.shape === "unframed") {
        this.settle(p, p.decoder.finishUnframed()); // idle gap ends the reply (may be empty)
      } else {
        this.failPending(new NetherTimeout(`nether command timeout after ${p.windowMs}ms inactivity`));
      }
    }, p.windowMs);
  }

  private onData(chunk: Buffer): void {
    const p = this.pending;
    if (!p || p.settled) return; // unsolicited bytes: protocol violation, drop
    this.armInactivity(p); // progress resets the inactivity window
    let reply: Reply | null = null;
    try {
      reply = p.decoder.push(new Uint8Array(chunk));
    } catch (err) {
      this.failPending(err as Error);
      this.destroy(err as Error);
      return;
    }
    if (reply) {
      this.settle(p, reply);
      return;
    }
    // Deterministic unframed completion beats the idle-gap wait when the verb
    // has detectable termination (events cursor rule, screendiff blank line).
    if (p.decoder.shape === "unframed" && p.complete?.(p.decoder.peek()) === true) {
      this.settle(p, p.decoder.finishUnframed());
      return;
    }
    // Bare ERR/OK guard (v1 only): v2 frames every ack, so no bare line ever
    // arrives and this never fires. In v1 a complete status line with no RS
    // waits SETTLE_MS before being treated as the terminal (unframed) reply.
    // Hardened beyond nether-ctl: any bytes arriving inside the window disarm
    // the timer (a slow framed body that merely STARTS with "OK " keeps its
    // frame), and the guard re-arms on the next quiet bare-status state.
    if (
      this.protoVersion === 1 &&
      p.decoder.shape === "framed" &&
      !p.settle &&
      p.decoder.isBareStatusCandidate()
    ) {
      const armedLen = p.decoder.byteLength;
      p.settle = setTimeout(() => {
        p.settle = undefined;
        if (p.settled) return;
        if (p.decoder.isBareStatusCandidate() && p.decoder.byteLength === armedLen) {
          this.settle(p, p.decoder.finishBare());
        }
      }, this.opts.settleMs);
    }
  }

  private onClose(): void {
    const p = this.pending;
    if (p && !p.settled) {
      try {
        this.settle(p, p.decoder.finishEof());
      } catch (err) {
        this.failPending(err as Error);
      }
    }
    this.socket = null;
  }

  private settle(p: Pending, reply: Reply): void {
    if (p.settled) return;
    p.settled = true;
    if (p.inactivity) clearTimeout(p.inactivity);
    if (p.settle) clearTimeout(p.settle);
    this.pending = null;
    p.resolve(reply);
  }

  private failPending(err: Error): void {
    const p = this.pending;
    if (!p || p.settled) return;
    p.settled = true;
    if (p.inactivity) clearTimeout(p.inactivity);
    if (p.settle) clearTimeout(p.settle);
    this.pending = null;
    p.reject(err);
  }

  destroy(reason?: Error): void {
    this.closedByUs = true;
    if (reason) this.failPending(reason);
    else this.failPending(new NetherProtocolError("nether connection closed"));
    this.socket?.destroy();
    this.socket = null;
  }

  get wasClosedLocally(): boolean {
    return this.closedByUs;
  }
}
