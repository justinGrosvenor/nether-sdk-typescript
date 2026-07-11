/**
 * Live-socket tests for NetherConnection against an in-process Unix server that
 * models control_stub.py's behavior modes (normal / timeout / crash / notready /
 * v2) plus the tenant `ensure` verb. Exercises the real socket path (escaping,
 * v1/v2 control errors, EOF-fail-closed) without booting a VM.
 */
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { controlError, ESC, RS } from "../src/codec.js";
import { NetherConnection } from "../src/connection.js";
import { NetherProtocolError, NetherTimeout } from "../src/errors.js";
import { PrimaryClient } from "../src/primary.js";

type StubMode = "normal" | "timeout" | "crash" | "notready" | "v2";

const INFO_BODY = "nether sandbox info\nproto_version=1\nbackend=stub\ncpus=1\n";
const INFO_BODY_V2 = "nether sandbox info\nproto_version=2\nbackend=stub\ncpus=1\n";

function reply(body: string, exit: number): Buffer {
  return Buffer.concat([Buffer.from(body), Buffer.from(`\x1e${exit}\n`)]);
}

interface Stub {
  path: string;
  close: () => Promise<void>;
}

const stubs: Stub[] = [];

function startStub(mode: StubMode, tenantSock = "/tmp/swc-test/vm0.data.sock"): Promise<Stub> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nether-sdk-"));
  const sockPath = path.join(dir, "ctl.sock");
  const server = net.createServer((conn) => {
    let buf = Buffer.alloc(0);
    conn.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      let nl = buf.indexOf(0x0a);
      while (nl >= 0) {
        const line = buf.subarray(0, nl).toString();
        buf = buf.subarray(nl + 1);
        handle(line);
        nl = buf.indexOf(0x0a);
      }
    });
    function handle(line: string): void {
      if (line === "") return;
      if (line === "__info__") {
        conn.write(reply(mode === "v2" ? INFO_BODY_V2 : INFO_BODY, 0));
        return;
      }
      if (mode === "v2") {
        if (line.startsWith("DRIVE")) conn.write(reply("ERR read-only observer", -1));
        else if (line.startsWith("__put__")) conn.write(reply("ERR no such file", -1));
        else conn.write(reply(`ran:${line}`, 0));
        return;
      }
      if (line.startsWith("ensure ")) {
        const tenant = line.slice("ensure ".length).trim();
        if (tenant.length === 0) conn.write(reply("no VM socket for tenant", 1));
        else conn.write(reply(tenantSock, 0));
        return;
      }
      switch (mode) {
        case "timeout":
          return;
        case "crash":
          conn.write("E2E partial output");
          conn.destroy();
          return;
        case "notready":
          conn.write("ERR agent not connected\n");
          return;
        case "normal": {
          if (line.startsWith("E2E ")) {
            const token = line.split(" ").slice(2).join(" ");
            if (token.trim().length > 0) conn.write(reply(`ok:${token.length}:${token}`, 0));
            else conn.write(reply("denied: no credential", 1));
            return;
          }
          if (line.startsWith("ESCAPE")) {
            // body decodes to literal "A\x1eB\x1fC" via the R2b escape.
            const wire = new Uint8Array([0x41, ESC, RS ^ 0x40, 0x42, ESC, ESC ^ 0x40, 0x43]);
            conn.write(Buffer.concat([Buffer.from(wire), Buffer.from("\x1e0\n")]));
            return;
          }
          conn.write(reply("stub: unknown command", 127));
        }
      }
    }
  });
  return new Promise((resolve) => {
    server.listen(sockPath, () => {
      const stub: Stub = {
        path: sockPath,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res());
          }),
      };
      stubs.push(stub);
      resolve(stub);
    });
  });
}

afterEach(async () => {
  while (stubs.length > 0) await stubs.pop()?.close();
});

describe("NetherConnection handshake", () => {
  it("connects and verifies proto_version=1", async () => {
    const stub = await startStub("normal");
    const conn = new NetherConnection(stub.path);
    const info = await conn.connect();
    expect(info.protoVersion).toBe(1);
    expect(info.backend).toBe("stub");
    conn.destroy();
  });
});

describe("NetherConnection command modes", () => {
  it("normal: framed allow and deny replies round-trip with exit codes", async () => {
    const stub = await startStub("normal");
    const { client } = await PrimaryClient.connect(stub.path);
    const ok = await client.exec("E2E /path token123");
    expect(ok.exitCode).toBe(0);
    expect(ok.output).toBe("ok:8:token123");
    const denied = await client.exec("E2E /path ");
    expect(denied.exitCode).toBe(1);
    expect(denied.output).toBe("denied: no credential");
    client.close();
  });

  it("normal: an escaped body round-trips to literal control bytes", async () => {
    const stub = await startStub("normal");
    const { client } = await PrimaryClient.connect(stub.path);
    const r = await client.exec("ESCAPE now");
    expect(Array.from(r.body)).toEqual([0x41, RS, 0x42, ESC, 0x43]);
    expect(r.exitCode).toBe(0);
    client.close();
  });

  it("v2: handshakes proto_version 2, frames acks, no settle needed", async () => {
    const stub = await startStub("v2");
    const conn = new NetherConnection(stub.path, { settleMs: 100 });
    const info = await conn.connect();
    expect(info.protoVersion).toBe(2);
    expect(conn.version).toBe(2);
    const rejected = await conn.command("DRIVE echo hi", { shape: "framed" });
    expect(rejected.kind).toBe("framed");
    if (rejected.kind === "framed") {
      expect(rejected.exitCode).toBe(-1);
      expect(rejected.text).toBe("ERR read-only observer");
    }
    const ok = await conn.command("echo hi", { shape: "framed" });
    if (ok.kind === "framed") expect(ok.text).toBe("ran:echo hi");
    conn.destroy();
  });

  it("v2: a framed put failure is a detectable control error, not swallowed", async () => {
    const stub = await startStub("v2");
    const { client } = await PrimaryClient.connect(stub.path);
    const r = await client.put("/host/x", "/guest/y");
    expect(r.kind).toBe("framed");
    expect(controlError(r)).toBe("ERR no such file");
    client.close();
  });

  it("ensure <tenant> returns the warm VM data socket path", async () => {
    const stub = await startStub("normal", "/tmp/swc-test/acme.data.sock");
    const { client } = await PrimaryClient.connect(stub.path);
    const res = await client.exec("ensure acme");
    expect(res.exitCode).toBe(0);
    expect(res.output).toBe("/tmp/swc-test/acme.data.sock");
    client.close();
  });

  it("timeout: a never-answered command fails with NetherTimeout, not a hang", async () => {
    const stub = await startStub("timeout");
    const conn = new NetherConnection(stub.path, { hangMs: 300 });
    await conn.connect();
    await expect(conn.command("E2E /path token")).rejects.toBeInstanceOf(NetherTimeout);
    conn.destroy();
  });

  it("crash: a partial fragment then EOF fails the command closed", async () => {
    const stub = await startStub("crash");
    const conn = new NetherConnection(stub.path);
    await conn.connect();
    await expect(conn.command("E2E /path token")).rejects.toBeInstanceOf(NetherProtocolError);
    conn.destroy();
  });

  it("notready: a bare ERR settles fast instead of hanging for the frame", async () => {
    const stub = await startStub("notready");
    const conn = new NetherConnection(stub.path, { settleMs: 100 });
    await conn.connect();
    const started = Date.now();
    const r = await conn.command("E2E /path token");
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(r.kind).toBe("bare");
    if (r.kind === "bare") {
      expect(r.ok).toBe(false);
      expect(r.line).toBe("ERR agent not connected");
    }
    conn.destroy();
  });

  it("a framed body that STARTS with OK keeps its frame past the settle window", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nether-sdk-"));
    const sockPath = path.join(dir, "slow.sock");
    const server = net.createServer((conn) => {
      let buf = Buffer.alloc(0);
      conn.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (buf.includes(0x0a) && buf.toString().includes("SLOW")) {
          conn.write("OK part one\n");
          setTimeout(() => conn.write("more body\n"), 60);
          setTimeout(() => conn.write(reply("", 0).subarray(0)), 220);
          buf = Buffer.alloc(0);
        } else if (buf.toString().startsWith("__info__")) {
          conn.write(reply(INFO_BODY, 0));
          buf = Buffer.alloc(0);
        }
      });
    });
    await new Promise<void>((res) => server.listen(sockPath, res));
    stubs.push({ path: sockPath, close: () => new Promise((res) => server.close(() => res())) });

    const conn = new NetherConnection(sockPath, { settleMs: 100 });
    await conn.connect();
    const result = await conn.command("SLOW cmd");
    expect(result.kind).toBe("framed");
    if (result.kind === "framed") {
      expect(result.text).toBe("OK part one\nmore body\n");
      expect(result.exitCode).toBe(0);
    }
    conn.destroy();
  });

  it("serializes concurrent commands (one in flight at a time)", async () => {
    const stub = await startStub("normal");
    const { client } = await PrimaryClient.connect(stub.path);
    const results = await Promise.all([
      client.exec("E2E /a one"),
      client.exec("E2E /b two"),
      client.exec("E2E /c three"),
    ]);
    expect(results.map((r) => r.output)).toEqual(["ok:3:one", "ok:3:two", "ok:5:three"]);
    client.close();
  });
});
