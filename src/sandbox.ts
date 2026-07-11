/**
 * High-level, ergonomic facade over a nether sandbox: launch one forked from a
 * base, drive it (exec / put / get / snapshot / park / info / stats), and tear
 * it down deterministically. Wraps the low-level PrimaryClient + NetherConnection
 * and the process lifecycle (lifecycle.ts).
 *
 *   await using sb = await Sandbox.create({ base: "base.snap", name: "t1" });
 *   const r = await sb.exec("python", "-c", "print(2+2)"); // { exitCode, output, body }
 *   // Symbol.asyncDispose tears down at end of scope; sb.close() does it eagerly.
 */
import type { ChildProcess } from "node:child_process";
import { type Reply, controlError } from "./codec.js";
import { NetherConnection } from "./connection.js";
import { NetherControlError, NetherError } from "./errors.js";
import { type LaunchOptions, launchFork, teardown } from "./lifecycle.js";
import { parseInfo, parseStats } from "./parse.js";
import { type ExecResult, PrimaryClient, toExecResult } from "./primary.js";
import type { SandboxInfo, SandboxStats } from "./types.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Options for `Sandbox.create` (launch a fork of a base). */
export interface CreateOptions extends LaunchOptions {
  /** Seconds to keep retrying the control-socket handshake. Default 30. */
  connectTimeoutS?: number;
}

/** Options for `Sandbox.attach` (connect to an already-running sandbox). */
export interface AttachOptions {
  /** Path to the running sandbox's control socket. */
  controlSocket: string;
}

/**
 * Retry PrimaryClient.connect until the sandbox answers `__info__` cleanly. The
 * socket file can exist before the server accepts, and an early handshake can
 * race the agent, so mirror bake.py `do_fork`'s connect loop.
 */
async function connectWithRetry(
  controlSocket: string,
  timeoutMs: number,
): Promise<{ client: PrimaryClient; info: SandboxInfo }> {
  const t0 = Date.now();
  let last: unknown;
  for (;;) {
    try {
      return await PrimaryClient.connect(controlSocket);
    } catch (err) {
      last = err;
      if (Date.now() - t0 > timeoutMs) {
        throw new NetherError(
          `nether sandbox never became driveable at ${controlSocket}: ${
            last instanceof Error ? last.message : String(last)
          }`,
        );
      }
      await sleep(5);
    }
  }
}

export class Sandbox {
  /** The low-level primary client (guest exec + primary-only verbs). */
  readonly client: PrimaryClient;
  /** The static `__info__` report captured at connect time. */
  readonly info: SandboxInfo;
  /** The control socket path this sandbox is driven over. */
  readonly controlSocket: string;

  private readonly proc: ChildProcess | null;
  private readonly workDir: string | null;
  private closed = false;

  private constructor(args: {
    client: PrimaryClient;
    info: SandboxInfo;
    controlSocket: string;
    proc: ChildProcess | null;
    workDir: string | null;
  }) {
    this.client = args.client;
    this.info = args.info;
    this.controlSocket = args.controlSocket;
    this.proc = args.proc;
    this.workDir = args.workDir;
  }

  /** The underlying control connection (proto version, raw `command`, ...). */
  get connection(): NetherConnection {
    return this.client.conn;
  }

  /**
   * Launch a nether process forked from `base` and return a driveable Sandbox.
   * Rehydrates a `RAM_COMPRESSED` base first, writes a `restore=1` nether.conf,
   * spawns the binary, polls for the control socket, and confirms `__info__`.
   * The returned Sandbox owns the process and work dir: `close()` (or leaving an
   * `await using` scope) shuts the guest down, kills the process, and reaps the
   * work dir.
   */
  static async create(opts: CreateOptions): Promise<Sandbox> {
    const launched = await launchFork(opts);
    try {
      const { client, info } = await connectWithRetry(
        launched.controlSocket,
        (opts.connectTimeoutS ?? 30) * 1000,
      );
      return new Sandbox({
        client,
        info,
        controlSocket: launched.controlSocket,
        proc: launched.proc,
        workDir: launched.workDir,
      });
    } catch (err) {
      // Never leak the process or work dir if the handshake fails.
      await teardown(launched.proc, launched.workDir);
      throw err;
    }
  }

  /**
   * Connect to an already-running sandbox over its control socket. The returned
   * Sandbox does NOT own a process or work dir: `close()` only disconnects and
   * leaves the sandbox running (it is torn down by its own owner, an idle
   * timeout, or an explicit `shutdown()`).
   */
  static async attach(opts: AttachOptions): Promise<Sandbox> {
    const { client, info } = await PrimaryClient.connect(opts.controlSocket);
    return new Sandbox({
      client,
      info,
      controlSocket: opts.controlSocket,
      proc: null,
      workDir: null,
    });
  }

  private assertOpen(): void {
    if (this.closed) throw new NetherError("nether sandbox: already closed");
  }

  private static throwOnControlError(reply: Reply, verb: string): void {
    const err = controlError(reply);
    if (err !== null) throw new NetherControlError(`${verb}: ${err}`);
  }

  /**
   * Run a shell command in the guest. Multiple arguments are joined with a
   * single space into one shell line (no auto-quoting: quote yourself if an
   * argument contains spaces). Returns the guest's exit code and BOUNDED stdout:
   * the control channel caps command output (default 1 MiB), so large or binary
   * output MUST be retrieved with `get()`, not read from `exec`. A non-zero guest
   * exit code is a normal result; a control-plane failure (agent not ready, ...)
   * raises `NetherControlError`.
   */
  async exec(...args: string[]): Promise<ExecResult> {
    this.assertOpen();
    if (args.length === 0) throw new NetherError("nether exec: empty command");
    const command = args.join(" ");
    const reply = await this.client.conn.command(command, { shape: "framed" });
    Sandbox.throwOnControlError(reply, "exec");
    return toExecResult(reply);
  }

  /** Push a host file into the guest (`__put__`, <= 16 MiB). Raises on ERR. */
  async put(hostPath: string, guestPath: string): Promise<void> {
    this.assertOpen();
    const reply = await this.client.put(hostPath, guestPath);
    Sandbox.throwOnControlError(reply, "put");
  }

  /** Pull a guest file to the host (`__get__`). Raises on ERR. */
  async get(guestPath: string, hostPath: string): Promise<void> {
    this.assertOpen();
    const reply = await this.client.get(guestPath, hostPath);
    Sandbox.throwOnControlError(reply, "get");
  }

  /**
   * Capture a fork-source base snapshot on demand (`__snapshot__`); the sandbox
   * keeps running. Blocks until the file is on disk. Raises on ERR (e.g. the
   * guest was not quiescent, or the backend does not support it).
   */
  async snapshot(path: string): Promise<void> {
    this.assertOpen();
    const reply = await this.client.snapshot(path);
    Sandbox.throwOnControlError(reply, "snapshot");
  }

  /**
   * Park the sandbox (`__park__`): capture a one-shot snapshot, bill the
   * session, and EXIT. This is terminal - the guest is never resumed - so after
   * `park()` the Sandbox is closed (its process is reaped and, if owned, its work
   * dir removed). Raises on ERR (e.g. the data/egress bridge still holds
   * undelivered bytes). Pass a path to control where the park file is written.
   */
  async park(path?: string): Promise<void> {
    this.assertOpen();
    const cmd = path === undefined ? "__park__" : `__park__ ${path}`;
    const reply = await this.client.conn.command(cmd, { shape: "framed" });
    Sandbox.throwOnControlError(reply, "park");
    // The guest exits after a park; reap the process and work dir.
    this.closed = true;
    this.client.conn.destroy();
    await teardown(this.proc, this.workDir);
  }

  /** Re-query the static `__info__` report. */
  async refreshInfo(): Promise<SandboxInfo> {
    this.assertOpen();
    const reply = await this.client.conn.command("__info__", { shape: "framed" });
    Sandbox.throwOnControlError(reply, "info");
    if (reply.kind !== "framed") throw new NetherError("nether info: unexpected reply shape");
    return parseInfo(reply.text);
  }

  /** Query live usage counters (`__stats__`). */
  async stats(): Promise<SandboxStats> {
    this.assertOpen();
    const reply = await this.client.conn.command("__stats__", { shape: "framed" });
    Sandbox.throwOnControlError(reply, "stats");
    const text =
      reply.kind === "framed" ? reply.text : new TextDecoder().decode(new Uint8Array());
    return parseStats(text);
  }

  /**
   * Clean guest teardown (`__shutdown__`): the guest powers off and the process
   * exits, emitting its final usage bill. Does not by itself reap the process /
   * work dir - call `close()` (or use `await using`) for full teardown.
   */
  async shutdown(): Promise<void> {
    this.assertOpen();
    const reply = await this.client.shutdown();
    Sandbox.throwOnControlError(reply, "shutdown");
  }

  /**
   * Tear down. For a `create()`d sandbox: best-effort `__shutdown__`, then
   * terminate + kill the process, then remove the work dir. For an `attach()`ed
   * sandbox: just disconnect (the running sandbox is left alone). Idempotent.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // Only send __shutdown__ when we own the process (create). An attach caller
    // must not power off a sandbox it merely observed.
    if (this.proc !== null && this.client.conn.connected) {
      try {
        await this.client.shutdown();
      } catch {
        // best-effort: a wedged/gone guest still gets SIGTERM/SIGKILL below
      }
    }
    this.client.conn.destroy();
    await teardown(this.proc, this.workDir);
  }

  /** `await using` support: tears down at end of scope. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
