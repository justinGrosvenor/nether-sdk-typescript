# @nether/sdk

[![CI](https://github.com/justinGrosvenor/nether-sdk-typescript/actions/workflows/ci.yml/badge.svg)](https://github.com/justinGrosvenor/nether-sdk-typescript/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@nether/sdk)](https://www.npmjs.com/package/@nether/sdk)
[![node](https://img.shields.io/node/v/@nether/sdk)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

TypeScript SDK for the [nether](https://github.com/justinGrosvenor/nether) sandbox control protocol.
Launch a sandbox forked from a base snapshot, drive it (run commands, move
files, snapshot, park), and tear it down deterministically - over nether's
line/frame protocol on a Unix socket.

- ESM, Node 22+, **zero runtime dependencies**.
- Two layers in one package: a high-level `Sandbox` facade, and the low-level
  wire primitives (codec, connection, role clients) for advanced integrators.
- Byte-for-byte faithful to the nether control protocol (proto_version 1 and 2).

## Install

```sh
npm install @nether/sdk
```

## Quickstart

```ts
import { Sandbox } from "@nether/sdk";

await using sb = await Sandbox.create({ base: "base.snap", name: "t1" }); // restore=1 fork
const r = await sb.exec("python", "-c", "print(2+2)"); // { exitCode, output, body }
console.log(r.exitCode, r.output);

await sb.put("./app.py", "/app.py");
await sb.get("/out.json", "./out.json");
await sb.snapshot("child.snap");

const info = await sb.refreshInfo(); // { protoVersion, backend, raw }
const stats = await sb.stats(); // { uptimeMs, cpuMs?, ... }
// Leaving the `await using` scope runs Symbol.asyncDispose: __shutdown__, kill
// the launched process, reap the work dir. Call sb.close() for non-`using` code.
```

Connect to an already-running sandbox instead of launching one:

```ts
const sb = await Sandbox.attach({ controlSocket: "/path/f.sock" });
// close() on an attached sandbox only disconnects; it does not stop the sandbox.
```

## `exec` returns BOUNDED output (use `get` for large data)

`exec` returns the guest command's exit code and **bounded** stdout+stderr. The
control channel caps a command's output at `max_output_bytes` (default 1 MiB;
reported by `__info__`). When a command exceeds it, nether truncates the body,
inserts a one-time `\n...[output capped]\n` marker, and still sends the exit code
- the reply is always a well-formed frame, but the tail is gone.

So **large or binary output must move through `get()` (file transfer), not
`exec`.** Write it to a file in the guest, then pull it:

```ts
await sb.exec("sh", "-c", "my-tool --out /tmp/big.bin");
await sb.get("/tmp/big.bin", "./big.bin"); // length-framed, binary-safe
```

A non-zero guest exit code is a normal `ExecResult` (not an error). A
control-plane failure (agent not ready, unknown verb, rejected transfer) raises
`NetherControlError`.

**Argv vs raw line.** `exec` accepts either shape:

- A **single string** is a raw shell line, passed through verbatim, so shell
  operators work: `sb.exec("ls | wc -l")` runs the pipeline.
- **Multiple arguments** are each POSIX shell-quoted and joined, so there is no
  injection surface: `sb.exec("python", "-c", "print(2+2)")` sends
  `python -c 'print(2+2)'`.

`put`/`get` paths are passed verbatim and must not contain whitespace (the
protocol parses arguments as single tokens); the host side is confined to the
sandbox's transfer jail (the work dir), so placing files there is the caller's
responsibility.

## Lifecycle: what `create` does

`Sandbox.create` ports nether's `bake.py do_fork`:

1. Resolve `base` to a forkable file. A `RAM_COMPRESSED` base (header RAM
   encoding at offset 84 == 2) is not directly forkable, so it is rehydrated once
   to `<base>.hydrated` (reused while newer than the base) via the nether binary.
2. Make a work dir; symlink `~/nether/kernels` into it if present; write
   `nether.conf` (`restore=1`, `restore_from=<abs base>`, `control_socket=f.sock`,
   `data_socket=f.data`).
3. Launch the nether binary (`NETHER_BIN` env, else `~/nether/zig-out/bin/nether`)
   with cwd = the work dir, poll for the control socket, connect, and confirm
   with `__info__`.
4. Teardown (`close()` / scope exit): best-effort `__shutdown__`, terminate then
   kill the process, remove the work dir. Never leaks a process or a work dir.

Relevant environment variables: `NETHER_BIN` (binary path), `NETHER_ROOT`
(checkout root for `kernels`, default `~/nether`), `NETHER_WORK` (work-dir root,
default `<tmpdir>/nether-fork`).

## Errors

A small typed hierarchy; every error is a `NetherError`.

| Class | Raised when |
|---|---|
| `NetherControlError` | nether rejected/failed a command (v1 bare `ERR`, or v2 framed negative exit). Has `.reason`. |
| `NetherProtocolError` | a framing / codec / cap / EOF fault (truncated escape, reply over the 1 MiB cap, socket closed mid-frame, bad handshake). |
| `NetherTimeout` | an inactivity window elapsed with no progress (connect timeout, or a quiet framed command past its hang window). |
| `NetherError` | base class. |

```ts
import { NetherControlError } from "@nether/sdk";
try {
  await sb.put("./missing", "/x");
} catch (e) {
  if (e instanceof NetherControlError) console.error("nether said no:", e.reason);
  else throw e;
}
```

## Low-level API

The facade is built on primitives that are exported for integrators who need
direct control (this is the surface swerver-console drives):

- **Codec**: `ReplyDecoder`, `isFramed`, `unescapeBody`, `controlError`,
  `validateCommand`, `eventsReplyComplete`, `screenDiffReplyComplete`, and the
  `RS` / `ESC` / `RECV_CAP` / `HANG_MS` / `IDLE_MS` / `SETTLE_MS` constants.
- **Connection**: `NetherConnection` (serial request/response over the socket,
  proto-version negotiation, the v1 settle guard) + `ConnectionOptions`.
- **Parsers**: `parseInfo`, `parseStats`, `parseEvents`, `parseScreenDiff`,
  `parseKeyValues`, `parseLogLines` and their result types.
- **Role clients**: `PrimaryClient` (drive), `ObserverClient` (read-only
  introspection), `SupervisorControlClient` (`ensure <tenant>`).
- **Lifecycle**: `launchFork`, `teardown`, `ensureForkable`, `readSnapEncoding`,
  `netherBin` / `netherRoot` / `netherWorkRoot`.

```ts
import { PrimaryClient, controlError } from "@nether/sdk";
const { client, info } = await PrimaryClient.connect("/path/f.sock");
const reply = await client.put("/host/a", "/guest/a");
if (controlError(reply)) throw new Error("put failed");
client.close();
```

## Wire semantics (summary)

- A reply is **framed** iff it is a shell command or one of
  `__info__`/`__stats__`/`__help__`; framed = `<body> 0x1e <exit-ascii> 0x0a`.
  Body bytes are delimiter-escaped (`0x1e`/`0x1f` -> `0x1f, byte ^ 0x40`) so a
  raw `0x1e` is only ever the trailer.
- A **control-plane error** is a v1 bare `ERR ...` line, or (v2) a framed reply
  with a NEGATIVE exit code. A guest exit is always `0..255`, so a negative
  framed exit unambiguously flags a control error, never guest output.
- Caps: replies are bounded at 1 MiB (`RECV_CAP`); EOF mid-frame fails closed.

## Testing

The unit suite needs no live nether: the codec is tested against the contract's
8 golden vectors, the connection/verbs against an in-process fake control server,
and `Sandbox.create`/teardown against a fake nether binary.

```sh
npm run build      # tsc -> dist/
npm run check      # biome + tsc --noEmit + vitest (what CI runs)
npm test           # vitest only
```

### Real end-to-end

`examples/e2e.mjs` drives a real HVF sandbox: fork from a base, exec, snapshot a
child while running, warm-fork a second sandbox from that child, and read the
state back. It needs an Apple Silicon Mac with a codesigned nether (see
`~/nether/docs/codesigning.md`) and a base snapshot:

```sh
npm run build && node examples/e2e.mjs --base /path/to/base.snap
```

## License

[Apache-2.0](LICENSE).
