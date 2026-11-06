import { collectHits } from "./evidence.js";
import { currentBlocks, type ModelBlock } from "./limits.js";
import { createLogger } from "./log.js";
import { loadState, markCleared, recordWarning, takeWarning } from "./state.js";

const logger = createLogger({ module: "ocm.gate" });

const DAY_MS = 86_400_000;
const DEFAULT_WINDOW_MS = 10 * 60_000;

const KIND_LABELS: Record<ModelBlock["kind"], string> = {
  five_hour: "5-hour limit",
  weekly_monthly: "weekly/monthly limit",
  weekly: "weekly limit",
  free_usage: "free usage limit",
  insufficient_funds: "insufficient account funds",
  model_disabled: "model access disabled",
  rate_limit: "rate limit",
};

/** One of the three launch outcomes checkLaunch can produce. */
export interface GateDecision {
  action: "launch" | "warn" | "refuse";
  message?: string;
  block?: ModelBlock;
  repeat?: boolean;
}

/** "refuse" only when OCM_LIMIT_MODE says so; limits stay a warning for now. */
export function limitMode(): "warn" | "refuse" {
  return process.env.OCM_LIMIT_MODE === "refuse" ? "refuse" : "warn";
}

function blockMessage(block: ModelBlock, prefix: "WARNING" | "REFUSED", windowMs: number): string {
  const until = block.resetAt
    ? `${block.resetAt.slice(0, 10)} ${block.resetAt.slice(11, 16)}Z`
    : "a successful run clears it";
  const base = `${prefix} ${block.provider}/${block.model}: limited until ${until} (${KIND_LABELS[block.kind]}).`;
  return prefix === "WARNING"
    ? `${base} Repeat the same run within ${Math.round(windowMs / 60_000)} minutes to launch anyway.`
    : base;
}

/**
 * Decide whether a run of `owner` on `model` (as `provider/model`) may launch.
 * A block in the last 7 days of opencode.log warns once per owner; the
 * identical repeat inside windowMs launches anyway.
 */
export function checkLaunch(
  owner: string,
  model: string,
  opts: {
    now?: Date;
    windowMs?: number;
    logPath?: string;
    mode?: "warn" | "refuse";
  } = {},
): GateDecision {
  // Resolved per call so tests can point HOME/OCM_LIMIT_MODE at a fixture.
  const now = opts.now ?? new Date();
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const mode = opts.mode ?? limitMode();
  const hits = collectHits({ logPath: opts.logPath, sinceMs: 7 * DAY_MS, now });
  const block = currentBlocks(hits, now, loadState().cleared).find(
    (b) => `${b.provider}/${b.model}` === model,
  );
  let decision: GateDecision;
  if (!block) {
    logger.debug("gate.no_block", { model });
    decision = { action: "launch" };
  } else if (mode === "refuse") {
    decision = { action: "refuse", block, message: blockMessage(block, "REFUSED", windowMs) };
  } else if (takeWarning(owner, model, windowMs, now)) {
    logger.warn("gate.launch_on_limited_model", {
      owner,
      model,
      kind: block.kind,
      resetAt: block.resetAt,
    });
    decision = { action: "launch", block, repeat: true };
  } else {
    recordWarning(owner, model, now);
    decision = { action: "warn", block, message: blockMessage(block, "WARNING", windowMs) };
  }
  logger.info("gate.decision", {
    owner,
    model,
    action: decision.action,
    kind: block?.kind,
    resetAt: block?.resetAt,
    repeat: decision.repeat,
  });
  return decision;
}

/** Caller hook: a real model response on `model` arrived, so the limit is lifted. */
export function markModelWorking(model: string, now: Date = new Date()): void {
  markCleared(model, now);
  logger.info("gate.limit_cleared", { model });
}
