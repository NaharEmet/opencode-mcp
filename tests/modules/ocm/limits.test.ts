import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  currentBlocks,
  type LimitHit,
  type LimitKind,
  parseLimitLine,
  scanLog,
} from "../../../src/modules/ocm/limits.js";
import { readLogs, serverLogPath } from "../../../src/modules/ocm/log.js";

const T = "2026-10-31T10:46:06.851Z";
const DAY_MS = 86_400_000;

// Fabricated opencode.log line in the real escaped-quote shape.
function hitLine(error: string, ts = T): string {
  return (
    `timestamp=${ts} level=ERROR run=4f55e49a message=\\"stream error\\" ` +
    "providerID=zai-coding-plan modelID=glm-5.3-flash session.id=ses_x small=false agent=build " +
    `mode=primary error.error=\\"AI_APICallError: ${error}\\"`
  );
}

function hit(over: Partial<LimitHit>): LimitHit {
  return {
    ts: T,
    provider: "zai-coding-plan",
    model: "glm-5.3-flash",
    kind: "rate_limit",
    raw: "raw",
    ...over,
  };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ocm-limits-"));
  process.env.OCM_STATE_DIR = dir;
});

afterEach(() => {
  delete process.env.OCM_STATE_DIR;
  delete process.env.OCM_LOG_LEVEL;
  rmSync(dir, { recursive: true, force: true });
});

describe("parseLimitLine", () => {
  it("parses the real ticket example", () => {
    const parsed = parseLimitLine(
      hitLine("Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-11-03 20:55:21"),
    );
    expect(parsed).toMatchObject({
      ts: T,
      provider: "zai-coding-plan",
      model: "glm-5.3-flash",
      kind: "weekly_monthly",
      resetAt: "2026-11-03T12:55:21.000Z",
    });
  });

  it.each([
    ["Usage limit reached for 5 hour", "five_hour"],
    [
      "Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-11-03 20:55:21",
      "weekly_monthly",
    ],
    ["Weekly usage limit reached. Resets in 3 days", "weekly"],
    ["Free usage limit reached", "free_usage"],
    ["Insufficient account funds", "insufficient_funds"],
    ["Model access is disabled", "model_disabled"],
    ["Rate limit exceeded", "rate_limit"],
  ] as [string, LimitKind][])("classifies %j", (text, kind) => {
    expect(parseLimitLine(hitLine(text))?.kind).toBe(kind);
  });

  it("adds the day/hour duration to the line timestamp for weekly", () => {
    const days = parseLimitLine(hitLine("Weekly usage limit reached. Resets in 3 days"));
    const hours = parseLimitLine(
      hitLine("Weekly usage limit reached. Resets in 2 hours", "2026-11-01T00:00:00.000Z"),
    );
    expect(days?.resetAt).toBe(new Date(Date.parse(T) + 3 * DAY_MS).toISOString());
    expect(hours?.resetAt).toBe("2026-11-01T02:00:00.000Z");
  });

  it("leaves resetAt undefined without reset text", () => {
    expect(parseLimitLine(hitLine("Insufficient account funds"))?.resetAt).toBeUndefined();
    expect(parseLimitLine(hitLine("Free usage limit reached"))?.resetAt).toBeUndefined();
    expect(parseLimitLine(hitLine("Model access is disabled"))?.resetAt).toBeUndefined();
    expect(parseLimitLine(hitLine("Usage limit reached for 5 hour"))?.resetAt).toBeUndefined();
  });

  it("accepts unescaped quotes around stream error", () => {
    const line = `timestamp=${T} level=ERROR message="stream error" providerID=p modelID=m error.error="Rate limit exceeded"`;
    expect(parseLimitLine(line)).toMatchObject({ provider: "p", model: "m", kind: "rate_limit" });
  });

  it("rejects non-ERROR lines", () => {
    expect(
      parseLimitLine(hitLine("Rate limit exceeded").replace("level=ERROR", "level=INFO")),
    ).toBeNull();
  });

  it("rejects lines whose message is not stream error", () => {
    const line = `timestamp=${T} level=ERROR message="tool error" providerID=p modelID=m error.error="Rate limit exceeded"`;
    expect(parseLimitLine(line)).toBeNull();
  });

  it("rejects lines without providerID", () => {
    expect(
      parseLimitLine(`timestamp=${T} level=ERROR message="stream error" modelID=m`),
    ).toBeNull();
  });

  it("rejects lines without modelID", () => {
    expect(
      parseLimitLine(`timestamp=${T} level=ERROR message="stream error" providerID=p`),
    ).toBeNull();
  });

  it("warns and returns null for a matching line with unknown error text", () => {
    expect(parseLimitLine(hitLine("Some brand new failure mode"))).toBeNull();
    expect(readLogs({ event: "limits.parse_failed" })).toHaveLength(1);
  });

  it("warns and returns null when the timestamp is missing or unparseable", () => {
    expect(
      parseLimitLine(hitLine("Rate limit exceeded").replace(`timestamp=${T} `, "")),
    ).toBeNull();
    expect(parseLimitLine(hitLine("Rate limit exceeded").replace(T, "not-a-time"))).toBeNull();
    expect(readLogs({ event: "limits.parse_failed" })).toHaveLength(2);
  });
});

describe("scanLog", () => {
  it("returns [] for a missing file", () => {
    expect(scanLog(join(dir, "nope.log"))).toEqual([]);
  });

  it("returns [] and logs an error for an unreadable path", () => {
    expect(scanLog(dir)).toEqual([]);
    expect(readLogs({ level: "error", event: "limits.scan_failed" })).toHaveLength(1);
  });

  it("parses every line and returns hits oldest first", () => {
    const path = join(dir, "opencode.log");
    writeFileSync(
      path,
      [
        `timestamp=${T} level=INFO message="hello" providerID=p modelID=m`,
        hitLine("Rate limit exceeded", "2026-10-31T10:00:00.000Z"),
        hitLine("Insufficient account funds", "2026-10-31T11:00:00.000Z"),
        "",
      ].join("\n"),
    );
    const hits = scanLog(path);
    expect(hits.map((h) => [h.ts, h.kind])).toEqual([
      ["2026-10-31T10:00:00.000Z", "rate_limit"],
      ["2026-10-31T11:00:00.000Z", "insufficient_funds"],
    ]);
  });

  it("drops the partial first line when truncating to maxBytes", () => {
    const path = join(dir, "opencode.log");
    const a = hitLine("Rate limit exceeded", "2026-10-31T10:00:00.000Z");
    const b = hitLine("Insufficient account funds", "2026-10-31T11:00:00.000Z");
    writeFileSync(path, `${a}\n${b}\n`);
    const hits = scanLog(path, { maxBytes: b.length + 10 });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ ts: "2026-10-31T11:00:00.000Z", kind: "insufficient_funds" });
  });

  it("reads the whole file when it fits the default 4 MB window", () => {
    const path = join(dir, "opencode.log");
    writeFileSync(path, `${hitLine("Rate limit exceeded")}\n`);
    expect(scanLog(path)).toHaveLength(1);
  });

  it("filters hits older than sinceMs", () => {
    const path = join(dir, "opencode.log");
    const stale = hitLine("Rate limit exceeded", new Date(Date.now() - 120_000).toISOString());
    const fresh = hitLine("Rate limit exceeded", new Date(Date.now() - 1_000).toISOString());
    writeFileSync(path, `${stale}\n${fresh}\n`);
    const hits = scanLog(path, { sinceMs: 60_000 });
    expect(hits.map((h) => h.ts)).toEqual([fresh.match(/timestamp=(\S+)/)?.[1]]);
  });

  it("logs path, bytes and hit count at debug", () => {
    process.env.OCM_LOG_LEVEL = "debug";
    const path = join(dir, "opencode.log");
    writeFileSync(path, `${hitLine("Rate limit exceeded")}\n`);
    scanLog(path);
    const entry = readLogs({ event: "limits.scanned" }).at(-1);
    expect(entry).toMatchObject({ event: "limits.scanned", path, hits: 1 });
    expect(typeof entry?.bytes).toBe("number");
    expect(serverLogPath()).toContain(dir);
  });
});

describe("currentBlocks", () => {
  const now = new Date("2026-11-01T00:00:00.000Z");

  it("keeps only the newest hit per provider/model", () => {
    const blocks = currentBlocks(
      [
        hit({ ts: "2026-10-31T11:00:00.000Z", kind: "five_hour" }),
        hit({ ts: "2026-10-31T10:00:00.000Z", kind: "rate_limit" }),
        hit({ provider: "other", model: "m2", ts: "2026-10-31T09:00:00.000Z" }),
      ],
      now,
    );
    expect(blocks).toEqual([
      expect.objectContaining({
        provider: "zai-coding-plan",
        since: "2026-10-31T11:00:00.000Z",
        kind: "five_hour",
      }),
      expect.objectContaining({
        provider: "other",
        model: "m2",
        since: "2026-10-31T09:00:00.000Z",
      }),
    ]);
  });

  it("drops blocks whose resetAt is in the past and keeps future ones", () => {
    const expired = hit({ resetAt: "2026-10-31T23:00:00.000Z", provider: "a", model: "x" });
    const live = hit({ resetAt: "2026-11-02T00:00:00.000Z", provider: "b", model: "y" });
    expect(currentBlocks([expired, live], now).map((b) => b.model)).toEqual(["y"]);
  });

  it("drops cleared blocks but keeps hits newer than the clear time", () => {
    const old = hit({ ts: "2026-10-31T10:00:00.000Z", provider: "a", model: "x" });
    const newer = hit({ ts: "2026-10-31T12:00:00.000Z", provider: "b", model: "y" });
    const cleared = { "a/x": "2026-10-31T11:00:00.000Z", "b/y": "2026-10-31T11:00:00.000Z" };
    expect(currentBlocks([old, newer], now, cleared).map((b) => b.model)).toEqual(["y"]);
  });

  it("keeps blocks without resetAt until cleared", () => {
    const block = hit({ kind: "insufficient_funds" });
    expect(currentBlocks([block], now)).toHaveLength(1);
    expect(
      currentBlocks([block], now, { "zai-coding-plan/glm-5.3-flash": "2026-11-01T00:00:00.000Z" }),
    ).toHaveLength(0);
  });
});
