/**
 * Process lifecycle: launch a nether process forked from a base snapshot, poll
 * for its control socket, and tear it down without leaking a process or a work
 * dir. Ported from nether scripts/bake.py `do_fork` / `ensure_forkable` /
 * `_nether_transform`.
 */
import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { NetherError } from "./errors.js";

// Snapshot header (nether src/agent/snapshot.zig): 128-byte little-endian,
// magic 'NSNP', v5. RAM encoding is a u32 at offset 84; a COMPRESSED base is not
// directly forkable and must be rehydrated first.
const SNAP_HDR_SIZE = 128;
const SNAP_MAGIC = 0x4e534e50;
const SNAP_VERSION = 5;
const RAM_ENCODING_OFFSET = 84;
const RAM_COMPRESSED = 2;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Path to the nether binary: `NETHER_BIN` env, else `~/nether/zig-out/bin/nether`. */
export function netherBin(): string {
  return process.env.NETHER_BIN ?? path.join(os.homedir(), "nether", "zig-out", "bin", "nether");
}

/** Root of the nether checkout (`NETHER_ROOT` env, else `~/nether`), for kernels. */
export function netherRoot(): string {
  return process.env.NETHER_ROOT ?? path.join(os.homedir(), "nether");
}

/** Base directory for per-sandbox work dirs (`NETHER_WORK` env, else /tmp/nether-fork). */
export function netherWorkRoot(): string {
  return process.env.NETHER_WORK ?? path.join(os.tmpdir(), "nether-fork");
}

/**
 * Read a v5 snapshot's RAM encoding (0=full, 1=diff, 2=compressed), or null if
 * `snap` is not a recognizable snapshot of this format (too short, bad magic,
 * wrong version). Used to decide whether a base must be rehydrated before it can
 * be forked. Fail safe: an unrecognizable file is never treated as compressed.
 */
export function readSnapEncoding(snap: string): number | null {
  let fd: number;
  try {
    fd = fs.openSync(snap, "r");
  } catch {
    return null;
  }
  try {
    const hdr = Buffer.alloc(SNAP_HDR_SIZE);
    const got = fs.readSync(fd, hdr, 0, SNAP_HDR_SIZE, 0);
    if (got < SNAP_HDR_SIZE) return null;
    if (hdr.readUInt32LE(0) !== SNAP_MAGIC || hdr.readUInt32LE(4) !== SNAP_VERSION) return null;
    return hdr.readUInt32LE(RAM_ENCODING_OFFSET);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Run a nether file-transform CLI mode (rehydrate) in a scratch dir: it reads
 * the key_in/key_out paths from nether.conf, does the transform, and exits (no
 * VM). Resolves on success, rejects on a non-zero exit. Mirrors bake.py
 * `_nether_transform`.
 */
function netherTransform(
  keyIn: string,
  keyOut: string,
  src: string,
  dst: string,
  bin: string,
): Promise<void> {
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), "nether-xf."));
  fs.writeFileSync(
    path.join(wd, "nether.conf"),
    `${keyIn}=${path.resolve(src)}\n${keyOut}=${path.resolve(dst)}\n`,
  );
  return new Promise<void>((resolve, reject) => {
    const proc = spawn(bin, [], { cwd: wd, stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    proc.stdout?.on("data", (d) => {
      err += d;
    });
    proc.stderr?.on("data", (d) => {
      err += d;
    });
    proc.on("error", (e) => {
      fs.rmSync(wd, { recursive: true, force: true });
      reject(new NetherError(`nether transform (${keyIn}) failed to spawn: ${e.message}`));
    });
    proc.on("exit", (code) => {
      fs.rmSync(wd, { recursive: true, force: true });
      if (code === 0) resolve();
      else
        reject(new NetherError(`nether transform (${keyIn}) failed (rc=${code}): ${err.trim()}`));
    });
  });
}

/**
 * A compressed base cannot be COW-mmap'd, so it is not directly forkable.
 * Rehydrate it once to a full, sparse, fast-forkable base cached next to it
 * (`<base>.hydrated`, reused while newer than the base) and return that path. A
 * full base is returned unchanged, keeping the fast fork path intact. Mirrors
 * bake.py `ensure_forkable`.
 */
export async function ensureForkable(snap: string, bin = netherBin()): Promise<string> {
  const abs = path.resolve(snap);
  if (readSnapEncoding(abs) !== RAM_COMPRESSED) return abs;
  const hy = `${abs}.hydrated`;
  const fresh = fs.existsSync(hy) && fs.statSync(hy).mtimeMs >= fs.statSync(abs).mtimeMs;
  if (!fresh) {
    await netherTransform("rehydrate_in", "rehydrate_out", abs, hy, bin);
  }
  return hy;
}

export interface LaunchOptions {
  /** Path to the base snapshot to fork from. */
  base: string;
  /** Sandbox name; also the work-dir leaf under the work root. */
  name: string;
  /** Override the nether binary path (default `netherBin()`). */
  bin?: string;
  /** Override the work dir (default `<workRoot>/<name>`). */
  workDir?: string;
  /** Extra `nether.conf` lines merged over the defaults (e.g. `{ ram_mb: 512 }`). */
  conf?: Record<string, string | number>;
  /** Seconds to wait for the control socket file to appear. Default 30. */
  socketTimeoutS?: number;
}

export interface LaunchResult {
  proc: ChildProcess;
  workDir: string;
  controlSocket: string;
  dataSocket: string;
  /** Absolute path of the forkable (possibly rehydrated) base used. */
  forkable: string;
  /** Log file the launched process's stdout/stderr is written to. */
  logPath: string;
}

/**
 * Launch a nether fork: resolve/rehydrate the base, build a work dir with a
 * `restore=1` nether.conf, spawn the binary, and wait for the control socket to
 * appear. The caller connects and confirms driveability (see Sandbox.create).
 * Ported from bake.py `do_fork` (minus the manifest/build-drift warnings).
 */
export async function launchFork(opts: LaunchOptions): Promise<LaunchResult> {
  const bin = opts.bin ?? netherBin();
  if (!fs.existsSync(opts.base)) {
    throw new NetherError(`nether base not found: ${opts.base}`);
  }
  const forkable = await ensureForkable(opts.base, bin);

  const workDir = opts.workDir ?? path.join(netherWorkRoot(), opts.name);
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });

  // Symlink the guest kernels dir into the work dir if the checkout has one.
  const kdir = path.join(netherRoot(), "kernels");
  if (fs.existsSync(kdir)) {
    try {
      fs.symlinkSync(kdir, path.join(workDir, "kernels"));
    } catch {
      // A pre-existing link or a filesystem without symlinks is non-fatal.
    }
  }

  const controlSocket = path.join(workDir, "f.sock");
  const dataSocket = path.join(workDir, "f.data");
  const conf: Record<string, string | number> = {
    restore: 1,
    restore_from: forkable,
    control_socket: "f.sock",
    data_socket: "f.data",
    ...opts.conf,
  };
  const confText = `${Object.entries(conf)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n")}\n`;
  fs.writeFileSync(path.join(workDir, "nether.conf"), confText);

  const logPath = path.join(workDir, "fork.log");
  const logFd = fs.openSync(logPath, "w");
  const proc = spawn(bin, [], {
    cwd: workDir,
    stdio: ["ignore", logFd, logFd],
  });
  fs.closeSync(logFd);

  // Wait for the control socket file to appear (bake.py polls at ~0.3ms).
  const timeoutMs = (opts.socketTimeoutS ?? 30) * 1000;
  const t0 = Date.now();
  let exited: number | null = null;
  proc.once("exit", (code) => {
    exited = code ?? -1;
  });
  while (!fs.existsSync(controlSocket)) {
    if (exited !== null) {
      let log = "";
      try {
        log = fs.readFileSync(logPath, "utf8").trim();
      } catch {
        // ignore
      }
      throw new NetherError(
        `nether process exited (code ${exited}) before the control socket appeared${
          log ? `:\n${log}` : ""
        }`,
      );
    }
    if (Date.now() - t0 > timeoutMs) {
      proc.kill("SIGKILL");
      throw new NetherError(
        `nether control socket never appeared at ${controlSocket} (see ${logPath})`,
      );
    }
    await sleep(2);
  }

  return { proc, workDir, controlSocket, dataSocket, forkable, logPath };
}

/**
 * Terminate a launched nether process and reap its work dir. Best-effort and
 * idempotent: SIGTERM, a short grace, then SIGKILL, then remove the work dir.
 */
export async function teardown(
  proc: ChildProcess | null,
  workDir: string | null,
  graceMs = 500,
): Promise<void> {
  if (proc && proc.exitCode === null && proc.signalCode === null) {
    const done = new Promise<void>((resolve) => {
      if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
      proc.once("exit", () => resolve());
    });
    try {
      proc.kill("SIGTERM");
    } catch {
      // already gone
    }
    const killed = await Promise.race([done.then(() => true), sleep(graceMs).then(() => false)]);
    if (!killed) {
      try {
        proc.kill("SIGKILL");
      } catch {
        // already gone
      }
      await done;
    }
  }
  if (workDir) {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}
