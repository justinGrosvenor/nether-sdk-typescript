/**
 * Typed error hierarchy for the nether SDK. Every error the SDK raises is a
 * `NetherError`, so a caller can `catch (e) { if (e instanceof NetherError) ... }`
 * and branch on the specific subclass:
 *
 * - `NetherControlError`  - nether rejected or failed the command at the control
 *   plane (a v1 bare `ERR ...` line, or a v2 framed reply with a NEGATIVE exit).
 *   This is a well-formed protocol answer that says "no", not a wire fault.
 * - `NetherProtocolError` - a framing / codec / cap / EOF fault: the bytes on the
 *   wire could not be decoded into a well-formed reply (truncated escape, reply
 *   over the 1 MiB cap, socket closed mid-frame, malformed handshake).
 * - `NetherTimeout`       - an inactivity window elapsed with no progress (connect
 *   timeout, or a framed command that went quiet past its hang window).
 */
export class NetherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
    // Restore the prototype chain for reliable `instanceof` across transpile
    // targets and bundlers.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * The control plane rejected or failed the command. `reason` is the raw nether
 * reason string (e.g. `ERR agent not connected (guest not ready)`).
 */
export class NetherControlError extends NetherError {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

/** A framing / codec / cap / EOF fault: the wire bytes are not a valid reply. */
export class NetherProtocolError extends NetherError {}

/** An inactivity window elapsed with no progress. */
export class NetherTimeout extends NetherError {}
