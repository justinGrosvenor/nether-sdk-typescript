/**
 * @nether/sdk - TypeScript SDK for the nether sandbox control protocol.
 *
 * Two layers, one package:
 *  - High-level facade: {@link Sandbox} (launch a fork, drive it, tear it down).
 *  - Low-level primitives: the reply codec, {@link NetherConnection}, and the
 *    role clients ({@link PrimaryClient} / {@link ObserverClient} /
 *    {@link SupervisorControlClient}) plus the `parse*` helpers.
 */

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
  type Reply,
  ReplyDecoder,
  type ReplyShape,
  RS,
  SETTLE_MS,
  screenDiffReplyComplete,
  unescapeBody,
  validateCommand,
} from "./codec.js";
// Connection.
export { type ConnectionOptions, NetherConnection } from "./connection.js";
// Typed error hierarchy.
export {
  NetherControlError,
  NetherError,
  NetherProtocolError,
  NetherTimeout,
} from "./errors.js";
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
export { ObserverClient } from "./observer.js";
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
// High-level facade.
export {
  type AttachOptions,
  type CreateOptions,
  Sandbox,
} from "./sandbox.js";
export { type EnsureResult, SupervisorControlClient } from "./supervisor.js";
// Inlined wire value types.
export type { SandboxEvent, SandboxInfo, SandboxStats } from "./types.js";
