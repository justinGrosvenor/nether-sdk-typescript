#!/usr/bin/env node
/**
 * Fake nether binary for lifecycle tests. Two modes, keyed off nether.conf in
 * the cwd (exactly how the real binary is driven by the SDK):
 *
 *  - transform mode: `rehydrate_in=` / `rehydrate_out=` (or compress_*). Copy the
 *    input snapshot to the output path (rewriting the RAM encoding byte to FULL)
 *    and exit 0. No VM.
 *  - control mode: `control_socket=`. Bind that Unix socket and speak just enough
 *    of proto_version 2 (every reply framed) to answer __info__, shell commands,
 *    __put__/__get__, __snapshot__, __shutdown__, and __park__.
 *
 * Env NETHER_FAKE_EXIT_BEFORE_SOCKET=1 makes it exit(3) before binding, to test
 * the "process died before the socket appeared" path.
 */
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";

function readConf() {
  const conf = {};
  let text = "";
  try {
    text = fs.readFileSync(path.join(process.cwd(), "nether.conf"), "utf8");
  } catch {
    return conf;
  }
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) conf[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return conf;
}

function frame(body, exit) {
  return Buffer.concat([Buffer.from(body), Buffer.from(`\x1e${exit}\n`)]);
}

const conf = readConf();

// --- transform mode ---------------------------------------------------------
const inKey = conf.rehydrate_in ?? conf.compress_in;
const outKey = conf.rehydrate_out ?? conf.compress_out;
if (inKey && outKey) {
  const buf = fs.readFileSync(inKey);
  if (buf.length >= 128) buf.writeUInt32LE(0, 84); // RAM encoding -> FULL
  fs.writeFileSync(outKey, buf);
  process.exit(0);
}

// --- control mode -----------------------------------------------------------
if (process.env.NETHER_FAKE_EXIT_BEFORE_SOCKET === "1") process.exit(3);

const sock = conf.control_socket;
if (!sock) {
  process.stderr.write("fake-nether: no control_socket in nether.conf\n");
  process.exit(2);
}
const sockPath = path.isAbsolute(sock) ? sock : path.join(process.cwd(), sock);

const INFO =
  "nether sandbox info\nproto_version=2\nbackend=fake\narch=aarch64\ncpus=1\nram_mb=512\nmax_output_bytes=1048576\nx402=off\n";
const STATS = "nether sandbox stats\nuptime_ms=1234\ncpu_ms=42\nram_mb=512\ncpus=1\ncommands=3\n";

const server = net.createServer((conn) => {
  let buf = Buffer.alloc(0);
  conn.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    let nl = buf.indexOf(0x0a);
    while (nl >= 0) {
      const line = buf.subarray(0, nl).toString();
      buf = buf.subarray(nl + 1);
      handle(conn, line);
      nl = buf.indexOf(0x0a);
    }
  });
});

function handle(conn, line) {
  if (line === "") return;
  if (line === "__info__") return void conn.write(frame(INFO, 0));
  if (line === "__stats__") return void conn.write(frame(STATS, 0));
  if (line === "__shutdown__") {
    conn.write(frame("OK shutting down", 0));
    setTimeout(() => process.exit(0), 5);
    return;
  }
  if (line === "__park__" || line.startsWith("__park__ ")) {
    conn.write(frame("OK parked uptime_ms=1234 cpu_ms=42", 0));
    setTimeout(() => process.exit(0), 5);
    return;
  }
  if (line.startsWith("__snapshot__")) {
    const p = line.split(/\s+/)[1] ?? "nether.snap";
    try {
      fs.writeFileSync(path.join(process.cwd(), p), Buffer.alloc(128));
      conn.write(frame("OK snapshot written", 0));
    } catch (e) {
      conn.write(frame(`ERR ${e.message}`, -1));
    }
    return;
  }
  if (line.startsWith("__put__")) {
    if (line.includes("MISS")) return void conn.write(frame("ERR no such file", -1));
    return void conn.write(frame("OK put", 0));
  }
  if (line.startsWith("__get__")) {
    if (line.includes("MISS")) return void conn.write(frame("ERR no such file", -1));
    return void conn.write(frame("OK get", 0));
  }
  // Shell command.
  if (line === "AGENTDOWN") return void conn.write(frame("ERR agent not connected", -1));
  const m = line.match(/^exit (\d+)$/);
  if (m) return void conn.write(frame("", Number(m[1])));
  conn.write(frame(`ran:${line}\n`, 0));
}

try {
  fs.rmSync(sockPath, { force: true });
} catch {}
server.listen(sockPath);

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => process.exit(0));
}
