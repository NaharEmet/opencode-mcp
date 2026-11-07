import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DispatchRecord, recordDispatch } from "../../../src/modules/ocm/ledger.js";
import { readLogs } from "../../../src/modules/ocm/log.js";
import { planStatus, zaiCredits } from "../../../src/modules/ocm/pricing.js";

let dir: string;

// Wednesday 2026-01-07 12:00 UTC: off-peak (peak is Mon-Fri 06:00-10:00 UTC).
const NOW = new Date("2026-01-07T12:00:00.000Z");
const PEAK = new Date("2026-01-07T07:00:00.000Z");
const SATURDAY = new Date("2026-01-10T07:00:00.000Z");
const tokens = { input: 10_000, output: 0, reasoning: 0, cacheRead: 0 };

function dispatch(model: string, ageMs: number, overrides: Partial<DispatchRecord> = {}) {
  recordDispatch({
    worker: "w1",
    ts: new Date(NOW.getTime() - ageMs).toISOString(),
    model,
    wallSec: 1,
    costUsd: 0,
    tokens: { ...tokens, cacheWrite: 0 },
    outcome: "done",
    ...overrides,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ocm-pricing-"));
  process.env.OCM_STATE_DIR = dir;
  process.env.OCM_LOG_LEVEL = "debug";
});

afterEach(() => {
  delete process.env.OCM_STATE_DIR;
  delete process.env.OCM_LOG_LEVEL;
  delete process.env.OCM_PLANS;
  rmSync(dir, { recursive: true, force: true });
});

describe("zaiCredits", () => {
  it("applies the Flash multipliers at the peak rate", () => {
    expect(zaiCredits("zai-coding-plan/glm-5.3-flash", tokens, PEAK)).toBeCloseTo(2.3);
  });

  it("halves the rate off-peak and on weekends", () => {
    expect(zaiCredits("zai-coding-plan/glm-5.3-flash", tokens, NOW)).toBeCloseTo(1.15);
    expect(zaiCredits("zai-coding-plan/glm-5.3-flash", tokens, SATURDAY)).toBeCloseTo(1.15);
  });

  it("prices other models as GLM-5.3 and counts cached and reasoning tokens", () => {
    const t = { input: 10_000, output: 5000, reasoning: 5000, cacheRead: 10_000 };
    // (10000*6.9 + 10000*1.7 + 10000*24) / 10000 = 32.6
    expect(zaiCredits("zai-coding-plan/glm-5.3", t, PEAK)).toBeCloseTo(32.6);
  });
});

describe("planStatus", () => {
  it("reports usage with no limit when no plan is set", () => {
    dispatch("zai-coding-plan/glm-5.3-flash", 1000);
    dispatch("opencode-go/glm-5.3-flash", 1000, { steps: 4 });
    const rows = planStatus(NOW, undefined);
    expect(rows).toEqual([
      expect.objectContaining({ pool: "zai", window: "5h", limit: undefined, level: "ok" }),
      expect.objectContaining({ pool: "zai", window: "7d", limit: undefined, level: "ok" }),
      expect.objectContaining({ pool: "go", model: "glm-5.3-flash", used: 4, level: "ok" }),
    ]);
  });

  it("reads OCM_PLANS from the environment by default", () => {
    process.env.OCM_PLANS = "zai:lite";
    expect(planStatus(NOW)[0]).toMatchObject({ plan: "lite", limit: 2000 });
  });

  it("measures Z.AI credits against the plan in sliding 5h and 7d windows", () => {
    // 100M input tokens off-peak on Flash = 100e6*2.3/1e4*0.5 = 11500 credits
    const big = { input: 100_000_000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
    dispatch("zai-coding-plan/glm-5.3-flash", 3_600_000, { tokens: big });
    dispatch("zai-coding-plan/glm-5.3-flash", 24 * 3_600_000, { tokens: big });
    dispatch("zai-coding-plan/glm-5.3-flash", 8 * 24 * 3_600_000, { tokens: big });
    const [fiveH, week] = planStatus(NOW, "zai:pro");
    expect(fiveH).toMatchObject({
      plan: "pro",
      unit: "credits",
      used: 11_500,
      limit: 12_000,
      pct: 96,
      level: "warn",
    });
    expect(week).toMatchObject({ used: 23_000, limit: 60_000, pct: 38, level: "ok" });
  });

  it("flags a Z.AI plan as over its limit", () => {
    const big = { input: 100_000_000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
    dispatch("zai-coding-plan/glm-5.3-flash", 1000, { tokens: big });
    expect(planStatus(NOW, "zai:lite")[0]).toMatchObject({ pct: 575, level: "over" });
  });

  it("counts Go requests per model in the 5h window against the plan", () => {
    dispatch("opencode-go/kimi-k3", 1000, { steps: 100 });
    dispatch("opencode-go/kimi-k3", 2000, { steps: 20 });
    dispatch("opencode-go/kimi-k3", 6 * 3_600_000, { steps: 500 });
    dispatch("opencode-go/glm-5.3-flash", 1000);
    dispatch("opencode-go/brand-new-model", 1000, { steps: 3 });
    dispatch("anthropic/claude", 1000, { steps: 9 });
    const go = planStatus(NOW, "go:go").filter((r) => r.pool === "go");
    expect(go).toEqual([
      expect.objectContaining({
        model: "kimi-k3",
        used: 120,
        limit: 110,
        pct: 109,
        level: "over",
        feeUsd: 10,
      }),
      expect.objectContaining({
        model: "glm-5.3-flash",
        used: 0,
        limit: 6320,
        pct: 0,
        level: "ok",
      }),
      expect.objectContaining({ model: "brand-new-model", used: 3, limit: undefined, feeUsd: 10 }),
    ]);
  });

  it("uses the larger Go Plus allowance", () => {
    dispatch("opencode-go/kimi-k3", 1000, { steps: 100 });
    const go = planStatus(NOW, "go:goplus").find((r) => r.pool === "go");
    expect(go).toMatchObject({ limit: 440, pct: 23, feeUsd: 40 });
  });

  it("logs and skips invalid plan entries", () => {
    const rows = planStatus(NOW, " zai:huge, go:go ,bogus,,");
    expect(rows[0].plan).toBeUndefined();
    expect(readLogs({ event: "pricing.plan_invalid" })).toHaveLength(2);
  });
});
