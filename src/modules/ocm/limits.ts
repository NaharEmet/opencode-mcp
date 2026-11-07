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

/** A session-keyed "Failed to drain Session" limit line; model unknown. */
export interface SessionHit {
  ts: string;
  session: string;
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

/** resetAt from "reset at ..." (UTC+8) or "Resets in ..." text, or undefined. */
function resetFrom(ts: string, text: string): string | undefined {
  const at = /reset at (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/.exec(text);
  const resetsIn = /Resets in (\d+) (day|hour)s?/.exec(text);
  if (at) {
    return new Date(`${at[1].replace(" ", "T")}${RESET_ZONE}`).toISOString();
  }
  if (resetsIn) {
    const ms = Number(resetsIn[1]) * (resetsIn[2] === "day" ? 86_400_000 : 3_600_000);
    return new Date(Date.parse(ts) + ms).toISOString();
  }
  return undefined;
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
  const resetAt = resetFrom(ts, line);
  return { ts, provider, model, kind, resetAt, raw: line };
}

/**
 * Parse a session-keyed drain-failure log line into a SessionHit. Only
 * level=ERROR message="Failed to drain Session" lines with a trailing
 * sessionID=<id> and a known limit cause count; everything else returns null.
 */
export function parseSessionLine(line: string): SessionHit | null {
  if (field(line, "level") !== "ERROR" || !/\bmessage=\\?"Failed to drain Session\\?"/.test(line)) {
    return null;
  }
  const session = /\bsessionID=(\S+)\s*$/.exec(line)?.[1];
  const ts = field(line, "timestamp");
  if (!session || !ts || Number.isNaN(Date.parse(ts))) {
    logger.warn("limits.parse_session_failed", { raw: line });
    return null;
  }
  const kind = KINDS.find(([pattern]) => pattern.test(line))?.[1];
  if (!kind) {
    // a drain failure for some other cause (e.g. a 402 for credits): not a limit wall
    logger.debug("limits.session_not_a_limit", { session });
    return null;
  }
  return { ts, session, kind, resetAt: resetFrom(ts, line), raw: line };
}

/**
 * Parse one worker JSONL event line into a LimitHit for `model`
 * (`provider/model`). Only `type: "error"` events with a recognized limit
 * kind count; anything else returns null without throwing.
 */
export function parseWorkerEvent(line: string, model: string): LimitHit | null {
  let event: {
    type?: unknown;
    timestamp?: unknown;
    error?: { message?: unknown; type?: unknown; retryAfterMs?: unknown };
  };
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }
  if (event.type !== "error" || Number.isNaN(new Date(Number(event.timestamp)).getTime())) {
    return null;
  }
  const message = typeof event.error?.message === "string" ? event.error.message : "";
  let kind: LimitKind | undefined = message.startsWith("This request requires more credits")
    ? "insufficient_funds"
    : KINDS.find(([pattern]) => pattern.test(message))?.[1];
  if (!kind) {
    kind = event.error?.type === "provider.free-limit" ? "free_usage" : undefined;
  }
  if (!kind) return null;
  const ts = new Date(Number(event.timestamp)).toISOString();
  const at = model.indexOf("/");
  const provider = at > 0 ? model.slice(0, at) : "";
  const id = at > 0 ? model.slice(at + 1) : model;
  const retry = event.error?.retryAfterMs;
  const resetAt =
    typeof retry === "number" && retry > 0
      ? new Date(Date.parse(ts) + retry).toISOString()
      : resetFrom(ts, message);
  return { ts, provider, model: id, kind, resetAt, raw: line };
}

/** Read the last `maxBytes` of a log file as lines, dropping a partial leading line. */
export function readLogTail(
  path: string,
  maxBytes: number = DEFAULT_MAX_BYTES,
): { bytes: number; lines: string[] } {
  const size = statSync(path).size;
  const start = Math.max(0, size - maxBytes);
  const buf = Buffer.alloc(size - start);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buf, 0, buf.length, start);
  } finally {
    closeSync(fd);
  }
  const lines = buf.toString("utf8").split("\n");
  if (start > 0) lines.shift();
  return { bytes: buf.length, lines };
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
    const tail = readLogTail(path, opts.maxBytes ?? DEFAULT_MAX_BYTES);
    bytes = tail.bytes;
    lines = tail.lines;
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

/** Model key used when a limit applies to every model of a provider. */
export const ANY_MODEL = "*";

/** Provider whose wall a model-less limit line describes, from its verified text. */
export function providerForKind(kind: LimitKind, raw: string): string | undefined {
  if (kind === "weekly_monthly") return "zai-coding-plan";
  if (kind === "weekly") return "opencode-go";
  if (kind === "free_usage") return "opencode";
  if (kind === "insufficient_funds" && raw.includes("openrouter.ai")) return "openrouter";
  return undefined;
}

/** The block (exact model or provider-wide) that applies to `provider/model`, if any. */
export function blockFor(blocks: ModelBlock[], model: string): ModelBlock | undefined {
  return blocks.find(
    (b) =>
      `${b.provider}/${b.model}` === model ||
      (b.model === ANY_MODEL && model.startsWith(`${b.provider}/`)),
  );
}

/** Latest clearing time for a hit; a provider-wide hit is cleared by any model of that provider. */
function clearedFor(hit: LimitHit, cleared: Record<string, string>): string | undefined {
  if (hit.model !== ANY_MODEL) return cleared[`${hit.provider}/${hit.model}`];
  const times = Object.entries(cleared)
    .filter(([key]) => key.startsWith(`${hit.provider}/`))
    .map(([, at]) => at);
  return times.sort().at(-1);
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
  for (const hit of newest.values()) {
    if (hit.resetAt && Date.parse(hit.resetAt) < now.getTime()) continue;
    const clearedAt = clearedFor(hit, cleared);
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
