import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkLaunch,
  type GateDecision,
  limitMode,
  markModelWorking,
} from "../../../src/modules/ocm/gate.js";
import { readLogs } from "../../../src/modules/ocm/log.js";

const MODEL = "zai-coding-plan/glm-5.3-flash";
const DAY_MS = 86_400_000;

// Fabricated opencode.log line in the real escaped-quote shape.
function hitLine(error: string, ts: string, model = "glm-5.3-flash"): string {
  return (
    `timestamp=${ts} level=ERROR run=4f55e49a message=\\"stream error\\" ` +
    `providerID=zai-coding-plan modelID=${model} session.id=ses_x small=false agent=build ` +
    `mode=primary error.error=\\"AI_APICallError: ${error}\\"`
  );
}

function decision(): ReturnType<typeof readLogs> {
  return readLogs({ event: "gate.decision" });
}

let dir: string;
let logPath: string;

function iso(minutesAgo: number): string {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ocm-gate-"));
  process.env.OCM_STATE_DIR = dir;
  process.env.HOME = dir; // keeps the default log path inside the temp dir
  logPath = join(dir, "opencode.log");
});

afterEach(() => {
  delete process.env.OCM_STATE_DIR;
  delete process.env.OCM_LIMIT_MODE;
  delete process.env.OCM_LOG_LEVEL;
  delete process.env.HOME;
  rmSync(dir, { recursive: true, force: true });
});

const REFUSE_WINDOW_MSG =
  "WARNING zai-coding-plan/glm-5.3-flash: limited until a successful run clears it " +
  "(5-hour limit). Repeat the same run within 10 minutes to launch anyway.";

describe("limitMode", () => {
  it("returns refuse only for OCM_LIMIT_MODE=refuse", () => {
    process.env.OCM_LIMIT_MODE = "refuse";
    expect(limitMode()).toBe("refuse");
    process.env.OCM_LIMIT_MODE = "warn";
    expect(limitMode()).toBe("warn");
    delete process.env.OCM_LIMIT_MODE;
    expect(limitMode()).toBe("warn");
  });
});

describe("checkLaunch", () => {
  it("launches when the log has no block for the model", () => {
    process.env.OCM_LOG_LEVEL = "debug";
    writeFileSync(
      logPath,
      [
        `timestamp=${iso(1)} level=INFO message="hello" providerID=zai-coding-plan modelID=glm-5.3-flash`,
        hitLine("Rate limit exceeded", iso(1), "other-model"),
        "",
      ].join("\n"),
    );
    expect(checkLaunch("m1", MODEL, { logPath, windowMs: 600_000 })).toEqual({ action: "launch" });
    expect(readLogs({ event: "gate.no_block" })).toHaveLength(1);
    expect(decision()).toEqual([expect.objectContaining({ model: MODEL, action: "launch" })]);
  });

  it("launches with no options at all", () => {
    expect(checkLaunch("m1", MODEL)).toEqual({ action: "launch" });
  });

  it("warns on first run, launches the identical repeat, warns again after expiry", () => {
    writeFileSync(logPath, `${hitLine("Usage limit reached for 5 hour", iso(1))}\n`);
    const t0 = new Date();
    const first = checkLaunch("m1", MODEL, { now: t0, logPath });
    expect(first.action).toBe("warn");
    expect(first.block).toMatchObject({ kind: "five_hour", resetAt: undefined });
    expect(first.message).toBe(REFUSE_WINDOW_MSG);

    const second: GateDecision = checkLaunch("m1", MODEL, {
      now: new Date(t0.getTime() + 30_000),
      logPath,
    });
    expect(second).toMatchObject({ action: "launch", repeat: true, block: { kind: "five_hour" } });
    expect(readLogs({ event: "gate.launch_on_limited_model" })).toHaveLength(1);

    const third = checkLaunch("m1", MODEL, {
      now: new Date(t0.getTime() + 11 * 60_000),
      logPath,
    });
    expect(third.action).toBe("warn");

    const entries = decision();
    expect(entries.at(-3)).toMatchObject({
      owner: "m1",
      model: MODEL,
      action: "warn",
      kind: "five_hour",
    });
    expect(entries.at(-2)).toMatchObject({ action: "launch", repeat: true });
    expect(entries.at(-1)).toMatchObject({ action: "warn" });
  });

  it("gives a different owner its own warning", () => {
    writeFileSync(logPath, `${hitLine("Usage limit reached for 5 hour", iso(1))}\n`);
    const now = new Date();
    expect(checkLaunch("a", MODEL, { now, logPath }).action).toBe("warn");
    expect(checkLaunch("b", MODEL, { now, logPath }).action).toBe("warn");
  });

  it("refuses with a formatted reset time", () => {
    writeFileSync(
      logPath,
      `${hitLine(
        "Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-12-03 20:55:21",
        iso(1),
      )}\n`,
    );
    const result = checkLaunch("m1", MODEL, { mode: "refuse", logPath });
    expect(result).toMatchObject({
      action: "refuse",
      block: { kind: "weekly_monthly", resetAt: "2026-12-03T12:55:21.000Z" },
    });
    expect(result.message).toBe(
      "REFUSED zai-coding-plan/glm-5.3-flash: limited until 2026-12-03 12:55Z (weekly/monthly limit).",
    );
  });

  it("refuses without reset text, also via OCM_LIMIT_MODE", () => {
    process.env.OCM_LIMIT_MODE = "refuse";
    writeFileSync(logPath, `${hitLine("Insufficient account funds", iso(1))}\n`);
    const result = checkLaunch("m1", MODEL, { logPath });
    expect(result.message).toBe(
      "REFUSED zai-coding-plan/glm-5.3-flash: limited until a successful run clears it (insufficient account funds).",
    );
  });

  it.each([
    ["Usage limit reached for 5 hour", "5-hour limit"],
    [
      "Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-12-03 20:55:21",
      "weekly/monthly limit",
    ],
    ["Weekly usage limit reached. Resets in 3 days", "weekly limit"],
    ["Free usage limit reached", "free usage limit"],
    ["Insufficient account funds", "insufficient account funds"],
    ["Model access is disabled", "model access disabled"],
    ["Rate limit exceeded", "rate limit"],
  ] as const)("labels %j", (text, label) => {
    writeFileSync(logPath, `${hitLine(text, iso(1))}\n`);
    expect(checkLaunch("m1", MODEL, { mode: "refuse", logPath }).message).toContain(label);
  });

  it("launches when the block's resetAt has passed", () => {
    writeFileSync(
      logPath,
      `${hitLine("Weekly usage limit reached. Resets in 1 hour", iso(120))}\n`,
    );
    expect(checkLaunch("m1", MODEL, { logPath })).toEqual({ action: "launch" });
  });

  it("lifts the block once markModelWorking records a real response", () => {
    writeFileSync(logPath, `${hitLine("Usage limit reached for 5 hour", iso(1))}\n`);
    markModelWorking(MODEL);
    expect(checkLaunch("m1", MODEL, { logPath })).toEqual({ action: "launch" });
    expect(readLogs({ event: "gate.limit_cleared" })).toEqual([
      expect.objectContaining({ event: "gate.limit_cleared", model: MODEL }),
    ]);
  });

  it("uses a non-default window in the warning text", () => {
    writeFileSync(logPath, `${hitLine("Usage limit reached for 5 hour", iso(1))}\n`);
    const first = checkLaunch("m1", MODEL, { logPath, windowMs: 120_000 });
    expect(first.message).toContain("Repeat the same run within 2 minutes to launch anyway.");
    // Inside the window the repeat launches, after it a fresh warning is due.
    expect(checkLaunch("m1", MODEL, { logPath, windowMs: 120_000 }).action).toBe("launch");
    const late = checkLaunch("m1", MODEL, {
      logPath,
      windowMs: DAY_MS,
      now: new Date(Date.now() + DAY_MS),
    });
    expect(late.action).toBe("warn");
  });
});
