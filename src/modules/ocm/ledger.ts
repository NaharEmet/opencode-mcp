import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createLogger, errorFields, stateDir } from "./log.js";

const logger = createLogger({ module: "ledger" });
const LOCK_TIMEOUT_MS = 2000;
const STALE_LOCK_MS = 10000;
const LOCK_RETRY_MS = 25;
const TIERS_HEADING = "## Speed and capability tiers";
const POOLS_HEADING = "## Three pools";
const POOL_ORDER: Record<Pool, number> = { free: 0, zai: 1, go: 2, other: 3 };
const SPEED_ORDER: Record<ModelEntry["speed"], number> = {
  fast: 0,
  medium: 1,
  slow: 2,
  unrated: 3,
};

export type Pool = "free" | "zai" | "go" | "other";

/** One model's rating, trial-ladder state and observed usage. */
export interface ModelEntry {
  id: string;
  pool: Pool;
  speed: "fast" | "medium" | "slow" | "unrated";
  strength: "light" | "medium" | "strong" | "unrated";
  maxDifficulty: 1 | 2 | 3 | 4;
  passes: number;
  strikes: number;
  streak: number;
  benched: boolean;
  listPrice?: { inputPerM: number; outputPerM: number };
  totals: {
    runs: number;
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
    wallSec: number;
  };
  notes?: string;
}

/** The persisted ledger document. */
export interface Ledger {
  version: 1;
  models: Record<string, ModelEntry>;
}

/** One finished dispatch, appended to dispatches.jsonl. */
export interface DispatchRecord {
  worker: string;
  ts: string;
  model: string;
  ticket?: string;
  difficulty?: 1 | 2 | 3 | 4;
  wallSec: number;
  costUsd: number;
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
    cacheWrite: number;
  };
  outcome: "done" | "failed" | "killed" | "stalled" | "limit";
  verdict?: "pass" | "strike";
  rework?: number;
}

export interface PickOptions {
  difficulty: 1 | 2 | 3 | 4;
  blocked?: Iterable<string>;
  running?: Record<string, number>;
  exclude?: string[];
}

export interface PickResult {
  id: string;
  pool: Pool;
  reason: string;
}

function ledgerPath(): string {
  return join(stateDir(), "ledger.json");
}

function dispatchesPath(): string {
  return join(stateDir(), "dispatches.jsonl");
}

function emptyLedger(): Ledger {
  return { version: 1, models: {} };
}

/** Fresh entry for a previously unseen model: unrated D1 in its natural pool. */
function freshEntry(id: string): ModelEntry {
  return {
    id,
    pool: poolOf(id),
    speed: "unrated",
    strength: "unrated",
    maxDifficulty: 1,
    passes: 0,
    strikes: 0,
    streak: 0,
    benched: false,
    totals: { runs: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, wallSec: 0 },
  };
}

/** Parse a raw ledger file; null means corrupt and the caller must fall back. */
function parseLedger(raw: string, path: string): Ledger | null {
  try {
    const parsed = JSON.parse(raw) as Partial<Ledger>;
    if (parsed?.version !== 1) {
      throw new Error(`unexpected ledger version: ${String(parsed?.version)}`);
    }
    return { version: 1, models: parsed.models ?? {} };
  } catch (error) {
    logger.error("ledger.corrupt", { path, bytes: Buffer.byteLength(raw), ...errorFields(error) });
    return null;
  }
}

/** Read ledger.json, falling back to ledger.json.bak; never throws. */
function readLedger(path: string): Ledger {
  try {
    const raw = readFileSync(path, "utf8");
    return (
      parseLedger(raw, path) ??
      parseLedger(readFileSync(`${path}.bak`, "utf8"), `${path}.bak`) ??
      emptyLedger()
    );
  } catch {
    return emptyLedger();
  }
}

/** Atomically persist the ledger: temp file + rename, previous copy kept as .bak. */
function saveLedger(ledger: Ledger): void {
  const path = ledgerPath();
  mkdirSync(stateDir(), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(ledger));
  if (existsSync(path)) copyFileSync(path, `${path}.bak`);
  renameSync(tmp, path);
}

/** Load the persisted ledger. Missing file is empty; corrupt recovers from .bak then empty. */
export function loadLedger(): Ledger {
  const ledger = readLedger(ledgerPath());
  logger.debug("ledger.load", { models: Object.keys(ledger.models).length });
  return ledger;
}

/**
 * Run `fn` under an exclusive lock over ledger.json, then save. Locks older
 * than STALE_LOCK_MS are removed; if no lock can be taken within ~2s this
 * throws instead of racing another writer.
 */
export function updateLedger<T>(fn: (l: Ledger) => T): T {
  mkdirSync(stateDir(), { recursive: true });
  const lock = `${ledgerPath()}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let fd: number;
  for (;;) {
    try {
      fd = openSync(lock, "wx");
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) {
        throw new Error(`ledger lock busy after ${LOCK_TIMEOUT_MS}ms: ${lock}`);
      }
      let stale = true; // a lock we cannot stat is gone or garbage: safe to clear
      try {
        stale = Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS;
      } catch (statError) {
        logger.debug("ledger.lock.stat_failed", errorFields(statError));
      }
      if (stale) {
        unlinkSync(lock);
        logger.warn("ledger.lock.stale", { lock });
        continue;
      }
      logger.warn("ledger.lock.wait", { lock });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_RETRY_MS);
    }
  }
  try {
    const ledger = readLedger(ledgerPath());
    const result = fn(ledger);
    saveLedger(ledger);
    return result;
  } finally {
    closeSync(fd);
    unlinkSync(lock);
  }
}

/** Pool for a model id, from the prefixes the three providers use. */
export function poolOf(id: string): Pool {
  if (id.startsWith("opencode/") && id.endsWith("-free")) return "free";
  if (id.startsWith("zai-coding-plan/")) return "zai";
  if (id.startsWith("opencode-go/")) return "go";
  return "other";
}

/** Cells of one markdown table row, trimmed, without the outer pipes. */
function rowCells(line: string): string[] {
  const parts = line.split("|");
  return parts.slice(1, parts.length - 1).map((cell) => cell.trim());
}

function isSeparator(line: string): boolean {
  const cells = rowCells(line);
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell));
}

/** Lines of the section under `heading`, up to the next `## ` heading or EOF. */
function sectionLines(markdown: string, heading: string): string[] {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trim().startsWith(heading));
  const section: string[] = [];
  for (let i = start + 1; start >= 0 && i < lines.length && !lines[i].startsWith("## "); i++) {
    section.push(lines[i]);
  }
  return section;
}

function unquote(cell: string): string {
  const text = cell.trim();
  return text.startsWith("`") && text.endsWith("`") ? text.slice(1, -1).trim() : text;
}

function tierSpeed(cell: string): ModelEntry["speed"] {
  return cell === "fast" || cell === "medium" || cell === "slow" ? cell : "unrated";
}

function tierStrength(cell: string): ModelEntry["strength"] {
  return cell === "light" || cell === "medium" || cell === "strong" ? cell : "unrated";
}

/**
 * Import the human-edited policy markdown: every tier row creates or updates a
 * model (existing totals and streak survive), and backticked pool-table ids
 * with a slash seed unrated entries. Returns the number of tier rows imported.
 */
export function importPolicy(markdown: string): number {
  let imported = 0;
  updateLedger((ledger) => {
    for (const line of sectionLines(markdown, TIERS_HEADING)) {
      if (!line.trim().startsWith("|") || isSeparator(line)) continue;
      const cells = rowCells(line);
      if (cells.length < 5) continue;
      const id = unquote(cells[0]);
      const difficulty = /^D([1-4])$/i.exec(cells[3]);
      if (!id || !difficulty) continue;
      const pass = /(\d+)\s*pass/i.exec(cells[4]);
      const strike = /(\d+)\s*strike/i.exec(cells[4]);
      const existing = ledger.models[id];
      const entry: ModelEntry = existing ? { ...existing } : freshEntry(id);
      entry.pool = poolOf(id);
      entry.speed = tierSpeed(cells[1]);
      entry.strength = tierStrength(cells[2]);
      entry.maxDifficulty = Number(difficulty[1]) as ModelEntry["maxDifficulty"];
      entry.passes = pass ? Number(pass[1]) : 0;
      entry.strikes = strike ? Number(strike[1]) : 0;
      entry.benched = line.includes("benched");
      entry.notes = cells[5] || undefined;
      ledger.models[id] = entry;
      imported += 1;
    }
    for (const line of sectionLines(markdown, POOLS_HEADING)) {
      if (!line.trim().startsWith("|")) continue;
      for (const match of line.matchAll(/`([^`]+)`/g)) {
        const id = match[1];
        if (id.includes("/") && !id.includes("*") && !ledger.models[id]) {
          ledger.models[id] = freshEntry(id);
        }
      }
    }
  });
  logger.info("ledger.import", { rows: imported });
  return imported;
}

function tierRow(entry: ModelEntry): string {
  const trial = entry.benched ? "benched" : `${entry.passes} pass / ${entry.strikes} strike`;
  return `| \`${entry.id}\` | ${entry.speed} | ${entry.strength} | D${entry.maxDifficulty} | ${trial} | ${entry.notes ?? ""} |`;
}

/**
 * Regenerate only the rows of the "Speed and capability tiers" table in
 * `existing`, sorted by pool then id; every other byte is returned unchanged.
 * A missing table returns the text as-is with a warning.
 */
export function exportPolicy(existing: string, ledger: Ledger): string {
  const lines = existing.split("\n");
  const start = lines.findIndex((line) => line.trim().startsWith(TIERS_HEADING));
  let separator = -1;
  for (let i = start + 1; start >= 0 && i < lines.length; i++) {
    if (lines[i].startsWith("## ")) break;
    if (isSeparator(lines[i])) {
      separator = i;
      break;
    }
  }
  if (separator < 0) {
    logger.warn("ledger.export.no_table", { foundHeading: start >= 0 });
    return existing;
  }
  let end = separator + 1;
  while (end < lines.length && lines[end].trim() !== "") end++;
  const rows = Object.values(ledger.models)
    .sort((a, b) => POOL_ORDER[a.pool] - POOL_ORDER[b.pool] || a.id.localeCompare(b.id))
    .map(tierRow);
  lines.splice(separator + 1, end - separator - 1, ...rows);
  return lines.join("\n");
}

/** Sum cost and tokens over step_finish events in a worker .out.jsonl; missing file: zeros. */
export function usageFromOutput(path: string): {
  costUsd: number;
  tokens: DispatchRecord["tokens"];
  steps: number;
} {
  const usage = {
    costUsd: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    steps: 0,
  };
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return usage;
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const step = event as null | {
      type?: unknown;
      part?: {
        cost?: unknown;
        tokens?: {
          input?: unknown;
          output?: unknown;
          reasoning?: unknown;
          cache?: { read?: unknown; write?: unknown };
        };
      };
    };
    if (step?.type !== "step_finish") continue;
    usage.steps += 1;
    const count = (value: unknown): number => (typeof value === "number" ? value : 0);
    usage.costUsd += typeof step.part?.cost === "number" ? step.part.cost : 0;
    const tokens = step.part?.tokens;
    usage.tokens.input += count(tokens?.input);
    usage.tokens.output += count(tokens?.output);
    usage.tokens.reasoning += count(tokens?.reasoning);
    usage.tokens.cacheRead += count(tokens?.cache?.read);
    usage.tokens.cacheWrite += count(tokens?.cache?.write);
  }
  return usage;
}

/** Shared verdict ladder: promote on 2 passes (cap D3), demote or bench on 3 strikes. */
function applyVerdictTo(entry: ModelEntry, verdict: "pass" | "strike"): ModelEntry {
  if (verdict === "pass") {
    entry.passes += 1;
    entry.streak += 1;
    if (entry.streak >= 2 && entry.maxDifficulty < 3) {
      entry.maxDifficulty = (entry.maxDifficulty + 1) as ModelEntry["maxDifficulty"];
      entry.streak = 0;
    }
  } else {
    entry.strikes += 1;
    entry.streak = 0;
    if (entry.strikes >= 3) {
      if (entry.maxDifficulty > 1) {
        entry.maxDifficulty = (entry.maxDifficulty - 1) as ModelEntry["maxDifficulty"];
        entry.strikes = 0;
      } else {
        entry.benched = true;
      }
    }
  }
  return entry;
}

/** Apply a pass/strike verdict to a model's trial ladder and return the entry. */
export function applyVerdict(model: string, verdict: "pass" | "strike"): ModelEntry {
  return updateLedger((ledger) => {
    const entry = ledger.models[model];
    if (!entry) throw new Error(`unknown model: ${model}`);
    applyVerdictTo(entry, verdict);
    logger.info("ledger.verdict", {
      model,
      verdict,
      maxDifficulty: entry.maxDifficulty,
      benched: entry.benched,
    });
    return entry;
  });
}

/** Append a dispatch record and fold its usage (and verdict) into the ledger. */
export function recordDispatch(rec: DispatchRecord): void {
  mkdirSync(stateDir(), { recursive: true });
  appendFileSync(dispatchesPath(), `${JSON.stringify(rec)}\n`);
  updateLedger((ledger) => {
    const entry = ledger.models[rec.model] ?? freshEntry(rec.model);
    ledger.models[rec.model] = entry;
    entry.totals.runs += 1;
    entry.totals.costUsd += rec.costUsd;
    entry.totals.inputTokens += rec.tokens.input;
    entry.totals.outputTokens += rec.tokens.output;
    entry.totals.wallSec += rec.wallSec;
    if (rec.verdict) applyVerdictTo(entry, rec.verdict);
    return entry;
  });
  logger.info("ledger.dispatch", {
    model: rec.model,
    outcome: rec.outcome,
    costUsd: rec.costUsd,
    verdict: rec.verdict,
  });
}

/** Rank qualifying ledger models for a ticket: pool, pool load, observed cost, speed, id. */
export function pick(opts: PickOptions): PickResult[] {
  const blocked = new Set(opts.blocked ?? []);
  const exclude = new Set(opts.exclude ?? []);
  const running: Record<string, number | undefined> = opts.running ?? {};
  const ledger = loadLedger();
  const poolLoad = new Map<Pool, number>();
  const loadIn = (pool: Pool): number => {
    const cached = poolLoad.get(pool);
    if (cached !== undefined) return cached;
    let sum = 0;
    for (const model of Object.values(ledger.models)) {
      if (model.pool === pool) sum += running[model.id] ?? 0;
    }
    poolLoad.set(pool, sum);
    return sum;
  };
  const filters = { considered: 0, benched: 0, tooWeak: 0, blocked: 0, excluded: 0 };
  const ranked: (PickResult & { load: number; avg: number; speed: ModelEntry["speed"] })[] = [];
  for (const entry of Object.values(ledger.models)) {
    filters.considered += 1;
    if (entry.benched) {
      filters.benched += 1;
      continue;
    }
    if (entry.maxDifficulty < opts.difficulty) {
      filters.tooWeak += 1;
      continue;
    }
    if (blocked.has(entry.id)) {
      filters.blocked += 1;
      continue;
    }
    if (exclude.has(entry.id)) {
      filters.excluded += 1;
      continue;
    }
    const load = loadIn(entry.pool);
    const avg = entry.totals.costUsd / Math.max(entry.totals.runs, 1);
    ranked.push({
      id: entry.id,
      pool: entry.pool,
      load,
      avg,
      speed: entry.speed,
      reason: `${entry.pool} pool, ${load} running, avg $${avg.toFixed(4)}/run`,
    });
  }
  ranked.sort(
    (a, b) =>
      POOL_ORDER[a.pool] - POOL_ORDER[b.pool] ||
      a.load - b.load ||
      a.avg - b.avg ||
      SPEED_ORDER[a.speed] - SPEED_ORDER[b.speed] ||
      a.id.localeCompare(b.id),
  );
  if (ranked.length === 0) {
    logger.warn("ledger.pick.empty", { difficulty: opts.difficulty, ...filters });
  }
  return ranked.map(({ id, pool, reason }) => ({ id, pool, reason }));
}
