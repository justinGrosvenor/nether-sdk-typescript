import { describe, expect, it } from "vitest";
import {
  controlError,
  ESC,
  eventsReplyComplete,
  isFramed,
  RS,
  ReplyDecoder,
  screenDiffReplyComplete,
  unescapeBody,
  validateCommand,
} from "../src/codec.js";
import { NetherProtocolError } from "../src/errors.js";

const enc = new TextEncoder();

function frame(body: string | Uint8Array, exit: number): Uint8Array {
  const b = typeof body === "string" ? enc.encode(body) : body;
  const trailer = enc.encode(`\x1e${exit}\n`);
  const out = new Uint8Array(b.length + trailer.length);
  out.set(b, 0);
  out.set(trailer, b.length);
  return out;
}

// ----------------------------------------------------------------------------
// The 8 golden conformance vectors from the SDK contract (sdk-contract.md).
// Feed the EXACT raw reply bytes to the decoder for the given command shape and
// assert the decoded result byte-for-byte. Both SDKs (TS + Python) test these.
// ----------------------------------------------------------------------------
describe("golden conformance vectors", () => {
  it("1. framed ok: 68 65 6c 6c 6f 0a 1e 30 0a -> exit 0, output 'hello\\n'", () => {
    const bytes = new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x0a, 0x1e, 0x30, 0x0a]);
    const reply = new ReplyDecoder("framed").push(bytes);
    expect(reply?.kind).toBe("framed");
    if (reply?.kind === "framed") {
      expect(reply.exitCode).toBe(0);
      expect(reply.text).toBe("hello\n");
      expect(Array.from(reply.body)).toEqual([0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x0a]);
    }
  });

  it("2. framed nonzero: 62 61 64 0a 1e 34 32 0a -> exit 42, output 'bad\\n'", () => {
    const bytes = new Uint8Array([0x62, 0x61, 0x64, 0x0a, 0x1e, 0x34, 0x32, 0x0a]);
    const reply = new ReplyDecoder("framed").push(bytes);
    expect(reply?.kind).toBe("framed");
    if (reply?.kind === "framed") {
      expect(reply.exitCode).toBe(42);
      expect(reply.text).toBe("bad\n");
    }
  });

  it("3. framed escaped: 1f 5e 1f 5f 41 1e 30 0a -> body 1e 1f 41, exit 0", () => {
    const bytes = new Uint8Array([0x1f, 0x5e, 0x1f, 0x5f, 0x41, 0x1e, 0x30, 0x0a]);
    const reply = new ReplyDecoder("framed").push(bytes);
    expect(reply?.kind).toBe("framed");
    if (reply?.kind === "framed") {
      expect(Array.from(reply.body)).toEqual([0x1e, 0x1f, 0x41]);
      expect(reply.exitCode).toBe(0);
    }
  });

  it("4. framed control error (v2): 6e 6f 70 65 0a 1e 2d 31 0a -> controlError != null (exit -1)", () => {
    const bytes = new Uint8Array([0x6e, 0x6f, 0x70, 0x65, 0x0a, 0x1e, 0x2d, 0x31, 0x0a]);
    const reply = new ReplyDecoder("framed").push(bytes);
    expect(reply?.kind).toBe("framed");
    if (reply?.kind === "framed") {
      expect(reply.exitCode).toBe(-1);
      // NOT a success with exit -1: controlError flags it.
      expect(controlError(reply)).toBe("nope\n");
    }
  });

  it("5. bare ok (v1): 4f 4b 20 64 6f 6e 65 0a -> after settle, bare ok=true", () => {
    const bytes = new Uint8Array([0x4f, 0x4b, 0x20, 0x64, 0x6f, 0x6e, 0x65, 0x0a]);
    const d = new ReplyDecoder("framed");
    expect(d.push(bytes)).toBeNull(); // no RS -> incomplete as a frame
    expect(d.isBareStatusCandidate()).toBe(true);
    const bare = d.finishBare();
    expect(bare.kind).toBe("bare");
    if (bare.kind === "bare") {
      expect(bare.ok).toBe(true);
      expect(bare.line).toBe("OK done");
    }
    expect(controlError(bare)).toBeNull();
  });

  it("6. bare err (v1): 45 52 52 20 6e 6f 0a -> controlError != null", () => {
    const bytes = new Uint8Array([0x45, 0x52, 0x52, 0x20, 0x6e, 0x6f, 0x0a]);
    const d = new ReplyDecoder("framed");
    expect(d.push(bytes)).toBeNull();
    expect(d.isBareStatusCandidate()).toBe(true);
    const bare = d.finishBare();
    expect(controlError(bare)).toBe("ERR no");
  });

  it("7. eof mid-frame: 70 61 72 74 then EOF -> NetherProtocolError (fail closed)", () => {
    const bytes = new Uint8Array([0x70, 0x61, 0x72, 0x74]);
    const d = new ReplyDecoder("framed");
    expect(d.push(bytes)).toBeNull();
    expect(() => d.finishEof()).toThrow(NetherProtocolError);
    expect(() => d.finishEof()).toThrow(/closed mid-reply/);
  });

  it("8. cap: a reply exceeding 1 MiB with no trailer -> NetherProtocolError", () => {
    const d = new ReplyDecoder("framed");
    const big = new Uint8Array(1 << 19); // 512 KiB, no RS
    d.push(big);
    d.push(big);
    expect(() => d.push(new Uint8Array(1))).toThrow(NetherProtocolError);
    expect(() => new ReplyDecoder("framed").push(new Uint8Array((1 << 20) + 1))).toThrow(/cap/);
  });
});

describe("isFramed", () => {
  it("frames shell commands and the report verbs only", () => {
    expect(isFramed("ls -la")).toBe(true);
    expect(isFramed("ensure acme")).toBe(true);
    expect(isFramed("__info__")).toBe(true);
    expect(isFramed("__stats__")).toBe(true);
    expect(isFramed("__help__")).toBe(true);
    expect(isFramed("__events__")).toBe(false);
    expect(isFramed("__events__ 42")).toBe(false);
    expect(isFramed("__screen__")).toBe(false);
    expect(isFramed("__frame__")).toBe(false);
    expect(isFramed("__shutdown__")).toBe(false);
  });
});

describe("unescapeBody", () => {
  it("decodes the R2b escape pairs back to literal bytes", () => {
    const wire = new Uint8Array([0x61, ESC, RS ^ 0x40, 0x62, ESC, ESC ^ 0x40, 0x63]);
    const body = unescapeBody(wire);
    expect(Array.from(body)).toEqual([0x61, RS, 0x62, ESC, 0x63]);
  });

  it("rejects a truncated escape (cannot occur in a complete frame)", () => {
    expect(() => unescapeBody(new Uint8Array([0x61, ESC]))).toThrow(NetherProtocolError);
    expect(() => unescapeBody(new Uint8Array([0x61, ESC]))).toThrow(/truncated escape/);
  });
});

describe("ReplyDecoder framed", () => {
  it("decodes a normal framed reply", () => {
    const reply = new ReplyDecoder("framed").push(frame("ok:5:token", 0));
    expect(reply?.kind).toBe("framed");
    if (reply?.kind === "framed") {
      expect(reply.text).toBe("ok:5:token");
      expect(reply.exitCode).toBe(0);
    }
  });

  it("decodes a denied reply with its guest exit code", () => {
    const reply = new ReplyDecoder("framed").push(frame("denied: no credential", 1));
    if (reply?.kind === "framed") expect(reply.exitCode).toBe(1);
  });

  it("reassembles a frame split across arbitrary chunk boundaries", () => {
    const whole = frame("hello world", 0);
    for (let split = 1; split < whole.length - 1; split++) {
      const d = new ReplyDecoder("framed");
      expect(d.push(whole.subarray(0, split))).toBeNull();
      const reply = d.push(whole.subarray(split));
      if (reply?.kind === "framed") expect(reply.text).toBe("hello world");
    }
  });

  it("waits for the newline after the RS before completing", () => {
    const d = new ReplyDecoder("framed");
    expect(d.push(enc.encode("out\x1e0"))).toBeNull();
    const reply = d.push(enc.encode("\n"));
    if (reply?.kind === "framed") expect(reply.exitCode).toBe(0);
  });

  it("EOF after a bare ERR still settles as bare", () => {
    const d = new ReplyDecoder("framed");
    d.push(enc.encode("ERR too many control clients\n"));
    expect(d.finishEof().kind).toBe("bare");
  });
});

describe("eventsReplyComplete", () => {
  const complete = eventsReplyComplete(3);
  it("header-only reply with cursor <= after is complete", () => {
    expect(complete(enc.encode("EVENTS 3\n"))).toBe(true);
    expect(complete(enc.encode("EVENTS 2\n"))).toBe(true);
  });
  it("header with cursor > after is incomplete until the cursor record arrives", () => {
    expect(complete(enc.encode("EVENTS 5\n"))).toBe(false);
    expect(complete(enc.encode("EVENTS 5\n4 100 CMD x\n"))).toBe(false);
    expect(complete(enc.encode("EVENTS 5\n4 100 CMD x\n5 200 NET TCP 1.1.1.1:443 ALLOW\n"))).toBe(
      true,
    );
  });
  it("a bare ERR line completes immediately", () => {
    expect(complete(enc.encode("ERR journal not enabled\n"))).toBe(true);
  });
});

describe("screenDiffReplyComplete", () => {
  it("completes on the trailing blank line, including the empty diff", () => {
    expect(screenDiffReplyComplete(enc.encode("SCREEN 24x80\n0 $ ls\n"))).toBe(false);
    expect(screenDiffReplyComplete(enc.encode("SCREEN 24x80\n0 $ ls\n\n"))).toBe(true);
    expect(screenDiffReplyComplete(enc.encode("SCREEN 24x80\n\n"))).toBe(true);
  });
  it("completes on a bare ERR line", () => {
    expect(screenDiffReplyComplete(enc.encode("ERR __screendiff__ is primary-only\n"))).toBe(true);
  });
});

describe("controlError (v1 bare + v2 negative-exit)", () => {
  it("v1: a bare ERR is a control error, a bare OK is not", () => {
    const d = new ReplyDecoder("framed");
    d.push(enc.encode("ERR read-only observer\n"));
    expect(controlError(d.finishBare())).toBe("ERR read-only observer");
    const ok = new ReplyDecoder("framed");
    ok.push(enc.encode("OK done\n"));
    expect(controlError(ok.finishBare())).toBeNull();
  });
  it("v2: a framed reply with a NEGATIVE exit is a control error", () => {
    const reply = new ReplyDecoder("framed").push(frame("ERR read-only observer", -1));
    if (reply) expect(controlError(reply)).toBe("ERR read-only observer");
  });
  it("v2: a framed guest reply with a non-negative exit is NOT a control error", () => {
    const zero = new ReplyDecoder("framed").push(frame("hello", 0));
    const seven = new ReplyDecoder("framed").push(frame("boom", 7));
    if (zero) expect(controlError(zero)).toBeNull();
    if (seven) expect(controlError(seven)).toBeNull();
  });
});

describe("validateCommand", () => {
  it("accepts ordinary command lines", () => {
    expect(() => validateCommand("ensure acme")).not.toThrow();
    expect(() => validateCommand("__info__")).not.toThrow();
  });
  it("fails closed on newline, CR, RS, ESC (command smuggling / forged frames)", () => {
    expect(() => validateCommand("ls\nrm -rf /")).toThrow(NetherProtocolError);
    expect(() => validateCommand("ls\nrm -rf /")).toThrow(/forbidden/);
    expect(() => validateCommand("ls\r")).toThrow(/forbidden/);
    expect(() => validateCommand("x\x1ey")).toThrow(/forbidden/);
    expect(() => validateCommand("x\x1fy")).toThrow(/forbidden/);
    expect(() => validateCommand("")).toThrow(/empty/);
  });
});
