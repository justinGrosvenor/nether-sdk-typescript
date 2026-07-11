/**
 * @nether/sdk - TypeScript SDK for the nether sandbox control protocol.
 *
 * Two layers, one package:
 *  - High-level facade: {@link Sandbox} (launch a fork, drive it, tear it down).
 *  - Low-level primitives: the reply codec, {@link NetherConnection}, and the
 *    role clients ({@link PrimaryClient} / {@link ObserverClient} /
 *    {@link SupervisorControlClient}) plus the `parse*` helpers.
 */

// Typed error hierarchy.
export {
  NetherControlError,
  NetherError,
  NetherProtocolError,
  NetherTimeout,
} from "./errors.js";

// Inlined wire value types.
export type { SandboxEvent, SandboxInfo, SandboxStats } from "./types.js";

// Codec (wire-level primitives).
export {
  controlError,
  ESC,
  ESC_XOR,
  eventsReplyComplete,
  HANG_MS,
  IDLE_MS,
  isFramed,
  RECV_CAP,
  RS,
  type Reply,
  ReplyDecoder,
  type ReplyShape,
  screenDiffReplyComplete,
  SETTLE_MS,
  unescapeBody,
  validateCommand,
} from "./codec.js";

// Connection.
export { type ConnectionOptions, NetherConnection } from "./connection.js";

// Parsers + their result types.
export {
  type EventsReply,
  parseEvents,
  parseInfo,
  parseKeyValues,
  parseLogLines,
  parseScreenDiff,
  parseStats,
  type ScreenDiff,
} from "./parse.js";

// Role clients.
export { type ExecResult, PrimaryClient, toExecResult } from "./primary.js";
export { ObserverClient } from "./observer.js";
export { type EnsureResult, SupervisorControlClient } from "./supervisor.js";

// Process lifecycle (launch / teardown a forked nether process).
export {
  ensureForkable,
  type LaunchOptions,
  type LaunchResult,
  launchFork,
  netherBin,
  netherRoot,
  netherWorkRoot,
  readSnapEncoding,
  teardown,
} from "./lifecycle.js";

// High-level facade.
export {
  type AttachOptions,
  type CreateOptions,
  Sandbox,
} from "./sandbox.js";
