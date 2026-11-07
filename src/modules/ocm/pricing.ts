import { readDispatches } from "./ledger.js";
import { createLogger } from "./log.js";

const logger = createLogger({ module: "ocm.pricing" });
const HOUR_MS = 3_600_000;
const FIVE_HOUR_MS = 5 * HOUR_MS;
const WEEK_MS = 7 * 24 * HOUR_MS;
const WARN_PCT = 80;

/** Z.AI credit multipliers per model (docs.z.ai/devpack/overview, checked 2026-11-07). */
const ZAI_MULTIPLIERS = {
  "glm-5.3": { input: 6.9, cached: 1.7, output: 24 },
  "glm-5.3-flash": { input: 2.3, cached: 0.56, output: 8 },
} as const;

/** Z.AI Coding Plan credits per 5 hours and per week. */
export const ZAI_PLANS = {
  lite: { "5h": 2000, "7d": 10_000 },
  pro: { "5h": 12_000, "7d": 60_000 },
  max: { "5h": 28_000, "7d": 140_000 },
} as const;

/** OpenCode Go estimated requests per 5 hours as [Go, Go Plus] (opencode.ai/go, checked 2026-11-07). */
const GO_REQUESTS_5H: Record<string, [number, number]> = {
  "kimi-k3": [110, 440],
  "kimi-k3.1-pro": [147, 588],
  "deepseek-v4-pro": [1050, 4200],
  hy4: [2710, 10_840],
  "claude-haiku-5.5": [3850, 15_380],
  "minimax-m3.1-flash": [3880, 15_500],
  "gpt-6-luna": [4230, 16_920],
  "qwen3.7-plus": [4300, 12_900],
  "glm-5.3-flash": [6320, 18_960],
  "mimo-v2.6-flash": [30_100, 60_200],
  "deepseek-v4.1-flash": [43_330, 86_670],
  "muse-spark-1.3-contributor": [45_300, 90_600],
};

/** Flat monthly fee in USD and the column of GO_REQUESTS_5H each Go plan uses. */
export const GO_PLANS = {
  go: { feeUsd: 10, column: 0 },
  goplus: { feeUsd: 40, column: 1 },
} as const;

export type ZaiPlan = keyof typeof ZAI_PLANS;
export type GoPlan = keyof typeof GO_PLANS;

export interface PlanRow {
  pool: "zai" | "go";
  plan?: string;
  window: "5h" | "7d";
  unit: "credits" | "requests";
  model?: string;
  used: number;
  limit?: number;
  pct?: number;
  level: "ok" | "warn" | "over";
  feeUsd?: number;
}

/** Peak is Monday to Friday 14:00-18:00 Singapore time, i.e. 06:00-10:00 UTC. */
function isPeak(ts: Date): boolean {
  const day = ts.getUTCDay();
  const hour = ts.getUTCHours();
  return day >= 1 && day <= 5 && hour >= 6 && hour < 10;
}

/**
 * Z.AI credits for one dispatch: (input x in + cached x cached + output x out) / 10000,
 * halved off-peak. Reasoning tokens count as output; models other than the Flash
 * model use the dearer GLM-5.3 multipliers so usage is never understated.
 */
export function zaiCredits(
  model: string,
  tokens: { input: number; output: number; reasoning: number; cacheRead: number },
  ts: Date,
): number {
  const name = model.slice(model.indexOf("/") + 1);
  const m = name.startsWith("glm-5.3-flash")
    ? ZAI_MULTIPLIERS["glm-5.3-flash"]
    : ZAI_MULTIPLIERS["glm-5.3"];
  const raw =
    (tokens.input * m.input +
      tokens.cacheRead * m.cached +
      (tokens.output + tokens.reasoning) * m.output) /
    10_000;
  return isPeak(ts) ? raw : raw * 0.5;
}

function level(pct: number): PlanRow["level"] {
  if (pct >= 100) return "over";
  return pct >= WARN_PCT ? "warn" : "ok";
}

function parsePlans(config: string | undefined): { zai?: ZaiPlan; go?: GoPlan } {
  const plans: { zai?: ZaiPlan; go?: GoPlan } = {};
  for (const part of (config ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)) {
    const [pool, plan] = part.split(":");
    if (pool === "zai" && plan in ZAI_PLANS) plans.zai = plan as ZaiPlan;
    else if (pool === "go" && plan in GO_PLANS) plans.go = plan as GoPlan;
    else logger.warn("pricing.plan_invalid", { entry: part });
  }
  return plans;
}

function row(base: Omit<PlanRow, "pct" | "level">): PlanRow {
  if (base.limit === undefined) return { ...base, level: "ok" };
  const pct = Math.round((base.used / base.limit) * 100);
  return { ...base, used: Math.round(base.used * 100) / 100, pct, level: level(pct) };
}

/**
 * Usage against the subscription plans in OCM_PLANS ("zai:pro,go:go"): Z.AI
 * credits per 5h and 7d, OpenCode Go requests per 5h for each model used.
 * Without a plan the usage is still reported, just with no limit or percentage.
 */
export function planStatus(
  now: Date,
  config: string | undefined = process.env.OCM_PLANS,
): PlanRow[] {
  const plans = parsePlans(config);
  const zai = { "5h": 0, "7d": 0 };
  const go: Record<string, number> = {};
  for (const rec of readDispatches()) {
    const ts = new Date(rec.ts);
    const age = now.getTime() - ts.getTime();
    if (rec.model.startsWith("zai-coding-plan/") && age <= WEEK_MS) {
      const credits = zaiCredits(rec.model, rec.tokens, ts);
      zai["7d"] += credits;
      if (age <= FIVE_HOUR_MS) zai["5h"] += credits;
    } else if (rec.model.startsWith("opencode-go/") && age <= FIVE_HOUR_MS) {
      const name = rec.model.slice("opencode-go/".length);
      go[name] = (go[name] ?? 0) + (rec.steps ?? 0);
    }
  }
  const rows: PlanRow[] = [];
  for (const window of ["5h", "7d"] as const) {
    rows.push(
      row({
        pool: "zai",
        plan: plans.zai,
        window,
        unit: "credits",
        used: zai[window],
        limit: plans.zai ? ZAI_PLANS[plans.zai][window] : undefined,
      }),
    );
  }
  for (const [model, used] of Object.entries(go)) {
    const plan = plans.go ? GO_PLANS[plans.go] : undefined;
    const table = GO_REQUESTS_5H[model];
    rows.push(
      row({
        pool: "go",
        plan: plans.go,
        window: "5h",
        unit: "requests",
        model,
        used,
        limit: plan && table ? table[plan.column] : undefined,
        feeUsd: plan?.feeUsd,
      }),
    );
  }
  return rows;
}
