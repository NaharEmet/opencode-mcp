import {
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

const logger = createLogger({ module: "state" });
const LOCK_TIMEOUT_MS = 2000;
const STALE_LOCK_MS = 10000;
const LOCK_RETRY_MS = 25;

export interface WorkerRecord {
  id: string;
  pid: number;
  owner: string;
  ticket?: string;
  model: string;
  cwd: string;
  session?: string;
  startedAt: string;
  lastActivityAt?: string;
  state: "running" | "done" | "failed" | "killed" | "stalled" | "orphan";
  endedAt?: string;
  exitCode?: number;
  killReason?: string;
  keepUntil?: string;
  askedAt?: string;
}

export interface WarningRecord {
  owner: string;
  model: string;
  at: string;
}

export interface State {
  version: 1;
  workers: Record<string, WorkerRecord>;
  warnings: WarningRecord[];
  cleared: Record<string, string>;
}

function statePath(): string {
  return join(stateDir(), "state.json");
}

function emptyState(): State {
  return { version: 1, workers: {}, warnings: [], cleared: {} };
}

function counts(state: State): Record<string, number> {
  return {
    workers: Object.keys(state.workers).length,
    warnings: state.warnings.length,
    cleared: Object.keys(state.cleared).length,
  };
}

/** Parse a raw state file; null means corrupt and the caller must fall back. */
function parseState(raw: string, path: string): State | null {
  try {
    const parsed = JSON.parse(raw) as Partial<State>;
    if (parsed?.version !== 1) {
      throw new Error(`unexpected state version: ${String(parsed?.version)}`);
    }
    return { ...emptyState(), ...parsed } as State;
  } catch (error) {
    logger.error("state.corrupt", { path, bytes: Buffer.byteLength(raw), ...errorFields(error) });
    return null;
  }
}

/** Read state.json, falling back to state.json.bak; never throws. */
function readState(path: string): State {
  try {
    const raw = readFileSync(path, "utf8");
    return (
      parseState(raw, path) ??
      parseState(readFileSync(`${path}.bak`, "utf8"), `${path}.bak`) ??
      emptyState()
    );
  } catch {
    return emptyState();
  }
}

/**
 * Load the persisted state. Missing file yields an empty state; corrupt JSON
 * recovers from the backup before giving up, so a crash never loses more than
 * one write.
 */
export function loadState(): State {
  const state = readState(statePath());
  logger.debug("state.load", counts(state));
  return state;
}

/** Atomically persist the state: temp file + rename, previous copy kept as .bak. */
export function saveState(state: State): void {
  const path = statePath();
  mkdirSync(stateDir(), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  if (existsSync(path)) copyFileSync(path, `${path}.bak`);
  renameSync(tmp, path);
  logger.debug("state.save", counts(state));
}

/**
 * Run `fn` under an exclusive lock over state.json, then save. Locks older
 * than STALE_LOCK_MS are removed; if no lock can be taken within ~2s this
 * throws instead of racing another writer.
 */
export function updateState<T>(fn: (state: State) => T): T {
  mkdirSync(stateDir(), { recursive: true });
  const lock = `${statePath()}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let fd: number;
  for (;;) {
    try {
      fd = openSync(lock, "wx");
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) {
        throw new Error(`state lock busy after ${LOCK_TIMEOUT_MS}ms: ${lock}`);
      }
      let stale = true; // a lock we cannot stat is gone or garbage: safe to clear
      try {
        stale = Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS;
      } catch (statError) {
        logger.debug("state.lock.stat_failed", errorFields(statError));
      }
      if (stale) {
        unlinkSync(lock);
        logger.warn("state.lock.stale", { lock });
        continue;
      }
      logger.warn("state.lock.wait", { lock });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_RETRY_MS);
    }
  }
  try {
    const state = loadState();
    const result = fn(state);
    saveState(state);
    return result;
  } finally {
    closeSync(fd);
    unlinkSync(lock);
  }
}

/** Insert or replace one worker record. */
export function upsertWorker(worker: WorkerRecord): void {
  updateState((state) => {
    state.workers[worker.id] = worker;
  });
}

/** Remember that owner hit a rate limit on model, so takeWarning can gate retries. */
export function recordWarning(owner: string, model: string, now: Date = new Date()): void {
  updateState((state) => {
    state.warnings.push({ owner, model, at: now.toISOString() });
  });
}

/**
 * True once per warning inside windowMs: a matching owner+model warning is
 * consumed and expired warnings are pruned. This is the "repeat the call to
 * launch anyway" check.
 */
export function takeWarning(
  owner: string,
  model: string,
  windowMs: number,
  now: Date = new Date(),
): boolean {
  return updateState((state) => {
    const cutoff = now.getTime() - windowMs;
    const hit = state.warnings.find(
      (w) => w.owner === owner && w.model === model && Date.parse(w.at) >= cutoff,
    );
    state.warnings = state.warnings.filter((w) => w !== hit && Date.parse(w.at) >= cutoff);
    return hit !== undefined;
  });
}

/** Record that a real model response arrived, lifting any limit block for modelKey. */
export function markCleared(modelKey: string, now: Date = new Date()): void {
  updateState((state) => {
    state.cleared[modelKey] = now.toISOString();
  });
}
