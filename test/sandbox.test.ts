/**
 * End-to-end lifecycle tests for the Sandbox facade against a FAKE nether binary
 * (test/fixtures/fake-nether.mjs) pointed at via NETHER_BIN. No HVF, no real VM:
 * the fake creates the control socket and speaks proto_version 2. Exercises
 * Sandbox.create (launch -> handshake), exec/put/get/snapshot/stats/info, the
 * compressed-base rehydrate path, park, attach, and full teardown.
 */
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { NetherControlError, NetherError } from "../src/errors.js";
import { launchFork, readSnapEncoding, teardown } from "../src/lifecycle.js";
import { Sandbox } from "../src/sandbox.js";

const FAKE_BIN = fileURLToPath(new URL("./fixtures/fake-nether.mjs", import.meta.url));

const SNAP_MAGIC = 0x4e534e50;
const SNAP_VERSION = 5;

/** Write a minimal valid v5 snapshot header with the given RAM encoding. */
function writeBase(file: string, encoding: number): void {
  const h = Buffer.alloc(256);
  h.writeUInt32LE(SNAP_MAGIC, 0);
  h.writeUInt32LE(SNAP_VERSION, 4);
  h.writeUInt32LE(0, 80); // KIND = base
  h.writeUInt32LE(encoding, 84);
  fs.writeFileSync(file, h);
}

const tmpDirs: string[] = [];
function scratch(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "nether-sbx-"));
  tmpDirs.push(d);
  return d;
}

beforeAll(() => {
  fs.chmodSync(FAKE_BIN, 0o755);
  process.env.NETHER_BIN = FAKE_BIN;
  // Point the work root at a throwaway dir so tests never touch /tmp/nether-fork.
  process.env.NETHER_WORK = scratch();
  // No kernels symlink in tests.
  process.env.NETHER_ROOT = scratch();
});

afterEach(() => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop();
    if (d) fs.rmSync(d, { recursive: true, force: true });
  }
  process.env.NETHER_WORK = scratch();
});

describe("Sandbox.create (full base)", () => {
  it("launches, handshakes proto 2, and drives the guest", async () => {
    const dir = scratch();
    const base = path.join(dir, "base.snap");
    writeBase(base, 0);

    const sb = await Sandbox.create({ base, name: "t1" });
    try {
      expect(sb.info.protoVersion).toBe(2);
      expect(sb.info.backend).toBe("fake");
      expect(sb.connection.version).toBe(2);

      const r = await sb.exec("echo", "hi");
      expect(r.exitCode).toBe(0);
      expect(r.output).toBe("ran:echo hi\n");

      const code = await sb.exec("exit", "7");
      expect(code.exitCode).toBe(7); // a non-zero guest exit is a normal result

      // Multiple args are shell-quoted; a special char gets single-quoted.
      const quoted = await sb.exec("echo", "a b", "print(2+2)");
      expect(quoted.output).toBe("ran:echo 'a b' 'print(2+2)'\n");

      // A single string is a raw shell line (operators pass through).
      const raw = await sb.exec("echo hi | cat");
      expect(raw.output).toBe("ran:echo hi | cat\n");

      const stats = await sb.stats();
      expect(stats.uptimeMs).toBe(1234);
      expect(stats.commands).toBe(3);

      const info = await sb.refreshInfo();
      expect(info.raw.max_output_bytes).toBe("1048576");
    } finally {
      await sb.close();
    }
  });

  it("put/get succeed, and a control-plane ERR raises NetherControlError", async () => {
    const dir = scratch();
    const base = path.join(dir, "base.snap");
    writeBase(base, 0);
    const sb = await Sandbox.create({ base, name: "t2" });
    try {
      await expect(sb.put("/host/a", "/guest/a")).resolves.toBeUndefined();
      await expect(sb.get("/guest/b", "/host/b")).resolves.toBeUndefined();
      await sb.snapshot("child.snap");
      await expect(sb.put("/host/MISS", "/guest/x")).rejects.toBeInstanceOf(NetherControlError);
      await expect(sb.exec("AGENTDOWN")).rejects.toBeInstanceOf(NetherControlError);
      // Fail fast on a whitespace path (not expressible over the protocol).
      await expect(sb.put("/host/a b", "/guest/x")).rejects.toBeInstanceOf(NetherError);
    } finally {
      await sb.close();
    }
  });

  it("close() kills the process and reaps the work dir", async () => {
    const dir = scratch();
    const base = path.join(dir, "base.snap");
    writeBase(base, 0);
    const workDir = path.join(scratch(), "reap-me");
    const sb = await Sandbox.create({ base, name: "t3", workDir });
    expect(fs.existsSync(workDir)).toBe(true);
    await sb.close();
    expect(fs.existsSync(workDir)).toBe(false);
    // Idempotent.
    await sb.close();
  });

  it("await using tears down at end of scope", async () => {
    const dir = scratch();
    const base = path.join(dir, "base.snap");
    writeBase(base, 0);
    const workDir = path.join(scratch(), "dispose-me");
    {
      await using sb = await Sandbox.create({ base, name: "t4", workDir });
      expect((await sb.exec("echo", "x")).output).toBe("ran:echo x\n");
    }
    expect(fs.existsSync(workDir)).toBe(false);
  });
});

describe("Sandbox.create (compressed base -> rehydrate)", () => {
  it("rehydrates a RAM_COMPRESSED base before forking", async () => {
    const dir = scratch();
    const base = path.join(dir, "comp.snap");
    writeBase(base, 2); // RAM_COMPRESSED
    expect(readSnapEncoding(base)).toBe(2);

    const sb = await Sandbox.create({ base, name: "tc" });
    try {
      const hydrated = `${base}.hydrated`;
      expect(fs.existsSync(hydrated)).toBe(true);
      expect(readSnapEncoding(hydrated)).toBe(0); // rehydrated to FULL
      expect((await sb.exec("echo", "ok")).output).toBe("ran:echo ok\n");
    } finally {
      await sb.close();
    }
  });
});

describe("Sandbox.park", () => {
  it("parks (terminal), reaps the process, and refuses further use", async () => {
    const dir = scratch();
    const base = path.join(dir, "base.snap");
    writeBase(base, 0);
    const workDir = path.join(scratch(), "park-me");
    const sb = await Sandbox.create({ base, name: "tp", workDir });
    await sb.park(path.join(workDir, "p.park"));
    expect(fs.existsSync(workDir)).toBe(false);
    await expect(sb.exec("echo", "x")).rejects.toBeInstanceOf(NetherError);
  });
});

describe("Sandbox.attach", () => {
  it("drives an already-running sandbox and only disconnects on close", async () => {
    const dir = scratch();
    const base = path.join(dir, "base.snap");
    writeBase(base, 0);
    // Launch a process the facade does NOT own.
    const launched = await launchFork({ base, name: "att", workDir: path.join(scratch(), "att") });
    try {
      const sb = await Sandbox.attach({ controlSocket: launched.controlSocket });
      const r = await sb.exec("echo", "attached");
      expect(r.output).toBe("ran:echo attached\n");
      await sb.close(); // disconnect only
      // The underlying process is still alive (attach did not own it).
      expect(launched.proc.exitCode).toBeNull();
    } finally {
      await teardown(launched.proc, launched.workDir);
    }
  });
});

describe("Sandbox.create failure paths", () => {
  it("throws (and reaps) when the process dies before the socket appears", async () => {
    const dir = scratch();
    const base = path.join(dir, "base.snap");
    writeBase(base, 0);
    const workDir = path.join(scratch(), "die");
    process.env.NETHER_FAKE_EXIT_BEFORE_SOCKET = "1";
    try {
      await expect(
        Sandbox.create({ base, name: "td", workDir, socketTimeoutS: 5 }),
      ).rejects.toBeInstanceOf(NetherError);
    } finally {
      delete process.env.NETHER_FAKE_EXIT_BEFORE_SOCKET;
    }
  });

  it("throws when the base file does not exist", async () => {
    await expect(
      Sandbox.create({ base: "/no/such/base.snap", name: "tx" }),
    ).rejects.toBeInstanceOf(NetherError);
  });
});
