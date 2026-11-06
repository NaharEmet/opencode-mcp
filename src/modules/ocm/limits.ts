import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { createLogger, errorFields } from "./log.js";

const logger = createLogger({ module: "ocm.limits" });

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

/** The reset time in provider messages is Singapore local time. */
const RESET_ZONE = "+08:00";

const KINDS: [RegExp, LimitKind][] = [
  [/Weekly\/Monthly Limit Exhausted/, "weekly_monthly"],
  [/Usage limit reached for 5 hour/, "five_hour"],
  [/Weekly usage limit reached/, "weekly"],
  [/Free usage limit reached/, "free_usage"],
  [/Insufficient account funds/, "insufficient_funds"],
  [/Model access is disabled/, "model_disabled"],
  [/Rate limit exceeded/, "rate_limit"],
];

export type LimitKind =
  | "five_hour"
  | "weekly_monthly"
  | "weekly"
  | "free_usage"
  | "insufficient_funds"
  | "model_disabled"
  | "rate_limit";

export interface LimitHit {
  ts: string;
  provider: string;
  model: string;
  kind: LimitKind;
  resetAt?: string;
  raw: string;
}

export interface ModelBlock {
  provider: string;
  model: string;
  kind: LimitKind;
  since: string;
  resetAt?: string;
  raw: string;
}

function field(line: string, name: string): string | undefined {
  return new RegExp(`\\b${name}=(\\S+)`).exec(line)?.[1];
}

/**
 * Parse one opencode.log line into a LimitHit. Only level=ERROR
 * message="stream error" lines carrying providerID/modelID and a known limit
 * text count; everything else returns null.
 */
export function parseLimitLine(line: string): LimitHit | null {
  const provider = field(line, "providerID");
  const model = field(line, "modelID");
  if (
    field(line, "level") !== "ERROR" ||
    !/\bmessage=\\?"stream error\\?"/.test(line) ||
    !provider ||
    !model
  ) {
    return null;
  }
  const ts = field(line, "timestamp");
  const kind = KINDS.find(([pattern]) => pattern.test(line))?.[1];
  if (!ts || Number.isNaN(Date.parse(ts)) || !kind) {
    logger.warn("limits.parse_failed", { provider, model, raw: line });
    return null;
  }
  let resetAt: string | undefined;
  const at = /reset at (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/.exec(line);
  const resetsIn = /Resets in (\d+) (day|hour)s?/.exec(line);
  if (at) {
    resetAt = new Date(`${at[1].replace(" ", "T")}${RESET_ZONE}`).toISOString();
  } else if (resetsIn) {
    const ms = Number(resetsIn[1]) * (resetsIn[2] === "day" ? 86_400_000 : 3_600_000);
    resetAt = new Date(Date.parse(ts) + ms).toISOString();
  }
  return { ts, provider, model, kind, resetAt, raw: line };
}

/**
 * Parse the tail of an opencode.log file into limit hits, oldest first.
 * Reads only the last `maxBytes` (default 4 MB) and drops the partial first
 * line that truncation leaves behind.
 */
export function scanLog(
  path: string,
  opts: { sinceMs?: number; maxBytes?: number } = {},
): LimitHit[] {
  if (!existsSync(path)) return [];
  let bytes = 0;
  let lines: string[];
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - (opts.maxBytes ?? DEFAULT_MAX_BYTES));
    bytes = size - start;
    const buf = Buffer.alloc(bytes);
    const fd = openSync(path, "r");
    try {
      readSync(fd, buf, 0, bytes, start);
    } finally {
      closeSync(fd);
    }
    lines = buf.toString("utf8").split("\n");
    if (start > 0) lines.shift();
  } catch (error) {
    logger.error("limits.scan_failed", { path, ...errorFields(error) });
    return [];
  }
  const hits = lines.map(parseLimitLine).filter((hit): hit is LimitHit => hit !== null);
  const cutoff = opts.sinceMs === undefined ? undefined : Date.now() - opts.sinceMs;
  const found = cutoff === undefined ? hits : hits.filter((hit) => Date.parse(hit.ts) > cutoff);
  logger.debug("limits.scanned", { path, bytes, hits: found.length });
  return found;
}

/**
 * Newest hit per provider/model, dropping blocks whose resetAt has passed or
 * that were cleared by a later successful run. Blocks without resetAt stay
 * until cleared.
 */
export function currentBlocks(
  hits: LimitHit[],
  now: Date,
  cleared: Record<string, string> = {},
): ModelBlock[] {
  const newest = new Map<string, LimitHit>();
  for (const hit of hits) {
    const key = `${hit.provider}/${hit.model}`;
    const held = newest.get(key);
    if (!held || Date.parse(hit.ts) >= Date.parse(held.ts)) newest.set(key, hit);
  }
  const blocks: ModelBlock[] = [];
  for (const [key, hit] of newest) {
    if (hit.resetAt && Date.parse(hit.resetAt) < now.getTime()) continue;
    const clearedAt = cleared[key];
    if (clearedAt && Date.parse(clearedAt) > Date.parse(hit.ts)) continue;
    blocks.push({
      provider: hit.provider,
      model: hit.model,
      kind: hit.kind,
      since: hit.ts,
      resetAt: hit.resetAt,
      raw: hit.raw,
    });
  }
  return blocks;
}
