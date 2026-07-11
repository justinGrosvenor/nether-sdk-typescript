import { describe, expect, it } from "vitest";
import { NetherProtocolError } from "../src/errors.js";
import {
  parseEvents,
  parseInfo,
  parseKeyValues,
  parseScreenDiff,
  parseStats,
} from "../src/parse.js";

describe("parseInfo", () => {
  it("extracts proto_version and backend, keeps raw", () => {
    const info = parseInfo("nether sandbox info\nproto_version=1\nbackend=hvf\ncpus=4\n");
    expect(info.protoVersion).toBe(1);
    expect(info.backend).toBe("hvf");
    expect(info.raw.cpus).toBe("4");
  });
  it("reports protoVersion 0 when missing (old nether)", () => {
    expect(parseInfo("nether sandbox info\n").protoVersion).toBe(0);
  });
});

describe("parseStats", () => {
  it("maps known fields to numbers and keeps unknowns in raw", () => {
    const stats = parseStats(
      "uptime_ms=61234\ncpu_ms=880\nmem_peak_mb=142\ncommands=9\nbytes_in=1024\nbytes_out=2048\nnet_tx=333\nnet_rx=444\ndata_conns=2\ndata_ms=57\nfuture_field=x\n",
    );
    expect(stats.uptimeMs).toBe(61234);
    expect(stats.cpuMs).toBe(880);
    expect(stats.memPeakMb).toBe(142);
    expect(stats.commands).toBe(9);
    expect(stats.dataMs).toBe(57);
    expect(stats.raw.future_field).toBe("x");
  });
  it("maps the real net_tx_bytes/net_rx_bytes keys and ram_mb/cpus", () => {
    const stats = parseStats(
      "nether sandbox stats\nuptime_ms=5000\nram_mb=512\ncpus=2\nnet_tx_bytes=100\nnet_rx_bytes=200\n",
    );
    expect(stats.ramMb).toBe(512);
    expect(stats.cpus).toBe(2);
    expect(stats.netTx).toBe(100);
    expect(stats.netRx).toBe(200);
  });
});

describe("parseEvents", () => {
  it("parses the header cursor and CMD/NET/LIFE records (audit.zig format)", () => {
    const reply = parseEvents(
      "EVENTS 5\n3 1783200000123 LIFE agent connected\n4 1783200001000 CMD exit=0 cpu_ms=12 ls -la\n5 1783200002000 NET TCP 1.1.1.1:443 BLOCK\n",
    );
    expect(reply.cursor).toBe(5);
    expect(reply.records).toHaveLength(3);
    expect(reply.records[0]).toEqual({
      seq: 3,
      ms: 1783200000123,
      kind: "LIFE",
      text: "agent connected",
    });
    expect(reply.records[1]?.text).toBe("exit=0 cpu_ms=12 ls -la");
    expect(reply.records[2]?.kind).toBe("NET");
  });
  it("handles the header-only no-new-events reply", () => {
    const reply = parseEvents("EVENTS 3\n");
    expect(reply.cursor).toBe(3);
    expect(reply.records).toHaveLength(0);
  });
  it("rejects a non-events body with a protocol error", () => {
    expect(() => parseEvents("ERR journal not enabled\n")).toThrow(NetherProtocolError);
    expect(() => parseEvents("ERR journal not enabled\n")).toThrow(/unexpected header/);
  });
});

describe("parseScreenDiff", () => {
  it("parses the SCREEN header, changed rows, and cleared rows (render.zig format)", () => {
    const diff = parseScreenDiff("SCREEN 24x80\n0 $ ls\n1 file.txt\n5\n\n");
    expect(diff.rows).toBe(24);
    expect(diff.cols).toBe(80);
    expect(diff.changed).toEqual([
      [0, "$ ls"],
      [1, "file.txt"],
      [5, ""],
    ]);
  });
  it("parses an empty diff (header + blank line)", () => {
    expect(parseScreenDiff("SCREEN 24x80\n\n").changed).toHaveLength(0);
  });
});

describe("parseKeyValues", () => {
  it("ignores non key=value lines and preserves values with equals", () => {
    const kv = parseKeyValues("header line\nkey=a=b\n\nempty=\n");
    expect(kv.key).toBe("a=b");
    expect(kv.empty).toBe("");
    expect(Object.keys(kv)).toHaveLength(2);
  });
});
