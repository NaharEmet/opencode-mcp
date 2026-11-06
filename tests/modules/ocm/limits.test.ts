import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  currentBlocks,
  type LimitHit,
  type LimitKind,
  parseLimitLine,
  parseSessionLine,
  parseWorkerEvent,
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

describe("parseSessionLine", () => {
  // Real post-update sample: no model fields, sessionID at the very end, and
  // literal backslash-n escapes inside the quoted cause.
  const ZAI_SESSION_LINE =
    "timestamp=2026-11-06T18:30:33.373Z level=ERROR run=c395a701 " +
    'message="Failed to drain Session" cause="AI.Error: Weekly/Monthly Limit Exhausted. ' +
    "Your limit will reset at 2026-11-10 02:02:55\\n    at Rae (/$bunfs/root/chunk-ek0q9z0p.js:3:3633)\\n" +
    '  [cause]: AI.Error.QuotaExceeded: Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-11-10 02:02:55\\n}" ' +
    "role=server sessionID=ses_e4de7b36bffeGj9tzvdxjKmhOH";
  const FREE_SESSION_LINE =
    "timestamp=2026-11-06T18:31:00.000Z level=ERROR run=c395a701 " +
    'message="Failed to drain Session" cause="AI.Error: Free usage limit reached. Free models ' +
    "work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: " +
    'https://opencode.ai/go\\n    at Rae (/$bunfs/root/chunk-ek0q9z0p.js:3:3633)" ' +
    "role=server sessionID=ses_e4de7b36bffeGj9tzvdxjKmhOH";

  it("parses the real Z.AI session line with UTC+8 reset conversion", () => {
    const parsed = parseSessionLine(ZAI_SESSION_LINE);
    expect(parsed).toMatchObject({
      ts: "2026-11-06T18:30:33.373Z",
      session: "ses_e4de7b36bffeGj9tzvdxjKmhOH",
      kind: "weekly_monthly",
      resetAt: "2026-11-09T18:02:55.000Z",
      raw: ZAI_SESSION_LINE,
    });
  });

  it("parses the free-pool session variant", () => {
    expect(parseSessionLine(FREE_SESSION_LINE)).toMatchObject({
      ts: "2026-11-06T18:31:00.000Z",
      session: "ses_e4de7b36bffeGj9tzvdxjKmhOH",
      kind: "free_usage",
      resetAt: undefined,
    });
  });

  it("rejects non-ERROR lines", () => {
    expect(parseSessionLine(ZAI_SESSION_LINE.replace("level=ERROR", "level=INFO"))).toBeNull();
  });

  it("rejects lines whose message is not Failed to drain Session", () => {
    expect(
      parseSessionLine(ZAI_SESSION_LINE.replace("Failed to drain Session", "Other error")),
    ).toBeNull();
  });

  it("rejects lines without a trailing sessionID", () => {
    expect(parseSessionLine(ZAI_SESSION_LINE.replace(/ sessionID=\S+$/, ""))).toBeNull();
    // a sessionID-looking token inside the cause does not satisfy the anchor
    expect(
      parseSessionLine(
        ZAI_SESSION_LINE.replace(/ sessionID=\S+$/, "").replace(
          "run=c395a701",
          "run=sessionID=ses_mid",
        ),
      ),
    ).toBeNull();
  });

  it("warns and returns null for unknown cause text", () => {
    expect(
      parseSessionLine(
        ZAI_SESSION_LINE.split("Weekly/Monthly Limit Exhausted").join("Some brand new wall"),
      ),
    ).toBeNull();
  });

  it("warns and returns null when the timestamp is missing", () => {
    expect(
      parseSessionLine(ZAI_SESSION_LINE.replace("timestamp=2026-11-06T18:30:33.373Z ", "")),
    ).toBeNull();
    expect(readLogs({ event: "limits.parse_session_failed" })).toHaveLength(1);
  });
});

describe("parseWorkerEvent", () => {
  const FREE_LIMIT_EVENT =
    '{"type":"error","timestamp":1793989303016,"sessionID":"ses_e4de7b333ffehtj1J774fjIhKK",' +
    '"error":{"type":"provider.free-limit","message":"Free usage limit reached. Connect a ' +
    'provider or subscribe to OpenCode Go to keep going, or switch models.","status":429,' +
    '"retryAfterMs":20313000}}';
  const AUTH_EVENT =
    '{"type":"error","timestamp":1793990000000,"sessionID":"ses_x",' +
    '"error":{"type":"provider.auth","message":"Model access is disabled","status":403}}';
  const QUOTA_EVENT =
    '{"type":"error","timestamp":1793990000000,"sessionID":"ses_x","error":{"type":"provider.quota",' +
    '"message":"This request requires more credits, or fewer max_tokens. You requested up to ' +
    '256000 tokens, but can only afford 3774.","status":402}}';

  it("parses the real free-limit event with a retryAfterMs reset", () => {
    expect(parseWorkerEvent(FREE_LIMIT_EVENT, "zai-coding-plan/glm-5.3-flash")).toMatchObject({
      ts: new Date(1793989303016).toISOString(),
      provider: "zai-coding-plan",
      model: "glm-5.3-flash",
      kind: "free_usage",
      resetAt: new Date(1793989303016 + 20313000).toISOString(),
      raw: FREE_LIMIT_EVENT,
    });
  });

  it("parses the real auth event", () => {
    expect(parseWorkerEvent(AUTH_EVENT, "zai-coding-plan/glm-5.3-flash")).toMatchObject({
      ts: new Date(1793990000000).toISOString(),
      provider: "zai-coding-plan",
      model: "glm-5.3-flash",
      kind: "model_disabled",
      resetAt: undefined,
    });
  });

  it("parses the real credit/quota event", () => {
    expect(parseWorkerEvent(QUOTA_EVENT, "zai-coding-plan/glm-5.3-flash")).toMatchObject({
      kind: "insufficient_funds",
      resetAt: undefined,
    });
  });

  it("falls back to message text for the reset when retryAfterMs is not positive", () => {
    const line = JSON.stringify({
      type: "error",
      timestamp: 1793990000000,
      error: {
        message: "Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-11-10 02:02:55",
      },
    });
    expect(parseWorkerEvent(line, "p/m")).toMatchObject({
      kind: "weekly_monthly",
      resetAt: "2026-11-09T18:02:55.000Z",
      provider: "p",
      model: "m",
    });
    const back = line.replace("reset at 2026-11-10 02:02:55", "Resets in 3 days");
    expect(parseWorkerEvent(back, "p/m")?.resetAt).toBe(
      new Date(Date.parse(new Date(1793990000000).toISOString()) + 3 * DAY_MS).toISOString(),
    );
  });

  it("classifies free-limit by error.type when the message is unknown", () => {
    const line = JSON.stringify({
      type: "error",
      timestamp: 1793990000000,
      error: { type: "provider.free-limit", message: "Some brand new free wall sentence" },
    });
    expect(parseWorkerEvent(line, "p/m")?.kind).toBe("free_usage");
  });

  it("splits on the first slash only", () => {
    const line = JSON.stringify({
      type: "error",
      timestamp: 1793990000000,
      error: { message: "Rate limit exceeded" },
    });
    expect(parseWorkerEvent(line, "a/b/c")).toMatchObject({ provider: "a", model: "b/c" });
    expect(parseWorkerEvent(line, "bare")).toMatchObject({ provider: "", model: "bare" });
  });

  it("rejects invalid JSON", () => {
    expect(parseWorkerEvent("{oops", "p/m")).toBeNull();
  });

  it("rejects non-error events", () => {
    expect(
      parseWorkerEvent(
        '{"type":"text","timestamp":1793990000000,"sessionID":"s","part":{"type":"text","text":"hi"}}',
        "p/m",
      ),
    ).toBeNull();
  });

  it("rejects unknown error messages", () => {
    const line = JSON.stringify({
      type: "error",
      timestamp: 1793990000000,
      error: { message: "Some brand new failure mode" },
    });
    expect(parseWorkerEvent(line, "p/m")).toBeNull();
  });

  it("rejects a non-string error message", () => {
    const line = JSON.stringify({
      type: "error",
      timestamp: 1793990000000,
      error: { message: 5 },
    });
    expect(parseWorkerEvent(line, "p/m")).toBeNull();
  });

  it("rejects an unparseable timestamp", () => {
    const line = JSON.stringify({
      type: "error",
      timestamp: "soon",
      error: { message: "Rate limit exceeded" },
    });
    expect(parseWorkerEvent(line, "p/m")).toBeNull();
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
