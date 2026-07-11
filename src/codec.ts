/**
 * Nether control-protocol reply codec. Dual-version (proto_version 1 and 2);
 * the version is negotiated from the __info__ handshake (connection.ts).
 *
 * Wire contract (nether docs/control-protocol.md, reference client
 * tools/nether-ctl.c read_reply):
 *
 * - Commands are single lines, `\n`-terminated. Reply shapes:
 *   - FRAMED (shell commands, __info__/__stats__/__help__ in both versions;
 *     PLUS every OK/ERR ack in v2): body bytes, then a raw 0x1e (RS) trailer
 *     followed by `<exit-code>\n`. OK -> exit 0; a control-plane error -> a
 *     NEGATIVE exit (a guest exit is 0..255, so negative is unambiguous,
 *     see controlError). The in-guest agent delimiter-escapes untrusted body
 *     bytes (0x1e/0x1f -> `0x1f, byte ^ 0x40`), forwarded RAW, so a raw 0x1e is
 *     ONLY the real trailer (unforgeable); the body is un-escaped.
 *   - BARE (v1 only): a single unframed `ERR <reason>\n` / `OK <reason>\n` line
 *     with no 0x1e, arriving where a framed reply was expected. A reader
 *     blocking for 0x1e would hang, hence the settle guard (v1-gated). v2 frames
 *     these, so no bare line ever occurs and the guard never arms.
 *   - UNFRAMED (logs __events__/__cmdlog__/__netlog__, render/framebuffer):
 *     self-delimiting or binary, no in-band terminator; the reader stops on an
 *     idle gap, a completion predicate, or EOF. No un-escaping (host-generated).
 */
import { NetherProtocolError } from "./errors.js";

export const RS = 0x1e;
export const ESC = 0x1f;
export const ESC_XOR = 0x40;

/** Reference timeouts from nether-ctl.c. All are inactivity windows, not totals. */
export const HANG_MS = 60_000;
export const IDLE_MS = 2_000;
export const SETTLE_MS = 500;

/** 1 MiB reply ceiling: a full screen/frame fits (matches nether-ctl BUFCAP). */
export const RECV_CAP = 1 << 20;

export type ReplyShape = "framed" | "unframed";

export type Reply =
  | { kind: "framed"; body: Uint8Array; text: string; exitCode: number }
  | { kind: "bare"; ok: boolean; line: string }
  | { kind: "unframed"; body: Uint8Array };

/** Is this command's reply framed? Mirrors nether-ctl.c is_framed. */
export function isFramed(command: string): boolean {
  if (!command.startsWith("__")) return true; // shell command -> agent frame
  return (
    command.startsWith("__info__") ||
    command.startsWith("__stats__") ||
    command.startsWith("__help__")
  );
}

/**
 * Un-escape agent body bytes: `0x1f, b` decodes to `b ^ 0x40`. Inverse of
 * agent.c write_escaped. Decoded length <= input length. A trailing lone 0x1f
 * cannot occur in a complete framed body (the escape pair never splits across
 * the trailer), so it is treated as a protocol error.
 */
export function unescapeBody(input: Uint8Array): Uint8Array {
  const out = new Uint8Array(input.length);
  let n = 0;
  let esc = false;
  for (const b of input) {
    if (esc) {
      out[n++] = b ^ ESC_XOR;
      esc = false;
    } else if (b === ESC) {
      esc = true;
    } else {
      out[n++] = b;
    }
  }
  if (esc) {
    throw new NetherProtocolError("nether codec: truncated escape sequence in framed body");
  }
  return out.subarray(0, n);
}

/**
 * Incremental decoder for ONE reply. Feed chunks as they arrive; `push` returns
 * the decoded Reply once complete, or null while incomplete. Timing decisions
 * (settle window, idle gap, hang) belong to the connection layer; the decoder
 * exposes `isBareStatusCandidate()` so the connection knows when to arm the
 * settle timer, and `finishUnframed()` / `finishBare()` for the timer paths.
 */
export class ReplyDecoder {
  private chunks: Uint8Array[] = [];
  private len = 0;
  readonly shape: ReplyShape;

  constructor(shape: ReplyShape) {
    this.shape = shape;
  }

  get byteLength(): number {
    return this.len;
  }

  private buffered(): Uint8Array {
    if (this.chunks.length === 1) return this.chunks[0] as Uint8Array;
    const all = new Uint8Array(this.len);
    let off = 0;
    for (const c of this.chunks) {
      all.set(c, off);
      off += c.length;
    }
    this.chunks = [all];
    return all;
  }

  push(chunk: Uint8Array): Reply | null {
    if (this.len + chunk.length > RECV_CAP) {
      throw new NetherProtocolError(`nether codec: reply exceeds ${RECV_CAP} byte cap`);
    }
    this.chunks.push(chunk);
    this.len += chunk.length;
    if (this.shape !== "framed") return null; // unframed ends on idle gap / EOF

    const buf = this.buffered();
    const rs = buf.indexOf(RS);
    if (rs < 0) return null;
    // Trailer is `<exit>\n`: wait for the newline after the RS.
    const nl = buf.indexOf(0x0a, rs + 1);
    if (nl < 0) return null;
    const exitText = new TextDecoder().decode(buf.subarray(rs + 1, nl));
    const exitCode = Number.parseInt(exitText, 10);
    const body = unescapeBody(buf.subarray(0, rs));
    return {
      kind: "framed",
      body,
      text: new TextDecoder().decode(body),
      exitCode: Number.isNaN(exitCode) ? 1 : exitCode,
    };
  }

  /**
   * True when the buffer is a complete bare `ERR ...\n` / `OK ...\n` line with
   * no RS: the connection should arm the SETTLE_MS timer (a real framed reply's
   * trailer follows its output immediately; nether-ctl.c bare_status_line).
   */
  isBareStatusCandidate(): boolean {
    if (this.len < 4) return false;
    const buf = this.buffered();
    if (buf.indexOf(RS) >= 0) return false;
    if (buf.indexOf(0x0a) < 0) return false;
    const head = new TextDecoder().decode(buf.subarray(0, 4));
    return head === "ERR " || head.startsWith("OK ");
  }

  /** Settle expired on a bare status line: deliver it as the terminal reply. */
  finishBare(): Reply {
    const buf = this.buffered();
    const nl = buf.indexOf(0x0a);
    const line = new TextDecoder().decode(buf.subarray(0, nl < 0 ? buf.length : nl));
    return { kind: "bare", ok: line.startsWith("OK "), line };
  }

  /** Idle gap / EOF on an unframed reply: everything buffered is the body. */
  finishUnframed(): Reply {
    return { kind: "unframed", body: this.buffered() };
  }

  /** Current buffered bytes, for completion predicates on unframed replies. */
  peek(): Uint8Array {
    return this.buffered();
  }

  /**
   * EOF while a framed reply was incomplete (guest crash mid-reply). A complete
   * bare status line still settles as bare; anything else is a hard error so the
   * caller fails the command closed and reconnects.
   */
  finishEof(): Reply {
    if (this.shape === "unframed") return this.finishUnframed();
    if (this.isBareStatusCandidate()) return this.finishBare();
    throw new NetherProtocolError(
      `nether codec: connection closed mid-reply (${this.len} bytes, no frame trailer)`,
    );
  }
}

/**
 * A control-plane error (nether rejected/failed the command), version-agnostic.
 * v1 sends a bare `ERR ...` line; v2 frames it with a NEGATIVE exit code. A
 * guest exit is always 0..255, so a negative framed exit unambiguously means a
 * control error rather than guest output. Returns the reason, or null on success.
 */
export function controlError(reply: Reply): string | null {
  if (reply.kind === "bare") return reply.ok ? null : reply.line;
  if (reply.kind === "framed") return reply.exitCode < 0 ? reply.text : null;
  return null;
}

// -- Completion predicates for unframed replies -----------------------------
// The reference client drains unframed replies to a 2s idle gap. Two verbs
// have deterministic termination a client can detect instead, which matters
// for tight poll loops (a 500ms events cursor cannot afford 2s per poll).

const decoder = new TextDecoder();

function bufferedText(buf: Uint8Array): string {
  return decoder.decode(buf);
}

/** A complete bare `ERR ...\n` reply (either verb can answer with one). */
function isBareErrLine(text: string): boolean {
  return text.startsWith("ERR ") && text.endsWith("\n") && !text.slice(0, -1).includes("\n");
}

/**
 * `__events__ <after>` completion: records are oldest-first and the newest
 * retained record's seq equals the header cursor, so the reply is complete
 * when (a) header-only and cursor <= after (no new events), or (b) the last
 * complete line's seq equals the header cursor (audit.zig:76-87 semantics).
 */
export function eventsReplyComplete(after: number): (buf: Uint8Array) => boolean {
  return (buf) => {
    const text = bufferedText(buf);
    if (isBareErrLine(text)) return true;
    if (!text.endsWith("\n")) return false;
    const lines = text.split("\n").filter((l) => l.length > 0);
    const header = lines[0];
    if (header === undefined || !header.startsWith("EVENTS ")) return false;
    const cursor = Number.parseInt(header.slice("EVENTS ".length), 10);
    if (Number.isNaN(cursor)) return false;
    if (cursor <= after) return true; // header-only reply
    const last = lines[lines.length - 1];
    if (last === undefined || last === header) return false;
    const lastSeq = Number.parseInt(last, 10);
    return lastSeq === cursor;
  };
}

/** `__screendiff__` completion: the reply always ends with a blank line. */
export function screenDiffReplyComplete(buf: Uint8Array): boolean {
  const text = bufferedText(buf);
  if (isBareErrLine(text)) return true;
  return text.endsWith("\n\n");
}

/**
 * Validate an outbound command line. Fail closed BEFORE any I/O: embedded
 * newlines would smuggle a second command; RS/ESC could forge reply framing.
 * Mirrors nether's control_client fail-closed checks.
 */
export function validateCommand(command: string): void {
  if (command.length === 0) throw new NetherProtocolError("nether codec: empty command");
  for (const ch of command) {
    const c = ch.codePointAt(0) as number;
    if (c === 0x0a || c === 0x0d || c === RS || c === ESC) {
      throw new NetherProtocolError(
        "nether codec: command contains forbidden byte (newline/CR/RS/ESC)",
      );
    }
  }
}
