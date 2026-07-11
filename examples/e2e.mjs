#!/usr/bin/env node
// Real end-to-end check against a live, codesigned nether and a base snapshot.
//
// Unlike the unit suite (which uses fakes), this drives an actual HVF sandbox, so it needs an
// Apple Silicon Mac with a codesigned nether (see ~/nether/docs/codesigning.md; point NETHER_BIN
// at it, or set NETHER_ROOT) and a base snapshot to fork from (bake one with
// ~/nether/scripts/bake.py). Build the SDK first, then run:
//
//   npm run build && node examples/e2e.mjs --base /path/to/base.snap
//
// It forks a sandbox, runs a command, snapshots a child base while the sandbox is still running,
// forks a SECOND sandbox from that child (proving warm fork carries live state), reads the marker
// back, and tears both down. Needs real HVF, so it does not run in hosted CI.
import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Sandbox } from "../dist/index.js";

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const base = arg("--base");
const name = arg("--name") ?? "e2e";
if (!base) {
  console.error("usage: node examples/e2e.mjs --base <base.snap> [--name <n>]");
  process.exit(2);
}
if (!existsSync(base)) {
  console.error(`base not found: ${base} (bake one with ~/nether/scripts/bake.py)`);
  process.exit(2);
}
const bin =
  process.env.NETHER_BIN ??
  path.join(process.env.NETHER_ROOT ?? path.join(os.homedir(), "nether"), "zig-out/bin/nether");
if (!existsSync(bin)) {
  console.error(
    `nether binary not found at ${bin}; build + codesign it ` +
      "(see ~/nether/docs/codesigning.md) or set NETHER_BIN",
  );
  process.exit(2);
}

const child = path.join(os.tmpdir(), `${name}-child.snap`);

console.log(`[e2e] forking a sandbox from ${base} ...`);
{
  await using sb = await Sandbox.create({ base, name });
  console.log(`[e2e] driveable: proto_version=${sb.info.protoVersion} socket=${sb.controlSocket}`);
  const r = await sb.exec("uname", "-a");
  if (r.exitCode !== 0) throw new Error(`uname failed: ${JSON.stringify(r)}`);
  console.log(`[e2e] exec uname -> ${r.output.trim()}`);
  await sb.exec("sh", "-c", "echo hello-from-parent > /tmp/marker");
  await sb.snapshot(child);
  console.log(`[e2e] snapshot while running -> ${child}`);
}
console.log("[e2e] parent torn down");

console.log("[e2e] forking a SECOND sandbox from the child snapshot (warm fork) ...");
{
  await using fk = await Sandbox.create({ base: child, name: `${name}-fork` });
  const r = await fk.exec("cat", "/tmp/marker");
  if (r.exitCode !== 0 || !r.output.includes("hello-from-parent")) {
    throw new Error(`fork did not resume parent state: ${JSON.stringify(r)}`);
  }
  console.log(`[e2e] fork resumed parent state: /tmp/marker = ${JSON.stringify(r.output.trim())}`);
}
console.log("[e2e] OK: create -> exec -> snapshot -> warm-fork -> exec -> teardown");
