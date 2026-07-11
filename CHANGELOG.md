# Changelog

All notable changes to `@nether/sdk` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-07-11

Initial release.

### Added
- `Sandbox` async facade: `create` (fork a driveable sandbox from a base, rehydrating a
  compressed base first), `attach` (connect to an already-running sandbox), `exec`, `put`, `get`,
  `snapshot`, `park`, `stats`, `refreshInfo`, `shutdown`, `close`, and `Symbol.asyncDispose`
  teardown.
- The low-level control-protocol client (the surface swerver-console consumes): the wire codec
  (`0x1e` framing, `0x1f`/`^0x40` escaping, framed/bare/unframed replies, the v1/v2 negative-exit
  control-error convention, a 1 MiB receive cap, fail-closed EOF), `NetherConnection`, the role
  clients (`PrimaryClient`, `ObserverClient`, `SupervisorControlClient`), and report parsers.
- Typed error hierarchy: `NetherError`, `NetherControlError`, `NetherProtocolError`,
  `NetherTimeout`.
- Process lifecycle (`launchFork` / `teardown` / `ensureForkable`): a faithful port of the nether
  reference runner's fork flow (compressed-base rehydrate, `restore=1` conf, spawn, socket poll,
  `__info__` confirm, kill + reap).
- Test suite (vitest): the 8 golden wire vectors, a fake control server, and a fake nether binary
  exercising the launch/teardown lifecycle. No live HVF required.

[Unreleased]: https://github.com/justinGrosvenor/nether-sdk-typescript/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/justinGrosvenor/nether-sdk-typescript/releases/tag/v0.1.0
